import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  buildRuleSnapshot,
  creditDecisionForStatus,
  handoverStatusForFacts,
  settlementStatusForFacts,
  type FinanceCompanyRuleSnapshot,
} from "./utils/financingEconomics";

/**
 * Backfills the financing lifecycle dimensions and flags every legacy deal
 * whose dealer-side economics cannot be reconstructed.
 *
 * ## What is safe to derive, and what is not
 *
 * The five dimensions are derivable: `financeApplications.status` conflated
 * them, but the timestamps beside it — `vehicleHandoverAt`, `finalizedSaleId`,
 * `disbursedAt` — say unambiguously how far the deal actually got. The mapping
 * itself lives in `utils/financingEconomics` so this and the live mutations
 * cannot drift apart.
 *
 * The money is not. `quotes.totalFinancedAmount` is the customer's Murabaha
 * principal, and it was simultaneously read as the amount the finance company
 * owed the dealership, the expected receipt and a cheque's face value. Which of
 * those a given historical row was *meant* to be cannot be recovered, because
 * the four were never distinguished when it was written. So none of the
 * economics fields are populated here, nothing is overwritten, and every
 * affected row is marked `needsFinancingReconciliation` with the reason.
 *
 * Guessing would be worse than leaving it blank: a wrong finance-company
 * receivable looks exactly like a right one, and the dealership would have no
 * signal to go back and check.
 *
 * ## Shape
 *
 * Two phases, each paginating its own table with a bounded page size. An
 * earlier version walked organizations and then `collect()`ed every application
 * belonging to each — which is unbounded in the one dimension that actually
 * grows. A single busy dealership would exceed the transaction's read/write
 * limit, roll that page back on every retry, and block every organization
 * behind it.
 *
 * ## Idempotency
 *
 * Applications are keyed on `creditDecision` being unset; rows created after
 * this ships always carry one. Companies are keyed on the existence of their
 * rule-version row. Re-running touches nothing already done.
 */

/** Rows per invocation. Small enough that one page cannot approach the limits. */
const COMPANY_BATCH_SIZE = 50;
const APPLICATION_BATCH_SIZE = 50;

type Phase = "companies" | "applications";

type Report = {
  companiesScanned: number;
  companiesVersioned: number;
  applicationsScanned: number;
  applicationsBackfilled: number;
  applicationsFlagged: number;
  applicationsBoundToSnapshot: number;
  applicationsSkipped: number;
};

const EMPTY_REPORT: Report = {
  companiesScanned: 0,
  companiesVersioned: 0,
  applicationsScanned: 0,
  applicationsBackfilled: 0,
  applicationsFlagged: 0,
  applicationsBoundToSnapshot: 0,
  applicationsSkipped: 0,
};

const reportValidator = v.object({
  companiesScanned: v.number(),
  companiesVersioned: v.number(),
  applicationsScanned: v.number(),
  applicationsBackfilled: v.number(),
  applicationsFlagged: v.number(),
  applicationsBoundToSnapshot: v.number(),
  applicationsSkipped: v.number(),
});

function reconciliationReasonFor(app: Doc<"financeApplications">): string | undefined {
  if (!app.companyId) return undefined;
  // A deal that died before any money moved has nothing to reconcile. Flagging
  // it would tell somebody to "record the approved purchase amount before
  // finalizing" a deal that will never be finalized — and this flag is the
  // whole human work-queue signal, documented as reported on and never
  // silently cleared, so the noise would be permanent.
  const isTerminalWithoutMoney =
    (app.status === "REJECTED" || app.status === "CANCELLED" || app.status === "DRAFT") &&
    !app.disbursedAt &&
    !app.finalizedSaleId;
  if (isTerminalWithoutMoney) return undefined;
  if (app.disbursedAt) {
    return "Disbursement was confirmed against the customer's financing principal, which is not what the finance company owed the dealership. Re-enter the approved purchase amount, the applied LTV and the actual receipt.";
  }
  if (app.finalizedSaleId) {
    return "Finalized before the dealer-side economics existed. The finance-company receivable was opened for the customer's financing principal. Re-enter the approved purchase amount and the applied LTV.";
  }
  return "Created before the dealer-side economics existed. Record the submitted quotation, the appraisal and the approved purchase amount before finalizing.";
}

/** Whether the deal can still move, and so still needs governing rules. */
function isInFlight(app: Doc<"financeApplications">): boolean {
  return app.status !== "CLOSED" && app.status !== "CANCELLED" && app.status !== "REJECTED";
}

