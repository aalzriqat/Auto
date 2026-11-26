import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { supportedCurrencyScale } from "../utils/money";
import { loadOpeningSourceIdentity } from "../utils/openingSourceIdentity";
import { checkPostingAllowed } from "../utils/postingPeriod";
import type { RuleResult } from "./postingRules";

/**
 * SCRUM-1012 (owner ruling 2026-11-26): a bank account created after the organization's opening entry stores its
 * stated opening balance as metadata only, so its book balance reads 0 and the single opening entry cannot be
 * repeated. This family posts that stored balance ONCE, against Opening suspense (1900): debit the bank (naming it),
 * credit 1900. Nothing typed by a caller decides the amount, the date or the currency: all three are re-derived from
 * the stored bank by `evaluateLateBankOpening`, for the owner door and again for the posting engine.
 *
 * Distinct from the organization opening on purpose. The journal's category is ADJUSTMENT and its source is
 * `bankOpeningBalances`, so `findPostedOpeningBalanceJournal`, `loadOpeningSourceIdentity`, `hasOpeningBalanceCommitment`
 * and the opening-void proof (which all key on category OPENING_BALANCE / source `cutover`) never see it as a second
 * opening. `openingLedgerHasActivity` and `hasPostedLedgerActivity` DO count it as ledger activity, which is correct:
 * once it exists the organization opening can no longer be voided or repeated.
 */
export const LATE_BANK_OPENING_EVENT = "BANK_OPENING_BALANCE_LATE";
export const LATE_BANK_OPENING_SOURCE = "bankOpeningBalances";
export const LATE_BANK_OPENING_VERSION = 1;
/** The engine-level idempotency key: one per bank, so the database itself refuses a second posting. */
export function lateBankOpeningEventKey(bankAccountId: string): string {
  return `bank_opening_late_${bankAccountId}`;
}

type LateOpeningCode =
  | typeof AppErrorCode.LATE_BANK_OPENING_BANK_UNAVAILABLE
  | typeof AppErrorCode.LATE_BANK_OPENING_INVALID_BALANCE
  | typeof AppErrorCode.LATE_BANK_OPENING_ALREADY_POSTED
  | typeof AppErrorCode.LATE_BANK_OPENING_NO_ORG_OPENING
  | typeof AppErrorCode.LATE_BANK_OPENING_PERIOD_UNAVAILABLE
  | typeof AppErrorCode.LATE_BANK_OPENING_OWNER_ONLY
  | typeof AppErrorCode.LATE_BANK_OPENING_NOT_REVERSIBLE
  | typeof AppErrorCode.LATE_BANK_OPENING_EDIT_REFUSED
  | typeof AppErrorCode.LATE_BANK_OPENING_BEFORE_CUTOVER;

/** English text of every refusal; `ServerError_<code>` in lib/i18n/domains/common.ts carries the Arabic and must match. */
export const LATE_BANK_OPENING_MESSAGES: Record<LateOpeningCode, string> = {
  LATE_BANK_OPENING_BANK_UNAVAILABLE: "Choose an active bank account of this organization to post its opening balance.",
  LATE_BANK_OPENING_INVALID_BALANCE:
    "This bank's stored opening balance or date cannot be posted. Correct it first. Nothing was posted.",
  LATE_BANK_OPENING_ALREADY_POSTED: "An opening balance has already been posted for this bank account.",
  LATE_BANK_OPENING_NO_ORG_OPENING:
    "Post the organization's opening balances first. This action only adds a bank created after them.",
  LATE_BANK_OPENING_PERIOD_UNAVAILABLE:
    "The accounting period for the opening balance date is closed or not open. Nothing was posted.",
  LATE_BANK_OPENING_OWNER_ONLY: "Only an owner can post a bank opening balance.",
  LATE_BANK_OPENING_NOT_REVERSIBLE: "A posted bank opening balance cannot be reversed.",
  LATE_BANK_OPENING_EDIT_REFUSED:
    "This bank's opening balance has been posted, so its opening balance and date can no longer be changed.",
  LATE_BANK_OPENING_BEFORE_CUTOVER:
    "This bank's opening balance date is before the organization's opening entry date. Change it to the opening entry date or later. Nothing was posted.",
};

export function refuseLateBankOpening(code: LateOpeningCode): never {
  return throwAppError(code, LATE_BANK_OPENING_MESSAGES[code]);
}

