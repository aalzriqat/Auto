/**
 * Shared fixtures for the financed consigned-deal settlement suites: a
 * dealership with a live chart and one consigned car (`seedDealershipWith`) and
 * a walk of a deal from quote to handover/finalization (`runDeal`).
 *
 * Moved verbatim out of `convex/financedConsignedSettlement.test.ts` (SCRUM-1017)
 * so a second suite can drive the same deal without a copy. The only change is
 * that the suite's own `import.meta.glob` module map is passed in.
 */
import { convexTestWithComponents, registerHandover, legacyFinancingMinor } from "./convexTest";
import { recordFirstPaymentForHandover } from "./firstPaymentEvidenceFixture";
import { payForwardBeforeFinalize } from "./financedDealFixture";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

export const PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  // SCRUM-886: correcting a supplier cost through vehicles.update needs the right to read cost.
  "view:cost_price",
  "view:commissions", "manage:commissions",
  // The sales reports read the same deals this file completes, and SCRUM-30
  // requires them to agree with the ledger about what one earned.
  "view:reports",
];

export const VEHICLE_PRICE = 20_000;
export const SUPPLIER_ENTITLEMENT = 15_000;
export const MARGIN = VEHICLE_PRICE - SUPPLIER_ENTITLEMENT;
/** JOD is a three-decimal currency, so a major unit is 1,000 minor units. */
export const SCALE = 1_000;

export type Route = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";

/**
 * A dealership with a live chart and an open period, one consigned car, and a
 * finance company. `sourceType: SOURCED` is what makes the car legally the
 * supplier's; `sourceCost` is his entitlement.
 */
export async function seedDealershipWith(
  modules: Record<string, () => Promise<unknown>>,
  tag: string,
  opts: { sourceType?: "STOCK" | "SOURCED"; /** false: a Free/Starter org that never initialized a chart. */ chart?: boolean } = {}
) {
  const t = convexTestWithComponents(schema, modules);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Financed ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Deal User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_appr`, email: `${tag}.appr@example.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  const asApprover = t.withIdentity({ subject: `${tag}_appr`, clerkId: `${tag}_appr` });

  if (opts.chart !== false) {
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const fiscalYear = new Date().getUTCFullYear();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", {
      orgId,
      label: "Eligible",
      isActive: true,
      order: 1,
    })
  );
  const sourceType = opts.sourceType ?? "SOURCED";
  let supplierId: Id<"suppliers"> | undefined;
  if (sourceType === "SOURCED") {
    supplierId = await t.run((ctx) =>
      ctx.db.insert("suppliers", {
        orgId,
        displayName: "Amman Importer Co",
        displayNameKey: "amman importer co",
        status: "ACTIVE",
        version: 1,
        origin: "MANUAL",
        createdBy: userId,
        createdAt: Date.now(),
        updatedBy: userId,
        updatedAt: Date.now(),
      })
    );
  }
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINFIN${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      ...(sourceType === "SOURCED"
        ? { sourceType: "SOURCED" as const, sourcedSupplierId: supplierId, sourcedFromName: "Amman Importer Co", sourceCost: SUPPLIER_ENTITLEMENT }
        : { sourceType: "STOCK" as const, purchasePrice: SUPPLIER_ENTITLEMENT }),
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, adminFees: 0, defaultLtvPercent: 100,
    })
  );

  return {
    t,
    orgId,
    userId,
    approverId,
    customerId,
    customerStatusId,
    vehicleId,
    companyId,
    asUser,
    asApprover,
  };
}

export type Seeded = Awaited<ReturnType<typeof seedDealershipWith>>;

