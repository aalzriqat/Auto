import { loadOpeningSourceIdentity } from "./openingSourceIdentity";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { toMinorUnits } from "./money";

type ReceivableBasis =
  | { kind: "ORDINARY" }
  | { kind: "OPENING"; basisDate: number }
  | { kind: "INVALID"; reason: string };

const invalid = (): ReceivableBasis => ({ kind: "INVALID",
  reason: "The opening receivable basis cannot be verified. Ask finance to review it before collection." });

/** A mutable row marker cannot alone establish, or erase, a posted opening. */
export async function openingReceivableBasis(ctx: MutationCtx, orgId: Id<"organizations">,
  receivableId: Id<"receivables">): Promise<ReceivableBasis> {
  const receivable = await ctx.db.get(receivableId);
  if (!receivable || receivable.orgId !== orgId) return invalid();
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (source.status === "UNAVAILABLE") return invalid();
  const matches = source.headers.flatMap(parent => (parent.allocationResults ?? [])
    .filter(row => row.kind === "CUSTOMER_RECEIVABLE" && row.receivableId === receivableId)
    .map(result => ({ parent, result })));
  if (!receivable.openingBalanceDraftId && matches.length === 0) return { kind: "ORDINARY" };
  const postedOpening = source.parent;
  if (!postedOpening || matches.length !== 1 || matches[0].parent._id !== postedOpening._id ||
      receivable.openingBalanceDraftId && receivable.openingBalanceDraftId !== postedOpening._id) return invalid();
  const references = [matches[0].result];
  const result = references[0];
  if (result.kind !== "CUSTOMER_RECEIVABLE" || !postedOpening.currency) return invalid();
  const allocations = postedOpening.allocations?.filter((row) =>
    row.kind === "CUSTOMER_RECEIVABLE" && row.rowKey === result.rowKey) ?? [];
  const allocation = allocations[0];
  if (allocations.length !== 1 || allocation?.kind !== "CUSTOMER_RECEIVABLE" ||
      allocation.customerId !== receivable.customerId ||
      !Number.isSafeInteger(allocation.amountMinor) || allocation.amountMinor <= 0 ||
      toMinorUnits(receivable.originalAmount, postedOpening.currency) !== allocation.amountMinor ||
      receivable.canonicalReceivableDocumentId !== result.canonicalReceivableDocumentId) return invalid();
  const canonical = await ctx.db.get(result.canonicalReceivableDocumentId);
  if (!canonical || canonical.orgId !== orgId || canonical.sourceType !== "legacy_receivable" ||
      canonical.sourceId !== String(receivableId) || canonical.documentType !== "INVOICE" ||
      canonical.customerId !== receivable.customerId || canonical.originalAmountMinor !== allocation.amountMinor ||
      canonical.issueDate !== postedOpening.asOfDate || canonical.currency !== postedOpening.currency) return invalid();
  const journal = postedOpening.journalEntryId ? await ctx.db.get(postedOpening.journalEntryId) : null;
  if (!journal || journal.orgId !== orgId || journal.status !== "POSTED" || journal.sourceType !== "cutover" ||
      journal.category !== "OPENING_BALANCE" || journal.sourceId !== String(orgId) ||
      journal.accountingDate !== postedOpening.asOfDate || journal.currency !== postedOpening.currency) return invalid();
  const siblings = postedOpening.allocations?.filter((row) => row.kind === "CUSTOMER_RECEIVABLE") ?? [];
  const total = siblings.reduce((sum, row) => sum + row.amountMinor, 0);
  if (siblings.length === 0 || siblings.length > 100 || !Number.isSafeInteger(total) ||
      siblings.some((row) => row.accountId !== allocation.accountId ||
        !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0)) return invalid();
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).collect();
  const arLines = lines.filter((line) => line.accountId === allocation.accountId);
  if (arLines.length === 0 || arLines.some((line) => line.orgId !== orgId ||
      line.currency !== postedOpening.currency || line.accountingDate !== postedOpening.asOfDate ||
      !Number.isSafeInteger(line.debitMinor) || line.debitMinor < 0 || line.creditMinor !== 0) ||
      arLines.reduce((sum, line) => sum + line.debitMinor, 0) !== total) return invalid();
  return { kind: "OPENING", basisDate: journal.accountingDate };
}
