import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { isFcLineage, isLiveFcCheque } from "./utils/fcCheque";

/**
 * SCRUM-447 D7'' — read-only finance-company cheque lineage audit.
 *
 * ONE paginated query per invocation over the organisation's cheques (the
 * platform allows a single paginated query per function). Everything else is a
 * bounded point read or indexed collect. It states its DENOMINATOR (rows
 * examined in this page) and whether the scan is complete. A page with no
 * findings is NOT a pass: only an exhaustive scan (`isDone` across every page
 * the caller walked) can say the organisation is clean, and UNKNOWN findings
 * are never counted as clean.
 *
 * Harness note: `convex-test` does not enforce the one-paginated-query limit,
 * so this shape is not proven on the platform by the tests.
 */

export type ChequeAuditClass =
  | "CLEARED_FACE_MISMATCH_OR_NO_RECEIPT"
  | "CLEARED_LEGACY_FACE_UNAVAILABLE"
  | "CLEARED_OUTSIDE_CONFIRM_DISBURSEMENT"
  | "LIVE_ON_CANCELLED_DEAL"
  | "APP_LINKED_NO_COMPANY_OR_DIRECT_ROUTE"
  | "DRAWER_UNVERIFIED"
  | "DRAWER_CONTRADICTS_APPLICATION"
  | "SEVERAL_LIVE_ROWS_FOR_APPLICATION"
  | "FC_ROW_CARRIES_CUSTOMER_RECEIVABLE"
  | "LINEAGE_UNKNOWN_REACHABLE_ONLY_VIA_REPLACEMENT"
  | "LINEAGE_DETACHED_BY_LEGACY_REPLACEMENT"
  | "LINEAGE_CHAIN_UNRESOLVED";

/** Largest page a caller may ask for; each row can cost several point reads. */
const MAX_PAGE_SIZE = 200;
/** Used when the caller sends a non-finite page size (`v.number()` admits NaN). */
const DEFAULT_PAGE_SIZE = 50;
/** How many replacement links an unmarked row is followed forward. */
const MAX_CHAIN_DEPTH = 8;

interface AuditFinding {
  chequeId: Id<"postDatedCheques">;
  class: ChequeAuditClass;
  /** UNKNOWN can never be read as PASS. */
  verdict: "FINDING" | "UNKNOWN";
  detail: string;
}

/**
 * Walks replacementChequeId forward from an unmarked row. "FC": reaches a row
 * with finance-company lineage. "CUSTOMER": ends at a row with none. Anything
 * else (cycle, missing row, another organisation's row, depth cap) is
 * "UNRESOLVED".
 */
async function followReplacementChain(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  start: Doc<"postDatedCheques">
): Promise<"FC" | "CUSTOMER" | "UNRESOLVED"> {
  const seen = new Set<string>([start._id]);
  let nextId = start.replacementChequeId;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth += 1) {
    if (nextId === undefined) return "CUSTOMER";
    if (seen.has(nextId)) return "UNRESOLVED";
    seen.add(nextId);
    const next = await ctx.db.get(nextId);
    if (!next || next.orgId !== orgId) return "UNRESOLVED";
    if (isFcLineage(next)) return "FC";
    nextId = next.replacementChequeId;
  }
  return nextId === undefined ? "CUSTOMER" : "UNRESOLVED";
}

