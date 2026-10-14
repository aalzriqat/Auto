/**
 * SCRUM-350 — executable NETWORK_RECOVERY browser attack.
 *
 * The real web client saves a synthetic expense while the network goes down
 * with the request in flight: the request is lost BEFORE the server (the
 * complement of the DUPLICATE_SUBMIT lost response, where the server committed
 * and only the reply was lost), the connection is dropped, and every reconnect
 * is refused for a while. When the network returns the client must recover on
 * its own. Judged on backend authority, never on what the page says:
 *
 *   IDEMPOTENCY_SINGLE_EFFECT  the intent has exactly one expense and exactly
 *                              one economic posting, under one command
 *                              identity, and no attempt was refused.
 *   STATE_TRANSITION           a dialog that closed as "saved" is backed by a
 *                              backend record, and a control intent saved
 *                              AFTER recovery is also a single effect — the
 *                              page really is usable again.
 *
 * Both oracles are judged by the same run, so a mission for either is
 * answered by the same evidence. Anything that was not positively observed —
 * the outage not firing, no reconnect, an intent never confirmed — is
 * unjudged and fails the mission; it is never a pass.
 *
 * Not covered: an outage during an EDIT, and a browser that goes fully offline
 * (navigator.onLine); the injected fault is a dropped sync socket.
 */
import type { BrowserMissionEvidence } from "./browserAttackSwarm";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  ConvexSyncObserver,
  CREATE_EXPENSE_UDF,
  SETTLE_INTERVAL_MS,
  UI_STEP_TIMEOUT_MS,
  exitPhase,
  fillNewExpense,
  gotoExpenses,
  openFreshDialog,
  settleIntent,
  untilAborted,
  type IntentReport,
  type MissionBrowserRuntime,
  type PhaseExit,
} from "./browserSwarmEconomicAttacks";

export interface NetworkRecoveryTimeouts {
  uiStepMs: number;
  /** How long the network stays down after the request is lost. */
  outageMs: number;
  /** How long the client may take, after the outage ends, to complete the save. */
  recoveryMs: number;
  /** Interval between authority reads while waiting for settled state. */
  settleMs: number;
}

const DEFAULT_TIMEOUTS: NetworkRecoveryTimeouts = {
  uiStepMs: UI_STEP_TIMEOUT_MS,
  outageMs: 8_000,
  recoveryMs: 60_000,
  settleMs: SETTLE_INTERVAL_MS,
};

const OUTAGE_AMOUNT = 59;
const CONTROL_AMOUNT = 61;

/** The dialog closing is the client's claim that the save happened. */
function dialogClaimedSaved(exit: PhaseExit): boolean {
  return exit.kind === "CONFIRMED" || exit.kind === "CLOSED_UNCONFIRMED";
}

