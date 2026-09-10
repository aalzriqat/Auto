// ⚠️ SCRUM-302 — imported FIRST, deliberately. `utils/orgLifecycle` and
// `utils/webhookLog` are leaves: neither imports anything from this
// application. Appended at the END of an import block, the binding was
// still uninitialized when a module cycle re-entered this file mid-init
// (`Cannot access '__vite_ssr_import_9__' before initialization`, thrown
// from enqueuePendingPost under full-suite ordering only). A leaf with no
// app edges is safe to initialize before anything that can participate in
// a cycle, so it goes above every local import.
import { assertOrgEconomicallyActive } from "../utils/orgLifecycle";
import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { assertPostingAllowed } from "../accountingPeriods";
import { scaleForCurrency } from "../utils/money";
import { simplePayloadHash, validateBalance, LineSpec } from "./postingRules";
import { auditLog } from "../financialAudit";
import { incrementAccountSnapshot } from "./accountSnapshots";
import {
  isReservedReceiptKey,
  isReservedReceiptTuple,
  occurrenceReversalIdempotencyKey,
  rehydrateReceiptOccurrence,
} from "./receiptOccurrence";

export interface ReversalCommand {
  orgId: Id<"organizations">;
  originalEventId: Id<"accountingEvents">;
  reversalDate: number;
  reason: string;
  actorId: Id<"users">;
  idempotencyKey: string;
}

export interface ReversalResult {
  reversalEventId: Id<"accountingEvents">;
  reversalJournalEntryId: Id<"journalEntries">;
  alreadyReversed: boolean;
}

