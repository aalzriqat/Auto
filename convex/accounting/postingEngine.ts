import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { assertPostingAllowed } from "../accountingPeriods";
import { resolveSystemAccount } from "../chartOfAccounts";
import { scaleForCurrency, assertValidMinorAmount } from "../utils/money";
import { SystemKey } from "../utils/defaultChart";
import {
  applyPostingRule,
  validateBalance,
  simplePayloadHash,
  ALL_EVENT_TYPES,
  LineSpec,
} from "./postingRules";
import { auditLog } from "../financialAudit";
import { incrementAccountSnapshot } from "./accountSnapshots";

export interface PostCommand {
  orgId: Id<"organizations">;
  branchId?: Id<"branches">;
  eventType: string;
  sourceType: string;
  sourceId: string;
  eventVersion: number;
  accountingDate: number;
  occurredAt: number;
  currency: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  actorId: Id<"users">;
}

export interface PostResult {
  /** Null only when `skipped` — the event had no accounting consequence. */
  eventId: Id<"accountingEvents"> | null;
  journalEntryId: Id<"journalEntries"> | null;
  alreadyPosted: boolean;
  /**
   * The rule declared this event genuinely has nothing to post. Reported rather
   * than swallowed so a caller can tell "no entry, deliberately" from "an entry
   * I forgot to look for" — and so nothing writes a journal entry with no lines.
   */
  skipped?: boolean;
}

/**
 * Event types that may never post again, whatever queued or called them.
 *
 * SCRUM-51 retired the Claims lifecycle: it opened finance-company
 * receivables with no originating GL debit and then credited them. The rules
 * themselves (`ruleClaimSettled`, `ruleClaimWrittenOff`) are deliberately
 * LEFT IN PLACE — they are how a historical, already-posted claim event is
 * still described when something reads it back. What is removed is the
 * ability to post a NEW one.
 */
const RETIRED_EVENT_TYPES = new Set<string>(["CLAIM_SETTLED", "CLAIM_WRITTEN_OFF"]);

