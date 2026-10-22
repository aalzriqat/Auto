import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES,
  UNSUPPORTED_BROWSER_SWARM_INVARIANTS,
  assertBrowserSwarmMissionsExecutable,
  assertMandatoryBrowserSwarmCoverage,
  browserSwarmCoverageMatrix,
  isBrowserSwarmMissionExecutable,
  planBrowserAttackSwarm,
  type BrowserAttackMission,
} from "./browserAttackSwarm";
import { createInitialBrowserAttackHandlers } from "./browserAttackSwarmHandlers";
import { TRUSTED_JEV_EXECUTABLE_FAMILIES } from "./trustedBrowserJevSuggestions.mjs";
import {
  AUTOFLOW_INVARIANTS,
  isActiveInvariant,
} from "../autoflowInvariantCatalog";

/**
 * SCRUM-826 — the planner-to-executor coverage contract.
 *
 * Run 38224038549 planned ECON-2's mandatory DUPLICATE_SUBMIT and
 * MULTI_TAB_RACE missions, provisioned a preview, built the candidate, ran the
 * full trusted E2E suite, and only THEN discovered in both attack workers that
 * neither family had a handler. These tests pin the contract that closes that
 * gap: the same refusal now has a single source that the trusted plan calls
 * before anything expensive happens, and the gap that remains is named here
 * rather than discovered in a worker.
 */
