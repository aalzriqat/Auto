/**
 * SCRUM-350 LIFE-1 — executable NAVIGATION_RACE browser attack on an economic lifecycle.
 *
 * The owner seat posts a run-unique synthetic expense (a real ledger posting),
 * visits the dashboard and then the expenses screen so browser history has
 * somewhere to go back to, and drives the screen's Delete flow until the
 * posted expense flips the dialog into "Reverse & Delete" with its reason
 * typed. It clicks that action and, without waiting for the dialog, goes
 * history-back and then history-forward. Whether the request reached the
 * backend first is left to the race; both outcomes are legitimate.
 *
 * The verdict is the LEDGER, read through the permission-checked accounting
 * queries and judged by browserSwarmNavigationRaceOracle.ts: unchanged, or
 * exactly one linked mirror reversal, never a half-applied or duplicate one.
 * The reloaded screen is read beside it (a reversed expense is not listed).
 * When the reversal was not applied, it is repeated from the returned screen
 * and must end with exactly one reversal.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the
 * fail-closed rule) is the shared runBoundaryMission.
 *
 * Not covered, and stated so a green run is not read as more than it proved:
 * only the posted-expense reversal on one screen by the OWNER seat, with one
 * back/forward pair — no reload during the request, no tab close, no offline
 * switch, no other lifecycle (deal, sale, receipt, refund, manual journal), no
 * closed period and no cross-tenant behavior. Which outcome the race produced
 * is not controlled (it is recorded in the evidence); a run that always lost
 * the race would only ever exercise the repeat. The ledger is read after a
 * fixed wait and two identical reads, so a posting that lands later than that
 * would be missed. Posted history is never deleted: a mission aborted before
 * its reversal leaves a posted expense in the disposable preview.
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
  reverseOnExpenseScreen,
} from "./browserSwarmBoundaryAttacks";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import { describeError, type LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import { UI_STEP_TIMEOUT_MS, gotoExpenses, untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { evaluateNavigationRace, raceOutcome } from "./browserSwarmNavigationRaceOracle";

export interface NavigationRaceAttackOptions {
  /** Replaces real waiting so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval while waiting on the screen or on the ledger. */
  pollMs?: number;
  /** How long a posting may take to reach the ledger. */
  postingWaitMs?: number;
  /**
   * Extra wait, shared by every ledger read in the mission, for a posting verifiably queued in the outbox
   * (which ticks once a minute). Spent once across the mission, not once per read.
   */
  queuedPostingExtraMs?: number;
  /** How long an in-flight request is given to land before the ledger is read. */
  raceSettleMs?: number;
  /** How long the reloaded screen may take to agree with the ledger. */
  uiSettleMs?: number;
}

const DEFAULTS = {
  pollMs: 500,
  postingWaitMs: 20_000,
  queuedPostingExtraMs: 60_000,
  raceSettleMs: 3_000,
  uiSettleMs: 15_000,
} as const;

/**
 * The most time the mission's five ledger reads can spend waiting on the ledger: each read's own wait, plus
 * the one shared extension. `browserMissionTimeoutMs("NAVIGATION_RACE")` must leave room for this and the
 * screen steps (SCRUM-851).
 */
export const NAVIGATION_RACE_LEDGER_WAIT_BOUND_MS =
  5 * DEFAULTS.postingWaitMs + DEFAULTS.queuedPostingExtraMs;
