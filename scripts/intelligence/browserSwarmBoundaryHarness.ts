/**
 * SCRUM-350 — the one mission lifecycle shared by the boundary attacks.
 *
 * A boundary attack supplies a `run` that exercises the product and folds what
 * it observed into a verdict ledger. This module owns everything around it so
 * no attack can get the contract wrong: the egress-contained browser (never a
 * launch of its own), the evidence contract, cleanup, and the fail-closed rule
 * that nothing is a pass unless every observation was judged.
 *
 *   BREACH        any proof: oracle.passed = false, evidence written first.
 *   INCONCLUSIVE  no proof but something unjudged: thrown, the executor
 *                 records HARNESS_ERROR and the run fails. Never a pass.
 *   PASS          every observation judged clean AND the browser evidence was
 *                 captured AND the backend evidence was written, in that order,
 *                 so no pass-shaped artifact exists unless all three held.
 */
import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import type { BrowserMissionEvidence, BrowserOracleKind } from "./browserAttackSwarm";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import type { Judgement } from "./browserSwarmBoundaryOracle";
import {
  attackNonce,
  errorText,
  untilAborted,
  type MissionBrowser,
  type MissionBrowserRuntime,
  type MissionSeat,
} from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError, VerdictLedger } from "./browserSwarmEconomicOracle";

export interface SeatSession {
  seat: MissionSeat;
  page: Page;
  orgId: string;
  client: ConvexHttpClient;
}

export interface BoundaryMissionEnv extends SeatSession {
  readonly context: BrowserMissionExecutionContext;
  readonly signal: AbortSignal;
  /** A run-unique synthetic stem; every planted record carries it. */
  readonly nonce: string;
  /** Backend-state evidence. Synthetic identifiers only, never a credential. */
  readonly detail: Record<string, unknown>;
  /** Folds a judgement into the verdict ledger. */
  judge(verdict: Judgement): void;
  /** Records that something could not be judged: the mission cannot pass. */
  unjudged(reason: string): void;
  /** Opens another authenticated seat in its own egress-contained browser. */
  openSeat(seat: MissionSeat): Promise<SeatSession>;
  /** Best-effort undo, run in reverse order before evidence is written. */
  onCleanup(label: string, run: () => Promise<void>): void;
}

export interface BoundaryMissionSpec {
  /** Evidence label, e.g. "TENANT_ESCAPE". */
  attack: string;
  /** The seat the mission's own browser is opened as. */
  seat: MissionSeat;
  /** The oracles this attack judges; a mission asking for another is refused. */
  oracles: readonly BrowserOracleKind[];
  passSummary: string;
  breachSummary: string;
  run(env: BoundaryMissionEnv): Promise<void>;
}

