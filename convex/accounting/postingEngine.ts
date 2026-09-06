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
import {
  ReceiptOccurrenceIdentity,
  assertOccurrenceAuthorizes,
  isReservedReceiptKey,
  isReservedReceiptTuple,
  reservedOccurrenceRefusal,
} from "./receiptOccurrence";

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
  /**
   * Proof that this command may address the reserved receipt occurrence
   * (SCRUM-249). Absent on every other posting, and absent is the default.
   *
   * ⚠️ THIS IS A RUNTIME CAPABILITY, NOT A TYPE. Its authority is membership of
   * `receiptOccurrence`'s module-private `WeakSet` — object identity — which is
   * why a registered mutation cannot supply one: arguments crossing the Convex
   * function boundary are deserialized, so an operator's JSON is a different
   * object however exactly it copies the shape. `accountingLedger.post`'s
   * validator also declares no such argument, but that is the second line of
   * defence, not the first; a field name is a convention and object identity is
   * a fact.
   *
   * ⚠️ IT MUST NEVER BE PERSISTED. `enqueuePendingPost` enumerates the columns
   * it stores rather than spreading the command, so this cannot reach the
   * database by accident — asserted in the SCRUM-249 suite rather than left to
   * hold by inspection, because a later `...cmd` would silently break it.
   */
  receiptAuthority?: ReceiptOccurrenceIdentity;
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

/**
 * SCRUM-249 — a generic posting ingress may not claim the reserved receipt
 * occurrence, and may not take its idempotency key from outside it either.
 *
 * Exported so the two `postOrEnqueue` short-circuits enforce the same predicate
 * rather than a lookalike. They matter because one of them fires EARLIER than
 * this function: `postOrEnqueue`'s `alreadyPosted` check returns silently on a
 * key match, so a guard that lived only here would be reached after the receipt
 * had already been dropped.
 *
 * Returns the proven identity when the command is reserved and authorized, and
 * `null` when the command has nothing to do with the reserved domain — so a
 * caller can tell "authorized reserved post" from "ordinary post" without
 * re-deriving the classification.
 */
export function proveReservedReceiptAuthority(
  cmd: PostCommand
): ReceiptOccurrenceIdentity | null {
  const reserved =
    isReservedReceiptTuple(cmd.eventType, cmd.sourceType) ||
    isReservedReceiptKey(cmd.idempotencyKey);
  if (!reserved) {
    // An authority carried on a non-reserved command would mean the tuple and
    // the identity disagree, which `assertOccurrenceAuthorizes` would catch —
    // but reaching here at all is a programming error, not a caller's, so say
    // so rather than letting it look like a refused attack.
    if (cmd.receiptAuthority) {
      throw new Error(
        `receipt occurrence authority supplied for a non-reserved posting ` +
          `(${cmd.eventType}/${cmd.sourceType}, key ${cmd.idempotencyKey}). ` +
          "The authority and the command disagree about what is being posted."
      );
    }
    return null;
  }
  if (!cmd.receiptAuthority) {
    throw new ConvexError(reservedOccurrenceRefusal(cmd));
  }
  assertOccurrenceAuthorizes(cmd.receiptAuthority, cmd);
  return cmd.receiptAuthority;
}

