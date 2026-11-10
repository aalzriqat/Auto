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
type AttentionResult = Omit<Infer<typeof attentionPage>, "asOfDate" | "unlinked" | "complete">;

function unavailablePage(cursor: string | null, incompleteReason: "READ_BUDGET" | "SPLIT_REQUIRED", pageStatus: AttentionResult["pageStatus"] = null, splitCursor: string | null = null): AttentionResult {
  return { page: [], isDone: false, continueCursor: cursor ?? "", pageStatus, splitCursor, incompleteReason };
}

async function attentionPageOf(ctx: QueryCtx, args: { orgId: Id<"organizations">; supplierId: Id<"suppliers">; kind: ObligationKind; paginationOpts: PaginationOptions }, nowMs: number): Promise<AttentionResult> {
  const options = args.paginationOpts;
  const { numItems = MAX_ROWS, maximumRowsRead = MAX_ROWS, maximumBytesRead = MAX_BYTES } = options;
  let page: Awaited<ReturnType<typeof readObligationPage>>;
  try {
    page = await readObligationPage(ctx, { ...args, nowMs,
      paginationOpts: { cursor: options.cursor, endCursor: options.endCursor,
        numItems: boundedCount(Number.isFinite(numItems) ? numItems : MAX_ROWS, MAX_ROWS),
        maximumRowsRead: boundedCount(Number.isFinite(maximumRowsRead) ? maximumRowsRead : MAX_ROWS, MAX_ROWS),
        maximumBytesRead: boundedCount(Number.isFinite(maximumBytesRead) ? maximumBytesRead : MAX_BYTES, MAX_BYTES) } });
  } catch (error) {
    if (!(error instanceof SupplierReadBudgetExhausted)) throw error;
    // Never advance a native cursor across obligations whose joined facts were unread.
    return unavailablePage(options.cursor, "READ_BUDGET");
  }
  if (page.pageStatus === "SplitRequired") {
    return unavailablePage(options.cursor, "SPLIT_REQUIRED", page.pageStatus, page.splitCursor);
  }
  const rows: Infer<typeof attentionRow>[] = [];
  for (const row of page.rows) {
    const projected = attentionOf(row);
    if (projected) rows.push(projected);
  }
  return { page: rows, isDone: page.complete, continueCursor: page.continueCursor,
    pageStatus: page.pageStatus, splitCursor: page.splitCursor };
}

export async function readAttention(ctx: QueryCtx, args: { orgId: Id<"organizations">; supplierId: Id<"suppliers">; kind: ObligationKind; paginationOpts: PaginationOptions }, nowMs: number) {
  const result = await attentionPageOf(ctx, args, nowMs);
  return { ...result, complete: args.paginationOpts.cursor === null && result.isDone && !result.pageStatus };
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
