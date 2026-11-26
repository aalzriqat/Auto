import { type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { projectFinanceApplication } from "../../utils/financeApplicationProjection";
import { projectOptionalVehicleForRole } from "../../utils/vehicleCostVisibility";
import { listEligibleBanks } from "../../utils/bankAccountGuards";
import { settlementPayer } from "../../utils/vehicleOwnership";
import { manualPayerLabel } from "../../utils/manualFinancePayer";
import { findFinanceReceivable } from "./financeReceivables";
import { getQuoteDeposits, pendingDepositResolution } from "./dealDeposits";
import { readQuoteDepositIntake } from "../../utils/depositRequestGuards";
import { type PaginationOptions } from "convex/server";

type ListInput = {
  orgId: Id<"organizations">;
  status?: string;
  paginationOpts: PaginationOptions;
};

import {
  economicsStamp,
  handoverEvidenceFor,
  type ApprovalAnomaly,
} from "./handover";
import { canChangeSettlementRoute, settlementPayerForApplication } from "./settlementRouting";

export async function executeList(
  ctx: QueryCtx,
  args: ListInput,
  role: Doc<"roles">,
) {
  // Reusing sales permission for now

  let pageResult;
  if (args.status) {
    pageResult = await ctx.db
      .query("financeApplications")
      .withIndex("by_org_status", (q) =>
        q
          .eq("orgId", args.orgId)
          .eq(
            "status",
            args.status as
              | "APPROVED"
              | "REJECTED"
              | "DRAFT"
              | "PENDING_DOCS"
              | "UNDER_REVIEW"
              | "CLOSED",
          ),
      )
      // Newest first: the Deals page shows the first page, and oldest-first
      // hid every new deal once an org passed one page (SCRUM-603).
      .order("desc")
      .paginate(args.paginationOpts);
  } else {
    pageResult = await ctx.db
      .query("financeApplications")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  }

  // Enrich
  const page = await Promise.all(
    pageResult.page.map(async (app) => {
      const customer = await ctx.db.get(app.customerId);
      const vehicle = await ctx.db.get(app.vehicleId);
      const company = app.companyId ? await ctx.db.get(app.companyId) : null;
      const salesperson = await ctx.db.get(app.salespersonId);
      const quote = await ctx.db.get(app.quoteId);
      const hasPendingDepositResolution = await pendingDepositResolution(
        ctx,
        app,
      );
      // Through the shared resolver, not a fourth hand-rolled reading of the
      // same rule — this file has been corrected twice already for exactly
      // that. The pure form, because `quote` is loaded here anyway for the
      // financed amounts, so it costs no extra read.
      const payerLabel = manualPayerLabel(app);
      const payer = settlementPayer({
        quoteMode: app.quoteModeAtSubmission ?? quote?.mode,
        financeCompanyId: app.companyId,
        manualProviderName: payerLabel,
      });
      // Trimmed, matching `settlementPayer` — `saveQuote` applies no trim, so
      // a whitespace-only provider name is reachable, and raw truthiness
      // would render it as a blank cell while the resolver correctly called
      // the payer unnamed.
      const manualProviderName = payerLabel?.trim() || undefined;

      return {
        // The list spreads the whole document too, and it authorizes on the
        // same VIEW_SALES as the detail query — so redacting the three detail
        // endpoints while leaving this one open would hand the same evidence
        // to the same caller through the paginated list. The fourth door.
        ...projectFinanceApplication(app, role),
        customerName: customer
          ? `${customer.firstName} ${customer.lastName}`
          : "Unknown",
        vehicleDesc: vehicle
          ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
          : "Unknown",
        // Not `company ? company.name : "Cash / Direct"`. A
        // MANUAL_FINANCE_COMPANY deal has no company row by construction, so
        // every one of them was listed as "Cash / Direct" — on a screen whose
        // whole subject is financed deals, and where "Direct" is now also the
        // name of the other settlement route. The operator finds the deal
        // here before opening it.
        // The nameless cases come back as a key the client translates —
        // returning English here put "Finance provider" and "Lease" into the
        // Arabic UI.
        //
        // `companyName` still carries a displayable string in every case, and
        // must never be empty: the MOBILE list renders it directly
        // (`apps/mobile/src/features/workspace/modules/applications.tsx`)
        // and knows nothing about the key, so an empty string would leave a
        // dangling separator there — and the mobile bundle publishes over
        // the air on merge. The web client prefers the key and translates.
        //
        // It is also what the list searches, so a manual provider's name
        // being the value here is what lets an operator find the deal by it.
        companyName:
          company?.name ??
          manualProviderName ??
          (!payer.external
            ? "Cash / Direct"
            : payer.counterparty === null &&
                payer.unidentifiedReason === "LEASE"
              ? "Lease"
              : "Finance provider"),
        companyLabelKey:
          (company?.name ?? manualProviderName)
            ? null
            : !payer.external
              ? "CashOrDirect"
              : payer.counterparty === null &&
                  payer.unidentifiedReason === "LEASE"
                ? "LeaseFinancing"
                : "UnnamedFinanceProvider",
        salespersonName:
          salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        financedAmount: quote?.totalFinancedAmount || 0,
        monthlyInstallment: quote?.monthlyInstallment || 0,
        hasPendingDepositResolution,
      };
    }),
  );

  return { ...pageResult, page };
}

type GetInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
};

