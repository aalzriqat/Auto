import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { postAccountingEvent } from "./accounting/postingEngine";
import { reverseAccountingEvent } from "./accounting/reversals";
import {
  readTreasuryTransferPayload, requireTransferDate, TREASURY_TRANSFER_EVENT, TREASURY_TRANSFER_SOURCE,
} from "./accounting/treasuryTransfer";
import { runWithIdempotency } from "./utils/idempotency";
import { supportedCurrencyScale } from "./utils/money";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

const bankId = v.union(v.id("bankAccounts"), v.null());

async function transferBoundary<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    console.error("Treasury transfer could not be verified", error);
    throw new ConvexError("The transfer could not be completed. Please try again later.");
  }
}

export const record = mutation({
  args: {
    orgId: v.id("organizations"), fromBankAccountId: bankId, toBankAccountId: bankId, currency: v.string(),
    amountMinor: v.number(), accountingDate: v.number(), reference: v.string(), idempotencyKey: v.string(),
  },
  returns: v.object({ eventId: v.id("accountingEvents"), journalEntryId: v.id("journalEntries") }),
  handler: async (ctx, args) => transferBoundary(async () => {
    const { orgId, fromBankAccountId, toBankAccountId, amountMinor, accountingDate, reference, idempotencyKey } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (membership.impersonationGrantId) throw new ConvexError("Use your own finance account to record a transfer.");
    requireTransferDate(accountingDate);
    const currency = args.currency.trim().toUpperCase();
    const payload = readTreasuryTransferPayload({ fromBankAccountId, toBankAccountId, amountMinor, reference });
    const sourceId = idempotencyKey.trim();
    return runWithIdempotency(ctx, {
      orgId, actorId: user._id, economic: true, operation: "bankTransfers.record", idempotencyKey,
      fingerprint: JSON.stringify([fromBankAccountId, toBankAccountId, amountMinor, currency, accountingDate, payload.reference]),
    }, async () => {
      const result = await postAccountingEvent(ctx, {
        orgId, eventType: TREASURY_TRANSFER_EVENT, sourceType: TREASURY_TRANSFER_SOURCE, sourceId,
        eventVersion: 1, accountingDate, occurredAt: accountingDate, currency, payload, actorId: user._id,
        idempotencyKey: "treasury_transfer_" + sourceId,
      });
      if (!result.eventId || !result.journalEntryId) throw new ConvexError("The transfer was not posted.");
      return { eventId: result.eventId, journalEntryId: result.journalEntryId };
    });
  }),
});

export const reverse = mutation({
  args: {
    orgId: v.id("organizations"), eventId: v.id("accountingEvents"), accountingDate: v.number(),
    reason: v.string(), idempotencyKey: v.string(),
  },
  returns: v.object({ reversalEventId: v.id("accountingEvents"), reversalJournalEntryId: v.id("journalEntries") }),
  handler: async (ctx, args) => transferBoundary(async () => {
    const { orgId, eventId, accountingDate, idempotencyKey } = args;
    const { user, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (membership.impersonationGrantId) throw new ConvexError("Use your own finance account to reverse a transfer.");
    const original = await requireOwnedRow(ctx, orgId, "accountingEvents", eventId);
    const reason = args.reason.trim();
    if (original.eventType !== TREASURY_TRANSFER_EVENT || original.sourceType !== TREASURY_TRANSFER_SOURCE ||
        !reason || reason.length > 500) throw new ConvexError("Choose a posted transfer and enter the reversal reason.");
    requireTransferDate(accountingDate, original.accountingDate);
    return runWithIdempotency(ctx, {
      orgId, actorId: user._id, economic: true, operation: "bankTransfers.reverse", idempotencyKey,
      fingerprint: JSON.stringify([eventId, accountingDate, reason]),
    }, async () => {
      if (original.status !== "POSTED") throw new ConvexError("This transfer is no longer available for reversal.");
      const { reversalEventId, reversalJournalEntryId } = await reverseAccountingEvent(ctx, {
        orgId, originalEventId: eventId, reversalDate: accountingDate, reason, actorId: user._id,
        idempotencyKey: "treasury_transfer_reversal_" + idempotencyKey.trim(),
      });
      return { reversalEventId, reversalJournalEntryId };
    });
  }),
});

export const recent = query({
  args: { orgId: v.id("organizations") },
  returns: v.union(v.null(), v.array(v.object({
    eventId: v.id("accountingEvents"), currency: v.string(), accountingDate: v.number(), amountMinor: v.number(),
    reference: v.string(), fromBankName: v.union(v.string(), v.null()), toBankName: v.union(v.string(), v.null()),
    reversed: v.boolean(),
  }))),
  handler: async (ctx, { orgId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_FINANCE]);
    return readRecentTransfers(ctx, orgId);
  },
});

async function readRecentTransfers(ctx: QueryCtx, orgId: Id<"organizations">) {
  try {
    const events = await ctx.db.query("accountingEvents")
      .withIndex("by_org_eventType", q => q.eq("orgId", orgId).eq("eventType", TREASURY_TRANSFER_EVENT))
      .order("desc").take(20);
    const transfers = events.map(event => {
      if (event.sourceType !== TREASURY_TRANSFER_SOURCE || !event.journalEntryId ||
          !Number.isSafeInteger(event.accountingDate) || event.accountingDate < 0 || event.accountingDate > Date.now() ||
          supportedCurrencyScale(event.currency) === null ||
          (event.status !== "POSTED" && event.status !== "REVERSED")) {
        throw new ConvexError("The transfer history could not be verified.");
      }
      return { event, payload: readTreasuryTransferPayload(event.payload) };
    });
    const names = new Map<string | null, string | null>([[null, null]]);
    const ids = new Set(transfers.flatMap(({ payload }) => [payload.fromBankAccountId, payload.toBankAccountId]));
    await Promise.all([...ids].map(async id => {
      if (id === null) return;
      const bankId: Id<"bankAccounts"> | null = ctx.db.normalizeId("bankAccounts", id);
      if (!bankId) throw new ConvexError("A transfer bank account could not be verified.");
      const bank = await requireOwnedRow(ctx, orgId, "bankAccounts", bankId);
      names.set(id, bank.name);
    }));
    return transfers.map(({ event, payload }) => ({
      eventId: event._id, currency: event.currency, accountingDate: event.accountingDate,
      amountMinor: payload.amountMinor, reference: payload.reference,
      fromBankName: names.get(payload.fromBankAccountId) ?? null, toBankName: names.get(payload.toBankAccountId) ?? null,
      reversed: event.status === "REVERSED",
    }));
  } catch (error) {
    console.error("Transfer history could not be verified", error);
    return null;
  }
}
