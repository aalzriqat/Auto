import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadOpeningSourceIdentity } from "../utils/openingSourceIdentity";
import { UNEXPLAINED_OPENING_DIFFERENCE_LABEL } from "../utils/closeWarnings";
import { hasLateOpeningEvent } from "./lateBankOpening";
import { readOpeningBankIdentity } from "./openingBankIdentity";

/**
 * SCRUM-858 S5 (owner ruling SCRUM-858#c23884): each physical bank opens as its own balance and reconciles to the
 * GL bank account. This is a READ. It never posts, never adjusts a balance and never forces two sides to agree: a
 * difference between what the dealer stated for a bank (`bankAccounts.openingBalanceMinor`, reference metadata) and
 * what the approved opening posted for that bank is reported under the owner's label until finance resolves it.
 *
 * The GL side is the posted OPENING_BALANCE journal's own BANK_ACCOUNT lines, the lines the bank aggregate sums.
 * Movement after the opening is read with `bankAccounts.getBookBalance`, not here.
 */

const MAX_BANKS = 200;
const DAY_MS = 86_400_000;

function accountingDay(date: number | undefined) {
  return date !== undefined && Number.isSafeInteger(date) && date >= 0 && date <= 8_640_000_000_000_000
    ? Math.floor(date / DAY_MS)
    : null;
}

export function compareBankStatementDate(statementDate: number, openingDate: number | undefined) {
  const statementDay = accountingDay(statementDate);
  const openingDay = accountingDay(openingDate);
  if (statementDay === null || openingDay === null || statementDay < openingDay) return "UNAVAILABLE";
  return statementDay === openingDay ? "SAME_DAY" : "AFTER_OPENING";
}

export type BankOpeningRow = {
  bankAccountId: Id<"bankAccounts">;
  name: string;
  currency: string;
  /** Net debit of this bank's lines in the posted opening; null when no opening is available. */
  openingLineMinor: number | null;
  /** The balance the dealer stated for this bank. Metadata only; never added to the GL. */
  referenceOpeningMinor: number;
  /** Reference minus the posted line when the accounting day and currency both match. */
  differenceMinor: number | null;
  referenceAfterOpening?: true;
  referenceNotComparable?: true;
  /** SCRUM-1012: this bank's stated balance was posted after cutover by its own late-opening journal. */
  lateOpeningPosted?: true;
};

export type BankOpeningReconciliation = {
  status: "OK" | "NO_OPENING" | "OPENING_PROOF_UNAVAILABLE";
  currency: string | null;
  asOfDate: number | null;
  banks: BankOpeningRow[];
  /** Net of every BANK_ACCOUNT line in the posted opening, attributed or not. */
  controlOpeningMinor: number | null;
  /** Net of the lines that name a bank. */
  bankLinesTotalMinor: number | null;
  /** Net of BANK_ACCOUNT opening lines that name no bank (history from before bank identity was required). */
  unattributedOpeningMinor: number | null;
  unexplainedOpeningDifference: {
    label: { en: string; ar: string };
    currencies: { currency: string; differenceMinor: number; absoluteDifferenceMinor: number }[];
  } | null;
};

class UnsafeMinorAmount extends Error {}

/** The value itself when it is a safe integer (ECMA-262 Number.isSafeInteger: |n| <= 2^53 - 1), else a refusal. */
function exactMinor(value: number): number {
  if (!Number.isSafeInteger(value)) throw new UnsafeMinorAmount("A minor-unit amount is not a safe integer.");
  return value;
}

function withoutOpening(
  status: "NO_OPENING" | "OPENING_PROOF_UNAVAILABLE",
  banks: Doc<"bankAccounts">[],
): BankOpeningReconciliation {
  const hasUnsafeReference = banks.some((bank) => !Number.isSafeInteger(bank.openingBalanceMinor));
  return {
    status: hasUnsafeReference ? "OPENING_PROOF_UNAVAILABLE" : status,
    currency: null,
    asOfDate: null,
    banks: (hasUnsafeReference ? [] : banks).map((bank) => ({
      bankAccountId: bank._id,
      name: bank.name,
      currency: bank.currency,
      openingLineMinor: null,
      referenceOpeningMinor: bank.openingBalanceMinor,
      differenceMinor: null,
    })),
    controlOpeningMinor: null,
    bankLinesTotalMinor: null,
    unattributedOpeningMinor: null,
    unexplainedOpeningDifference: null,
  };
}

