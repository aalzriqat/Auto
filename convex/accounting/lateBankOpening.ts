import { ConvexError } from "convex/values";
import { z } from "zod";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "../utils/defaultChart";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { supportedCurrencyScale } from "../utils/money";
import { loadOpeningSourceIdentity } from "../utils/openingSourceIdentity";
import { checkPostingAllowed } from "../utils/postingPeriod";
import { readOpeningBankIdentity } from "./openingBankIdentity";
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
  | typeof AppErrorCode.LATE_BANK_OPENING_BEFORE_CUTOVER
  | typeof AppErrorCode.LATE_BANK_OPENING_OPENING_UNPROVABLE
  | typeof AppErrorCode.LATE_BANK_OPENING_EDIT_UNPROVABLE
  | typeof AppErrorCode.LATE_BANK_OPENING_FIGURES_CHANGED;

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
  LATE_BANK_OPENING_OPENING_UNPROVABLE:
    "The organization's opening entry cannot be shown to name every bank it already covers (for example, one of its bank lines names no bank). This bank's opening balance cannot be posted here. Nothing was posted.",
  LATE_BANK_OPENING_EDIT_UNPROVABLE:
    "This bank's opening balance and date cannot be changed while the organization's opening entry cannot be shown to name every bank it already covers.",
  LATE_BANK_OPENING_FIGURES_CHANGED: "The bank's opening figures changed since this screen loaded. Review them and try again. Nothing was posted.",
};

export function refuseLateBankOpening(code: LateOpeningCode): never {
  return throwAppError(code, LATE_BANK_OPENING_MESSAGES[code]);
}

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

/**
 * The organization's posted opening as far as it can be PROVEN. ABSENT: no live opening exists. UNPROVABLE: one exists
 * but it cannot be shown which banks it already covers (an unnamed or unresolvable bank line, too many lines, an
 * unavailable source or no date), so nothing may be decided from it. AVAILABLE: the banks it names and its date.
 * The identity rules are the opening reconciliation's own (`readOpeningBankIdentity`), not a second copy.
 */
type OrgOpening =
  | { status: "ABSENT" }
  | { status: "UNPROVABLE" }
  | { status: "AVAILABLE"; named: Set<string>; accountingDate: number };

async function loadOrgOpening(ctx: Reader, orgId: Id<"organizations">): Promise<OrgOpening> {
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (source.status === "ABSENT") return { status: "ABSENT" };
  if (source.status !== "AVAILABLE") return { status: "UNPROVABLE" };
  const accountingDate = source.journal.accountingDate;
  if (accountingDate === undefined || !Number.isSafeInteger(accountingDate)) return { status: "UNPROVABLE" };
  const identity = await readOpeningBankIdentity(ctx, orgId, source.journal._id);
  if (identity.status !== "PROVABLE") return { status: "UNPROVABLE" };
  // Late-opening side only (the reconciliation ignores such lines and reports OK): a bank named on an account that is
  // not a bank control account means the opening's bank attribution is not the clean one this decision relies on.
  if (identity.namedOnNonBankLines) return { status: "UNPROVABLE" };
  return { status: "AVAILABLE", named: identity.named, accountingDate };
}
export async function hasLateOpeningEvent(ctx: Reader, orgId: Id<"organizations">, bankAccountId: Id<"bankAccounts">) {
  const event = await ctx.db.query("accountingEvents")
    .withIndex("by_org_event_source_version", (q) => q.eq("orgId", orgId).eq("eventType", LATE_BANK_OPENING_EVENT)
      .eq("sourceType", LATE_BANK_OPENING_SOURCE).eq("sourceId", String(bankAccountId))).first();
  return event !== null;
}

/** At most one late opening per bank and an organization lists at most this many banks, so this bounds its 1900 lines. */
export const LATE_BANK_OPENING_MAX_BANKS = 200;

/**
 * SCRUM-1022: the one derivation of "this journal line belongs to a posted late bank opening of this organization".
 * Decided by event identity, never by memo text: the line is a pure credit of a POSTED, unreversed ADJUSTMENT journal
 * of this organization that is linked to a POSTED `BANK_OPENING_BALANCE_LATE` event of this organization whose source,
 * version, journal link and per-bank idempotency key are the ones `postAccountingEvent` stamped for it.
 */
