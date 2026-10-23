import { loadOpeningSourceIdentity } from "./openingSourceIdentity";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export type PartnerOpeningContext = {
  parent: Doc<"openingBalanceDrafts"> | null;
  journal: Doc<"journalEntries"> | null;
  postedLinesValid: boolean;
  ambiguous: boolean;
  headers: Doc<"openingBalanceDrafts">[];
};
type PartnerBasis = { kind: "ORDINARY"; amountMinor: number } | { kind: "OPENING"; amountMinor: number } | { kind: "INVALID" };

/** Bounded header and source-journal inventories identify the current partner basis. */
export async function loadPartnerOpening(ctx: QueryCtx, orgId: Id<"organizations">): Promise<PartnerOpeningContext> {
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  const { parent, journal } = source;
  let postedLinesValid = false;
  if (parent?.journalEntryId && parent.allocations?.some((row) => row.kind === "PARTNER_CAPITAL")) {
    // The immutable draft is only a claim about the GL. Check its posted lines
    // through the journal index before using any materialized partner base.
    const posted = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) =>
      q.eq("journalEntryId", parent.journalEntryId!)).take(parent.lines.length + 1);
    postedLinesValid = posted.length === parent.lines.length &&
      new Set(posted.map((line) => line.lineNumber)).size === posted.length && posted.every((line) => {
      const original = parent.lines[line.lineNumber - 1];
      return original !== undefined && line.orgId === orgId && line.journalEntryId === parent.journalEntryId &&
        line.currency === parent.currency && line.accountingDate === parent.asOfDate &&
        line.accountId === original.accountId && line.debitMinor === original.debitMinor &&
        line.creditMinor === original.creditMinor && line.bankAccountId === original.bankAccountId &&
        line.description === original.description;
    });
  }
  return { parent, journal, postedLinesValid, ambiguous: source.status === "UNAVAILABLE", headers: source.headers };
}

export function openingPartnerBasis(partner: Doc<"partnerEquity">, currency: string,
  context: PartnerOpeningContext, legacyBaseMinor: number): PartnerBasis {
  const { parent, journal } = context;
  if (context.ambiguous) return { kind: "INVALID" };
  const rows = parent?.allocations?.filter((row) => row.kind === "PARTNER_CAPITAL" && row.partnerId === partner._id) ?? [];
  const references = parent?.allocationResults?.filter((row) => row.kind === "PARTNER_CAPITAL" && row.partnerId === partner._id) ?? [];
  const historicalReference = context.headers.some(header => header._id !== parent?._id &&
    ((header.allocations ?? []).some(row => row.kind === "PARTNER_CAPITAL" && row.partnerId === partner._id) ||
      (header.allocationResults ?? []).some(row => row.kind === "PARTNER_CAPITAL" && row.partnerId === partner._id)));
  if (historicalReference) return { kind: "INVALID" };
  if (!partner.openingBalanceDraftId && rows.length === 0 && references.length === 0) {
    return Number.isSafeInteger(legacyBaseMinor) ? { kind: "ORDINARY", amountMinor: legacyBaseMinor } : { kind: "INVALID" };
  }
  if (!parent || !context.postedLinesValid || partner.openingBalanceDraftId !== parent._id || parent.orgId !== partner.orgId || parent.currency !== currency ||
      !journal || journal.orgId !== partner.orgId || journal.status !== "POSTED" || journal.sourceType !== "cutover" ||
      journal.category !== "OPENING_BALANCE" || journal.sourceId !== String(partner.orgId) || journal.currency !== currency ||
      journal.accountingDate !== parent.asOfDate || !Number.isSafeInteger(parent.asOfDate) ||
      (parent.allocations?.length ?? 0) > 100 || (parent.allocationResults?.length ?? 0) > 100 ||
      rows.length === 0 || rows.length !== references.length) return { kind: "INVALID" };
  const keys = new Set<string>();
  let total = 0;
  for (const row of rows) {
    if (keys.has(row.rowKey) || references.filter((result) => result.rowKey === row.rowKey).length !== 1 ||
        !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) return { kind: "INVALID" };
    keys.add(row.rowKey);
    total += row.amountMinor;
  }
  if (!Number.isSafeInteger(total) || total !== partner.openingBalanceMinor) return { kind: "INVALID" };
  return { kind: "OPENING", amountMinor: total };
}
