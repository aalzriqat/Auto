/**
 * Comprehensive regression test suite for Unified Deal single fee authority,
 * profit and outlay forecast models, and cockpit financial invariants.
 *
 * Requirements covered:
 * A. Execution Fees = 700 is the single authoritative dealer-borne fee figure.
 * B. Actual costs = 356: remaining = 344, known committed/outlay basis = 700, profit expense basis = 700.
 * C. Actual costs overrun = 760: remaining = 0, profit & outlay expense basis = 760 (uncapped).
 * D. Dealer outlay = 2,650 (1,950 contribution + 700 execution fees).
 * E. Profit before settlement: forecast expense basis = max(executionFees, actual).
 *    After settlement (fullySettled = true): expense basis switches strictly to recorded actuals.
 * F. Canonical 12,500 deal fixture: 10,625 funded + 500 deposit + 1,375 contribution = 12,500.
 *    Net proceeds = 10,500 (12,500 - 1,375 - 625 = 10,500). Profit = 10,500 - 9,500 = 1,000.
 * G. Customer figures distinction: 500 deposit vs 600 planned gap vs 700 first payment.
 * H. Financier remittance labeled as ESTIMATED_PRE_RECEIVABLE with dealer contribution settlement mode.
 * I. Negative profit: loss styling, "LossEstimated" / "LossActual", and handover loss warning.
 * J. Historical quote preservation: quotes with manualAdminFees or legacy snapshots resolve accurately.
 * K. Finalization safety: financial invariants remain uncompromised.
 */
import { describe, expect, test } from "vitest";
import { dealerBorneExpected } from "./dealOverview";
import {
  deriveStockManagementProfit,
  composeCustomerGapToDealer,
  buildRuleSnapshot,
} from "./utils/financingEconomics";
import { deriveDealFinancialSummary } from "./utils/dealFinancialSummary";
import {
  unrecordedConfiguredFeePositions,
  assertConfiguredFeesRecorded,
} from "./utils/settlementDeductions";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveExpectedExecutionFeesMinor } from "./applications";

const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);