export async function postAccountingEvent(
  ctx: MutationCtx,
  cmd: PostCommand
): Promise<PostResult> {
  // 1. Validate event type is known
  if (!ALL_EVENT_TYPES.has(cmd.eventType)) {
    throw new ConvexError(`Unknown event type: ${cmd.eventType}`);
  }

  // ⚠️ RETIRED EVENT TYPES ARE REFUSED HERE, AT THE ONE PLACE EVERY POSTING
  // PATH MUST PASS — SCRUM-51.
  //
  // Claims used to credit Accounts Receivable — Finance Companies with no
  // originating debit. Retiring the five `claims.ts` writers closed the front
  // door; removing the CLAIM_PAYMENT migration mapping closed a second. Both
  // review seats then found a third: a CLAIM_SETTLED or CLAIM_WRITTEN_OFF
  // event ALREADY QUEUED in `pendingAccountingEvents` by the pre-retirement
  // code still drains and posts the moment an accounting period opens, with
  // no operator action at all.
  //
  // Closing that door individually would have been the third patch to the
  // same defect, and the next path would have been the fourth. This is the
  // invariant, so it belongs where the invariant can actually be enforced:
  // every posting — domain hook, ledger call, either migration, and the
  // outbox drain — reaches this function, and none of them can post a retired
  // event type past this point.
  //
  // A drained entry that hits this refuses, is marked failed by the drain's
  // own error handling, and eventually dead-letters. That is the right end
  // for it: unlike a held entry it will never become postable, so retrying
  // forever would be dishonest about what is waiting.
  if (RETIRED_EVENT_TYPES.has(cmd.eventType)) {
    throw new ConvexError(
      `The ${cmd.eventType} accounting event is retired and can no longer post. Finance-company receivables are originated and settled through the Finance Application, which is the only authority for them.`
    );
  }

  // 2. Validate currency
  const currency = cmd.currency.toUpperCase();
  const scale = scaleForCurrency(currency);

  // 3. Idempotency: check for existing event with same key
  const existingByKey = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .unique();

  if (existingByKey) {
    if (existingByKey.status === "POSTED" && existingByKey.journalEntryId) {
      return {
        eventId: existingByKey._id,
        journalEntryId: existingByKey.journalEntryId,
        alreadyPosted: true,
      };
    }
    if (existingByKey.status === "REVERSED") {
      throw new ConvexError("This accounting event has already been reversed and cannot be reposted.");
    }
  }

  // 4. Check for duplicate event by source identity
  const existingBySource = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_event_source_version", (q) =>
      q
        .eq("orgId", cmd.orgId)
        .eq("eventType", cmd.eventType)
        .eq("sourceType", cmd.sourceType)
        .eq("sourceId", cmd.sourceId)
        .eq("eventVersion", cmd.eventVersion)
    )
    .unique();

  if (existingBySource && existingBySource.status === "POSTED" && existingBySource.journalEntryId) {
    return {
      eventId: existingBySource._id,
      journalEntryId: existingBySource.journalEntryId,
      alreadyPosted: true,
    };
  }

  // 5. Validate accounting period
  const periodId = await assertPostingAllowed(ctx, cmd.orgId, cmd.accountingDate);

  // 6. Apply posting rules to generate line specs
  const ruleResult = applyPostingRule(cmd.eventType, cmd.payload);

  // 6b. A rule may declare that the event genuinely has no accounting
  // consequence — a consigned car placed for a supplier at zero margin with no
  // dealership income, for instance. That is different from a rule returning
  // nothing by mistake, which must still fail: `validateBalance` accepts zero
  // lines (0 === 0), so without this distinction both outcomes wrote a journal
  // entry with no lines at all.
  if (ruleResult.skipPosting) {
    // A declared skip that nevertheless produced lines is a rule contradicting
    // itself, and silently discarding real debits and credits is the worse of
    // the two readings.
    if (ruleResult.lines.length > 0) {
      throw new Error(
        `Posting rule for ${cmd.eventType} declared skipPosting but produced ${ruleResult.lines.length} lines. Refusing to discard them.`
      );
    }
    return {
      eventId: null,
      journalEntryId: null,
      alreadyPosted: false,
      skipped: true,
    };
  }

  // 6c. An empty result that did NOT declare itself. `validateBalance` accepts
  // zero lines (0 === 0), so without this a rule returning nothing by mistake
  // writes a journal entry with no lines — a row asserting an event the books
  // do not reflect. The `skipPosting` flag above is what distinguishes the
  // deliberate case; reaching here without it is a bug in the rule.
  if (ruleResult.lines.length === 0) {
    throw new Error(
      `Posting rule for ${cmd.eventType} produced no journal lines and did not declare skipPosting. A journal entry with no lines would balance trivially and assert an event the books do not reflect.`
    );
  }

  // 7. Validate balance before resolving accounts
  validateBalance(ruleResult.lines);

  // 8. Resolve account IDs from system keys and validate amounts
  const resolvedLines = await Promise.all(
    ruleResult.lines.map(async (spec, idx) => {
      const accountId = await resolveSystemAccount(ctx, cmd.orgId, spec.accountSystemKey);
      assertValidMinorAmount(spec.debitMinor, `line ${idx + 1} debit`);
      assertValidMinorAmount(spec.creditMinor, `line ${idx + 1} credit`);
      return { ...spec, accountId, lineNumber: idx + 1 };
    })
  );

  // 9. Create accounting event record
  const now = Date.now();
  const payloadHash = await simplePayloadHash(cmd.payload);

  const eventId = await ctx.db.insert("accountingEvents", {
    orgId: cmd.orgId,
    branchId: cmd.branchId,
    eventType: cmd.eventType,
    sourceType: cmd.sourceType,
    sourceId: cmd.sourceId,
    eventVersion: cmd.eventVersion,
    idempotencyKey: cmd.idempotencyKey,
    occurredAt: cmd.occurredAt,
    accountingDate: cmd.accountingDate,
    currency,
    payload: cmd.payload,
    payloadHash,
    status: "PENDING",
    createdBy: cmd.actorId,
    createdAt: now,
  });

  // 10. Create journal entry
  const journalEntryId = await ctx.db.insert("journalEntries", {
    orgId: cmd.orgId,
    branchId: cmd.branchId,
    accountingEventId: eventId,
    journalNumber: "pending",
    accountingDate: cmd.accountingDate,
    periodId,
    sourceType: cmd.sourceType,
    sourceId: cmd.sourceId,
    category: ruleResult.category,
    memo: ruleResult.memo,
    status: "POSTED",
    currency,
    postedBy: cmd.actorId,
    postedAt: now,
    createdAt: now,
  });

  // Set readable journal number from entry ID
  const journalNumber = `JE-${journalEntryId.toString().replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
  await ctx.db.patch(journalEntryId, { journalNumber });

  // 11. Create journal lines atomically, keeping each account's running
  // balance snapshot (GL Phase 18) synchronously up to date so reports never
  // need to re-scan this org's full posting history.
  for (const l of resolvedLines) {
    await ctx.db.insert("journalLines", {
      orgId: cmd.orgId,
      journalEntryId,
      lineNumber: l.lineNumber,
      accountId: l.accountId,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      currency,
      scale,
      accountingDate: cmd.accountingDate,
      branchId: cmd.branchId,
      vehicleId: (l.vehicleId || undefined) as Id<"vehicles"> | undefined,
      customerId: (l.customerId || undefined) as Id<"customers"> | undefined,
      salespersonId: (l.salespersonId || undefined) as Id<"users"> | undefined,
      description: l.description,
    });
    await incrementAccountSnapshot(ctx, {
      orgId: cmd.orgId,
      accountId: l.accountId,
      currency,
      periodId,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
    });
  }

  // 12. Mark event as POSTED and link journal entry
  await ctx.db.patch(eventId, {
    status: "POSTED",
    journalEntryId,
  });

  // 13. Write immutable audit log entry
  await auditLog(ctx, {
    orgId: cmd.orgId,
    actorId: cmd.actorId,
    actionType: "POST_EVENT",
    resourceType: "journalEntries",
    resourceId: journalEntryId.toString(),
    description: `Posted ${cmd.eventType} for ${cmd.sourceType}/${cmd.sourceId}`,
    after: { eventType: cmd.eventType, journalNumber, lineCount: resolvedLines.length },
    idempotencyKey: cmd.idempotencyKey,
  });

  return { eventId, journalEntryId, alreadyPosted: false };
}
