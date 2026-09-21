import {
  classifyBrowserMissionEvidence,
  type BrowserAttackFamily,
  type BrowserAttackMission,
  type BrowserMissionEvidence,
  type BrowserMissionOutcome,
  type BrowserSwarmRunManifest,
  type BrowserSwarmWorkerPlan,
} from "./browserAttackSwarm";

export interface BrowserPreviewVerification {
  verified: boolean;
  summary: string;
}

export type BrowserPreviewVerifier = (
  manifest: BrowserSwarmRunManifest,
) => Promise<BrowserPreviewVerification>;

export interface BrowserMissionExecutionContext {
  manifest: BrowserSwarmRunManifest;
  worker: BrowserSwarmWorkerPlan;
  mission: BrowserAttackMission;
  signal: AbortSignal;
}

export type BrowserMissionHandler = (
  context: BrowserMissionExecutionContext,
) => Promise<BrowserMissionEvidence>;

export type BrowserAttackHandlerRegistry = Partial<
  Record<BrowserAttackFamily, BrowserMissionHandler>
>;

export interface BrowserMissionExecutionResult {
  missionId: string;
  outcome: BrowserMissionOutcome;
  evidence: BrowserMissionEvidence;
}

export interface BrowserSwarmWorkerExecution {
  workerId: string;
  previewVerification: BrowserPreviewVerification;
  results: readonly BrowserMissionExecutionResult[];
  passed: boolean;
  confirmedBreachCount: number;
  harnessErrorCount: number;
}

export class BrowserSwarmExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSwarmExecutionError";
  }
}

function sanitizeHarnessError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.name + ": " + error.message
      : String(error);

  return raw
    .replace(/\r?\n/g, " ")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(/sk_(?:test|live)_[A-Za-z0-9_-]+/g, "<redacted-clerk-key>")
    .replace(/preview:[^|\s]+\|[^\s]+/g, "<redacted-preview-key>")
    .slice(0, 600);
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function findWorker(
  manifest: BrowserSwarmRunManifest,
  workerId: string,
): BrowserSwarmWorkerPlan {
  const matches = manifest.workers.filter((worker) => worker.workerId === workerId);
  if (matches.length !== 1) {
    throw new BrowserSwarmExecutionError(
      "Browser swarm manifest must contain exactly one worker named " + workerId,
    );
  }

  const worker = matches[0];
  const expectedArtifactRoot =
    "swarm/" + manifest.runId + "/" + worker.workerId;

  if (worker.artifactRoot !== expectedArtifactRoot) {
    throw new BrowserSwarmExecutionError(
      "Browser swarm worker " +
        worker.workerId +
        " artifactRoot must be " +
        expectedArtifactRoot,
    );
  }

  return worker;
}

function artifactBelongsToWorker(
  worker: BrowserSwarmWorkerPlan,
  artifact: string,
): boolean {
  return artifact.startsWith(worker.artifactRoot + "/");
}

function harnessEvidence(
  mission: BrowserAttackMission,
  workerId: string,
  startedAt: string,
  completedAt: string,
  error: unknown,
): BrowserMissionEvidence {
  return {
    missionId: mission.id,
    workerId,
    startedAt,
    completedAt,
    oracle: {
      kind: mission.oracle,
      passed: false,
      summary: "Mission did not produce authoritative oracle evidence.",
    },
    artifacts: [],
    harnessError: sanitizeHarnessError(error),
  };
}

