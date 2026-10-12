import { describe, expect, it } from "vitest";
import {
  PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES,
  assertBrowserSwarmMissionsExecutable,
  assertMandatoryBrowserSwarmCoverage,
  browserSwarmCoverageMatrix,
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
      "DUPLICATE_SUBMIT",
      "MULTI_TAB_RACE",
      "RTL_PARITY",
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
        { id: "TEN-1", severity: "CRITICAL" },
        { id: "ECON-2", severity: "CRITICAL" },
      ]),
    ).toThrow(/no executable handler.*TENANT_ESCAPE.*TEN-1/i);
  });

  it("refuses a plan that mixes executable and non-executable missions rather than running the executable half", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [
        { id: "UI-1", severity: "HIGH" },
        { id: "CONC-1", severity: "CRITICAL" },
      ],
    });

    expect(() => assertBrowserSwarmMissionsExecutable(plan.missions)).toThrow(
      /NETWORK_RECOVERY/,
    );
  });

  it("refuses a forged Jev mission of an unexecutable family", () => {
    const forged: BrowserAttackMission = {
      id: "jev::TENANT_ESCAPE",
      family: "TENANT_ESCAPE",
      source: "JEV",
      invariantIds: ["UI-1"],
      invariantSeverity: "HIGH",
      oracle: "TENANT_ISOLATION",
      timeoutMs: 45_000,
      estimatedCostUnits: 5,
      evidence: ["TRACE"],
      jevProbability: 0.9,
    };

    expect(() => assertBrowserSwarmMissionsExecutable([forged])).toThrow(
      /TENANT_ESCAPE/,
    );
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
        (PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES as readonly string[]).includes(
          row.family,
        ),
      );
    }
  });

  it("names the Phase A gap explicitly so a new handler or a new mapping must update it", () => {
    // Phase A is NOT complete. Every family below is a mandatory deterministic
    // obligation of an active CRITICAL invariant with no executable handler.
    // Implementing one removes it from this list in the same change; adding a
    // new unexecutable mapping adds to it. Either way the gap stays visible.
    const missing = [
      ...new Set(
        browserSwarmCoverageMatrix()
          .filter((row) => !row.executable)
          .map((row) => row.family),
      ),
    ].sort();

    expect(missing).toEqual([
      "AUTHORIZATION_ABUSE",
      "COMPLETENESS_BOUNDARY",
      "CONSIGNMENT_ECONOMICS",
      "LIFECYCLE_REVERSAL",
      "MONEY_BOUNDARY",
      "NAVIGATION_RACE",
      "NETWORK_RECOVERY",
      "STALE_UI",
      "TENANT_ESCAPE",
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
    expect(fullyCovered).toEqual(["ECON-2", "UI-1"]);
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