/**
 * A key match is NOT an occurrence match, and treating it as one is the
 * absorption defect itself (SCRUM-249).
 *
 * `postAccountingEvent` short-circuits on `by_org_idempotency` before it has
 * compared a single economic column. For an ordinary event family that is the
 * long-standing behaviour and this change does not touch it. For the reserved
 * receipt occurrence it is not acceptable: returning a prior row as
 * `alreadyPosted` asserts the two are the same fact, and if the stored tuple or
 * the stored economics differ, that assertion is false and the certified
 * receipt is silently discarded.
 *
 * So an authorized reserved post refuses on divergence instead of absorbing it.
 * An EXACT retry — the same posting envelope — still returns the prior event,
 * which is what keeps the drain and every legitimate retry idempotent.
 *
 * Scoped deliberately to the reserved domain. Widening it to every event family
 * would newly refuse producers that legitimately reuse one key across tuples
 * (`hookDepositApplied` varies `sourceType` behind a fixed key), and SCRUM-249
 * does not own those.
 *
 * ## ⚠️ THE COMPARISON IS THE WHOLE ENVELOPE, NOT THE TUPLE AND PAYLOAD
 *
 * The first revision of this function compared only the four economic columns
 * and the payload hash. That is not what "the same posting" means. The Codex
 * seat found it at `22605dff3` as SCRUM-249-ADV-01, and I reproduced it at the
 * base revision `ca68b2b0e` before accepting it: through the base generic
 * ingress an operator can create a POSTED row carrying the reserved tuple, the
 * receipt authority's own derived key and a **byte-identical payloadHash**,
 * while supplying a different `accountingDate` and a different top-level
 * `currency`. Those two fields never appear in the payload, so the hash cannot
 * see them — and `postAccountingEvent` uses them independently for period
 * selection, journal/line currency, scale and snapshot partitioning.
 *
 * The certified receipt then arrives, matches on tuple and hash, and is
 * reported `alreadyPosted` against a journal booked in the wrong period and the
 * wrong currency. The outbox marks its row POSTED and the causal check accepts
 * it. Proven, not argued: the provenance test at the base revision showed the
 * exact bytes are producible and the certified receipt is absorbed.
 *
 * Reachability, stated honestly rather than inflated: at THIS revision the
 * generic ingress can no longer create such a row at all, so the surviving
 * exposure is a row already written under the base revision — a cutover
 * concern. It is fixed here anyway, because "a conflicting existing occurrence
 * must never be accepted merely because its key already exists" is this
 * ticket's requirement, and a row in a different period and currency is a
 * conflicting occurrence by any reading.
 *
 * Comparing dates is safe for every real producer, and that was checked rather
 * than assumed: `recordPayment` and `clearCheque` each INSERT their own
 * `collectionPayments` row, so one occurrence has exactly one legitimate
 * forward post. The only same-occurrence repeats are the drain replaying its
 * own persisted row and a genuine exact retry — both carry the identical
 * envelope.
 */
