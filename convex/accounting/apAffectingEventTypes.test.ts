import { describe, expect, test } from "vitest";
import {
  AP_AFFECTING_BY_EVENT_TYPE,
  ALL_EVENT_TYPES,
  applyPostingRule,
} from "./postingRules";
import { SYSTEM_KEYS } from "../utils/defaultChart";

/**
 * SCRUM-651 drift guard. The AP-Suppliers reconciliation treats a queued posting as "the GL is
 * about to move" only when its event type is classified AP-affecting. The classification is
 * exhaustive at the type level; this test closes the other direction: a rule that starts touching
 * ACCOUNTS_PAYABLE_SUPPLIERS under a type classified `false` fails here.
 *
 * It is a SUBSET check (touches AP => classified true), not an equivalence: a `true` whose
 * payloads never reach AP in the probes below is allowed.
 */

const AP = SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS;

// Every field any rule reads, with permissive values. Rules that still reject a probe are skipped
// for THAT probe only; the variants below steer the branches that reach AP.
const KITCHEN_SINK = {
  saleId: "s1", vehicleId: "v1", customerId: "c1", salespersonId: "u1", payableId: "p1",
  currency: "JOD", sourcedFromName: "Supplier Co", paymentMethod: "BANK_TRANSFER", costOrigin: "COGS",
  amountMinor: 1000, costMinor: 1000, deltaMinor: 1000, saleAmountMinor: 12000, tradeInValueMinor: 1000,
  correctionType: "PRIOR_PERIOD_RESTATEMENT",
};

const VARIANTS: Array<Record<string, unknown>> = [
  {},
  { paymentMethod: "ON_ACCOUNT" },
  { isSourced: true },
  {
    isSourced: true,
    consignment: { supplierEntitlementMinor: 9000, supplierName: "Supplier Co", settlementRoute: "THROUGH_DEALERSHIP" },
  },
  { correctionType: "SUPPLIER_INVOICE_ERROR" },
  { correctionType: "VENDOR_CREDIT", deltaMinor: -1000 },
  { correctionType: "CASH_REFUND" },
];

describe("AP_AFFECTING_BY_EVENT_TYPE", () => {
  test("classifies exactly the event types the posting engine accepts (plus the direct reversal type)", () => {
    expect(new Set(Object.keys(AP_AFFECTING_BY_EVENT_TYPE))).toEqual(
      new Set([...ALL_EVENT_TYPES, "JOURNAL_REVERSAL"])
    );
  });

  test("every posting rule that produces an ACCOUNTS_PAYABLE_SUPPLIERS line is classified AP-affecting", () => {
    const touchedAp = new Set<string>();
    let probesThatProducedLines = 0;
    for (const eventType of ALL_EVENT_TYPES) {
      for (const variant of VARIANTS) {
        let lines;
        try {
          lines = applyPostingRule(eventType, { ...KITCHEN_SINK, ...variant }).lines;
        } catch {
          continue; // this probe is not a valid payload for the rule
        }
        probesThatProducedLines++;
        if (lines.some((l) => l.accountSystemKey === AP)) touchedAp.add(eventType);
      }
    }
    // The probe must actually exercise rules, or the subset check below proves nothing.
    expect(probesThatProducedLines).toBeGreaterThan(ALL_EVENT_TYPES.size);
    // Anchors: the four known AP-moving rules are reached by the probes.
    expect([...touchedAp].sort()).toEqual(
      expect.arrayContaining([
        "SALE_COMPLETED",
        "SUPPLIER_PAYMENT_SETTLED",
        "VEHICLE_ACQUIRED",
        "VEHICLE_ACQUISITION_COST_CORRECTED",
      ])
    );
    const misclassified = [...touchedAp].filter(
      (eventType) => !(AP_AFFECTING_BY_EVENT_TYPE as Record<string, boolean>)[eventType]
    );
    expect(misclassified).toEqual([]);
  });
});
