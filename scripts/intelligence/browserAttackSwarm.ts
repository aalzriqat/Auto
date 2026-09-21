import type { InvariantSeverity } from "../autoflowInvariantCatalog";

export const MAX_BROWSER_SWARM_WORKERS = 8;
export const MAX_BROWSER_SWARM_MISSIONS = 64;
export const JEV_BROWSER_MISSION_THRESHOLD = 0.35;

export type BrowserAttackFamily =
  | "TENANT_ESCAPE"
  | "AUTHORIZATION_ABUSE"
  | "DUPLICATE_SUBMIT"
  | "STALE_UI"
  | "LIFECYCLE_REVERSAL"
  | "CONSIGNMENT_ECONOMICS"
  | "FINANCE_REORDERING"
  | "MONEY_BOUNDARY"
  | "NAVIGATION_RACE"
  | "NETWORK_RECOVERY"
  | "MULTI_TAB_RACE"
  | "COMPLETENESS_BOUNDARY"
  | "RTL_PARITY"
  | "UI_BACKEND_MISMATCH";

export const PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES = [
  "RTL_PARITY",
  "UI_BACKEND_MISMATCH",
] as const satisfies readonly BrowserAttackFamily[];

const PHASE_A_EXECUTABLE_FAMILY_SET = new Set<BrowserAttackFamily>(
  PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES,
);

export type BrowserOracleKind =
  | "TENANT_ISOLATION"
  | "AUTHORIZATION"
  | "IDEMPOTENCY_SINGLE_EFFECT"
  | "STATE_TRANSITION"
  | "REVERSAL_RECONCILIATION"
  | "ECONOMIC_AUTHORITY"
  | "LIST_COMPLETENESS"
  | "UI_BACKEND_AUTHORITY";

export type MissionSource = "DETERMINISTIC" | "JEV";

export interface BrowserAttackMission {
  id: string;
  family: BrowserAttackFamily;
  source: MissionSource;
  invariantIds: readonly string[];
  invariantSeverity: InvariantSeverity;
  oracle: BrowserOracleKind;
  timeoutMs: number;
  estimatedCostUnits: number;
  evidence: readonly (
    | "TRACE"
    | "SCREENSHOT"
    | "BACKEND_STATE"
    | "NETWORK_LOG"
    | "CONSOLE_LOG"
  )[];
  jevProbability?: number;
}

export interface JevBrowserMissionSuggestion {
  family: BrowserAttackFamily;
  probability: number;
}

export interface BrowserMissionPlan {
  missions: readonly BrowserAttackMission[];
  deterministicMissionCount: number;
  jevMissionCount: number;
  droppedJevSuggestions: number;
}


export interface BrowserSwarmWorkerPlan {
  workerId: string;
  artifactRoot: string;
  missions: readonly BrowserAttackMission[];
}

export interface BrowserSwarmRunManifest {
  version: 1;
  runId: string;
  previewName: string;
  expectedCloudUrl: string;
  requiresPreviewMarker: true;
  workers: readonly BrowserSwarmWorkerPlan[];
}

export interface BrowserMissionEvidence {
  missionId: string;
  workerId: string;
  startedAt: string;
  completedAt: string;
  oracle: {
    kind: BrowserOracleKind;
    passed: boolean;
    summary: string;
  };
  artifacts: readonly string[];
  harnessError?: string;
}

export type BrowserMissionOutcome =
  | "PASS"
  | "CONFIRMED_BREACH"
  | "HARNESS_ERROR";

type DeterministicMissionTemplate = Omit<
  BrowserAttackMission,
  "id" | "source" | "invariantIds" | "invariantSeverity"
>;

const DEFAULT_TIMEOUT_MS = 45_000;

const template = (
  family: BrowserAttackFamily,
  oracle: BrowserOracleKind,
  estimatedCostUnits: number,
  evidence: BrowserAttackMission["evidence"],
): DeterministicMissionTemplate => ({
  family,
  oracle,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  estimatedCostUnits,
  evidence,
});

const DETERMINISTIC_MISSIONS: Readonly<
  Record<string, readonly DeterministicMissionTemplate[]>
