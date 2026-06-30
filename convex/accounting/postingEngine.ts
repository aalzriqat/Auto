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
  eventId: Id<"accountingEvents">;
  journalEntryId: Id<"journalEntries">;
  alreadyPosted: boolean;
}

export async function postAccountingEvent(
  ctx: MutationCtx,
  cmd: PostCommand
): Promise<PostResult> {
  // 1. Validate event type is known
  if (!ALL_EVENT_TYPES.has(cmd.eventType)) {
    throw new ConvexError(`Unknown event type: ${cmd.eventType}`);
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

  // 11. Create journal lines atomically
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
