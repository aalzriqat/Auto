/**
 * SCRUM-802 (owner ruling, Option A): the pilot cash-sale containment must run for real.
 *
 * `vitest.setup.ts` no longer turns `CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED` off. A suite that only uses a cash
 * completion as a fixture (complete a cash sale, then collect or cancel it, to test something else) opts out with a
 * file-level `vi.mock` marked "SCRUM-802 legacy-cash-lifecycle opt-out". This census is the ratchet: the opt-out list
 * is exactly the one below, so a new suite cannot quietly run with the containment off, and the certification and
 * rehearsal files can never be on it. Shrinking the list (re-cutting a suite to pay by deposit) is always allowed;
 * delete the entry in the same change.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MARK = "SCRUM-802 legacy-cash-lifecycle opt-out";

const ALLOWED_OPT_OUTS: readonly string[] = [
  "components/deposits/QuoteDepositManager.test.tsx",
  "convex/accountingPhase0.test.ts",
  "convex/accountingPhase8.test.ts",
  "convex/accountingPhase9.test.ts",
  "convex/accountingReceiptMovement.test.ts",
  "convex/accountingVehicleInventory.test.ts",
  "convex/applications.test.ts",
  "convex/billOfSaleEconomics.test.ts",
  "convex/cashApplicationFinancierLeg.test.ts",
  "convex/chequeCancelledSaleCredit.test.ts",
  "convex/commissionAccrualTiming.test.ts",
  "convex/commissionMarginBase.test.ts",
  "convex/commitmentFinalization.test.ts",
  "convex/commitmentRestorationSpine.test.ts",
  "convex/consignedDepositResolution.test.ts",
  "convex/consignedReporting.test.ts",
  "convex/consignedSettlementRoute.test.ts",
  "convex/consignmentEconomics.test.ts",
  "convex/depositCancellationPending.test.ts",
  "convex/depositRevenueRecognition.test.ts",
  "convex/deposits.test.ts",
  "convex/financeLifecyclePhase1.test.ts",
  "convex/financeLifecyclePhase3.test.ts",
  "convex/financeLifecyclePhase4.test.ts",
  "convex/financedConsignedSettlement.test.ts",
  "convex/financierLegNotApplicable.test.ts",
  "convex/migrateConsignedSaleBasis.test.ts",
  "convex/multiVehicleDepositAllocation.test.ts",
  "convex/profitApprovalEnforcement.test.ts",
  "convex/retiredDealModes.test.ts",
  "convex/saleCancellationOutcomeMatrix.test.ts",
  "convex/saleCompletionTenancyGuards.test.ts",
  "convex/saleOwnedTeardown.test.ts",
  "convex/sales.test.ts",
  "convex/salesCommissionEntry.test.ts",
  "convex/scrum230MonthlyCronIsolation.test.ts",
  "convex/scrum411P202ForwardedDeposit.test.ts",
  "convex/scrum415FinancedDoor.test.ts",
  "convex/scrum571s1Containment.test.ts",
  "convex/scrum571s2CashSettlement.test.ts",
  "convex/scrum641DeletedVehicleDoors.test.ts",
  "convex/scrum693VehicleNotReadyForSale.test.ts",
  "convex/scrum69FinanceDoor.test.ts",
  "convex/supplierPayableSettlement.test.ts",
  "convex/supplierPayablesReconciliation.scrum651.test.ts",
  "convex/supplierReceivables.test.ts",
];

const MUST_RUN_WITH_REAL_SWITCH = [
  "convex/scrum486Certification.test.ts",
  "convex/accountingReleaseRehearsal.test.ts",
  "convex/scrum802CashSaleContainment.test.ts",
  "convex/scrum802CashSaleExtras.test.ts",
  // Bound to the regression scenario cash-taxed-owned-sale-gl-subledger-invoice-agree (re-cut to the refusal).
  "convex/ownedSaleTaxEndToEnd.test.ts",
] as const;

// The mutation attacks on the extras switch (CASH_SALE_EXTRAS_PILOT_REFUSED): each mocks the gate module and flips ONLY
// that switch, so it is neither an opt-out nor allowed to touch the full-payment switch.
const EXTRAS_SWITCH_ATTACKS: readonly string[] = ["convex/scrum802CashSaleExtrasSwitchAttack.test.ts"];

// Mirrors vitest.config.ts: include **/*.test.ts(x) from the repository root, exclude these directories.
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "build", "apps", "packages"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
    const path = dir === "." ? name : join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

