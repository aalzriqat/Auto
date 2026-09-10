import { v, ConvexError } from "convex/values";
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
  // ⚠️ SCRUM-208 c15825 — AUTHORITY LIFECYCLE FIRST, IN DEPENDENCY ORDER:
  // attempts → work → the accounting rows they reference.
  //
  // This omission was found by a reviewer, not by me. Last round a repository
  // guard failed because `commitmentAuthorityWork` had no organization
  // hard-delete step; I added the step it asked for and never asked which
  // OTHER destructive path had the same gap. This one did. A financial reset
  // that cleared `pendingAccountingEvents` while leaving authority work behind
  // would leave rows instructing a settlement against a reversal that no
  // longer exists — pointing at deleted accounting rows, on a fresh ledger.
  "commitmentAuthorityAttempt",
  "commitmentAuthorityWork",
  // General ledger
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "financialAuditLog",
  "accountBalanceSnapshots",
  "chartOfAccounts",
  // Money movement
  //
  // ⚠️ SCRUM-218-C receipt authority FIRST, and it is here because the comment
  // above told me to look. A repository guard failed on the organization
  // hard-delete for exactly these three tables; the lesson recorded above is
  // that fixing the guard that fired and not asking which OTHER destructive path
  // has the same gap is how the second one survives. It did have the same gap.
  //
  // A reset that cleared `collectionPayments`, `canonicalPayments` and
  // `paymentAllocations` while leaving these behind would strand a customer's
  // retained credit — a live liability position pointing at payments that no
  // longer exist, on an otherwise fresh ledger.
  //
  // ⚠️ ORDER AND `CHILD_TABLES` ARE **BOTH** LOAD-BEARING. Neither alone is the
  // guarantee, and this comment has now been wrong in both directions:
  //
  //   "children first is the rule"        -> false: each table is batched
  //                                          independently, so a child that does
  //                                          not fully drain in one pass leaves
  //                                          its parent deletable next pass.
  //   "order is only a readability aid"   -> ALSO FALSE, and this was my
  //                                          over-correction of the first.
  //
  // `stillPopulated` is built INCREMENTALLY as this array is iterated, so a
  // parent listed BEFORE its child can never see that child in the set and is
  // never blocked by it — `CHILD_TABLES` is silently inert for that pair. A
  // reviewer proved it by reordering this array and watching the R02 regression
  // fail on pass 0, then reverting it as a control.
  //
  // So: children stay before parents HERE, and `CHILD_TABLES` additionally
  // covers the partial-drain case that ordering alone cannot.
  // `orgDeletionCoverage.test.ts` now enforces the ordering half, because a
  // property stated only in a comment is not enforced — which is exactly how
  // this comment came to be wrong twice.
  "receiptApplications",
  "receiptRetainedPositions",
  "receiptMovements",
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
 * so a PARTIAL PASS can never orphan them — the case listing order alone cannot
 * cover, because each table is batched independently.
 *
 * ⚠️ IT DOES NOT MAKE THE GUARANTEE INDEPENDENT OF ORDER, WHICH THIS COMMENT
 * PREVIOUSLY CLAIMED. `stillPopulated` is built while `RESET_TABLES` is
 * iterated, so a child listed AFTER its parent is never in the set when the
 * parent is considered, and the edge is silently inert. Order and this map are
 * both load-bearing, for different failure modes.
 *
 * `orgDeletionCoverage.test.ts` enforces the ordering half for every edge here,
 * including ones added later — the claim was wrong in this comment twice before
 * anything checked it.
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
  // ⚠️ SCRUM-218-C receipt authority. These edges cover the PARTIAL-DRAIN case:
  // every table is batched independently, so at a small `batchSize` the reset
  // could otherwise delete a movement and its position while an application
  // child still survived, committing an orphan whose immutable occurrence can
  // never be reconstructed.
  //
  // They do NOT make ordering irrelevant — an earlier revision of this comment
  // said they did, which was an over-correction of an earlier comment saying
  // ordering was the whole story. Both halves are required; the array order is
  // enforced by `orgDeletionCoverage.test.ts`.
  receiptMovements: ["receiptApplications", "receiptRetainedPositions"],
  receiptRetainedPositions: ["receiptApplications"],
  // The rows a receipt movement and its applications POINT AT. Deleting these
  // first would leave live receipt authority referring to payments,
  // allocations and receivables that no longer exist.
  collectionPayments: ["receiptMovements"],
  canonicalPayments: ["receiptMovements"],
  paymentAllocations: ["receiptApplications"],
  receivableDocuments: ["receiptApplications"],
  receivables: ["receiptApplications"],
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
    /**
     * True when this org holds canonical commitment-authority records, which
     * make a destructive reset unsafe. Reported on a dry run so an operator
     * learns the precondition BEFORE typing the destructive form, rather than
     * discovering it as an error.
     */
    authorityLifecyclePresent: boolean;
  }> => {
    const dryRun = args.dryRun ?? true;
    const limit = Math.min(Math.max(args.batchSize ?? RESET_DELETE_BATCH, 1), RESET_DELETE_BATCH);

    // Named in the result so an operator can see, in the output they are about
    // to act on, which dealership this actually hit.
    const org = await ctx.db.get(args.orgId);
    const orgName = org?.name ?? null;

    // ⚠️ FAIL-CLOSED PREFLIGHT, TAKEN BEFORE ANY DELETE OR STORAGE WRITE.
    // (SCRUM-208 c15892, Option C.)
    //
    // Phase 3 added `commitmentAuthorityAttempt` and `commitmentAuthorityWork`
    // to this reset. Every table here is batched independently, so a partial
    // pass could delete a `pendingAccountingEvents` row while a work row
    // referencing it survived — and `performAuthoritySettlement` dereferences
    // `work.pendingEventId` with a non-null assertion, so the surviving row
    // would throw on every dispatch, burn its retry budget and record a false
    // RETRY_EXHAUSTED against a deal nobody could explain.
    //
    // `CHILD_TABLES` already defers a parent whose children remain, but the
    // authority lifecycle is not expressible that way: work rows reference
    // pending events, deposits, sales, holds and vehicles at once, and the
    // ordering of this array is not a dependency proof.
    //
    // ⚠️ SO THIS REFUSES RATHER THAN ORDERING. Safety beats partial progress on
    // a destructive internal tool: an organization carrying canonical authority
    // state simply cannot be reset until the dependency-safe cursor
    // implementation exists. A wrong guess here orphans money records; a refusal
    // costs an operator an error message.
    const authorityAttempts = await ctx.db
      .query("commitmentAuthorityAttempt")
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .take(1);
    const authorityWork = await ctx.db
      .query("commitmentAuthorityWork")
      .filter((q) => q.eq(q.field("orgId"), args.orgId))
      .take(1);
    const authorityLifecyclePresent =
      authorityAttempts.length > 0 || authorityWork.length > 0;

    if (authorityLifecyclePresent && !dryRun) {
      // Thrown, not returned: an uncaught throw aborts the whole transaction,
      // which is the strongest possible guarantee that nothing was deleted.
      throw new ConvexError(
        "This organization holds canonical commitment-authority records, which this reset " +
          "cannot remove safely in one pass. Refusing before any deletion. Run with " +
          "dryRun to inspect, and clear the authority lifecycle first."
      );
    }

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
        if (rows.length > 0) {
          remaining += rows.length;
          // ⚠️ BLOCKING MUST PROPAGATE, OR THE ORPHAN JUST MOVES UP A LEVEL
          // (review R05). A blocked table that still holds rows has to block ITS
          // parents too. Without this line the graph is only one level deep: a
          // surviving `receiptMovements` row was invisible to
          // `collectionPayments` and `canonicalPayments`, which then deleted
          // themselves — leaving the movement alive with dangling
          // `collectionPaymentId` and `canonicalPaymentId` references.
          //
          // That was strictly a consequence of ADDING the multi-level receipt
          // edges: before them every dependency here was one level deep, so
          // skip-without-propagation was indistinguishable from correct. The
          // first fix relocated the orphan from the child to the parent rather
          // than removing it.
          //
          // Guarded on `rows.length > 0` deliberately: an empty table cannot
          // orphan anything, so it must not block its parents and stall the run.
          stillPopulated.add(table);
        }
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

    // Reported truthfully on a dry run so an operator sees the precondition
    // BEFORE typing the destructive form, rather than discovering it as an error.
    return { dryRun, orgName, perTable, total, remaining, authorityLifecyclePresent };
  },
});

/** Exported for the test that pins the signed-off scope. */
export const RESET_TABLES_FOR_TEST: readonly string[] = RESET_TABLES;

/**
 * Exported so the ordering invariant can be ENFORCED rather than asserted in
 * prose. `stillPopulated` is built as `RESET_TABLES` is iterated, so an edge
 * whose child is listed AFTER its parent is silently inert — the parent is
 * never blocked by it. See `orgDeletionCoverage.test.ts`.
 */
export const CHILD_TABLES_FOR_TEST: Readonly<Record<string, readonly string[]>> = CHILD_TABLES;

/** Exported so a caller can type the org argument without importing generated ids. */
export type ResetOrgId = Id<"organizations">;