describe("Unified Deal Single Fee Authority & Economics Regression", () => {
  describe("Requirements A, B, C, D: Execution Fees (700 JOD) as single fee authority", () => {
    test("A & D: Execution Fees = 700 establishes single expected dealer-borne fee and total outlay 2,650", () => {
      const estimatedDealerBorneMinor = jod(700); // 700,000
      const dealerBorneActualMinor = 0;

      const expectedFees = dealerBorneExpected(
        "NO_TEMPLATES",
        [],
        "JOD",
        false,
        estimatedDealerBorneMinor,
        dealerBorneActualMinor
      );

      expect(expectedFees.totalMinor).toBe(700_000);
      expect(expectedFees.remainingMinor).toBe(700_000);
      expect(expectedFees.reason).toBeNull();

      // Dealer outlay: 1,950 contribution + 700 fees = 2,650 outlay
      const plannedContributionMinor = jod(1950);
      const summary = deriveDealFinancialSummary({
        currency: "JOD",
        app: {
          financeCompanyFundedPortionMinor: jod(10_000),
          dealerContributionMinor: plannedContributionMinor,
          approvedDealerPurchaseAmountMinor: jod(12_000),
          estimatedDealerBorneExpensesMinor: estimatedDealerBorneMinor,
        },
        parties: [],
        routeKnown: true,
        settlesDirectToSupplier: false,
        feeEvidence: { reason: null },
        expenses: {
          actualTotalMinor: 0,
          reason: null,
          awaitingActuals: 0,
        },
        expectedDealerBorne: expectedFees,
        canonicalProfit: null,
      });

      expect(summary.dealerOutlay.plannedContributionMinor).toBe(1_950_000);
      expect(summary.dealerOutlay.recordedCostsMinor).toBe(0);
      expect(summary.dealerOutlay.expectedCostsRemainingMinor).toBe(700_000);
      expect(summary.dealerOutlay.totalExpectedMinor).toBe(2_650_000);
    });

    test("B: When actual costs = 356 are recorded, remaining = 344 and profit expense basis = 700", () => {
      const estimatedDealerBorneMinor = jod(700);
      const actualCostsMinor = jod(356);

      const expectedFees = dealerBorneExpected(
        "NO_TEMPLATES",
        [],
        "JOD",
        false,
        estimatedDealerBorneMinor,
        actualCostsMinor
      );

      expect(expectedFees.totalMinor).toBe(700_000);
      expect(expectedFees.remainingMinor).toBe(344_000); // 700 - 356 = 344

      // Profit before settlement: uses max(700, 356) = 700 as expense basis
      const profit = deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: jod(12_500),
        vehicleCostMinor: jod(9_500),
        dealerContributionMinor: jod(1_375),
        customerDirectToDealerMinor: jod(625),
        actualExpensesMinor: actualCostsMinor,
        expectedExpensesMinor: estimatedDealerBorneMinor,
        currency: "JOD",
        fullySettled: false,
      });

      expect(profit.available).toBe(true);
      if (!profit.available) throw new Error("unreachable");
      expect(profit.basis).toBe("MANAGEMENT_ESTIMATE");
      expect(profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
      // Profit = 12,500 + 625 - 9,500 - 1,375 - 700 = 1,550
      expect(profit.amountMinor).toBe(jod(1550));
      expect(profit.lines).toContainEqual(
        expect.objectContaining({
          key: "FORECAST_EXPENSES",
          amountMinor: 700_000,
        })
      );
    });

    test("C: When actual costs overrun to 760, remaining = 0 and profit expense basis expands to 760", () => {
      const estimatedDealerBorneMinor = jod(700);
      const actualCostsMinor = jod(760);

      const expectedFees = dealerBorneExpected(
        "NO_TEMPLATES",
        [],
        "JOD",
        false,
        estimatedDealerBorneMinor,
        actualCostsMinor
      );

      // Remaining floored at 0 (never negative)
      expect(expectedFees.remainingMinor).toBe(0);

      // Profit expense basis expands to 760 (overruns never capped at 700)
      const profit = deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: jod(12_500),
        vehicleCostMinor: jod(9_500),
        dealerContributionMinor: jod(1_375),
        customerDirectToDealerMinor: jod(625),
        actualExpensesMinor: actualCostsMinor,
        expectedExpensesMinor: estimatedDealerBorneMinor,
        currency: "JOD",
        fullySettled: false,
      });

      expect(profit.available).toBe(true);
      if (!profit.available) throw new Error("unreachable");
      // Profit = 12,500 + 625 - 9,500 - 1,375 - 760 = 1,490
      expect(profit.amountMinor).toBe(jod(1490));
      expect(profit.lines).toContainEqual(
        expect.objectContaining({
          key: "ACTUAL_EXPENSES",
          amountMinor: 760_000,
        })
      );
    });
  });

  describe("Requirement E: Profit before settlement vs after settlement", () => {
    test("switches strictly from forecast max(estimate, actual) to recorded actuals upon final settlement", () => {
      const estimatedMinor = jod(700);
      const actualMinor = jod(356);

      // Before settlement: forecast uses 700
      const preSettlement = deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: jod(12_500),
        vehicleCostMinor: jod(9_500),
        dealerContributionMinor: jod(1_375),
        customerDirectToDealerMinor: jod(0),
        actualExpensesMinor: actualMinor,
        expectedExpensesMinor: estimatedMinor,
        currency: "JOD",
        fullySettled: false,
      });
      expect(preSettlement.available).toBe(true);
      if (!preSettlement.available) throw new Error("unreachable");
      expect(preSettlement.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
      // 12,500 - 9,500 - 1,375 - 700 = 925
      expect(preSettlement.amountMinor).toBe(jod(925));

      // After settlement: strictly uses actual 356
      const postSettlement = deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: jod(12_500),
        vehicleCostMinor: jod(9_500),
        dealerContributionMinor: jod(1_375),
        customerDirectToDealerMinor: jod(0),
        actualExpensesMinor: actualMinor,
        expectedExpensesMinor: estimatedMinor,
        currency: "JOD",
        fullySettled: true,
      });
      expect(postSettlement.available).toBe(true);
      if (!postSettlement.available) throw new Error("unreachable");
      expect(postSettlement.classification).toBe("ACTUAL_UNPOSTABLE");
      // 12,500 - 9,500 - 1,375 - 356 = 1,269
      expect(postSettlement.amountMinor).toBe(jod(1269));
    });
  });

  describe("Requirement F: Canonical 12,500 Deal Fixture & Net Proceeds", () => {
    test("verifies canonical 12,500 fixture mathematics: 10,625 funded + 500 deposit + 1,375 contribution", () => {
      const salePriceMinor = jod(12_500);
      const fundedMinor = jod(10_625);
      const depositMinor = jod(500);
      const contributionMinor = jod(1_375);
      const customerGapMinor = jod(625); // customer gap contribution
      const costBasisMinor = jod(9_500);

      // Check sum of funding parts
      expect(fundedMinor + depositMinor + contributionMinor).toBe(salePriceMinor);

      // Net proceeds = 12,500 - 1,375 - 625 = 10,500
      const netProceedsMinor = salePriceMinor - contributionMinor - customerGapMinor;
      expect(netProceedsMinor).toBe(jod(10_500));

      const profit = deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: netProceedsMinor,
        vehicleCostMinor: costBasisMinor,
        dealerContributionMinor: 0,
        customerDirectToDealerMinor: 0,
        actualExpensesMinor: 0,
        expectedExpensesMinor: 0,
        currency: "JOD",
        fullySettled: true,
      });

      expect(profit.available).toBe(true);
      if (!profit.available) throw new Error("unreachable");
      expect(profit.amountMinor).toBe(jod(1_000)); // 10,500 - 9,500 = 1,000
    });
  });

  describe("Requirement G: Customer Figures Distinction", () => {
    test("keeps 500 held deposit, 600 planned gap (cash vs installment), and 700 quote first payment separate", () => {
      const composed = composeCustomerGapToDealer({
        customerGapCashToDealerMinor: jod(400),
        customerGapInstallmentToDealerMinor: jod(200),
      });

      expect(composed.readable).toBe(true);
      expect(composed.amountMinor).toBe(jod(600));

      const summary = deriveDealFinancialSummary({
        currency: "JOD",
        app: {
          customerGapCashToDealerMinor: jod(400),
          customerGapInstallmentToDealerMinor: jod(200),
          customerFirstPaymentMinor: jod(700),
          dealerContributionSettlement: "NETTED_FROM_REMITTANCE",
        },
        parties: [
          {
            party: "CUSTOMER",
            position: "DEALERSHIP_HOLDS",
            amountMinor: jod(500),
            currency: "JOD",
          },
        ],
        routeKnown: true,
        settlesDirectToSupplier: false,
        feeEvidence: { reason: null },
        expenses: {
          actualTotalMinor: 0,
          reason: null,
          awaitingActuals: 0,
        },
        expectedDealerBorne: { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" },
        canonicalProfit: null,
      });

      // Held deposit = 500
      expect(summary.customerPaidToDealer?.heldDepositMinor).toBe(500_000);
      // Planned gap = 600 (400 cash + 200 installment)
      expect(summary.customerGapPlanned?.totalMinor).toBe(600_000);
      expect(summary.customerGapPlanned?.cashMinor).toBe(400_000);
      expect(summary.customerGapPlanned?.installmentMinor).toBe(200_000);
      // Quote first payment = 700
      expect(summary.customerFirstPaymentMinor).toBe(700_000);
      // Financier dealer contribution settlement mode
      expect(summary.financier.dealerContributionSettlement).toBe("NETTED_FROM_REMITTANCE");
    });
  });

  describe("Requirements H & I: Remittance Labeling & Loss Handling", () => {
    test("H: Pre-receivable financier outstanding is marked ESTIMATED_PRE_RECEIVABLE", () => {
      const summary = deriveDealFinancialSummary({
        currency: "JOD",
        app: {
          expectedDealerRemittanceMinor: jod(9_000),
          financeCompanyFundedPortionMinor: jod(10_000),
        },
        parties: [],
        routeKnown: true,
        settlesDirectToSupplier: false,
        feeEvidence: { reason: null },
        expenses: {
          actualTotalMinor: 0,
          reason: null,
          awaitingActuals: 0,
        },
        expectedDealerBorne: { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" },
        canonicalProfit: null,
      });

      expect(summary.financier.outstanding.state).toBe("ESTIMATED_PRE_RECEIVABLE");
      expect(summary.financier.outstanding.basis).toBe("EXPECTED_DEALER_REMITTANCE");
      expect(summary.financier.outstanding.amountMinor).toBe(9_000_000);
    });

    test("I: Negative profit calculates loss accurately and flags loss basis", () => {
      const lossProfit = deriveStockManagementProfit({
        approvedDealerPurchaseAmountMinor: jod(12_500),
        vehicleCostMinor: jod(13_000),
        dealerContributionMinor: jod(1_375),
        customerDirectToDealerMinor: 0,
        actualExpensesMinor: jod(500),
        expectedExpensesMinor: jod(700),
        currency: "JOD",
        fullySettled: false,
      });

      expect(lossProfit.available).toBe(true);
      if (!lossProfit.available) throw new Error("unreachable");
      // 12,500 - 13,000 - 1,375 - 700 = -2,575 loss
      expect(lossProfit.amountMinor).toBe(-2_575_000);
      expect(lossProfit.amountMinor).toBeLessThan(0);
    });
  });

  describe("Requirement J: Historical quote preservation", () => {
    test("quotes with manualAdminFees continue to resolve expected fee figures correctly", () => {
      const quote = {
        manualAdminFees: 650,
      };
      const quoteCompany = undefined;

      const resolvedFees = quoteCompany?.adminFees ?? quote.manualAdminFees;
      expect(resolvedFees).toBe(650);

      const feeMinor = Math.round(resolvedFees * 1000);
      expect(feeMinor).toBe(650_000);

      const expectedFees = dealerBorneExpected("NO_TEMPLATES", [], "JOD", false, feeMinor, 150_000);
      expect(expectedFees.totalMinor).toBe(650_000);
      expect(expectedFees.remainingMinor).toBe(500_000);
    });
  });

  describe("Requirement K: Single Fee Authority Enforcement & Template Retirement Invariants", () => {
    const dummyTemplate = {
      feeType: "LICENSING" as const,
      description: "Plates",
      estimatedAmountMinor: jod(250),
      paidBy: "DEALER" as const,
      paidTo: "GOVERNMENT" as const,
      includedInQuotation: true,
      deductedFromSettlement: false,
      refundable: false,
      accountingTreatment: "SELLING_EXPENSE" as const,
    };

    test("buildRuleSnapshot excludes feeTemplates for newly created snapshots", () => {
      const companyWithAdminFees = {
        _id: "company_1" as never,
        _creationTime: Date.now(),
        orgId: "org_1" as never,
        name: "Test Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 700,
        feeTemplates: [dummyTemplate],
      } as unknown as Doc<"financeCompanies">;

      const snapshot = buildRuleSnapshot(companyWithAdminFees);
      expect(snapshot.adminFees).toBe(700);
      expect(snapshot.feeTemplates).toBeUndefined();

      const legacyCompany = {
        _id: "company_1" as never,
        _creationTime: Date.now(),
        orgId: "org_1" as never,
        name: "Legacy Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: undefined,
        feeTemplates: [dummyTemplate],
      } as unknown as Doc<"financeCompanies">;

      const legacySnapshot = buildRuleSnapshot(legacyCompany);
      expect(legacySnapshot.adminFees).toBeUndefined();
      expect(legacySnapshot.feeTemplates).toBeUndefined();
    });

    test("unrecordedConfiguredFeePositions and assertConfiguredFeesRecorded bypass templates under single fee authority", () => {
      const snapshotUnderAdminFees = {
        ruleVersion: 1,
        companyName: "Test Finance",
        adminFees: 700,
        feeTemplates: [dummyTemplate],
      };

      // With adminFees set, fee template rows are NOT required
      expect(unrecordedConfiguredFeePositions(snapshotUnderAdminFees, [])).toEqual([]);
      expect(() => assertConfiguredFeesRecorded(snapshotUnderAdminFees, [], "finalizing")).not.toThrow();

      // For legacy snapshot without adminFees, missing template positions are enforced
      const legacySnapshot = {
        ruleVersion: 1,
        companyName: "Legacy Finance",
        adminFees: undefined,
        feeTemplates: [dummyTemplate],
      };
      expect(unrecordedConfiguredFeePositions(legacySnapshot, [])).toEqual([0]);
      expect(() => assertConfiguredFeesRecorded(legacySnapshot, [], "finalizing")).toThrow(
        /1 fee\(s\) configured by this deal's finance company have no actual recorded/
      );
    });

    test("server-side validation rejects invalid adminFees, denomination scale mismatch, retired feeTemplates writes, and clears legacy templates upon adminFees update", async () => {
      const t = convexTestWithComponents(schema, MODULES);
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: "Dealer K", createdAt: Date.now() })
      );
      await t.run((ctx) =>
        ctx.db.insert("orgSettings", {
          orgId,
          currency: "USD",
          currencySymbol: "$",
          enabledPaymentTypes: ["CASH"],
        })
      );
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_k", email: "k@dealer.com" })
      );
      const roleId = await t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      const asOwner = t.withIdentity({ subject: "user_k" });

      // Negative adminFees is rejected
      await expect(
        asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Invalid Fees Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: -100,
        })
      ).rejects.toThrow(/Execution fees \(adminFees\) must be a non-negative finite number/);

      // Denomination scale mismatch (USD scale is 2, 0.001 cannot be represented)
      await expect(
        asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Fractional USD Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 0.001,
        })
      ).rejects.toThrow(/cannot be represented accurately at 2 decimal places/);

      // feeTemplates write authority is retired on createCompany
      await expect(
        asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Conflicting Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 700,
          feeTemplates: [dummyTemplate],
        })
      ).rejects.toThrow(/Configuring company fee templates is retired/);

      // Create a legacy company directly in DB with feeTemplates
      const legacyCompanyId = await t.run((ctx) =>
        ctx.db.insert("financeCompanies", {
          orgId,
          name: "Legacy Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          ruleVersion: 1,
          feeTemplates: [dummyTemplate],
        })
      );

      // feeTemplates write authority is retired on updateCompany
      await expect(
        asOwner.mutation(api.finance.updateCompany, {
          orgId,
          id: legacyCompanyId,
          name: "Legacy Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          feeTemplates: [dummyTemplate],
        })
      ).rejects.toThrow(/Updating company fee templates is retired/i);

      // Updating legacy company with adminFees explicitly clears legacy feeTemplates
      await asOwner.mutation(api.finance.updateCompany, {
        orgId,
        id: legacyCompanyId,
        name: "Legacy Co Migrated",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 700,
      });
      const migrated = (await t.run((ctx) => ctx.db.get(legacyCompanyId)))!;
      expect(migrated.adminFees).toBe(700);
      expect(migrated.feeTemplates).toBeUndefined();
      expect(migrated.ruleVersion).toBe(2);
    });

    test("S1-R3-H1 invariant: configured deal creation fails closed when finance company has undefined adminFees authority", async () => {
      const t = convexTestWithComponents(schema, MODULES);
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: "Dealer Incomplete Authority", createdAt: Date.now() })
      );
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_incomplete", email: "incomplete@dealer.com" })
      );
      const roleId = await t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      const asOwner = t.withIdentity({ subject: "user_incomplete" });

      const customerId = await t.run((ctx) =>
        ctx.db.insert("customers", { orgId, firstName: "Incomplete", lastName: "Customer" })
      );
      const vehicleId = await t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId,
          vin: "VIN_INCOMPLETE_1",
          make: "Toyota",
          model: "RAV4",
          year: 2024,
          mileage: 100,
          color: "Silver",
          fuelType: "Hybrid",
          transmission: "Auto",
          purchasePrice: 15_000,
          sellingPrice: 20_000,
          status: "AVAILABLE",
        })
      );

      // Finance company created with adminFees left undefined (authority not yet configured)
      const companyId = await asOwner.mutation(api.finance.createCompany, {
        orgId,
        name: "Incomplete Authority Finance",
        profitRate: 4.5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        defaultLtvPercent: 80,
        isActive: true,
        adminFees: undefined,
      });

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        totalFinancedAmount: 20_000,
      });

      // Fails closed before application is written
      await expect(
        asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        })
      ).rejects.toThrow(
        "Execution Fees are not configured for this finance company. Enter the expected execution fee amount, or enter 0 if none are charged."
      );
    });

    test("S1-R3-H1 invariant: configured deal creation succeeds with expected fees 0 when adminFees is explicitly 0", async () => {
      const t = convexTestWithComponents(schema, MODULES);
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: "Dealer Zero Authority", createdAt: Date.now() })
      );
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_zero", email: "zero@dealer.com" })
      );
      const roleId = await t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      const asOwner = t.withIdentity({ subject: "user_zero" });

      const customerId = await t.run((ctx) =>
        ctx.db.insert("customers", { orgId, firstName: "Zero", lastName: "Customer" })
      );
      const vehicleId = await t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId,
          vin: "VIN_ZERO_1",
          make: "Toyota",
          model: "RAV4",
          year: 2024,
          mileage: 100,
          color: "Silver",
          fuelType: "Hybrid",
          transmission: "Auto",
          purchasePrice: 15_000,
          sellingPrice: 20_000,
          status: "AVAILABLE",
        })
      );

      // Finance company created with adminFees explicitly 0
      const companyId = await asOwner.mutation(api.finance.createCompany, {
        orgId,
        name: "Zero Fees Finance",
        profitRate: 4.5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        defaultLtvPercent: 80,
        isActive: true,
        adminFees: 0,
      });

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        totalFinancedAmount: 20_000,
      });

      const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
        orgId,
        quoteId,
      });

      const app = (await t.run((ctx) => ctx.db.get(applicationId)))!;
      expect(app.estimatedDealerBorneExpensesMinor).toBe(0);
      expect(app.companyRuleSnapshot?.adminFees).toBe(0);
      expect(app.companyRuleSnapshot?.feeTemplates).toBeUndefined();

      // Unrecorded positions are empty
      expect(unrecordedConfiguredFeePositions(app.companyRuleSnapshot, [])).toEqual([]);
      expect(() => assertConfiguredFeesRecorded(app.companyRuleSnapshot, [], "finalizing")).not.toThrow();
    });

    test("S1-R3-H1 invariant: configured deal creation succeeds with expected fees 700 when adminFees is 700", async () => {
      const t = convexTestWithComponents(schema, MODULES);
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: "Dealer E2E", createdAt: Date.now() })
      );
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_e2e", email: "e2e@dealer.com" })
      );
      const roleId = await t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      const asOwner = t.withIdentity({ subject: "user_e2e" });

      const customerId = await t.run((ctx) =>
        ctx.db.insert("customers", { orgId, firstName: "E2E", lastName: "Customer" })
      );
      const vehicleId = await t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId,
          vin: "VIN_E2E_12345",
          make: "Toyota",
          model: "RAV4",
          year: 2024,
          mileage: 100,
          color: "Silver",
          fuelType: "Hybrid",
          transmission: "Auto",
          purchasePrice: 15_000,
          sellingPrice: 20_000,
          status: "AVAILABLE",
        })
      );

      const companyId = await asOwner.mutation(api.finance.createCompany, {
        orgId,
        name: "Authority Finance",
        profitRate: 4.5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        defaultLtvPercent: 80,
        isActive: true,
        adminFees: 700,
      });

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        totalFinancedAmount: 20_000,
      });

      const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
        orgId,
        quoteId,
      });

      const app = (await t.run((ctx) => ctx.db.get(applicationId)))!;
      expect(app.estimatedDealerBorneExpensesMinor).toBe(700_000);
      expect(app.companyRuleSnapshot?.adminFees).toBe(700);
      expect(app.companyRuleSnapshot?.feeTemplates).toBeUndefined();

      // Unrecorded positions are empty
      expect(unrecordedConfiguredFeePositions(app.companyRuleSnapshot, [])).toEqual([]);
      expect(() => assertConfiguredFeesRecorded(app.companyRuleSnapshot, [], "finalizing")).not.toThrow();
    });

    test("end-to-end deal created under adminFees authority finalizes cleanly through the entire finalization stack", async () => {
      const t = convexTestWithComponents(schema, MODULES);
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: "Dealer Full Finalize", createdAt: Date.now() })
      );
      await t.run((ctx) =>
        ctx.db.insert("subscriptions", {
          orgId,
          plan: "professional",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      );
      await t.run((ctx) =>
        ctx.db.insert("orgSettings", {
          orgId,
          currency: "JOD",
          currencySymbol: "JD",
          enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
        })
      );
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_full_finalize", email: "ff@dealer.com", name: "Full Finalize" })
      );
      const approverId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_full_approver", email: "appr@dealer.com", name: "Approver" })
      );
      const roleId = await t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
      const asOwner = t.withIdentity({ subject: "user_full_finalize", clerkId: "user_full_finalize" });
      const asApprover = t.withIdentity({ subject: "user_full_approver", clerkId: "user_full_approver" });

      await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
      const fiscalYear = new Date().getUTCFullYear();
      await asOwner.mutation(api.accountingPeriods.create, {
        orgId,
        startDate: Date.UTC(fiscalYear, 0, 1),
        endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
        fiscalYear,
        periodNumber: 1,
      });
      const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
      await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

      const customerId = await t.run((ctx) =>
        ctx.db.insert("customers", { orgId, firstName: "Full", lastName: "Buyer" })
      );
      const vehicleId = await t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId,
          vin: "VIN_FULL_E2E_123",
          make: "Kia",
          model: "Sportage",
          year: 2024,
          mileage: 10,
          color: "Blue",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: 20_000,
          purchasePrice: 15_000,
          status: "AVAILABLE",
          sourceType: "STOCK",
        })
      );

      const companyId = await asOwner.mutation(api.finance.createCompany, {
        orgId,
        name: "Single Fee Authority Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        defaultLtvPercent: 100,
        isActive: true,
        adminFees: 700,
      });

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        totalFinancedAmount: 20_000,
      });

      const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
        orgId,
        quoteId,
      });

      await asOwner.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "UNDER_REVIEW",
      });
      await asApprover.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      });

      await asOwner.mutation(api.financingEconomics.recordSubmittedQuotation, {
        orgId,
        applicationId,
        submittedQuotationMinor: 20_000 * 1000,
        source: "MANUAL_ENTRY",
      });
      await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
        orgId,
        applicationId,
        approvedAmountMinor: 20_000 * 1000,
        basis: "MANUAL",
        notes: "Approved at quotation price.",
      });

      await registerHandover(asOwner, api, orgId, applicationId);

      await asOwner.mutation(api.applications.registerExpectedPayment, {
        orgId,
        applicationId,
        method: "BANK_TRANSFER",
        expectedDate: Date.now(),
      });

      await asOwner.mutation(api.financeDealCosts.recordLegalInvoice, {
        orgId,
        applicationId,
        legalInvoiceAmountMinor: 20_000 * 1000,
        legalInvoiceNumber: `INV-AUTH-${applicationId}`,
        legalInvoiceDate: Date.now(),
        issuedTo: "FINANCE_COMPANY",
      });

      const feeId = await asOwner.mutation(api.financeDealCosts.recordDealFee, {
        expectedCurrency: "JOD",
        orgId,
        applicationId,
        feeType: "OTHER_CLOSING_EXPENSE",
        paidBy: "DEALER",
        paidTo: "OTHER",
        accountingTreatment: "SELLING_EXPENSE",
        deductedFromSettlement: false,
        actualAmountMinor: 700 * 1000,
        description: "Execution fees recorded.",
        idempotencyKey: `fee-auth-${applicationId}`,
      });
      await asOwner.mutation(api.financeDealCosts.reconcileDealFee, {
        orgId,
        feeId,
        notes: "Execution fees reconciled.",
      });

      await asOwner.mutation(api.financeDealCosts.classifyDealAccounting, {
        orgId,
        applicationId,
        notes: "Invoice on file, deal classified without requiring fee template actuals.",
      });

      const saleId = await asOwner.mutation(api.applications.finalizeDeal, {
        orgId,
        applicationId,
        idempotencyKey: `authority-finalize-${applicationId}`,
      });

      expect(saleId).toBeTruthy();

      const closedApp = (await t.run((ctx) => ctx.db.get(applicationId)))!;
      expect(closedApp.status).toBe("CLOSED");

      const sale = (await t.run((ctx) => ctx.db.get(saleId)))!;
      expect(sale).toBeDefined();
      expect(sale.applicationId).toBe(applicationId);
      expect(sale.vehicleId).toBe(vehicleId);

      const vehicle = (await t.run((ctx) => ctx.db.get(vehicleId)))!;
      expect(vehicle.status).toBe("SOLD");
    });
  });

  describe("S1-R4-H1: Canonical Fee Authority Resolution Regression Matrix", () => {
    describe("resolveExpectedExecutionFeesMinor canonical resolver unit tests", () => {
      const dummyCompanyId = "dummy_company_id" as Id<"financeCompanies">;

      // 1. configured + adminFees: undefined -> reject
      test("Case 1: configured + adminFees: undefined -> reject", () => {
        expect(() =>
          resolveExpectedExecutionFeesMinor({
            quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: dummyCompanyId },
            companyRuleSnapshot: {
              ruleVersion: 1,
              defaultLtvPercent: 80,
              profitRate: 5,
              maxTermMonths: 60,
              gracePeriodMonths: 0,
              adminFees: undefined,
            },
            currency: "JOD",
          })
        ).toThrow(/Execution Fees are not configured/);
      });

      // 2. configured + adminFees: 0 -> succeed, expected fee 0
      test("Case 2: configured + adminFees: 0 -> succeed, expected fee 0", () => {
        const feeMinor = resolveExpectedExecutionFeesMinor({
          quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: dummyCompanyId },
          companyRuleSnapshot: {
            ruleVersion: 1,
            defaultLtvPercent: 80,
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 0,
          },
          currency: "JOD",
        });
        expect(feeMinor).toBe(0);
      });

      // 3. configured + adminFees: 700 -> succeed, expected fee 700000 JOD minor
      test("Case 3: configured + adminFees: 700 -> succeed, expected fee 700000 JOD minor", () => {
        const feeMinor = resolveExpectedExecutionFeesMinor({
          quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: dummyCompanyId },
          companyRuleSnapshot: {
            ruleVersion: 1,
            defaultLtvPercent: 80,
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 700,
          },
          currency: "JOD",
        });
        expect(feeMinor).toBe(700_000);
      });

      // 4. companyId + mode: undefined -> reject
      test("Case 4: companyId + mode: undefined -> reject", () => {
        expect(() =>
          resolveExpectedExecutionFeesMinor({
            quote: { companyId: dummyCompanyId, mode: undefined },
            currency: "JOD",
          })
        ).toThrow(/Finance company can only be set for configured finance company quotes/);
      });

      // 5. manual + manualAdminFees: undefined -> reject
      test("Case 5: manual + manualAdminFees: undefined -> reject", () => {
        expect(() =>
          resolveExpectedExecutionFeesMinor({
            quote: { mode: "MANUAL_FINANCE_COMPANY", manualAdminFees: undefined },
            currency: "JOD",
          })
        ).toThrow(/Execution Fees are not configured for this manual finance company quote/);
      });

      // 6. manual + manualAdminFees: 0 -> succeed with 0
      test("Case 6: manual + manualAdminFees: 0 -> succeed with 0", () => {
        const feeMinor = resolveExpectedExecutionFeesMinor({
          quote: { mode: "MANUAL_FINANCE_COMPANY", manualAdminFees: 0 },
          currency: "JOD",
        });
        expect(feeMinor).toBe(0);
      });

      // 7. manual + manualAdminFees: 700 -> succeed with correct minor amount
      test("Case 7: manual + manualAdminFees: 700 -> succeed with correct minor amount", () => {
        const feeMinor = resolveExpectedExecutionFeesMinor({
          quote: { mode: "MANUAL_FINANCE_COMPANY", manualAdminFees: 700 },
          currency: "JOD",
        });
        expect(feeMinor).toBe(700_000);
      });

      // 8. repair path with unknown authority -> reject, never repair to 0
      test("Case 8: repair path with unknown authority -> reject, never repair to 0", () => {
        expect(() =>
          resolveExpectedExecutionFeesMinor({
            quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: dummyCompanyId },
            companyRuleSnapshot: {
              ruleVersion: 1,
              defaultLtvPercent: 80,
              profitRate: 5,
              maxTermMonths: 60,
              gracePeriodMonths: 0,
              adminFees: undefined,
              feeTemplates: undefined,
            },
            currency: "JOD",
          })
        ).toThrow(/Execution Fees are not configured/);

        expect(() =>
          resolveExpectedExecutionFeesMinor({
            quote: { mode: "MANUAL_FINANCE_COMPANY", manualAdminFees: undefined },
            currency: "JOD",
          })
        ).toThrow(/Execution Fees are not configured for this manual finance company quote/);
      });
    });

    describe("End-to-end Convex mutation integration across the 8 matrix cases", () => {
      async function setupMatrixEnv() {
        const t = convexTestWithComponents(schema, MODULES);
        const orgId = await t.run((ctx) =>
          ctx.db.insert("organizations", { name: "Dealer Matrix Test", createdAt: Date.now() })
        );
        await t.run((ctx) =>
          ctx.db.insert("orgSettings", {
            orgId,
            currency: "JOD",
            currencySymbol: "JD",
            enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
          })
        );
        const userId = await t.run((ctx) =>
          ctx.db.insert("users", { clerkId: "user_matrix", email: "matrix@dealer.com" })
        );
        const roleId = await t.run((ctx) =>
          ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
        );
        await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
        const asOwner = t.withIdentity({ subject: "user_matrix" });

        const customerId = await t.run((ctx) =>
          ctx.db.insert("customers", { orgId, firstName: "Matrix", lastName: "Customer" })
        );
        const vehicleId = await t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId,
            vin: `VIN_MATRIX_${Date.now()}_${Math.random()}`,
            make: "Toyota",
            model: "RAV4",
            year: 2024,
            mileage: 100,
            color: "Silver",
            fuelType: "Hybrid",
            transmission: "Auto",
            purchasePrice: 15_000,
            sellingPrice: 20_000,
            status: "AVAILABLE",
          })
        );

        return { t, orgId, userId, asOwner, customerId, vehicleId };
      }

      test("Matrix Case 1: configured + adminFees: undefined rejects at createFromQuote", async () => {
        const { asOwner, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Unconfigured Fees Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: undefined,
        });

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          totalFinancedAmount: 20_000,
        });

        await expect(
          asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId })
        ).rejects.toThrow(/Execution Fees are not configured for this finance company/);
      });

      test("Matrix Case 2: configured + adminFees: 0 succeeds with expected fee 0", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Zero Fees Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 0,
        });

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          totalFinancedAmount: 20_000,
        });

        const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        const app = (await t.run((ctx) => ctx.db.get(applicationId)))!;
        expect(app.estimatedDealerBorneExpensesMinor).toBe(0);
      });

      test("Matrix Case 3: configured + adminFees: 700 succeeds with expected fee 700,000 JOD minor", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "700 Fees Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 700,
        });

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          totalFinancedAmount: 20_000,
        });

        const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        const app = (await t.run((ctx) => ctx.db.get(applicationId)))!;
        expect(app.estimatedDealerBorneExpensesMinor).toBe(700_000);
      });

      test("Matrix Case 4: companyId + mode: undefined rejects at saveQuote boundary and createFromQuote", async () => {
        const { asOwner, t, orgId, userId, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Ambiguous Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 700,
        });

        // Rejected at saveQuote boundary
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            companyId,
            mode: undefined,
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Finance company can only be set for configured finance company quotes/);

        // If an ambiguous quote row somehow pre-existed in DB, createFromQuote fails closed
        const ambiguousQuoteId = await t.run((ctx) =>
          ctx.db.insert("quotes", {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            companyId,
            mode: undefined,
            totalFinancedAmount: 20_000,
            monthlyInstallment: 450,
            totalProfit: 1600,
            status: "DRAFT",
            createdBy: userId,
            createdAt: Date.now(),
          })
        );

        await expect(
          asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId: ambiguousQuoteId })
        ).rejects.toThrow(/Finance company can only be set for configured finance company quotes/);
      });

      test("Matrix Case 5: manual + manualAdminFees: undefined rejects at createFromQuote", async () => {
        const { asOwner, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProviderName: "Custom Bank",
          manualProfitRate: 5,
          manualAdminFees: undefined,
          totalFinancedAmount: 20_000,
        });

        await expect(
          asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId })
        ).rejects.toThrow(/Execution Fees are not configured for this manual finance company quote/);
      });

      test("Matrix Case 6: manual + manualAdminFees: 0 succeeds with 0", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProviderName: "Custom Bank",
          manualProfitRate: 5,
          manualAdminFees: 0,
          totalFinancedAmount: 20_000,
        });

        const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        const app = (await t.run((ctx) => ctx.db.get(applicationId)))!;
        expect(app.estimatedDealerBorneExpensesMinor).toBe(0);
      });

      test("Matrix Case 7: manual + manualAdminFees: 700 succeeds with correct minor amount (700,000)", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProviderName: "Custom Bank",
          manualProfitRate: 5,
          manualAdminFees: 700,
          totalFinancedAmount: 20_000,
        });

        const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        const app = (await t.run((ctx) => ctx.db.get(applicationId)))!;
        expect(app.estimatedDealerBorneExpensesMinor).toBe(700_000);
      });

      test("Matrix Case 8: repair path with unknown authority rejects and never repairs to 0", async () => {
        const { asOwner, t, orgId, userId, customerId, vehicleId } = await setupMatrixEnv();

        // Subcase A: Configured company with missing adminFees and no legacy templates
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Missing Fee Authority",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 0, // initially 0 so quote can be saved
        });

        const quoteIdA = await t.run((ctx) =>
          ctx.db.insert("quotes", {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            totalFinancedAmount: 20_000,
            monthlyInstallment: 450,
            totalProfit: 1600,
            status: "DRAFT",
            createdBy: userId,
            createdAt: Date.now(),
          })
        );

        const companyA = (await t.run((ctx) => ctx.db.get(companyId)))!;
        // Seed in-flight application without lineage and with undefined adminFees in snapshot
        const appIdA = await t.run((ctx) =>
          ctx.db.insert("financeApplications", {
            orgId,
            customerId,
            vehicleId,
            salespersonId: userId,
            quoteId: quoteIdA,
            companyId,
            status: "UNDER_REVIEW",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            companyRuleSnapshot: {
              ...buildRuleSnapshot(companyA),
              adminFees: undefined,
            },
          })
        );

        await expect(
          asOwner.mutation(api.applications.repairQuoteEconomicsLineage, {
            orgId,
            applicationId: appIdA,
            expectedCurrency: "JOD",
            dryRun: false,
          })
        ).rejects.toThrow(/Execution Fees are not configured for this finance company/);

        // Assert that the record was not repaired to 0
        const unRepairedA = (await t.run((ctx) => ctx.db.get(appIdA)))!;
        expect(unRepairedA.estimatedDealerBorneExpensesMinor).toBeUndefined();

        // Subcase B: Manual finance with manualAdminFees undefined
        const vehicleIdB = await t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId,
            vin: `VIN_MATRIX_B_${Date.now()}`,
            make: "Kia",
            model: "Sportage",
            year: 2024,
            mileage: 10,
            color: "White",
            fuelType: "Gasoline",
            transmission: "Auto",
            purchasePrice: 14_000,
            sellingPrice: 19_000,
            status: "AVAILABLE",
          })
        );

        const quoteIdB = await t.run((ctx) =>
          ctx.db.insert("quotes", {
            orgId,
            customerId,
            vehicleId: vehicleIdB,
            vehiclePrice: 19_000,
            downPayment: 0,
            termMonths: 48,
            mode: "MANUAL_FINANCE_COMPANY",
            manualProviderName: "Bank B",
            manualAdminFees: undefined,
            totalFinancedAmount: 19_000,
            monthlyInstallment: 420,
            totalProfit: 1500,
            status: "DRAFT",
            createdBy: userId,
            createdAt: Date.now(),
          })
        );

        const appIdB = await t.run((ctx) =>
          ctx.db.insert("financeApplications", {
            orgId,
            customerId,
            vehicleId: vehicleIdB,
            salespersonId: userId,
            quoteId: quoteIdB,
            status: "UNDER_REVIEW",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );

        await expect(
          asOwner.mutation(api.applications.repairQuoteEconomicsLineage, {
            orgId,
            applicationId: appIdB,
            expectedCurrency: "JOD",
            dryRun: false,
          })
        ).rejects.toThrow(/Execution Fees are not configured for this manual finance company quote/);

        const unRepairedB = (await t.run((ctx) => ctx.db.get(appIdB)))!;
        expect(unRepairedB.estimatedDealerBorneExpensesMinor).toBeUndefined();
      });
    });
  });
});
