import type { Infer } from "convex/values";
import { feeAccountingTreatmentValidator } from "./financingEconomics";
import { SYSTEM_KEYS, type SystemKey } from "./defaultChart";

/**
 * The posting plan for an external-finance sale settled THROUGH_DEALERSHIP.
 *
 * On one of these deals the financing company is the legal buyer of the vehicle,
 * so the dealership's claim for the car is against the company — not against the
 * customer. The plan therefore recognises the sale as a direct split at
 * completion rather than raising the whole consideration as customer debt and
 * transferring it out again afterwards. The transfer shape is what produced the
 * defect this replaces: it opened the finance receivable from the customer's
 * financing principal, a number that is neither what the company owes the
 * dealership nor what the customer owes it.
 *
 * Every figure here is server-derived. Nothing is supplied by a caller, nothing
 * is inferred from the gap between two other figures, and there is no balancing
 * account: an amount that cannot be explained by an explicit, classified,
 * reconciled component refuses the sale instead of being plugged.
 *
 * The arithmetic, in integer minor units of one currency:
 *
 *     G  gross dealer-side settlement, before anything the company nets out
 *     D  the sum of explicit classified settlement components
 *     N  max(0, G - D)   what the company will actually remit -> finance receivable
 *     P  max(0, D - G)   what the dealership owes the company -> finance payable
 *
 *     N + D = G + P      always, by construction
 *
 * `N` and `P` are floored against each other rather than allowed to go negative,
 * because a negative receivable is a payable wearing the wrong sign, and the two
 * live in different places on the balance sheet.
 */

export type FeeAccountingTreatment = Infer<typeof feeAccountingTreatmentValidator>;

export const FINANCED_SALE_PLAN_VERSION = 1 as const;

/** Which side of the journal a classified component lands on. */
export type ComponentSide = "DEBIT" | "CREDIT";

/**
 * Where each accounting treatment posts.
 *
 * `null` means "this treatment has no supported account mapping", which is a
 * refusal and not a licence to guess. The alternative — defaulting to General
 * Expense — is wrong for most of these: a consideration reduction is not an
 * expense, an amount the customer still owes is an asset, and money owed to an
 * employee is a liability. Mapping them all to one bucket would make the ledger
 * agree with itself while describing the wrong business facts.
 *
 * The `satisfies` clause is the point of writing it as a total record: adding a
 * thirteenth treatment to the validator fails the typecheck here until somebody
 * decides where it posts, rather than silently falling through to a default arm.
 *
 * A settlement deduction consumes consideration, so every mapped treatment
 * debits. `side` is carried explicitly anyway because a component that credits
 * is representable and must not be assumed away.
 */
const TREATMENT_POSTING = {
  // Contra-revenue. Both of these reduce what the dealership earned on the car
  // rather than adding a cost, so they post against revenue and not to an
  // expense account.
  SALE_CONSIDERATION_REDUCTION: {
    systemKey: SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS,
    side: "DEBIT",
  },
  DEALER_CONCESSION: {
    systemKey: SYSTEM_KEYS.SALES_CONSIDERATION_REDUCTIONS,
    side: "DEBIT",
  },

  // Costs the dealership actually bears out of the settlement.
  FINANCE_COMPANY_COMMISSION: {
    systemKey: SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE,
    side: "DEBIT",
  },
  APPRAISAL_EXPENSE: { systemKey: SYSTEM_KEYS.APPRAISAL_EXPENSE, side: "DEBIT" },
  INSURANCE_EXPENSE: { systemKey: SYSTEM_KEYS.INSURANCE_EXPENSE, side: "DEBIT" },
  OWNERSHIP_TRANSFER_EXPENSE: {
    systemKey: SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE,
    side: "DEBIT",
  },
  SELLING_EXPENSE: { systemKey: SYSTEM_KEYS.SELLING_EXPENSE, side: "DEBIT" },

  // Control assets — the amount did not leave the dealership, it changed form.
  CUSTOMER_RECEIVABLE: {
    systemKey: SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS,
    side: "DEBIT",
  },
  EMPLOYEE_RECEIVABLE: { systemKey: SYSTEM_KEYS.EMPLOYEE_ADVANCES, side: "DEBIT" },
  CAPITALIZED_TO_VEHICLE: { systemKey: SYSTEM_KEYS.VEHICLE_INVENTORY, side: "DEBIT" },

  // Deliberately unmapped, and both for the same reason: the chart has no
  // account that means what they mean, and picking a near-enough one would
  // record a fact nobody established.
  //
  // EMPLOYEE_PAYABLE is a liability to a named person; SALARIES_PAYABLE is
  // payroll and a deal fee is not payroll. REFUNDABLE_DEPOSIT does not even fix
  // its own direction — a deposit the dealership PAID is an asset, one it HOLDS
  // is a liability, and the treatment alone does not say which.
  EMPLOYEE_PAYABLE: null,
  REFUNDABLE_DEPOSIT: null,
} satisfies Record<
  FeeAccountingTreatment,
  { systemKey: SystemKey; side: ComponentSide } | null