const MAX_OPENING_LINES = 500;

const latePayload = z.object({
  bankAccountId: z.string().min(1),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export function readLateBankOpeningPayload(value: unknown) {
  const parsed = latePayload.safeParse(value);
  if (!parsed.success) throw new ConvexError("The bank opening balance could not be verified.");
  return parsed.data;
}

export function ruleLateBankOpening(value: unknown): RuleResult {
  const { bankAccountId, amountMinor } = readLateBankOpeningPayload(value);
  return {
    lines: [
      { accountSystemKey: SYSTEM_KEYS.BANK_ACCOUNT, bankAccountId, debitMinor: amountMinor, creditMinor: 0,
        description: "Opening balance posted after cutover" },
      { accountSystemKey: SYSTEM_KEYS.OPENING_SUSPENSE, debitMinor: 0, creditMinor: amountMinor,
        description: "Opening balance posted after cutover" },
    ],
    memo: "Bank opening balance posted after cutover",
    category: "ADJUSTMENT",
  };
}

type Reader = QueryCtx | MutationCtx;

export interface LateBankOpeningPlan {
  bankAccountId: Id<"bankAccounts">;
  name: string;
  currency: string;
  amountMinor: number;
  accountingDate: number;
}

type Evaluation = { ok: true; plan: LateBankOpeningPlan } | { ok: false; code: LateOpeningCode };

const DAY_MS = 86_400_000;

/** The organization's posted opening: the banks it names and its accounting date. */
interface OrgOpening { named: Set<string>; accountingDate: number }

/** The organization's posted opening, or null when it is absent, has no date, or cannot be proven. */
async function loadOrgOpening(ctx: Reader, orgId: Id<"organizations">): Promise<OrgOpening | null> {
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (source.status !== "AVAILABLE") return null;
  const accountingDate = source.journal.accountingDate;
  if (accountingDate === undefined || !Number.isSafeInteger(accountingDate)) return null;
  const journalId = source.journal._id;
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId)).take(MAX_OPENING_LINES + 1);
  if (lines.length > MAX_OPENING_LINES) return null;
  const named = new Set<string>();
  for (const line of lines) if (line.bankAccountId) named.add(String(line.bankAccountId));
  return { named, accountingDate };
}

export async function hasLateOpeningEvent(ctx: Reader, orgId: Id<"organizations">, bankAccountId: Id<"bankAccounts">) {
  const event = await ctx.db.query("accountingEvents")
    .withIndex("by_org_event_source_version", (q) => q.eq("orgId", orgId).eq("eventType", LATE_BANK_OPENING_EVENT)
      .eq("sourceType", LATE_BANK_OPENING_SOURCE).eq("sourceId", String(bankAccountId))).first();
  return event !== null;
}

/**
 * The single decision "may this bank's stored opening be posted now, and as what". Pure reads. The order is the
 * order a person would fix the problems in: the bank, then whether it already opened, then the stored figures, then
 * the organization opening, then the period.
 */
export async function evaluateLateBankOpening(
  ctx: Reader,
  orgId: Id<"organizations">,
  bank: Doc<"bankAccounts"> | null,
  orgOpeningIn?: OrgOpening | null,
): Promise<Evaluation> {
  const refuse = (code: LateOpeningCode): Evaluation => ({ ok: false, code });
  if (!bank || bank.orgId !== orgId || bank.isDeleted || !bank.isActive) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_BANK_UNAVAILABLE);
  }
  const orgOpening = orgOpeningIn === undefined ? await loadOrgOpening(ctx, orgId) : orgOpeningIn;
  if (orgOpening?.named.has(String(bank._id)) || await hasLateOpeningEvent(ctx, orgId, bank._id)) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_ALREADY_POSTED);
  }
  const amount = bank.openingBalanceMinor;
  const date = bank.openingBalanceDate;
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(date) || date < 0 ||
      date > Date.now() || supportedCurrencyScale(bank.currency) === null) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_INVALID_BALANCE);
  }
  if (orgOpening === null) return refuse(AppErrorCode.LATE_BANK_OPENING_NO_ORG_OPENING);
  // Activity dated before the posted opening would change balances that opening already states. Whole UTC days, as
  // the opening reconciliation compares them.
  if (Math.floor(date / DAY_MS) < Math.floor(orgOpening.accountingDate / DAY_MS)) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_BEFORE_CUTOVER);
  }
  const period = await checkPostingAllowed(ctx, orgId, date);
  if (!period.ok) return refuse(AppErrorCode.LATE_BANK_OPENING_PERIOD_UNAVAILABLE);
  return { ok: true, plan: { bankAccountId: bank._id, name: bank.name, currency: bank.currency, amountMinor: amount, accountingDate: date } };
}