export function assertExistingRowIsSameOccurrence(
  existing: {
    eventType?: string;
    sourceType: string;
    sourceId: string;
    eventVersion?: number;
    payloadHash?: string;
    currency?: string;
    accountingDate?: number;
    occurredAt?: number;
    branchId?: Id<"branches">;
    idempotencyKey?: string;
  },
  cmd: PostCommand,
  cmdPayloadHash: string
): void {
  // ⚠️ AN ABSENT COLUMN IS DIVERGENCE, NOT A MATCH.
  //
  // `eventType`, `eventVersion` and `payloadHash` are optional on the pending
  // row's schema, so the obvious spelling is `!== undefined && !== cmd.x` — and
  // that fails OPEN: a row missing the very column being compared would be
  // reported as the same occurrence. Comparing directly makes `undefined`
  // unequal to any real value, so an incomplete row refuses.
  //
  // Stated honestly: this branch is UNREACHABLE through the current writers.
  // `enqueuePendingPost` sets all four economic columns and `postAccountingEvent`
  // always writes a `payloadHash`, so no reserved POST row can be missing one.
  // It is written fail-closed anyway because the cost is nothing and the
  // alternative is a guard whose default answer on unexpected data is "equivalent".
  // For the same reason there is no mutant for it — an unreachable branch would
  // survive, and a survivor that means "unreachable" is not evidence of a gap.
  const divergent: string[] = [];
  if (existing.eventType !== cmd.eventType) {
    divergent.push(`eventType ${String(existing.eventType)} != ${cmd.eventType}`);
  }
  if (existing.sourceType !== cmd.sourceType) {
    divergent.push(`sourceType ${existing.sourceType} != ${cmd.sourceType}`);
  }
  if (existing.sourceId !== cmd.sourceId) {
    divergent.push(`sourceId ${existing.sourceId} != ${cmd.sourceId}`);
  }
  if (existing.eventVersion !== cmd.eventVersion) {
    divergent.push(`eventVersion ${String(existing.eventVersion)} != ${cmd.eventVersion}`);
  }
  if (existing.payloadHash !== cmdPayloadHash) {
    divergent.push("payload economics differ");
  }
  // The rest of the posting envelope — the part no payload hash can see.
  // Currency is normalised on BOTH sides: `postAccountingEvent` stores it
  // uppercased on `accountingEvents`, while `enqueuePendingPost` stores the raw
  // command value, so a case-only difference between the two tables is not a
  // divergence and must not be reported as one.
  if (String(existing.currency).toUpperCase() !== cmd.currency.toUpperCase()) {
    divergent.push(`currency ${String(existing.currency)} != ${cmd.currency}`);
  }
  if (existing.accountingDate !== cmd.accountingDate) {
    // Says what it KNOWS. An earlier wording called this "(different period)",
    // which this function cannot establish — it has not resolved a period, and
    // two timestamps milliseconds apart produced that message during testing.
    // A different accounting date MAY select a different period; the refusal
    // reports the fact and leaves the inference to the reader.
    divergent.push(`accountingDate ${String(existing.accountingDate)} != ${cmd.accountingDate}`);
  }
  if (existing.occurredAt !== cmd.occurredAt) {
    divergent.push(`occurredAt ${String(existing.occurredAt)} != ${cmd.occurredAt}`);
  }
  if (existing.branchId !== cmd.branchId) {
    divergent.push(`branchId ${String(existing.branchId)} != ${String(cmd.branchId)}`);
  }
  // THE CANONICAL ADDRESS ITSELF (SCRUM-249-ADV-02).
  //
  // The comparator is reached from two lookups. Step 3 selects the row BY KEY,
  // so there the stored key equals the command key by construction and this
  // comparison is a tautology. Step 4 selects it by the TUPLE index, where the
  // stored key is entirely FREE — and without this line a POSTED reserved row
  // carrying somebody else's key is handed back as `alreadyPosted`.
  //
  // Reproduced before it was fixed: a row keyed `cheque_return_after_clear_<id>`
  // with an otherwise byte-identical envelope absorbed the certified receipt
  // silently — no new event, no pending row, no error — and
  // `findPostedReceiptOccurrence` then returned that foreign-keyed row as the
  // receipt's posting.
  //
  // `cmd.idempotencyKey` is already proven canonical for a reserved command:
  // `assertOccurrenceAuthorizes` refuses unless it equals
  // `occurrenceIdempotencyKey(identity)`. So this asks the one remaining
  // question — is the STORED row addressed as this occurrence, or as something
  // else that merely shares its tuple.
  if (existing.idempotencyKey !== cmd.idempotencyKey) {
    divergent.push(
      `idempotencyKey ${String(existing.idempotencyKey)} != ${cmd.idempotencyKey}`
    );
  }
  if (divergent.length > 0) {
    throw new ConvexError(
      `Refusing to absorb a reserved receipt occurrence into a conflicting existing row ` +
        `under idempotency key "${cmd.idempotencyKey}" (SCRUM-249): ${divergent.join("; ")}. ` +
        "A shared key is not evidence that two postings are the same economic fact, and " +
        "returning the earlier one would report them as equivalent."
    );
  }
}

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

  // ⚠️ 1c. THE RESERVED RECEIPT OCCURRENCE IS PROVEN HERE — SCRUM-249.
  //
  // Placed BEFORE every idempotency lookup below, and that ordering is the
  // whole point rather than a detail. The defect was never "a caller can choose
  // a bad key"; it was that the key is compared before anything else, so
  // whoever reaches a key first owns the occurrence and the certified payload
  // is never compared to what is already there. A guard placed after the
  // `alreadyPosted` short-circuit would run only in the cases that had already
  // gone wrong.
  //
  // It also sits before `assertPostingAllowed`, the posting rules and every
  // insert, so a refusal costs zero journal, event, journal line, snapshot or
  // outbox row — measured, not assumed (SCRUM-249 §1 R2).
  //
  // Authority is a runtime capability minted in `receiptOccurrence`, so the
  // registered generic ingress cannot produce one; the outbox drain, which
  // holds no in-process value, re-establishes it from its persisted row through
  // the one sanctioned rehydration door.
  const reservedAuthority = proveReservedReceiptAuthority(cmd);

  // 2. Validate currency
  const currency = cmd.currency.toUpperCase();
  const scale = scaleForCurrency(currency);

  // Computed early ONLY for the reserved comparison below — the general path
  // still hashes at step 9. `simplePayloadHash` canonicalizes before hashing,
  // so a payload that round-tripped through the outbox row hashes identically
  // to the one the producer built.
  const reservedPayloadHash = reservedAuthority ? await simplePayloadHash(cmd.payload) : "";

  // 3. Idempotency: check for existing event with same key
  const existingByKey = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .unique();

  if (existingByKey) {
    if (existingByKey.status === "POSTED" && existingByKey.journalEntryId) {
      // The key found something. For the reserved occurrence, prove it is the
      // SAME occurrence with the SAME economics before reporting equivalence.
      if (reservedAuthority) {
        assertExistingRowIsSameOccurrence(existingByKey, cmd, reservedPayloadHash);
      }
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
    // Same occurrence by construction here — the index range IS the tuple — so
    // only the economics can still differ. A repost of one receipt with a
    // different split is not the same fact, whichever index found it.
    if (reservedAuthority) {
      assertExistingRowIsSameOccurrence(existingBySource, cmd, reservedPayloadHash);
    }
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
  const payloadHash = reservedAuthority ? reservedPayloadHash : await simplePayloadHash(cmd.payload);

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