export const backfillFinancingEconomics = internalMutation({
  args: {
    phase: v.optional(v.union(v.literal("companies"), v.literal("applications"))),
    cursor: v.optional(v.string()),
    report: v.optional(reportValidator),
  },
  // Explicit return type is required, not stylistic: a self-scheduling handler
  // without one makes its own inferred type circular, and TypeScript reports
  // the resulting failure in whichever unrelated files happen to import the
  // generated api — hundreds of errors nowhere near the cause.
  handler: async (ctx, args): Promise<Report> => {
    const phase: Phase = args.phase ?? "companies";
    const report: Report = { ...EMPTY_REPORT, ...args.report };
    const now = Date.now();

    if (phase === "companies") {
      const page = await ctx.db
        .query("financeCompanies")
        .paginate({ cursor: args.cursor ?? null, numItems: COMPANY_BATCH_SIZE });

      for (const company of page.page) {
        report.companiesScanned += 1;
        const version = company.ruleVersion ?? 1;
        const existingVersion = await ctx.db
          .query("financeCompanyRuleVersions")
          .withIndex("by_company_version", (q) =>
            q.eq("companyId", company._id).eq("version", version)
          )
          .first();
        if (existingVersion) continue;

        if (company.ruleVersion === undefined) {
          await ctx.db.patch(company._id, { ruleVersion: version });
        }
        const refreshed = await ctx.db.get(company._id);
        if (!refreshed) continue;
        await ctx.db.insert("financeCompanyRuleVersions", {
          orgId: company.orgId,
          companyId: company._id,
          version,
          snapshot: buildRuleSnapshot(refreshed),
          note: "Backfilled from the company's settings when dealer-purchase rules were introduced.",
          createdAt: now,
        });
        report.companiesVersioned += 1;
      }

      // Companies must all be versioned before any application is bound to one,
      // so the two phases are strictly sequential rather than interleaved.
      await ctx.scheduler.runAfter(
        0,
        internal.migrateFinancingEconomics.backfillFinancingEconomics,
        page.isDone
          ? { phase: "applications" as const, report }
          : { phase: "companies" as const, cursor: page.continueCursor, report }
      );
      return report;
    }

    const page = await ctx.db
      .query("financeApplications")
      .paginate({ cursor: args.cursor ?? null, numItems: APPLICATION_BATCH_SIZE });

    for (const app of page.page) {
      report.applicationsScanned += 1;
      if (app.creditDecision !== undefined) {
        report.applicationsSkipped += 1;
        continue;
      }

      // Bind the deal to one immutable set of rules. Without this a legacy
      // application falls back to reading its company live, so a deal quoted
      // under one LTV could be approved under whatever the company was edited
      // to afterwards — exactly the retroactive rewrite snapshots exist to
      // prevent. Only for deals that can still move; a closed or cancelled one
      // has no future decision left for rules to govern.
      let companyRuleSnapshot: FinanceCompanyRuleSnapshot | undefined;
      let companyRuleVersionId: Id<"financeCompanyRuleVersions"> | undefined;
      if (app.companyId && app.companyRuleSnapshot === undefined && isInFlight(app)) {
        const company = await ctx.db.get(app.companyId);
        if (company && company.orgId === app.orgId) {
          companyRuleSnapshot = buildRuleSnapshot(company);
          const versionRow = await ctx.db
            .query("financeCompanyRuleVersions")
            .withIndex("by_company_version", (q) =>
              q.eq("companyId", company._id).eq("version", companyRuleSnapshot!.ruleVersion)
            )
            .first();
          if (versionRow) companyRuleVersionId = versionRow._id;
        }
      }

      const reconciliationReason = reconciliationReasonFor(app);
      await ctx.db.patch(app._id, {
        creditDecision: creditDecisionForStatus(app.status),
        // No appraisal record has ever existed for these. The
        // `underwritingSnapshot.vehicleValuationAtSubmission` beside them is a
        // mutable, dealer-editable valuation with no provider, date or
        // document — promoting it to an appraisal would manufacture evidence.
        appraisalStatus: "NOT_REQUESTED",
        settlementStatus: settlementStatusForFacts(app),
        handoverStatus: handoverStatusForFacts(app),
        // gapResolution is deliberately left unset. NOT_REQUIRED would assert
        // somebody checked there was no appraisal gap, and nobody did — the
        // concept did not exist when these were written.
        ...(companyRuleSnapshot ? { companyRuleSnapshot } : {}),
        ...(companyRuleVersionId ? { companyRuleVersionId } : {}),
        ...(reconciliationReason
          ? {
              needsFinancingReconciliation: true,
              financingReconciliationReason: reconciliationReason,
            }
          : {}),
      });

      report.applicationsBackfilled += 1;
      if (reconciliationReason) report.applicationsFlagged += 1;
      if (companyRuleSnapshot) report.applicationsBoundToSnapshot += 1;
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrateFinancingEconomics.backfillFinancingEconomics,
        { phase: "applications" as const, cursor: page.continueCursor, report }
      );
      return report;
    }

    console.log(
      `[migrateFinancingEconomics] complete: ${report.companiesScanned} companies scanned ` +
        `(${report.companiesVersioned} versioned), ` +
        `${report.applicationsScanned} applications scanned ` +
        `(${report.applicationsBackfilled} backfilled, ` +
        `${report.applicationsBoundToSnapshot} bound to a rule snapshot, ` +
        `${report.applicationsFlagged} flagged for reconciliation, ` +
        `${report.applicationsSkipped} already current).`
    );
    return report;
  },
});