>;

export type PlanRefusalCode =
  | "LEGAL_INVOICE_MISSING"
  | "LEGAL_INVOICE_WRONG_RECIPIENT"
  | "GROSS_SETTLEMENT_UNKNOWN"
  | "REMITTANCE_UNKNOWN"
  | "REMITTANCE_STALE"
  | "COMPONENT_AMOUNT_INVALID"
  | "COMPONENT_SOURCE_DUPLICATED"
  | "TREATMENT_UNMAPPED"
  | "PLAN_UNBALANCED";

export interface PlanRefusal {
  code: PlanRefusalCode;
  /** Operator-facing. Says what is missing and what to do, never an account id. */
  message: string;
}

/** Where a settlement component came from, so a retry can recognise the same one. */
export type ComponentSourceKind =
  | "FEE"
  | "DEALER_CONTRIBUTION"
  | "CUSTOMER_RETAINED_BY_COMPANY";

export interface SettlementComponentInput {
  sourceKind: ComponentSourceKind;
  /** Stable identity of the underlying row. Two components may not share one. */
  sourceId: string;
  label: string;
  amountMinor: number;
  treatment: FeeAccountingTreatment;
}

export interface PlannedComponent extends SettlementComponentInput {
  systemKey: SystemKey;
  side: ComponentSide;
}

export interface FinancedSalePlanInput {
  currency: string;
  /** The only figure revenue may be posted from. */
  legalInvoiceConsiderationMinor: number | undefined;
  legalInvoiceIssuedTo: "CUSTOMER" | "FINANCE_COMPANY" | "OTHER" | undefined;
  /** True when the deal names a configured external financier. */
  financierIsConfiguredExternal: boolean;
  /** G — from the shared economics engine, never from the customer's principal. */
  grossDealerSettlementMinor: number | undefined;
  /** What the application currently claims; must equal the recomputed N. */
  storedExpectedDealerRemittanceMinor: number | undefined;
  components: SettlementComponentInput[];
  /** Only amounts the customer independently owes the dealership. */
  customerReceivableMinor: number;
  /** Consideration the dealership already holds — cash and applied deposits. */
  cashOrDepositAppliedMinor: number;
}

export interface FinancedSalePostingPlan {
  version: typeof FINANCED_SALE_PLAN_VERSION;
  currency: string;
  legalInvoiceConsiderationMinor: number;
  grossDealerSettlementMinor: number;
  totalDeductionsMinor: number;
  financeCompanyReceivableMinor: number;
  financeCompanyPayableMinor: number;
  customerReceivableMinor: number;
  cashOrDepositAppliedMinor: number;
  components: PlannedComponent[];
  /**
   * Identifies this exact plan.
   *
   * It is the canonical serialization itself rather than a hash of it, because
   * the fingerprint is what a retry compares against to decide whether it is
   * replaying the same recognition or attempting a different one. A hash
   * collision there would let a changed plan post over an unchanged one, and no
   * hash short enough to be worth storing is worth that risk.
   */
  fingerprint: string;
}

export type BuildPlanResult =
  | { ok: true; plan: FinancedSalePostingPlan }
  | { ok: false; refusal: PlanRefusal };

