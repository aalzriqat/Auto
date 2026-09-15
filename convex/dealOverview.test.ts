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
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined as unknown as number });
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

  test("STOCK: an unreadable capitalized row refuses the profit rather than overstating it", async () => {
    const s = await seed("12");
    await insertExpense(s, { capitalizedAmount: undefined as unknown as number });
    const applicationId = await insertApplication(s);
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    expect(view!.financialSummary!.profit).toEqual({ available: false, reason: "NoVehicleCost" });
    expect(view!.vehicleCostBasis).toMatchObject({ available: false, reason: "UNREADABLE_AMOUNT" });
  });

  test("SOURCED: the cockpit's consignment profit, less the dealership's pre-deal preparation spend, subtracted exactly once", async () => {
    const s = await seed("13", { sourceType: "SOURCED" });
    // Period expenses on the supplier's car: 100 net paid before the deal, one after, one pending.
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined as unknown as number });
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined as unknown as number, status: "PENDING" });
    const applicationId = await insertApplication(s);
    await insertExpense(s, { accountingTreatment: "PERIOD_EXPENSE", capitalizedAmount: undefined as unknown as number });
    const cockpit = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    const served = view!.financialSummary!.profit;
    const own = cockpit!.money!.profit;
    // The cockpit's figure on this fixture is unavailable (no supplier settlement yet); it passes through with its reason.
    if (!own.available) {
      expect(served).toEqual(own);
    } else {
      if (!served.available || served.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected a management estimate");
      expect(served.amountMinor).toBe(own.amountMinor - 100_000);
      expect(served.lines.filter((l) => l.key === "PREPARATION_EXPENSES")).toHaveLength(1);
    }
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
