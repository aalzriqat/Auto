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
  assertFinancedQuoteContributionValid,
  requireConfiguredExecutionFees,
} from "./utils/financingEconomics";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeAffordabilityRange } from "./marketplaceAffordability";
import { estimateMonthlyPayment } from "./marketplaceBrowse";
import { computePersonalizedFinance } from "./marketplaceRequests";
import { websitePublicProjection } from "./websiteProjection";
import { buildSmartReplyText } from "./utils/smartReplyBuilder";
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
import { toMinorUnits, fromMinorUnits } from "./utils/money";

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
        profit: { available: false, reason: "NoApprovedPurchaseAmount" },
        vehicleConsigned: false,
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
      if (!composed.readable) throw new Error("customer gap composition must be readable");
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
        profit: { available: false, reason: "NoApprovedPurchaseAmount" },
        vehicleConsigned: false,
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
        profit: { available: false, reason: "NoApprovedPurchaseAmount" },
        vehicleConsigned: false,
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
      const feeMinor = resolveExpectedExecutionFeesMinor({
        quote: { mode: "MANUAL_FINANCE_COMPANY", manualAdminFees: 650 },
        currency: "JOD",
      });
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
          expectedEditRevision: 1,
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
        expectedEditRevision: 1,
        name: "Legacy Co Migrated",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 700,
      });
      const migrated = (await t.run((ctx) => ctx.db.get("financeCompanies", legacyCompanyId)))!;
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

      // Fails closed at saveQuote boundary
      await expect(
        asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          totalFinancedAmount: 20_000,
        })
      ).rejects.toThrow(/Execution Fees are not configured for this finance company/);

      // Direct legacy quote in DB also fails closed at createFromQuote
      const legacyQuoteId = await t.run((ctx) =>
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

      await expect(
        asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId: legacyQuoteId,
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

      const statusId = await t.run((ctx) =>
        ctx.db.insert("orgCustomerStatuses", {
          orgId,
          label: "Salary Slip",
          isActive: true,
          order: 1,
        })
      );

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        customerEligibilityStatusIds: [statusId],
        totalFinancedAmount: 20_000,
      });

      const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
        orgId,
        quoteId,
      });

      const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
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

      const statusId = await t.run((ctx) =>
        ctx.db.insert("orgCustomerStatuses", {
          orgId,
          label: "Salary Slip",
          isActive: true,
          order: 1,
        })
      );

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        customerEligibilityStatusIds: [statusId],
        totalFinancedAmount: 20_000,
      });

      const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
        orgId,
        quoteId,
      });

      const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
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

      const statusId = await t.run((ctx) =>
        ctx.db.insert("orgCustomerStatuses", {
          orgId,
          label: "Salary Slip",
          isActive: true,
          order: 1,
        })
      );

      const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 48,
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId,
        customerEligibilityStatusIds: [statusId],
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

      const closedApp = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
      expect(closedApp.status).toBe("CLOSED");

      const sale = (await t.run((ctx) => ctx.db.get("sales", saleId)))!;
      expect(sale).toBeDefined();
      expect(sale.applicationId).toBe(applicationId);
      expect(sale.vehicleId).toBe(vehicleId);

      const vehicle = (await t.run((ctx) => ctx.db.get("vehicles", vehicleId)))!;
      expect(vehicle.status).toBe("SOLD");
    });
  });

  describe("S1-R4-H1: Canonical Fee Authority Resolution Regression Matrix", () => {
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

      const customerStatusId = await t.run((ctx) =>
        ctx.db.insert("orgCustomerStatuses", {
          orgId,
          label: "Salary Slip",
          isActive: true,
          order: 1,
        })
      );

      const rawMutation = asOwner.mutation.bind(asOwner);
      const wrappedAsOwner = {
        ...asOwner,
        rawMutation,
        mutation: (fn: any, args: any) => {
          if (
            args?.mode === "CONFIGURED_FINANCE_COMPANY" &&
            args?.customerEligibilityStatusIds === undefined
          ) {
            return rawMutation(fn, {
              ...args,
              customerEligibilityStatusIds: [customerStatusId],
            });
          }
          return rawMutation(fn, args);
        },
      };

      return { t, orgId, userId, asOwner: wrappedAsOwner, customerId, vehicleId, customerStatusId };
    }

    describe("resolveExpectedExecutionFeesMinor canonical resolver unit tests", () => {
      const dummyCompanyId = "dummy_company_id" as Id<"financeCompanies">;

      // 1. configured + adminFees: undefined -> reject
      test("Case 1: configured + adminFees: undefined -> reject", () => {
        expect(() =>
          resolveExpectedExecutionFeesMinor({
            quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: dummyCompanyId },
            companyRuleSnapshot: {
              ruleVersion: 1,
              companyName: "Test Finance",
              defaultLtvPercent: 80,
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
            companyName: "Test Finance",
            defaultLtvPercent: 80,
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
            companyName: "Test Finance",
            defaultLtvPercent: 80,
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
              companyName: "Test Finance",
              defaultLtvPercent: 80,
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
      test("Matrix Case 1: configured + adminFees: undefined rejects at saveQuote and createFromQuote", async () => {
        const { asOwner, t, orgId, userId, customerId, vehicleId } = await setupMatrixEnv();

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

        // 1. Rejected at saveQuote boundary
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Execution Fees are not configured for this finance company/);

        // 2. Direct legacy DB insert rejects at createFromQuote boundary
        const legacyQuoteId = await t.run((ctx) =>
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

        await expect(
          asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId: legacyQuoteId })
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
        const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
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
        const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
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

      test("Matrix Case 5: manual + manualAdminFees: undefined rejects at saveQuote and createFromQuote", async () => {
        const { asOwner, t, orgId, userId, customerId, vehicleId } = await setupMatrixEnv();

        // 1. Rejected at saveQuote boundary
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
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
          })
        ).rejects.toThrow(/Execution Fees are not configured for this manual finance company quote/);

        // 2. Direct legacy DB insert rejects at createFromQuote boundary
        const legacyQuoteId = await t.run((ctx) =>
          ctx.db.insert("quotes", {
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
            monthlyInstallment: 450,
            totalProfit: 1600,
            status: "DRAFT",
            createdBy: userId,
            createdAt: Date.now(),
          })
        );

        await expect(
          asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId: legacyQuoteId })
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
        const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
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
        const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
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

        const companyA = (await t.run((ctx) => ctx.db.get("financeCompanies", companyId)))!;
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
        const unRepairedA = (await t.run((ctx) => ctx.db.get("financeApplications", appIdA)))!;
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

        const unRepairedB = (await t.run((ctx) => ctx.db.get("financeApplications", appIdB)))!;
        expect(unRepairedB.estimatedDealerBorneExpensesMinor).toBeUndefined();
      });
    });

    describe("Adversarial Review Seat 1 Round 5: Bound Quote Economics Lineage & Frozen Fee Authority (S1-R5-H1)", () => {
      test("Case 1: configured company adminFees undefined -> generate quote rejects / no economics", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Unconfigured Fees Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            // adminFees is undefined
          })
        );

        // Attempting to generate/save quote with unconfigured company fees must reject
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 25_000,
            downPayment: 5_000,
            termMonths: 60,
            totalFinancedAmount: 20_000,
            monthlyInstallment: 416.67,
            totalProfit: 5000,
          })
        ).rejects.toThrow(/Execution Fees are not configured for this finance company/);
      });

      test("Case 2: configured company adminFees 0 -> valid zero-fee quote with frozen authority", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Zero Fee Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 0,
            ruleVersion: 1,
          })
        );

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 28_000,
          downPayment: 5_000,
          termMonths: 60,
          totalFinancedAmount: 23_000,
          monthlyInstallment: 479.17,
          totalProfit: 5750,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.companyRuleVersion).toBe(1);
        expect(quote.companyRuleSnapshot).toBeDefined();
        expect(quote.companyRuleSnapshot?.adminFees).toBe(0);
      });

      test("Case 3: configured company adminFees 700 -> quote calculated and frozen with 700", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "700 Fee Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 700,
            ruleVersion: 1,
          })
        );

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 38_000,
          downPayment: 8_000,
          termMonths: 60,
          totalFinancedAmount: 30_700,
          monthlyInstallment: 639.58,
          totalProfit: 7675,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.companyRuleSnapshot?.adminFees).toBe(700);
      });

      test("Case 4: quote made at 0, company later changed to 700 -> preserves frozen 0 fee authority in application", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Changing Bank A",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 0,
            ruleVersion: 1,
          })
        );

        // Quote created at 0 fees
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 22_000,
          downPayment: 2_000,
          termMonths: 48,
          totalFinancedAmount: 20_000,
          monthlyInstallment: 500,
          totalProfit: 4000,
        });

        // Later, company is updated to 700 in settings
        await t.run((ctx) =>
          ctx.db.patch(companyId, {
            adminFees: 700,
            ruleVersion: 2,
          })
        );

        // Application created from quote
        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        // Application must preserve the quote's frozen 0 fee authority, NOT the current company's 700
        expect(app.estimatedDealerBorneExpensesMinor).toBe(0);
        expect(app.companyRuleSnapshot?.adminFees).toBe(0);
      });

      test("Case 5: quote made at 700, company later changed to 900 -> preserves frozen 700 fee authority in application", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Changing Bank B",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 700,
            ruleVersion: 1,
          })
        );

        // Quote created at 700 fees
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 26_000,
          downPayment: 3_000,
          termMonths: 48,
          totalFinancedAmount: 23_700,
          monthlyInstallment: 592.5,
          totalProfit: 4740,
        });

        // Later, company is updated to 900 in settings
        await t.run((ctx) =>
          ctx.db.patch(companyId, {
            adminFees: 900,
            ruleVersion: 2,
          })
        );

        // Application created from quote
        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        // Application must preserve the quote's frozen 700 fee authority, NOT the current company's 900
        expect(app.estimatedDealerBorneExpensesMinor).toBe(700_000);
        expect(app.companyRuleSnapshot?.adminFees).toBe(700);
      });

      test("Case 6 & 7: blank manual fee in web/mobile remains undefined and blocks saveQuote", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        // With manualAdminFees: undefined (blank in client), saveQuote must reject and not manufacture 0
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode: "MANUAL_FINANCE_COMPANY",
            manualProviderName: "Custom Lender",
            manualProfitRate: 5,
            manualAdminFees: undefined, // blank
            vehiclePrice: 24_000,
            downPayment: 4_000,
            termMonths: 48,
            totalFinancedAmount: 20_000,
            monthlyInstallment: 500,
            totalProfit: 4000,
          })
        ).rejects.toThrow(/Execution Fees are not configured for this manual finance company quote/);
      });

      test("Case 8: explicit manual 0 is valid and creates application with 0 expenses", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProviderName: "Zero Fee Manual Bank",
          manualProfitRate: 5,
          manualAdminFees: 0, // explicit 0
          vehiclePrice: 21_000,
          downPayment: 3_000,
          termMonths: 48,
          totalFinancedAmount: 18_000,
          monthlyInstallment: 450,
          totalProfit: 3600,
        });

        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        expect(app.estimatedDealerBorneExpensesMinor).toBe(0);
        expect(app.manualFinanceSnapshot?.adminFees).toBe(0);
      });

      test("Case 9: DBR and LTV derived from the identical frozen fee authority as application economics", async () => {
        const { t, orgId, asOwner, vehicleId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Lineage Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500, // 500 JOD fee
            ruleVersion: 1,
          })
        );

        const customerId = await t.run((ctx) =>
          ctx.db.insert("customers", {
            orgId,
            firstName: "Kareem",
            lastName: "Client",
            phone: "+962798888888",
            employment: {
              employer: "Tech Corp",
              salary: 1500,
            },
            createdAt: Date.now(),
          })
        );

        // Vehicle valuation
        await t.run((ctx) =>
          ctx.db.insert("vehicleValuations", {
            orgId,
            vehicleId,
            companyId,
            valuationAmount: 25_000,
          })
        );

        // Vehicle price 25,000 - down payment 5,000 + admin fees 500 = 20,500 financed
        // Caller sends intentionally fabricated 1 / 1 values to test server-side authority
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 25_000,
          downPayment: 5_000,
          termMonths: 48,
          totalFinancedAmount: 1,
          monthlyInstallment: 1,
          totalProfit: 1,
        });

        // Server independently produces the expected 20,500 financed amount and 512.5 monthly installment
        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.totalFinancedAmount).toBe(20_500);
        expect(quote.monthlyInstallment).toBe(512.5);
        expect(quote.customerQuotePricingSnapshot?.totalFinancedAmount).toBe(20_500);
        expect(quote.customerQuotePricingSnapshot?.monthlyInstallment).toBe(512.5);

        // Company fees are later changed to 1200 in settings
        await t.run((ctx) =>
          ctx.db.patch(companyId, {
            adminFees: 1200,
            ruleVersion: 2,
          })
        );

        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        // 1. Application economics: matches frozen quote authority (500 JOD = 500,000 minor)
        expect(app.estimatedDealerBorneExpensesMinor).toBe(500_000);

        // 2. Underwriting snapshot: proposedMonthlyInstallment and DBR are derived from quote.monthlyInstallment (512.5)
        expect(app.underwritingSnapshot?.proposedMonthlyInstallment).toBe(512.5);
        expect(app.underwritingSnapshot?.dbrAtSubmission).toBeCloseTo(512.5 / 1500, 4);

        // 3. Underwriting LTV: derived from quote.totalFinancedAmount (20,500 / 25,000 * 100 = 82)
        expect(app.underwritingSnapshot?.ltvAtSubmission).toBeCloseTo((20_500 / 25_000) * 100, 4);
      });
    });

    describe("Adversarial Review Seat 1 Round 6: Server Authoritative Quote Economics & Customer Pricing Snapshot (S1-R6-H1)", () => {
      // 1. adminFees=700, caller sends financed amount 1 -> overwritten with canonical calculation
      test("1. adminFees=700, caller sends financed amount 1 -> overwritten with canonical calculation", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Canonical Engine Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 700,
            ruleVersion: 1,
          })
        );

        // Vehicle: 20,000, downPayment: 0, adminFees: 700 -> financedAmount = 20,700
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          totalFinancedAmount: 1, // Attacker sends fabricated 1
          monthlyInstallment: 1,
          totalProfit: 1,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.totalFinancedAmount).toBe(20_700);
        expect(quote.customerQuotePricingSnapshot?.totalFinancedAmount).toBe(20_700);
        expect(quote.customerQuotePricingSnapshot?.executionFees).toBe(700);
      });

      // 2. adminFees=700, caller sends monthly installment 1 -> overwritten with canonical calculation
      test("2. adminFees=700, caller sends monthly installment 1 -> overwritten with canonical calculation", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Canonical Installment Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 700,
            ruleVersion: 1,
          })
        );

        // 20,700 * 5% * 4 years = 4,140 profit. Total debt = 24,840. Monthly = 24,840 / 48 = 517.5
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          totalFinancedAmount: 1,
          monthlyInstallment: 1, // Attacker sends fabricated 1
          totalProfit: 1,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.monthlyInstallment).toBe(517.5);
        expect(quote.customerQuotePricingSnapshot?.monthlyInstallment).toBe(517.5);
      });

      // 3. caller sends correct fee but stale profit rate result -> backend wins
      test("3. caller sends correct fee but stale profit rate result -> backend wins", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Rate Authority Bank",
            profitRate: 6, // Current is 6%
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
          })
        );

        // Financed = 20,500. Profit at 6% = 20,500 * 0.06 * 4 = 4,920.
        // Caller calculates with stale rate 3%: profit = 2,460.
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          totalFinancedAmount: 20_500,
          monthlyInstallment: 478.33,
          totalProfit: 2460, // Stale
          profitRateApplied: 3,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.profitRateApplied).toBe(6);
        expect(quote.totalProfit).toBe(4920);
        expect(quote.customerQuotePricingSnapshot?.profitRate).toBe(6);
        expect(quote.customerQuotePricingSnapshot?.totalProfit).toBe(4920);
      });

      // 4. company changes after quote creation (adminFees and profitRate) -> application continues with entire frozen snapshot
      test("4. company changes after quote creation (adminFees and profitRate) -> application continues with entire frozen snapshot", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Drifting Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
          })
        );

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 25_000,
          downPayment: 5_000,
          termMonths: 48,
        });

        // Company changes both adminFees and profitRate later
        await t.run((ctx) =>
          ctx.db.patch(companyId, {
            adminFees: 1200,
            profitRate: 9,
            ruleVersion: 2,
          })
        );

        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        // Preserves frozen snapshot from quote creation
        expect(app.customerQuotePricingSnapshot).toBeDefined();
        expect(app.customerQuotePricingSnapshot?.profitRate).toBe(5);
        expect(app.customerQuotePricingSnapshot?.executionFees).toBe(500);
        expect(app.estimatedDealerBorneExpensesMinor).toBe(500_000);
        expect(app.underwritingSnapshot?.proposedMonthlyInstallment).toBe(512.5);
      });

      // 5. manual quote sends arbitrary computed outputs -> overwritten with canonical calculation
      test("5. manual quote sends arbitrary computed outputs -> overwritten with canonical calculation", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        // Manual: vehiclePrice: 20,000, downPayment: 2,000, termMonths: 36, manualAdminFees: 300, manualProfitRate: 4
        // manualIncludesCommissionInDebt: true (default)
        // financedAmount = 20,000 - 2,000 + 300 = 18,300.
        // totalProfit = 18,300 * 0.04 * 3 = 2,196.
        // totalContractValue = 18,300 + 2,196 = 20,496.
        // monthlyInstallment = 20,496 / 36 = 569.3333...
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProviderName: "Arbitrary Manual Bank",
          vehiclePrice: 20_000,
          downPayment: 2_000,
          termMonths: 36,
          manualAdminFees: 300,
          manualProfitRate: 4,
          totalFinancedAmount: 9999, // Fabricated
          monthlyInstallment: 99,
          totalProfit: 9,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.totalFinancedAmount).toBe(18_300);
        expect(quote.totalProfit).toBe(2196);
        expect(quote.monthlyInstallment).toBeCloseTo(20496 / 36, 4);
        expect(quote.customerQuotePricingSnapshot?.totalFinancedAmount).toBe(18_300);
        expect(quote.customerQuotePricingSnapshot?.monthlyInstallment).toBeCloseTo(20496 / 36, 4);
      });

      // 6. web calculation differs from backend engine -> backend wins
      test("6. web calculation differs from backend engine -> backend wins", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Web Drift Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 400,
            ruleVersion: 1,
          })
        );

        // Web sends rounded or slightly drifted outputs
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          totalFinancedAmount: 20_399, // 1 off
          monthlyInstallment: 509.0, // drifted
          totalProfit: 4000, // drifted
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        // Correct financed amount: 20,000 + 400 = 20,400
        expect(quote.totalFinancedAmount).toBe(20_400);
        expect(quote.totalProfit).toBe(20_400 * 0.05 * 4); // 4,080
        expect(quote.monthlyInstallment).toBe((20_400 + 4080) / 48); // 510
      });

      // 7. mobile calculation differs from backend engine -> backend wins
      test("7. mobile calculation differs from backend engine -> backend wins", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Mobile Drift Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 400,
            ruleVersion: 1,
          })
        );

        // Mobile sends old cached calculation
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          totalFinancedAmount: 20_000,
          monthlyInstallment: 500,
          totalProfit: 4000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.totalFinancedAmount).toBe(20_400);
        expect(quote.monthlyInstallment).toBe(510);
      });

      // 8. direct API caller fabricates economics -> cannot influence stored quote economics or underwriting
      test("8. direct API caller fabricates economics -> cannot influence stored quote economics or underwriting", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Adversarial API Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 600,
            ruleVersion: 1,
          })
        );

        await t.run((ctx) =>
          ctx.db.patch(customerId, {
            employment: {
              employer: "Tech Corp",
              salary: 2000,
            },
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("vehicleValuations", {
            orgId,
            vehicleId,
            companyId,
            valuationAmount: 20_000,
          })
        );

        // Attacker calls API directly with 1 / 1
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          totalFinancedAmount: 1,
          monthlyInstallment: 1,
          totalProfit: 1,
        });

        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        // Financed: 20,600. Installment: (20,600 + 4,120) / 48 = 515.
        expect(app.underwritingSnapshot?.proposedMonthlyInstallment).toBe(515);
        expect(app.underwritingSnapshot?.dbrAtSubmission).toBeCloseTo(515 / 2000, 4);
        expect(app.underwritingSnapshot?.ltvAtSubmission).toBeCloseTo((20_600 / 20_000) * 100, 4);
      });

      // 9. NaN / Infinity in calculated or input fields -> rejects before storage with ConvexError
      test("9. NaN / Infinity in calculated or input fields -> rejects before storage with ConvexError", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Finite Guard Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: NaN,
            downPayment: 0,
            termMonths: 48,
          })
        ).rejects.toThrow(/Vehicle price must be a finite number/);

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: Infinity,
            termMonths: 48,
          })
        ).rejects.toThrow(/Down payment must be a finite number/);

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            totalFinancedAmount: NaN,
          })
        ).rejects.toThrow(/Total financed amount must be a finite number/);

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            monthlyInstallment: Infinity,
          })
        ).rejects.toThrow(/Monthly installment must be a finite number/);
      });

      // 10. financed quotes reject vehicleItems before any multi-vehicle normalization.
      test("10. financed vehicleItems are rejected before quote economics are calculated", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const vehicleId2 = await t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId,
            vin: `VIN_V2_${Date.now()}`,
            make: "Toyota",
            model: "Camry",
            year: 2024,
            mileage: 50,
            color: "White",
            fuelType: "Hybrid",
            transmission: "Auto",
            purchasePrice: 10_000,
            sellingPrice: 12_000,
            status: "AVAILABLE",
          })
        );

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Multi Item Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
          })
        );

        const before = await t.run((ctx) => ctx.db.query("quotes").collect());
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehicleItems: [
              { vehicleId, unitPrice: 15_000 },
              { vehicleId: vehicleId2, unitPrice: 10_000 },
            ],
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 10_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow(/exactly one vehicle/i);
        const after = await t.run((ctx) => ctx.db.query("quotes").collect());
        expect(after).toHaveLength(before.length);
      });

      // 11. manual includesCommissionInDebt omitted -> uses manual default true
      test("11. manual includesCommissionInDebt omitted -> uses manual default true", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        // manualIncludesCommissionInDebt is omitted -> defaults to TRUE
        // Under true: commission is NOT included in financedAmount:
        // financedAmount = 20,000 - 0 + 300 = 20,300 (not 20,300 + 500 = 20,800)
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProviderName: "Default Commission Bank",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          manualAdminFees: 300,
          manualCommission: 500,
          manualProfitRate: 5,
          // manualIncludesCommissionInDebt omitted
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.totalFinancedAmount).toBe(20_300);
        expect(quote.customerQuotePricingSnapshot?.includesCommissionInDebt).toBe(true);
        expect(quote.customerQuotePricingSnapshot?.totalFinancedAmount).toBe(20_300);
        // Contract value includes commission on top: 20,300 + profit (4,060) + commission (500) = 24,860
        expect(quote.customerQuotePricingSnapshot?.totalContractValue).toBe(24_860);
      });

      // 12. org currency changes after quote -> application fails closed on currency mismatch
      test("12. org currency changes after quote -> application fails closed on currency mismatch", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Currency Guard Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
          })
        );

        // Quote created under JOD
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerQuotePricingSnapshot?.currency).toBe("JOD");

        // Org currency is changed to USD in orgSettings
        await t.run(async (ctx) => {
          const existing = await ctx.db
            .query("orgSettings")
            .withIndex("by_org", (q) => q.eq("orgId", orgId))
            .first();
          if (existing) {
            await ctx.db.patch(existing._id, { currency: "USD", currencySymbol: "$" });
          } else {
            await ctx.db.insert("orgSettings", {
              orgId,
              currency: "USD",
              currencySymbol: "$",
              enabledPaymentTypes: ["CASH", "INSTALLMENT"],
            });
          }
        });

        // createFromQuote must fail closed rather than silently reinterpreting JOD amounts as USD
        await expect(
          asOwner.mutation(api.applications.createFromQuote, {
            orgId,
            quoteId,
          })
        ).rejects.toThrow(/Quote currency \(JOD\) does not match organization currency \(USD\)/);
      });

      // 13. quote mirror fields are tampered after creation but pricing snapshot remains intact -> application consumes snapshot authority or fails closed
      test("13. quote mirror fields are tampered after creation but pricing snapshot remains intact -> application consumes snapshot authority or fails closed", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Tamper Guard Bank",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
          })
        );

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
        });

        // Directly tamper with mirror fields in the DB
        await t.run((ctx) =>
          ctx.db.patch(quoteId, {
            monthlyInstallment: 10,
            totalFinancedAmount: 100,
          })
        );

        // createFromQuote detects the discrepancy against customerQuotePricingSnapshot and fails closed
        await expect(
          asOwner.mutation(api.applications.createFromQuote, {
            orgId,
            quoteId,
          })
        ).rejects.toThrow(/Quotation monthly installment does not match its frozen customer pricing snapshot/);
      });

      // 14. all quote modes verified (CASH, INTERNAL_INSTALLMENT, LEASE, undefined) -> no mode preserves caller-fabricated Murabaha economics
      test("14. all quote modes verified (CASH, INTERNAL_INSTALLMENT, LEASE, undefined) -> no mode preserves caller-fabricated Murabaha economics", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const unfinancedModes = ["CASH", "INTERNAL_INSTALLMENT", "LEASE", undefined] as const;

        for (const mode of unfinancedModes) {
          const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode,
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
            totalFinancedAmount: 15_000, // Caller fabricates computed Murabaha outputs
            monthlyInstallment: 350,
            profitRateApplied: 8,
            totalProfit: 1800,
          });

          const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
          // Stored Murabaha computed outputs must be completely cleared/undefined
          expect(quote.totalFinancedAmount).toBeUndefined();
          expect(quote.monthlyInstallment).toBeUndefined();
          expect(quote.profitRateApplied).toBeUndefined();
          expect(quote.totalProfit).toBeUndefined();
          expect(quote.customerQuotePricingSnapshot).toBeUndefined();
        }
      });
    });

    describe("Adversarial Review Seat 1 Round 7: Major-Unit Denomination Representability (S1-R7-H1)", () => {
      test("JOD manual fee 0.0004 is rejected as unrepresentable at 3 decimal places", async () => {
        const { orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode: "MANUAL_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
            manualAdminFees: 0.0004,
          })
        ).rejects.toThrow(/cannot be represented in JOD/);
      });

      test("JOD manual fee 0.001 is accepted as representable (1 fils)", async () => {
        const { orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          mode: "MANUAL_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 5_000,
          termMonths: 48,
          manualAdminFees: 0.001,
        });
        expect(quoteId).toBeDefined();
      });

      test("JOD vehicle price 20000.0004 is rejected as unrepresentable in JOD", async () => {
        const { orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode: "MANUAL_FINANCE_COMPANY",
            vehiclePrice: 20000.0004,
            downPayment: 5_000,
            termMonths: 48,
            manualAdminFees: 100,
          })
        ).rejects.toThrow(/cannot be represented in JOD/);
      });

      test("JOD down payment 500.0004 is rejected as unrepresentable in JOD", async () => {
        const { orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode: "MANUAL_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 500.0004,
            termMonths: 48,
            manualAdminFees: 100,
          })
        ).rejects.toThrow(/cannot be represented in JOD/);
      });

      test("JOD commission with >3 decimals is rejected as unrepresentable in JOD", async () => {
        const { orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode: "MANUAL_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
            manualAdminFees: 100,
            manualCommission: 50.0004,
          })
        ).rejects.toThrow(/cannot be represented in JOD/);
      });

      test("explicit representable 0 is accepted for downPayment, adminFees, and commission", async () => {
        const { orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          mode: "MANUAL_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 0,
          termMonths: 48,
          manualAdminFees: 0,
          manualCommission: 0,
        });
        expect(quoteId).toBeDefined();
      });

      test("2-decimal currency (USD) rejects values with a third decimal place", async () => {
        const t = convexTestWithComponents(schema, MODULES);
        const orgId = await t.run((ctx) =>
          ctx.db.insert("organizations", { name: "Dealer USD", createdAt: Date.now() })
        );
        await t.run((ctx) =>
          ctx.db.insert("orgSettings", {
            orgId,
            currency: "USD",
            currencySymbol: "$",
            enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
          })
        );
        const userId = await t.run((ctx) =>
          ctx.db.insert("users", { clerkId: "user_usd", email: "usd@dealer.com" })
        );
        const roleId = await t.run((ctx) =>
          ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
        );
        await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
        const asOwner = t.withIdentity({ subject: "user_usd" });

        const customerId = await t.run((ctx) =>
          ctx.db.insert("customers", { orgId, firstName: "USD", lastName: "Customer" })
        );
        const vehicleId = await t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId,
            vin: `VIN_USD_${Date.now()}`,
            make: "Ford",
            model: "Mustang",
            year: 2024,
            mileage: 100,
            color: "Black",
            fuelType: "Gasoline",
            transmission: "Auto",
            purchasePrice: 25_000,
            sellingPrice: 30_000,
            status: "AVAILABLE",
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            mode: "MANUAL_FINANCE_COMPANY",
            vehiclePrice: 30_000,
            downPayment: 5_000,
            termMonths: 48,
            manualAdminFees: 100.001,
          })
        ).rejects.toThrow(/cannot be represented in USD/);
      });

      test("accepted quote preserves exact economic value when converting snapshot money to minor units and back", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          mode: "MANUAL_FINANCE_COMPANY",
          vehiclePrice: 20000.125,
          downPayment: 5000.250,
          termMonths: 48,
          manualAdminFees: 150.375,
          manualCommission: 50.125,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerQuotePricingSnapshot).toBeDefined();
        const snap = quote.customerQuotePricingSnapshot!;

        for (const [amount, label] of [
          [snap.vehiclePrice, "vehiclePrice"],
          [snap.downPayment, "downPayment"],
          [snap.executionFees, "executionFees"],
          [snap.commission, "commission"],
        ] as const) {
          const minor = toMinorUnits(amount, snap.currency);
          const roundtrip = fromMinorUnits(minor, snap.currency);
          expect(roundtrip, `${label} must roundtrip with exact equality`).toBe(amount);
        }
      });

      test("saveQuote defensively rejects legacy/corrupt company row with unrepresentable adminFees from DB", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const corruptCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Corrupt Fees Co",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 500.0004,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: corruptCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow(/cannot be represented in JOD/);
      });

      test("saveQuote enforces args.termMonths <= company.maxTermMonths", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Capped Term Co",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 60,
          })
        ).rejects.toThrow(/exceeds maximum term allowed by finance company \(48\)/);
      });
    });

    describe("Adversarial Review Seat 1 Round 8: Commercial-Term Authority (S1-R8-H1)", () => {
      test("createCompany rejects maxTermMonths: NaN", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "NaN Term Co",
            profitRate: 5,
            maxTermMonths: NaN,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Maximum term months.*Must be a finite number/);
      });

      test("createCompany rejects maxTermMonths: Infinity", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "Infinity Term Co",
            profitRate: 5,
            maxTermMonths: Infinity,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Maximum term months.*Must be a finite number/);
      });

      test("createCompany rejects maxTermMonths: 0", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "Zero Term Co",
            profitRate: 5,
            maxTermMonths: 0,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Maximum term months must be a positive integer/);
      });

      test("createCompany rejects maxTermMonths: -12", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "Negative Term Co",
            profitRate: 5,
            maxTermMonths: -12,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Maximum term months must be a positive integer/);
      });

      test("createCompany rejects maxTermMonths: 48.5", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "Fractional Term Co",
            profitRate: 5,
            maxTermMonths: 48.5,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Maximum term months must be a positive integer/);
      });

      test("updateCompany rejects updating to invalid maxTermMonths", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Valid Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 100,
        });

        for (const invalidMax of [NaN, Infinity, 0, -12, 48.5]) {
          await expect(
            asOwner.mutation(api.finance.updateCompany, {
              id: companyId,
              orgId,
              expectedEditRevision: 1,
              name: "Valid Co",
              profitRate: 5,
              maxTermMonths: invalidMax,
              gracePeriodMonths: 0,
              isActive: true,
              adminFees: 100,
            })
          ).rejects.toThrow();
        }
      });

      test("saveQuote defensively rejects corrupt company row with maxTermMonths: NaN", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const corruptCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Corrupt NaN Co",
            profitRate: 5,
            maxTermMonths: NaN,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: corruptCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow(/Maximum term months.*Must be a finite number/);
      });

      test("saveQuote defensively rejects corrupt company row with maxTermMonths: Infinity", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const corruptCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Corrupt Infinity Co",
            profitRate: 5,
            maxTermMonths: Infinity,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: corruptCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow(/Maximum term months.*Must be a finite number/);
      });

      test("saveQuote accepts termMonths === maxTermMonths", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Exact Term Co",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 5_000,
          termMonths: 48,
        });
        expect(quoteId).toBeDefined();
      });

      test("saveQuote rejects termMonths === maxTermMonths + 1", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Exact Term Co",
            profitRate: 5,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 49,
          })
        ).rejects.toThrow(/exceeds maximum term allowed by finance company \(48\)/);
      });

      test("createCompany and updateCompany reject gracePeriodMonths >= maxTermMonths", async () => {
        const { orgId, asOwner } = await setupMatrixEnv();
        // Equal
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "Equal Grace Co",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 60,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Grace period months \(60\) must be strictly less than maximum term months \(60\)/);

        // Exceeds
        await expect(
          asOwner.mutation(api.finance.createCompany, {
            orgId,
            name: "Exceeding Grace Co",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 72,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Grace period months \(72\) must be strictly less than maximum term months \(60\)/);

        // Valid creation then invalid update
        const validCompanyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Valid Grace Co",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 3,
          isActive: true,
          adminFees: 100,
        });

        await expect(
          asOwner.mutation(api.finance.updateCompany, {
            id: validCompanyId,
            orgId,
            expectedEditRevision: 1,
            name: "Valid Grace Co",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 60,
            isActive: true,
            adminFees: 100,
          })
        ).rejects.toThrow(/Grace period months \(60\) must be strictly less than maximum term months \(60\)/);
      });
    });

    describe("Adversarial Review Seat 1 Round 9: Active Finance Company Gating (S1-R9-H1)", () => {
      test("isActive: false company + new saveQuote rejects and inserts no quote document", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const inactiveCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Inactive Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            isActive: false,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        const quotesBefore = await t.run((ctx) => ctx.db.query("quotes").collect());

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: inactiveCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow("Finance company is inactive or unavailable for new quotations.");

        const quotesAfter = await t.run((ctx) => ctx.db.query("quotes").collect());
        expect(quotesAfter.length).toBe(quotesBefore.length);
      });

      test("active company + saveQuote accepts and persists valid quote", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const activeCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Active Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId: activeCompanyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 5_000,
          termMonths: 48,
        });

        expect(quoteId).toBeDefined();
        const quote = await t.run((ctx) => ctx.db.get("quotes", quoteId));
        expect(quote).not.toBeNull();
        expect(quote?.companyId).toEqual(activeCompanyId);
      });

      test("finance.deleteCompany (soft deactivation) prevents subsequent new quotes", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Soon Deleted Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 150,
        });

        // Soft delete the company
        await asOwner.mutation(api.finance.deleteCompany, {
          id: companyId,
          orgId,
        });

        const company = await t.run((ctx) => ctx.db.get("financeCompanies", companyId));
        expect(company?.isActive).toBe(false);

        // Subsequent quote attempt must reject
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow("Finance company is inactive or unavailable for new quotations.");
      });

      test("imported/inert inactive company rejects quote origination", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        // Simulating vehicle-import path creating inert discovered company
        const inertCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Discovered Inert Bank",
            isActive: false,
            // even if it has terms populated
            profitRate: 4.5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 200,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: inertCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 25_000,
            downPayment: 5_000,
            termMonths: 36,
          })
        ).rejects.toThrow("Finance company is inactive or unavailable for new quotations.");
      });

      test("direct API bypass / stale client referencing deactivated company is rejected", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const staleCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Deactivated Stale Bank",
            profitRate: 6,
            maxTermMonths: 48,
            gracePeriodMonths: 0,
            isActive: false,
            adminFees: 250,
            ruleVersion: 1,
            deactivatedAt: Date.now() - 10000,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: staleCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 30_000,
            downPayment: 6_000,
            termMonths: 36,
          })
        ).rejects.toThrow("Finance company is inactive or unavailable for new quotations.");
      });

      test("active company → create quote → deactivate company → createFromQuote preserves frozen quote lineage", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Lifecycle Bank",
          profitRate: 5.5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 300,
        });

        // 1. Create quote while active at 10:00
        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          companyId,
          mode: "CONFIGURED_FINANCE_COMPANY",
          vehiclePrice: 20_000,
          downPayment: 4_000,
          termMonths: 48,
        });

        const frozenQuote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(frozenQuote.customerQuotePricingSnapshot).toBeDefined();
        expect(frozenQuote.companyRuleSnapshot?.adminFees).toBe(300);

        // 2. Company disabled at 10:05
        await asOwner.mutation(api.finance.deleteCompany, {
          id: companyId,
          orgId,
        });

        const companyAfterDeactivation = (await t.run((ctx) => ctx.db.get("financeCompanies", companyId)))!;
        expect(companyAfterDeactivation.isActive).toBe(false);

        // 3. Application attempted at 10:06 from previously frozen quote must succeed
        const appId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });

        expect(appId).toBeDefined();
        const app = (await t.run((ctx) => ctx.db.get("financeApplications", appId)))!;
        expect(app.estimatedDealerBorneExpensesMinor).toBe(300_000);
        expect(app.companyRuleSnapshot?.adminFees).toBe(300);
        expect(app.quoteId).toEqual(quoteId);
      });

      test("another-org active company continues to reject with org mismatch", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();
        const otherOrgId = await t.run((ctx) =>
          ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
        );
        const otherOrgCompanyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId: otherOrgId,
            name: "Other Org Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 100,
            ruleVersion: 1,
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            companyId: otherOrgCompanyId,
            mode: "CONFIGURED_FINANCE_COMPANY",
            vehiclePrice: 20_000,
            downPayment: 5_000,
            termMonths: 48,
          })
        ).rejects.toThrow("Finance company not found in this organization.");
      });
    });

    describe("Adversarial Review Seat 1 Round 10: Customer Eligibility Authority (S1-R10-H1)", () => {
      test("Company accepts status A -> submitting status A succeeds and freezes customerEligibilitySnapshot", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Government Employee",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Gov Only Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 700,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot).toBeDefined();
        expect(quote.customerEligibilitySnapshot!.evaluatedAt).toBeGreaterThan(0);
        expect(quote.customerEligibilitySnapshot!.companyAcceptedStatusIds).toEqual([statusA]);
        expect(quote.customerEligibilitySnapshot!.selectedStatuses).toEqual([
          { statusId: statusA, label: "Government Employee" },
        ]);
        expect(quote.customerEligibilitySnapshot!.matchedStatusIds).toEqual([statusA]);
      });

      test("Company accepts status A or B -> submitting status B succeeds", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Government Employee",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Private Sector",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Flexible Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA, statusB],
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
          customerEligibilityStatusIds: [statusB],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusB]);
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusB, label: "Private Sector" },
        ]);
      });

      test("Company accepts status A -> submitting status C rejects with detailed error", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Government Employee",
            isActive: true,
            order: 1,
          })
        );
        const statusC = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Freelancer",
            isActive: true,
            order: 3,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Strict Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 600,
          acceptedStatuses: [statusA],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [statusC],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/This finance company does not accept the selected customer eligibility status/);
      });

      test("Company acceptedStatuses undefined -> accepts any valid active status", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Universal Employee",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Universal Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 400,
          acceptedStatuses: undefined,
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.companyAcceptedStatusIds).toBeUndefined();
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusA]);
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusA, label: "Universal Employee" },
        ]);
      });

      test("Company acceptedStatuses empty array -> accepts any valid active status", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Anyone",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Empty List Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 400,
          acceptedStatuses: [],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.companyAcceptedStatusIds).toEqual([]);
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusA]);
      });

      test("No selected customer status -> rejects configured quote (both empty array and undefined)", async () => {
        const { asOwner, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Standard Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        // 1. Explicit empty array
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status is required for configured finance company quotes/);

        // 2. Missing/undefined via rawMutation
        await expect(
          asOwner.rawMutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: undefined,
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status is required for configured finance company quotes/);
      });

      test("Selected status from another organization rejects", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const otherOrgId = await t.run((ctx) =>
          ctx.db.insert("organizations", { name: "Other Dealer Org", createdAt: Date.now() })
        );
        const foreignStatusId = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId: otherOrgId,
            label: "Foreign Status",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Local Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [foreignStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status not found in this organization/);
      });

      test("Deleted or nonexistent status rejects", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const tempStatusId = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Temporary Status",
            isActive: true,
            order: 1,
          })
        );
        // Delete it
        await t.run((ctx) => ctx.db.delete(tempStatusId));

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Local Finance 2",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [tempStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status not found in this organization/);
      });

      test("Inactive customer status rejects", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const inactiveStatusId = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Decommissioned Status",
            isActive: false,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Local Finance 3",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [inactiveStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status is inactive or unavailable/);
      });

      test("Duplicate submitted status IDs canonicalize deterministically in snapshot", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Gov Employee",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Dedup Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA, statusA],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusA, label: "Gov Employee" },
        ]);
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusA]);
      });

      test("Direct API eligibility bypass attempt is rejected by server", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Standard",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Restricted",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Gated Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
        });

        // Caller attempts to bypass wizard and save quote with unaccepted status B
        await expect(
          asOwner.rawMutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [statusB],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/This finance company does not accept the selected customer eligibility status/);
      });

      test("Stale UI: company changes acceptedStatuses from A to B before saveQuote -> rejects", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Tier A",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Tier B",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Dynamic Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
        });

        // Company updates its policy to only accept B
        await t.run((ctx) =>
          ctx.db.patch(companyId, {
            acceptedStatuses: [statusB],
          })
        );

        // Stale client submits quote with status A
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [statusA],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/This finance company does not accept the selected customer eligibility status/);
      });

      test("Quote valid under A -> company later changes to B -> createFromQuote still succeeds from frozen eligibility", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Tier A",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Tier B",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Evolving Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        // Later, company changes acceptedStatuses to only B
        await t.run((ctx) =>
          ctx.db.patch(companyId, {
            acceptedStatuses: [statusB],
          })
        );

        // createFromQuote must succeed using frozen quote snapshot!
        const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });
        const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
        expect(app.quoteId).toBe(quoteId);
      });

      test("Status row deleted after quote creation -> application creation still works and quote snapshot preserves label", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Legacy Status",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Resilient Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        // Status row is deleted from database
        await t.run((ctx) => ctx.db.delete(statusA));

        // createFromQuote still succeeds
        const applicationId = await asOwner.mutation(api.applications.createFromQuote, {
          orgId,
          quoteId,
        });
        expect(applicationId).toBeDefined();

        // Frozen quote snapshot preserved human label even though status row was deleted
        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusA, label: "Legacy Status" },
        ]);
      });

      test("Non-configured modes (CASH, MANUAL_FINANCE_COMPANY) do not require customerEligibilityStatusIds and leave snapshot undefined", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        // 1. CASH quote without customerEligibilityStatusIds
        const cashQuoteId = await asOwner.rawMutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 20_000,
          termMonths: 0,
          mode: "CASH",
        });
        const cashQuote = (await t.run((ctx) => ctx.db.get("quotes", cashQuoteId)))!;
        expect(cashQuote.customerEligibilitySnapshot).toBeUndefined();

        // 2. MANUAL_FINANCE_COMPANY quote without customerEligibilityStatusIds
        const customQuoteId = await asOwner.rawMutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 5_000,
          termMonths: 36,
          mode: "MANUAL_FINANCE_COMPANY",
          manualProfitRate: 6.5,
          manualAdminFees: 300,
          totalFinancedAmount: 15_300,
        });
        const customQuote = (await t.run((ctx) => ctx.db.get("quotes", customQuoteId)))!;
        expect(customQuote.customerEligibilitySnapshot).toBeUndefined();
      });
    });

    describe("Adversarial Review Seat 1 Round 12: Financed Quote Contribution Authority (S1-R12-H1)", () => {
      test("configured finance: downPayment = vehiclePrice is rejected", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Equal Down Payment Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [customerStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 20_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("configured finance: downPayment > vehiclePrice is rejected", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Exceeding Down Payment Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [customerStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 21_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("configured finance: downPayment = vehiclePrice - smallest currency unit is accepted", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Near Price Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [customerStatusId],
        });

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 19_999.999,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          customerEligibilityStatusIds: [customerStatusId],
          totalFinancedAmount: 500.001,
        });
        expect(quoteId).toBeDefined();
      });

      test("configured finance: downPayment = 0 is accepted", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Zero Down Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [customerStatusId],
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
          customerEligibilityStatusIds: [customerStatusId],
          totalFinancedAmount: 20_500,
        });
        expect(quoteId).toBeDefined();
      });

      test("high fees must not rescue downPayment >= vehiclePrice", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "High Fee Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 2000,
          acceptedStatuses: [customerStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 20_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 2000,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("high commission must not rescue downPayment >= vehiclePrice", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "High Commission Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          commission: 3000,
          acceptedStatuses: [customerStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 20_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 3500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("includesCommissionInDebt = true same rejection on downPayment >= vehiclePrice", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Debt Commission Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          commission: 3000,
          includesCommissionInDebt: true,
          acceptedStatuses: [customerStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 20_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 3500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("manual finance equality: downPayment = vehiclePrice is rejected", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 20_000,
            termMonths: 48,
            mode: "MANUAL_FINANCE_COMPANY",
            manualAdminFees: 500,
            manualProfitRate: 5,
            manualProviderName: "Custom Bank",
            totalFinancedAmount: 500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("manual finance greater-than: downPayment > vehiclePrice is rejected", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 22_000,
            termMonths: 48,
            mode: "MANUAL_FINANCE_COMPANY",
            manualAdminFees: 500,
            manualProfitRate: 5,
            manualProviderName: "Custom Bank",
            totalFinancedAmount: 500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("manual finance just below price: downPayment = vehiclePrice - 1 is accepted", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 19_999,
          termMonths: 48,
          mode: "MANUAL_FINANCE_COMPANY",
          manualAdminFees: 500,
          manualProfitRate: 5,
          manualProviderName: "Custom Bank",
          totalFinancedAmount: 501,
        });
        expect(quoteId).toBeDefined();
      });

      test("financed vehicleItems cannot bypass the single-vehicle contribution authority", async () => {
        const { t, orgId, asOwner, customerId, customerStatusId } = await setupMatrixEnv();

        const v1 = await t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId,
            vin: "VIN_ITEM_1",
            make: "Toyota",
            model: "Camry",
            year: 2024,
            mileage: 100,
            color: "White",
            fuelType: "Gasoline",
            transmission: "Auto",
            purchasePrice: 10_000,
            sellingPrice: 12_000,
            status: "AVAILABLE",
          })
        );
        const v2 = await t.run((ctx) =>
          ctx.db.insert("vehicles", {
            orgId,
            vin: "VIN_ITEM_2",
            make: "Toyota",
            model: "Corolla",
            year: 2024,
            mileage: 100,
            color: "Black",
            fuelType: "Gasoline",
            transmission: "Auto",
            purchasePrice: 11_000,
            sellingPrice: 13_000,
            status: "AVAILABLE",
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Items Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [customerStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId: v1,
            vehiclePrice: 10_000,
            vehicleItems: [
              { vehicleId: v1, unitPrice: 12_000 },
              { vehicleId: v2, unitPrice: 13_000 },
            ],
            downPayment: 15_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
          })
        ).rejects.toThrow(/exactly one vehicle/i);
      });

      test("direct API bypass attempt is rejected before quote insertion", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();

        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Direct API Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 500,
            ruleVersion: 1,
            acceptedStatuses: [customerStatusId],
          })
        );

        const beforeCount = (await t.run((ctx) => ctx.db.query("quotes").collect())).length;

        await expect(
          asOwner.rawMutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 20_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 500,
          })
        ).rejects.toThrow("Down payment must be less than the vehicle price for financed quotations.");

        const afterCount = (await t.run((ctx) => ctx.db.query("quotes").collect())).length;
        expect(afterCount).toBe(beforeCount);
      });

      test("assertFinancedQuoteContributionValid enforces identical semantics for marketplace and quotes", () => {
        // Valid ranges
        expect(() =>
          assertFinancedQuoteContributionValid({ vehiclePrice: 20_000, downPayment: 0 })
        ).not.toThrow();
        expect(() =>
          assertFinancedQuoteContributionValid({ vehiclePrice: 20_000, downPayment: 19_999 })
        ).not.toThrow();

        // Negative down payment
        expect(() =>
          assertFinancedQuoteContributionValid({ vehiclePrice: 20_000, downPayment: -1 })
        ).toThrow("Down payment cannot be negative.");

        // Equal down payment
        expect(() =>
          assertFinancedQuoteContributionValid({ vehiclePrice: 20_000, downPayment: 20_000 })
        ).toThrow("Down payment must be less than the vehicle price for financed quotations.");

        // Exceeding down payment
        expect(() =>
          assertFinancedQuoteContributionValid({ vehiclePrice: 20_000, downPayment: 25_000 })
        ).toThrow("Down payment must be less than the vehicle price for financed quotations.");
      });

      test("CASH mode allows downPayment = vehiclePrice without financed rejection", async () => {
        const { t, orgId, asOwner, customerId, vehicleId } = await setupMatrixEnv();

        const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
          orgId,
          customerId,
          vehicleId,
          vehiclePrice: 20_000,
          downPayment: 20_000,
          termMonths: 0,
          mode: "CASH",
        });
        expect(quoteId).toBeDefined();
      });
    });

    describe("Adversarial Review Seat 1 Round 13: Single Fee Authority Marketplace & Public Financing (S1-R13-H1)", () => {
      // 1. active company + adminFees: undefined + quotes.saveQuote -> reject
      test("active company + adminFees: undefined + quotes.saveQuote rejects", async () => {
        const { t, orgId, asOwner, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Unconfigured Fees Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            // adminFees: undefined,
            ruleVersion: 1,
            acceptedStatuses: [customerStatusId],
          })
        );

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 2_000,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 18_000,
          })
        ).rejects.toThrow(
          "Execution Fees are not configured for this finance company. Configure the expected execution fee amount, or enter 0 if none are charged, before generating a quotation."
        );
      });

      // 2. active company + adminFees: undefined + marketplace concrete finance offer -> reject
      // 3. marketplace rejection inserts no response/finance snapshot -> verify atomicity
      test("active company + adminFees: undefined + marketplace concrete finance offer rejects and inserts no response", async () => {
        const { t, orgId, asOwner, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Unconfigured Marketplace Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            // adminFees: undefined,
            ruleVersion: 1,
          })
        );

        const requestId = await t.run((ctx) =>
          ctx.db.insert("marketplaceRequests", {
            status: "MATCHED",
            buyerFirstName: "Ahmad",
            buyerPhone: "+962791234567",
            buyerCity: "Amman",
            make: "Toyota",
            model: "RAV4",
            paymentType: "FINANCE",
            buyerTimeframe: "ASAP",
            buyerIntent: "HOT",
            consentAcceptedAt: Date.now(),
            clientFingerprint: "fp-round13",
            expiresAt: Date.now() + 100000,
            createdAt: Date.now(),
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("marketplaceRequestMatches", {
            requestId,
            orgId,
            matchedAt: Date.now(),
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("marketplaceDealerProfiles", {
            orgId,
            isOptedIn: true,
            areas: ["Amman"],
            brandsCarried: ["Toyota"],
            badges: [],
            totalResponses: 0,
            totalAccepted: 0,
            tier: "FREE_FOUNDING",
            leadsUsedThisPeriod: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );

        const beforeCount = (await t.run((ctx) => ctx.db.query("marketplaceResponses").collect())).length;

        await expect(
          asOwner.mutation(api.marketplaceResponses.respond, {
            orgId,
            requestId,
            kind: "HAVE_MATCH",
            vehicleId,
            offerPriceJod: 20_000,
            downPayment: 4_000,
            termMonths: 48,
            financeCompanyId: companyId,
          })
        ).rejects.toThrow(
          "Execution Fees are not configured for this finance company. Configure the expected execution fee amount, or enter 0 if none are charged, before generating a finance offer."
        );

        const afterCount = (await t.run((ctx) => ctx.db.query("marketplaceResponses").collect())).length;
        expect(afterCount).toBe(beforeCount);
      });

      // 4. active company + adminFees: 0 + marketplace offer -> accept
      // 5. marketplace processingFees snapshot with explicit 0 -> exactly 0
      test("active company + adminFees: 0 + marketplace offer accepts with processingFees exactly 0", async () => {
        const { t, orgId, asOwner, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Zero Fee Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 0,
            ruleVersion: 1,
          })
        );

        const requestId = await t.run((ctx) =>
          ctx.db.insert("marketplaceRequests", {
            status: "MATCHED",
            buyerFirstName: "Sami",
            buyerPhone: "+962791234568",
            buyerCity: "Amman",
            make: "Toyota",
            model: "RAV4",
            paymentType: "FINANCE",
            buyerTimeframe: "ASAP",
            buyerIntent: "HOT",
            consentAcceptedAt: Date.now(),
            clientFingerprint: "fp-round13-zero",
            expiresAt: Date.now() + 100000,
            createdAt: Date.now(),
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("marketplaceRequestMatches", {
            requestId,
            orgId,
            matchedAt: Date.now(),
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("marketplaceDealerProfiles", {
            orgId,
            isOptedIn: true,
            areas: ["Amman"],
            brandsCarried: ["Toyota"],
            badges: [],
            totalResponses: 0,
            totalAccepted: 0,
            tier: "FREE_FOUNDING",
            leadsUsedThisPeriod: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );

        const result = await asOwner.mutation(api.marketplaceResponses.respond, {
          orgId,
          requestId,
          kind: "HAVE_MATCH",
          vehicleId,
          offerPriceJod: 20_000,
          downPayment: 4_000,
          termMonths: 48,
          financeCompanyId: companyId,
        });
        expect(result.responseId).toBeDefined();

        const responseDoc = await t.run((ctx) => ctx.db.get("marketplaceResponses", result.responseId));
        expect(responseDoc?.financeOffer).toBeDefined();
        expect(responseDoc?.financeOffer?.processingFees).toBe(0);
        expect(responseDoc?.financeOffer?.totalContractValue).toBeGreaterThan(0);
      });

      // 6. active company + positive adminFees -> normal calculation
      test("active company + positive adminFees normal calculation and snapshot with exact fees", async () => {
        const { t, orgId, asOwner, vehicleId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Standard Fee Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 350,
            ruleVersion: 1,
          })
        );

        const requestId = await t.run((ctx) =>
          ctx.db.insert("marketplaceRequests", {
            status: "MATCHED",
            buyerFirstName: "Rami",
            buyerPhone: "+962791234569",
            buyerCity: "Amman",
            make: "Toyota",
            model: "RAV4",
            paymentType: "FINANCE",
            buyerTimeframe: "ASAP",
            buyerIntent: "HOT",
            consentAcceptedAt: Date.now(),
            clientFingerprint: "fp-round13-positive",
            expiresAt: Date.now() + 100000,
            createdAt: Date.now(),
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("marketplaceRequestMatches", {
            requestId,
            orgId,
            matchedAt: Date.now(),
          })
        );
        await t.run((ctx) =>
          ctx.db.insert("marketplaceDealerProfiles", {
            orgId,
            isOptedIn: true,
            areas: ["Amman"],
            brandsCarried: ["Toyota"],
            badges: [],
            totalResponses: 0,
            totalAccepted: 0,
            tier: "FREE_FOUNDING",
            leadsUsedThisPeriod: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );

        const result = await asOwner.mutation(api.marketplaceResponses.respond, {
          orgId,
          requestId,
          kind: "HAVE_MATCH",
          vehicleId,
          offerPriceJod: 20_000,
          downPayment: 4_000,
          termMonths: 48,
          financeCompanyId: companyId,
        });

        const responseDoc = await t.run((ctx) => ctx.db.get("marketplaceResponses", result.responseId));
        expect(responseDoc?.financeOffer?.processingFees).toBe(350);
        expect(responseDoc?.financeOffer?.totalContractValue).toBeGreaterThan(0);
      });

      // 7. public website projection + adminFees: undefined -> must preserve undefined / not emit fake 0
      test("public website projection + adminFees: undefined preserves undefined and does not emit fake 0", async () => {
        const { t, orgId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Unconfigured Projection Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            // adminFees: undefined,
            ruleVersion: 1,
          })
        );
        const websiteSettingsId = await t.run((ctx) =>
          ctx.db.insert("websiteSettings", {
            orgId,
            enabled: true,
            status: "active",
            defaultLanguage: "ar",
            supportedLanguages: ["ar"],
            activeFinanceCompanyId: companyId,
            defaultSubdomain: "test-dealer",
            templateId: "classic",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );

        const projection = await t.run((ctx) => {
          return websitePublicProjection(ctx, orgId, {
            _id: websiteSettingsId,
            _creationTime: Date.now(),
            orgId,
            enabled: true,
            status: "active",
            defaultLanguage: "ar",
            supportedLanguages: ["ar"],
            activeFinanceCompanyId: companyId,
            defaultSubdomain: "test-dealer",
            templateId: "classic",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          } as any);
        });

        expect(projection.financeCompany).toBeDefined();
        expect(projection.financeCompany!.adminFees).toBeUndefined();
      });

      // 8. projection + explicit adminFees: 0 -> emit 0
      test("public website projection + explicit adminFees: 0 emits 0", async () => {
        const { t, orgId } = await setupMatrixEnv();
        const companyId = await t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId,
            name: "Zero Fee Projection Bank",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            defaultLtvPercent: 100,
            isActive: true,
            adminFees: 0,
            ruleVersion: 1,
          })
        );
        const websiteSettingsId = await t.run((ctx) =>
          ctx.db.insert("websiteSettings", {
            orgId,
            enabled: true,
            status: "active",
            defaultLanguage: "ar",
            supportedLanguages: ["ar"],
            activeFinanceCompanyId: companyId,
            defaultSubdomain: "zero-dealer",
            templateId: "classic",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        );

        const projection = await t.run((ctx) => {
          return websitePublicProjection(ctx, orgId, {
            _id: websiteSettingsId,
            _creationTime: Date.now(),
            orgId,
            enabled: true,
            status: "active",
            defaultLanguage: "ar",
            supportedLanguages: ["ar"],
            activeFinanceCompanyId: companyId,
            defaultSubdomain: "zero-dealer",
            templateId: "classic",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          } as any);
        });

        expect(projection.financeCompany).toBeDefined();
        expect(projection.financeCompany!.adminFees).toBe(0);
      });

      // 9. personalized marketplace matching + unknown fees -> no calculated estimate/snapshot
      test("personalized marketplace matching + unknown fees returns null", () => {
        const result = computePersonalizedFinance(
          20_000,
          {
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: undefined,
          },
          undefined
        );
        expect(result).toBeNull();
      });

      // 10. personalized matching + explicit zero -> calculate
      test("personalized marketplace matching + explicit zero calculates with processingFees: 0", () => {
        const result = computePersonalizedFinance(
          20_000,
          {
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 0,
          },
          undefined
        );
        expect(result).not.toBeNull();
        expect(result!.snapshot.processingFees).toBe(0);
        expect(result!.monthly).toBeGreaterThan(0);
      });

      // 11. marketplace browse + unknown fees -> no monthly estimate
      test("marketplace browse + unknown fees returns null (no monthly estimate)", () => {
        const estimate = estimateMonthlyPayment(20_000, {
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          adminFees: undefined,
        });
        expect(estimate).toBeNull();
      });

      test("marketplace browse + explicit zero calculates monthly estimate", () => {
        const estimate = estimateMonthlyPayment(20_000, {
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          adminFees: 0,
        });
        expect(estimate).not.toBeNull();
        expect(estimate).toBeGreaterThan(0);
      });

      // 12. affordability + unknown fees -> company excluded from calculated range
      test("affordability + unknown fees excludes company from calculated range", () => {
        const range = computeAffordabilityRange(
          [
            {
              profitRate: 5,
              maxTermMonths: 60,
              gracePeriodMonths: 0,
              adminFees: undefined,
            },
          ],
          { maximumMonthlyPayment: 400, downPayment: 3000, termMonths: 60 }
        );
        expect(range).toBeNull();
      });

      test("affordability + explicit zero includes company in calculated range", () => {
        const range = computeAffordabilityRange(
          [
            {
              profitRate: 5,
              maxTermMonths: 60,
              gracePeriodMonths: 0,
              adminFees: 0,
            },
          ],
          { maximumMonthlyPayment: 400, downPayment: 3000, termMonths: 60 }
        );
        expect(range).not.toBeNull();
        expect(range!.companiesConsidered).toBe(1);
        expect(range!.maxPriceJod).toBeGreaterThan(0);
      });

      // 13. smart reply calculated mode + unknown fees -> generic financing reply, not calculated amount
      test("smart reply calculated mode + unknown fees falls back to generic financing reply", () => {
        const reply = buildSmartReplyText({
          intent: "financing",
          vehicle: {
            model: "Camry",
            year: 2024,
            sellingPrice: 25_000,
            status: "AVAILABLE",
            mileage: 0,
            color: "Silver",
            fuelType: "Hybrid",
            transmission: "Auto",
          },
          orgSettings: {
            smartReplyFinancingMode: "calculated",
            smartReplyDefaultDownPaymentPercent: 20,
          },
          financeCompany: {
            name: "Unconfigured Bank",
            isActive: true,
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: undefined,
          },
          locale: "en",
        });
        expect(reply).not.toBeNull();
        // Falls back to generic financing text which does not include a calculated monthly installment
        expect(reply).toContain("personalized monthly rate");
        expect(reply).not.toContain("/month");
      });

      // 14. smart reply + explicit zero -> calculated reply permitted
      test("smart reply calculated mode + explicit zero produces calculated reply with monthly installment", () => {
        const reply = buildSmartReplyText({
          intent: "financing",
          vehicle: {
            model: "Camry",
            year: 2024,
            sellingPrice: 25_000,
            status: "AVAILABLE",
            mileage: 0,
            color: "Silver",
            fuelType: "Hybrid",
            transmission: "Auto",
          },
          orgSettings: {
            smartReplyFinancingMode: "calculated",
            smartReplyDefaultDownPaymentPercent: 20,
          },
          financeCompany: {
            name: "Zero Fee Bank",
            isActive: true,
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            adminFees: 0,
          },
          locale: "en",
        });
        expect(reply).not.toBeNull();
        expect(reply).toContain("estimated monthly payments start from");
        expect(reply).toContain("/month");
      });

      // 15. repo regression ensuring no financing-authority code uses adminFees ?? 0 or manualExecutionFees ?? 0 where undefined means unknown
      test("source policy: no financing code collapses adminFees/manualExecutionFees ?? 0 or || 0", () => {
        const targetDirs = [
          path.join(process.cwd(), "convex"),
          path.join(process.cwd(), "components", "sales"),
          path.join(process.cwd(), "apps", "mobile", "src", "features", "workspace", "salesWizard"),
          path.join(process.cwd(), "app", "dealer-site"),
        ];
        const forbiddenPattern = /(?:adminFees|manualExecutionFees)\s*(?:\?\?|\|\|)\s*0/;
        const violations: string[] = [];

        function scan(dir: string) {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (
                entry.name === "_generated" ||
                entry.name === "node_modules" ||
                entry.name === ".git"
              ) {
                continue;
              }
              scan(full);
            } else if (
              (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
              !entry.name.endsWith(".test.ts") &&
              !entry.name.endsWith(".test.tsx") &&
              !entry.name.endsWith(".spec.ts") &&
              !entry.name.endsWith(".spec.tsx")
            ) {
              const content = fs.readFileSync(full, "utf-8");
              if (forbiddenPattern.test(content)) {
                violations.push(path.relative(process.cwd(), full));
              }
            }
          }
        }

        for (const dir of targetDirs) {
          scan(dir);
        }

        expect(violations).toEqual([]);
      });
    });

    describe("Adversarial Review Seat 1 Round 10: Customer Eligibility Authority (S1-R10-H1)", () => {
      test("Case 1: Company accepts status A, customer submits status A -> quote accepted, snapshot frozen with matched status and human-readable label", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Salaried Employee",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Alpha Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot).toBeDefined();
        expect(quote.customerEligibilitySnapshot?.selectedStatuses?.map((s: { statusId: string }) => s.statusId)).toEqual([statusA]);
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusA]);
        expect(quote.customerEligibilitySnapshot?.companyAcceptedStatusIds).toEqual([statusA]);
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusA, label: "Salaried Employee" },
        ]);
        expect(typeof quote.customerEligibilitySnapshot?.evaluatedAt).toBe("number");
      });

      test("Case 2: Company accepts A or B, customer submits B -> accepted, snapshot reflects matched B", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Salaried Employee",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Business Owner",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Beta Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA, statusB],
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
          customerEligibilityStatusIds: [statusB],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusB]);
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusB, label: "Business Owner" },
        ]);
      });

      test("Case 3: Company accepts A, customer submits C -> rejected at saveQuote boundary", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Salaried Employee",
            isActive: true,
            order: 1,
          })
        );
        const statusC = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Student",
            isActive: true,
            order: 3,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Gamma Bank",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [statusC],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/This finance company does not accept the selected customer eligibility status/);
      });

      test("Case 4: Company acceptedStatuses is undefined (accepts all) -> customer with any valid status accepted", async () => {
        const { asOwner, t, orgId, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Universal Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: undefined,
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
          customerEligibilityStatusIds: [customerStatusId],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.companyAcceptedStatusIds).toBeUndefined();
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([customerStatusId]);
      });

      test("Case 5: Company acceptedStatuses is empty array (accepts all) -> customer with any valid status accepted", async () => {
        const { asOwner, t, orgId, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Open Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [],
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
          customerEligibilityStatusIds: [customerStatusId],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        // Empty array on the company is stored faithfully; the assertion function
        // treats [] and undefined equivalently ("accepts all").
        expect(
          quote.customerEligibilitySnapshot?.companyAcceptedStatusIds === undefined ||
          (Array.isArray(quote.customerEligibilitySnapshot?.companyAcceptedStatusIds) &&
           quote.customerEligibilitySnapshot!.companyAcceptedStatusIds!.length === 0)
        ).toBe(true);
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([customerStatusId]);
      });

      test("Case 6: No selected customer status (empty array or undefined) -> rejected for configured quote", async () => {
        const { asOwner, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Strict Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        // 1. Explicit empty array
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status is required for configured finance company quotes/);

        // 2. Missing/undefined via rawMutation
        await expect(
          asOwner.rawMutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status is required for configured finance company quotes/);
      });

      test("Case 7: Selected status belongs to another organization -> rejected at saveQuote boundary", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const otherOrgId = await t.run((ctx) =>
          ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
        );
        const foreignStatusId = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId: otherOrgId,
            label: "Foreign Status",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Tenant Guard Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [foreignStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status not found in this organization/);
      });

      test("Case 8: Selected status does not exist -> rejected at saveQuote boundary", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const dummyStatusId = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "To Be Deleted",
            isActive: true,
            order: 1,
          })
        );
        await t.run((ctx) => ctx.db.delete(dummyStatusId));

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Existence Guard Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [dummyStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status not found in this organization/);
      });

      test("Case 9: Selected status is inactive -> rejected at saveQuote boundary", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const inactiveStatusId = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Archived Status",
            isActive: false,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Active Status Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [inactiveStatusId],
        });

        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [inactiveStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Customer eligibility status is inactive or unavailable/);
      });

      test("Case 10: Duplicate submitted status IDs -> canonicalized deterministically in snapshot without duplicates", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status Alpha",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status Beta",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "De-dup Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA, statusB],
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
          customerEligibilityStatusIds: [statusA, statusA, statusB, statusA],
          totalFinancedAmount: 20_000,
        });

        const quote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(quote.customerEligibilitySnapshot?.selectedStatuses?.map((s: { statusId: string }) => s.statusId)).toEqual([statusA, statusB]);
        expect(quote.customerEligibilitySnapshot?.matchedStatusIds).toEqual([statusA, statusB]);
        expect(quote.customerEligibilitySnapshot?.selectedStatuses).toHaveLength(2);
      });

      test("Case 11: Direct API eligibility bypass (calling saveQuote directly with ineligible status) -> rejected", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusAccepted = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Accepted Tier",
            isActive: true,
            order: 1,
          })
        );
        const statusUnaccepted = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Unaccepted Tier",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "API Protected Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusAccepted],
        });

        // Direct call bypassing client-side wizard filtering
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [statusUnaccepted],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/This finance company does not accept the selected customer eligibility status/);
      });

      test("Case 12: TOCTOU / Stale UI: company acceptedStatuses changes from A to B before saveQuote -> rejected", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status A",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status B",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "TOCTOU Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
        });

        // Company updates to only accept B while client was sitting on wizard Step 1/2
        await asOwner.mutation(api.finance.updateCompany, {
          id: companyId,
          orgId,
          expectedEditRevision: 1,
          name: "TOCTOU Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusB],
        });

        // Stale client submits quote with status A -> rejected by server-authoritative check
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 48,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [statusA],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/This finance company does not accept the selected customer eligibility status/);
      });

      test("Case 13: Frozen quote lineage: quote created under A remains valid when company policy changes to B; createFromQuote succeeds from snapshot", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status A",
            isActive: true,
            order: 1,
          })
        );
        const statusB = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status B",
            isActive: true,
            order: 2,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Lineage Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        // Company updates to only accept B
        await asOwner.mutation(api.finance.updateCompany, {
          id: companyId,
          orgId,
          expectedEditRevision: 1,
          name: "Lineage Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusB],
        });

        // createFromQuote succeeds because quote's eligibility was frozen at quotation time
        const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        expect(applicationId).toBeDefined();

        const app = (await t.run((ctx) => ctx.db.get("financeApplications", applicationId)))!;
        expect(app.status).toBe("PENDING_DOCS");
      });

      test("Case 14: Frozen quote lineage: status document deleted/deactivated after quote creation -> createFromQuote still succeeds from snapshot", async () => {
        const { asOwner, t, orgId, customerId, vehicleId } = await setupMatrixEnv();

        const statusA = await t.run((ctx) =>
          ctx.db.insert("orgCustomerStatuses", {
            orgId,
            label: "Status Temporary",
            isActive: true,
            order: 1,
          })
        );

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Doc Deletion Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
          acceptedStatuses: [statusA],
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
          customerEligibilityStatusIds: [statusA],
          totalFinancedAmount: 20_000,
        });

        // Status row is hard deleted
        await t.run((ctx) => ctx.db.delete(statusA));

        // createFromQuote still succeeds because quote holds the frozen snapshot
        const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
        expect(applicationId).toBeDefined();

        const savedQuote = (await t.run((ctx) => ctx.db.get("quotes", quoteId)))!;
        expect(savedQuote.customerEligibilitySnapshot?.selectedStatuses).toEqual([
          { statusId: statusA, label: "Status Temporary" },
        ]);
      });

      test("Case 15: Term validation at saveQuote boundary rejects invalid terms", async () => {
        const { asOwner, t, orgId, customerId, vehicleId, customerStatusId } = await setupMatrixEnv();

        const companyId = await asOwner.mutation(api.finance.createCompany, {
          orgId,
          name: "Term Guard Finance",
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 6,
          defaultLtvPercent: 100,
          isActive: true,
          adminFees: 500,
        });

        // 1. termMonths <= 0
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 0,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Term months must be a positive integer/);

        // 2. termMonths > company.maxTermMonths
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 72,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/exceeds maximum term allowed by finance company/);

        // 3. gracePeriodMonths >= termMonths
        await expect(
          asOwner.mutation(api.quotes.saveQuote, {
            orgId,
            customerId,
            vehicleId,
            vehiclePrice: 20_000,
            downPayment: 0,
            termMonths: 6,
            mode: "CONFIGURED_FINANCE_COMPANY",
            companyId,
            customerEligibilityStatusIds: [customerStatusId],
            totalFinancedAmount: 20_000,
          })
        ).rejects.toThrow(/Finance term must be strictly greater than the grace period/);
      });
    });
  });
});