function refuse(code: PlanRefusalCode, message: string): BuildPlanResult {
  return { ok: false, refusal: { code, message } };
}

function isWholeMinorAmount(value: number): boolean {
  return Number.isInteger(value) && Number.isFinite(value);
}

/**
 * Builds the plan, or says exactly why it will not.
 *
 * Pure: it reads no database and writes nothing, so the caller can build it
 * before the first write and refuse the whole finalization atomically. Every
 * exit before the `ok: true` is a refusal, and there is no arm that returns a
 * partial or best-effort plan.
 */
export function buildFinancedSalePostingPlan(
  input: FinancedSalePlanInput
): BuildPlanResult {
  const {
    legalInvoiceConsiderationMinor: legalInvoiceMinor,
    grossDealerSettlementMinor: grossMinor,
    storedExpectedDealerRemittanceMinor: storedRemittanceMinor,
  } = input;

  if (legalInvoiceMinor === undefined) {
    return refuse(
      "LEGAL_INVOICE_MISSING",
      "This deal has no legal invoice recorded. The invoice amount is the only figure revenue may be posted from, so record it before finalizing."
    );
  }
  if (!isWholeMinorAmount(legalInvoiceMinor) || legalInvoiceMinor <= 0) {
    return refuse(
      "LEGAL_INVOICE_MISSING",
      "The recorded legal invoice amount is not a usable figure. Record it again before finalizing."
    );
  }

  // On a configured external financier the company is the legal buyer, so an
  // invoice made out to the customer describes a different transaction from the
  // one about to be posted. Posting anyway would recognise revenue against a
  // document that contradicts it.
  if (input.financierIsConfiguredExternal && input.legalInvoiceIssuedTo !== "FINANCE_COMPANY") {
    return refuse(
      "LEGAL_INVOICE_WRONG_RECIPIENT",
      `The financing company is the legal buyer on this deal, but the recorded invoice was issued to ${
        input.legalInvoiceIssuedTo?.toLowerCase().replace(/_/g, " ") ?? "nobody recorded"
      }. Re-record the invoice before finalizing.`
    );
  }

  if (grossMinor === undefined || !isWholeMinorAmount(grossMinor) || grossMinor < 0) {
    return refuse(
      "GROSS_SETTLEMENT_UNKNOWN",
      "The gross settlement this financing company owes the dealership could not be established. Resolve the reconciliation note on this deal before finalizing."
    );
  }

  if (storedRemittanceMinor === undefined) {
    return refuse(
      "REMITTANCE_UNKNOWN",
      "What this financing company will actually remit to the dealership is not known on this deal. Record where the customer's payment went, then finalize."
    );
  }

  // Components are validated before any arithmetic uses them, so a bad row
  // cannot reach the totals and produce a refusal that names the wrong problem.
  const seenSourceIds = new Set<string>();
  const components: PlannedComponent[] = [];

  for (const component of input.components) {
    if (!isWholeMinorAmount(component.amountMinor) || component.amountMinor <= 0) {
      return refuse(
        "COMPONENT_AMOUNT_INVALID",
        `"${component.label}" is deducted from this settlement but has no usable amount recorded. A deduction nobody has quantified is not a deduction of zero — record its actual amount before finalizing.`
      );
    }
    if (seenSourceIds.has(component.sourceId)) {
      return refuse(
        "COMPONENT_SOURCE_DUPLICATED",
        `"${component.label}" appears twice in this deal's settlement. Each recorded cost may reduce the remittance once.`
      );
    }
    seenSourceIds.add(component.sourceId);

    const posting = TREATMENT_POSTING[component.treatment];
    if (posting === null) {
      return refuse(
        "TREATMENT_UNMAPPED",
        `"${component.label}" is classified as ${component.treatment}, which has no account to post to. Reclassify it before finalizing — it will not be posted to a general account instead.`
      );
    }
    components.push({ ...component, systemKey: posting.systemKey, side: posting.side });
  }

  const totalDeductionsMinor = components.reduce((sum, c) => sum + c.amountMinor, 0);
  const financeCompanyReceivableMinor = Math.max(0, grossMinor - totalDeductionsMinor);
  const financeCompanyPayableMinor = Math.max(0, totalDeductionsMinor - grossMinor);

  // The stored figure was computed by a path that supplies no fee rows, so it
  // is not automatically authoritative. Finalization recomputes it from the
  // actual reconciled components and refuses on disagreement rather than
  // patching the application to match — a settlement whose expected amount
  // moved silently under the operator is exactly what a fresh recomputation is
  // supposed to catch.
  if (storedRemittanceMinor !== financeCompanyReceivableMinor) {
    return refuse(
      "REMITTANCE_STALE",
      "This deal's expected remittance no longer matches what its recorded settlement costs produce. Recalculate the deal's economics before finalizing."
    );
  }

  const debitsMinor =
    financeCompanyReceivableMinor +
    input.cashOrDepositAppliedMinor +
    input.customerReceivableMinor +
    components
      .filter((c) => c.side === "DEBIT")
      .reduce((sum, c) => sum + c.amountMinor, 0);
  const creditsMinor =
    legalInvoiceMinor +
    financeCompanyPayableMinor +
    components
      .filter((c) => c.side === "CREDIT")
      .reduce((sum, c) => sum + c.amountMinor, 0);

  // The last line of defence, and the one that makes every other refusal above
  // safe to relax later: whatever the components turned out to be, the entry
  // this plan describes must balance. A difference here is a real amount nobody
  // has explained, and the one thing that must never happen to it is being
  // given an account so the journal will post.
  if (debitsMinor !== creditsMinor) {
    return refuse(
      "PLAN_UNBALANCED",
      "This deal's legal invoice does not agree with what the financing company settles plus the costs recorded against it. The difference has no account of its own, so resolve the figures before finalizing."
    );
  }

  return {
    ok: true,
    plan: {
      version: FINANCED_SALE_PLAN_VERSION,
      currency: input.currency,
      legalInvoiceConsiderationMinor: legalInvoiceMinor,
      grossDealerSettlementMinor: grossMinor,
      totalDeductionsMinor,
      financeCompanyReceivableMinor,
      financeCompanyPayableMinor,
      customerReceivableMinor: input.customerReceivableMinor,
      cashOrDepositAppliedMinor: input.cashOrDepositAppliedMinor,
      components,
      fingerprint: fingerprintOf({
        currency: input.currency,
        legalInvoiceMinor,
        grossMinor,
        financeCompanyReceivableMinor,
        financeCompanyPayableMinor,
        customerReceivableMinor: input.customerReceivableMinor,
        cashOrDepositAppliedMinor: input.cashOrDepositAppliedMinor,
        components,
      }),
    },
  };
}

