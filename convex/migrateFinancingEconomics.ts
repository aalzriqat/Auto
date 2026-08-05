import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { buildRuleSnapshot } from "./utils/financingEconomics";

/**
 * Backfills the financing lifecycle dimensions and flags every legacy deal
 * whose dealer-side economics cannot be reconstructed.
 *
 * ## What is safe to derive, and what is not
 *
 * The five dimensions are derivable: `financeApplications.status` conflated
 * them, but the timestamps beside it — `vehicleHandoverAt`, `finalizedSaleId`,
 * `disbursedAt` — say unambiguously how far the deal actually got.
 *
 * The money is not. `quotes.totalFinancedAmount` is the customer's Murabaha
 * principal, and it was simultaneously read as the amount the finance company
 * owed the dealership, the expected receipt and a cheque's face value. Which of
 * those a given historical row was *meant* to be cannot be recovered from the
 * data, because the four were never distinguished when it was written. So none
 * of the economics fields are populated here, nothing is overwritten, and every
 * affected row is marked `needsFinancingReconciliation` with the reason.
 *
 * Guessing would be worse than leaving it blank: a wrong finance-company
 * receivable looks exactly like a right one, and the dealership would have no
 * signal to go back and check.
 *
 * ## Idempotency
 *
 * Keyed on `creditDecision` being unset. Applications created after this ships
 * always carry one (see `applications.createFromQuote`), so re-running never
 * touches a modern row and never re-flags one already dealt with.
 */

/** Organizations per invocation — each org's finance tables are small. */
const BACKFILL_ORG_BATCH_SIZE = 10;

type Report = {
  orgsScanned: number;
  companiesVersioned: number;
  applicationsBackfilled: number;
  applicationsFlagged: number;
  applicationsSkipped: number;
};

const EMPTY_REPORT: Report = {
  orgsScanned: 0,
  companiesVersioned: 0,
  applicationsBackfilled: 0,
  applicationsFlagged: 0,
  applicationsSkipped: 0,
};

/**
 * The credit decision the legacy status was really carrying.
 *
 * CLOSED maps to APPROVED rather than to a terminal state of its own: closing
 * is what `finalizeDeal` does after the credit file was approved, so the credit
 * dimension's value is APPROVED and the *settlement* and *handover* dimensions
 * are what record that the deal completed.
 */
function creditDecisionFor(
  status: Doc<"financeApplications">["status"]
): NonNullable<Doc<"financeApplications">["creditDecision"]> {
  switch (status) {
    case "DRAFT":
      return "DRAFT";
    case "PENDING_DOCS":
      return "SUBMITTED";
    case "UNDER_REVIEW":
      return "UNDER_REVIEW";
    case "APPROVED":
    case "CLOSED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return "CANCELLED";
  }
}

function handoverStatusFor(
  app: Doc<"financeApplications">
): NonNullable<Doc<"financeApplications">["handoverStatus"]> {
  if (app.vehicleHandoverAt) return "HANDED_OVER";
  return app.status === "APPROVED" ? "READY" : "BLOCKED";
}

/**
 * How far settlement got.
 *
 * FULLY_SETTLED records the fact that a disbursement was confirmed — which is
 * true, `disbursedAt` is a timestamp of a real event. It does NOT assert the
 * amount was right: the old `confirmDisbursement` compared it against the
 * customer's principal, so those rows also carry the reconciliation flag.
 */
function settlementStatusFor(
  app: Doc<"financeApplications">
): NonNullable<Doc<"financeApplications">["settlementStatus"]> {
  if (app.disbursedAt) return "FULLY_SETTLED";
  if (app.finalizedSaleId) return "EXPECTED";
  return "NOT_READY";
}

function reconciliationReasonFor(app: Doc<"financeApplications">): string | undefined {
  if (!app.companyId) return undefined;
  if (app.disbursedAt) {
    return "Disbursement was confirmed against the customer's financing principal, which is not what the finance company owed the dealership. Re-enter the approved purchase amount, the applied LTV and the actual receipt.";
  }
  if (app.finalizedSaleId) {
    return "Finalized before the dealer-side economics existed. The finance-company receivable was opened for the customer's financing principal. Re-enter the approved purchase amount and the applied LTV.";
  }
  return "Created before the dealer-side economics existed. Record the submitted quotation, the appraisal and the approved purchase amount before finalizing.";
}

export const backfillFinancingEconomics = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    report: v.optional(
      v.object({
        orgsScanned: v.number(),
        companiesVersioned: v.number(),
        applicationsBackfilled: v.number(),
        applicationsFlagged: v.number(),
        applicationsSkipped: v.number(),
      })
    ),
  },
  // Explicit return type is required, not stylistic: a self-scheduling handler
  // without one makes its own inferred type circular, and TypeScript reports
  // the resulting failure in whichever unrelated files happen to import the
  // generated api — hundreds of errors nowhere near the cause.
  handler: async (ctx, args): Promise<Report> => {
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: BACKFILL_ORG_BATCH_SIZE });

    const report: Report = { ...EMPTY_REPORT, ...args.report };
    const now = Date.now();

    for (const org of page.page) {
      report.orgsScanned += 1;

      // Give every company a rule version to point at, so applications created
      // from here on snapshot a real immutable row rather than nothing.
      const companies = await ctx.db
        .query("financeCompanies")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .collect();
      for (const company of companies) {
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
          orgId: org._id,
          companyId: company._id,
          version,
          snapshot: buildRuleSnapshot(refreshed),
          note: "Backfilled from the company's settings when dealer-purchase rules were introduced.",
          createdAt: now,
        });
        report.companiesVersioned += 1;
      }

      const applications = await ctx.db
        .query("financeApplications")
        .withIndex("by_org", (q) => q.eq("orgId", org._id))
        .collect();

      for (const app of applications) {
        if (app.creditDecision !== undefined) {
          report.applicationsSkipped += 1;
          continue;
        }

        const reconciliationReason = reconciliationReasonFor(app);
        await ctx.db.patch(app._id, {
          creditDecision: creditDecisionFor(app.status),
          // No appraisal record has ever existed for these. The
          // `underwritingSnapshot.vehicleValuationAtSubmission` beside them is a
          // mutable, dealer-editable valuation with no provider, date or
          // document — promoting it to an appraisal would manufacture evidence.
          appraisalStatus: "NOT_REQUESTED",
          settlementStatus: settlementStatusFor(app),
          handoverStatus: handoverStatusFor(app),
          // gapResolution is deliberately left unset. NOT_REQUIRED would assert
          // somebody checked there was no appraisal gap, and nobody did — the
          // concept did not exist when these were written.
          ...(reconciliationReason
            ? {
                needsFinancingReconciliation: true,
                financingReconciliationReason: reconciliationReason,
              }
            : {}),
        });

        report.applicationsBackfilled += 1;
        if (reconciliationReason) report.applicationsFlagged += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.migrateFinancingEconomics.backfillFinancingEconomics,
        { cursor: page.continueCursor, report }
      );
      return report;
    }

    console.log(
      `[migrateFinancingEconomics] complete: ${report.orgsScanned} orgs, ` +
        `${report.companiesVersioned} companies versioned, ` +
        `${report.applicationsBackfilled} applications backfilled ` +
        `(${report.applicationsFlagged} flagged for reconciliation, ` +
        `${report.applicationsSkipped} already current).`
    );
    return report;
  },
});
