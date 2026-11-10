import { v, type Infer } from "convex/values";
import type { PaginationOptions } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { readObligationPage, type ObligationRow, type ObligationKind } from "./supplierObligationDue";
import { alertStatusFor } from "./supplierDueAlertPlan";
import { readBoundedStream } from "./transactionReadHeadroom";
import { supportedCurrencyScale } from "./money";
import { SupplierReadBudgetExhausted } from "./supplierReadCache";
import { boundedCount } from "./paginationBounds";

export const attentionKind = v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY"));
const common = { kind: attentionKind, id: v.string(), currency: v.string(), outstandingMinor: v.number(), disputedMinor: v.number(),
  dueDate: v.union(v.string(), v.null()), daysOverdue: v.union(v.number(), v.null()) };
// Port of dc840b6c3: each row has exactly one usable eligibility variant.
const attentionRow = v.union(v.object({ ...common, status: v.literal("ALERTING"),
  step: v.union(v.literal("T_MINUS_3"), v.literal("DUE_DAY"), v.literal("OVERDUE_7"), v.literal("OVERDUE_WEEKLY")) }),
v.object({ ...common, status: v.literal("HELD"), heldReason: v.union(v.literal("NO_DUE_DATE"), v.literal("DISPUTED")) }));
export const attentionPage = v.object({ page: v.array(attentionRow), complete: v.boolean(), isDone: v.boolean(), continueCursor: v.string(),
  incompleteReason: v.optional(v.union(v.literal("READ_BUDGET"), v.literal("SPLIT_REQUIRED"))),
  pageStatus: v.union(v.literal("SplitRequired"), v.literal("SplitRecommended"), v.null()), splitCursor: v.union(v.string(), v.null()),
  asOfDate: v.string(), unlinked: v.union(v.literal("PRESENT"), v.literal("NONE"), v.literal("INCOMPLETE")) });

function attentionOf(row: ObligationRow): Infer<typeof attentionRow> | null {
  if (supportedCurrencyScale(row.currency) === null || !Number.isSafeInteger(row.outstandingMinor) ||
    !Number.isSafeInteger(row.disputedMinor) || row.outstandingMinor < 0 || row.disputedMinor < 0 || row.disputedMinor > row.outstandingMinor) {
    throw new Error("Unusable supplier attention money");
  }
  const state = alertStatusFor(row);
  if (state.status === "NOT_YET") return null;
  const fields = { kind: row.kind, id: row.id, currency: row.currency, outstandingMinor: row.outstandingMinor,
    disputedMinor: row.disputedMinor, dueDate: row.dueDate, daysOverdue: row.daysOverdue };
  if (state.status === "ALERTING") return { ...fields, status: state.status, step: state.step };
  return { ...fields, status: state.status, heldReason: state.reason };
}

const MAX_ROWS = 50;
const MAX_BYTES = 1024 * 1024;
function bounded(value: number | undefined, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return max;
  return boundedCount(value, max);
}

export async function readAttention(ctx: QueryCtx, args: { orgId: Id<"organizations">; supplierId: Id<"suppliers">; kind: ObligationKind; paginationOpts: PaginationOptions }, nowMs: number): Promise<Omit<Infer<typeof attentionPage>, "asOfDate" | "unlinked">> {
  const options = args.paginationOpts;
  let page: Awaited<ReturnType<typeof readObligationPage>>;
  try {
    page = await readObligationPage(ctx, { ...args, nowMs,
    paginationOpts: { cursor: options.cursor, endCursor: options.endCursor, numItems: bounded(options.numItems, MAX_ROWS),
      maximumRowsRead: bounded(options.maximumRowsRead, MAX_ROWS), maximumBytesRead: bounded(options.maximumBytesRead, MAX_BYTES) } });
  } catch (error) {
    if (!(error instanceof SupplierReadBudgetExhausted)) throw error;
    // Never advance a native cursor across obligations whose joined facts were unread.
    return { page: [], complete: false, isDone: false, continueCursor: options.cursor ?? "", pageStatus: null,
      splitCursor: null, incompleteReason: "READ_BUDGET" };
  }
  if (page.pageStatus === "SplitRequired") {
    // This native range may omit source rows. Refuse it without advancing over those rows.
    return { page: [], complete: false, isDone: false, continueCursor: options.cursor ?? "",
      pageStatus: page.pageStatus, splitCursor: page.splitCursor ?? null, incompleteReason: "SPLIT_REQUIRED" };
  }
  const rows: Infer<typeof attentionRow>[] = [];
  for (const row of page.rows) {
    const projected = attentionOf(row);
    if (projected) rows.push(projected);
  }
  return { page: rows, isDone: page.complete, continueCursor: page.continueCursor,
    complete: options.cursor === null && page.complete && !page.pageStatus,
    pageStatus: page.pageStatus ?? null, splitCursor: page.splitCursor ?? null };
}

/** Existence only, including history. No name inference, partial count, amounts or ordinary opening creditors. */
export async function unlinkedPresence(ctx: QueryCtx, orgId: Id<"organizations">, kind: ObligationKind): Promise<"PRESENT" | "NONE" | "INCOMPLETE"> {
  if (kind === "PAYABLE") {
    const read = await readBoundedStream(ctx, ctx.db.query("vehicleSupplierPayables")
      .withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", orgId).eq("supplierId", undefined)), MAX_ROWS);
    if (read.docs.some(row => row.origin !== "OPENING" || row.openingKind !== "OTHER_PAYABLE")) return "PRESENT";
    return read.outOfHeadroom || read.docs.length > MAX_ROWS ? "INCOMPLETE" : "NONE";
  }
  const table = kind === "RECEIVABLE" ? "vehicleSupplierReceivables" : "supplierCostRecoveries";
  const source = ctx.db.query(table).withIndex("by_org_and_supplierId_and_status", q => q.eq("orgId", orgId).eq("supplierId", undefined));
  const read = await readBoundedStream(ctx, source, 0);
  if (read.docs.length > 0) return "PRESENT";
  return read.outOfHeadroom ? "INCOMPLETE" : "NONE";
}