function networkRecoverySpec(timeouts: NetworkRecoveryTimeouts) {
  return {
    attack: "NETWORK_RECOVERY",
    seat: "primary" as const,
    oracles: ["IDEMPOTENCY_SINGLE_EFFECT" as const, "STATE_TRANSITION" as const],
    passSummary:
      "A save whose request was lost before the server, followed by a network outage and recovery, produced exactly one expense and one economic posting under one command identity, the dialog's claim of success matched the backend, and a control save after recovery also produced exactly one effect.",
    breachSummary: "Network recovery broke single effect or state consistency",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { page, orgId, client, nonce, signal, detail } = env;
      const observer = new ConvexSyncObserver(CREATE_EXPENSE_UDF);
      await observer.attach(page, "tab-1");
      await untilAborted(signal, gotoExpenses(page, orgId, timeouts.uiStepMs));

      const outage = { title: `${nonce}-outage`, amount: OUTAGE_AMOUNT };
      const control = { title: `${nonce}-control`, amount: CONTROL_AMOUNT };
      const exits = new Map<string, PhaseExit | null>();
      /** Intents whose dialog closed although no reply ever answered the save. */
      const closedUnanswered = new Set<string>();
      let uiBlocked: string | null = null;

      const runPhase = async (
        phase: string,
        intent: { title: string; amount: number },
        waitMs: number,
        arm: () => void,
      ): Promise<void> => {
        exits.set(intent.title, null);
        if (uiBlocked !== null) {
          env.unjudged(`${phase} was not run: ${uiBlocked}`);
          return;
        }
        const opening = await untilAborted(signal, openFreshDialog(page, phase, timeouts.uiStepMs, signal));
        if (opening.kind === "REFUSED") {
          uiBlocked = opening.reason;
          env.unjudged(opening.reason);
          return;
        }
        await untilAborted(signal, fillNewExpense(opening.dialog, intent));
        arm();
        await untilAborted(
          signal,
          opening.dialog.getByRole("button", { name: "Record Expense", exact: true }).click({ timeout: timeouts.uiStepMs }),
        );
        const exit = await exitPhase(observer, opening.dialog, intent.title, waitMs, timeouts.uiStepMs, signal);
        exits.set(intent.title, exit);
        if (exit.kind === "BLOCKED") {
          uiBlocked = exit.reason;
          env.unjudged(exit.reason);
          // The client closed the dialog as saved without ever hearing back.
          if (!(await untilAborted(signal, opening.dialog.isVisible()))) closedUnanswered.add(intent.title);
        }
      };

      // Phase A — the request is lost before the server; the network is down
      // for `outageMs`, then back. The fault is disarmed when the phase ends,
      // fired or not.
      try {
        await runPhase("Phase A (outage with the request in flight)", outage, timeouts.outageMs + timeouts.recoveryMs, () =>
          observer.armOutage(outage.title, timeouts.outageMs),
        );
      } finally {
        observer.disarmOutage();
      }
      // Phase B — the control: after recovery the page saves normally.
      await runPhase("Phase B (control save after recovery)", control, timeouts.recoveryMs, () => undefined);

      const droppedCount = observer.droppedFor(outage.title).length;
      const reconnected = observer.reconnectedAfterOutage(outage.title);
      detail.outage = {
        dropped: droppedCount,
        reconnected,
        attempts: observer.mutationsFor(outage.title).length,
        controlAttempts: observer.mutationsFor(control.title).length,
        exits: Object.fromEntries([...exits].map(([title, exit]) => [title, exit?.kind ?? "NOT_RUN"])),
      };
      if (exits.get(outage.title) !== null) {
        if (droppedCount === 0) {
          env.unjudged("the outage never fired: no save of the intent was observed leaving the page, so recovery was not exercised");
        } else if (!reconnected) {
          env.unjudged("the page was never heard from on a newer connection after the outage, so it had no observed chance to recover");
        }
      }

      for (const intent of [outage, control]) {
        const exit = exits.get(intent.title);
        if (exit === null || exit === undefined) continue;
        const uiClaimedSaved = dialogClaimedSaved(exit) || closedUnanswered.has(intent.title);
        let report: IntentReport;
        try {
          report = await untilAborted(
            signal,
            settleIntent(client, orgId, observer, { ...intent, uiConfirmed: uiClaimedSaved }, timeouts.settleMs),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          env.unjudged(`intent "${intent.title}" could not be settled: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        detail[intent.title === outage.title ? "outageIntent" : "controlIntent"] = {
          uiClaimedSaved,
          transmittedAttempts: report.transmittedAttempts,
          identities: report.identities,
          expenses: report.snapshot.expenses.filter((row) => row.title === intent.title).length,
          replies: report.replies,
        };
        env.judge({
          violations: report.proven,
          unjudged: report.inconclusive === null ? [] : [report.inconclusive],
        });
      }
    },
  };
}

export function createNetworkRecoveryHandler(
  runtimeApi: MissionBrowserRuntime,
  overrides: Partial<NetworkRecoveryTimeouts> = {},
): (context: BrowserMissionExecutionContext) => Promise<BrowserMissionEvidence> {
  const timeouts: NetworkRecoveryTimeouts = { ...DEFAULT_TIMEOUTS, ...overrides };
  return (context) => runBoundaryMission(runtimeApi, context, networkRecoverySpec(timeouts));
}