/** `evaluateLateBankOpening`, thrown as a coded refusal. */
export async function planLateBankOpening(
  ctx: Reader,
  orgId: Id<"organizations">,
  bank: Doc<"bankAccounts"> | null,
): Promise<LateBankOpeningPlan> {
  const result = await evaluateLateBankOpening(ctx, orgId, bank);
  if (!result.ok) refuseLateBankOpening(result.code);
  return result.plan;
}

/**
 * Engine-side proof, called from `postAccountingEvent` for this event type only. Whatever the caller sent, the posting
 * must equal what the stored bank says, so no internal caller can post a different amount, date, currency or bank.
 */
export async function requireLateBankOpeningPosting(
  ctx: MutationCtx,
  command: {
    orgId: Id<"organizations">; currency: string; sourceType: string; sourceId: string; eventVersion: number;
    accountingDate: number; idempotencyKey: string; payload: unknown;
  },
) {
  const unverified = () => new ConvexError("The bank opening balance could not be verified.");
  if (command.sourceType !== LATE_BANK_OPENING_SOURCE || command.eventVersion !== LATE_BANK_OPENING_VERSION) throw unverified();
  const payload = readLateBankOpeningPayload(command.payload);
  const bankAccountId = ctx.db.normalizeId("bankAccounts", payload.bankAccountId);
  if (!bankAccountId || command.sourceId !== payload.bankAccountId ||
      command.idempotencyKey !== lateBankOpeningEventKey(payload.bankAccountId)) throw unverified();
  const plan = await planLateBankOpening(ctx, command.orgId, await ctx.db.get(bankAccountId));
  if (plan.amountMinor !== payload.amountMinor || plan.accountingDate !== command.accountingDate ||
      plan.currency.toUpperCase() !== command.currency.toUpperCase()) throw unverified();
}

/** True once an opening line (organization opening or this family) exists for the bank. Used to lock the stored figures. */
export async function bankHasOpeningLine(ctx: Reader, orgId: Id<"organizations">, bankAccountId: Id<"bankAccounts">) {
  if (await hasLateOpeningEvent(ctx, orgId, bankAccountId)) return true;
  const orgOpening = await loadOrgOpening(ctx, orgId);
  return orgOpening?.named.has(String(bankAccountId)) === true;
}

export interface LateOpeningOffer {
  bankAccountId: Id<"bankAccounts">;
  name: string;
  currency: string;
  amountMinor: number;
  openingBalanceDate: number;
  canPostLateOpening: boolean;
  /** The refusal code the server would give now; present only when `canPostLateOpening` is false. */
  blockedReason?: LateOpeningCode;
}

/**
 * The banks whose stored opening is non-zero and that have no opening line, each with a server-computed
 * `canPostLateOpening`. The caller (an owner-only query) decides who may see this.
 */
export async function listLateOpeningOffers(ctx: Reader, orgId: Id<"organizations">): Promise<LateOpeningOffer[]> {
  const MAX_BANKS = 200;
  const banks = await ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(MAX_BANKS + 1);
  if (banks.length > MAX_BANKS) return [];
  const orgOpening = await loadOrgOpening(ctx, orgId);
  const offers: LateOpeningOffer[] = [];
  for (const bank of banks) {
    if (bank.isDeleted || !bank.isActive || bank.openingBalanceMinor === 0 || orgOpening?.named.has(String(bank._id))) continue;
    if (await hasLateOpeningEvent(ctx, orgId, bank._id)) continue;
    const result = await evaluateLateBankOpening(ctx, orgId, bank, orgOpening);
    offers.push({
      bankAccountId: bank._id, name: bank.name, currency: bank.currency, amountMinor: bank.openingBalanceMinor,
      openingBalanceDate: bank.openingBalanceDate, canPostLateOpening: result.ok,
      ...(result.ok ? {} : { blockedReason: result.code }),
    });
  }
  return offers;
}