export async function computeBankOpeningReconciliation(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<BankOpeningReconciliation> {
  const allBanks = await ctx.db.query("bankAccounts").withIndex("by_org", (q) => q.eq("orgId", orgId)).take(MAX_BANKS + 1);
  const liveBanks = allBanks.filter((bank) => !bank.isDeleted);
  if (allBanks.length > MAX_BANKS) return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks.slice(0, MAX_BANKS));

  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (source.status !== "AVAILABLE") {
    return withoutOpening(source.status === "ABSENT" ? "NO_OPENING" : "OPENING_PROOF_UNAVAILABLE", liveBanks);
  }

  const journal = source.journal;
  const openingCurrency = journal.currency;
  // An opening journal that names no currency cannot be compared with any bank, so no figures are claimed.
  if (!openingCurrency) return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);
  // The identity rules (too many lines; a bank-control line of another organization or naming no bank; a named bank
  // this organization cannot resolve) are shared with the late bank opening: `readOpeningBankIdentity`. A zero net does
  // not prove attribution: opposing unnamed legacy lines would otherwise disappear, and two unresolved lines of +3.000
  // and -3.000 net to zero. Any unprovable identity makes the opening unavailable, whatever its net, and nothing is
  // posted or adjusted to balance it (c23884).
  const identity = await readOpeningBankIdentity(ctx, orgId, journal._id);
  if (identity.status !== "PROVABLE") return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);

  // Every operand and every running total must stay an exact integer count of minor units. Past 2^53 - 1 a sum is
  // rounded (and 1e308 + 1e308 is Infinity), so a figure that cannot be proven exact is never reported as OK.
  let controlOpeningMinor = 0;
  // Every bank-control line names a resolvable bank once the identity is provable, so nothing is unattributed.
  const unattributedOpeningMinor = 0;
  const lineByBank = new Map<string, number>();
  let banks: BankOpeningRow[] = [];
  let bankLinesTotalMinor = 0;
  const byCurrency = new Map<string, { net: number; absolute: number }>();
  try {
    for (const line of identity.bankControlLines) {
      if (line.currency !== openingCurrency) return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);
      const net = exactMinor(exactMinor(line.debitMinor) - exactMinor(line.creditMinor));
      controlOpeningMinor = exactMinor(controlOpeningMinor + net);
      const bankKey = String(line.bankAccountId);
      lineByBank.set(bankKey, exactMinor((lineByBank.get(bankKey) ?? 0) + net));
    }

    // A bank removed after the opening still owns its opening line, so it stays in the reconciliation.
    const shown = allBanks.filter((bank) => !bank.isDeleted || lineByBank.has(String(bank._id)));
    // SCRUM-1012: a bank opened after cutover has its stated balance posted by its own late-opening journal, outside the
    // organization's opening entry this report reads. Its stated figure is therefore explained, not a difference.
    const lateOpened = new Set<string>();
    for (const bank of shown) {
      if (await hasLateOpeningEvent(ctx, orgId, bank._id)) lateOpened.add(String(bank._id));
    }
    banks = shown.map((bank) => {
      const openingLineMinor = lineByBank.get(String(bank._id)) ?? 0;
      bankLinesTotalMinor = exactMinor(bankLinesTotalMinor + openingLineMinor);
      const referenceOpeningMinor = exactMinor(bank.openingBalanceMinor);
      if (lateOpened.has(String(bank._id))) {
        return {
          bankAccountId: bank._id, name: bank.name, currency: bank.currency, openingLineMinor, referenceOpeningMinor,
          differenceMinor: null, lateOpeningPosted: true as const,
        };
      }
      // Only compare balances for the same UTC accounting day.
      const dateRelation = compareBankStatementDate(bank.openingBalanceDate, journal.accountingDate);
      const referenceAfterOpening = dateRelation === "AFTER_OPENING";
      const comparable = bank.currency === openingCurrency && dateRelation === "SAME_DAY";
      const differenceMinor = comparable ? exactMinor(referenceOpeningMinor - openingLineMinor) : null;
      if (differenceMinor !== null && differenceMinor !== 0) {
        const entry = byCurrency.get(bank.currency) ?? { net: 0, absolute: 0 };
        entry.net = exactMinor(entry.net + differenceMinor);
        entry.absolute = exactMinor(entry.absolute + exactMinor(Math.abs(differenceMinor)));
        byCurrency.set(bank.currency, entry);
      }
      return {
        bankAccountId: bank._id,
        name: bank.name,
        currency: bank.currency,
        openingLineMinor,
        referenceOpeningMinor,
        differenceMinor,
        ...(referenceAfterOpening ? { referenceAfterOpening: true as const } : {}),
        ...(!comparable && !referenceAfterOpening ? { referenceNotComparable: true as const } : {}),
      };
    });
    // Every minor unit of the control is either on a resolved bank or disclosed as unattributed. Anything else is
    // an amount the report cannot explain, so it is refused rather than shown.
    if (exactMinor(bankLinesTotalMinor + unattributedOpeningMinor) !== controlOpeningMinor) {
      return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);
    }
  } catch (error) {
    if (error instanceof UnsafeMinorAmount) return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);
    throw error;
  }

  return {
    status: "OK",
    currency: openingCurrency,
    asOfDate: journal.accountingDate ?? null,
    banks,
    controlOpeningMinor,
    bankLinesTotalMinor,
    unattributedOpeningMinor,
    // Reported, never posted. Offsetting bank differences still raise it: the net is shown beside the absolute total.
    unexplainedOpeningDifference:
      byCurrency.size === 0
        ? null
        : {
            label: { ...UNEXPLAINED_OPENING_DIFFERENCE_LABEL },
            currencies: [...byCurrency.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([currency, entry]) => ({
                currency,
                differenceMinor: entry.net,
                absoluteDifferenceMinor: entry.absolute,
              })),
          },
  };
}
