import { describe, expect, test } from "vitest";
import {
  deriveDealFinancialSummary,
  type DealFinancialSummaryInputs,
  type ServedParty,
} from "./dealFinancialSummary";
import type { DealProfit } from "./financingEconomics";

/**
 * The money formulas behind the deal overview.
 *
 * Every figure is read from a served input; the only arithmetic is a handful
 * of additions of served figures. These tests pin that nothing else is ever
 * invented — a missing input is a `null` with a reason, never a zero, and a
 * planned figure is never labelled paid.
 */

const JOD = "JOD";

const availableProfit: DealProfit = {
  available: true,
  basis: "MANAGEMENT_ESTIMATE",
  amountMinor: 1_250_000,
  currency: JOD,
  classification: "ESTIMATED_AWAITING_SETTLEMENT",
  postable: false,
  lines: [],
};

function party(
  partyName: ServedParty["party"],
  position: ServedParty["position"],
  amountMinor: number,
  currency = JOD
): ServedParty {
  return { party: partyName, position, amountMinor, currency };
}

function inputs(overrides: Partial<DealFinancialSummaryInputs> = {}): DealFinancialSummaryInputs {
  return {
    currency: JOD,
    routeKnown: true,
    settlesDirectToSupplier: false,
    parties: [
      party("CUSTOMER", "DEALERSHIP_HOLDS", 500_000),
      party("SUPPLIER", "DEALERSHIP_OWES", 9_000_000),
      party("FINANCIER", "OWED_TO_DEALERSHIP", 4_000_000),
    ],
    expenses: { actualTotalMinor: 150_000, awaitingActuals: 1, reason: null },
    profit: availableProfit,
    vehicleConsigned: true,
    app: {
      targetSellingAmountMinor: 12_000_000,
      submittedQuotationMinor: 11_500_000,
      approvedDealerPurchaseAmountMinor: 11_000_000,
      financeCompanyFundedPortionMinor: 9_350_000,
      dealerContributionMinor: 1_650_000,
      customerFirstPaymentMinor: 1_000_000,
      customerGapCashToDealerMinor: 200_000,
      expectedDealerRemittanceMinor: 9_200_000,
    },
    expectedDealerBorne: { totalMinor: 400_000, remainingMinor: 250_000, reason: null },
    ...overrides,
  };
}