export async function reverseAccountingEvent(
  ctx: MutationCtx,
  cmd: ReversalCommand
): Promise<ReversalResult> {
  // ⚠️ SCRUM-302 — this function does NOT route through `postAccountingEvent`;
  // it writes its own accountingEvents, journalEntries and journalLines rows
  // directly (the standing note beside JOURNAL_REVERSAL in `postingRules.ts`
  // says so). So the engine's lifecycle refusal does not cover it, and a
  // reversal is a NEW economic footprint even though it unwinds an old one.
  // A suspended or destructively-purged organization must not acquire one.
  await assertOrgEconomicallyActive(ctx, cmd.orgId);

  const original = await ctx.db.get(cmd.originalEventId);
  if (!original || original.orgId !== cmd.orgId) {
    throw new ConvexError("Accounting event not found in this organization.");
  }
  if (original.status === "REVERSED") {
    if (original.reversedByEventId) {
      const reversalEvent = await ctx.db.get(original.reversedByEventId);
      if (reversalEvent?.journalEntryId) {
        return {
          reversalEventId: original.reversedByEventId,
          reversalJournalEntryId: reversalEvent.journalEntryId,
          alreadyReversed: true,
        };
      }
    }
    throw new ConvexError("This accounting event has already been reversed.");
  }
  if (original.status !== "POSTED") {
    throw new ConvexError(`Cannot reverse an event with status "${original.status}".`);
  }
  if (!original.journalEntryId) {
    throw new ConvexError("Original event has no linked journal entry.");
  }

  // ⚠️ SCRUM-249 — THE RESERVED KEY NAMESPACE IS CLOSED ON THIS DOOR TOO.
  //
  // A reversal writes an `accountingEvents` row carrying the caller's
  // `idempotencyKey`, so `internal.accountingLedger.reverse` is a second way to
  // occupy the receipt authority's key space — and once a row holds
  // `collection_payment_<paymentId>`, `postOrEnqueue` drops the genuine receipt
  // silently, exactly as in the forward case. Reserving the namespace here as
  // well is what makes the forward guard's claim true rather than approximate.
  //
  // Stated precisely, because the boundary matters: this restricts WHICH KEY a
  // reversal may be written under, not WHICH EVENTS may be reversed. The only
  // reserved-namespace key any caller may use is the one derived from the
  // occurrence actually being reversed, proven from the ORIGINAL EVENT'S OWN
  // PERSISTED COLUMNS rather than from anything the caller supplied.
  // `reverseReceiptOccurrence` derives exactly that key and is unaffected;
  // `clearCheque`'s `cheque_return_after_clear_<chequeId>` lives outside the
  // namespace and is untouched.
  //
  // ⚠️ WHAT THIS DELIBERATELY DOES NOT DO: it does not decide whether a generic
  // operator may reverse a certified receipt occurrence at all. That is a real
  // and separate authority question, it would refuse `clearCheque`'s existing
  // direct reversal of a `collectionPayments`-sourced event, and that surface
  // belongs to SCRUM-130. Recorded as an open boundary rather than closed by
  // implication.
  if (isReservedReceiptKey(cmd.idempotencyKey)) {
    // Rehydration is attempted ONLY when the original really is a reserved
    // receipt occurrence. Calling it unconditionally also fails closed — the
    // cross-family check refuses a `JOURNAL_REVERSAL` or an `expenses` snapshot
    // — but it reports "snapshot is not a direct collection", which describes
    // the wrong problem to whoever hit it. Reversing an unrelated event under a
    // reserved key is not a malformed snapshot; it is taking a namespace that
    // is not yours, and the error should say so.
    const sanctioned = isReservedReceiptTuple(original.eventType, original.sourceType)
      ? occurrenceReversalIdempotencyKey(
          rehydrateReceiptOccurrence({
            orgId: cmd.orgId,
            snapshot: {
              eventType: original.eventType,
              sourceType: original.sourceType,
              sourceId: original.sourceId,
              eventVersion: original.eventVersion,
            },
          })
        )
      : null;
    if (cmd.idempotencyKey !== sanctioned) {
      throw new ConvexError(
        `Refusing a reversal under a reserved receipt idempotency key (SCRUM-249). ` +
          `"${cmd.idempotencyKey}" is inside the direct-collection receipt authority's key space, ` +
          `and the only sanctioned key for reversing ${original.eventType}/${original.sourceType}/` +
          `${original.sourceId}@v${original.eventVersion} is the one derived from that occurrence.`
      );
    }
  }

  // Check idempotency
  const existingReversal = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", cmd.orgId).eq("idempotencyKey", cmd.idempotencyKey)
    )
    .unique();

  if (existingReversal && existingReversal.status === "POSTED" && existingReversal.journalEntryId) {
    return {
      reversalEventId: existingReversal._id,
      reversalJournalEntryId: existingReversal.journalEntryId,
      alreadyReversed: true,
    };
  }

  // Validate the reversal date falls in an open period
  const periodId = await assertPostingAllowed(ctx, cmd.orgId, cmd.reversalDate);

  // Load original journal lines
  const originalLines = await ctx.db
    .query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", original.journalEntryId!))
    .collect();

  if (originalLines.length === 0) {
    throw new ConvexError("Original journal entry has no lines — cannot reverse.");
  }

  // Build inverted lines (swap debits and credits)
  const invertedLines: (typeof originalLines[number])[] = originalLines.map((l) => ({
    ...l,
    debitMinor: l.creditMinor,
    creditMinor: l.debitMinor,
    accountingDate: cmd.reversalDate,
  }));

  // Validate balance of inverted lines
  const lineSpecs: LineSpec[] = invertedLines.map((l) => ({
    accountSystemKey: "CASH_ON_HAND" as never,
    debitMinor: l.debitMinor,
    creditMinor: l.creditMinor,
  }));
  validateBalance(lineSpecs);

  const currency = original.currency;
  const scale = scaleForCurrency(currency);
  const now = Date.now();

  // Build reversal payload
  const reversalPayload = {
    originalEventId: cmd.originalEventId.toString(),
    originalEventType: original.eventType,
    reason: cmd.reason,
  };

  // Create reversal accounting event
  const reversalEventId = await ctx.db.insert("accountingEvents", {
    orgId: cmd.orgId,
    eventType: "JOURNAL_REVERSAL",
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    eventVersion: original.eventVersion + 1,
    idempotencyKey: cmd.idempotencyKey,
    occurredAt: now,
    accountingDate: cmd.reversalDate,
    currency,
    payload: reversalPayload,
    payloadHash: await simplePayloadHash(reversalPayload),
    status: "PENDING",
    reversalOfEventId: cmd.originalEventId,
    createdBy: cmd.actorId,
    createdAt: now,
  });

  // Create reversal journal entry
  const reversalJournalEntryId = await ctx.db.insert("journalEntries", {
    orgId: cmd.orgId,
    accountingEventId: reversalEventId,
    journalNumber: "pending",
    accountingDate: cmd.reversalDate,
    periodId,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    category: "REVERSAL",
    memo: `Reversal of journal for ${original.eventType}: ${cmd.reason}`,
    status: "POSTED",
    currency,
    reversalOfJournalEntryId: original.journalEntryId,
    postedBy: cmd.actorId,
    postedAt: now,
    createdAt: now,
  });

  const journalNumber = `JE-${reversalJournalEntryId.toString().replace(/[^a-z0-9]/gi, "").slice(-10).toUpperCase()}`;
  await ctx.db.patch(reversalJournalEntryId, { journalNumber });

  // Write inverted journal lines, incrementing the same running snapshots
  // (GL Phase 18) the original posting incremented — since debit/credit are
  // already swapped here, this naturally nets the reversed entry's effect
  // back out of the running balance.
  for (let i = 0; i < invertedLines.length; i++) {
    const l = invertedLines[i];
    await ctx.db.insert("journalLines", {
      orgId: cmd.orgId,
      journalEntryId: reversalJournalEntryId,
      lineNumber: i + 1,
      accountId: l.accountId,
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
      currency,
      scale,
      accountingDate: cmd.reversalDate,
      branchId: l.branchId,
      vehicleId: l.vehicleId,
      customerId: l.customerId,
      salespersonId: l.salespersonId,
      cashierId: l.cashierId,
      financeCompanyId: l.financeCompanyId,
      description: l.description ? `[REVERSAL] ${l.description}` : "[REVERSAL]",
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

  // Mark reversal event as posted
  await ctx.db.patch(reversalEventId, { status: "POSTED", journalEntryId: reversalJournalEntryId });

  // Mark original event as reversed and link the reversal journal
  await ctx.db.patch(cmd.originalEventId, { status: "REVERSED", reversedByEventId: reversalEventId });

  // Mark original journal entry as reversed
  await ctx.db.patch(original.journalEntryId!, {
    status: "REVERSED",
    reversedByJournalEntryId: reversalJournalEntryId,
  });

  // Immutable financial audit record for the reversal (REVERSE_EVENT).
  await auditLog(ctx, {
    orgId: cmd.orgId,
    actorId: cmd.actorId,
    actionType: "REVERSE_EVENT",
    resourceType: "journalEntries",
    resourceId: reversalJournalEntryId.toString(),
    description: `Reversed ${original.eventType} (${original.sourceType}/${original.sourceId}): ${cmd.reason}`,
    before: {
      originalEventId: cmd.originalEventId.toString(),
      originalJournalEntryId: original.journalEntryId!.toString(),
    },
    after: { reversalEventId: reversalEventId.toString(), journalNumber },
    idempotencyKey: cmd.idempotencyKey,
  });

  return { reversalEventId, reversalJournalEntryId, alreadyReversed: false };
}
