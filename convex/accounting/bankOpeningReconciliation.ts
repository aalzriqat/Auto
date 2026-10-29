import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadOpeningSourceIdentity } from "../utils/openingSourceIdentity";
import { UNEXPLAINED_OPENING_DIFFERENCE_LABEL } from "../utils/closeWarnings";
import { SYSTEM_KEYS } from "../utils/defaultChart";

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
const MAX_OPENING_LINES = 500;

export type BankOpeningRow = {
  bankAccountId: Id<"bankAccounts">;
  name: string;
  currency: string;
  /** Net debit of this bank's lines in the posted opening; null when no opening is available. */
  openingLineMinor: number | null;
  /** The balance the dealer stated for this bank. Metadata only; never added to the GL. */
  referenceOpeningMinor: number;
  /** reference minus posted line; null when there is no opening or the currencies differ. */
  differenceMinor: number | null;
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

function withoutOpening(
  status: "NO_OPENING" | "OPENING_PROOF_UNAVAILABLE",
  banks: Doc<"bankAccounts">[],
): BankOpeningReconciliation {
  return {
    status,
    currency: null,
    asOfDate: null,
    banks: banks.map((bank) => ({
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
  const lines = await ctx.db
    .query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id))
    .take(MAX_OPENING_LINES + 1);
  if (lines.length > MAX_OPENING_LINES) return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);

  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accounts = await Promise.all(accountIds.map((id) => ctx.db.get(id)));
  const bankControlIds = new Set<string>();
  for (const account of accounts) {
    if (account && account.orgId === orgId && account.systemKey === SYSTEM_KEYS.BANK_ACCOUNT) {
      bankControlIds.add(String(account._id));
    }
  }

  let controlOpeningMinor = 0;
  let unattributedOpeningMinor = 0;
  const lineByBank = new Map<string, number>();
  for (const line of lines) {
    if (!bankControlIds.has(String(line.accountId))) continue;
    if (line.orgId !== orgId || line.currency !== openingCurrency) {
      return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);
    }
    const net = line.debitMinor - line.creditMinor;
    controlOpeningMinor += net;
    if (line.bankAccountId) {
      lineByBank.set(String(line.bankAccountId), (lineByBank.get(String(line.bankAccountId)) ?? 0) + net);
    } else {
      unattributedOpeningMinor += net;
    }
  }
  if (!Number.isSafeInteger(controlOpeningMinor) || !Number.isSafeInteger(unattributedOpeningMinor)) {
    return withoutOpening("OPENING_PROOF_UNAVAILABLE", liveBanks);
  }

  // A bank removed after the opening still owns its opening line, so it stays in the reconciliation.
  const shown = allBanks.filter((bank) => !bank.isDeleted || lineByBank.has(String(bank._id)));
  let bankLinesTotalMinor = 0;
  const byCurrency = new Map<string, { net: number; absolute: number }>();
  const banks: BankOpeningRow[] = shown.map((bank) => {
    const openingLineMinor = lineByBank.get(String(bank._id)) ?? 0;
    bankLinesTotalMinor += openingLineMinor;
    // Reference metadata in another currency cannot be compared to the opening's currency.
    const comparable = bank.currency === openingCurrency;
    const differenceMinor = comparable ? bank.openingBalanceMinor - openingLineMinor : null;
    if (differenceMinor !== null && differenceMinor !== 0) {
      const entry = byCurrency.get(bank.currency) ?? { net: 0, absolute: 0 };
      entry.net += differenceMinor;
      entry.absolute += Math.abs(differenceMinor);
      byCurrency.set(bank.currency, entry);
    }
    return {
      bankAccountId: bank._id,
      name: bank.name,
      currency: bank.currency,
      openingLineMinor,
      referenceOpeningMinor: bank.openingBalanceMinor,
      differenceMinor,
    };
  });

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
