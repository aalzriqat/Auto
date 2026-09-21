import { describe, expect, it } from "vitest";
import {
  MAX_BROWSER_SWARM_MISSIONS,
  PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES,
  SUPPORTED_BROWSER_SWARM_INVARIANT_IDS,
  buildBrowserSwarmRunManifest,
  classifyBrowserMissionEvidence,
  partitionBrowserAttackMissions,
  planBrowserAttackSwarm,
  type BrowserAttackMission,
} from "./browserAttackSwarm";
import {
  AUTOFLOW_INVARIANTS,
  isActiveInvariant,
} from "../autoflowInvariantCatalog";

describe("SCRUM-350 browser attack swarm control plane", () => {
  it("keeps deterministic browser mappings source-complete with the active invariant catalog", () => {
    const activeIds = AUTOFLOW_INVARIANTS
      .filter(isActiveInvariant)
      .map((invariant) => invariant.id)
      .sort();

    expect(SUPPORTED_BROWSER_SWARM_INVARIANT_IDS).toEqual(activeIds);
  });

  it("fails closed when an impacted invariant has no deterministic browser mapping", () => {
    expect(() =>
      planBrowserAttackSwarm({
        impactedInvariants: [{ id: "UI1", severity: "HIGH" }],
      }),
    ).toThrow(/no deterministic mission mapping/);
  });

  it("always emits deterministic tenant and authorization attacks for impacted critical invariants", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [
        { id: "TEN-1", severity: "CRITICAL" },
        { id: "AUTH-1", severity: "CRITICAL" },
      ],
    });

    expect(plan.deterministicMissionCount).toBe(2);
    expect(plan.missions.map((mission) => mission.family)).toEqual([
      "AUTHORIZATION_ABUSE",
      "TENANT_ESCAPE",
    ]);
    expect(plan.missions.every((mission) => mission.source === "DETERMINISTIC")).toBe(true);
  });

  it("uses union semantics: Jev can add exploration but cannot remove deterministic missions", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [{ id: "CONC-1", severity: "CRITICAL" }],
      jevSuggestions: [
        { family: "RTL_PARITY", probability: 0.91 },
        { family: "MULTI_TAB_RACE", probability: 0.99 },
      ],
    });

    expect(plan.missions.filter((mission) => mission.source === "DETERMINISTIC").map((mission) => mission.family)).toEqual([
      "MULTI_TAB_RACE",
      "NETWORK_RECOVERY",
    ]);
    expect(plan.missions.some((mission) => mission.family === "RTL_PARITY" && mission.source === "JEV")).toBe(true);
    expect(plan.missions.filter((mission) => mission.family === "MULTI_TAB_RACE")).toHaveLength(1);
  });

  it("never lets Jev suggestions crowd deterministic attacks out of a bounded mission budget", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [{ id: "LIFE-1", severity: "CRITICAL" }],
      maxMissions: 4,
      jevSuggestions: [
        { family: "RTL_PARITY", probability: 0.99 },
        { family: "TENANT_ESCAPE", probability: 0.98 },
        { family: "AUTHORIZATION_ABUSE", probability: 0.97 },
      ],
    });

    const deterministic = plan.missions.filter((mission) => mission.source === "DETERMINISTIC");
    expect(deterministic).toHaveLength(3);
    expect(plan.missions).toHaveLength(4);
    expect(plan.droppedJevSuggestions).toBe(2);
  });

  it("fails closed instead of dropping deterministic missions when the configured cap is too small", () => {
    expect(() =>
      planBrowserAttackSwarm({
        impactedInvariants: [{ id: "LIFE-1", severity: "CRITICAL" }],
        maxMissions: 2,
      }),
    ).toThrow(/refusing to drop required attacks/);
  });

  it("rejects malformed Jev probabilities rather than silently coercing them", () => {
    expect(() =>
      planBrowserAttackSwarm({
        impactedInvariants: [{ id: "UI-1", severity: "HIGH" }],
        jevSuggestions: [{ family: "RTL_PARITY", probability: 1.1 }],
      }),
    ).toThrow(/between 0 and 1/);
  });

  it("keeps the hard global mission cap", () => {
    expect(() =>
      planBrowserAttackSwarm({
        impactedInvariants: [],
        maxMissions: MAX_BROWSER_SWARM_MISSIONS + 1,
      }),
    ).toThrow(/maxMissions/);
  });

  it("partitions expensive missions deterministically without duplicates", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [
        { id: "LIFE-1", severity: "CRITICAL" },
        { id: "CONC-1", severity: "CRITICAL" },
        { id: "UI-1", severity: "HIGH" },
      ],
    });
    const first = partitionBrowserAttackMissions(plan.missions, 3);
    const second = partitionBrowserAttackMissions(plan.missions, 3);

    expect(first).toEqual(second);
    const ids = first.flat().map((mission) => mission.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(plan.missions.map((mission) => mission.id).sort());
  });

  it("refuses unsafe worker counts", () => {
    expect(() => partitionBrowserAttackMissions([], 0)).toThrow(/workerCount/);
    expect(() => partitionBrowserAttackMissions([], 9)).toThrow(/workerCount/);
  });

  it("only deterministic oracle evidence can produce PASS or CONFIRMED_BREACH", () => {
    const mission: BrowserAttackMission = {
      id: "det::TEN-1::TENANT_ESCAPE",
      family: "TENANT_ESCAPE",
      source: "DETERMINISTIC",
      invariantIds: ["TEN-1"],
      invariantSeverity: "CRITICAL",
      oracle: "TENANT_ISOLATION",
      timeoutMs: 45_000,
      estimatedCostUnits: 5,
      evidence: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
    };

    expect(
      classifyBrowserMissionEvidence(mission, {
        missionId: mission.id,
        workerId: "worker-1",
        startedAt: "2026-09-21T00:00:00.000Z",
        completedAt: "2026-09-21T00:00:01.000Z",
        oracle: {
          kind: "TENANT_ISOLATION",
          passed: true,
          summary: "foreign resource remained unreadable and unmodified",
        },
        artifacts: ["swarm/worker-1/trace.zip"],
      }),
    ).toBe("PASS");

    expect(
      classifyBrowserMissionEvidence(mission, {
        missionId: mission.id,
        workerId: "worker-1",
        startedAt: "2026-09-21T00:00:00.000Z",
        completedAt: "2026-09-21T00:00:01.000Z",
        oracle: {
          kind: "TENANT_ISOLATION",
          passed: false,
          summary: "foreign vehicle became visible",
        },
        artifacts: ["swarm/worker-1/trace.zip"],
      }),
    ).toBe("CONFIRMED_BREACH");
  });

  it("treats harness errors separately from product breaches", () => {
    const mission: BrowserAttackMission = {
      id: "det::AUTH-1::AUTHORIZATION_ABUSE",
      family: "AUTHORIZATION_ABUSE",
      source: "DETERMINISTIC",
      invariantIds: ["AUTH-1"],
      invariantSeverity: "CRITICAL",
      oracle: "AUTHORIZATION",
      timeoutMs: 45_000,
      estimatedCostUnits: 4,
      evidence: ["TRACE", "BACKEND_STATE"],
    };

    expect(
      classifyBrowserMissionEvidence(mission, {
        missionId: mission.id,
        workerId: "worker-2",
        startedAt: "2026-09-21T00:00:00.000Z",
        completedAt: "2026-09-21T00:00:01.000Z",
        oracle: {
          kind: "AUTHORIZATION",
          passed: false,
          summary: "oracle could not complete",
        },
        artifacts: ["swarm/worker-2/trace.zip"],
        harnessError: "browser crashed before the backend probe",
      }),
    ).toBe("HARNESS_ERROR");
  });

  it("binds every worker to one explicit disposable preview identity", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [
        { id: "UI-1", severity: "HIGH" },
      ],
    });
    const manifest = buildBrowserSwarmRunManifest({
      plan,
      workerCount: 2,
      runId: "pr-350-abcdef1234",
      previewName: "e2e-pr-350-abcdef1234",
      expectedCloudUrl: "https://example-preview.convex.cloud",
    });

    expect(manifest).toMatchObject({
      version: 1,
      runId: "pr-350-abcdef1234",
      previewName: "e2e-pr-350-abcdef1234",
      expectedCloudUrl: "https://example-preview.convex.cloud",
      requiresPreviewMarker: true,
    });
    expect(manifest.workers).toHaveLength(2);
    expect(manifest.workers.map((worker) => worker.workerId)).toEqual([
      "worker-1",
      "worker-2",
    ]);
    expect(
      manifest.workers.every((worker) =>
        worker.artifactRoot.startsWith("swarm/pr-350-abcdef1234/worker-"),
      ),
    ).toBe(true);
  });

  it("fails before manifest creation when Phase A has no executable handler", () => {
    const plan = planBrowserAttackSwarm({
      impactedInvariants: [{ id: "TEN-1", severity: "CRITICAL" }],
    });

    expect(PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES).toEqual([
      "RTL_PARITY",
      "UI_BACKEND_MISMATCH",
    ]);
    expect(() =>
      buildBrowserSwarmRunManifest({
        plan,
        workerCount: 1,
        runId: "pr-350-abcdef1234",
        previewName: "e2e-pr-350-abcdef1234",
        expectedCloudUrl: "https://example-preview.convex.cloud",
      }),
    ).toThrow(/no executable handler.*TENANT_ESCAPE/i);
  });

  it("refuses ambiguous or non-preview swarm targets before browser execution", () => {
    const plan = planBrowserAttackSwarm({ impactedInvariants: [] });

    expect(() =>
      buildBrowserSwarmRunManifest({
        plan,
        workerCount: 1,
        runId: "pr-350-abcdef1234",
        previewName: "production",
        expectedCloudUrl: "https://example.convex.cloud",
      }),
    ).toThrow(/e2e-\*/);

    expect(() =>
      buildBrowserSwarmRunManifest({
        plan,
        workerCount: 1,
        runId: "pr-350-abcdef1234",
        previewName: "e2e-pr-350-abcdef1234",
        expectedCloudUrl: "http://example.convex.cloud",
      }),
    ).toThrow(/bare HTTPS deployment origin/);

    expect(() =>
      buildBrowserSwarmRunManifest({
        plan,
        workerCount: 1,
        runId: "pr-350-abcdef1234",
        previewName: "e2e-pr-350-abcdef1234",
        expectedCloudUrl: "https://example-preview.invalid",
      }),
    ).toThrow(/convex\.cloud/);

    expect(() =>
      buildBrowserSwarmRunManifest({
        plan,
        workerCount: 1,
        runId: "../escape",
        previewName: "e2e-pr-350-abcdef1234",
        expectedCloudUrl: "https://example.convex.cloud",
      }),
    ).toThrow(/runId/);
  });

  it("rejects evidence path traversal", () => {
    const mission: BrowserAttackMission = {
      id: "det::UI-1::RTL_PARITY",
      family: "RTL_PARITY",
      source: "DETERMINISTIC",
      invariantIds: ["UI-1"],
      invariantSeverity: "HIGH",
      oracle: "UI_BACKEND_AUTHORITY",
      timeoutMs: 45_000,
      estimatedCostUnits: 3,
      evidence: ["TRACE", "SCREENSHOT"],
    };

    expect(() =>
      classifyBrowserMissionEvidence(mission, {
        missionId: mission.id,
        workerId: "worker-3",
        startedAt: "2026-09-21T00:00:00.000Z",
        completedAt: "2026-09-21T00:00:01.000Z",
        oracle: {
          kind: "UI_BACKEND_AUTHORITY",
          passed: true,
          summary: "behavior matched",
        },
        artifacts: ["../raw-secret.log"],
      }),
    ).toThrow(/unsafe artifact path/);
  });
});