async function runHandlerWithCancellation(
  handler: BrowserMissionHandler,
  context: Omit<BrowserMissionExecutionContext, "signal">,
): Promise<BrowserMissionEvidence> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const task = Promise.resolve().then(() =>
    handler({ ...context, signal: controller.signal }),
  );
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "timeout" }),
      context.mission.timeoutMs,
    );
  });

  try {
    const winner = await Promise.race([
      task.then((value) => ({ kind: "value" as const, value })),
      timeout,
    ]);
    if (winner.kind === "value") return winner.value;

    const timeoutError = new BrowserSwarmExecutionError(
      "Browser mission " +
        context.mission.id +
        " exceeded its " +
        context.mission.timeoutMs +
        "ms timeout and was aborted",
    );
    controller.abort(timeoutError);

    // Do not dispatch the next adversarial mission while the timed-out handler
    // can still mutate the shared preview. A handler is required to observe the
    // AbortSignal and quiesce; if it does not, the worker intentionally remains
    // blocked until the outer job timeout kills the process.
    await task.catch(() => undefined);
    throw timeoutError;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateEvidenceBinding(
  worker: BrowserSwarmWorkerPlan,
  mission: BrowserAttackMission,
  evidence: BrowserMissionEvidence,
): void {
  if (evidence.workerId !== worker.workerId) {
    throw new BrowserSwarmExecutionError(
      "Browser mission " +
        mission.id +
        " returned evidence for worker " +
        evidence.workerId +
        " instead of " +
        worker.workerId,
    );
  }

  if (
    evidence.artifacts.some(
      (artifact) => !artifactBelongsToWorker(worker, artifact),
    )
  ) {
    throw new BrowserSwarmExecutionError(
      "Browser mission " +
        mission.id +
        " returned evidence outside its assigned artifact root",
    );
  }

  const started = Date.parse(evidence.startedAt);
  const completed = Date.parse(evidence.completedAt);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    completed < started
  ) {
    throw new BrowserSwarmExecutionError(
      "Browser mission " + mission.id + " returned invalid evidence timestamps",
    );
  }
}

export async function executeBrowserSwarmWorker({
  manifest,
  workerId,
  verifyPreviewTarget,
  handlers,
  now = () => new Date(),
}: {
  manifest: BrowserSwarmRunManifest;
  workerId: string;
  verifyPreviewTarget: BrowserPreviewVerifier;
  handlers: BrowserAttackHandlerRegistry;
  now?: () => Date;
}): Promise<BrowserSwarmWorkerExecution> {
  const worker = findWorker(manifest, workerId);

  let previewVerification: BrowserPreviewVerification;
  try {
    previewVerification = await verifyPreviewTarget(manifest);
  } catch (error) {
    throw new BrowserSwarmExecutionError(
      "Browser swarm preview verification failed before worker execution: " +
        sanitizeHarnessError(error),
    );
  }

  if (!previewVerification.verified) {
    throw new BrowserSwarmExecutionError(
      "Browser swarm preview verification refused execution: " +
        previewVerification.summary,
    );
  }

  const results: BrowserMissionExecutionResult[] = [];

  for (const mission of worker.missions) {
    const startedAt = isoNow(now);
    const handler = handlers[mission.family];

    if (!handler) {
      const evidence = harnessEvidence(
        mission,
        worker.workerId,
        startedAt,
        isoNow(now),
        new BrowserSwarmExecutionError(
          "No browser attack handler is registered for " + mission.family,
        ),
      );
      results.push({
        missionId: mission.id,
        outcome: "HARNESS_ERROR",
        evidence,
      });
      continue;
    }

    try {
      const evidence = await runHandlerWithCancellation(handler, {
        manifest,
        worker,
        mission,
      });
      validateEvidenceBinding(worker, mission, evidence);
      const outcome = classifyBrowserMissionEvidence(mission, evidence);
      results.push({ missionId: mission.id, outcome, evidence });
    } catch (error) {
      const evidence = harnessEvidence(
        mission,
        worker.workerId,
        startedAt,
        isoNow(now),
        error,
      );
      results.push({
        missionId: mission.id,
        outcome: "HARNESS_ERROR",
        evidence,
      });
    }
  }

  const confirmedBreachCount = results.filter(
    (result) => result.outcome === "CONFIRMED_BREACH",
  ).length;
  const harnessErrorCount = results.filter(
    (result) => result.outcome === "HARNESS_ERROR",
  ).length;

  return {
    workerId: worker.workerId,
    previewVerification,
    results,
    passed: confirmedBreachCount === 0 && harnessErrorCount === 0,
    confirmedBreachCount,
    harnessErrorCount,
  };
}