export async function executeGet(
  ctx: QueryCtx,
  args: GetInput,
  app: Doc<"financeApplications">,
  role: Doc<"roles">,
  approvedAmountIsFarFromEvidenceFor: ApprovalAnomaly,
) {
  /**
   * Settlement evidence is withheld from a caller who may not see money.
   *
   * This query authorizes on VIEW_SALES and returns the whole application
   * document, which predates this release — but the settlement fields inside
   * it do not. `supplierDisbursedAmountMinor`, `supplierDisbursementReference`,
   * `supplierDisbursementStatus` and `supplierDisbursementApprovedAtRecordingMinor`
   * appear nowhere in `origin/main`'s schema. So the release put exactly the
   * figures `dealCockpit` gates behind VIEW_FINANCE into a payload the default
   * SALES template can read, and gating one of the two queries that return the
   * same document gates nothing.
   *
   * `approvedDealerPurchaseAmountMinor` goes with them even though the field
   * itself predates the release. The discrepancy IS the difference between
   * approved and disbursed; withholding one side while publishing the other
   * closes nothing, and the approved amount is one subtraction from the
   * supplier's entitlement — the disclosure the cockpit's split exists to
   * prevent.
   *
   * The ROUTE stays visible. It is a workflow fact about how the deal
   * settles, not an amount, and the cockpit likewise leaves
   * `settlementAdviceRequiresReconciliation` ungated so a stuck deal is still
   * visible to the people who work it.
   */
  const visibleApp = projectFinanceApplication(app, role);

  const customer = await ctx.db.get(app.customerId);
  const vehicle = await ctx.db.get(app.vehicleId);
  const company = app.companyId ? await ctx.db.get(app.companyId) : null;
  const salesperson = await ctx.db.get(app.salespersonId);
  const quote = await ctx.db.get(app.quoteId);
  const deposits = (await getQuoteDeposits(ctx, app.quoteId))
    .filter((deposit) => deposit.orgId === app.orgId && deposit.customerId === app.customerId);
  const intake = quote?.orgId === app.orgId && (quote.vehicleItems?.length ?? 1) === 1 &&
    app.vehicleHandoverAt === undefined && app.finalizedSaleId === undefined
    ? await readQuoteDepositIntake(ctx, quote)
    : null;

  // Derived here rather than in the dialog, because the client must not hold
  // a second opinion about who pays for the car. A previous version of this
  // change shipped the rule twice — once on the server and once in
  // `lib/consignedRouteGuard.ts` — and the copies were free to disagree about
  // what the operator was allowed to choose. One answer, from the side that
  // enforces it.
  //
  // Through the same helper the mutations use, not a second assembly of the
  // same facts: an inline copy here would be a third opinion in the file that
  // exists to remove the second one.
  const payer = await settlementPayerForApplication(ctx, app);
  // A held عربون no longer refuses the direct route (plan v3 forwards it to the
  // finance company with the contribution), so the payer alone decides.
  const payerAllowsDirect = payer.external && payer.counterparty !== null;

  return {
    ...visibleApp,
    // Issued from the UNREDACTED row, deliberately. The stamp is a comparison
    // token, not evidence: a caller whose amounts were withheld above still
    // has to prove the deal did not move under them.
    economicsStamp: economicsStamp(app),
    /**
     * The server's anomaly verdict, so this screen's handover confirmation
     * warns about the same deals the cockpit's does.
     *
     * Both entry points open the SAME one-way door. Passing `false` here — as
     * this screen briefly did — meant the cockpit could say an amount is
     * unlike the quotation and every appraisal on file while the other
     * confirmation presented it as ordinary. Read from the shared derivation
     * rather than recomputed, so the two cannot form separate opinions.
     */
    /**
     * The SAME projection the cockpit consumes, so the two doors into the
     * handover cannot describe the same deal differently — including how its
     * figures are denominated.
     */
    handoverEvidence: await handoverEvidenceFor(
      ctx,
      app,
      role,
      approvedAmountIsFarFromEvidenceFor,
    ),
    customer,
    vehicle: projectOptionalVehicleForRole(vehicle, role),
    company,
    salesperson,
    quote,
    deposits,
    ...(intake && intake.kind === "available" && intake.application?._id === app._id
      ? { depositReceiptQuoteId: app.quoteId }
      : {}),
    /** Whether an outside party pays for the car at all. */
    hasExternalFinancier: payer.external,
    /** Whether DIRECT_TO_SUPPLIER is available, and why not when it is not. */
    canSettleDirectToSupplier: payerAllowsDirect,
    /** SCRUM-1017: false once the vehicle is handed over on a recorded route. */
    canChangeSettlementRoute: canChangeSettlementRoute(app),
    directRouteRefusal: !payer.external
      ? "NoExternalFinancier"
      : payer.counterparty === null
        ? payer.unidentifiedReason
        : null,
  };
}

type GetLogInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
};

// SCRUM-37: prove the application is this org's (missing and foreign refuse
// alike), then return only log rows stamped with this org.
export async function executeGetLog(
  ctx: QueryCtx,
  args: GetLogInput,
  application: Doc<"financeApplications">,
) {
  const entries = (
    await ctx.db
      .query("applicationStatusLog")
      .withIndex("by_application", (q) =>
        q.eq("applicationId", application._id),
      )
      .order("asc")
      .collect()
  ).filter((entry) => entry.orgId === args.orgId);

  return Promise.all(
    entries.map(async (entry) => {
      const user = await ctx.db.get(entry.changedBy);
      return {
        ...entry,
        changedByName:
          user && "name" in user ? (user.name ?? user.email) : "Unknown",
      };
    }),
  );
}

type ListDisbursementBankOptionsInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
};

/**
 * SCRUM-54: what the confirm-receipt dialog needs to name the physical bank.
 * `needsBank` is the server's own answer (the registered method is not CASH);
 * `banks` are this org's live, active banks in the receivable's currency - the
 * same test `confirmDisbursement` applies. Only id, name and currency are
 * returned, never IBAN or account numbers.
 */
export async function executeListDisbursementBankOptions(
  ctx: QueryCtx,
  args: ListDisbursementBankOptionsInput,
  app: Doc<"financeApplications">,
) {
  const needsBank = app.expectedPaymentMethod !== "CASH";
  // CASH needs no bank and never reads the receivable.
  if (!needsBank)
    return { needsBank, banks: [], truncated: false, receivableMissing: false };
  // The receivable fixes the currency a bank must match. Without it the eligible set is
  // unknowable, so this is its own state - never an empty list that reads as "no bank".
  const receivable = await findFinanceReceivable(ctx, app);
  if (!receivable)
    return { needsBank, banks: [], truncated: false, receivableMissing: true };
  // Read by currency, so banks in other currencies never crowd out an eligible one; more
  // eligible banks than the limit is reported as truncation, never as a partial list.
  const { banks, truncated } = await listEligibleBanks(
    ctx,
    args.orgId,
    receivable.currency,
  );
  return { needsBank, banks, truncated, receivableMissing: false };
}
