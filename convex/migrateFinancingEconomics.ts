import { v } from "convex/values";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { MutationCtx } from "./_generated/server";
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
 * Applications are keyed on `financingBackfilledAt`, a marker no live mutation
 * writes, and each concern is filled only when unset — so a row a user
 * advanced mid-migration is completed rather than skipped or reverted.
 * Companies are keyed on the existence of their rule-version row. Re-running
 * touches nothing already done.
 */

/** Rows per invocation. Small enough that one page cannot approach the limits. */
const COMPANY_BATCH_SIZE = 50;
const APPLICATION_BATCH_SIZE = 50;

type Phase = "companies" | "applications";

type Report = {
  /** SCHEDULED while pages remain; COMPLETE only on the final one. */
  status: "SCHEDULED" | "COMPLETE";
  companiesScanned: number;
  companiesVersioned: number;
  applicationsScanned: number;
  applicationsBackfilled: number;
  applicationsFlagged: number;
  applicationsBoundToSnapshot: number;
  /**
   * Modern applications whose inline rule snapshot could not be linked to a
   * version row. Deliberately left unmarked so a later run retries them, and
   * flagged so a human is told rather than the count being the only trace.
   */
  applicationsUnlinked: number;
  /**
   * Terminal deals abandoned unlinked because there was nothing left to
   * reconcile. Counted apart from `applicationsSkipped`, which also means
   * "already current" and "linked fine" — an operator could not otherwise tell
   * from the output how many deals were permanently given up on.
   */
  applicationsClosedUnlinked: number;
  applicationsSkipped: number;
};

const EMPTY_REPORT: Report = {
  status: "SCHEDULED",
  companiesScanned: 0,
  companiesVersioned: 0,
  applicationsScanned: 0,
  applicationsBackfilled: 0,
  applicationsFlagged: 0,
  applicationsBoundToSnapshot: 0,
  applicationsUnlinked: 0,
  applicationsClosedUnlinked: 0,
  applicationsSkipped: 0,
};

