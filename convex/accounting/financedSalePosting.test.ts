import { describe, expect, test } from "vitest";
import {
  ruleSaleCompleted,
  validateBalance,
  type FinancedSalePlanPayload,
  type SaleCompletedPayload,
} from "./postingRules";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * How an external financed sale settled THROUGH_DEALERSHIP reaches the ledger.
 *
 * The defect this replaces opened the finance-company receivable from
 * `quote.totalFinancedAmount` — the customer's Murabaha principal. That number
 * is neither what the financing company owes the dealership nor what the
 * customer owes it, and it was used as both the gate and the amount. On a deal
 * billed 5,000 against a 9,000 principal it credited AR-Customers 9,000 against
 * a 5,000 debit, leaving the customer's account 4,000 in credit for a debt
 * they never had.
 *
 * The replacement recognises the split directly at completion. The financing
 * company is the legal buyer of the car, so the vehicle consideration is a
 * claim on the company from the start and is never routed through the
 * customer's receivable in order to be taken out again.
 *
 * These assert per-account amounts rather than only that the entry balances.
 * Both wrong answers this design rejects — the principal fallback, and the
 * literal one-number swap — produce BALANCED journals, so `validateBalance`
 * cannot see either of them.
 */

const jod = (major: number): number => Math.round(major * 1000);

function plan(over: Partial<FinancedSalePlanPayload> = {}): FinancedSalePlanPayload {
  return {
    version: 1,
    fingerprint: "v1;JOD;L12500000;G12500000;N11125000;P0;C0;H0;FEE:fee_1:DEALER_CONCESSION:DEBIT:1375000",
    financeCompanyId: "fc_1",
    legalInvoiceConsiderationMinor: jod(12_500),
    financeCompanyReceivableMinor: jod(11_125),
    financeCompanyPayableMinor: 0,
    customerReceivableMinor: 0,
    depositLiabilityAppliedMinor: 0,
    components: [
      {
        sourceKind: "FEE",
        sourceId: "fee_1",
        label: "Netted dealer contribution",
        amountMinor: jod(1_375),
        treatment: "DEALER_CONCESSION",
        systemKey: SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS,
        side: "DEBIT",
      },
    ],
    ...over,
  };
}

function sale(over: Partial<SaleCompletedPayload> = {}): SaleCompletedPayload {
  return {
    saleId: "sale_fin_1",
    // The dealership's own operational figure. Deliberately NOT the legal
    // invoice: a 10,500 target against a 12,500 invoice to the financier is the
    // ordinary shape of these deals.
    saleAmountMinor: jod(10_500),
    currency: "JOD",
    customerId: "cust_1",
    vehicleId: "veh_1",
    salespersonId: "user_1",
    consignmentEvaluated: true,
    taxConventionExclusive: true,
    financedSalePlan: plan(),
    ...over,
  };
}

