import { v } from "convex/values";
import { internalMutation } from "./functions";
import type { Id } from "./_generated/dataModel";

/**
 * One-off operational tool: clears an organization's accounting, sales and
 * finance-application records while leaving the dealership itself intact.
 *
 * ## Why the table list is hard-coded
 *
 * This deletes production rows with no undo. Taking the tables as an argument
 * would make it a general "purge whatever I name for this org" weapon, one
 * typo away from removing an org's vehicles, members or settings. The list
 * below is the exact set signed off for this operation, so the blast radius is
 * fixed at authorship time and reviewable in the diff rather than decided at
 * the call site.
 *
 * ## What is deliberately NOT here
 *
 * - `vehicles` and `vehicleValuations` — inventory and its valuation history
 *   are kept.
 * - `customers`, `leads` — the CRM survives; only the money moves.
 * - `memberships`, `roles`, `orgSettings`, `subscriptions`, `branches` — the
 *   org has to remain usable and its people have to remain able to sign in.
 * - `bankAccounts`, `financeCompanies`, `orgValuationCompanies` — configuration
 *   describing who the dealer banks and finances with, not transactions.
 *
 * ## Known, accepted inconsistency
 *
 * Vehicle statuses are left untouched by explicit instruction, so vehicles
 * previously marked SOLD or RESERVED keep that status with no sale row behind
 * them. They will read as unavailable inventory until someone changes the
 * status by hand. This is a deliberate choice, not an oversight.
 */
const RESET_TABLES = [
  // General ledger
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "financialAuditLog",
  "accountBalanceSnapshots",
  "chartOfAccounts",
  // Money movement
  "transactions",
  "deposits",
  "collectionPayments",
  "receivableDocuments",
  "canonicalPayments",
  "receivables",
  "paymentAllocations",
  "postDatedCheques",
  "cashierReconciliations",
  "collectionApprovalRequests",
  "paymentVouchers",
  // Expenses
  "expenses",
  // Payroll
  "payrollRuns",
  "payrollItems",
  "employeeCompensation",
  // Sales
  "sales",
  "quotes",
  // Finance applications, children first so a run that stops between batches
  // never leaves a row whose application is already gone.
  "financeAppraisals",
  "financeApplicationOverrides",
  "financeApplications",
  "applicationStatusLog",
] as const;

/**
 * Rows removed per call.
 *
 * Well inside a mutation's write budget, and large enough that the signed-off
 * scope (196 rows) clears in a single run. A larger org would simply need the
 * command repeated until `remaining` reports zero.
 */
const RESET_DELETE_BATCH = 500;

/**
 * Deletes — or with `dryRun`, merely counts — this org's rows in every table
 * above.
 *
 * `dryRun` defaults to **true**. Nothing is destroyed unless the caller opts in
 * explicitly, so the natural first invocation is the safe one and the
 * destructive form has to be typed on purpose.
 *
 * Rows are matched with a filter rather than a `by_org` index because the
 * tables here differ in which indexes they carry, and a wrong index name would
 * fail loudly mid-run after earlier tables had already been deleted. Every one
 * of these tables is small on this deployment, so a scan costs little and
 * behaves identically everywhere.
 */
export const resetOrgFinancialData = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    orgName: string | null;
    perTable: Record<string, number>;
    total: number;
    remaining: number;
  }> => {
    const dryRun = args.dryRun ?? true;
    const limit = Math.min(Math.max(args.batchSize ?? RESET_DELETE_BATCH, 1), RESET_DELETE_BATCH);

    // Named in the result so an operator can see, in the output they are about
    // to act on, which dealership this actually hit.
    const org = await ctx.db.get(args.orgId);
    const orgName = org?.name ?? null;

    const perTable: Record<string, number> = {};
    let total = 0;
    let remaining = 0;

    for (const table of RESET_TABLES) {
      // One past the limit, so `remaining` reports honestly whether another
      // run is needed instead of silently stopping at a full batch.
      const rows = await ctx.db
        .query(table)
        .filter((q) => q.eq(q.field("orgId"), args.orgId))
        .take(limit + 1);

      const batch = rows.slice(0, limit);
      if (batch.length > 0) perTable[table] = batch.length;
      total += batch.length;
      if (rows.length > limit) remaining += rows.length - batch.length;

      if (!dryRun) {
        for (const row of batch) {
          await ctx.db.delete(row._id);
        }
      }
    }

    return { dryRun, orgName, perTable, total, remaining };
  },
});

/** Exported for the test that pins the signed-off scope. */
export const RESET_TABLES_FOR_TEST: readonly string[] = RESET_TABLES;

/** Exported so a caller can type the org argument without importing generated ids. */
export type ResetOrgId = Id<"organizations">;