const reportValidator = v.object({
  status: v.union(v.literal("SCHEDULED"), v.literal("COMPLETE")),
  companiesScanned: v.number(),
  companiesVersioned: v.number(),
  applicationsScanned: v.number(),
  applicationsBackfilled: v.number(),
  applicationsFlagged: v.number(),
  applicationsBoundToSnapshot: v.number(),
  // Optional purely for deployment compatibility, not because the counter is.
  // A continuation scheduled by the previous revision carries a report without
  // this field, and Convex runs scheduled functions against the code deployed
  // at the time they fire — so requiring it would fail argument validation
  // before EMPTY_REPORT could supply the default, breaking the chain mid-run
  // and leaving the remaining applications unbackfilled. The spread below
  // normalizes it to 0.
  applicationsUnlinked: v.optional(v.number()),
  applicationsClosedUnlinked: v.optional(v.number()),
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

/**
 * Whether the deal can still move, and so still needs governing rules.
 *
 * REJECTED counts. It looks terminal but is not — `REJECTED -> PENDING_DOCS` is
 * a legal transition — and the same patch stamps `financingBackfilledAt`, so a
 * rejected row denied a snapshot could never be repaired by re-running. Reopened
 * weeks later it would read its company's rules live, and an LTV edited in the
 * meantime would silently rewrite terms the deal was never submitted under.
 */
function isInFlight(app: Doc<"financeApplications">): boolean {
  return app.status !== "CLOSED" && app.status !== "CANCELLED";
}

/**
 * Finds the rule-version row an application's inline snapshot refers to, and
 * materializes it from that snapshot when it is missing.
 *
 * The companies phase writes a row for each company's *current* version only.
 * So a company edited between an application snapshotting version N and this
 * migration running gets a row for N+1, and version N — the one the deal is
 * actually governed by — has no row at all.
 *
 * Reconstructing it is exact rather than inferred: `companyRuleSnapshot` is a
 * verbatim `buildRuleSnapshot(company)` copy taken at the moment the deal was
 * created, which is precisely what the version row is meant to hold. Nothing is
 * overwritten — the insert happens only when the lookup found nothing.
 *
 * Returns `undefined` when recovery is not defensible: no company on the
 * application, or a company row that is missing or belongs to another org. The
 * caller must then leave the row unmarked rather than record a link it does not
 * have.
 */
type RuleVersionResolution =
  | { status: "LINKED"; versionId: Id<"financeCompanyRuleVersions"> }
  /** Cannot link, and the reason says what a person would actually have to do. */
  | { status: "UNRESOLVED"; reason: string };

async function resolveOrRecoverRuleVersion(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  now: number
): Promise<RuleVersionResolution> {
  const snapshot = app.companyRuleSnapshot;
  const companyId = app.companyId;
  if (!snapshot || !companyId) {
    return {
      status: "UNRESOLVED",
      reason:
        "This deal has no finance company on it, so there are no dealer-purchase rules to bind it to. Attach the finance company, or close the deal.",
    };
  }

  const existing = await ctx.db
    .query("financeCompanyRuleVersions")
    .withIndex("by_company_version", (q) =>
      q.eq("companyId", companyId).eq("version", snapshot.ruleVersion)
    )
    .first();
  if (existing) return { status: "LINKED", versionId: existing._id };

  // Cross-tenant guard on a table this row will claim to belong to. A dangling
  // or foreign companyId is exactly the case where inventing a version row
  // would be manufacturing history.
  const company = await ctx.db.get(companyId);
  if (!company || company.orgId !== app.orgId) {
    // The old text here told the reader to "re-save the finance company", which
    // is impossible in the only state that produces this: the company row is
    // gone, or belongs to another organization. An instruction that cannot be
    // carried out is worse than none — it reads as actionable and wastes the
    // one person who looked.
    return {
      status: "UNRESOLVED",
      reason:
        "This deal's finance company record no longer exists in this organization, so its dealer-purchase rules cannot be restored. Re-attach a finance company to the deal, or close it.",
    };
  }

  // Only ever fill in a version the company has already passed through.
  //
  // `by_company_version` is a plain index with no uniqueness constraint and
  // every reader takes `.first()`, so a row written for a version the company
  // has NOT reached is a landmine: when `finance.updateCompany` eventually
  // bumps the company to that version it inserts its own row unconditionally,
  // and from then on `.first()` may hand a brand-new application this old
  // application's terms instead of the company's real ones. Recovering
  // backwards is reconstruction — the company demonstrably held those rules at
  // that version. Recovering forwards is invention.
  const currentVersion = company.ruleVersion ?? 1;
  if (snapshot.ruleVersion > currentVersion) {
    return {
      status: "UNRESOLVED",
      reason: `This deal was snapshotted under rule version ${snapshot.ruleVersion}, which is ahead of ${company.name}'s current version ${currentVersion} — so the rules it was quoted under cannot be confirmed against the company. Check the deal's terms against the company's settings before relying on its figures.`,
    };
  }

  const versionId = await ctx.db.insert("financeCompanyRuleVersions", {
    orgId: app.orgId,
    companyId,
    version: snapshot.ruleVersion,
    snapshot,
    note: "Recovered from an application's inline rule snapshot during the financing backfill; the company had been edited past this version before the migration ran.",
    createdAt: now,
  });
  return { status: "LINKED", versionId };
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
    // The explicit `?? 0` is not redundant with the spread. Convex omits an
    // absent optional argument, in which case the spread does keep
    // EMPTY_REPORT's zero — but a caller that passes the key with an explicit
    // undefined would overwrite it, and this value is only ever read back to be
    // incremented, so NaN would propagate silently through every later page.
    const report: Report = {
      ...EMPTY_REPORT,
      ...args.report,
      applicationsUnlinked: args.report?.applicationsUnlinked ?? 0,
      applicationsClosedUnlinked: args.report?.applicationsClosedUnlinked ?? 0,
    };
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
      // Keyed on a marker no live mutation writes. Keying it on `creditDecision`
      // — a business field that updateStatus, cancelApplication and finalizeDeal
      // now all set — meant any legacy row a user touched before its page came
      // up was skipped permanently: no settlement or appraisal dimension, no
      // rule snapshot (so it kept reading live company rules, the exact hazard
      // the snapshot exists to prevent), and no reconciliation flag, so nobody
      // was ever told. The worst case was a legacy deal finalized mid-migration,
      // which opens a finance-company receivable for the wrong number and then
      // never enters the queue.
      if (app.financingBackfilledAt !== undefined) {
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

      // An application created under the new code always carries a rule
      // snapshot (see applications.createFromQuote), and a legacy one never
      // does until this migration binds it — read before the patch below, that
      // is a reliable discriminator. Without it, moving the idempotency key off
      // `creditDecision` meant the backfill started flagging brand-new deals
      // for reconciliation, filling the human work queue with rows that have
      // nothing wrong with them.
      const isModernApplication = app.companyRuleSnapshot !== undefined;
      if (isModernApplication) {
        // An application created between the deploy and this run snapshotted
        // its rules inline but found no version row to point at, because the
        // companies phase had not run yet. Link it now — otherwise the audit
        // reference is permanently missing and the marker below stops any
        // later run from revisiting it.
        let backfilledVersionId: Id<"financeCompanyRuleVersions"> | undefined;
        let unresolvedReason: string | undefined;
        if (app.companyRuleVersionId === undefined && app.companyId) {
          const resolution = await resolveOrRecoverRuleVersion(ctx, app, now);
          if (resolution.status === "LINKED") backfilledVersionId = resolution.versionId;
          else unresolvedReason = resolution.reason;
        }
        // Writing the marker without the link is what made this permanent: the
        // next run reads `financingBackfilledAt` and skips the row before it
        // ever reaches this branch again, so an application that failed to bind
        // once stays unbound forever and silently falls back to reading its
        // company's rules live. Leave the marker off and it is simply retried.
        // A deal that is terminal AND never moved money has no future decision
        // for rules to govern and no history worth reconciling, so asking about
        // its rule binding is noise nobody can clear. This is the exact test
        // `reconciliationReasonFor` applies to terminal legacy rows — matched
        // deliberately, because exempting every CLOSED row regardless of money
        // would abandon a deal that disbursed and finalized, which is the one
        // kind of closed deal whose unresolved rules a person still needs told
        // about. Without any exemption, "or close it" in the reasons below was
        // simply false: closing changed nothing, the flag stayed up, and the
        // next run re-raised whatever a triager had cleared.
        const terminalWithoutMoney =
          !isInFlight(app) && !app.disbursedAt && !app.finalizedSaleId;
        if (unresolvedReason && terminalWithoutMoney) {
          // Clearing the flag is what makes "close it" an exit rather than a
          // two-step one described as one — the triager who closes the deal
          // should not have to come back and clear a note that is now false.
          // Cleared with a row, never silently: the flag's documented contract
          // is that it is reported on and never quietly dropped.
          if (app.needsFinancingReconciliation === true) {
            await ctx.db.insert("financeApplicationOverrides", {
              orgId: app.orgId,
              applicationId: app._id,
              field: "needsFinancingReconciliation",
              previousValue: app.financingReconciliationReason ?? "true",
              newValue: "cleared",
              reason: `The deal reached ${app.status} without disbursement or a finalized sale, so there is nothing left to reconcile.`,
              changedBy: app.salespersonId,
              changedAt: now,
            });
          }
          await ctx.db.patch(app._id, {
            financingBackfilledAt: now,
            ...(app.needsFinancingReconciliation === true
              ? {
                  needsFinancingReconciliation: false,
                  financingReconciliationReason: undefined,
                }
              : {}),
          });
          report.applicationsClosedUnlinked += 1;
          continue;
        }
        if (unresolvedReason) {
          // Terminal but money moved: the deal cannot be re-bound and closing it
          // is not an exit, so say that rather than leaving an instruction the
          // reader cannot follow. It stays flagged because it is a real
          // unresolved state on a deal that actually paid out.
          const reasonForRow = isInFlight(app)
            ? unresolvedReason
            : `${unresolvedReason} This deal is already ${app.status.toLowerCase()} and money moved on it, so it cannot be re-bound — it stays flagged as a historical record.`;
          // Re-raise whenever the flag is not currently up — NOT only when it
          // has never been set. `resolveFinancingReconciliation` clears it to
          // `false`, so testing for `undefined` meant one triager clearing an
          // item they could not action silenced it for good: permanently
          // unlinked AND invisible, which is the exact outcome this branch
          // exists to prevent, reached through the queue instead of the marker.
          // The condition is genuinely still true, so the row belongs back in
          // the queue until somebody changes the deal.
          if (app.needsFinancingReconciliation !== true) {
            await ctx.db.patch(app._id, {
              needsFinancingReconciliation: true,
              financingReconciliationReason: reasonForRow,
            });
          }
          report.applicationsUnlinked += 1;
          continue;
        }
        await ctx.db.patch(app._id, {
          financingBackfilledAt: now,
          ...(backfilledVersionId ? { companyRuleVersionId: backfilledVersionId } : {}),
        });
        report.applicationsSkipped += 1;
        continue;
      }

      const reconciliationReason = reconciliationReasonFor(app);
      // Fill only what is unset. A row a live mutation already advanced holds a
      // value derived from the same mapping, and overwriting a dimension the
      // application has genuinely moved past — an appraisalStatus of PENDING,
      // say — would be a downgrade, not a repair.
      await ctx.db.patch(app._id, {
        financingBackfilledAt: now,
        ...(app.creditDecision === undefined
          ? { creditDecision: creditDecisionForStatus(app.status) }
          : {}),
        // No appraisal record has ever existed for these. The
        // `underwritingSnapshot.vehicleValuationAtSubmission` beside them is a
        // mutable, dealer-editable valuation with no provider, date or
        // document — promoting it to an appraisal would manufacture evidence.
        ...(app.appraisalStatus === undefined
          ? { appraisalStatus: "NOT_REQUESTED" as const }
          : {}),
        ...(app.settlementStatus === undefined
          ? { settlementStatus: settlementStatusForFacts(app) }
          : {}),
        ...(app.handoverStatus === undefined
          ? { handoverStatus: handoverStatusForFacts(app) }
          : {}),
        // gapResolution is deliberately left unset. NOT_REQUIRED would assert
        // somebody checked there was no appraisal gap, and nobody did — the
        // concept did not exist when these were written.
        ...(companyRuleSnapshot ? { companyRuleSnapshot } : {}),
        ...(companyRuleVersionId ? { companyRuleVersionId } : {}),
        ...(reconciliationReason && app.needsFinancingReconciliation === undefined
          ? {
              needsFinancingReconciliation: true,
              financingReconciliationReason: reconciliationReason,
            }
          : {}),
      });

      report.applicationsBackfilled += 1;
      if (reconciliationReason && app.needsFinancingReconciliation === undefined) {
        report.applicationsFlagged += 1;
      }
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

    report.status = "COMPLETE";
    console.log(
      `[migrateFinancingEconomics] complete: ${report.companiesScanned} companies scanned ` +
        `(${report.companiesVersioned} versioned), ` +
        `${report.applicationsScanned} applications scanned ` +
        `(${report.applicationsBackfilled} backfilled, ` +
        `${report.applicationsBoundToSnapshot} bound to a rule snapshot, ` +
        `${report.applicationsFlagged} flagged for reconciliation, ` +
        `${report.applicationsUnlinked} left unmarked pending a rule-version link, ` +
        `${report.applicationsClosedUnlinked} terminal and abandoned unlinked, ` +
        `${report.applicationsSkipped} already current).`
    );
    // COMPLETE means the walk finished, not that every row landed. Saying so at
    // warn level keeps an operator from reading a clean "complete" and closing
    // the ticket over deals that are still unbound.
    if (report.applicationsUnlinked > 0) {
      console.warn(
        `[migrateFinancingEconomics] ${report.applicationsUnlinked} application(s) could not be bound ` +
          `to a rule version and are flagged for reconciliation. They are re-scanned on every run and ` +
          `will stay flagged until the underlying deal is corrected.`
      );
    }
    return report;
  },
});