const UI_STEP = { timeout: UI_STEP_TIMEOUT_MS };
const NAVIGATION = { waitUntil: "domcontentloaded" as const, timeout: UI_STEP_TIMEOUT_MS };
const SEEDED_AMOUNT = 59;
const SENTINEL_AMOUNT = 61;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const onExpensesScreen = (env: BoundaryMissionEnv): boolean => /\/expenses\/?(?:[?#].*)?$/.test(env.page.url());

/**
 * Reads whether the reloaded screen lists the expense. Absence only counts once the sentinel row (a different,
 * posted, untouched expense) is visible, i.e. once the list has loaded; otherwise the listing is unread (null).
 * A listed expense needs no sentinel. The wait is bounded by `uiSettleMs`.
 *
 * Load-order assumption: the target is created BEFORE the sentinel (and before any product expense made later),
 * and the product's `expenses.list` is one paginated `by_org` query read in ascending (creation) order. So a
 * visible sentinel implies the page holding the target has loaded; a sentinel pushed to a later page (a large
 * organization) only makes the listing unread. If the list's order or paging changes, this reading is invalid
 * and the handler and its tests must change with it.
 */
async function readRowListing(
  env: BoundaryMissionEnv,
  options: Required<NavigationRaceAttackOptions>,
  expenseId: string,
  sentinelId: string,
  expectedListed: boolean,
): Promise<"LISTED" | "NOT_LISTED" | null> {
  const row = env.page.locator(`#row-${expenseId}`);
  const sentinel = env.page.locator(`#row-${sentinelId}`);
  const deadline = Date.now() + options.uiSettleMs;
  let listed = await untilAborted(env.signal, row.isVisible());
  let loaded = await untilAborted(env.signal, sentinel.isVisible());
  while (!(loaded && listed === expectedListed) && Date.now() < deadline) {
    await untilAborted(env.signal, options.sleep(options.pollMs));
    listed = await untilAborted(env.signal, row.isVisible());
    loaded = await untilAborted(env.signal, sentinel.isVisible());
  }
  env.detail.sentinelVisible = loaded;
  if (listed) return "LISTED";
  return loaded ? "NOT_LISTED" : null;
}

function navigationRaceSpec(options: Required<NavigationRaceAttackOptions>) {
  return {
    attack: "NAVIGATION_RACE",
    seat: "primary" as const,
    oracles: ["STATE_TRANSITION" as const],
    passSummary:
      "A posted expense's Reverse & Delete was clicked and followed by history back and forward, and the result was read back: the ledger was either unchanged or held exactly one linked mirror reversal with the original posting untouched, a reversal that had not applied was repeated from the returned screen to exactly one, a second posted sentinel expense was untouched, and the reloaded expenses screen (its list loaded, shown by the sentinel row) listed the expense only while the ledger showed it unreversed. Whether the request was still in flight during the navigation is recorded (dialogOpenAtBack), not established.",
    breachSummary: "A navigation race left the lifecycle transition inconsistent with backend authority",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const extraWait = { remainingMs: options.queuedPostingExtraMs };

      // History needs an entry before the expenses screen to go back to.
      await untilAborted(signal, page.goto(`/${orgId}/dashboard`, NAVIGATION));
      await untilAborted(signal, gotoExpenses(page, orgId));

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
      const posted = await readSettledLedger(env, options, expenseId, { until: isPosted, extraWait });

      // The sentinel: a second posted expense the race must not touch. Its row on the reloaded screen proves
      // the list has loaded, so the target's absence is evidence; its ledger is the bystander posting.
      const sentinelId = String(
        await untilAborted(
          signal,
          client.mutation(api.expenses.create, {
            orgId: org,
            title: `${nonce}-sentinel`,
            amount: SENTINEL_AMOUNT,
            date: Date.now(),
            category: "OTHER",
            status: "PAID",
            paymentMethod: "CASH",
            idempotencyKey: `${nonce}-sentinel`,
          }),
        ),
      );
      detail.sentinelId = sentinelId;
      const sentinelPosted = await readSettledLedger(env, options, sentinelId, { until: isPosted, extraWait });

      try {
        await armReversalOnExpenseScreen(page, signal, expenseId, `${nonce} interrupted reversal`);
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(`the expenses screen could not be driven to an armed Reverse & Delete (${describeError(error)})`);
        return;
      }

      // The race: submit, then leave and come back without waiting for the dialog.
      let clickIssued = false;
      let leftScreen = false;
      let returned = false;
      try {
        await untilAborted(
          signal,
          page.getByRole("dialog").getByRole("button", { name: "Reverse & Delete", exact: true }).click(UI_STEP),
        );
        clickIssued = true;
        // Recorded, not required: a fast backend may already have closed the dialog, and this read is itself racy.
        detail.dialogOpenAtBack = await untilAborted(signal, page.getByRole("dialog").isVisible());
        await untilAborted(signal, page.goBack(NAVIGATION));
        leftScreen = !onExpensesScreen(env);
        await untilAborted(signal, page.goForward(NAVIGATION));
        await untilAborted(
          signal,
          page.getByRole("button", { name: "Record Expense", exact: true }).waitFor({ state: "visible", ...UI_STEP }),
        );
        returned = onExpensesScreen(env);
      } catch (error) {
        if (signal.aborted) throw error;
        detail.raceError = describeError(error);
      }
      detail.race = { clickIssued, leftScreen, returned };
      /** The sentinel's ledger after everything else; a failed read is null (unjudged), never a thrown mission. */
      const readSentinelAfter = async (): Promise<LedgerSnapshot | null> => {
        try {
          return await readSettledLedger(env, options, sentinelId, { extraWait });
        } catch (error) {
          if (signal.aborted) throw error;
          detail.sentinelAfterError = describeError(error);
          return null;
        }
      };
      /**
       * Evidence records only what was read (null = not read). The oracle takes placeholders for the unread
       * snapshots: it returns before using them when the sequence did not happen, and judges the known
       * afterRace (with the repeat marked not performed) when only the final read is missing.
       */
      const judge = (
        afterRace: LedgerSnapshot | null,
        final: LedgerSnapshot | null,
        screenRow: "LISTED" | "NOT_LISTED" | null,
        repeatPerformed: boolean,
        sentinelAfter: LedgerSnapshot | null,
      ): void => {
        detail.screenRow = screenRow;
        detail.ledger = { posted, afterRace, final, repeatPerformed, sentinelPosted, sentinelAfter };
        env.judge(
          evaluateNavigationRace({
            clickIssued,
            leftScreen,
            returned,
            posted,
            afterRace: afterRace ?? posted,
            final: final ?? afterRace ?? posted,
            screenRow,
            repeatPerformed,
            sentinelPosted,
            sentinelAfter,
            seededAmount: SEEDED_AMOUNT,
            expectedCurrency,
          }),
        );
      };
      if (!clickIssued || !leftScreen || !returned) {
        // The sequence did not happen, so there is nothing to read back or repeat and no after-read was made:
        // the evidence records every after-read as unavailable (null) and the oracle reports the premise that failed.
        judge(null, null, null, false, null);
        return;
      }

      await untilAborted(signal, options.sleep(options.raceSettleMs));
      const afterRace = await readSettledLedger(env, options, expenseId, { extraWait });
      const outcome = raceOutcome(afterRace);
      detail.raceOutcome = outcome;

      // A fresh load, so the listing is the server's and not a cached client view.
      let screenRow: "LISTED" | "NOT_LISTED" | null = null;
      try {
        await untilAborted(signal, page.reload(NAVIGATION));
        await untilAborted(
          signal,
          page.getByRole("button", { name: "Record Expense", exact: true }).waitFor({ state: "visible", ...UI_STEP }),
        );
        screenRow = await readRowListing(env, options, expenseId, sentinelId, outcome === "NOT_APPLIED");
      } catch (error) {
        if (signal.aborted) throw error;
        detail.reloadError = describeError(error);
      }

      let final = afterRace;
      if (outcome === "NOT_APPLIED") {
        try {
          await reverseOnExpenseScreen(page, signal, expenseId, `${nonce} repeated reversal`);
        } catch (error) {
          if (signal.aborted) throw error;
          // What the ledger and the screen already show is still judged; only convergence stays unproven.
          detail.repeatError = describeError(error);
          judge(afterRace, null, screenRow, false, await readSentinelAfter());
          return;
        }
        final = await readSettledLedger(env, options, expenseId, { until: isReversed, extraWait });
      }

      judge(afterRace, final, screenRow, outcome === "NOT_APPLIED", await readSentinelAfter());
    },
  };
}

export function createNavigationRaceAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: NavigationRaceAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: Required<NavigationRaceAttackOptions> = {
    sleep: overrides.sleep ?? realSleep,
    pollMs: overrides.pollMs ?? DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? DEFAULTS.postingWaitMs,
    queuedPostingExtraMs: overrides.queuedPostingExtraMs ?? DEFAULTS.queuedPostingExtraMs,
    raceSettleMs: overrides.raceSettleMs ?? DEFAULTS.raceSettleMs,
    uiSettleMs: overrides.uiSettleMs ?? DEFAULTS.uiSettleMs,
  };
  return {
    NAVIGATION_RACE: (context) => runBoundaryMission(runtimeApi, context, navigationRaceSpec(options)),
  };
}