export async function isLateBankOpeningLine(ctx: Reader, orgId: Id<"organizations">, line: Doc<"journalLines">): Promise<boolean> {
  if (line.orgId !== orgId || line.debitMinor !== 0 || line.creditMinor <= 0) return false;
  const journal = await ctx.db.get(line.journalEntryId);
  if (!journal || journal.orgId !== orgId || journal.status !== "POSTED" || journal.reversedByJournalEntryId ||
      journal.category !== "ADJUSTMENT" || journal.sourceType !== LATE_BANK_OPENING_SOURCE || !journal.accountingEventId) return false;
  const event = await ctx.db.get(journal.accountingEventId);
  return event !== null && event.orgId === orgId && event.status === "POSTED" &&
    event.eventType === LATE_BANK_OPENING_EVENT && event.sourceType === LATE_BANK_OPENING_SOURCE &&
    event.eventVersion === LATE_BANK_OPENING_VERSION && event.sourceId === journal.sourceId &&
    event.journalEntryId === journal._id && event.idempotencyKey === lateBankOpeningEventKey(event.sourceId);
}

/**
 * The single decision "may this bank's stored opening be posted now, and as what". Pure reads. The order is the
 * order a person would fix the problems in: the bank, then whether it already has its own late opening (a fact that
 * needs no proof), then the organization opening (absent, or unprovable, which must refuse BEFORE "already in the
 * opening" is decided from a set that may be incomplete), then whether the opening names the bank, then the stored
 * figures, then the cutover date and the period.
 */
/** The figures the owner's screen showed when confirming (SCRUM-1012 F3). */
export interface ExpectedOpeningFigures { amountMinor: number; openingBalanceDate: number }

export async function evaluateLateBankOpening(
  ctx: Reader,
  orgId: Id<"organizations">,
  bank: Doc<"bankAccounts"> | null,
  orgOpeningIn?: OrgOpening,
  expected?: ExpectedOpeningFigures,
): Promise<Evaluation> {
  const refuse = (code: LateOpeningCode): Evaluation => ({ ok: false, code });
  if (!bank || bank.orgId !== orgId || bank.isDeleted || !bank.isActive) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_BANK_UNAVAILABLE);
  }
  if (await hasLateOpeningEvent(ctx, orgId, bank._id)) return refuse(AppErrorCode.LATE_BANK_OPENING_ALREADY_POSTED);
  const orgOpening = orgOpeningIn ?? await loadOrgOpening(ctx, orgId);
  if (orgOpening.status === "ABSENT") return refuse(AppErrorCode.LATE_BANK_OPENING_NO_ORG_OPENING);
  if (orgOpening.status === "UNPROVABLE") return refuse(AppErrorCode.LATE_BANK_OPENING_OPENING_UNPROVABLE);
  if (orgOpening.named.has(String(bank._id))) return refuse(AppErrorCode.LATE_BANK_OPENING_ALREADY_POSTED);
  const amount = bank.openingBalanceMinor;
  const date = bank.openingBalanceDate;
  // Comparison only: the owner confirmed the figures the screen showed; the posting still uses the stored ones.
  if (expected && (expected.amountMinor !== amount || expected.openingBalanceDate !== date)) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_FIGURES_CHANGED);
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(date) || date < 0 ||
      date > Date.now() || supportedCurrencyScale(bank.currency) === null) {
    return refuse(AppErrorCode.LATE_BANK_OPENING_INVALID_BALANCE);
  }
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
  expected?: ExpectedOpeningFigures,
): Promise<LateBankOpeningPlan> {
  const result = await evaluateLateBankOpening(ctx, orgId, bank, undefined, expected);
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

/**
 * Why the bank's stored opening figures may not be edited, or null when they may. Locked once an opening line
 * (organization opening or this family) exists for the bank, and while the organization opening cannot be proven to
 * exclude it: an edit then could change a figure the ledger may already be built on.
 */
export async function bankOpeningEditLock(
  ctx: Reader, orgId: Id<"organizations">, bankAccountId: Id<"bankAccounts">,
): Promise<LateOpeningCode | null> {
  if (await hasLateOpeningEvent(ctx, orgId, bankAccountId)) return AppErrorCode.LATE_BANK_OPENING_EDIT_REFUSED;
  const orgOpening = await loadOrgOpening(ctx, orgId);
  if (orgOpening.status === "UNPROVABLE") return AppErrorCode.LATE_BANK_OPENING_EDIT_UNPROVABLE;
  return orgOpening.status === "AVAILABLE" && orgOpening.named.has(String(bankAccountId))
    ? AppErrorCode.LATE_BANK_OPENING_EDIT_REFUSED : null;
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
  const banks = await ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(LATE_BANK_OPENING_MAX_BANKS + 1);
  if (banks.length > LATE_BANK_OPENING_MAX_BANKS) return [];
  const orgOpening = await loadOrgOpening(ctx, orgId);
  const offers: LateOpeningOffer[] = [];
  for (const bank of banks) {
    if (bank.isDeleted || !bank.isActive || bank.openingBalanceMinor === 0 || (orgOpening.status === "AVAILABLE" && orgOpening.named.has(String(bank._id)))) continue;
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