export async function runDeal(
  s: Seeded,
  opts: {
    route?: Route;
    downPayment?: number;
    finalize?: boolean;
    /**
     * What the finance company approved, in major units. Direct route only —
     * it is the amount that reaches the supplier. Defaults to the vehicle
     * price, which is the shape every pre-existing expectation assumes.
     */
    approvedAmount?: number;
    /** A reservation deposit (عربون) held on the quote before the deal closes. */
    deposit?: number;
    /**
     * Who takes the deposit.
     *
     * `releaseHeldDeposit` refuses to let the person who took a deposit be the one
     * who refunds or forfeits it, so a case that ends in a refund has to have
     * been taken by somebody else — the same segregation a real dealership runs.
     */
    depositTakenBy?: "user" | "approver";
    /** A deposit taken AFTER the route was chosen — the ordering the route-time guard cannot see. */
    depositAfterRoute?: number;
    /**
     * Every mode but CONFIGURED_FINANCE_COMPANY is refused a `companyId` by
     * `quotes.saveQuote`, so these are the shapes where "is there an external
     * financier?" cannot be answered by looking at that field.
     */
    mode?:
      | "CONFIGURED_FINANCE_COMPANY"
      | "INTERNAL_INSTALLMENT"
      | "MANUAL_FINANCE_COMPANY"
      | "LEASE";
    /** The manual financier's name, which is the only identity that mode has. */
    manualProviderName?: string;
    /**
     * The legacy shape: `mode` is optional on both the quote and the
     * application, and `saveQuote` explicitly permits a `companyId` without
     * one. Rows written before the field existed look exactly like this.
     */
    omitMode?: boolean;
    depositResolution?: {
      treatment: "APPLY_TO_DEALER_AMOUNT" | "APPLY_TO_TRANSACTION_SETTLEMENT" | "REFUND_TO_CUSTOMER" | "FORFEITED" | "OTHER";
      reason?: string;
      refundMethod?: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
    };
    /** Runs after the route is chosen and before the vehicle goes out. */
    beforeHandover?: (applicationId: Id<"financeApplications">) => Promise<void>;
    /** Use pre-proof history to isolate a downstream finalization refusal. */
    historicalHandover?: true;
    /** Runs after every prerequisite is on the record and immediately before `finalizeDeal`. */
    beforeFinalize?: (applicationId: Id<"financeApplications">) => Promise<void>;
  } = {}
) {
  const downPayment = opts.downPayment ?? 0;
  const mode = opts.mode ?? "CONFIGURED_FINANCE_COMPANY";
  // SCRUM-495: LEASE and INTERNAL_INSTALLMENT can no longer be SAVED, so a legacy row in either mode
  // is built the way one actually exists: saved through an operated mode with no company (the same
  // no-companyId shape those modes had), then stamped into the retired mode below. Everything the
  // readers derive (`quote.mode` and `quoteModeAtSubmission`) is therefore what a real legacy row carries.
  const retiredMode = mode === "LEASE" || mode === "INTERNAL_INSTALLMENT" ? mode : undefined;
  const savedMode = retiredMode ? "MANUAL_FINANCE_COMPANY" : mode;
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment,
    termMonths: 48,
    mode: savedMode,
    ...(mode === "CONFIGURED_FINANCE_COMPANY"
      ? {
          companyId: s.companyId,
          customerEligibilityStatusIds: [s.customerStatusId],
        }
      : {}),
    ...(savedMode === "MANUAL_FINANCE_COMPANY" && opts.manualProviderName !== undefined
      ? { manualProviderName: opts.manualProviderName }
      : {}),
    ...(savedMode === "MANUAL_FINANCE_COMPANY" ? { manualAdminFees: 0 } : {}),
    totalFinancedAmount: VEHICLE_PRICE - downPayment,
  });

  if (opts.deposit) {
    const taker = opts.depositTakenBy === "approver" ? s.asApprover : s.asUser;
    await taker.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      quoteId,
      amount: opts.deposit,
    });
  }

  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, {
    orgId: s.orgId,
    quoteId,
  });
  if (retiredMode) {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(quoteId, { mode: retiredMode });
      // A legacy retired-mode row never carried the manual-provider snapshot the operated mode stamps.
      await ctx.db.patch(applicationId, { quoteModeAtSubmission: retiredMode, manualFinanceSnapshot: undefined });
    });
  }
  if (opts.omitMode) {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(quoteId, { mode: undefined });
      await ctx.db.patch(applicationId, { quoteModeAtSubmission: undefined });
    });
  }
  await s.asUser.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
  });
  await s.asApprover.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "APPROVED",
  });

  if (opts.route) {
    await s.asUser.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId, applicationId, route: opts.route,
    });
  }

  if (opts.depositAfterRoute) {
    await s.asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      quoteId,
      amount: opts.depositAfterRoute,
    });
  }

  // A financed deal settled through the dealership now has to carry the figures
  // its settlement posts from: what the company approved, and therefore what it
  // will actually remit. Finalization refuses without them. Before SCRUM-192
  // every fixture here relied on the legacy no-quotation carve-out and the deal
  // posted from the customer's financing principal instead — which is the defect,
  // not the baseline.
  //
  // Recorded here because handover seals the approved amount, and skipped when
  // the caller drives its own: `approveDealerPurchaseAmount` refuses to change a
  // recorded approval, so seeding one would make that path unreachable.
  const throughRouteNeedsEconomics =
    opts.finalize !== false &&
    mode === "CONFIGURED_FINANCE_COMPANY" &&
    !opts.omitMode &&
    opts.route !== "DIRECT_TO_SUPPLIER";
  if (throughRouteNeedsEconomics) {
    const alreadyApproved = await s.t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      return app?.approvedDealerPurchaseAmountMinor !== undefined;
    });
    if (!alreadyApproved) {
      await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId: s.orgId,
        applicationId,
        submittedQuotationMinor: VEHICLE_PRICE * SCALE,
        source: "MANUAL_ENTRY",
      });
      await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId: s.orgId,
        applicationId,
        approvedAmountMinor: VEHICLE_PRICE * SCALE, approvedFinancingAmountMinor: legacyFinancingMinor(VEHICLE_PRICE * SCALE, 100, downPayment * SCALE),
        basis: "MANUAL",
        notes: "Approved at the quotation.",
      });
    }
  }

  // SCRUM-27: a MANUAL finance company deal cannot be handed over until the
  // manager has entered its approval letter (G, name, S). A deal whose quote
  // names the provider gets the letter here, naming the same company at the
  // vehicle price, so the payer identity every test below reads is unchanged.
  // A deal whose quote names NO provider has no name a letter could carry, so it
  // stops here - before handover - which is all its route/label assertions need.
  if (mode === "MANUAL_FINANCE_COMPANY") {
    const providerName = opts.manualProviderName?.trim();
    if (providerName) {
      await s.asApprover.mutation(api.financingEconomics.recordManualFinanceApproval, {
        orgId: s.orgId, applicationId,
        approvedAmountMinor: VEHICLE_PRICE * SCALE, financierName: providerName, dealerSendsMinor: 0,
      });
    } else if (opts.finalize === false) {
      return { quoteId, applicationId, saleId: null };
    }
  }

  // Anything that must be on the record BEFORE the vehicle goes out.
  //
  // Handover seals the approved amount: `approveDealerPurchaseAmount` now
  // refuses to change a recorded one afterwards, as `reopenApproval` and
  // `recordAppraisal` already did. A case that needs a CORRECTION on the record
  // — an override history, say — has to make it while the door is still open,
  // which is also the only order an operator could achieve.
  await opts.beforeHandover?.(applicationId);

  // The stamp of the economics as they stand at this moment, taken from the
  // deal payload the way a real screen gets it. Read rather than assumed:
  // `beforeHandover` may have recorded an approval, and most callers here have
  // not, so the stamp differs between cases.
  if (opts.historicalHandover) {
    await s.t.run((ctx) => ctx.db.patch(applicationId, {
      vehicleHandoverAt: Date.now(), vehicleHandoverBy: s.userId, handoverStatus: "HANDED_OVER",
    }));
  } else {
    await recordFirstPaymentForHandover({ verifier: s.asApprover, api, orgId: s.orgId, applicationId });
    await registerHandover(s.asUser, api, s.orgId, applicationId);
  }
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });

  // The deal's costs settled and checked - what finalization's automatic readiness
  // check requires (SCRUM-407 retired the manual classification step; SCRUM-411
  // retired the manual legal invoice, so none is recorded here). The single cost line carries a
  // zero actual and is NOT deducted from the settlement — the shape the refusal
  // message itself suggests for a deal the dealership bore no costs on — so the
  // remittance stays the whole approval and these tests keep testing the supplier.
  if (throughRouteNeedsEconomics) {
    const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, { expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      deductedFromSettlement: false,
      actualAmountMinor: 0,
      description: "The dealership bore no closing costs on this deal.",
    });
    await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "Nothing to match.",
      expectedActualAmountMinor: 0,
      expectedActualEvidenceRevision: 0,
    });
  }

  // On the direct route the finance company's APPROVED amount is what reaches
  // the supplier, so the dealership's claim on him is measured from it and
  // `finalizeDeal` refuses without one.
  //
  // Approved AT the vehicle price, which is what every expectation in this file
  // was written against: with `approved === salePrice` the claim is
  // `salePrice − entitlement`, exactly as before, so this records a fact that
  // was previously implicit rather than changing any deal's economics. The case
  // where they DIFFER is the one that matters, and it is exercised through the
  // real writers — `recordSubmittedQuotation` then `approveDealerPurchaseAmount`
  // — rather than from here, because that is the path a real deal takes.
  //
  // Only `approvedDealerPurchaseAmountMinor` is written. The funding split is
  // deliberately left alone: `assertDealerEconomicsRecorded` requires it only
  // once a quotation is recorded, and tests that care about the contribution set
  // it themselves — including the one that proves an UNRECORDED contribution
  // withholds the headline instead of assuming zero.
  // AFTER the `finalize: false` return, deliberately. A caller that stops short
  // of finalizing is one that intends to drive the economics itself through the
  // real writers, and `recordSubmittedQuotation` refuses to run once an approval
  // exists — so seeding one here would make that path unreachable.
  if (opts.finalize === false) return { quoteId, applicationId, saleId: null };

  if (opts.route === "DIRECT_TO_SUPPLIER") {
    await s.t.run(async (ctx) => {
      await ctx.db.patch(applicationId, {
        approvedDealerPurchaseAmountMinor: (opts.approvedAmount ?? VEHICLE_PRICE) * SCALE,
      });
    });
  }

  await opts.beforeFinalize?.(applicationId);
  // SCRUM-411 P2-01: the deposit (H) and the contribution (D) are paid to the finance
  // company BEFORE the sale, and `finalizeDeal` refuses until that payment is on the
  // books. A no-op when nothing is owed. Skipped when the operator's deposit choice is
  // anything but "apply it to this purchase": the payment is judged against the plan
  // finalize will freeze, which then carries no H, so paying H here would only leave a
  // stale payment behind (and add accounting events the refusal cases forbid).
  const depositIsApplied =
    opts.depositResolution === undefined ||
    opts.depositResolution.treatment === "APPLY_TO_TRANSACTION_SETTLEMENT";
  // Also skipped when `beforeFinalize` already closed the deal itself: the payment is
  // only recordable (and only needed) before the sale exists, and the finalize below
  // then just replays the stored sale.
  const beforeSale = await s.t.run((ctx) => ctx.db.get(applicationId));
  if (depositIsApplied && beforeSale?.status === "APPROVED" && beforeSale.finalizedSaleId === undefined) {
    await payForwardBeforeFinalize(s, s.asUser, applicationId);
  }
  const saleId = await s.asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    applicationId,
    ...(opts.depositResolution ? { depositResolution: opts.depositResolution } : {}),
  });
  return { quoteId, applicationId, saleId };
}