> = {
  "TEN-1": [
    template("TENANT_ESCAPE", "TENANT_ISOLATION", 5, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
  ],
  "AUTH-1": [
    template("AUTHORIZATION_ABUSE", "AUTHORIZATION", 4, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "ECON-1": [
    template("DUPLICATE_SUBMIT", "IDEMPOTENCY_SINGLE_EFFECT", 5, [
      "TRACE",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
    template("NETWORK_RECOVERY", "IDEMPOTENCY_SINGLE_EFFECT", 6, [
      "TRACE",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
  ],
  "ECON-2": [
    template("DUPLICATE_SUBMIT", "IDEMPOTENCY_SINGLE_EFFECT", 5, [
      "TRACE",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
    template("MULTI_TAB_RACE", "IDEMPOTENCY_SINGLE_EFFECT", 7, [
      "TRACE",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
  ],
  "ACC-1": [
    template("MONEY_BOUNDARY", "ECONOMIC_AUTHORITY", 6, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "ACC-2": [
    template("LIFECYCLE_REVERSAL", "REVERSAL_RECONCILIATION", 7, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "ACC-3": [
    template("MONEY_BOUNDARY", "STATE_TRANSITION", 5, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "CONS-1": [
    template("CONSIGNMENT_ECONOMICS", "ECONOMIC_AUTHORITY", 6, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "LIFE-1": [
    template("LIFECYCLE_REVERSAL", "STATE_TRANSITION", 7, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
    template("NAVIGATION_RACE", "STATE_TRANSITION", 5, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
    template("STALE_UI", "UI_BACKEND_AUTHORITY", 4, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "PERF-1": [
    template("COMPLETENESS_BOUNDARY", "LIST_COMPLETENESS", 6, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
  ],
  "CONC-1": [
    template("MULTI_TAB_RACE", "IDEMPOTENCY_SINGLE_EFFECT", 8, [
      "TRACE",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
    template("NETWORK_RECOVERY", "STATE_TRANSITION", 6, [
      "TRACE",
      "BACKEND_STATE",
      "NETWORK_LOG",
    ]),
  ],
  "UI-1": [
    template("UI_BACKEND_MISMATCH", "UI_BACKEND_AUTHORITY", 4, [
      "TRACE",
      "SCREENSHOT",
      "BACKEND_STATE",
    ]),
    template("RTL_PARITY", "UI_BACKEND_AUTHORITY", 3, [
      "TRACE",
      "SCREENSHOT",
    ]),
  ],
};

export const SUPPORTED_BROWSER_SWARM_INVARIANT_IDS = Object.freeze(
  Object.keys(DETERMINISTIC_MISSIONS).sort(),
);

const JEV_DEFAULT_ORACLE: Readonly<Record<BrowserAttackFamily, BrowserOracleKind>> = {
  TENANT_ESCAPE: "TENANT_ISOLATION",
  AUTHORIZATION_ABUSE: "AUTHORIZATION",
  DUPLICATE_SUBMIT: "IDEMPOTENCY_SINGLE_EFFECT",
  STALE_UI: "UI_BACKEND_AUTHORITY",
  LIFECYCLE_REVERSAL: "REVERSAL_RECONCILIATION",
  CONSIGNMENT_ECONOMICS: "ECONOMIC_AUTHORITY",
  FINANCE_REORDERING: "STATE_TRANSITION",
  MONEY_BOUNDARY: "ECONOMIC_AUTHORITY",
  NAVIGATION_RACE: "STATE_TRANSITION",
  NETWORK_RECOVERY: "STATE_TRANSITION",
  MULTI_TAB_RACE: "IDEMPOTENCY_SINGLE_EFFECT",
  COMPLETENESS_BOUNDARY: "LIST_COMPLETENESS",
  RTL_PARITY: "UI_BACKEND_AUTHORITY",
  UI_BACKEND_MISMATCH: "UI_BACKEND_AUTHORITY",
};

const FAMILY_EVIDENCE: Readonly<
  Record<BrowserAttackFamily, BrowserAttackMission["evidence"]>
> = {
  TENANT_ESCAPE: ["TRACE", "SCREENSHOT", "BACKEND_STATE", "NETWORK_LOG"],
  AUTHORIZATION_ABUSE: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  DUPLICATE_SUBMIT: ["TRACE", "BACKEND_STATE", "NETWORK_LOG"],
  STALE_UI: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  LIFECYCLE_REVERSAL: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  CONSIGNMENT_ECONOMICS: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  FINANCE_REORDERING: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  MONEY_BOUNDARY: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  NAVIGATION_RACE: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  NETWORK_RECOVERY: ["TRACE", "BACKEND_STATE", "NETWORK_LOG"],
  MULTI_TAB_RACE: ["TRACE", "BACKEND_STATE", "NETWORK_LOG"],
  COMPLETENESS_BOUNDARY: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
  RTL_PARITY: ["TRACE", "SCREENSHOT"],
  UI_BACKEND_MISMATCH: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
};

function stableId(parts: readonly string[]): string {
  return parts.join("::").replace(/[^A-Za-z0-9:_-]/g, "-");
}

function assertProbability(probability: number): void {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`Jev browser mission probability must be between 0 and 1; got ${probability}`);
  }
}

function dedupeByMissionKey(
  missions: readonly BrowserAttackMission[],
): BrowserAttackMission[] {
  const seen = new Set<string>();
  const result: BrowserAttackMission[] = [];
  for (const mission of missions) {
    const key = `${mission.family}::${[...mission.invariantIds].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(mission);
  }
  return result;
}

export function deterministicBrowserMissionsForInvariant(
  invariantId: string,
  severity: InvariantSeverity,
): readonly BrowserAttackMission[] {
  const templates = DETERMINISTIC_MISSIONS[invariantId] ?? [];
  return templates.map((missionTemplate) => ({
    ...missionTemplate,
    id: stableId(["det", invariantId, missionTemplate.family]),
    source: "DETERMINISTIC",
    invariantIds: [invariantId],
    invariantSeverity: severity,
  }));
}

export function planBrowserAttackSwarm({
  impactedInvariants,
  jevSuggestions = [],
  maxMissions = MAX_BROWSER_SWARM_MISSIONS,
}: {
  impactedInvariants: readonly { id: string; severity: InvariantSeverity }[];
  jevSuggestions?: readonly JevBrowserMissionSuggestion[];
  maxMissions?: number;
}): BrowserMissionPlan {
  if (!Number.isInteger(maxMissions) || maxMissions < 1 || maxMissions > MAX_BROWSER_SWARM_MISSIONS) {
    throw new Error(
      `Browser swarm maxMissions must be an integer from 1 to ${MAX_BROWSER_SWARM_MISSIONS}`,
    );
  }

  const unsupportedInvariantIds = [
    ...new Set(
      impactedInvariants
        .map((invariant) => invariant.id)
        .filter((id) => !(id in DETERMINISTIC_MISSIONS)),
    ),
  ].sort();
  if (unsupportedInvariantIds.length > 0) {
    throw new Error(
      "Browser swarm has no deterministic mission mapping for impacted invariant(s): " +
        unsupportedInvariantIds.join(", "),
    );
  }

  const deterministic = dedupeByMissionKey(
    impactedInvariants.flatMap((invariant) =>
      deterministicBrowserMissionsForInvariant(invariant.id, invariant.severity),
    ),
  ).sort((a, b) => a.id.localeCompare(b.id));

  if (deterministic.length > maxMissions) {
    throw new Error(
      `Browser swarm requires ${deterministic.length} deterministic missions but maxMissions is ${maxMissions}; refusing to drop required attacks`,
    );
  }

  const impactedIds = [...new Set(impactedInvariants.map((entry) => entry.id))].sort();
  const jevCandidates = jevSuggestions
    .map((suggestion) => {
      assertProbability(suggestion.probability);
      return suggestion;
    })
    .filter((suggestion) => suggestion.probability >= JEV_BROWSER_MISSION_THRESHOLD)
    .sort(
      (a, b) =>
        b.probability - a.probability ||
        a.family.localeCompare(b.family),
    )
    .map<BrowserAttackMission>((suggestion) => ({
      id: stableId(["jev", suggestion.family]),
      family: suggestion.family,
      source: "JEV",
      invariantIds: impactedIds,
      invariantSeverity: impactedInvariants.some(
        (entry) => entry.severity === "CRITICAL",
      )
        ? "CRITICAL"
        : "HIGH",
      oracle: JEV_DEFAULT_ORACLE[suggestion.family],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      estimatedCostUnits: 5,
      evidence: FAMILY_EVIDENCE[suggestion.family],
      jevProbability: suggestion.probability,
    }));

  const deterministicFamilies = new Set(deterministic.map((mission) => mission.family));
  const novelJev = dedupeByMissionKey(
    jevCandidates.filter((mission) => !deterministicFamilies.has(mission.family)),
  );
  const remainingCapacity = maxMissions - deterministic.length;
  const admittedJev = novelJev.slice(0, remainingCapacity);

  return {
    missions: [...deterministic, ...admittedJev],
    deterministicMissionCount: deterministic.length,
    jevMissionCount: admittedJev.length,
    droppedJevSuggestions: novelJev.length - admittedJev.length,
  };
}

export function partitionBrowserAttackMissions(
  missions: readonly BrowserAttackMission[],
  workerCount: number,
): readonly (readonly BrowserAttackMission[])[] {
  if (
    !Number.isInteger(workerCount) ||
    workerCount < 1 ||
    workerCount > MAX_BROWSER_SWARM_WORKERS
  ) {
    throw new Error(
      `Browser swarm workerCount must be an integer from 1 to ${MAX_BROWSER_SWARM_WORKERS}`,
    );
  }

  const buckets: BrowserAttackMission[][] = Array.from(
    { length: workerCount },
    () => [],
  );
  const loads = Array.from({ length: workerCount }, () => 0);

  const ordered = [...missions].sort(
    (a, b) =>
      b.estimatedCostUnits - a.estimatedCostUnits ||
      a.id.localeCompare(b.id),
  );

  for (const mission of ordered) {
    let target = 0;
    for (let index = 1; index < workerCount; index += 1) {
      if (loads[index] < loads[target]) target = index;
    }
    buckets[target].push(mission);
    loads[target] += mission.estimatedCostUnits;
  }

  return buckets;
}

function assertSafeRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(runId)) {
    throw new Error(
      "Browser swarm runId must be a lowercase safe identifier of at most 81 characters",
    );
  }
}

function assertSwarmPreviewIdentity(
  previewName: string,
  expectedCloudUrl: string,
): void {
  if (!/^e2e-[a-z0-9][a-z0-9._-]{0,56}$/.test(previewName)) {
    throw new Error(
      "Browser swarm previewName must be an explicit e2e-* disposable preview identifier",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(expectedCloudUrl);
  } catch {
    throw new TypeError("Browser swarm expectedCloudUrl must be a valid URL");
  }
  if (
    parsed.protocol !== "https:" ||
    !/^[a-z0-9-]+\.convex\.cloud$/.test(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "Browser swarm expectedCloudUrl must be a bare HTTPS deployment origin on convex.cloud",
    );
  }
}

export function buildBrowserSwarmRunManifest({
  plan,
  workerCount,
  runId,
  previewName,
  expectedCloudUrl,
}: {
  plan: BrowserMissionPlan;
  workerCount: number;
  runId: string;
  previewName: string;
  expectedCloudUrl: string;
}): BrowserSwarmRunManifest {
  assertSafeRunId(runId);
  assertSwarmPreviewIdentity(previewName, expectedCloudUrl);

  const unsupportedFamilies = [
    ...new Set(
      plan.missions
        .map((mission) => mission.family)
        .filter((family) => !PHASE_A_EXECUTABLE_FAMILY_SET.has(family)),
    ),
  ].sort();
  if (unsupportedFamilies.length > 0) {
    throw new Error(
      "Browser swarm Phase A has no executable handler for mission family/families: " +
        unsupportedFamilies.join(", "),
    );
  }

  const partitions = partitionBrowserAttackMissions(plan.missions, workerCount);

  return {
    version: 1,
    runId,
    previewName,
    expectedCloudUrl,
    requiresPreviewMarker: true,
    workers: partitions.map((missions, index) => ({
      workerId: `worker-${index + 1}`,
      artifactRoot: `swarm/${runId}/worker-${index + 1}`,
      missions,
    })),
  };
}

function isSafeArtifactPath(pathValue: string): boolean {
  if (!pathValue || pathValue.startsWith("/") || pathValue.includes("\\")) return false;
  const segments = pathValue.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

export function classifyBrowserMissionEvidence(
  mission: BrowserAttackMission,
  evidence: BrowserMissionEvidence,
): BrowserMissionOutcome {
  if (evidence.missionId !== mission.id) {
    throw new Error(
      `Browser mission evidence id ${evidence.missionId} does not match mission ${mission.id}`,
    );
  }
  if (evidence.oracle.kind !== mission.oracle) {
    throw new Error(
      `Browser mission ${mission.id} expected oracle ${mission.oracle} but evidence used ${evidence.oracle.kind}`,
    );
  }
  if (evidence.artifacts.some((artifact) => !isSafeArtifactPath(artifact))) {
    throw new Error(
      `Browser mission ${mission.id} contains an unsafe artifact path`,
    );
  }
  if (evidence.harnessError) return "HARNESS_ERROR";
  return evidence.oracle.passed ? "PASS" : "CONFIRMED_BREACH";
}
