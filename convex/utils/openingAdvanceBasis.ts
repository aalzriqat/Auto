import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { resolveSystemAccount } from "../chartOfAccounts";
import { SYSTEM_KEYS } from "./defaultChart";

type AdvanceBasis = { kind: "ORDINARY" } | { kind: "OPENING"; basisDate: number } | { kind: "INVALID"; reason: string };
const invalid = (): AdvanceBasis => ({ kind: "INVALID", reason: "The opening advance basis cannot be verified. Ask finance to review it before repayment." });

/** Both consumers use the immutable parent and actual posted journal. A marker
 * alone is never authority; removing it cannot turn an opening into ordinary. */
export async function openingAdvanceBasis(ctx: MutationCtx, orgId: Id<"organizations">,
  advanceId: Id<"employeeAdvances">): Promise<AdvanceBasis> {
  const advance = await ctx.db.get(advanceId);
  const postedOpening = await ctx.db.query("openingBalanceDrafts").withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("status"), "POSTED")).first();
  const references = postedOpening?.allocationResults?.filter((row) => row.kind === "EMPLOYEE_ADVANCE" && row.advanceId === advanceId) ?? [];
  // Ordinary outbox prerequisites retain their existing event-based behavior,
  // including legacy events whose native row is no longer present.
  if (!advance?.openingBalanceDraftId && references.length === 0) return { kind: "ORDINARY" };
  if (!advance || advance.orgId !== orgId || advance.isDeleted) return invalid();
  if (!postedOpening || advance.openingBalanceDraftId !== postedOpening._id || references.length !== 1) return invalid();
  const result = references[0];
  const allocations = postedOpening.allocations?.filter((row) => row.kind === "EMPLOYEE_ADVANCE" && row.rowKey === result.rowKey) ?? [];
  const allocation = allocations[0];
  if (allocations.length !== 1 || allocation?.kind !== "EMPLOYEE_ADVANCE" || allocation.userId !== advance.userId ||
      allocation.amountMinor !== advance.amountMinor || postedOpening.currency !== advance.currency ||
      postedOpening.asOfDate !== advance.date || advance.method !== undefined || advance.bankAccountId !== undefined ||
      !Number.isSafeInteger(advance.amountMinor) || advance.amountMinor <= 0 ||
      !Number.isSafeInteger(advance.recoveredMinor) || advance.recoveredMinor < 0 || advance.recoveredMinor > advance.amountMinor) return invalid();
  const journal = postedOpening.journalEntryId ? await ctx.db.get(postedOpening.journalEntryId) : null;
  if (!journal || journal.orgId !== orgId || journal.status !== "POSTED" || journal.sourceType !== "cutover" ||
      journal.category !== "OPENING_BALANCE" || journal.sourceId !== String(orgId) ||
      journal.accountingDate !== advance.date || journal.currency !== advance.currency) return invalid();
  const canonicalAccount = await resolveSystemAccount(ctx, orgId, SYSTEM_KEYS.EMPLOYEE_ADVANCES);
  if (allocation.accountId !== canonicalAccount) return invalid();
  const siblings = postedOpening.allocations?.filter((row) => row.kind === "EMPLOYEE_ADVANCE") ?? [];
  const total = siblings.reduce((sum, row) => sum + row.amountMinor, 0);
  if (siblings.length === 0 || siblings.length > 100 || !Number.isSafeInteger(total) ||
      siblings.some((row) => row.accountId !== canonicalAccount || !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0)) return invalid();
  const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).collect();
  const accountLines = lines.filter((line) => line.accountId === canonicalAccount);
  if (accountLines.length === 0 || accountLines.some((line) => line.orgId !== orgId || line.currency !== advance.currency ||
      line.accountingDate !== advance.date || !Number.isSafeInteger(line.debitMinor) || line.debitMinor < 0 || line.creditMinor !== 0) ||
      accountLines.reduce((sum, line) => sum + line.debitMinor, 0) !== total) return invalid();
  return { kind: "OPENING", basisDate: journal.accountingDate };
}
