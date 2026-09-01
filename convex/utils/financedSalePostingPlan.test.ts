import { describe, expect, test } from "vitest";
import {
  buildFinancedSalePostingPlan,
  type FinancedSalePlanInput,
  type FinancedSalePostingPlan,
  type SettlementComponentInput,
} from "./financedSalePostingPlan";

/** JOD is a 3-decimal currency, so a dinar is 1000 minor units. */
const jod = (major: number) => Math.round(major * 1000);

function component(
  over: Partial<SettlementComponentInput> = {}
): SettlementComponentInput {
  return {
    sourceKind: "FEE",
    sourceId: "fee_1",
    label: "Finance company commission",
    amountMinor: jod(1_375),
    treatment: "FINANCE_COMPANY_COMMISSION",
    ...over,
  };
}

function input(over: Partial<FinancedSalePlanInput> = {}): FinancedSalePlanInput {
  return {
    currency: "JOD",
    legalInvoiceConsiderationMinor: jod(12_500),
    legalInvoiceIssuedTo: "FINANCE_COMPANY",
    financierIsConfiguredExternal: true,
    grossDealerSettlementMinor: jod(12_500),
    storedExpectedDealerRemittanceMinor: jod(11_125),
    components: [
      component({
        treatment: "DEALER_CONCESSION",
        label: "Netted dealer contribution",
      }),
    ],
    customerReceivableMinor: 0,
    depositLiabilityAppliedMinor: 0,
    ...over,
  };
}

function planOf(over: Partial<FinancedSalePlanInput> = {}): FinancedSalePostingPlan {
  const result = buildFinancedSalePostingPlan(input(over));
  if (!result.ok) {
    throw new Error(
      "expected a plan, got refusal " + result.refusal.code + ": " + result.refusal.message
    );
  }
  return result.plan;
}

function refusalOf(over: Partial<FinancedSalePlanInput> = {}) {
  const result = buildFinancedSalePostingPlan(input(over));
  if (result.ok) throw new Error("expected a refusal, got a plan");
  return result.refusal;
}

/**
 * Every plan must balance. This is the contract c16207 states directly — "sum(all
 * debit lines) = sum(all credit lines)" — not an incidental property, so it is
 * asserted on every shape rather than on the one case that motivated it.
 */
function assertBalanced(plan: FinancedSalePostingPlan): void {
  const debits =
    plan.financeCompanyReceivableMinor +
    plan.depositLiabilityAppliedMinor +
    plan.customerReceivableMinor +
    plan.components
      .filter((c) => c.side === "DEBIT")
      .reduce((sum, c) => sum + c.amountMinor, 0);
  const credits =
    plan.legalInvoiceConsiderationMinor +
    plan.financeCompanyPayableMinor +
    plan.components
      .filter((c) => c.side === "CREDIT")
      .reduce((sum, c) => sum + c.amountMinor, 0);
  expect(debits).toBe(credits);
}

describe("financed sale posting plan — the owner-proxy worked control (c16207)", () => {
  test("legal invoice 12,500 with a netted classified contribution of 1,375 recognises 11,125 as the finance receivable and posts NO customer AR for the vehicle leg", () => {
    const plan = planOf();

    expect(plan.legalInvoiceConsiderationMinor).toBe(jod(12_500));
    expect(plan.financeCompanyReceivableMinor).toBe(jod(11_125));
    expect(plan.totalDeductionsMinor).toBe(jod(1_375));
    expect(plan.financeCompanyPayableMinor).toBe(0);
    // The whole point of c16207: the vehicle consideration never originates as
    // customer debt, so there is nothing to transfer out of it afterwards.
    expect(plan.customerReceivableMinor).toBe(0);

    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]).toMatchObject({
      amountMinor: jod(1_375),
      treatment: "DEALER_CONCESSION",
      side: "DEBIT",
    });
    assertBalanced(plan);
  });

  test("the invariant N + D = G + P holds on the control", () => {
    const plan = planOf();
    expect(plan.financeCompanyReceivableMinor + plan.totalDeductionsMinor).toBe(
      plan.grossDealerSettlementMinor + plan.financeCompanyPayableMinor
    );
  });

  test("zero-deduction control: N equals G and the plan still balances", () => {
    const plan = planOf({
      components: [],
      storedExpectedDealerRemittanceMinor: jod(12_500),
    });
    expect(plan.financeCompanyReceivableMinor).toBe(jod(12_500));
    expect(plan.totalDeductionsMinor).toBe(0);
    expect(plan.financeCompanyPayableMinor).toBe(0);
    assertBalanced(plan);
  });

  test("multiple deductions with different treatments map independently and sum exactly", () => {
    const plan = planOf({
      components: [
        component({
          sourceId: "fee_a",
          amountMinor: jod(1_000),
          treatment: "FINANCE_COMPANY_COMMISSION",
        }),
        component({
          sourceId: "fee_b",
          amountMinor: jod(250),
          treatment: "APPRAISAL_EXPENSE",
        }),
        component({
          sourceId: "fee_c",
          amountMinor: jod(125),
          treatment: "OWNERSHIP_TRANSFER_EXPENSE",
        }),
      ],
    });
    expect(plan.totalDeductionsMinor).toBe(jod(1_375));
    expect(plan.financeCompanyReceivableMinor).toBe(jod(11_125));
    // Independently mapped: three distinct accounts, not one lumped total.
    expect(new Set(plan.components.map((c) => c.systemKey)).size).toBe(3);
    assertBalanced(plan);
  });

  test("D > G produces a finance-company PAYABLE, never a negative receivable", () => {
    const plan = planOf({
      legalInvoiceConsiderationMinor: jod(1_000),
      grossDealerSettlementMinor: jod(1_000),
      storedExpectedDealerRemittanceMinor: 0,
      components: [component({ amountMinor: jod(1_500) })],
    });
    expect(plan.financeCompanyReceivableMinor).toBe(0);
    expect(plan.financeCompanyPayableMinor).toBe(jod(500));
    expect(plan.financeCompanyReceivableMinor + plan.totalDeductionsMinor).toBe(
      plan.grossDealerSettlementMinor + plan.financeCompanyPayableMinor
    );
    assertBalanced(plan);
  });
});