/**
 * Canonical serialization of everything that decides what gets posted.
 *
 * Components are sorted by source id so that reading the same rows in a
 * different order produces the same fingerprint — the order a query returns
 * rows in is not part of the deal. Amounts and treatments are included
 * individually rather than only as a total, because two different splits that
 * happen to sum alike are two different journals.
 */
function fingerprintOf(parts: {
  currency: string;
  legalInvoiceMinor: number;
  grossMinor: number;
  financeCompanyReceivableMinor: number;
  financeCompanyPayableMinor: number;
  customerReceivableMinor: number;
  cashOrDepositAppliedMinor: number;
  components: PlannedComponent[];
}): string {
  const componentPart = [...parts.components]
    .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
    .map((c) => `${c.sourceKind}:${c.sourceId}:${c.treatment}:${c.side}:${c.amountMinor}`)
    .join("|");

  return [
    `v${FINANCED_SALE_PLAN_VERSION}`,
    parts.currency,
    `L${parts.legalInvoiceMinor}`,
    `G${parts.grossMinor}`,
    `N${parts.financeCompanyReceivableMinor}`,
    `P${parts.financeCompanyPayableMinor}`,
    `C${parts.customerReceivableMinor}`,
    `H${parts.cashOrDepositAppliedMinor}`,
    componentPart,
  ].join(";");
}
