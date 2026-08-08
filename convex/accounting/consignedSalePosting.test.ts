import { describe, expect, test } from "vitest";
import {
  ruleSaleCompleted,
  ruleSupplierPaymentSettled,
  validateBalance,
  SaleCompletedPayload,
} from "./postingRules";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * A consigned vehicle is legally the supplier's. The dealership sells it on his
 * behalf and may recognize only the spread over his entitlement.
 *
 * Nothing pinned this before: the existing sourced-vehicle tests cover
 * acquisition (never capitalized) and conversion to owned stock, but no test
 * ever asserted what a sourced SALE posts. That is why every historical one
 * went onto the books at gross.
 */

const jod = (major: number): number => Math.round(major * 1000);

const base: SaleCompletedPayload = {
  saleId: "sale_1",
  saleAmountMinor: jod(12_500),
  currency: "JOD",
  customerId: "cust_1",
  vehicleId: "veh_1",
  salespersonId: "user_1",
};

const consigned = (
  overrides: Partial<SaleCompletedPayload> = {},
  route: "DIRECT_TO_SUPPLIER" | "THROUGH_DEALERSHIP" = "THROUGH_DEALERSHIP"
): SaleCompletedPayload => ({
  ...base,
  isSourced: true,
  consignment: {
    supplierEntitlementMinor: jod(9_500),
    supplierName: "Amman Importer Co",
    settlementRoute: route,
  },
  ...overrides,
});

/** Net movement on an account across the whole entry: debits minus credits. */
function net(result: ReturnType<typeof ruleSaleCompleted>, key: string): number {
  return result.lines
    .filter((l) => l.accountSystemKey === key)
    .reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0);
}