describe("financed sale posting plan — refusals, all before any write", () => {
  test("a missing legal invoice refuses; revenue has no other authority", () => {
    expect(refusalOf({ legalInvoiceConsiderationMinor: undefined }).code).toBe(
      "LEGAL_INVOICE_MISSING"
    );
  });

  test("a legal invoice issued to the CUSTOMER on a configured external financier refuses", () => {
    expect(refusalOf({ legalInvoiceIssuedTo: "CUSTOMER" }).code).toBe(
      "LEGAL_INVOICE_WRONG_RECIPIENT"
    );
  });

  test("an unknown dealer remittance refuses rather than defaulting to gross", () => {
    expect(refusalOf({ storedExpectedDealerRemittanceMinor: undefined }).code).toBe(
      "REMITTANCE_UNKNOWN"
    );
  });

  test("stored economics that disagree with the recomputed plan refuse — never silently patched or clamped", () => {
    // Exactly the feeDeductionsMinor: 0 staleness. The stored figure was computed
    // with no fee rows, the plan recomputes with them, and the two disagree.
    expect(refusalOf({ storedExpectedDealerRemittanceMinor: jod(12_500) }).code).toBe(
      "REMITTANCE_STALE"
    );
  });

  test("a treatment with no supported account mapping refuses; it does not fall back to General Expense", () => {
    const refusal = refusalOf({
      components: [component({ treatment: "EMPLOYEE_PAYABLE" })],
      storedExpectedDealerRemittanceMinor: jod(11_125),
    });
    expect(refusal.code).toBe("TREATMENT_UNMAPPED");
    expect(refusal.message).toMatch(/EMPLOYEE_PAYABLE/);
  });

  test("a legal invoice disagreeing with the gross dealer settlement refuses rather than plugging the gap", () => {
    expect(refusalOf({ legalInvoiceConsiderationMinor: jod(13_000) }).code).toBe(
      "PLAN_UNBALANCED"
    );
  });

  test("a component with a non-positive amount refuses — an unrecorded deduction is not a zero one", () => {
    expect(
      refusalOf({
        components: [component({ amountMinor: 0 })],
        storedExpectedDealerRemittanceMinor: jod(12_500),
      }).code
    ).toBe("COMPONENT_AMOUNT_INVALID");
  });

  test("two components sharing one source id refuse — the same fee must not be deducted twice", () => {
    expect(
      refusalOf({
        components: [
          component({ sourceId: "dup", amountMinor: jod(1_000) }),
          component({ sourceId: "dup", amountMinor: jod(375) }),
        ],
      }).code
    ).toBe("COMPONENT_SOURCE_DUPLICATED");
  });
});

describe("financed sale posting plan — fingerprint", () => {
  test("the fingerprint is stable across component order but changes with any amount", () => {
    const a = planOf({
      components: [
        component({ sourceId: "fee_a", amountMinor: jod(1_000) }),
        component({
          sourceId: "fee_b",
          amountMinor: jod(375),
          treatment: "APPRAISAL_EXPENSE",
        }),
      ],
    });
    const b = planOf({
      components: [
        component({
          sourceId: "fee_b",
          amountMinor: jod(375),
          treatment: "APPRAISAL_EXPENSE",
        }),
        component({ sourceId: "fee_a", amountMinor: jod(1_000) }),
      ],
    });
    expect(a.fingerprint).toBe(b.fingerprint);

    // Same total, different split: a fingerprint that only hashed the sum would
    // call these identical and let a retry post the wrong components.
    const c = planOf({
      components: [
        component({ sourceId: "fee_a", amountMinor: jod(1_001) }),
        component({
          sourceId: "fee_b",
          amountMinor: jod(374),
          treatment: "APPRAISAL_EXPENSE",
        }),
      ],
    });
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });
});

