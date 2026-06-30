import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { assertPostingAllowed } from "../accountingPeriods";
import { scaleForCurrency } from "../utils/money";
import { simplePayloadHash, validateBalance, LineSpec } from "./postingRules";
import { auditLog } from "../financialAudit";

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

  // Write inverted journal lines
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