// Anything that turns the switch off or replaces the gate module, however it is spelled. Two independent detectors:
// (1) any vi.mock / vi.doMock call that names either gate module (optional extension, import(...) form, any quote or
//     backtick), and (2) the switch's name used as an object key with any value other than the literal `true`
//     (false, !1, 0, undefined, null, a variable...).
const MOCKS_GATE_MODULE = /vi\.(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*(?:saleDebtContainment|cashSalePilotGate)/;
const SETS_SWITCH_NOT_TRUE = /CASH_SALE_(?:FULL_PAYMENT_PILOT_REQUIRED|EXTRAS_PILOT_REFUSED)\s*:\s*(?!\s|true\b)/;
function turnsSwitchOff(src: string): boolean {
  return MOCKS_GATE_MODULE.test(src) || SETS_SWITCH_NOT_TRUE.test(src);
}

// What a marked opt-out must actually DO, not merely say: mock the containment module and set the full-payment switch
// to a falsy literal. A file that carries the marker text but mocks nothing runs with the real switch and is a lie.
const MOCKS_CONTAINMENT_MODULE = /vi\.(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*saleDebtContainment/;
const FULL_PAYMENT_SET_FALSY = /CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED\s*:\s*(?:false|!1|0|null|undefined)\b/;
function mocksFullPaymentSwitchOff(src: string): boolean {
  return MOCKS_CONTAINMENT_MODULE.test(src) && FULL_PAYMENT_SET_FALSY.test(src);
}
function flipsOnlyTheExtrasSwitch(src: string): boolean {
  return (
    MOCKS_CONTAINMENT_MODULE.test(src) &&
    /CASH_SALE_EXTRAS_PILOT_REFUSED\s*:\s*(?:false|!1|0|null|undefined)\b/.test(src) &&
    !/CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED\s*:/.test(src)
  );
}

describe("SCRUM-802 opt-out census", () => {
  const SELF = "convex/scrum802OptOutCensus.test.ts";
  const all = testFiles(".").filter((path) => path !== SELF);
  const optedOut = all.filter((path) => readFileSync(path, "utf8").includes(MARK)).sort();

  test("the scan covers every test directory vitest runs (convex, components, lib, scripts, test-utils and the rest)", () => {
    expect(all).toContain("convex/sales.test.ts");
    expect(all).toContain("components/deposits/QuoteDepositManager.test.tsx");
    expect(all.some((path) => path.startsWith("scripts/"))).toBe(true);
    expect(all.some((path) => path.startsWith("lib/"))).toBe(true);
  });

  test("no test file turns the switch off or mocks the gate modules without carrying the opt-out marker", () => {
    // "importOriginal()" pass-through mocks are harmless no-ops but are still flagged: there is nothing to opt back in to.
    const unmarked = all.filter((path) => {
      const src = readFileSync(path, "utf8");
      if (EXTRAS_SWITCH_ATTACKS.includes(path)) return !flipsOnlyTheExtrasSwitch(src);
      return turnsSwitchOff(src) && !src.includes(MARK);
    });
    expect(unmarked).toEqual([]);
  });

  test("every opted-out suite really mocks the full-payment switch off (the marker alone is not an opt-out)", () => {
    const notReal = optedOut.filter((path) => !mocksFullPaymentSwitchOff(readFileSync(path, "utf8")));
    expect(notReal).toEqual([]);
  });

  test("the extras-switch attacks exist, flip only that switch, and are not opt-outs", () => {
    for (const path of EXTRAS_SWITCH_ATTACKS) {
      expect(all).toContain(path);
      expect(optedOut).not.toContain(path);
      expect(flipsOnlyTheExtrasSwitch(readFileSync(path, "utf8"))).toBe(true);
    }
  });

  test("exactly the listed suites run with the containment off", () => {
    expect(optedOut).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("certification and rehearsal files run with the real switch", () => {
    for (const path of MUST_RUN_WITH_REAL_SWITCH) {
      expect(all).toContain(path); // a renamed or deleted certification file must fail here, not silently drop out
      expect(optedOut).not.toContain(path);
      const src = readFileSync(path, "utf8");
      expect(turnsSwitchOff(src)).toBe(false);
      expect(src).not.toContain(MARK);
    }
    expect(readFileSync("vitest.setup.ts", "utf8")).not.toContain("CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED");
  });

  test("the detector goes red on every spelling vitest honours (self-test)", () => {
    const N = "CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED";
    const escapes = [
      `vi.mock("./utils/saleDebtContainment", async () => ({ ${N}: false }));`,
      `vi.mock("./utils/saleDebtContainment.ts", async o => ({...(await o()), ${N}: !1}));`,
      `vi.mock("./utils/saleDebtContainment.js", async (o) => ({...(await o()), ${N}: 0}));`,
      `vi.mock(import("./utils/saleDebtContainment"), async (o) => ({...(await o()), ${N}: undefined}));`,
      "vi.mock(`./utils/saleDebtContainment`, async (o) => await o());",
      `vi.doMock('../utils/cashSalePilotGate', () => ({}));`,
      `vi.mock( "./utils/cashSalePilotGate.ts" , () => ({}));`,
      `const m = { ${N}: null };`,
      `const m = { ${N}:flag };`,
    ];
    for (const src of escapes) expect(turnsSwitchOff(src), src).toBe(true);
    const harmless = [
      `import { ${N} } from "./utils/saleDebtContainment";`,
      `expect(${N}).toBe(true);`,
      `const m = { ${N}: true };`,
      `vi.mock("./rateLimit", () => ({}));`,
    ];
    for (const src of harmless) expect(turnsSwitchOff(src), src).toBe(false);
    // The extras switch is covered by the same detector.
    expect(turnsSwitchOff("const m = { CASH_SALE_EXTRAS_PILOT_REFUSED: false };")).toBe(true);
    expect(turnsSwitchOff("const m = { CASH_SALE_EXTRAS_PILOT_REFUSED: !1 };")).toBe(true);
  });

  test("the opt-out verifier goes red on a marker with no real mock (self-test)", () => {
    const real = `// ${MARK}\nvi.mock("./utils/saleDebtContainment", async (importOriginal) => ({ ...(await importOriginal()), CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false }));`;
    expect(mocksFullPaymentSwitchOff(real)).toBe(true);
    expect(mocksFullPaymentSwitchOff(`// ${MARK}\nconst x = 1;`)).toBe(false); // marker only
    expect(mocksFullPaymentSwitchOff(`// ${MARK}\nvi.mock("./utils/saleDebtContainment", async (o) => await o());`)).toBe(false); // mock, switch still real
    expect(mocksFullPaymentSwitchOff(`// ${MARK}\nconst m = { CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false };`)).toBe(false); // value set, nothing mocked
    expect(flipsOnlyTheExtrasSwitch(`vi.mock("./utils/saleDebtContainment", async (o) => ({ ...(await o()), CASH_SALE_EXTRAS_PILOT_REFUSED: false }));`)).toBe(true);
    expect(flipsOnlyTheExtrasSwitch(`vi.mock("./utils/saleDebtContainment", async (o) => ({ ...(await o()), CASH_SALE_EXTRAS_PILOT_REFUSED: false, CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false }));`)).toBe(false);
  });
});