describe("sales tax on an agent-basis sale", () => {
  // The defect: `consignedAgentSaleLines` ignored `taxMinor` altogether, though
  // `saleCompletion` passes it in the same payload as the consignment. The
  // whole margin went to commission revenue, no liability was recorded, and the
  // dealership held the customer's tax money with nothing saying it owed it —
  // while the entry balanced, which is why nothing caught it.
  //
  // It is refused rather than posted because the codebase holds two
  // contradictory tax conventions (see the rule's own comment): the principal
  // rule reads `saleAmountMinor` as tax-INCLUSIVE, the sale form and the AR
  // subledger read it as EXCLUSIVE. On an agency sale those give materially
  // different commission revenue, so posting either one would be inventing tax
  // policy. Refusing drops nothing and guesses nothing.
  test.each([
    ["THROUGH_DEALERSHIP" as const],
    ["DIRECT_TO_SUPPLIER" as const],
  ])("is refused on %s rather than silently dropped", (route) => {
    expect(() => ruleSaleCompleted(consigned({ taxMinor: jod(500) }, route))).toThrow(
      /tax/i
    );
  });

  test("posts normally when there is no tax, which is every current wizard sale", () => {
    // `completeFromQuote` passes no tax at all, so the refusal above cannot
    // reach the sales wizard — only the sale form, which offers a tax field.
    const result = ruleSaleCompleted(consigned({ taxMinor: 0 }));
    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(-jod(3_000));
    expect(net(result, SYSTEM_KEYS.SALES_TAX_PAYABLE)).toBe(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });
});

describe("a zero-margin consigned sale", () => {
  test("never posts an entry with no lines at all", () => {
    // A zero-margin DIRECT_TO_SUPPLIER sale is a real deal — the dealership
    // placed the car and made nothing on the metal — but nothing gross reaches
    // these books either, so with no dealer fees and no F&I there is genuinely
    // nothing to record. The old code returned an EMPTY line array, and
    // `validateBalance` waves that through because 0 === 0, so a journal entry
    // with no lines was posted: a row implying an event that has no accounting
    // consequence, which then shows up in every entry count and reconciliation.
    const result = ruleSaleCompleted(
      consigned({ consignment: { supplierEntitlementMinor: jod(12_500), supplierName: "Amman Importer Co", settlementRoute: "DIRECT_TO_SUPPLIER" } })
    );

    expect(result.lines).toHaveLength(0);
    // The rule says so explicitly rather than leaving the caller to infer it
    // from an empty array it never checks.
    expect(result.skipPosting).toBe(true);
  });

  test("still posts when the dealership earned its own income on the deal", () => {
    // Zero margin on the metal, but dealer fees are the dealership's own income
    // on its own services and have nothing to do with who owned the car.
    const result = ruleSaleCompleted(
      consigned({
        consignment: { supplierEntitlementMinor: jod(12_500), supplierName: "Amman Importer Co", settlementRoute: "DIRECT_TO_SUPPLIER" },
        dealerFeesMinor: jod(300),
      })
    );

    expect(result.skipPosting ?? false).toBe(false);
    expect(net(result, SYSTEM_KEYS.DEALER_FEE_INCOME)).toBe(-jod(300));
    expect(() => validateBalance(result.lines)).not.toThrow();
  });
});

describe("a consigned vehicle sold as the supplier's agent", () => {
  test("recognizes the margin as commission and no vehicle revenue at all", () => {
    const result = ruleSaleCompleted(consigned());

    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(-jod(3_000));
    // The three that gross posting inflated by the supplier's entitlement.
    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(0);
    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(0);
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(0);
  });

  test("keeps the supplier's share as a liability, never as revenue in transit", () => {
    const result = ruleSaleCompleted(consigned());

    // Gross arrives, but 9,500 of it belongs to somebody else from the instant
    // it lands — it is not the dealership's money to report or to spend.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(12_500));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)).toBe(-jod(9_500));
  });

  test("credits the same account the supplier is later paid out of", () => {
    // The sale raises what the supplier is owed; `markPaid` discharges it
    // through ruleSupplierPaymentSettled. If the two name different accounts
    // the liability is never cleared: the sale's credit sits there forever and
    // the payment's debit lands on an account that was never credited, leaving
    // two permanently wrong balances that happen to offset in total.
    const sale = ruleSaleCompleted(consigned());
    const settlement = ruleSupplierPaymentSettled({
      payableId: "pay_1",
      sourcedFromName: "Amman Importer Co",
      amountMinor: jod(9_500),
      currency: "JOD",
      paymentMethod: "BANK_TRANSFER",
      costOrigin: "COGS",
    });

    const raisedOn = sale.lines.filter((l) => l.creditMinor > 0).map((l) => l.accountSystemKey);
    const settledOn = settlement.lines.filter((l) => l.debitMinor > 0).map((l) => l.accountSystemKey);
    expect(raisedOn).toEqual(expect.arrayContaining(settledOn));
  });

  test("books only a claim for the margin when the buyer paid the supplier direct", () => {
    const result = ruleSaleCompleted(consigned({}, "DIRECT_TO_SUPPLIER"));

    // Nothing gross ever reaches these books.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(0);
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)).toBe(0);
    expect(net(result, SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS)).toBe(jod(3_000));
    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(-jod(3_000));
  });

  test("balances", () => {
    for (const route of ["THROUGH_DEALERSHIP", "DIRECT_TO_SUPPLIER"] as const) {
      const result = ruleSaleCompleted(consigned({}, route));
      const debits = result.lines.reduce((s, l) => s + l.debitMinor, 0);
      const credits = result.lines.reduce((s, l) => s + l.creditMinor, 0);
      expect(debits).toBe(credits);
    }
  });

  test("still books the dealership's own fee income, which the supplier's car does not affect", () => {
    const result = ruleSaleCompleted(consigned({ dealerFeesMinor: jod(200) }));

    expect(net(result, SYSTEM_KEYS.DEALER_FEE_INCOME)).toBe(-jod(200));
    // The fee is owed by the customer, on top of the proceeds.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(12_700));
  });

  test("refuses a sale below the supplier's entitlement rather than posting a negative commission", () => {
    // Real situation, but not one this rule may guess at: it is a loss the
    // dealership has to fund, and netting it into revenue would hide that.
    expect(() =>
      ruleSaleCompleted(consigned({ saleAmountMinor: jod(9_000) }))
    ).toThrow(/below the supplier's entitlement/i);
  });
});

describe("the fail-closed guard on owned-basis posting", () => {
  test("refuses to post a sourced vehicle as an owned sale", () => {
    // Silence here is what put every historical sourced sale on the books at
    // gross: revenue on a car the dealership never owned, and inventory relief
    // for stock it never held.
    expect(() =>
      ruleSaleCompleted({
        ...base,
        isSourced: true,
        consignmentEvaluated: true,
        costMinor: jod(9_500),
      })
    ).toThrow(/cannot be posted as an owned sale/i);
  });

  test("names conversion to dealer-owned stock as the other legitimate answer", () => {
    expect(() =>
      ruleSaleCompleted({ ...base, isSourced: true, consignmentEvaluated: true })
    ).toThrow(/convert the vehicle to dealer-owned stock/i);
  });

  test("leaves an ordinary owned sale exactly as it was", () => {
    const result = ruleSaleCompleted({ ...base, costMinor: jod(9_500) });

    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(12_500));
    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(jod(9_500));
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(-jod(9_500));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(12_500));
    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(0);
  });

  test("reaches the same bottom line as the gross posting it replaces", () => {
    // The whole reason the historical correction is a reclassification rather
    // than a restatement: agent basis and principal basis agree on profit.
    const agent = ruleSaleCompleted(consigned());
    const agentProfit =
      -net(agent, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE) -
      net(agent, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD);

    const principal = ruleSaleCompleted({ ...base, costMinor: jod(9_500) });
    const principalProfit =
      -net(principal, SYSTEM_KEYS.SALES_REVENUE) -
      net(principal, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD);

    expect(agentProfit).toBe(jod(3_000));
    expect(principalProfit).toBe(jod(3_000));
  });
});