describe("deriveDealFinancialSummary", () => {
  test("serves each figure from its own authority, and the profit untouched", () => {
    const s = deriveDealFinancialSummary(inputs());
    expect(s.currency).toBe(JOD);
    expect(s.approvedPurchaseAmountMinor).toBe(11_000_000);
    expect(s.financier.fundedPortionMinor).toBe(9_350_000);
    expect(s.customerFirstPaymentMinor).toBe(1_000_000);
    expect(s.profit).toBe(availableProfit);
  });

  describe("customer sale price basis: legal invoice → submitted quotation → target", () => {
    test("the legal invoice wins when recorded", () => {
      const s = deriveDealFinancialSummary(
        inputs({ app: { ...inputs().app, legalInvoiceAmountMinor: 12_345_000 } })
      );
      expect(s.customerSalePrice).toEqual({ amountMinor: 12_345_000, basis: "LEGAL_INVOICE" });
    });
    test("a submitted quotation outranks the dealership's internal target", () => {
      expect(deriveDealFinancialSummary(inputs()).customerSalePrice).toEqual({
        amountMinor: 11_500_000,
        basis: "SUBMITTED_QUOTATION",
      });
    });
    test("the internal target is what is left before a quotation is submitted", () => {
      const s = deriveDealFinancialSummary(
        inputs({ app: { ...inputs().app, submittedQuotationMinor: undefined } })
      );
      expect(s.customerSalePrice).toEqual({ amountMinor: 12_000_000, basis: "TARGET_SELLING_AMOUNT" });
    });
    test("null — not zero — when nothing is recorded", () => {
      expect(deriveDealFinancialSummary(inputs({ app: {} })).customerSalePrice).toBeNull();
    });
  });

  describe("what the customer paid the dealership", () => {
    test("the held deposit alone — the negotiated gap cash is served beside it as PLANNED, never inside the paid total", () => {
      const s = deriveDealFinancialSummary(inputs());
      expect(s.customerPaidToDealer).toEqual({ heldDepositMinor: 500_000, totalMinor: 500_000 });
      expect(s.customerGapCashPlannedMinor).toBe(200_000);
    });
    test("resolving a gap alone does not increase paid cash: the same deposits before and after the allocation", () => {
      const before = deriveDealFinancialSummary(
        inputs({ app: { ...inputs().app, customerGapCashToDealerMinor: undefined } })
      );
      const after = deriveDealFinancialSummary(
        inputs({ app: { ...inputs().app, customerGapCashToDealerMinor: 750_000 } })
      );
      expect(before.customerPaidToDealer).toEqual(after.customerPaidToDealer);
      expect(after.customerPaidToDealer?.totalMinor).toBe(500_000);
      expect(before.customerGapCashPlannedMinor).toBeNull();
      expect(after.customerGapCashPlannedMinor).toBe(750_000);
    });
    test("withheld when the customer row is UNKNOWN (unreadable deposit or unknown route)", () => {
      expect(
        deriveDealFinancialSummary(inputs({ parties: [party("CUSTOMER", "UNKNOWN", 0)] })).customerPaidToDealer
      ).toBeNull();
    });
    test("withheld when the customer row is in another currency", () => {
      expect(
        deriveDealFinancialSummary(inputs({ parties: [party("CUSTOMER", "DEALERSHIP_HOLDS", 500, "USD")] }))
          .customerPaidToDealer
      ).toBeNull();
    });
    test("a customer who put nothing in reads as zero, not as unknown", () => {
      const s = deriveDealFinancialSummary(
        inputs({
          parties: [party("CUSTOMER", "NOT_INVOLVED", 0)],
          app: { ...inputs().app, customerGapCashToDealerMinor: undefined },
        })
      );
      expect(s.customerPaidToDealer).toEqual({ heldDepositMinor: 0, totalMinor: 0 });
    });
  });

  describe("the financier's remaining balance: estimated before a receivable, actual after", () => {
    test("OUTSTANDING from the receivable once one exists, on the through-dealership route", () => {
      expect(deriveDealFinancialSummary(inputs()).financier.outstanding).toEqual({
        state: "OUTSTANDING",
        amountMinor: 4_000_000,
        basis: "RECEIVABLE",
      });
    });
    test("COLLECTED when the receivable is settled", () => {
      const s = deriveDealFinancialSummary(inputs({ parties: [party("FINANCIER", "SETTLED", 0)] }));
      expect(s.financier.outstanding).toEqual({ state: "COLLECTED", amountMinor: 0, basis: "RECEIVABLE" });
    });
    test("before finalization the expected remittance is served as an ESTIMATE, labelled as one", () => {
      const s = deriveDealFinancialSummary(inputs({ parties: [party("FINANCIER", "NOT_INVOLVED", 0)] }));
      expect(s.financier.outstanding).toEqual({
        state: "ESTIMATED_PRE_RECEIVABLE",
        amountMinor: 9_200_000,
        basis: "EXPECTED_DEALER_REMITTANCE",
      });
    });
    test("the estimate gives way to the receivable the moment one exists — never both", () => {
      const before = deriveDealFinancialSummary(inputs({ parties: [party("FINANCIER", "NOT_INVOLVED", 0)] }));
      const after = deriveDealFinancialSummary(inputs({ parties: [party("FINANCIER", "OWED_TO_DEALERSHIP", 9_150_000)] }));
      expect(before.financier.outstanding.basis).toBe("EXPECTED_DEALER_REMITTANCE");
      expect(after.financier.outstanding).toEqual({ state: "OUTSTANDING", amountMinor: 9_150_000, basis: "RECEIVABLE" });
    });
    test("NOT_YET_RECEIVABLE when no receivable exists and no remittance was ever expected", () => {
      const s = deriveDealFinancialSummary(
        inputs({
          parties: [party("FINANCIER", "NOT_INVOLVED", 0)],
          app: { ...inputs().app, expectedDealerRemittanceMinor: undefined },
        })
      );
      expect(s.financier.outstanding).toEqual({ state: "NOT_YET_RECEIVABLE", amountMinor: null, basis: null });
    });
    test("NONE_DIRECT_ROUTE when the financier pays the supplier — even with an expected remittance on file", () => {
      const s = deriveDealFinancialSummary(
        inputs({ settlesDirectToSupplier: true, parties: [party("FINANCIER", "NOT_INVOLVED", 0)] })
      );
      expect(s.financier.outstanding).toEqual({ state: "NONE_DIRECT_ROUTE", amountMinor: null, basis: null });
    });
    test("UNKNOWN when the route is unknown or the balance cannot be stated", () => {
      expect(deriveDealFinancialSummary(inputs({ routeKnown: false })).financier.outstanding.state).toBe("UNKNOWN");
      expect(
        deriveDealFinancialSummary(inputs({ parties: [party("FINANCIER", "UNKNOWN", 0)] })).financier.outstanding.state
      ).toBe("UNKNOWN");
    });
  });

  describe("the dealership's outlay — planned, recorded, expected, never 'paid'", () => {
    test("the four facts and the two totals", () => {
      expect(deriveDealFinancialSummary(inputs()).dealerOutlay).toEqual({
        plannedContributionMinor: 1_650_000,
        recordedCostsMinor: 150_000,
        recordedCostsReason: null,
        awaitingActuals: 1,
        knownCommittedMinor: 1_800_000,
        expectedCostsRemainingMinor: 250_000,
        expectedCostsReason: null,
        totalExpectedMinor: 2_050_000,
        aggregateReason: null,
      });
    });
    test("no contribution on record: nothing is totalled", () => {
      const s = deriveDealFinancialSummary(inputs({ app: { ...inputs().app, dealerContributionMinor: undefined } }));
      expect(s.dealerOutlay.plannedContributionMinor).toBeNull();
      expect(s.dealerOutlay.knownCommittedMinor).toBeNull();
      expect(s.dealerOutlay.totalExpectedMinor).toBeNull();
      expect(s.dealerOutlay.recordedCostsMinor).toBe(150_000);
    });
    test("no policy configured: the known subtotal stands, the expected total is unknown — not zero", () => {
      const s = deriveDealFinancialSummary(inputs({ expectedDealerBorne: { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" } }));
      expect(s.dealerOutlay.knownCommittedMinor).toBe(1_800_000);
      expect(s.dealerOutlay.expectedCostsRemainingMinor).toBeNull();
      expect(s.dealerOutlay.expectedCostsReason).toBe("NO_POLICY");
      expect(s.dealerOutlay.totalExpectedMinor).toBeNull();
      const mixed = deriveDealFinancialSummary(inputs({ expectedDealerBorne: { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" } }));
      expect(mixed.dealerOutlay.expectedCostsReason).toBe("MIXED_DENOMINATION");
      expect(mixed.dealerOutlay.totalExpectedMinor).toBeNull();
    });
    test("a policy fully recorded leaves zero remaining and the total equals the known figure", () => {
      const s = deriveDealFinancialSummary(inputs({ expectedDealerBorne: { totalMinor: 400_000, remainingMinor: 0, reason: null } }));
      expect(s.dealerOutlay.expectedCostsRemainingMinor).toBe(0);
      expect(s.dealerOutlay.totalExpectedMinor).toBe(1_800_000);
    });
  });

  describe("the supplier — consignment (SOURCED) vs owned (PURCHASED)", () => {
    test("consigned, through the dealership: owed BY the dealership", () => {
      expect(deriveDealFinancialSummary(inputs()).supplier).toEqual({
        consigned: true,
        direction: "DEALERSHIP_OWES",
        amountMinor: 9_000_000,
        route: "THROUGH_DEALERSHIP",
      });
    });
    test("consigned, direct route: the margin is owed TO the dealership", () => {
      const s = deriveDealFinancialSummary(
        inputs({ settlesDirectToSupplier: true, parties: [party("SUPPLIER", "OWED_TO_DEALERSHIP", 1_250_000)] })
      ).supplier;
      expect(s.direction).toBe("OWED_TO_DEALERSHIP");
      expect(s.amountMinor).toBe(1_250_000);
      expect(s.route).toBe("DIRECT_TO_SUPPLIER");
    });
    test("an owned vehicle has no supplier obligation", () => {
      const s = deriveDealFinancialSummary(
        inputs({ vehicleConsigned: false, parties: [party("SUPPLIER", "NOT_INVOLVED", 0)] })
      ).supplier;
      expect(s.consigned).toBe(false);
      expect(s.direction).toBe("NOT_INVOLVED");
      expect(s.amountMinor).toBe(0);
    });
    test("an unknown route withholds the amount rather than reporting nothing owed", () => {
      const s = deriveDealFinancialSummary(
        inputs({ routeKnown: false, parties: [party("SUPPLIER", "UNKNOWN", 0)] })
      ).supplier;
      expect(s.direction).toBe("UNKNOWN");
      expect(s.amountMinor).toBeNull();
      expect(s.route).toBe("UNKNOWN");
    });
  });

  test("recorded costs withheld for a foreign dealer-borne line: committed and total are withheld with it, the contribution stands alone", () => {
    const s = deriveDealFinancialSummary(
      inputs({
        expenses: { actualTotalMinor: null, awaitingActuals: 2, reason: "MIXED_DENOMINATION" },
        expectedDealerBorne: { totalMinor: null, remainingMinor: null, reason: "MIXED_DENOMINATION" },
      })
    );
    expect(s.dealerOutlay).toEqual({
      plannedContributionMinor: 1_650_000,
      recordedCostsMinor: null,
      recordedCostsReason: "MIXED_DENOMINATION",
      awaitingActuals: 2,
      knownCommittedMinor: null,
      expectedCostsRemainingMinor: null,
      expectedCostsReason: "MIXED_DENOMINATION",
      totalExpectedMinor: null,
      aggregateReason: null,
    });
  });

  describe("the readable-total contract — a served total that is not a figure is withheld, never published", () => {
    test.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a fraction of a minor unit", 150_000.5],
      ["a negative total", -150_000],
      ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ])("a recorded total of %s is served null as UNSAFE_AMOUNT, and every total built on it is withheld", (_label, total) => {
      const s = deriveDealFinancialSummary(inputs({ expenses: { actualTotalMinor: total, awaitingActuals: 0, reason: null } }));
      expect(s.dealerOutlay).toMatchObject({
        plannedContributionMinor: 1_650_000,
        recordedCostsMinor: null,
        recordedCostsReason: "UNSAFE_AMOUNT",
        knownCommittedMinor: null,
        expectedCostsRemainingMinor: 250_000,
        totalExpectedMinor: null,
        aggregateReason: null,
      });
    });

    test("the caller's own UNSAFE_AMOUNT reason travels through with a null total", () => {
      const s = deriveDealFinancialSummary(inputs({ expenses: { actualTotalMinor: null, awaitingActuals: 1, reason: "UNSAFE_AMOUNT" } }));
      expect(s.dealerOutlay.recordedCostsMinor).toBeNull();
      expect(s.dealerOutlay.recordedCostsReason).toBe("UNSAFE_AMOUNT");
      expect(s.dealerOutlay.knownCommittedMinor).toBeNull();
      expect(s.dealerOutlay.totalExpectedMinor).toBeNull();
    });

    test("planned contribution + recorded costs that leave the safe range: both operands stand, the sums are withheld with the reason", () => {
      const nearMax = Number.MAX_SAFE_INTEGER - 1;
      const s = deriveDealFinancialSummary(
        inputs({
          app: { ...inputs().app, dealerContributionMinor: nearMax },
          expenses: { actualTotalMinor: 2, awaitingActuals: 0, reason: null },
        })
      );
      expect(s.dealerOutlay).toMatchObject({
        plannedContributionMinor: nearMax,
        recordedCostsMinor: 2,
        recordedCostsReason: null,
        knownCommittedMinor: null,
        expectedCostsRemainingMinor: 250_000,
        totalExpectedMinor: null,
        aggregateReason: "UNSAFE_AMOUNT",
      });
    });

    test("known outlay + expected remaining that leave the safe range: the known subtotal stands, the expected total is withheld with the reason", () => {
      const s = deriveDealFinancialSummary(
        inputs({
          app: { ...inputs().app, dealerContributionMinor: Number.MAX_SAFE_INTEGER - 150_001 },
          expectedDealerBorne: { totalMinor: 2, remainingMinor: 2, reason: null },
        })
      );
      expect(s.dealerOutlay.knownCommittedMinor).toBe(Number.MAX_SAFE_INTEGER - 1);
      expect(s.dealerOutlay.expectedCostsRemainingMinor).toBe(2);
      expect(s.dealerOutlay.totalExpectedMinor).toBeNull();
      expect(s.dealerOutlay.aggregateReason).toBe("UNSAFE_AMOUNT");
    });

    test("a valid same-currency deal is untouched by the contract: totals stand and no reason is served", () => {
      const s = deriveDealFinancialSummary(inputs());
      expect(s.dealerOutlay.recordedCostsReason).toBeNull();
      expect(s.dealerOutlay.aggregateReason).toBeNull();
      expect(s.dealerOutlay.knownCommittedMinor).toBe(1_800_000);
      expect(s.dealerOutlay.totalExpectedMinor).toBe(2_050_000);
    });
  });

  describe("the read boundary — every republished amount is a readable figure, or withheld and NAMED", () => {
    const CORRUPT: Array<[string, number]> = [
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["a fraction", 1_000_000.5],
      ["a negative", -1_000_000],
      ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ];

    test.each(CORRUPT)("app fields carrying %s are withheld one by one, each named, nothing turned into zero", (_label, corrupt) => {
      const s = deriveDealFinancialSummary(
        inputs({
          app: {
            legalInvoiceAmountMinor: corrupt,
            submittedQuotationMinor: 11_500_000,
            targetSellingAmountMinor: 12_000_000,
            approvedDealerPurchaseAmountMinor: corrupt,
            financeCompanyFundedPortionMinor: corrupt,
            dealerContributionMinor: corrupt,
            customerFirstPaymentMinor: corrupt,
            customerGapCashToDealerMinor: corrupt,
            expectedDealerRemittanceMinor: 9_200_000,
          },
        })
      );
      // A corrupt legal invoice does NOT fall through to the quotation: the
      // strongest document on record is the one that is withheld.
      expect(s.customerSalePrice).toBeNull();
      expect(s.approvedPurchaseAmountMinor).toBeNull();
      expect(s.financier.fundedPortionMinor).toBeNull();
      expect(s.customerFirstPaymentMinor).toBeNull();
      expect(s.customerGapCashPlannedMinor).toBeNull();
      expect(s.dealerOutlay.plannedContributionMinor).toBeNull();
      expect(s.dealerOutlay.knownCommittedMinor).toBeNull();
      expect(s.dealerOutlay.totalExpectedMinor).toBeNull();
      expect(s.unreadable.map((entry) => entry.field).sort()).toEqual(
        ["approvedPurchaseAmount", "customerFirstPayment", "customerGapCashPlanned", "customerSalePrice", "financierFundedPortion", "plannedContribution"].sort()
      );
      expect(s.unreadable.every((entry) => entry.reason === "UNSAFE_AMOUNT")).toBe(true);
      expect(JSON.stringify(s)).not.toContain(String(corrupt));
    });

    test.each(CORRUPT)("party amounts carrying %s: customer, supplier and financier figures are withheld and named", (_label, corrupt) => {
      const s = deriveDealFinancialSummary(
        inputs({
          parties: [
            party("CUSTOMER", "DEALERSHIP_HOLDS", corrupt),
            party("SUPPLIER", "DEALERSHIP_OWES", corrupt),
            party("FINANCIER", "OWED_TO_DEALERSHIP", corrupt),
          ],
        })
      );
      expect(s.customerPaidToDealer).toBeNull();
      expect(s.supplier.amountMinor).toBeNull();
      expect(s.supplier.direction).toBe("DEALERSHIP_OWES");
      expect(s.financier.outstanding).toEqual({ state: "UNKNOWN", amountMinor: null, basis: null });
      expect(s.unreadable.map((entry) => entry.field).sort()).toEqual(["customerPaidToDealer", "financierOutstanding", "supplierAmount"]);
    });

    test.each(CORRUPT)("an expected remittance of %s before a receivable exists is UNKNOWN, never an estimate", (_label, corrupt) => {
      const s = deriveDealFinancialSummary(
        inputs({
          parties: [party("FINANCIER", "NOT_INVOLVED", 0)],
          app: { ...inputs().app, expectedDealerRemittanceMinor: corrupt },
        })
      );
      expect(s.financier.outstanding).toEqual({ state: "UNKNOWN", amountMinor: null, basis: null });
      expect(s.unreadable).toContainEqual({ field: "financierOutstanding", reason: "UNSAFE_AMOUNT" });
    });

    test("absent is absent, not unreadable: a deal with nothing recorded names no field", () => {
      const s = deriveDealFinancialSummary(inputs({ parties: [], app: {} }));
      expect(s.unreadable).toEqual([]);
      expect(s.customerSalePrice).toBeNull();
      expect(s.approvedPurchaseAmountMinor).toBeNull();
    });

    test("a fully readable deal names no field and serves every figure", () => {
      const s = deriveDealFinancialSummary(inputs());
      expect(s.unreadable).toEqual([]);
      expect(s.customerPaidToDealer).toEqual({ heldDepositMinor: 500_000, totalMinor: 500_000 });
      expect(s.supplier.amountMinor).toBe(9_000_000);
      expect(s.financier.outstanding).toEqual({ state: "OUTSTANDING", amountMinor: 4_000_000, basis: "RECEIVABLE" });
    });
  });

  test("an empty deal — nothing recorded, no parties, no policy — is nulls with reasons and zero recorded costs", () => {
    const s = deriveDealFinancialSummary(
      inputs({
        parties: [],
        app: {},
        expenses: { actualTotalMinor: 0, awaitingActuals: 0, reason: null },
        expectedDealerBorne: { totalMinor: null, remainingMinor: null, reason: "NO_POLICY" },
        profit: { available: false, reason: "NoApprovedPurchaseAmount" },
        vehicleConsigned: null,
      })
    );
    expect(s.customerSalePrice).toBeNull();
    expect(s.approvedPurchaseAmountMinor).toBeNull();
    expect(s.customerPaidToDealer).toBeNull();
    expect(s.financier).toEqual({
      fundedPortionMinor: null,
      outstanding: { state: "NOT_YET_RECEIVABLE", amountMinor: null, basis: null },
    });
    expect(s.dealerOutlay).toEqual({
      plannedContributionMinor: null,
      recordedCostsMinor: 0,
      recordedCostsReason: null,
      awaitingActuals: 0,
      knownCommittedMinor: null,
      expectedCostsRemainingMinor: null,
      expectedCostsReason: "NO_POLICY",
      totalExpectedMinor: null,
      aggregateReason: null,
    });
    expect(s.supplier).toEqual({ consigned: null, direction: "UNKNOWN", amountMinor: null, route: "THROUGH_DEALERSHIP" });
    expect(s.profit.available).toBe(false);
  });
});
