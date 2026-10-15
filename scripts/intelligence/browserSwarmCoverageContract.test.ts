import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES,
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
      "AUTHORIZATION_ABUSE",
      "COMPLETENESS_BOUNDARY",
      "CONSIGNMENT_ECONOMICS",
      "DUPLICATE_SUBMIT",
      "LIFECYCLE_REVERSAL",
      "MULTI_TAB_RACE",
      "NETWORK_RECOVERY",
      "RTL_PARITY",
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

  it("refuses an impact set whose mandatory missions cannot execute, naming every family and invariant", () => {
    expect(() =>
      assertMandatoryBrowserSwarmCoverage([
        { id: "ACC-1", severity: "CRITICAL" },
        { id: "ECON-2", severity: "CRITICAL" },
      ]),
    ).toThrow(/no executable handler.*MONEY_BOUNDARY.*ACC-1/i);
  });

  it("accepts CONS-1 as executable: its CONSIGNMENT_ECONOMICS mission has a handler that judges ECONOMIC_AUTHORITY", () => {
    const plan = assertMandatoryBrowserSwarmCoverage([{ id: "CONS-1", severity: "CRITICAL" }]);
    expect(plan.missions.map((mission) => `${mission.family}/${mission.oracle}`)).toEqual([
      "CONSIGNMENT_ECONOMICS/ECONOMIC_AUTHORITY",
    ]);
    expect(plan.missions[0]?.evidence).toEqual(["TRACE", "SCREENSHOT", "BACKEND_STATE"]);
    // The handler judges ECONOMIC_AUTHORITY for this family only; the same oracle on
    // MONEY_BOUNDARY (ACC-1) stays unexecutable.
    expect(isBrowserSwarmMissionExecutable("CONSIGNMENT_ECONOMICS", "ECONOMIC_AUTHORITY")).toBe(true);
    expect(isBrowserSwarmMissionExecutable("CONSIGNMENT_ECONOMICS", "STATE_TRANSITION")).toBe(false);
    expect(isBrowserSwarmMissionExecutable("MONEY_BOUNDARY", "ECONOMIC_AUTHORITY")).toBe(false);
  });

  it("refuses a plan that mixes executable and non-executable missions rather than running the executable half", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [
        { id: "UI-1", severity: "HIGH" },
        { id: "ACC-1", severity: "CRITICAL" },
      ],
    });

    expect(() => assertBrowserSwarmMissionsExecutable(plan.missions)).toThrow(
      /MONEY_BOUNDARY/,
    );
  });

  it("refuses a forged Jev mission of an unexecutable family", () => {
    const forged: BrowserAttackMission = {
      id: "jev::MONEY_BOUNDARY",
      family: "MONEY_BOUNDARY",
      source: "JEV",
      invariantIds: ["UI-1"],
      invariantSeverity: "HIGH",
      oracle: "ECONOMIC_AUTHORITY",
      timeoutMs: 45_000,
      estimatedCostUnits: 5,
      evidence: ["TRACE"],
      jevProbability: 0.9,
    };

    expect(() => assertBrowserSwarmMissionsExecutable([forged])).toThrow(
      /MONEY_BOUNDARY/,
    );
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

    expect([...new Set(matrix.map((row) => row.invariantId))].sort()).toEqual(
      activeIds,
    );
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

    expect(missing).toEqual([
      "ACC-1:MONEY_BOUNDARY/ECONOMIC_AUTHORITY",
      "ACC-3:MONEY_BOUNDARY/STATE_TRANSITION",
      "LIFE-1:NAVIGATION_RACE/STATE_TRANSITION",
      "LIFE-1:STALE_UI/UI_BACKEND_AUTHORITY",
    ]);

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
      "ACC-2",
      "AUTH-1",
      "CONC-1",
      "CONS-1",
      "ECON-1",
      "ECON-2",
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
      "browserSwarmEconomicAttacks.ts",
      "browserSwarmBoundaryAttacks.ts",
      "browserSwarmBoundaryHarness.ts",
      "browserSwarmConsignmentAttack.ts",
      "browserSwarmNetworkRecoveryAttack.ts",
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