/** Net movement on one account across the whole entry, debit-positive. */
function net(result: ReturnType<typeof ruleSaleCompleted>, systemKey: string): number {
  return result.lines
    .filter((l) => l.accountSystemKey === systemKey)
    .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

describe("financed sale recognition — the owner-proxy worked control (c16207)", () => {
  test("revenue is the legal invoice, the finance company carries the receivable, and the customer carries nothing for the car", () => {
    const result = ruleSaleCompleted(sale());

    // Revenue is 12,500 — the invoice — not the 10,500 operational sale amount.
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(12_500));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES)).toBe(jod(11_125));
    expect(net(result, SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS)).toBe(jod(1_375));

    // The whole point: no customer receivable for the vehicle leg, in either
    // direction. The old rule left this at a large credit.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(
      result.lines.some((l) => l.accountSystemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)
    ).toBe(false);

    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("the contra-revenue leg REDUCES the top line rather than adding to it", () => {
    // Guards the normal-balance choice on account 4180. Both reports net by
    // normal balance, so a DEBIT-normal contra account would make this same
    // posting increase revenue to 13,875 and break the balance sheet.
    const consideration = SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS;
    const result = ruleSaleCompleted(sale());
    const contra = result.lines.find((l) => l.accountSystemKey === consideration);
    expect(contra?.debitMinor).toBe(jod(1_375));
    expect(contra?.creditMinor).toBe(0);
  });

  test("the customer still owes tax, dealer fees, warranty and GAP — only the car is the financier's", () => {
    const result = ruleSaleCompleted(
      sale({
        taxMinor: jod(200),
        dealerFeesMinor: jod(150),
        warrantySoldMinor: jod(300),
        gapSoldMinor: jod(100),
      })
    );
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(750));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES)).toBe(jod(11_125));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(200));
    expect(net(result, SYSTEM_KEYS.DEALER_FEE_INCOME)).toBe(-jod(150));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("a customer gap the plan says is genuinely owed does land in AR-Customers", () => {
    const result = ruleSaleCompleted(
      sale({
        financedSalePlan: plan({
          customerReceivableMinor: jod(500),
          financeCompanyReceivableMinor: jod(10_625),
          fingerprint: "v1-gap",
        }),
      })
    );
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(500));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("deductions above the gross credit a finance-company PAYABLE, never a negative receivable", () => {
    const result = ruleSaleCompleted(
      sale({
        saleAmountMinor: jod(1_000),
        financedSalePlan: plan({
          legalInvoiceConsiderationMinor: jod(1_000),
          financeCompanyReceivableMinor: 0,
          financeCompanyPayableMinor: jod(500),
          fingerprint: "v1-payable",
          components: [
            {
              sourceKind: "FEE",
              sourceId: "fee_big",
              label: "Finance company commission",
              amountMinor: jod(1_500),
              treatment: "FINANCE_COMPANY_COMMISSION",
              systemKey: SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE,
              side: "DEBIT",
            },
          ],
        }),
      })
    );
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_PAYABLE_FINANCE_COMPANIES)).toBe(-jod(500));
    // No receivable line at all, rather than one carrying zero or a negative.
    expect(
      result.lines.some(
        (l) => l.accountSystemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES
      )
    ).toBe(false);
    // And emphatically not netted against the supplier's payable.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)).toBe(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("each classified component posts to its own account — never summed into one bucket", () => {
    const result = ruleSaleCompleted(
      sale({
        financedSalePlan: plan({
          fingerprint: "v1-multi",
          components: [
            {
              sourceKind: "FEE",
              sourceId: "fee_a",
              label: "Finance company commission",
              amountMinor: jod(1_000),
              treatment: "FINANCE_COMPANY_COMMISSION",
              systemKey: SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE,
              side: "DEBIT",
            },
            {
              sourceKind: "FEE",
              sourceId: "fee_b",
              label: "Appraisal",
              amountMinor: jod(250),
              treatment: "APPRAISAL_EXPENSE",
              systemKey: SYSTEM_KEYS.APPRAISAL_EXPENSE,
              side: "DEBIT",
            },
            {
              sourceKind: "FEE",
              sourceId: "fee_c",
              label: "Ownership transfer",
              amountMinor: jod(125),
              treatment: "OWNERSHIP_TRANSFER_EXPENSE",
              systemKey: SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE,
              side: "DEBIT",
            },
          ],
        }),
      })
    );
    expect(net(result, SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE)).toBe(jod(1_000));
    expect(net(result, SYSTEM_KEYS.APPRAISAL_EXPENSE)).toBe(jod(250));
    expect(net(result, SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE)).toBe(jod(125));
    // Nothing swept into the generic bucket.
    expect(net(result, SYSTEM_KEYS.GENERAL_EXPENSE)).toBe(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("the customer's financing principal moves no ledger amount — the 5,000 billed / 9,000 principal counterexample", () => {
    // The principal is credit data. It appears nowhere in the payload, so the
    // only way it could reach the ledger is a fallback, and there is none.
    const result = ruleSaleCompleted(
      sale({
        saleAmountMinor: jod(5_000),
        financedSalePlan: plan({
          legalInvoiceConsiderationMinor: jod(5_000),
          financeCompanyReceivableMinor: jod(5_000),
          fingerprint: "v1-principal",
          components: [],
        }),
      })
    );
    const amounts = result.lines.map((l) => l.debitMinor + l.creditMinor);
    expect(amounts).not.toContain(jod(9_000));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES)).toBe(jod(5_000));
    // The defect's signature: AR-Customers driven to a credit balance.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBeGreaterThanOrEqual(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });
});

