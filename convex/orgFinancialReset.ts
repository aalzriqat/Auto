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
  // Finance applications and their children. Ordering IS a safety property,
  // contrary to what this comment used to claim: the batch limit applies to
  // each table separately, so a run that clears one of two fee rows and then
  // deletes the application leaves the second fee pointing at an applicationId
  // that no longer resolves. Atomicity does not help — the whole broken state
  // commits together. Children first, and the parent additionally deferred
  // while any child still has rows; see CHILD_TABLES.
  "financeAppraisals",
  "financeApplicationOverrides",
  "financeDealCustodyEntries",
  "financeDealFees",
  "financeDealCustody",
  "applicationStatusLog",
  "financeApplications",
] as const;

/**
 * Tables whose rows reference a parent, keyed by that parent.
 *
 * The parent is skipped for the whole run while any of these still has rows,
 * so a partial pass can never orphan them. Listing order above already puts
 * children first; this makes the guarantee independent of that ordering, since
 * a later edit reshuffling the array would silently remove it otherwise.
 */
const CHILD_TABLES: Partial<Record<(typeof RESET_TABLES)[number], readonly string[]>> = {
  financeApplications: [
    "financeAppraisals",
    "financeApplicationOverrides",
    "financeDealCustodyEntries",
    "financeDealFees",
    "financeDealCustody",
    "applicationStatusLog",
  ],
};

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

    // Tables that still hold rows for this org after their own batch ran.
    const stillPopulated = new Set<string>();

    for (const table of RESET_TABLES) {
      // One past the limit, so `remaining` reports honestly whether another
      // run is needed instead of silently stopping at a full batch.
      const rows = await ctx.db
        .query(table)
        .filter((q) => q.eq(q.field("orgId"), args.orgId))
        .take(limit + 1);

      // Deleting a parent while a child still has rows leaves those rows
      // pointing at nothing. Defer the parent entirely — it is reported in
      // `remaining`, so the operator repeats the command and it clears once the
      // children are gone.
      const blockedBy = (CHILD_TABLES[table] ?? []).filter((child) =>
        stillPopulated.has(child)
      );
      if (blockedBy.length > 0) {
        if (rows.length > 0) remaining += rows.length;
        continue;
      }

      const batch = rows.slice(0, limit);
      if (batch.length > 0) perTable[table] = batch.length;
      total += batch.length;
      if (rows.length > limit) {
        remaining += rows.length - batch.length;
        stillPopulated.add(table);
      }
      // A dry run deletes nothing, so every row it counted is still there when
      // the parent is considered. Without this the dry run would report the
      // parent as clearable in the same pass that reports its children as not.
      if (dryRun && rows.length > 0) stillPopulated.add(table);

      if (!dryRun) {
        for (const row of batch) {
          // `financeAppraisals` is the first table in this list that carries
          // storage ids. Deleting the row alone would leave the finance
          // company's appraisal report on a customer's vehicle in storage with
          // nothing referencing it — not enumerable, not deletable by any code
          // path, and billed indefinitely. An orphaned row is recoverable; an
          // unreferenced blob is not.
          const storageIds =
            "documentStorageIds" in row ? (row.documentStorageIds ?? []) : [];
          for (const storageId of storageIds) {
            const metadata = await ctx.db.system.get("_storage", storageId);
            if (metadata) await ctx.storage.delete(storageId);
          }
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
