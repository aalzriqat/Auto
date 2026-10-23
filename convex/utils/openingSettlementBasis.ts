import { orgResetState } from "./orgResetGeneration";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import {
  openingAccountAllowsFamily,
  type RemainingOpeningKind,
} from "./openingAccountPolicy";

type Allocation = NonNullable<
  Doc<"openingBalanceDrafts">["allocations"]
>[number];
type RemainingAllocation = Extract<Allocation, { kind: RemainingOpeningKind }>;
type Result = NonNullable<
  Doc<"openingBalanceDrafts">["allocationResults"]
>[number];
export type OpeningSourceRef = {
  draftId: Id<"openingBalanceDrafts">;
  rowKey: string;
};
export type OpeningSettlementBasis =
  | {
      kind: "AVAILABLE";
      draftId: Id<"openingBalanceDrafts">;
      rowKey: string;
      allocation: RemainingAllocation;
      result: Result;
      accountId: Id<"chartOfAccounts">;
      currency: string;
      asOfDate: number;
      amountMinor: number;
    }
  | { kind: "UNAVAILABLE"; reason: string };
const unavailable = (): OpeningSettlementBasis => ({
  kind: "UNAVAILABLE",
  reason:
    "The opening obligation basis cannot be verified. Ask finance to review it before settlement.",
});

/** Read-only proof shared by source consumers; the embedded result is not an
 * account override. Every domain also proves its actual economic occurrence. */
const readerIdentity = Symbol("opening settlement request reader");
type ReadCtx = QueryCtx | MutationCtx;
export type OpeningSettlementReader = {
  readonly [readerIdentity]: true;
  readonly ctx: ReadCtx;
  readonly orgId: Id<"organizations">;
  readonly parent: (
    id: Id<"openingBalanceDrafts">,
  ) => Promise<Doc<"openingBalanceDrafts"> | null>;
  readonly lines: (id: Id<"journalEntries">) => Promise<Doc<"journalLines">[]>;
};
/** Explicitly request-local: only immutable opening rows and journal lines are
 * reused. Current organization/reset/account and occurrence state is never cached. */
export function createOpeningSettlementReader(
  ctx: ReadCtx,
  orgId: Id<"organizations">,
): OpeningSettlementReader {
  const parents = new Map<
    Id<"openingBalanceDrafts">,
    Promise<Doc<"openingBalanceDrafts"> | null>
  >();
  const lines = new Map<Id<"journalEntries">, Promise<Doc<"journalLines">[]>>();
  return {
    [readerIdentity]: true,
    ctx,
    orgId,
    parent(id) {
      let value = parents.get(id);
      if (!value) {
        value = ctx.db.get(id);
        parents.set(id, value);
      }
      return value;
    },
    lines(id) {
      let value = lines.get(id);
      if (!value) {
        value = ctx.db
          .query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", id))
          .take(201);
        lines.set(id, value);
      }
      return value;
    },
  };
}
async function hasCurrentOpeningJournal(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">,
  journalId: Id<"journalEntries"> | undefined): Promise<boolean> {
  const postedJournals = await ctx.db.query("journalEntries")
    .withIndex("by_org_source", q => q.eq("orgId", orgId).eq("sourceType", "cutover").eq("sourceId", String(orgId)))
    .take(101);
  const liveJournals = postedJournals.filter(entry => entry.status === "POSTED" && entry.category === "OPENING_BALANCE");
  return postedJournals.length <= 100 && liveJournals.length === 1 && liveJournals[0]._id === journalId;
}

function matchesOpeningSettlementJournal(journal: Doc<"journalEntries"> | null,
  orgId: Id<"organizations">, draft: Doc<"openingBalanceDrafts">): journal is Doc<"journalEntries"> {
  return !!journal && journal.orgId === orgId && journal.status === "POSTED" &&
    journal.category === "OPENING_BALANCE" && journal.sourceType === "cutover" && journal.sourceId === String(orgId) &&
    journal.currency === draft.currency && journal.accountingDate === draft.asOfDate;
}