export const auditFinanceCompanyCheques = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    // The ONE paginated query. The caller's page size is capped: every row can
    // cost several point reads below.
    const requested = Number.isNaN(args.paginationOpts.numItems)
      ? DEFAULT_PAGE_SIZE
      : Math.floor(args.paginationOpts.numItems);
    const numItems = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);
    const page = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .paginate({ ...args.paginationOpts, numItems });

    const findings: AuditFinding[] = [];
    const push = (
      row: Doc<"postDatedCheques">,
      cls: ChequeAuditClass,
      verdict: AuditFinding["verdict"],
      detail: string
    ) => findings.push({ chequeId: row._id, class: cls, verdict, detail });

    let examined = 0;
    let fcLineageRows = 0;
    for (const row of page.page) {
      if (row.isDeleted === true) continue;
      examined += 1;

      const anchorId = row.applicationId ?? row.originApplicationId;
      const lineage = isFcLineage(row);

      // Reachable only through a predecessor's replacementChequeId: this row
      // carries no lineage mark, but a finance-company row names it as its
      // replacement. History cannot prove which side it belongs to.
      if (!lineage) {
        // Forward direction, the REAL residue: before v4, replaceCheque copied
        // applicationId to the successor and CLEARED it from the old row, which
        // became REPLACED -> successor. The old row now looks like a customer
        // cheque; its finance-company origin is provable only from where the
        // chain leads. Bounded same-org point reads; anything that cannot be
        // walked to an end is UNKNOWN, never a pass.
        if (row.replacementChequeId !== undefined) {
          const outcome = await followReplacementChain(ctx, args.orgId, row);
          if (outcome === "FC") {
            push(
              row,
              "LINEAGE_DETACHED_BY_LEGACY_REPLACEMENT",
              "UNKNOWN",
              "Replaced before lineage was kept; its finance-company successor proves the origin."
            );
          } else if (outcome === "UNRESOLVED") {
            push(
              row,
              "LINEAGE_CHAIN_UNRESOLVED",
              "UNKNOWN",
              "The replacement chain could not be followed to an end, so the origin is unknown."
            );
          }
        }
        const predecessors = await ctx.db
          .query("postDatedCheques")
          .withIndex("by_replacementCheque", (q) => q.eq("replacementChequeId", row._id))
          .collect();
        if (predecessors.some((p) => p.orgId === args.orgId && isFcLineage(p))) {
          push(
            row,
            "LINEAGE_UNKNOWN_REACHABLE_ONLY_VIA_REPLACEMENT",
            "UNKNOWN",
            "Replaces a finance-company cheque but carries no lineage of its own."
          );
        }
        continue;
      }
      fcLineageRows += 1;

      if (row.receivableId) {
        push(row, "FC_ROW_CARRIES_CUSTOMER_RECEIVABLE", "FINDING", "A finance-company cheque is tied to a customer receivable.");
      }
      if (row.drawerType !== "FINANCE_COMPANY" || row.financeCompanyId === undefined) {
        push(row, "DRAWER_UNVERIFIED", "FINDING", "The drawer is not recorded, so it is unverified.");
      }

      const app = anchorId ? await ctx.db.get(anchorId) : null;
      if (!anchorId || !app || app.orgId !== args.orgId) {
        push(row, "DRAWER_CONTRADICTS_APPLICATION", "UNKNOWN", "The deal this cheque belongs to could not be loaded.");
        continue;
      }

      if (
        row.financeCompanyId !== undefined &&
        app.companyId !== undefined &&
        row.financeCompanyId !== app.companyId
      ) {
        push(row, "DRAWER_CONTRADICTS_APPLICATION", "FINDING", "The recorded drawer differs from the deal's finance company.");
      }
      if (row.applicationId && (app.companyId === undefined || app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER")) {
        push(
          row,
          "APP_LINKED_NO_COMPANY_OR_DIRECT_ROUTE",
          "FINDING",
          app.companyId === undefined
            ? "The deal has no finance company."
            : "The deal is on the direct-to-supplier route."
        );
      }

      const live = isLiveFcCheque(row);
      if (live) {
        let cancelled = app.status === "CANCELLED";
        if (!cancelled && row.saleId) {
          const sale = await ctx.db.get(row.saleId);
          cancelled = sale?.status === "CANCELLED";
        }
        if (cancelled) {
          push(row, "LIVE_ON_CANCELLED_DEAL", "FINDING", "The cheque is still open but its deal is cancelled.");
        }
        if (row.applicationId) {
          const siblings = await ctx.db
            .query("postDatedCheques")
            .withIndex("by_application", (q) => q.eq("applicationId", row.applicationId))
            .collect();
          if (siblings.filter((s) => isLiveFcCheque(s)).length > 1) {
            push(row, "SEVERAL_LIVE_ROWS_FOR_APPLICATION", "FINDING", "More than one open cheque exists for this deal.");
          }
        }
      }

      if (row.status === "CLEARED") {
        if (app.disbursedAt === undefined || row.clearedAt !== app.disbursedAt) {
          push(
            row,
            "CLEARED_OUTSIDE_CONFIRM_DISBURSEMENT",
            "FINDING",
            "The cheque was cleared without the deal's disbursement confirmation."
          );
        }
        if (row.amountMinor === undefined || row.currency === undefined) {
          push(row, "CLEARED_LEGACY_FACE_UNAVAILABLE", "UNKNOWN", "Cleared with no recorded face, so the face cannot be compared.");
        } else if (
          app.disbursedAmountMinor === undefined ||
          row.amountMinor !== app.disbursedAmountMinor
        ) {
          push(
            row,
            "CLEARED_FACE_MISMATCH_OR_NO_RECEIPT",
            "FINDING",
            app.disbursedAmountMinor === undefined
              ? "Cleared but the deal recorded no receipt."
              : "The recorded face does not equal the receipt."
          );
        }
      }
    }

    return {
      // The denominator: rows examined in THIS page. A clean page is not a pass.
      denominator: { examined, fcLineageRows, pageSize: page.page.length },
      isDone: page.isDone,
      continueCursor: page.continueCursor,
      findings,
      unknownCount: findings.filter((f) => f.verdict === "UNKNOWN").length,
      findingCount: findings.filter((f) => f.verdict === "FINDING").length,
      note: page.isDone
        ? "Final page reached. Combine every page walked before drawing a conclusion; UNKNOWN is not PASS."
        : "More pages remain — this page alone cannot show the organisation is clean.",
    };
  },
});
