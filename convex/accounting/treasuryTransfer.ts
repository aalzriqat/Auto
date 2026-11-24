import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireActiveBankInCurrency } from "../utils/bankAccountGuards";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import { supportedCurrencyScale } from "../utils/money";
import type { RuleResult } from "./postingRules";

export const TREASURY_TRANSFER_EVENT = "TREASURY_TRANSFER";
export const TREASURY_TRANSFER_SOURCE = "treasuryTransfers";

const transferPayload = z.object({
  fromBankAccountId: z.string().min(1).nullable(),
  toBankAccountId: z.string().min(1).nullable(),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reference: z.string().trim().min(1).max(160),
}).strict().refine(value => value.fromBankAccountId !== value.toBankAccountId);

export function readTreasuryTransferPayload(value: unknown) {
  const parsed = transferPayload.safeParse(value);
  if (!parsed.success) throw new ConvexError("Enter two different accounts, a valid transfer amount and a confirmation reference.");
  return parsed.data;
}

type TransferPayload = ReturnType<typeof readTreasuryTransferPayload>;

export function requireTransferDate(value: number, from = 0) {
  if (!Number.isSafeInteger(value) || value < from || value > Date.now()) {
    throw new ConvexError("Enter a valid transfer date.");
  }
}

function assetLine(bankAccountId: string | null, debitMinor: number, creditMinor: number, description: string) {
  return bankAccountId
    ? { accountSystemKey: SYSTEM_KEYS.BANK_ACCOUNT, bankAccountId, debitMinor, creditMinor, description }
    : { accountSystemKey: SYSTEM_KEYS.CASH_ON_HAND, debitMinor, creditMinor, description };
}

export interface CashDrawerDepositedPayload {
  sessionId: string;
  amountMinor: number;
  currency: string;
  /** Historic queued events may lack the physical bank and must be refused. */
  bankAccountId?: string;
}

export function ruleCashDrawerDeposited(p: CashDrawerDepositedPayload): RuleResult {
  if (!p.bankAccountId) throw new Error("A cash drawer bank deposit requires its physical bank account.");
  return {
    lines: [
      assetLine(p.bankAccountId, p.amountMinor, 0, "Cash drawer deposited to bank"),
      assetLine(null, 0, p.amountMinor, "Drawer cash removed"),
    ],
    memo: "Cash drawer session deposited",
    category: "SYSTEM",
  };
}

export function ruleTreasuryTransfer(value: unknown): RuleResult {
  const { amountMinor, fromBankAccountId, toBankAccountId, reference } = readTreasuryTransferPayload(value);
  return {
    lines: [
      assetLine(toBankAccountId, amountMinor, 0, "Transfer in"),
      assetLine(fromBankAccountId, 0, amountMinor, "Transfer out"),
    ],
    memo: reference,
    category: "SYSTEM",
  };
}

async function requireSettledDrawer(ctx: MutationCtx, orgId: Id<"organizations">, payload: TransferPayload) {
  if (payload.fromBankAccountId && payload.toBankAccountId) return;
  const unsettledStatuses = ["OPEN", "COUNTING", "CLOSED"] as const;
  const unsettled = await Promise.all(unsettledStatuses.map(status => ctx.db.query("cashDrawerSessions")
    .withIndex("by_org_status", q => q.eq("orgId", orgId).eq("status", status)).first()));
  if (unsettled.some(Boolean)) throw new ConvexError("Close and settle the cash drawer before recording a cash transfer.");
}

export async function requireTreasuryPosting(
  ctx: MutationCtx,
  command: { orgId: Id<"organizations">; currency: string; sourceType: string; accountingDate: number; payload: unknown },
) {
  if (command.sourceType !== TREASURY_TRANSFER_SOURCE || supportedCurrencyScale(command.currency) === null) {
    throw new ConvexError("The transfer source or currency could not be verified.");
  }
  requireTransferDate(command.accountingDate);
  const payload = readTreasuryTransferPayload(command.payload);
  for (const value of [payload.fromBankAccountId, payload.toBankAccountId]) {
    if (value === null) continue;
    const bankAccountId = ctx.db.normalizeId("bankAccounts", value) ?? undefined;
    await requireActiveBankInCurrency(ctx, { orgId: command.orgId, bankAccountId, currency: command.currency,
      missingMessage: "Choose an active bank account.", currencySubject: "transfer" });
  }
  await requireSettledDrawer(ctx, command.orgId, payload);
}

export async function requireTreasuryReversal(ctx: MutationCtx, original: Doc<"accountingEvents">, reversalDate: number) {
  const journalEntryId = original.journalEntryId;
  if (original.sourceType !== TREASURY_TRANSFER_SOURCE || !journalEntryId) {
    throw new ConvexError("The original transfer could not be verified.");
  }
  requireTransferDate(reversalDate, original.accountingDate);
  const payload = readTreasuryTransferPayload(original.payload);
  await requireSettledDrawer(ctx, original.orgId, payload);
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", q => q.eq("journalEntryId", journalEntryId)).take(3);
  const debit = lines.find(line => line.lineNumber === 1);
  const credit = lines.find(line => line.lineNumber === 2);
  if (lines.length !== 2 || !debit || !credit || lines.some(line => line.orgId !== original.orgId || line.currency !== original.currency) ||
      (debit.bankAccountId ?? null) !== payload.toBankAccountId || (credit.bankAccountId ?? null) !== payload.fromBankAccountId ||
      debit.debitMinor !== payload.amountMinor || debit.creditMinor !== 0 ||
      credit.creditMinor !== payload.amountMinor || credit.debitMinor !== 0) {
    throw new ConvexError("The original transfer journal could not be verified.");
  }
  const [destination, source] = await Promise.all([ctx.db.get(debit.accountId), ctx.db.get(credit.accountId)]);
  if (destination?.orgId !== original.orgId || source?.orgId !== original.orgId ||
      destination.systemKey !== (payload.toBankAccountId ? SYSTEM_KEYS.BANK_ACCOUNT : SYSTEM_KEYS.CASH_ON_HAND) ||
      source.systemKey !== (payload.fromBankAccountId ? SYSTEM_KEYS.BANK_ACCOUNT : SYSTEM_KEYS.CASH_ON_HAND)) {
    throw new ConvexError("The original transfer accounts could not be verified.");
  }
  const matched = await Promise.all(lines.map(line => ctx.db.query("bankStatementLines")
    .withIndex("by_matched_journal_line", q => q.eq("matchedJournalLineId", line._id)).first()));
  if (matched.some(Boolean)) throw new ConvexError("Unmatch the bank statement lines before reversing this transfer.");
}