export async function resolveOpeningSettlementBasis(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  ref: OpeningSourceRef,
  expectedKind: RemainingOpeningKind,
  reader?: OpeningSettlementReader,
): Promise<OpeningSettlementBasis> {
  const org = await ctx.db.get(orgId);
  if (!org || orgResetState(org).inProgress) return unavailable();
  if (
    reader &&
    (reader[readerIdentity] !== true ||
      reader.ctx !== ctx ||
      reader.orgId !== orgId)
  )
    return unavailable();
  const activeReader = reader ?? createOpeningSettlementReader(ctx, orgId);
  const draft = await activeReader.parent(ref.draftId);
  if (
    !draft ||
    draft.orgId !== orgId ||
    draft.status !== "POSTED" ||
    !draft.currency
  )
    return unavailable();
  if (!(await hasCurrentOpeningJournal(ctx, orgId, draft.journalEntryId))) return unavailable();
  const rows =
    draft.allocations?.filter((row) => row.rowKey === ref.rowKey) ?? [];
  const results =
    draft.allocationResults?.filter((row) => row.rowKey === ref.rowKey) ?? [];
  if (
    rows.length !== 1 ||
    results.length !== 1 ||
    rows[0].kind !== expectedKind ||
    results[0].kind !== expectedKind
  )
    return unavailable();
  const allocation = rows[0];
  if (
    allocation.kind !== "SUPPLIER_RECOVERABLE" &&
    allocation.kind !== "SUPPLIER_PAYABLE" &&
    allocation.kind !== "OTHER_PAYABLE" &&
    allocation.kind !== "EMPLOYEE_COMMISSION" &&
    allocation.kind !== "UNALLOCATED_LIABILITY"
  )
    return unavailable();
  if (
    !Number.isSafeInteger(allocation.amountMinor) ||
    allocation.amountMinor <= 0
  )
    return unavailable();
  const account = await ctx.db.get(allocation.accountId);
  const purpose = "purpose" in allocation ? allocation.purpose : undefined;
  if (
    !account ||
    !(await openingAccountAllowsFamily(
      ctx,
      orgId,
      account,
      draft.currency,
      allocation.kind,
      purpose,
    ))
  )
    return unavailable();
  const journal = draft.journalEntryId
    ? await ctx.db.get(draft.journalEntryId)
    : null;
  if (!matchesOpeningSettlementJournal(journal, orgId, draft)) return unavailable();
  const siblings =
    draft.allocations?.filter((row) => row.accountId === account._id) ?? [];
  const total = siblings.reduce((sum, row) => sum + row.amountMinor, 0);
  if (
    siblings.length === 0 ||
    siblings.length > 100 ||
    !Number.isSafeInteger(total) ||
    siblings.some(
      (row) => !Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0,
    )
  )
    return unavailable();
  const debit = allocation.kind === "SUPPLIER_RECOVERABLE";
  if (siblings.some((row) => (row.kind === "SUPPLIER_RECOVERABLE") !== debit))
    return unavailable();
  const allLines=await activeReader.lines(journal._id);
  if(allLines.length>200)return unavailable();
  const lines=allLines.filter(line=>line.accountId===account._id);
  if (
    lines.length === 0 ||
    lines.some(
      (line) =>
        line.orgId !== orgId ||
        line.currency !== draft.currency ||
        line.accountingDate !== draft.asOfDate ||
        !Number.isSafeInteger(line.debitMinor) ||
        !Number.isSafeInteger(line.creditMinor) ||
        line.debitMinor < 0 ||
        line.creditMinor < 0 ||
        (debit ? line.creditMinor !== 0 : line.debitMinor !== 0),
    ) ||
    lines.reduce(
      (sum, line) => sum + (debit ? line.debitMinor : line.creditMinor),
      0,
    ) !== total
  )
    return unavailable();
  return {
    kind: "AVAILABLE",
    draftId: draft._id,
    rowKey: allocation.rowKey,
    allocation,
    result: results[0],
    accountId: account._id,
    currency: draft.currency,
    asOfDate: draft.asOfDate,
    amountMinor: allocation.amountMinor,
  };
}

export async function requireOpeningSettlementBasis(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  ref: OpeningSourceRef,
  expectedKind: RemainingOpeningKind,
  reader?: OpeningSettlementReader,
) {
  const basis = await resolveOpeningSettlementBasis(
    ctx,
    orgId,
    ref,
    expectedKind,
    reader,
  );
  if (basis.kind !== "AVAILABLE") throw new ConvexError(basis.reason);
  return basis;
}