describe("financed sale recognition — what it must not disturb", () => {
  test("an ordinary cash sale posts exactly as before when no plan is attached", () => {
    const cash = sale({ financedSalePlan: undefined, saleAmountMinor: jod(20_000), taxMinor: jod(3_200) });
    const result = ruleSaleCompleted(cash);

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(23_200));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(-jod(3_200));
    expect(
      result.lines.some(
        (l) => l.accountSystemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES
      )
    ).toBe(false);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("a plan on a legacy tax-INCLUSIVE event refuses rather than posting two conventions at once", () => {
    expect(() => ruleSaleCompleted(sale({ taxConventionExclusive: undefined }))).toThrow(
      /legacy tax convention/i
    );
  });
});

describe("financed sale recognition — a deposit the dealership already banked (c16213)", () => {
  test("the deposit RELEASES the deposit liability and touches no cash account", () => {
    const result = ruleSaleCompleted(
      sale({
        saleAmountMinor: jod(20_000),
        financedSalePlan: plan({
          legalInvoiceConsiderationMinor: jod(20_000),
          financeCompanyReceivableMinor: jod(17_000),
          depositLiabilityAppliedMinor: jod(3_000),
          fingerprint: "v1-deposit",
          components: [],
        }),
      })
    );

    // The correction that matters. The deposit was banked when it was taken —
    // DR cash / CR deposit liability — so recognising the sale discharges that
    // liability. Debiting cash here instead would book the same 3,000 twice and
    // still balance, which is exactly why this asserts the account and not just
    // the total.
    expect(net(result, SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY)).toBe(jod(3_000));
    expect(net(result, SYSTEM_KEYS.BANK_ACCOUNT)).toBe(0);
    expect(net(result, SYSTEM_KEYS.CASH_ON_HAND)).toBe(0);

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES)).toBe(jod(17_000));
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(20_000));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("omitting the deposit leg would leave the entry short — the balance check catches it", () => {
    // Guards the leg itself rather than its account: without the release the
    // debits come to 17,000 against 20,000 of revenue.
    const result = ruleSaleCompleted(
      sale({
        saleAmountMinor: jod(20_000),
        financedSalePlan: plan({
          legalInvoiceConsiderationMinor: jod(20_000),
          financeCompanyReceivableMinor: jod(17_000),
          depositLiabilityAppliedMinor: jod(3_000),
          fingerprint: "v1-deposit-balance",
          components: [],
        }),
      })
    );
    const debits = result.lines.reduce((sum, l) => sum + l.debitMinor, 0);
    const credits = result.lines.reduce((sum, l) => sum + l.creditMinor, 0);
    expect(debits).toBe(jod(20_000));
    expect(credits).toBe(jod(20_000));
  });
});

/**
 * c16218: settlement funding and ownership basis are ORTHOGONAL.
 *
 * These two questions were competing top-level branches, and a consigned
 * financed sale answered only the second: it returned agent-basis lines and
 * dropped the plan, so the GL debited the customer for the gross while the
 * subledger opened a finance-company receivable for the same sale. The entry
 * balanced, which is why nothing caught it.
 *
 * Each of these asserts the EXACT line set, not merely that the entry balances.
 * Every wrong answer in this area balances.
 */