export async function runBoundaryMission(
  runtimeApi: MissionBrowserRuntime,
  context: BrowserMissionExecutionContext,
  spec: BoundaryMissionSpec,
): Promise<BrowserMissionEvidence> {
  const { signal, mission } = context;
  if (!spec.oracles.includes(mission.oracle)) {
    // The coverage gate refuses this before provisioning; this is the
    // worker's own refusal for a manifest that bypassed it.
    throw new Error(`${spec.attack} does not judge the ${mission.oracle} oracle`);
  }

  const startedAt = new Date().toISOString();
  const nonce = attackNonce(context);
  const primary = await runtimeApi.open(context, spec.seat);
  const opened: MissionBrowser[] = [primary];
  const ledger = new VerdictLedger();
  const detail: Record<string, unknown> = {};
  const cleanups: { label: string; run: () => Promise<void> }[] = [];
  const cleanupReport: Record<string, string> = {};
  let resolvedOrgId: string | null = null;
  let cleanupsRan = false;
  let cleanupStarted = false;
  let concluding = false;
  /** Observations the attack recorded; a run that recorded none has judged nothing. */
  let observations = 0;

  /** Undoes what the attack planted, newest first. Never touches an aborted preview (D5). */
  const runCleanups = async (): Promise<void> => {
    if (cleanupsRan) return;
    cleanupsRan = true;
    for (const { label, run } of [...cleanups].reverse()) {
      if (signal.aborted) {
        cleanupReport[label] = "skipped: the mission was aborted";
        continue;
      }
      try {
        await run();
        cleanupReport[label] = "done";
      } catch (error) {
        cleanupReport[label] = `failed: ${errorText(error)}`;
      }
    }
  };

  /**
   * Captures browser evidence for every opened seat; reports a failure instead
   * of hiding it. Runs once: later calls return the first result, so a pass that
   * finished its browsers early cannot finish them again on the failure path.
   */
  let finished: Promise<{ artifacts: string[]; failure: string | null }> | null = null;
  const finishAll = (): Promise<{ artifacts: string[]; failure: string | null }> => {
    finished ??= (async () => {
      const artifacts: string[] = [];
      const failures: string[] = [];
      for (const runtime of opened) {
        try {
          artifacts.push(...(await runtimeApi.finish(runtime)));
        } catch (error) {
          failures.push(errorText(error));
        }
      }
      return { artifacts, failure: failures.length > 0 ? failures.join("; ") : null };
    })();
    return finished;
  };

  const evidenceBody = (extra: Record<string, unknown>): Record<string, unknown> => ({
    attack: spec.attack,
    oracle: mission.oracle,
    orgId: resolvedOrgId,
    nonce,
    ...detail,
    cleanup: cleanupReport,
    unjudged: ledger.unjudged,
    ...extra,
  });

  const conclude = async (
    violations: readonly string[],
    extra: Record<string, unknown>,
  ): Promise<BrowserMissionEvidence> => {
    concluding = true;
    const passed = violations.length === 0;
    await runCleanups();
    if (passed) {
      // A pass needs complete browser evidence, so settle it BEFORE anything
      // pass-shaped is written: a failure here must leave no artifact to read as
      // a pass, whatever else fails afterwards. The thrown error reaches the
      // failure path, which labels the evidence HARNESS_ERROR. A breach is made
      // durable first, below.
      const early = await finishAll();
      if (early.failure !== null) throw new Error(`browser evidence cleanup failed: ${early.failure}`);
    }
    const body = evidenceBody({ ...extra, violations });
    let backendArtifact: string;
    try {
      backendArtifact = await runtimeApi.writeBackendEvidence(primary.paths, body);
    } catch (writeError) {
      // A pass is never certified without its evidence. A proven breach gets
      // one more attempt so a transient write fault cannot demote it.
      if (passed) throw writeError;
      backendArtifact = await runtimeApi.writeBackendEvidence(primary.paths, body);
    }
    cleanupStarted = true;
    const browser = await finishAll();
    // Screenshot or trace failures cannot retract a breach already on disk.
    return {
      missionId: mission.id,
      workerId: context.worker.workerId,
      startedAt,
      completedAt: new Date().toISOString(),
      oracle: {
        kind: mission.oracle,
        passed,
        summary: passed
          ? spec.passSummary
          : `${spec.breachSummary}: ${violations.join("; ")}${
              browser.failure === null ? "" : ` (browser evidence cleanup also failed: ${browser.failure})`
            }`,
      },
      artifacts: [...browser.artifacts, backendArtifact],
    };
  };

  const openSeat = async (seat: MissionSeat): Promise<SeatSession> => {
    signal.throwIfAborted();
    const runtime = await runtimeApi.open(context, seat);
    opened.push(runtime);
    const orgId = await untilAborted(signal, runtimeApi.resolveOrgRoute(runtime.page));
    if (!orgId) throw new Error(`${spec.attack} could not resolve the ${seat} seat's organization route.`);
    const client = await untilAborted(signal, runtimeApi.authenticatedClient(runtime.page));
    return { seat, page: runtime.page, orgId, client };
  };

  try {
    const orgId = await untilAborted(signal, runtimeApi.resolveOrgRoute(primary.page));
    if (!orgId) throw new Error(`${spec.attack} could not resolve the authenticated organization route.`);
    resolvedOrgId = orgId;
    const client = await untilAborted(signal, runtimeApi.authenticatedClient(primary.page));

    await untilAborted(
      signal,
      spec.run({
        seat: spec.seat,
        page: primary.page,
        orgId,
        client,
        context,
        signal,
        nonce,
        detail,
        judge: (verdict) => {
          observations += 1;
          ledger.prove(...verdict.violations);
          for (const reason of verdict.unjudged) ledger.unjudgeable(reason);
        },
        unjudged: (reason) => {
          observations += 1;
          ledger.unjudgeable(reason);
        },
        openSeat,
        onCleanup: (label, run) => {
          cleanups.push({ label, run });
        },
      }),
    );

    const decision = ledger.decide();
    if (decision.kind === "BREACH") {
      return await conclude(
        decision.violations,
        decision.unjudged.length > 0 ? { phase: "PARTIAL" } : {},
      );
    }
    if (decision.kind === "INCONCLUSIVE") {
      throw new BrowserSwarmOracleInconclusiveError(decision.reason);
    }
    if (observations === 0) {
      // An attack that judged nothing has proven nothing; silence is not a pass.
      throw new BrowserSwarmOracleInconclusiveError(`${spec.attack} recorded no observation to judge`);
    }
    return await conclude([], {});
  } catch (error) {
    let undelivered: string[] | null = null;
    const decision = ledger.decide();
    if (!cleanupStarted && !concluding && decision.kind === "BREACH" && !signal.aborted) {
      // A failure interrupted the attack after it had already proven a breach.
      // Proof is a product verdict and must survive the interruption.
      try {
        return await conclude(decision.violations, {
          phase: "INTERRUPTED",
          interruptedBy: errorText(error),
        });
      } catch (concludeError) {
        if (error instanceof Error && error.cause === undefined) error.cause = concludeError;
        if (!cleanupStarted) undelivered = decision.violations;
      }
    } else if (concluding && !cleanupStarted && decision.kind === "BREACH") {
      undelivered = decision.violations;
    }
    if (!cleanupStarted) {
      // Every run that fails to conclude still leaves evidence an operator can
      // read, labelled by what went wrong. Best effort: the original error
      // stays the result.
      cleanupStarted = true;
      await runCleanups();
      const browser = await finishAll();
      if (browser.failure !== null && error instanceof Error && error.cause === undefined) {
        error.cause = new Error(browser.failure);
      }
      try {
        await runtimeApi.writeBackendEvidence(
          primary.paths,
          evidenceBody({
            outcome:
              undelivered !== null
                ? "BREACH_UNDELIVERED"
                : error instanceof BrowserSwarmOracleInconclusiveError
                  ? "INCONCLUSIVE"
                  : "HARNESS_ERROR",
            ...(undelivered !== null ? { violations: undelivered } : {}),
            reason: errorText(error),
            browserCleanupFailure: browser.failure,
          }),
        );
      } catch {
        // The original error is reported regardless.
      }
    }
    return runtimeApi.rethrowAfterCleanup(primary, error, true);
  }
}