describe("events queued before agent accounting existed", () => {
  // The organizations this is about: they sold sourced cars, enabled accounting
  // afterwards, and their SALE_COMPLETED events have been sitting in the outbox
  // ever since. Those payloads carry `isSourced` and nothing else — no
  // settlement route was ever asked for, so no consignment block can honestly
  // be reconstructed from them.

  test("posts a legacy sourced event on the basis it was written for", () => {
    // Not a variation on agent basis: this is exactly what the rule produced
    // before agent basis existed, which is what the queued event was built to
    // produce. Failing it closed would dead-letter a real sale after
    // MAX_ATTEMPTS and drop it off the books entirely.
    const result = ruleSaleCompleted({ ...base, isSourced: true, costMinor: jod(9_500) });

    expect(net(result, SYSTEM_KEYS.SALES_REVENUE)).toBe(-jod(12_500));
    expect(net(result, SYSTEM_KEYS.COST_OF_VEHICLES_SOLD)).toBe(jod(9_500));
    // AP-Suppliers, not Vehicle Inventory — the pre-existing sourced treatment.
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)).toBe(-jod(9_500));
    expect(net(result, SYSTEM_KEYS.VEHICLE_INVENTORY)).toBe(0);
  });

  test("says on the entry that it is awaiting restatement", () => {
    // So the entry is identifiable later without reconstructing why it exists.
    // migrateConsignedSaleBasis restates it like every other historical
    // sourced sale once it has posted.
    const result = ruleSaleCompleted({ ...base, isSourced: true, costMinor: jod(9_500) });
    expect(result.memo).toMatch(/awaiting restatement/i);
  });

  test("balances, so the outbox can actually drain it", () => {
    // The failure this replaces was not a wrong number, it was a throw: the
    // event burned an attempt on every drain and dead-lettered.
    expect(() =>
      validateBalance(ruleSaleCompleted({ ...base, isSourced: true, costMinor: jod(9_500) }).lines)
    ).not.toThrow();
  });

  test("still refuses a NEW sourced event with no consignment block", () => {
    // The flag is what separates the two. Every emitter sets it from this
    // deploy on, so its absence can only mean a payload built before agent
    // basis — and its presence with no consignment is a bug that must not post.
    expect(() =>
      ruleSaleCompleted({
        ...base,
        isSourced: true,
        consignmentEvaluated: true,
        costMinor: jod(9_500),
      })
    ).toThrow(/cannot be posted as an owned sale/i);
  });
});

describe("a consigned sale the dealership made nothing on", () => {
  // A legitimate deal: the dealership placed the car for the supplier at his
  // entitlement and earns only its fees. `validateBalance` rejects a 0/0 line,
  // so emitting a zero commission line made the sale uncompletable — a
  // representable fact turned into a structural impossibility.

  test("posts nothing at all when settled directly and there are no fees", () => {
    const result = ruleSaleCompleted(
      consigned({ saleAmountMinor: jod(9_500) }, "DIRECT_TO_SUPPLIER")
    );

    expect(result.lines).toHaveLength(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("still posts the dealership's own fee income", () => {
    const result = ruleSaleCompleted(
      consigned({ saleAmountMinor: jod(9_500), dealerFeesMinor: jod(200) }, "DIRECT_TO_SUPPLIER")
    );

    expect(net(result, SYSTEM_KEYS.DEALER_FEE_INCOME)).toBe(-jod(200));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(200));
    // No commission was earned, so no receivable from the supplier is opened.
    expect(net(result, SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS)).toBe(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });

  test("balances on the through-dealership route, where gross still moves", () => {
    const result = ruleSaleCompleted(
      consigned({ saleAmountMinor: jod(9_500) }, "THROUGH_DEALERSHIP")
    );

    expect(net(result, SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(jod(9_500));
    expect(net(result, SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS)).toBe(-jod(9_500));
    expect(net(result, SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)).toBe(0);
    expect(() => validateBalance(result.lines)).not.toThrow();
  });
});