describe("financed sale posting plan — the deposit is money the dealership already holds (c16213)", () => {
  test("a 3,000 deposit against a 20,000 invoice leaves the company owing 17,000, and the customer owing nothing", () => {
    const plan = planOf({
      legalInvoiceConsiderationMinor: jod(20_000),
      grossDealerSettlementMinor: jod(20_000),
      storedExpectedDealerRemittanceMinor: jod(20_000),
      components: [],
      depositLiabilityAppliedMinor: jod(3_000),
    });

    expect(plan.financeCompanyReceivableMinor).toBe(jod(17_000));
    expect(plan.depositLiabilityAppliedMinor).toBe(jod(3_000));
    expect(plan.customerReceivableMinor).toBe(0);
    expect(plan.financeCompanyPayableMinor).toBe(0);
    assertBalanced(plan);
  });

  test("the deposit changes only what the company still owes — never the invoice or the gross", () => {
    const withDeposit = planOf({
      legalInvoiceConsiderationMinor: jod(20_000),
      grossDealerSettlementMinor: jod(20_000),
      storedExpectedDealerRemittanceMinor: jod(20_000),
      components: [],
      depositLiabilityAppliedMinor: jod(3_000),
    });
    const without = planOf({
      legalInvoiceConsiderationMinor: jod(20_000),
      grossDealerSettlementMinor: jod(20_000),
      storedExpectedDealerRemittanceMinor: jod(20_000),
      components: [],
      depositLiabilityAppliedMinor: 0,
    });

    expect(withDeposit.legalInvoiceConsiderationMinor).toBe(
      without.legalInvoiceConsiderationMinor
    );
    expect(withDeposit.grossDealerSettlementMinor).toBe(without.grossDealerSettlementMinor);
    // Only this moves, and by exactly the deposit.
    expect(without.financeCompanyReceivableMinor - withDeposit.financeCompanyReceivableMinor).toBe(
      jod(3_000)
    );
  });

  test("the invariant N + D + H = G + P holds with a deposit and deductions together", () => {
    const plan = planOf({
      legalInvoiceConsiderationMinor: jod(20_000),
      grossDealerSettlementMinor: jod(20_000),
      storedExpectedDealerRemittanceMinor: jod(18_625),
      depositLiabilityAppliedMinor: jod(3_000),
    });
    // 20,000 gross - 1,375 netted contribution - 3,000 deposit = 15,625.
    expect(plan.financeCompanyReceivableMinor).toBe(jod(15_625));
    expect(
      plan.financeCompanyReceivableMinor +
        plan.totalDeductionsMinor +
        plan.depositLiabilityAppliedMinor
    ).toBe(plan.grossDealerSettlementMinor + plan.financeCompanyPayableMinor);
    assertBalanced(plan);
  });

  test("a deposit larger than what the company still owes refuses rather than inventing a credit", () => {
    const refusal = refusalOf({
      legalInvoiceConsiderationMinor: jod(20_000),
      grossDealerSettlementMinor: jod(20_000),
      storedExpectedDealerRemittanceMinor: jod(20_000),
      components: [],
      depositLiabilityAppliedMinor: jod(25_000),
    });
    expect(refusal.code).toBe("DEPOSIT_EXCEEDS_SETTLEMENT");
  });

  test("a deposit alongside a net payable refuses — nobody has said whose money settles which obligation", () => {
    const refusal = refusalOf({
      legalInvoiceConsiderationMinor: jod(1_000),
      grossDealerSettlementMinor: jod(1_000),
      storedExpectedDealerRemittanceMinor: 0,
      components: [component({ amountMinor: jod(1_500) })],
      depositLiabilityAppliedMinor: jod(500),
    });
    expect(refusal.code).toBe("DEPOSIT_WITH_NET_PAYABLE");
  });

  test("deductions above the gross with NO deposit still produce a payable, not a deposit refusal", () => {
    // The guard that distinguishes them. D > G drives the same figure negative
    // for a different reason, and an earlier version of this refused it as a
    // deposit overage on deals carrying no deposit at all.
    const plan = planOf({
      legalInvoiceConsiderationMinor: jod(1_000),
      grossDealerSettlementMinor: jod(1_000),
      storedExpectedDealerRemittanceMinor: 0,
      components: [component({ amountMinor: jod(1_500) })],
      depositLiabilityAppliedMinor: 0,
    });
    expect(plan.financeCompanyPayableMinor).toBe(jod(500));
    expect(plan.financeCompanyReceivableMinor).toBe(0);
    assertBalanced(plan);
  });
});

describe("financed sale posting plan — staleness is checked before the deposit is netted", () => {
  test("a stale stored remittance refuses even on a deal carrying a deposit", () => {
    // The stored figure answers "what does the company owe", which knows nothing
    // about deposits. Checking it against the POST-deposit number would let a
    // stale one through whenever the deposit happened to absorb the difference.
    const refusal = refusalOf({
      legalInvoiceConsiderationMinor: jod(20_000),
      grossDealerSettlementMinor: jod(20_000),
      storedExpectedDealerRemittanceMinor: jod(17_000),
      components: [],
      depositLiabilityAppliedMinor: jod(3_000),
    });
    expect(refusal.code).toBe("REMITTANCE_STALE");
  });
});
