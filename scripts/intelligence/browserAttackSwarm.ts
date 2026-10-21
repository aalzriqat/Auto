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
  | "UI_BACKEND_MISMATCH"
  | "ACCOUNTING_DATE_BOUNDARY";

export const PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES = [
  "DUPLICATE_SUBMIT",
  "MULTI_TAB_RACE",
  "RTL_PARITY",
  "UI_BACKEND_MISMATCH",
  "TENANT_ESCAPE",
  "AUTHORIZATION_ABUSE",
  "LIFECYCLE_REVERSAL",
  "COMPLETENESS_BOUNDARY",
  "NETWORK_RECOVERY",
  "CONSIGNMENT_ECONOMICS",
  "STALE_UI",
  "MONEY_BOUNDARY",
  "NAVIGATION_RACE",
  "ACCOUNTING_DATE_BOUNDARY",
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

/**
 * A handler judges the oracles listed here and no others. A family with a
 * handler is not "executable" for a mission whose oracle the handler does not
 * judge: reporting it so would certify an obligation nothing checks (a forged
 * LIFECYCLE_REVERSAL mission asking for ECONOMIC_AUTHORITY has a handler, but
 * that handler judges only REVERSAL_RECONCILIATION and STATE_TRANSITION).
 */
const PHASE_A_EXECUTABLE_FAMILY_ORACLES: Readonly<
  Record<(typeof PHASE_A_EXECUTABLE_BROWSER_ATTACK_FAMILIES)[number], readonly BrowserOracleKind[]>
> = {
  DUPLICATE_SUBMIT: ["IDEMPOTENCY_SINGLE_EFFECT"],
  MULTI_TAB_RACE: ["IDEMPOTENCY_SINGLE_EFFECT"],
  RTL_PARITY: ["UI_BACKEND_AUTHORITY"],
  UI_BACKEND_MISMATCH: ["UI_BACKEND_AUTHORITY"],
  TENANT_ESCAPE: ["TENANT_ISOLATION"],
  AUTHORIZATION_ABUSE: ["AUTHORIZATION"],
  // ACC-2 reconciles a reversed expense; LIFE-1 judges a deposit void's state transition.
  LIFECYCLE_REVERSAL: ["REVERSAL_RECONCILIATION", "STATE_TRANSITION"],
  COMPLETENESS_BOUNDARY: ["LIST_COMPLETENESS"],
  NETWORK_RECOVERY: ["IDEMPOTENCY_SINGLE_EFFECT", "STATE_TRANSITION"],
  CONSIGNMENT_ECONOMICS: ["ECONOMIC_AUTHORITY"],
  STALE_UI: ["UI_BACKEND_AUTHORITY"],
  // ACC-1 (a financed sale of owned stock) judges ECONOMIC_AUTHORITY; LIFE-1 (voiding a directly paid cost) is a
  // distinct scenario of the same family that judges STATE_TRANSITION. Only that one LIFE-1 path is covered.
  MONEY_BOUNDARY: ["ECONOMIC_AUTHORITY", "STATE_TRANSITION"],
  NAVIGATION_RACE: ["STATE_TRANSITION"],
  // ACC-3 (SCRUM-795): manual journals are off for the pilot, so this mission covers ONLY the create door being
  // refused with the pilot code and leaving journals and drafts unchanged. It does not cover the approve door, the
  // posted date or the closed-period rule (proven in backend tests with the switch mocked off), a LOCKED or
  // unopened period, outbox posting or a reopen.
  ACCOUNTING_DATE_BOUNDARY: ["STATE_TRANSITION"],
};

/** True when a handler exists for the family AND judges the mission's oracle. */
export function isBrowserSwarmMissionExecutable(
  family: BrowserAttackFamily,
  oracle: BrowserOracleKind,
): boolean {
  if (!PHASE_A_EXECUTABLE_FAMILY_SET.has(family)) return false;
  const judged: readonly BrowserOracleKind[] =
    PHASE_A_EXECUTABLE_FAMILY_ORACLES[family as keyof typeof PHASE_A_EXECUTABLE_FAMILY_ORACLES];
  return judged.includes(oracle);
}

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

/**
 * Economic attacks drive several real submissions, a forced websocket
 * reconnect and bounded backend authority reads against a cold preview. A
 * budget that cannot fit the attack turns every run into HARNESS_ERROR, which
 * is fail-closed but proves nothing, so these families get a larger bound.
 */
const FAMILY_TIMEOUT_MS: Partial<Record<BrowserAttackFamily, number>> = {
  DUPLICATE_SUBMIT: 180_000,
  MULTI_TAB_RACE: 180_000,
  // Opens a second authenticated seat, creates a foreign tenant and probes it.
  TENANT_ESCAPE: 180_000,
  AUTHORIZATION_ABUSE: 120_000,
  // Readiness waits alone can total 60s (20s org route, 15s Add Customer, 5s dialog, 15s reload search, 5s result) before launch, the customer submit and the backend query.
  UI_BACKEND_MISMATCH: 120_000,
  // Posts an expense and reverses it twice (ACC-2), or takes two deposits, voids one
  // and reads the ledger three times (LIFE-1); the larger bound fits the deposit leg.
  LIFECYCLE_REVERSAL: 240_000,
  // Seeds more rows than one page holds, then walks the whole list.
  COMPLETENESS_BOUNDARY: 240_000,
  // Holds the connection down, waits out the recovery window, then settles.
  NETWORK_RECOVERY: 180_000,
  // About 25 product commands (some may wait out the write rate limit) plus up to 30s for the sale to post.
  CONSIGNMENT_ECONOMICS: 240_000,
  // Posts an expense, arms its reversal on the screen, reverses it server-side, then settles the ledger three times.
  STALE_UI: 180_000,
  // About 27 product commands (some may wait out the write rate limit) plus up to 30s for the sale to post.
  MONEY_BOUNDARY: 240_000,
  // Posts an expense, races its reversal against history back/forward, settles the ledger and repeats the reversal if it did not apply.
  // Five ledger reads of up to 20s each plus one shared 60s wait for a queued posting (SCRUM-851), with screen steps on top.
  NAVIGATION_RACE: 240_000,
  // Establishes two periods, closes one, prepares and approves two journals, then reads the periods, the journals and the pending list.
  ACCOUNTING_DATE_BOUNDARY: 180_000,
};

export function browserMissionTimeoutMs(family: BrowserAttackFamily): number {
  return FAMILY_TIMEOUT_MS[family] ?? DEFAULT_TIMEOUT_MS;
}

const template = (
  family: BrowserAttackFamily,
  oracle: BrowserOracleKind,
  estimatedCostUnits: number,
  evidence: BrowserAttackMission["evidence"],
): DeterministicMissionTemplate => ({
  family,
  oracle,
  timeoutMs: browserMissionTimeoutMs(family),
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
  // The create door refused while manual journals are off for the pilot (SCRUM-795), judged on the backend's journal and draft state.
  "ACC-3": [
    template("ACCOUNTING_DATE_BOUNDARY", "STATE_TRANSITION", 5, [
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
    // Voiding a directly paid deal cost: one linked reversal, the sibling cost untouched.
    template("MONEY_BOUNDARY", "STATE_TRANSITION", 5, [
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
  Object.keys(DETERMINISTIC_MISSIONS).sort((left, right) => left.localeCompare(right)),
);

/**
 * Active invariants no browser mission judges. Planning one throws, so a change that impacts it refuses the
 * swarm rather than passing it. Removing an entry requires a mission whose oracle really judges the invariant.
 */
export const UNSUPPORTED_BROWSER_SWARM_INVARIANTS: Readonly<Record<string, string>> = Object.freeze({});

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
  ACCOUNTING_DATE_BOUNDARY: "STATE_TRANSITION",
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
  ACCOUNTING_DATE_BOUNDARY: ["TRACE", "SCREENSHOT", "BACKEND_STATE"],
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
    const key = `${mission.family}::${[...mission.invariantIds].sort((left, right) => left.localeCompare(right)).join(",")}`;
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
  ].sort((left, right) => left.localeCompare(right));
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

  const impactedIds = [...new Set(impactedInvariants.map((entry) => entry.id))].sort(
    (left, right) => left.localeCompare(right),
  );
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
      timeoutMs: browserMissionTimeoutMs(suggestion.family),
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

/**
 * SCRUM-826 planner-to-executor coverage contract. One source of truth for
 * "can this plan actually run": the trusted plan calls it before any preview,
 * build or E2E is paid for, and the worker manifest calls it again. A plan
 * with ANY unexecutable mission is refused whole — running the executable
 * half would let the missing obligations look satisfied.
 */
export function assertBrowserSwarmMissionsExecutable(
  missions: readonly BrowserAttackMission[],
): void {
  const unsupported = new Map<string, Set<string>>();
  for (const mission of missions) {
    if (isBrowserSwarmMissionExecutable(mission.family, mission.oracle)) continue;
    const label = PHASE_A_EXECUTABLE_FAMILY_SET.has(mission.family)
      ? `${mission.family} with oracle ${mission.oracle}`
      : mission.family;
    const invariants = unsupported.get(label) ?? new Set<string>();
    for (const id of mission.invariantIds) invariants.add(id);
    unsupported.set(label, invariants);
  }
  if (unsupported.size === 0) return;
  const described = [...unsupported.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([label, invariants]) =>
        `${label} (${[...invariants].sort((l, r) => l.localeCompare(r)).join(", ")})`,
    );
  throw new Error(
    "Browser swarm Phase A has no executable handler for mission family/families: " +
      described.join(", "),
  );
}

/**
 * Plans ONLY the mandatory deterministic obligations of a trusted impact set
 * and refuses it if any cannot execute. Jev is excluded on purpose: this is
 * the pre-provisioning check of what the change obliges, which exploration
 * can add to but never subtract from.
 */
export function assertMandatoryBrowserSwarmCoverage(
  impactedInvariants: readonly { id: string; severity: InvariantSeverity }[],
): BrowserMissionPlan {
  if (impactedInvariants.length === 0) {
    throw new Error(
      "Browser swarm coverage requires at least one impacted invariant; an empty set has no obligations to certify",
    );
  }
  const plan = planBrowserAttackSwarm({ impactedInvariants });
  assertBrowserSwarmMissionsExecutable(plan.missions);
  return plan;
}

export interface BrowserSwarmCoverageRow {
  invariantId: string;
  family: BrowserAttackFamily;
  oracle: BrowserOracleKind;
  executable: boolean;
}

/** The complete mandatory-mission coverage matrix, one row per mapping. */
export function browserSwarmCoverageMatrix(): readonly BrowserSwarmCoverageRow[] {
  return SUPPORTED_BROWSER_SWARM_INVARIANT_IDS.flatMap((invariantId) =>
    (DETERMINISTIC_MISSIONS[invariantId] ?? []).map((missionTemplate) => ({
      invariantId,
      family: missionTemplate.family,
      oracle: missionTemplate.oracle,
      executable: isBrowserSwarmMissionExecutable(missionTemplate.family, missionTemplate.oracle),
    })),
  );
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
  // Second, independent enforcement point: the trusted plan already refused
  // this before provisioning, but the worker never trusts that it did.
  assertBrowserSwarmMissionsExecutable(plan.missions);

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