describe("funding and ownership basis, composed (c16218)", () => {
  const AGENT_GROSS = 20_000;
  const ENTITLEMENT = 15_000;
  const COMMISSION = AGENT_GROSS - ENTITLEMENT;

  const consignment = (over = {}) => ({
    supplierEntitlementMinor: jod(ENTITLEMENT),
    supplierName: "Amman Importer Co",
    settlementRoute: "THROUGH_DEALERSHIP" as const,
    externallyFinanced: true,
    financedByConfiguredCompany: true,
    ...over,
  });

  const consignedPlan = (over: Partial<FinancedSalePlanPayload> = {}) =>
    plan({
      legalInvoiceConsiderationMinor: jod(AGENT_GROSS),
      financeCompanyReceivableMinor: jod(17_000),
      depositLiabilityAppliedMinor: jod(3_000),
      customerReceivableMinor: 0,
      components: [],
      ...over,
    });

  const consignedSale = (over: Partial<SaleCompletedPayload> = {}) =>
    sale({
      saleAmountMinor: jod(AGENT_GROSS),
      consignment: consignment(),
      financedSalePlan: consignedPlan(),
      ...over,
    });

  /** Every line as [account, debit, credit], for an exact comparison. */
  const shape = (result: ReturnType<typeof ruleSaleCompleted>) =>
    result.lines.map((l) => [l.accountSystemKey, l.debitMinor, l.creditMinor]);

  test("the four facts of a consigned financed sale, and nothing else", () => {
    const result = ruleSaleCompleted(consignedSale());

    // c16218 §2's worked case, exactly.
    expect(shape(result)).toEqual([
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, jod(17_000), 0],
      [SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, jod(3_000), 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, jod(ENTITLEMENT)],
      [SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, jod(COMMISSION)],
    ]);

    // The company owes 17,000 · the deposit is already held · the supplier is
    // owed 15,000 · the dealership earned 5,000. Four facts, one entry.
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("no customer receivable, no dealership vehicle revenue, no inventory movement", () => {
    const result = ruleSaleCompleted(consignedSale());

    // The three things the old path did wrong, and the one thing routing this
    // through the owned branch would do wrong instead.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(0);
    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(0);
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(0);
  });

  test("with no deposit the company owes the whole gross", () => {
    const result = ruleSaleCompleted(
      consignedSale({
        financedSalePlan: consignedPlan({
          financeCompanyReceivableMinor: jod(AGENT_GROSS),
          depositLiabilityAppliedMinor: 0,
        }),
      })
    );

    expect(shape(result)).toEqual([
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, jod(AGENT_GROSS), 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, jod(ENTITLEMENT)],
      [SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, jod(COMMISSION)],
    ]);
  });

  test("a classified deduction reduces the funding side once, and leaves the agent basis alone", () => {
    // 20,000 gross = 15,625 still owed + 3,000 deposit + 1,375 withheld and
    // classified. The supplier is still owed 15,000 and the dealership still
    // earned 5,000 — who withheld what does not change whose car it was.
    const result = ruleSaleCompleted(
      consignedSale({
        financedSalePlan: consignedPlan({
          financeCompanyReceivableMinor: jod(15_625),
          components: [
            {
              sourceKind: "FEE",
              sourceId: "fee_1",
              label: "Netted dealer contribution",
              amountMinor: jod(1_375),
              treatment: "DEALER_CONCESSION",
              systemKey: SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS,
              side: "DEBIT",
            },
          ],
        }),
      })
    );

    expect(shape(result)).toEqual([
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES, jod(15_625), 0],
      [SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY, jod(3_000), 0],
      [SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS, jod(1_375), 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, jod(ENTITLEMENT)],
      [SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, jod(COMMISSION)],
    ]);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("what the customer separately owes is theirs, and only that", () => {
    const result = ruleSaleCompleted(
      consignedSale({
        financedSalePlan: consignedPlan({
          financeCompanyReceivableMinor: jod(16_000),
          customerReceivableMinor: jod(1_000),
        }),
      })
    );

    // 1,000, not 20,000. The distinction the defect erased.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(1_000));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES)).toBe(jod(16_000));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  // ── The shapes that must not have moved ──────────────────────────────────

  test("a cash consigned sale posts exactly what it always posted", () => {
    const result = ruleSaleCompleted(
      consignedSale({
        financedSalePlan: undefined,
        consignment: consignment({
          externallyFinanced: undefined,
          financedByConfiguredCompany: undefined,
        }),
      })
    );

    // Nobody else funded it, so the customer owes the gross — unchanged, and
    // the shape every consigned sale in history posted under.
    expect(shape(result)).toEqual([
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, jod(AGENT_GROSS), 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, jod(ENTITLEMENT)],
      [SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, jod(COMMISSION)],
    ]);
  });

  test("a lease is externally financed, has no configured company, and still posts", () => {
    // ⚠️ The first version of the fail-closed guard keyed on `externallyFinanced`
    // and refused every one of these. A lease carries no `companyId`, so no plan
    // is ever built for it and no finance-company receivable is opened on either
    // side — there is no divergence to prevent, and its gross really is the
    // customer's debt. The suite caught it, not inspection.
    const result = ruleSaleCompleted(
      consignedSale({
        financedSalePlan: undefined,
        consignment: consignment({ financedByConfiguredCompany: undefined }),
      })
    );

    expect(shape(result)).toEqual([
      [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, jod(AGENT_GROSS), 0],
      [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, jod(ENTITLEMENT)],
      [SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, jod(COMMISSION)],
    ]);
  });

  test("the direct route is untouched and opens no dealership finance receivable", () => {
    const result = ruleSaleCompleted(
      consignedSale({
        financedSalePlan: undefined,
        consignment: consignment({
          settlementRoute: "DIRECT_TO_SUPPLIER",
          supplierGrossReceiptMinor: jod(AGENT_GROSS),
        }),
      })
    );

    // The buyer paid the supplier; the only asset is the margin he owes back.
    expect(shape(result)).toEqual([
      [SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS, jod(COMMISSION), 0],
      [SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE, 0, jod(COMMISSION)],
    ]);
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES)).toBe(0);
  });

  // ── The refusals ─────────────────────────────────────────────────────────

  test("a configured-company consigned sale with no plan refuses rather than billing the customer", () => {
    // The silent failure this replaces: fall back to a gross Customer AR debit
    // and the entry balances, while the subledger names the finance company.
    expect(() =>
      ruleSaleCompleted(consignedSale({ financedSalePlan: undefined }))
    ).toThrow(/carries no settlement plan/i);
  });

  test("a legal invoice that disagrees with the proceeds refuses rather than plugging the gap", () => {
    // The supplier's entitlement and the commission are measured from the
    // proceeds; the funding side sums to the legal consideration. If those two
    // differ the entry is short by the difference — and the difference is not
    // evidence of a third amount.
    expect(() =>
      ruleSaleCompleted(
        consignedSale({
          financedSalePlan: consignedPlan({
            legalInvoiceConsiderationMinor: jod(19_000),
          }),
        })
      )
    ).toThrow(/must agree before this can post/i);
  });
});
