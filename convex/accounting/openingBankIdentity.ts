import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * SCRUM-858 c23884 / SCRUM-1012: which banks does a posted organization opening PROVE it already covers?
 *
 * One derivation, shared by the opening reconciliation (a read that reports differences) and the late bank opening
 * (a write that must never post a bank twice). Only IDENTITY is decided here; amounts, currencies and sums stay with
 * the caller. The opening is provable only when every line on a BANK_ACCOUNT control account of this organization
 * names a bank, every named bank resolves to a bank of this organization (a soft-deleted bank still resolves; a record
 * that is gone or belongs to another organization does not), and the opening is small enough to read completely.
 * A zero net never proves attribution: opposing unnamed legacy lines would otherwise disappear.
 */
export const MAX_OPENING_LINES = 500;

type Reader = QueryCtx | MutationCtx;

export type OpeningBankIdentity =
  | {
      status: "PROVABLE";
      /** Ids of the banks the opening names. Empty when the opening has no BANK_ACCOUNT control line at all. */
      named: Set<string>;
      /** The opening's lines on BANK_ACCOUNT control accounts of this organization, each naming a resolvable bank. */
      bankControlLines: Doc<"journalLines">[];
      /**
       * True when some opening line names a bank on an account that is NOT a bank control account of this organization.
       * Reported, not decided: the reconciliation ignores such lines (its GL side is the control lines only), while the
       * late bank opening treats them as unprovable.
       */
      namedOnNonBankLines: boolean;
    }
  | { status: "UNPROVABLE" };

export async function readOpeningBankIdentity(
  ctx: Reader,
  orgId: Id<"organizations">,
  journalId: Id<"journalEntries">,
): Promise<OpeningBankIdentity> {
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journalId)).take(MAX_OPENING_LINES + 1);
  if (lines.length > MAX_OPENING_LINES) return { status: "UNPROVABLE" };

  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accounts = await Promise.all(accountIds.map((id) => ctx.db.get(id)));
  const bankControlIds = new Set<string>();
  for (const account of accounts) {
    if (account && account.orgId === orgId && account.systemKey === SYSTEM_KEYS.BANK_ACCOUNT) {
      bankControlIds.add(String(account._id));
    }
  }

  const bankControlLines: Doc<"journalLines">[] = [];
  const named = new Set<string>();
  const namedIds = new Map<string, Id<"bankAccounts">>();
  let namedOnNonBankLines = false;
  for (const line of lines) {
    if (!bankControlIds.has(String(line.accountId))) {
      if (line.bankAccountId) namedOnNonBankLines = true;
      continue;
    }
    if (line.orgId !== orgId || !line.bankAccountId) return { status: "UNPROVABLE" };
    bankControlLines.push(line);
    named.add(String(line.bankAccountId));
    namedIds.set(String(line.bankAccountId), line.bankAccountId);
  }

  const resolved = await Promise.all([...namedIds.values()].map((id) => ctx.db.get(id)));
  if (resolved.some((bank) => !bank || bank.orgId !== orgId)) return { status: "UNPROVABLE" };
  return { status: "PROVABLE", named, bankControlLines, namedOnNonBankLines };
}
