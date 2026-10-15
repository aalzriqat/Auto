/**
 * SCRUM-350 LIFE-1 — executable STALE_UI browser attack on an economic lifecycle.
 *
 * The owner seat posts a run-unique synthetic expense (a real ledger posting),
 * then drives the expenses screen through its own Delete flow until the posted
 * expense flips the dialog into "Reverse & Delete" and types the reason, so the
 * reversal action is armed on the page. While that dialog is open the backend
 * reverses the same expense through the public command (the stand-in for
 * another tab or user: a server-authoritative lifecycle transition the open
 * screen holds no news of). The screen's late "Reverse & Delete" is then used.
 *
 * The verdict is the ledger, read through the permission-checked accounting
 * queries and judged by browserSwarmStaleUiOracle.ts: the original posting
 * untouched, exactly one linked mirror reversal, and no event added by the
 * stale request. The screen's announcement is judged beside it; a toast alone
 * never decides a pass.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the
 * fail-closed rule) is the shared runBoundaryMission.
 *
 * Not covered, and stated so a green run is not read as more than it proved:
 * only the posted-expense reversal on one screen by the OWNER seat — no deal,
 * sale, receipt, refund or manual-journal lifecycle, no stale role/permission
 * change, no closed accounting period, and no cross-tenant behavior (the
 * expense, the reversal and every read are inside the one disposable
 * organization); the server-side reversal is made by the
 * same session through the backend, not by a second signed-in browser; the
 * ledger is read after it settles (two identical reads), so a posting that
 * lands later than that would be missed. Posted history is never deleted: the
 * expense and its reversal stay in the disposable preview, and a mission
 * aborted before its server-side reversal leaves a posted expense behind.
 */
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import {
  armReversalOnExpenseScreen,
  isPosted,
  isRecord,
  isReversed,
  readSettledLedger,
} from "./browserSwarmBoundaryAttacks";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import { REPLAY_REFUSAL, describeError, probe } from "./browserSwarmBoundaryOracle";
import { UI_STEP_TIMEOUT_MS, gotoExpenses, untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { evaluateStaleReversal, type StaleScreenAnswer } from "./browserSwarmStaleUiOracle";

export interface StaleUiAttackOptions {
  /** Replaces real waiting so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval while waiting on the screen or on the ledger. */
  pollMs?: number;
  /** How long a posting may take to reach the ledger. */
  postingWaitMs?: number;
  /** How long the screen may take to answer before its silence is reported as unjudged. */
  uiSettleMs?: number;
}

const DEFAULTS = { pollMs: 500, postingWaitMs: 20_000, uiSettleMs: 15_000 } as const;
const UI_STEP = { timeout: UI_STEP_TIMEOUT_MS };
/** A probe's refusal pattern that matches nothing: any failure of the call stays unclassified. */
const NO_REFUSAL = /(?!)/;
const SEEDED_AMOUNT = 53;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The reversal action's own button: visible and enabled, not merely "a dialog is open". */
async function reversalActionOffered(env: BoundaryMissionEnv): Promise<boolean> {
  const action = env.page.getByRole("dialog").getByRole("button", { name: "Reverse & Delete", exact: true });
  return (await untilAborted(env.signal, action.isVisible())) && (await untilAborted(env.signal, action.isEnabled()));
}

/**
 * What the screen announced after the late click; the toast is read by kind, then
 * by the product's own words (the anchored refusal `reverseExpense` raises for a
 * reversed expense). The wait is bounded by `uiSettleMs`.
 */
async function readScreenAnswer(env: BoundaryMissionEnv, options: Required<StaleUiAttackOptions>): Promise<StaleScreenAnswer> {
  const { page, signal } = env;
  const success = page.locator("[data-sonner-toast][data-type='success']").first();
  const other = page.locator("[data-sonner-toast]:not([data-type='success'])").first();
  const deadline = Date.now() + options.uiSettleMs;
  let answer: StaleScreenAnswer | null = null;
  while (answer === null) {
    if (await untilAborted(signal, success.isVisible())) {
      answer = "SUCCESS_TOAST";
    } else if (await untilAborted(signal, other.isVisible())) {
      const text = await untilAborted(signal, other.innerText(UI_STEP));
      answer = REPLAY_REFUSAL.test(text.trim()) ? "REFUSAL_TOAST" : "UNCLASSIFIED_TOAST";
    } else if (Date.now() >= deadline) {
      answer = "SILENT";
    } else {
      await untilAborted(signal, options.sleep(options.pollMs));
    }
  }
  return answer;
}

function staleUiSpec(options: Required<StaleUiAttackOptions>) {
  return {
    attack: "STALE_UI",
    seat: "primary" as const,
    oracles: ["UI_BACKEND_AUTHORITY" as const],
    passSummary:
      "After the backend reversed a posted expense, the expenses screen's still-open Reverse & Delete was used: the ledger kept the original posting, held exactly one linked mirror reversal in the organization's currency and gained no event from the stale request, and the screen announced the product's 'Expense not found' refusal.",
    breachSummary: "A stale screen's lifecycle action disagreed with backend authority",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;

      await untilAborted(signal, gotoExpenses(page, orgId));

      // The posting's denomination is the organization's own, never read from the journal being judged.
      const settings: unknown = await untilAborted(signal, client.query(api.orgSettings.get, { orgId: org }));
      const expectedCurrency = isRecord(settings) && typeof settings.currency === "string" ? settings.currency : null;
      detail.expectedCurrency = expectedCurrency;

      const expenseId = String(
        await untilAborted(
          signal,
          client.mutation(api.expenses.create, {
            orgId: org,
            title: `${nonce}-posted`,
            amount: SEEDED_AMOUNT,
            date: Date.now(),
            category: "OTHER",
            status: "PAID",
            paymentMethod: "CASH",
            idempotencyKey: `${nonce}-create`,
          }),
        ),
      );
      detail.expenseId = expenseId;
      const posted = await readSettledLedger(env, options, expenseId, { until: isPosted });

      // The stale action: armed on the page, before the lifecycle moves.
      try {
        await armReversalOnExpenseScreen(page, signal, expenseId, `${nonce} stale reversal`);
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(`the expenses screen could not be driven to an armed Reverse & Delete (${describeError(error)})`);
        return;
      }
      const actionArmedBeforeChange = await reversalActionOffered(env);

      // The server-authoritative lifecycle transition, made while the dialog is open.
      const transition = await probe(
        () =>
          untilAborted(
            signal,
            client.mutation(api.expenses.reverseExpense, {
              orgId: org,
              expenseId: expenseId as Id<"expenses">,
              reason: `${nonce} server-side reversal`,
            }),
          ),
        NO_REFUSAL,
        signal,
      );
      if (transition.kind !== "ACCEPTED") {
        env.unjudged(
          `the server-side reversal did not go through (${transition.kind}${"message" in transition ? `: ${transition.message}` : ""})`,
        );
        return;
      }
      const reversed = await readSettledLedger(env, options, expenseId, { until: isReversed });

      const offered = await reversalActionOffered(env);
      let screenAnswer: StaleScreenAnswer | null = null;
      if (offered) {
        try {
          await untilAborted(
            signal,
            page.getByRole("dialog").getByRole("button", { name: "Reverse & Delete", exact: true }).click(UI_STEP),
          );
          screenAnswer = await readScreenAnswer(env, options);
        } catch (error) {
          if (signal.aborted) throw error;
          detail.lateClickError = describeError(error);
          screenAnswer = "SILENT";
        }
      }
      const afterStale = await readSettledLedger(env, options, expenseId);

      const observed = { actionArmedBeforeChange, actionAfterChange: offered ? "OFFERED" : "WITHDRAWN", screenAnswer } as const;
      detail.ledger = { posted, reversed, afterStale };
      detail.observed = observed;
      env.judge(
        evaluateStaleReversal({
          ...observed,
          posted,
          reversed,
          afterStale,
          seededAmount: SEEDED_AMOUNT,
          expectedCurrency,
        }),
      );
    },
  };
}

export function createStaleUiAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: StaleUiAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: Required<StaleUiAttackOptions> = {
    sleep: overrides.sleep ?? realSleep,
    pollMs: overrides.pollMs ?? DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? DEFAULTS.postingWaitMs,
    uiSettleMs: overrides.uiSettleMs ?? DEFAULTS.uiSettleMs,
  };
  return {
    STALE_UI: (context) => runBoundaryMission(runtimeApi, context, staleUiSpec(options)),
  };
}
