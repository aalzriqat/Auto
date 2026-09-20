import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

/**
 * The financed deal overview read model: what it serves, to whom, and that it
 * is derived from the cockpit's own authority rather than a second reading.
 */
describe("dealOverview.financedDealOverview", () => {
  interface Seed {
    t: TestConvex;
    orgId: Id<"organizations">;
    otherOrgId: Id<"organizations">;
    userId: Id<"users">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    quoteId: Id<"quotes">;
    asOwner: AuthenticatedTestConvex;
  }

  async function seed(suffix = "1", vehicle: { sourceType?: "STOCK" | "SOURCED" } = {}): Promise<Seed> {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `DO Dealer ${suffix}`, createdAt: Date.now() })
    );
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `DO Other ${suffix}`, createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `do_owner_${suffix}`, email: `do.owner${suffix}@example.com`, name: "DO Owner" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "DO", lastName: "Customer" })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `DOVIN${suffix}`,
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 10_500,
        status: "AVAILABLE",
        ...(vehicle.sourceType === "SOURCED"
          ? { sourceType: "SOURCED" as const, sourceCost: 8_000, sourcedFromName: "Supplier Co" }
          : { sourceType: "STOCK" as const, purchasePrice: 9_500, landedCostTotal: 100 }),
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 10_500,
        downPayment: 500,
        termMonths: 60,
        status: "ACCEPTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    return { t, orgId, otherOrgId, userId, customerId, vehicleId, quoteId, asOwner: t.withIdentity({ subject: `do_owner_${suffix}` }) };
  }

  const DEAL_CREATED_AT = Date.UTC(2026, 5, 15);

  async function insertApplication(s: Seed, orgId: Id<"organizations"> = s.orgId) {
    return await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status: "APPROVED",
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 12_000_000,
        approvedDealerPurchaseAmountMinor: 11_000_000,
        financeCompanyFundedPortionMinor: 9_350_000,
        dealerContributionMinor: 1_650_000,
        createdAt: DEAL_CREATED_AT,
        updatedAt: DEAL_CREATED_AT,
      })
    );
  }

  async function callerWith(s: Seed, tag: string, permissions: string[]): Promise<AuthenticatedTestConvex> {
    const userId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `do_${tag}`, email: `do.${tag}@example.com`, name: tag })
    );
    const roleId = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: tag, permissions }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    return s.t.withIdentity({ subject: `do_${tag}` });
  }

  async function insertExpense(
    s: Seed,
    overrides: Partial<{ date: number; accountingTreatment: "CAPITALIZED_INVENTORY" | "PERIOD_EXPENSE"; capitalizedAmount: number; reversedAt: number; status: "PAID" | "PENDING" }>
  ) {
    return await s.t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        title: "Brake job",
        amount: 116,
        taxAmount: 16,
        date: DEAL_CREATED_AT - 1_000,
        category: "REPAIR",
        status: "PAID",
        accountingTreatment: "CAPITALIZED_INVENTORY",
        capitalizedAmount: 100,
        ...overrides,
      })
    );
  }

  test("the owner reads the summary from the application's frozen economics and the cost basis from the vehicle", async () => {
    const s = await seed();
    // Registered BEFORE the application: pre-deal. The cutoff is the row's
    // registration instant, not its business date.
    await insertExpense(s, {});
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined });
    const applicationId = await insertApplication(s);
    // Registered AFTER the application, back-dated: not pre-deal, counted as excluded.
    await insertExpense(s, { date: DEAL_CREATED_AT - 5_000 });

    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view).not.toBeNull();
    const summary = view!.financialSummary!;
    expect(summary.currency).toBe("JOD");
    expect(summary.customerSalePrice).toEqual({ amountMinor: 12_000_000, basis: "TARGET_SELLING_AMOUNT" });
    expect(summary.approvedPurchaseAmountMinor).toBe(11_000_000);
    expect(summary.financier.fundedPortionMinor).toBe(9_350_000);
    expect(summary.dealerOutlay.plannedContributionMinor).toBe(1_650_000);
    expect(summary.dealerOutlay.recordedCostsMinor).toBe(0);
    expect(summary.dealerOutlay.knownCommittedMinor).toBe(1_650_000);
    // No policy on this deal: the expected side is unknown, and so is the total — never zero.
    expect(summary.dealerOutlay.expectedCostsRemainingMinor).toBeNull();
    expect(summary.dealerOutlay.totalExpectedMinor).toBeNull();

    const basis = view!.vehicleCostBasis!;
    expect(basis.available).toBe(true);
    if (!basis.available) return;
    expect(basis.consigned).toBe(false);
    expect(basis.baseMinor).toBe(9_500_000);
    expect(basis.landedCostMinor).toBe(100_000);
    expect(basis.eligibleExpensesMinor).toBe(100_000);
    expect(basis.totalBeforeDealMinor).toBe(9_700_000);
    expect(basis.excluded.afterCutoffCount).toBe(1);
    expect(basis.excluded.periodExpenseCount).toBe(1);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(basis.cutoffCreationTime).toBe(app!._creationTime);
  });

  test("STOCK: the profit is measured against the vehicle's whole book value, never through a supplier settlement", async () => {
    const s = await seed("11");
    await insertExpense(s, {}); // pre-deal, capitalized 100
    const applicationId = await insertApplication(s);
    await insertExpense(s, {}); // deal-time reconditioning, capitalized 100 — in the book value, not in the pre-deal basis
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const profit = view!.financialSummary!.profit;
    expect(profit.available).toBe(true);
    if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
    // 9,500 purchase + 100 landed + 200 capitalized = 9,800 book value.
    expect(profit.lines).toContainEqual({ key: "VEHICLE_COST", sign: -1, amountMinor: 9_800_000 });
    expect(profit.lines.map((l) => l.key)).not.toContain("SUPPLIER_SETTLEMENT");
    expect(profit.amountMinor).toBe(11_000_000 - 9_800_000 - 1_650_000);
    expect(profit.postable).toBe(false);
    // The pre-deal basis beside it stops at the application's registration.
    const basis = view!.vehicleCostBasis!;
    if (!basis.available) throw new Error("expected available");
    expect(basis.totalBeforeDealMinor).toBe(9_700_000);
    // The cockpit's own consignment derivation is unavailable here, and is NOT what was served.
    const cockpit = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(cockpit!.money!.profit.available).toBe(false);
  });

  test("STOCK: the figure is called ACTUAL only when the money is settled AND every cost line is RECONCILED — a recorded actual is not enough", async () => {
    const s = await seed("17");
    const applicationId = await insertApplication(s);
    // Money settled on the cockpit's own terms; one dealer-borne line with a recorded, unchecked actual.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { settlementStatus: "FULLY_SETTLED" }));
    const feeId = await s.asOwner.mutation(api.financeDealCosts.recordDealFee, {
      orgId: s.orgId,
      applicationId,
      feeType: "LICENSING",
      paidBy: "DEALER",
      paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      actualAmountMinor: 90_000,
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    const classificationOf = async () => {
      const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      const profit = view!.financialSummary!.profit;
      if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
      return profit.classification;
    };
    // Settlement stage complete, but the line is RECORDED, not RECONCILED: still an estimate.
    expect(await classificationOf()).toBe("ESTIMATED_AWAITING_SETTLEMENT");
    await s.asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "checked against the receipt" });
    expect(await classificationOf()).toBe("ACTUAL_UNPOSTABLE");
  });

  test("STOCK: settled money with NO cost lines at all is still an estimate — nothing is reconciled", async () => {
    const s = await seed("18");
    const applicationId = await insertApplication(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { settlementStatus: "FULLY_SETTLED" }));
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const profit = view!.financialSummary!.profit;
    if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
    expect(profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("STOCK: a configured fee with no recorded line keeps the figure an estimate even when every recorded line is reconciled", async () => {
    const s = await seed("19");
    const applicationId = await insertApplication(s);
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        settlementStatus: "FULLY_SETTLED",
        companyRuleSnapshot: {
          ruleVersion: 1,
          companyName: "Policy Co",
          feeTemplates: [
            {
              feeType: "LICENSING",
              description: "Plates",
              estimatedAmountMinor: 250_000,
              paidBy: "DEALER",
              paidTo: "GOVERNMENT",
              includedInQuotation: false,
              deductedFromSettlement: false,
              refundable: false,
              accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
            },
          ],
        },
      })
    );
    // An unplanned line, recorded and reconciled — but the CONFIGURED fee has no line.
    const feeId = await s.asOwner.mutation(api.financeDealCosts.recordDealFee, {
      orgId: s.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      actualAmountMinor: 10_000,
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    await s.asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "checked" });
    const classificationOf = async () => {
      const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      const profit = view!.financialSummary!.profit;
      if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
      return profit.classification;
    };
    expect(await classificationOf()).toBe("ESTIMATED_AWAITING_SETTLEMENT");
    // Record and reconcile the configured fee: now, and only now, actual.
    const templateFeeId = await s.asOwner.mutation(api.financeDealCosts.recordTemplateFeeActual, {
      orgId: s.orgId,
      applicationId,
      templateIndex: 0,
      feeType: "LICENSING",
      actualAmountMinor: 250_000,
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await classificationOf()).toBe("ESTIMATED_AWAITING_SETTLEMENT");
    await s.asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId: templateFeeId, notes: "checked" });
    expect(await classificationOf()).toBe("ACTUAL_UNPOSTABLE");
  });

  test("STOCK: an unreadable capitalized row refuses the profit rather than overstating it", async () => {
    const s = await seed("12");
    await insertExpense(s, { capitalizedAmount: undefined });
    const applicationId = await insertApplication(s);
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "NoVehicleCost" });
    expect(view!.vehicleCostBasis).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
  });

  test("SOURCED: the cockpit's consignment profit, less the dealership's pre-deal preparation spend, subtracted exactly once", async () => {
    const s = await seed("13", { sourceType: "SOURCED" });
    // Period expenses on the supplier's car: 100 net paid before the deal, one after, one pending.
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined });
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined, status: "PENDING" });
    const applicationId = await insertApplication(s);
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined });
    // The supplier's payable makes the consignment profit AVAILABLE on the
    // through-dealership route: approved 11,000 − payable 8,000 − contribution 1,650.
    await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        sourcedFromName: "Supplier Co",
        amountDue: 8_000,
        amountPaid: 0,
        currency: "JOD",
        status: "DUE_ON_SALE",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const cockpit = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const served = view!.financialSummary!.profit;
    const own = cockpit!.money!.profit;
    if (!own.available || own.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected the cockpit's consignment estimate");
    expect(own.amountMinor).toBe(11_000_000 - 8_000_000 - 1_650_000);
    if (!served.available || served.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
    // Exactly the pre-deal preparation spend, subtracted once, as its own line; every other line untouched.
    expect(served.amountMinor).toBe(own.amountMinor - 100_000);
    expect(served.lines).toEqual([...own.lines, { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: 100_000 }]);
    expect(served.lines.find((l) => l.key === "SUPPLIER_SETTLEMENT")?.amountMinor).toBe(8_000_000);
    // The preparation figure itself is served beside the supplier's cost, never added to it.
    const prep = view!.dealerPreparation!;
    if (!prep.available) throw new Error("expected available");
    expect(prep.totalMinor).toBe(100_000);
    expect(prep.excluded.pendingCount).toBe(1);
    expect(prep.excluded.afterCutoffCount).toBe(1);
    const basis = view!.vehicleCostBasis!;
    if (!basis.available) throw new Error("expected available");
    expect(basis.totalBeforeDealMinor).toBe(8_000_000);
  });

  test("SOURCED: a capitalized row on a car that is consigned now is refused as ambiguous, not added to the supplier's cost", async () => {
    const s = await seed("15", { sourceType: "SOURCED" });
    await insertExpense(s, {}); // CAPITALIZED_INVENTORY on a consigned car
    const applicationId = await insertApplication(s);
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.vehicleCostBasis).toMatchObject({ available: false, reason: "AMBIGUOUS_OWNERSHIP_HISTORY" });
    expect(view!.dealerPreparation).toMatchObject({ available: false, reason: "AMBIGUOUS_OWNERSHIP_HISTORY" });
  });

  test("STOCK: no preparation figure is served — those costs are in the capitalized basis", async () => {
    const s = await seed("16");
    const applicationId = await insertApplication(s);
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.dealerPreparation).toBeNull();
  });

  test("the financier balance is an ESTIMATE from the expected remittance until a receivable exists, then the receivable", async () => {
    const s = await seed("14");
    const applicationId = await insertApplication(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { expectedDealerRemittanceMinor: 9_200_000 }));
    const before = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(before!.financialSummary!.financier.outstanding).toEqual({
      state: "ESTIMATED_PRE_RECEIVABLE",
      amountMinor: 9_200_000,
      basis: "EXPECTED_DEALER_REMITTANCE",
    });
    // The canonical receivable the finalization opens, keyed exactly as the cockpit reads it.
    await s.t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: s.orgId,
        documentType: "INVOICE",
        documentNumber: "FIN-1",
        payerType: "FINANCE_COMPANY",
        sourceType: "finance_application",
        sourceId: applicationId,
        originalAmountMinor: 9_150_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN",
        createdAt: Date.now(),
        createdBy: s.userId,
      })
    );
    const after = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(after!.financialSummary!.financier.outstanding).toEqual({
      state: "OUTSTANDING",
      amountMinor: 9_150_000,
      basis: "RECEIVABLE",
    });
  });

  describe("the pre-receivable estimate stands only on usable fee evidence", () => {
    async function estimateDeal(suffix: string) {
      const s = await seed(suffix);
      const applicationId = await insertApplication(s);
      await s.t.run((ctx) => ctx.db.patch(applicationId, { expectedDealerRemittanceMinor: 9_200_000 }));
      const outstanding = async () =>
        (await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId }))!.financialSummary!.financier.outstanding;
      return { s, applicationId, outstanding };
    }
    async function deductedFee(s: Seed, applicationId: Id<"financeApplications">, actualAmountMinor: number, currency = "JOD") {
      return await s.t.run((ctx) =>
        ctx.db.insert("financeDealFees", {
          orgId: s.orgId, applicationId, feeType: "FINANCE_COMPANY_FEE", currency, actualAmountMinor,
          paidBy: "FINANCE_COMPANY", paidTo: "FINANCE_COMPANY", accountingTreatment: "SELLING_EXPENSE",
          includedInQuotation: false, deductedFromSettlement: true, refundable: false, source: "MANUAL",
          createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
        })
      );
    }
    async function receivable(s: Seed, applicationId: Id<"financeApplications">) {
      await s.t.run((ctx) =>
        ctx.db.insert("receivableDocuments", {
          orgId: s.orgId, documentType: "INVOICE", documentNumber: "FIN-1", payerType: "FINANCE_COMPANY",
          sourceType: "finance_application", sourceId: applicationId, originalAmountMinor: 9_150_000, currency: "JOD", scale: 3,
          issueDate: Date.now(), dueDate: Date.now(), status: "OPEN", createdAt: Date.now(), createdBy: s.userId,
        })
      );
    }

    test.each([
      ["NaN", Number.NaN],
      ["a fraction", 50_000.5],
      ["a negative", -50_000],
      ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ])("a settlement-deducted actual carrying %s (raw) withholds the estimate as UNSAFE_AMOUNT; a receivable then overrides", async (label, corrupt) => {
      const { s, applicationId, outstanding } = await estimateDeal(`est-${label}`);
      await deductedFee(s, applicationId, 50_000);
      expect(await outstanding()).toEqual({ state: "ESTIMATED_PRE_RECEIVABLE", amountMinor: 9_200_000, basis: "EXPECTED_DEALER_REMITTANCE" });
      await deductedFee(s, applicationId, corrupt);
      expect(await outstanding()).toEqual({ state: "ESTIMATE_WITHHELD", amountMinor: null, basis: null, reason: "UNSAFE_AMOUNT" });
      await receivable(s, applicationId);
      expect(await outstanding()).toEqual({ state: "OUTSTANDING", amountMinor: 9_150_000, basis: "RECEIVABLE" });
    });

    test("two safe deducted actuals that overflow between them withhold the estimate as UNSAFE_AMOUNT", async () => {
      const { s, applicationId, outstanding } = await estimateDeal("est-overflow");
      await deductedFee(s, applicationId, Number.MAX_SAFE_INTEGER - 1);
      await deductedFee(s, applicationId, 2);
      expect(await outstanding()).toEqual({ state: "ESTIMATE_WITHHELD", amountMinor: null, basis: null, reason: "UNSAFE_AMOUNT" });
    });

    test("a live line in another currency — even one the dealership does not bear — withholds the estimate as MIXED_DENOMINATION; a receivable then overrides", async () => {
      const { s, applicationId, outstanding } = await estimateDeal("est-mixed");
      await deductedFee(s, applicationId, 40_000, "USD");
      expect(await outstanding()).toEqual({ state: "ESTIMATE_WITHHELD", amountMinor: null, basis: null, reason: "MIXED_DENOMINATION" });
      await receivable(s, applicationId);
      expect(await outstanding()).toEqual({ state: "OUTSTANDING", amountMinor: 9_150_000, basis: "RECEIVABLE" });
    });
  });

  test("a SOURCED vehicle's basis is the supplier's cost, flagged consigned, with no landed cost", async () => {
    const s = await seed("2", { sourceType: "SOURCED" });
    const applicationId = await insertApplication(s);
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const basis = view!.vehicleCostBasis!;
    if (!basis.available) throw new Error("expected available");
    expect(basis.consigned).toBe(true);
    expect(basis.baseMinor).toBe(8_000_000);
    expect(basis.landedCostMinor).toBeNull();
    expect(view!.financialSummary!.supplier.consigned).toBe(true);
  });

  test("the summary is served from the SAME money payload the cockpit serves — a held deposit shows in both", async () => {
    const s = await seed("3");
    const applicationId = await insertApplication(s);
    await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        amount: 500,
        status: "HELD",
        holdActive: true,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );
    const cockpit = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const customer = cockpit!.money!.parties.find((p) => p.party === "CUSTOMER")!;
    expect(view!.financialSummary!.customerPaidToDealer?.heldDepositMinor).toBe(customer.amountMinor);
    // A STOCK deal: the headline is the overview's own derivation (see the
    // STOCK test), but every party figure is the cockpit's, verbatim.
    expect(view!.financialSummary!.supplier.direction).toBe(cockpit!.money!.parties.find((p) => p.party === "SUPPLIER")!.position);
  });

  // --- redaction, field family by field family -------------------------------

  /** A live cost line inserted directly, so its denomination can be anything — the writers refuse a foreign one. */
  async function insertFee(
    s: Seed,
    applicationId: Id<"financeApplications">,
    fee: { paidBy: "DEALER" | "EMPLOYEE" | "CUSTOMER" | "FINANCE_COMPANY"; currency: string; actualAmountMinor: number }
  ) {
    return await s.t.run((ctx) =>
      ctx.db.insert("financeDealFees", {
        orgId: s.orgId,
        applicationId,
        feeType: "OTHER_CLOSING_EXPENSE",
        currency: fee.currency,
        actualAmountMinor: fee.actualAmountMinor,
        paidBy: fee.paidBy,
        paidTo: "OTHER",
        accountingTreatment: "SELLING_EXPENSE",
        includedInQuotation: false,
        deductedFromSettlement: false,
        refundable: false,
        source: "MANUAL",
        createdBy: s.userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  test("resolving the appraisal gap alone does not increase what the customer PAID — the allocation is served as planned", async () => {
    const s = await seed("20");
    const applicationId = await insertApplication(s);
    const paidBefore = (await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId }))!
      .financialSummary!;
    expect(paidBefore.customerPaidToDealer).toEqual({ heldDepositMinor: 0, totalMinor: 0 });
    expect(paidBefore.customerGapCashPlannedMinor).toBeNull();
    // A gap allocated to the customer, paid to the dealership in cash — exactly
    // what `resolveAppraisalGap` writes, and nothing else: no receipt, no deposit.
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        rawAppraisalGapMinor: 500_000,
        gapResolution: "CUSTOMER_ABSORBS",
        customerGapShareMinor: 500_000,
        customerGapCashToDealerMinor: 500_000,
        customerGapInstallmentToDealerMinor: 0,
        customerGapToFinanceCompanyMinor: 0,
      })
    );
    const after = (await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId }))!
      .financialSummary!;
    expect(after.customerPaidToDealer).toEqual(paidBefore.customerPaidToDealer);
    expect(after.customerGapCashPlannedMinor).toBe(500_000);
    // Nothing served by the overview labels that allocation as received.
    expect(JSON.stringify(after.customerPaidToDealer)).not.toContain("500000");
  });

  test("an UNPLANNED dealer-borne line in another currency withholds recorded, committed and expected outlay and the profit, with the reason", async () => {
    const s = await seed("21");
    const applicationId = await insertApplication(s);
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        companyRuleSnapshot: {
          ruleVersion: 1,
          companyName: "Policy Co",
          feeTemplates: [
            {
              feeType: "LICENSING",
              description: "Plates",
              estimatedAmountMinor: 250_000,
              paidBy: "DEALER",
              paidTo: "GOVERNMENT",
              includedInQuotation: false,
              deductedFromSettlement: false,
              refundable: false,
              accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
            },
          ],
        },
      })
    );
    // A JOD line the cockpit sums, and a USD line it silently leaves out.
    await insertFee(s, applicationId, { paidBy: "DEALER", currency: "JOD", actualAmountMinor: 90_000 });
    await insertFee(s, applicationId, { paidBy: "EMPLOYEE", currency: "USD", actualAmountMinor: 20_000 });
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const outlay = view!.financialSummary!.dealerOutlay;
    expect(outlay).toMatchObject({
      recordedCostsMinor: null,
      recordedCostsReason: "MIXED_DENOMINATION",
      knownCommittedMinor: null,
      expectedCostsRemainingMinor: null,
      expectedCostsReason: "MIXED_DENOMINATION",
      totalExpectedMinor: null,
    });
    expect(outlay.plannedContributionMinor).toBe(1_650_000);
    expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "ExpensesMixedDenomination" });
    // The partial JOD total the cockpit serves is nowhere in the overview's outlay.
    expect(JSON.stringify(outlay)).not.toContain("90000");
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction of a fils", 90_000.5],
    ["a negative amount", -90_000],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])(
    "a SAME-currency dealer-borne line carrying %s (raw, as `v.number()` admits it) withholds the recorded, committed and expected outlay, the checklist's actual and the profit — never a corrupt total",
    async (_label, corrupt) => {
      const s = await seed(`u-${_label}`);
      const applicationId = await insertApplication(s);
      await s.t.run((ctx) =>
        ctx.db.patch(applicationId, {
          companyRuleSnapshot: {
            ruleVersion: 1,
            companyName: "Policy Co",
            feeTemplates: [
              {
                feeType: "LICENSING",
                description: "Plates",
                estimatedAmountMinor: 250_000,
                paidBy: "DEALER",
                paidTo: "GOVERNMENT",
                includedInQuotation: false,
                deductedFromSettlement: false,
                refundable: false,
                accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
              },
            ],
          },
        })
      );
      await insertFee(s, applicationId, { paidBy: "DEALER", currency: "JOD", actualAmountMinor: 90_000 });
      // Bypasses `recordDealFee`, which asserts the amount — the row carries
      // exactly what a legacy write or an admin raw edit would leave in it.
      await insertFee(s, applicationId, { paidBy: "EMPLOYEE", currency: "JOD", actualAmountMinor: corrupt });
      const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      const outlay = view!.financialSummary!.dealerOutlay;
      expect(outlay).toMatchObject({
        plannedContributionMinor: 1_650_000,
        recordedCostsMinor: null,
        recordedCostsReason: "UNSAFE_AMOUNT",
        knownCommittedMinor: null,
        totalExpectedMinor: null,
      });
      expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "ExpensesUnreadable" });
      // The readable line's partial figure is published nowhere in the outlay.
      expect(JSON.stringify(outlay)).not.toContain("90000");

      // The cost list's totals are withheld on the same contract, with the
      // reason, and the checklist compares against no actual.
      const costs = await s.asOwner.query(api.financeDealCosts.listDealCosts, { orgId: s.orgId, applicationId });
      expect(costs.summary).toBeNull();
      expect(costs.summaryUnavailable).toMatchObject({ reason: "UNSAFE_AMOUNT", dealCurrency: "JOD" });
      expect(costs.expected.actualTotalMinor).toBeNull();
      expect(costs.expected.differenceMinor).toBeNull();
    }
  );

  test("a corrupt legacy frozen adminFees value withholds the expected outlay instead of crashing the deal overview", async () => {
    const s = await seed("corrupt-admin-fees");
    const applicationId = await insertApplication(s);
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        companyRuleSnapshot: {
          ruleVersion: 1,
          companyName: "Legacy Finance",
          adminFees: Number.MAX_SAFE_INTEGER,
          feeTemplates: [],
        },
      })
    );

    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, {
      orgId: s.orgId,
      applicationId,
    });

    expect(view).not.toBeNull();
    expect(view!.financialSummary!.dealerOutlay).toMatchObject({
      expectedCostsRemainingMinor: null,
      expectedCostsReason: "UNSAFE_AMOUNT",
      totalExpectedMinor: null,
    });
  });

  test("two safe same-currency actuals that overflow between them are withheld as UNSAFE_AMOUNT, never summed", async () => {
    const s = await seed("u-overflow");
    const applicationId = await insertApplication(s);
    await insertFee(s, applicationId, { paidBy: "DEALER", currency: "JOD", actualAmountMinor: Number.MAX_SAFE_INTEGER - 1 });
    await insertFee(s, applicationId, { paidBy: "DEALER", currency: "JOD", actualAmountMinor: 2 });
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.financialSummary!.dealerOutlay).toMatchObject({
      recordedCostsMinor: null,
      recordedCostsReason: "UNSAFE_AMOUNT",
      knownCommittedMinor: null,
      totalExpectedMinor: null,
    });
    expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "ExpensesUnreadable" });
  });

  test("a CUSTOMER- or financier-borne line in another currency is not the dealership's outlay and withholds nothing", async () => {
    const s = await seed("22");
    const applicationId = await insertApplication(s);
    await insertFee(s, applicationId, { paidBy: "DEALER", currency: "JOD", actualAmountMinor: 90_000 });
    await insertFee(s, applicationId, { paidBy: "CUSTOMER", currency: "USD", actualAmountMinor: 20_000 });
    await insertFee(s, applicationId, { paidBy: "FINANCE_COMPANY", currency: "USD", actualAmountMinor: 30_000 });
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const outlay = view!.financialSummary!.dealerOutlay;
    expect(outlay.recordedCostsMinor).toBe(90_000);
    expect(outlay.recordedCostsReason).toBeNull();
    expect(outlay.knownCommittedMinor).toBe(1_650_000 + 90_000);
    const profit = view!.financialSummary!.profit;
    if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
    expect(profit.lines).toContainEqual({ key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 90_000 });
  });

  test("view:sales alone reads neither the summary nor the cost basis", async () => {
    const s = await seed("4");
    const applicationId = await insertApplication(s);
    const sales = await callerWith(s, "sales", [PERMISSIONS.VIEW_SALES]);
    const view = await sales.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view).toEqual({ financialSummary: null, vehicleCostBasis: null, dealerPreparation: null });
  });

  test("view:finance reads the summary but not the vehicle's cost", async () => {
    const s = await seed("5");
    const applicationId = await insertApplication(s);
    const finance = await callerWith(s, "finance", [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_FINANCE]);
    const view = await finance.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.financialSummary).not.toBeNull();
    expect(view!.vehicleCostBasis).toBeNull();
  });

  test("view:cost_price reads the vehicle's cost but not the deal's economics", async () => {
    const s = await seed("6");
    const applicationId = await insertApplication(s);
    const cost = await callerWith(s, "cost", [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_COST_PRICE]);
    const view = await cost.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.financialSummary).toBeNull();
    expect(view!.vehicleCostBasis?.available).toBe(true);
    // Nothing FINANCE-class leaks through the serialized response.
    const text = JSON.stringify(view);
    expect(text).not.toContain("dealerContribution");
    expect(text).not.toContain("fundedPortion");
    expect(text).not.toContain("11000000");
  });

  describe("expense LINE detail is the expense ledger: view:cost_price serves the totals, view:expenses the rows", () => {
    async function seedSourcedWithLines(suffix: string) {
      const s = await seed(suffix, { sourceType: "SOURCED" });
      // A pre-deal PERIOD_EXPENSE on the supplier's car: a preparation line (100 net).
      await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined });
      const applicationId = await insertApplication(s);
      return { s, applicationId };
    }
    const LINE_FIELDS = ["Brake job", "\"title\"", "\"category\"", "\"date\"", "\"netMinor\"", "\"capitalizedMinor\"", "\"expenses\""];

    test("cost only: the totals, no `expenses` key, no title/category/date/amount anywhere in the payload", async () => {
      const { s, applicationId } = await seedSourcedWithLines("30");
      const cost = await callerWith(s, "cost30", [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_COST_PRICE]);
      const view = await cost.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      const basis = view!.vehicleCostBasis!;
      const prep = view!.dealerPreparation!;
      if (!basis.available || !prep.available) throw new Error("expected available");
      expect(basis.lineDetail).toBe("WITHHELD");
      expect(prep.lineDetail).toBe("WITHHELD");
      expect(basis.totalBeforeDealMinor).toBe(8_000_000);
      expect(prep.totalMinor).toBe(100_000);
      expect(prep.excluded).toEqual({ pendingCount: 0, reversedCount: 0, otherCount: 0, afterCutoffCount: 0 });
      expect("expenses" in basis).toBe(false);
      expect("expenses" in prep).toBe(false);
      const text = JSON.stringify(view);
      for (const field of LINE_FIELDS) expect(text).not.toContain(field);
    });

    test("cost + expenses: the rows are served, and only their own fields", async () => {
      const { s, applicationId } = await seedSourcedWithLines("31");
      const both = await callerWith(s, "both31", [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_COST_PRICE, PERMISSIONS.VIEW_EXPENSES]);
      const view = await both.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      const prep = view!.dealerPreparation!;
      if (!prep.available || prep.lineDetail !== "SERVED") throw new Error("expected served lines");
      expect(prep.expenses).toHaveLength(1);
      expect(prep.expenses[0]).toMatchObject({ title: "Brake job", category: "REPAIR", netMinor: 100_000 });
      expect(Object.keys(prep.expenses[0]).sort()).toEqual(["category", "date", "id", "netMinor", "title"]);
      const basis = view!.vehicleCostBasis!;
      if (!basis.available || basis.lineDetail !== "SERVED") throw new Error("expected served lines");
      expect(basis.expenses).toEqual([]);
    });

    test("view:expenses without view:cost_price reads no cost figure at all — lines are not a back door to the basis", async () => {
      const { s, applicationId } = await seedSourcedWithLines("32");
      const expensesOnly = await callerWith(s, "exp32", [PERMISSIONS.VIEW_SALES, PERMISSIONS.VIEW_EXPENSES]);
      const view = await expensesOnly.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      expect(view!.vehicleCostBasis).toBeNull();
      expect(view!.dealerPreparation).toBeNull();
    });

    test("the system owner reads the rows without either permission being enumerated", async () => {
      const { s, applicationId } = await seedSourcedWithLines("33");
      const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
      expect(view!.dealerPreparation).toMatchObject({ available: true, lineDetail: "SERVED" });
      expect(view!.vehicleCostBasis).toMatchObject({ available: true, lineDetail: "SERVED" });
    });
  });

  test("a caller without view:sales is refused outright", async () => {
    const s = await seed("7");
    const applicationId = await insertApplication(s);
    const nobody = await callerWith(s, "nobody", [PERMISSIONS.VIEW_FINANCE]);
    await expect(
      nobody.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId })
    ).rejects.toThrow();
  });

  // --- tenancy ---------------------------------------------------------------

  test("an application belonging to another org returns null, as the cockpit does", async () => {
    const s = await seed("8");
    const foreignApplicationId = await insertApplication(s, s.otherOrgId);
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, {
      orgId: s.orgId,
      applicationId: foreignApplicationId,
    });
    expect(view).toBeNull();
  });

  test("a member of another org cannot read this org's deal", async () => {
    const s = await seed("9");
    const applicationId = await insertApplication(s);
    const outsiderId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "do_outsider", email: "do.outsider@example.com", name: "Outsider" })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: s.otherOrgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.otherOrgId, userId: outsiderId, roleId }));
    const outsider = s.t.withIdentity({ subject: "do_outsider" });
    await expect(
      outsider.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId })
    ).rejects.toThrow();
  });

  test("an empty deal — no economics, no expenses — is nulls with reasons, never zeros", async () => {
    const s = await seed("10");
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status: "PENDING_DOCS",
        createdAt: DEAL_CREATED_AT,
        updatedAt: DEAL_CREATED_AT,
      })
    );
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const summary = view!.financialSummary!;
    expect(summary.customerSalePrice).toBeNull();
    expect(summary.approvedPurchaseAmountMinor).toBeNull();
    expect(summary.financier.fundedPortionMinor).toBeNull();
    expect(summary.dealerOutlay.plannedContributionMinor).toBeNull();
    expect(summary.dealerOutlay.totalExpectedMinor).toBeNull();
    expect(summary.profit.available).toBe(false);
  });
});
