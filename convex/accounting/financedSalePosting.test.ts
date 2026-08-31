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