describe("SCRUM-826 browser swarm coverage contract", () => {
  it("executes real DUPLICATE_SUBMIT and MULTI_TAB_RACE handlers for ECON-2", () => {
    expect([...PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES].sort()).toEqual([
      "ACCOUNTING_DATE_BOUNDARY",
      "AUTHORIZATION_ABUSE",
      "COMPLETENESS_BOUNDARY",
      "CONSIGNMENT_ECONOMICS",
      "DUPLICATE_SUBMIT",
      "LIFECYCLE_REVERSAL",
      "MONEY_BOUNDARY",
      "MULTI_TAB_RACE",
      "NAVIGATION_RACE",
      "NETWORK_RECOVERY",
      "RTL_PARITY",
      "STALE_UI",
      "TENANT_ESCAPE",
      "UI_BACKEND_MISMATCH",
    ]);

    const plan = assertMandatoryBrowserSwarmCoverage([
      { id: "ECON-2", severity: "CRITICAL" },
    ]);
    expect(plan.missions.map((mission) => mission.family).sort()).toEqual([
      "DUPLICATE_SUBMIT",
      "MULTI_TAB_RACE",
    ]);
    expect(plan.jevMissionCount).toBe(0);
  });

  // No active invariant maps to an unexecutable mission any more (see the Phase A gap test below), so the
  // refusals are exercised with a forged mission whose oracle its family's handler does not judge.
  const forgedMoneyMission = (invariantIds: string[]): BrowserAttackMission => ({
    id: "jev::MONEY_BOUNDARY",
    family: "MONEY_BOUNDARY",
    source: "JEV",
    invariantIds,
    invariantSeverity: "CRITICAL",
    oracle: "UI_BACKEND_AUTHORITY",
    timeoutMs: 45_000,
    estimatedCostUnits: 5,
    evidence: ["TRACE"],
    jevProbability: 0.9,
  });

  it("refuses missions that cannot execute, naming every family, oracle and invariant", () => {
    expect(() => assertBrowserSwarmMissionsExecutable([forgedMoneyMission(["ACC-3", "UI-1"])])).toThrow(
      /no executable handler.*MONEY_BOUNDARY with oracle UI_BACKEND_AUTHORITY \(ACC-3, UI-1\)/i,
    );
  });

  it("accepts ACC-1 as executable: its MONEY_BOUNDARY mission has a handler that judges ECONOMIC_AUTHORITY", () => {
    const plan = assertMandatoryBrowserSwarmCoverage([{ id: "ACC-1", severity: "CRITICAL" }]);
    expect(plan.missions.map((mission) => `${mission.family}/${mission.oracle}`)).toEqual([
      "MONEY_BOUNDARY/ECONOMIC_AUTHORITY",
    ]);
    expect(plan.missions[0]?.evidence).toEqual(["TRACE", "SCREENSHOT", "BACKEND_STATE"]);
    // A sale drives ~27 product commands and a posting wait: the 45s default would end in HARNESS_ERROR.
    expect(plan.missions[0]?.timeoutMs).toBeGreaterThanOrEqual(180_000);
    expect(isBrowserSwarmMissionExecutable("MONEY_BOUNDARY", "ECONOMIC_AUTHORITY")).toBe(true);
  });

  it("accepts ACC-3 as executable: its ACCOUNTING_DATE_BOUNDARY mission has a handler that judges STATE_TRANSITION", () => {
    const plan = assertMandatoryBrowserSwarmCoverage([{ id: "ACC-3", severity: "CRITICAL" }]);
    expect(plan.missions.map((mission) => `${mission.family}/${mission.oracle}`)).toEqual([
      "ACCOUNTING_DATE_BOUNDARY/STATE_TRANSITION",
    ]);
    expect(plan.missions[0]?.evidence).toEqual(["TRACE", "SCREENSHOT", "BACKEND_STATE"]);
    expect(plan.missions[0]?.timeoutMs).toBeGreaterThanOrEqual(180_000);
    // A forged mission that routes ACC-3 to a family whose handler judges another oracle is still refused whole.
    expect(() => assertBrowserSwarmMissionsExecutable([...plan.missions, forgedMoneyMission(["ACC-3"])])).toThrow(
      /no executable handler.*MONEY_BOUNDARY with oracle UI_BACKEND_AUTHORITY \(ACC-3\)/i,
    );
  });

  it("accepts LIFE-1's fee void as executable through its own STATE_TRANSITION scenario, and no other oracle for the family", () => {
    const plan = assertMandatoryBrowserSwarmCoverage([{ id: "LIFE-1", severity: "CRITICAL" }]);
    const feeVoid = plan.missions.find((mission) => mission.family === "MONEY_BOUNDARY");
    expect(feeVoid).toMatchObject({ oracle: "STATE_TRANSITION", invariantIds: ["LIFE-1"] });
    expect(feeVoid?.evidence).toEqual(["TRACE", "SCREENSHOT", "BACKEND_STATE"]);
    // Two costs recorded, reconciled and paid, then voided twice, with six ledger settles.
    expect(feeVoid?.timeoutMs).toBeGreaterThanOrEqual(180_000);
    expect(isBrowserSwarmMissionExecutable("MONEY_BOUNDARY", "STATE_TRANSITION")).toBe(true);
    // The family's handler judges these two oracles; a forged mission for any other is still refused.
    expect(isBrowserSwarmMissionExecutable("MONEY_BOUNDARY", "UI_BACKEND_AUTHORITY")).toBe(false);
    expect(isBrowserSwarmMissionExecutable("MONEY_BOUNDARY", "REVERSAL_RECONCILIATION")).toBe(false);
  });

  it("accepts CONS-1 as executable: its CONSIGNMENT_ECONOMICS mission has a handler that judges ECONOMIC_AUTHORITY", () => {
    const plan = assertMandatoryBrowserSwarmCoverage([{ id: "CONS-1", severity: "CRITICAL" }]);
    expect(plan.missions.map((mission) => `${mission.family}/${mission.oracle}`)).toEqual([
      "CONSIGNMENT_ECONOMICS/ECONOMIC_AUTHORITY",
    ]);
    expect(plan.missions[0]?.evidence).toEqual(["TRACE", "SCREENSHOT", "BACKEND_STATE"]);
    // The handler judges ECONOMIC_AUTHORITY for this family only.
    expect(isBrowserSwarmMissionExecutable("CONSIGNMENT_ECONOMICS", "ECONOMIC_AUTHORITY")).toBe(true);
    expect(isBrowserSwarmMissionExecutable("CONSIGNMENT_ECONOMICS", "STATE_TRANSITION")).toBe(false);
  });

  it("executes LIFE-1's STALE_UI mission through a handler that judges UI_BACKEND_AUTHORITY, and no other LIFE-1 mission by that", () => {
    const plan = planBrowserAttackSwarm({ impactedInvariants: [{ id: "LIFE-1", severity: "CRITICAL" }] });
    const stale = plan.missions.find((mission) => mission.family === "STALE_UI");
    expect(stale).toMatchObject({ oracle: "UI_BACKEND_AUTHORITY", evidence: ["TRACE", "SCREENSHOT", "BACKEND_STATE"] });
    expect(stale?.timeoutMs).toBeGreaterThan(45_000);
    expect(() => assertBrowserSwarmMissionsExecutable([stale!])).not.toThrow();
    expect(isBrowserSwarmMissionExecutable("STALE_UI", "UI_BACKEND_AUTHORITY")).toBe(true);
    // The handler judges that oracle for this family only.
    expect(isBrowserSwarmMissionExecutable("STALE_UI", "STATE_TRANSITION")).toBe(false);
    // None of LIFE-1's three missions (STALE_UI, LIFECYCLE_REVERSAL, NAVIGATION_RACE) is listed missing any more.
    expect(() => assertMandatoryBrowserSwarmCoverage([{ id: "LIFE-1", severity: "CRITICAL" }])).not.toThrow();
  });

  it("executes LIFE-1's NAVIGATION_RACE mission through a handler that judges STATE_TRANSITION for that family only", () => {
    const plan = planBrowserAttackSwarm({ impactedInvariants: [{ id: "LIFE-1", severity: "CRITICAL" }] });
    const race = plan.missions.find((mission) => mission.family === "NAVIGATION_RACE");
    expect(race).toMatchObject({ oracle: "STATE_TRANSITION", evidence: ["TRACE", "SCREENSHOT", "BACKEND_STATE"] });
    expect(race?.timeoutMs).toBeGreaterThan(45_000);
    expect(() => assertBrowserSwarmMissionsExecutable([race!])).not.toThrow();
    expect(isBrowserSwarmMissionExecutable("NAVIGATION_RACE", "STATE_TRANSITION")).toBe(true);
    expect(isBrowserSwarmMissionExecutable("NAVIGATION_RACE", "UI_BACKEND_AUTHORITY")).toBe(false);
    // LIFE-1 is now executable as a whole: STALE_UI, LIFECYCLE_REVERSAL and NAVIGATION_RACE each have a handler judging their oracle.
    expect(() => assertMandatoryBrowserSwarmCoverage([{ id: "LIFE-1", severity: "CRITICAL" }])).not.toThrow();
  });

  it("refuses a plan that mixes executable and non-executable missions rather than running the executable half", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [{ id: "UI-1", severity: "HIGH" }],
    });
    const missions = [...plan.missions, forgedMoneyMission(["ACC-3"])];

    expect(() => assertBrowserSwarmMissionsExecutable(plan.missions)).not.toThrow();
    expect(() => assertBrowserSwarmMissionsExecutable(missions)).toThrow(/MONEY_BOUNDARY/);
  });

  it("refuses a forged Jev MONEY_BOUNDARY mission whose UI_BACKEND_AUTHORITY oracle its handler does not judge", () => {
    const forged: BrowserAttackMission = {
      id: "jev::MONEY_BOUNDARY",
      family: "MONEY_BOUNDARY",
      source: "JEV",
      invariantIds: ["UI-1"],
      invariantSeverity: "HIGH",
      oracle: "UI_BACKEND_AUTHORITY",
      timeoutMs: 45_000,
      estimatedCostUnits: 5,
      evidence: ["TRACE"],
      jevProbability: 0.9,
    };

    expect(() => assertBrowserSwarmMissionsExecutable([forged])).toThrow(
      /MONEY_BOUNDARY/,
    );
  });

  it("plans a Jev MONEY_BOUNDARY suggestion as an executable ECONOMIC_AUTHORITY mission with a sale-length timeout", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [{ id: "UI-1", severity: "HIGH" }],
      jevSuggestions: [{ family: "MONEY_BOUNDARY", probability: 0.9 }],
    });
    const mission = plan.missions.find((entry) => entry.family === "MONEY_BOUNDARY");
    expect(mission).toMatchObject({ source: "JEV", oracle: "ECONOMIC_AUTHORITY" });
    expect(mission?.timeoutMs).toBeGreaterThanOrEqual(180_000);
    expect(() => assertBrowserSwarmMissionsExecutable([mission!])).not.toThrow();
  });

  it("executes LIFE-1's LIFECYCLE_REVERSAL mission: the family's handler judges STATE_TRANSITION as well as ACC-2's reconciliation", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [{ id: "LIFE-1", severity: "CRITICAL" }],
    });
    const lifecycle = plan.missions.find(
      (mission) => mission.family === "LIFECYCLE_REVERSAL",
    );
    expect(lifecycle?.oracle).toBe("STATE_TRANSITION");
    expect(lifecycle?.timeoutMs).toBeGreaterThanOrEqual(240_000);

    expect(() => assertBrowserSwarmMissionsExecutable([lifecycle!])).not.toThrow();
    expect(isBrowserSwarmMissionExecutable("LIFECYCLE_REVERSAL", "STATE_TRANSITION")).toBe(true);
    expect(isBrowserSwarmMissionExecutable("LIFECYCLE_REVERSAL", "REVERSAL_RECONCILIATION")).toBe(true);
    const rows = browserSwarmCoverageMatrix().filter(
      (row) => row.invariantId === "LIFE-1" && row.family === "LIFECYCLE_REVERSAL",
    );
    expect(rows.map((row) => row.executable)).toEqual([true]);
  });

  it("refuses a mission whose family has a handler but whose oracle that handler does not judge", () => {
    // The lifecycle handler judges a reversal's reconciliation and a deposit
    // void's state transition. A LIFECYCLE_REVERSAL mission asking for any other
    // oracle would be reported executable by family alone while nothing checks it.
    const forged: BrowserAttackMission = {
      id: "forged::LIFECYCLE_REVERSAL",
      family: "LIFECYCLE_REVERSAL",
      source: "DETERMINISTIC",
      invariantIds: ["LIFE-1"],
      invariantSeverity: "CRITICAL",
      oracle: "ECONOMIC_AUTHORITY",
      timeoutMs: 240_000,
      estimatedCostUnits: 7,
      evidence: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
    };
    expect(() => assertBrowserSwarmMissionsExecutable([forged])).toThrow(
      /LIFECYCLE_REVERSAL.*ECONOMIC_AUTHORITY.*LIFE-1/,
    );
    expect(isBrowserSwarmMissionExecutable("LIFECYCLE_REVERSAL", "ECONOMIC_AUTHORITY")).toBe(false);
  });

  it("executes every mandatory mission of the five newly covered invariants", () => {
    const plan = assertMandatoryBrowserSwarmCoverage([
      { id: "TEN-1", severity: "CRITICAL" },
      { id: "AUTH-1", severity: "CRITICAL" },
      { id: "ACC-2", severity: "CRITICAL" },
      { id: "PERF-1", severity: "CRITICAL" },
      { id: "CONC-1", severity: "CRITICAL" },
      { id: "ECON-1", severity: "CRITICAL" },
    ]);
    expect(
      plan.missions.map((mission) => `${mission.family}/${mission.oracle}`).sort(),
    ).toEqual([
      "AUTHORIZATION_ABUSE/AUTHORIZATION",
      "COMPLETENESS_BOUNDARY/LIST_COMPLETENESS",
      "DUPLICATE_SUBMIT/IDEMPOTENCY_SINGLE_EFFECT",
      "LIFECYCLE_REVERSAL/REVERSAL_RECONCILIATION",
      "MULTI_TAB_RACE/IDEMPOTENCY_SINGLE_EFFECT",
      "NETWORK_RECOVERY/IDEMPOTENCY_SINGLE_EFFECT",
      "NETWORK_RECOVERY/STATE_TRANSITION",
      "TENANT_ESCAPE/TENANT_ISOLATION",
    ]);
  });

  it("refuses an empty mandatory impact set instead of returning a vacuous pass", () => {
    expect(() => assertMandatoryBrowserSwarmCoverage([])).toThrow(
      /at least one impacted invariant/i,
    );
  });

  it("publishes one coverage row per active invariant mandatory mission", () => {
    const activeIds = AUTOFLOW_INVARIANTS.filter(isActiveInvariant)
      .map((invariant) => invariant.id)
      .sort();
    const matrix = browserSwarmCoverageMatrix();

    // An explicitly unsupported invariant has no row, so it can never read as covered.
    expect(
      [
        ...new Set(matrix.map((row) => row.invariantId)),
        ...Object.keys(UNSUPPORTED_BROWSER_SWARM_INVARIANTS),
      ].sort(),
    ).toEqual(activeIds);
    expect(matrix.filter((row) => row.invariantId === "ACC-3").map((row) => `${row.family}/${row.oracle}/${row.executable}`)).toEqual([
      "ACCOUNTING_DATE_BOUNDARY/STATE_TRANSITION/true",
    ]);
    for (const row of matrix) {
      expect(row.executable).toBe(
        isBrowserSwarmMissionExecutable(row.family, row.oracle),
      );
      if (row.executable) {
        expect(PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES).toContain(row.family);
      }
    }
  });

  it("names the Phase A gap explicitly so a new handler or a new mapping must update it", () => {
    // Phase A is NOT complete. Every mapping below is a mandatory deterministic
    // obligation of an active CRITICAL invariant that nothing executes. A row
    // is executable only when its family has a handler AND that handler judges
    // the mission's oracle. Implementing one removes it from this list in the
    // same change; adding a new unexecutable mapping adds to it. Either way the
    // gap stays visible.
    const missing = browserSwarmCoverageMatrix()
      .filter((row) => !row.executable)
      .map((row) => `${row.invariantId}:${row.family}/${row.oracle}`)
      .sort();

    // Every mandatory mapping now has a handler that judges its oracle; LIFE-1's fee void is covered for the
    // direct-paid cost void only (see the MONEY_BOUNDARY comment in browserAttackSwarm.ts). ACC-3 is covered for a
    // manual journal's declared date and the closed-period refusal only (see the ACCOUNTING_DATE_BOUNDARY comment).
    expect(missing).toEqual([]);

    const fullyCovered = [
      ...new Set(browserSwarmCoverageMatrix().map((row) => row.invariantId)),
    ]
      .filter((id) =>
        browserSwarmCoverageMatrix()
          .filter((row) => row.invariantId === id)
          .every((row) => row.executable),
      )
      .sort();
    expect(fullyCovered).toEqual([
      "ACC-1",
      "ACC-2",
      "ACC-3",
      "AUTH-1",
      "CONC-1",
      "CONS-1",
      "ECON-1",
      "ECON-2",
      "LIFE-1",
      "PERF-1",
      "TEN-1",
      "UI-1",
    ]);
  });

  it("keeps every attack inside the shared egress-contained browser lifecycle", () => {
    // The economic handlers must never launch their own browser or context:
    // the only launch path is openMissionBrowser, which REQUIRES the egress
    // proxy (SCRUM-784). A second launch path would be an unconstrained one.
    for (const file of [
      "browserSwarmAccountingDateAttack.ts",
      "browserSwarmEconomicAttacks.ts",
      "browserSwarmBoundaryAttacks.ts",
      "browserSwarmBoundaryHarness.ts",
      "browserSwarmConsignmentAttack.ts",
      "browserSwarmFeeVoidAttack.ts",
      "browserSwarmMoneyBoundaryAttack.ts",
      "browserSwarmNavigationRaceAttack.ts",
      "browserSwarmNetworkRecoveryAttack.ts",
      "browserSwarmStaleUiAttack.ts",
    ]) {
      const source = readFileSync(path.join(__dirname, file), "utf8");
      expect(source, file).not.toMatch(/chromium|firefox|webkit|\.launch\(|newContext\(/);
      expect(source, file).not.toMatch(/storageState/);
    }
  });

  it("keeps the handler registry, the executable set and Jev admission in lockstep", () => {
    expect(Object.keys(createInitialBrowserAttackHandlers()).sort()).toEqual(
      [...PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES].sort(),
    );
    for (const family of TRUSTED_JEV_EXECUTABLE_FAMILIES) {
      expect(PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES).toContain(family);
    }
  });
});
