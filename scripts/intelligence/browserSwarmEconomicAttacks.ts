/**
 * SCRUM-826 — executable DUPLICATE_SUBMIT and MULTI_TAB_RACE browser attacks.
 *
 * Both attacks drive the REAL web client against the isolated disposable
 * preview with synthetic, run-unique data, and judge only BACKEND authority:
 * operational rows, accounting events, the posting outbox and journal lines,
 * read through the same public, permission-checked queries an accountant uses.
 *
 * Outcomes:
 *   PASS             every oracle held on settled backend state
 *   CONFIRMED_BREACH an oracle reproduced a violation (oracle.passed = false)
 *   HARNESS_ERROR    the attack could not be exercised or judged (a thrown
 *                    error, including BrowserSwarmOracleInconclusiveError).
 *                    The executor fails the run on it; it is never a pass.
 */
import type { Browser, BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs } from "convex/server";
import { jsonToConvex, type JSONValue } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BrowserMissionEvidence } from "./browserAttackSwarm";
import type {
  BrowserMissionExecutionContext,
  BrowserMissionHandler,
} from "./browserAttackSwarmExecutor";
import {
  isConvexSyncSocketUrl,
  parseConvexMutationRequest,
  parseConvexMutationResponse,
} from "./browserSwarmConvexFrames";
import {
  BrowserSwarmOracleInconclusiveError,
  evaluateCommandIdentityLifetime,
  evaluateConcurrentEditRace,
  evaluateExpenseSingleEffect,
  type ExpenseEffectSnapshot,
  type TabOutcome,
} from "./browserSwarmEconomicOracle";
import {
  readSettledExpenseEffectSnapshot,
  type ExpenseAuthorityRefs,
} from "./browserSwarmExpenseAuthority";

export interface MissionArtifactPaths {
  root: string;
  trace: string;
  screenshot: string;
  backendState: string;
}

export interface MissionBrowser {
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
  paths: MissionArtifactPaths;
}

/** The shared, egress-contained mission browser lifecycle from the handler module. */
export interface MissionBrowserRuntime {
  open(context: BrowserMissionExecutionContext): Promise<MissionBrowser>;
  finish(runtime: MissionBrowser): Promise<readonly string[]>;
  rethrowAfterCleanup(
    runtime: MissionBrowser,
    error: unknown,
    cleanupStarted: boolean,
  ): Promise<never>;
  writeBackendEvidence(paths: MissionArtifactPaths, value: unknown): Promise<string>;
  resolveOrgRoute(page: Page): Promise<string | null>;
  authenticatedClient(page: Page): Promise<ConvexHttpClient>;
}

const CREATE_EXPENSE_UDF = /^expenses(\.js)?:create$/;
const UPDATE_EXPENSE_UDF = /^expenses(\.js)?:update$/;
const FINGERPRINT_CONFLICT = /Idempotency key reused with different request content/;
const UI_STEP_TIMEOUT_MS = 20_000;
const LOST_RESPONSE_RECOVERY_TIMEOUT_MS = 60_000;

const EXPENSE_AUTHORITY_REFS: ExpenseAuthorityRefs = {
  listExpenses: api.expenses.list,
  listAccountingEvents: api.accountingLedger.listAccountingEvents,
  listPendingOutbox: api.accountingOutbox.listPending,
  getJournalEntry: api.accountingLedger.getJournalEntry,
};

function attackNonce(context: BrowserMissionExecutionContext): string {
  const leaf = (value: string) => value.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40);
  return [
    "swarm",
    leaf(context.manifest.runId),
    leaf(context.worker.workerId),
    leaf(context.mission.family.toLowerCase()),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8),
  ].join("-");
}

// ─── Convex sync observation and fault injection ──────────────────────────────

interface ObservedMutation {
  pageLabel: string;
  requestId: number;
  title: string | undefined;
  idempotencyKey: string | undefined;
  args: Record<string, unknown>;
}

interface ObservedResponse {
  pageLabel: string;
  requestId: number;
  success: boolean;
  errorText?: string;
}

/**
 * Observes every Convex sync socket a page opens. It forwards every frame
 * unchanged, records the mutations that match `udfPattern` and their
 * responses, and — only when armed for one title — withholds that mutation's
 * response once and drops the connection, which is exactly a lost response:
 * the server committed, the client never heard, and the client reconnects and
 * retries. Nothing is forged or rewritten.
 */
class ConvexSyncObserver {
  readonly mutations: ObservedMutation[] = [];
  readonly responses: ObservedResponse[] = [];
  readonly withheld: { title: string; requestId: number }[] = [];
  private armedTitle: string | null = null;
  private readonly trackedRequests = new Set<string>();

  constructor(private readonly udfPattern: RegExp) {}

  async attach(page: Page, pageLabel: string): Promise<void> {
    await page.routeWebSocket(
      (url) => isConvexSyncSocketUrl(url),
      (socket) => this.bridge(socket, pageLabel),
    );
  }

  armLostResponse(title: string): void {
    this.armedTitle = title;
  }

  mutationsFor(title: string): ObservedMutation[] {
    return this.mutations.filter((mutation) => mutation.title === title);
  }

  responseFor(pageLabel: string, requestId: number): ObservedResponse | undefined {
    return [...this.responses]
      .reverse()
      .find((response) => response.pageLabel === pageLabel && response.requestId === requestId);
  }

  private bridge(socket: WebSocketRoute, pageLabel: string): void {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = parseConvexMutationRequest(message, this.udfPattern);
      if (frame) {
        const title = typeof frame.args.title === "string" ? frame.args.title : undefined;
        this.mutations.push({ pageLabel, ...frame, title });
        this.trackedRequests.add(pageLabel + "#" + frame.requestId);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const response = parseConvexMutationResponse(message);
      if (response && this.trackedRequests.has(pageLabel + "#" + response.requestId)) {
        this.responses.push({ pageLabel, ...response });
        const request = [...this.mutations]
          .reverse()
          .find(
            (mutation) =>
              mutation.pageLabel === pageLabel && mutation.requestId === response.requestId,
          );
        if (
          this.armedTitle !== null &&
          request?.title === this.armedTitle &&
          response.success
        ) {
          this.withheld.push({ title: this.armedTitle, requestId: response.requestId });
          this.armedTitle = null;
          // Withhold the committed response and drop the connection.
          void socket.close({ code: 4000, reason: "swarm-injected-lost-response" });
          void server.close();
          return;
        }
      }
      socket.send(message);
    });
  }
}

// ─── Expense UI drivers ──────────────────────────────────────────────────────

async function gotoExpenses(page: Page, orgId: string): Promise<void> {
  await page.goto("/" + orgId + "/expenses", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Record Expense", exact: true })
    .waitFor({ state: "visible", timeout: UI_STEP_TIMEOUT_MS });
}

async function openRecordDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Record Expense", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("heading", { name: "Record Expense" })
    .waitFor({ state: "visible", timeout: UI_STEP_TIMEOUT_MS });
  return dialog;
}

async function fillNewExpense(
  dialog: Locator,
  intent: { title: string; amount: number },
): Promise<void> {
  // Date / category / status / payment method keep their valid defaults
  // (today / OTHER / PAID / CASH): a PAID expense is the money-moving path.
  await dialog.getByLabel("Title / Description").fill(intent.title);
  await dialog.getByLabel(/^Amount \(/).fill(String(intent.amount));
}

/** Waits for the dialog to close, which the client does ONLY after success. */
async function dialogClosedAfterSuccess(dialog: Locator, timeout: number): Promise<boolean> {
  try {
    await dialog.waitFor({ state: "hidden", timeout });
    return true;
  } catch {
    return false;
  }
}

// ─── DUPLICATE_SUBMIT ────────────────────────────────────────────────────────

interface IntentReport {
  title: string;
  amount: number;
  uiConfirmed: boolean;
  transmittedAttempts: number;
  identities: (string | undefined)[];
  snapshot: ExpenseEffectSnapshot;
  effect: ReturnType<typeof evaluateExpenseSingleEffect>;
  identity: ReturnType<typeof evaluateCommandIdentityLifetime>;
}

async function settleIntent(
  client: ConvexHttpClient,
  orgId: string,
  observer: ConvexSyncObserver,
  intent: { title: string; amount: number; uiConfirmed: boolean },
): Promise<IntentReport> {
  const snapshot = await readSettledExpenseEffectSnapshot(client, {
    orgId,
    title: intent.title,
    refs: EXPENSE_AUTHORITY_REFS,
  });
  const observed = observer.mutationsFor(intent.title);
  const identities = observed.map((mutation) => mutation.idempotencyKey);
  const identity = evaluateCommandIdentityLifetime(identities);
  const matching = snapshot.expenses.filter((row) => row.title === intent.title).length;
  if (!intent.uiConfirmed && matching <= 1) {
    // The client never reported success and the backend holds at most one
    // record, so the attack was not exercised: inconclusive, never a pass.
    throw new BrowserSwarmOracleInconclusiveError(
      `intent "${intent.title}" was never confirmed by the client (backend holds ${matching}); the attack was not exercised`,
    );
  }
  const effect = evaluateExpenseSingleEffect(snapshot, {
    amount: intent.amount,
    status: "PAID",
  });
  return {
    title: intent.title,
    amount: intent.amount,
    uiConfirmed: intent.uiConfirmed,
    transmittedAttempts: observed.length,
    identities,
    snapshot,
    effect,
    identity,
  };
}

async function runDuplicateSubmitAttack(
  runtimeApi: MissionBrowserRuntime,
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const runtime = await runtimeApi.open(context);
  let cleanupStarted = false;

  try {
    const { page } = runtime;
    const observer = new ConvexSyncObserver(CREATE_EXPENSE_UDF);
    await observer.attach(page, "tab-1");

    const orgId = await runtimeApi.resolveOrgRoute(page);
    if (!orgId) throw new Error("DUPLICATE_SUBMIT could not resolve the authenticated organization route.");
    await gotoExpenses(page, orgId);

    const nonce = attackNonce(context);
    const rapid = { title: nonce + "-rapid", amount: 41 };
    const lost = { title: nonce + "-lost", amount: 43 };
    const control = { title: nonce + "-control", amount: 47 };

    // Phase A — impatient user: five submits of ONE intent in a single tick,
    // before React can re-render the disabled button (a double-click race).
    const rapidDialog = await openRecordDialog(page);
    await fillNewExpense(rapidDialog, rapid);
    await rapidDialog.locator("form").evaluate((form: HTMLFormElement) => {
      for (let attempt = 0; attempt < 5; attempt += 1) form.requestSubmit();
    });
    const rapidConfirmed = await dialogClosedAfterSuccess(rapidDialog, UI_STEP_TIMEOUT_MS);

    // Phase B — lost response: the server commits, the response is withheld
    // and the connection dropped; the client reconnects and retries.
    const lostDialog = await openRecordDialog(page);
    await fillNewExpense(lostDialog, lost);
    observer.armLostResponse(lost.title);
    await lostDialog.getByRole("button", { name: "Record Expense", exact: true }).click();
    const lostConfirmed = await dialogClosedAfterSuccess(
      lostDialog,
      LOST_RESPONSE_RECOVERY_TIMEOUT_MS,
    );
    if (!observer.withheld.some((entry) => entry.title === lost.title)) {
      throw new BrowserSwarmOracleInconclusiveError(
        "the lost-response fault was never injected; the retry path was not exercised",
      );
    }

    // Phase C — server-side replay of the exact transmitted command, then a
    // conflicting replay under the same identity with a changed amount.
    const client = await runtimeApi.authenticatedClient(page);
    const rapidFrame = observer.mutationsFor(rapid.title)[0];
    if (!rapidFrame) {
      throw new BrowserSwarmOracleInconclusiveError(
        "no transmitted create command was observed for the rapid intent",
      );
    }
    const replayArgs = jsonToConvex(rapidFrame.args as JSONValue) as FunctionArgs<
      typeof api.expenses.create
    >;
    const replayResult = await client.mutation(api.expenses.create, replayArgs);
    let conflict: { accepted: boolean; message: string };
    try {
      await client.mutation(api.expenses.create, {
        ...replayArgs,
        amount: rapid.amount + 30,
      });
      conflict = { accepted: true, message: "" };
    } catch (error) {
      conflict = {
        accepted: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!conflict.accepted && !FINGERPRINT_CONFLICT.test(conflict.message)) {
      throw new BrowserSwarmOracleInconclusiveError(
        "the conflicting replay was refused for an unrelated reason: " + conflict.message,
      );
    }

    // Phase D — control: a genuinely new intent from a fresh dialog must be a
    // new command identity and exactly one new record (retirement works).
    const controlDialog = await openRecordDialog(page);
    await fillNewExpense(controlDialog, control);
    await controlDialog.getByRole("button", { name: "Record Expense", exact: true }).click();
    const controlConfirmed = await dialogClosedAfterSuccess(controlDialog, UI_STEP_TIMEOUT_MS);

    const authorityClient = await runtimeApi.authenticatedClient(page);
    const reports = [
      await settleIntent(authorityClient, orgId, observer, { ...rapid, uiConfirmed: rapidConfirmed }),
      await settleIntent(authorityClient, orgId, observer, { ...lost, uiConfirmed: lostConfirmed }),
      await settleIntent(authorityClient, orgId, observer, { ...control, uiConfirmed: controlConfirmed }),
    ];

    const violations: string[] = [];
    for (const report of reports) {
      for (const violation of [...report.effect.violations, ...report.identity.violations]) {
        violations.push(`${report.title}: ${violation}`);
      }
    }
    const rapidReport = reports[0];
    if (reports[1].transmittedAttempts < 2) {
      violations.push(
        `${lost.title}: the client did not retry the command after the lost response (${reports[1].transmittedAttempts} attempt)`,
      );
    }
    if (String(replayResult) !== String(rapidReport.effect.expenseId)) {
      violations.push(
        `replaying the transmitted command returned ${String(replayResult)} instead of the original expense ${String(rapidReport.effect.expenseId)}`,
      );
    }
    if (conflict.accepted) {
      violations.push("a conflicting replay under an existing command identity was accepted");
    }
    const keys = reports.map((report) => report.identity.key);
    if (new Set(keys).size !== keys.length) {
      violations.push("distinct user intents shared a command identity: " + keys.join(", "));
    }

    const passed = violations.length === 0;
    const backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, {
      attack: "DUPLICATE_SUBMIT",
      orgId,
      nonce,
      replay: { result: String(replayResult), conflict },
      lostResponse: observer.withheld,
      reports,
      violations,
    });
    cleanupStarted = true;
    const artifacts = [...(await runtimeApi.finish(runtime)), backendArtifact];

    return {
      missionId: context.mission.id,
      workerId: context.worker.workerId,
      startedAt,
      completedAt: new Date().toISOString(),
      oracle: {
        kind: "IDEMPOTENCY_SINGLE_EFFECT",
        passed,
        summary: passed
          ? "Rapid resubmits, a lost response with client retry, an exact server replay and a fresh control intent each produced exactly one expense and one economic posting; the conflicting replay was refused."
          : "Duplicate-submit attack breached single economic effect: " + violations.join("; "),
      },
      artifacts,
    };
  } catch (error) {
    return runtimeApi.rethrowAfterCleanup(runtime, error, cleanupStarted);
  }
}

// ─── MULTI_TAB_RACE ──────────────────────────────────────────────────────────

async function openEditDialog(page: Page, orgId: string, title: string, expenseId: string): Promise<Locator> {
  await gotoExpenses(page, orgId);
  // Search exhausts the paginated list, so the row is reachable however many
  // expenses the shared preview already holds.
  await page.getByPlaceholder("Search expenses...", { exact: true }).fill(title);
  const row = page.locator("#row-" + expenseId);
  await row.waitFor({ state: "visible", timeout: UI_STEP_TIMEOUT_MS });
  await row.getByRole("button").first().click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Save Changes", exact: true })
    .waitFor({ state: "visible", timeout: UI_STEP_TIMEOUT_MS });
  await dialog.getByLabel("Title / Description").waitFor({ state: "visible" });
  return dialog;
}

async function setPaidWithAmount(page: Page, dialog: Locator, amount: number): Promise<void> {
  await dialog.getByLabel(/^Amount \(/).fill(String(amount));
  await dialog.getByLabel("Payment Status").click();
  await page.getByRole("option", { name: "Paid", exact: true }).click();
}

async function awaitUpdateOutcome(
  observer: ConvexSyncObserver,
  pageLabel: string,
  title: string,
  sentBefore: number,
): Promise<TabOutcome & { requestId?: number; transmittedAmount?: unknown }> {
  const deadline = Date.now() + UI_STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sent = observer
      .mutationsFor(title)
      .filter((mutation) => mutation.pageLabel === pageLabel)
      .slice(sentBefore);
    const request = sent[sent.length - 1];
    if (request) {
      const response = observer.responseFor(pageLabel, request.requestId);
      if (response) {
        return response.success
          ? { outcome: "SUCCESS", requestId: request.requestId, transmittedAmount: request.args.amount }
          : {
              outcome: "REFUSED",
              message: response.errorText ?? "",
              requestId: request.requestId,
              transmittedAmount: request.args.amount,
            };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { outcome: "UNKNOWN" };
}

function sentCount(observer: ConvexSyncObserver, pageLabel: string, title: string): number {
  return observer.mutationsFor(title).filter((mutation) => mutation.pageLabel === pageLabel).length;
}

async function runMultiTabRaceAttack(
  runtimeApi: MissionBrowserRuntime,
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const runtime = await runtimeApi.open(context);
  let cleanupStarted = false;

  try {
    const tabA = runtime.page;
    const observer = new ConvexSyncObserver(UPDATE_EXPENSE_UDF);
    await observer.attach(tabA, "tab-a");
    const tabB = await runtime.browserContext.newPage();
    await observer.attach(tabB, "tab-b");

    const orgId = await runtimeApi.resolveOrgRoute(tabA);
    if (!orgId) throw new Error("MULTI_TAB_RACE could not resolve the authenticated organization route.");

    // Synthetic setup through the same authenticated, permission-checked
    // command the UI uses: one PENDING (not yet money-moving) expense.
    const nonce = attackNonce(context);
    const title = nonce + "-race";
    const setupAmount = 50;
    const today = new Date();
    const date = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const setupClient = await runtimeApi.authenticatedClient(tabA);
    const expenseId = String(
      await setupClient.mutation(api.expenses.create, {
        idempotencyKey: "swarm-setup:" + nonce,
        orgId: orgId as Id<"organizations">,
        title,
        amount: setupAmount,
        date,
        category: "OTHER",
        status: "PENDING",
      }),
    );

    const dialogA = await openEditDialog(tabA, orgId, title, expenseId);
    const dialogB = await openEditDialog(tabB, orgId, title, expenseId);
    const intended = { A: 50, B: 80 } as const;
    await setPaidWithAmount(tabA, dialogA, intended.A);
    await setPaidWithAmount(tabB, dialogB, intended.B);

    // Both tabs pay the same expense with different amounts, concurrently.
    await Promise.all([
      dialogA.getByRole("button", { name: "Save Changes", exact: true }).click(),
      dialogB.getByRole("button", { name: "Save Changes", exact: true }).click(),
    ]);
    const [outcomeA, outcomeB] = await Promise.all([
      awaitUpdateOutcome(observer, "tab-a", title, 0),
      awaitUpdateOutcome(observer, "tab-b", title, 0),
    ]);
    for (const [label, outcome, amount] of [
      ["A", outcomeA, intended.A],
      ["B", outcomeB, intended.B],
    ] as const) {
      if (outcome.outcome !== "UNKNOWN" && outcome.transmittedAmount !== amount) {
        throw new BrowserSwarmOracleInconclusiveError(
          `tab ${label} transmitted amount ${String(outcome.transmittedAmount)} instead of ${amount}`,
        );
      }
    }

    // The losing tab's dialog stays open on refusal; it retries its stale form.
    const loser =
      outcomeA.outcome === "REFUSED" ? { page: "tab-a", dialog: dialogA } :
      outcomeB.outcome === "REFUSED" ? { page: "tab-b", dialog: dialogB } :
      null;
    let staleRetry: TabOutcome = { outcome: "REFUSED", message: "Posted expenses are locked (no loser to retry)" };
    if (loser) {
      const before = sentCount(observer, loser.page, title);
      await loser.dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
      staleRetry = await awaitUpdateOutcome(observer, loser.page, title, before);
    }

    const authorityClient = await runtimeApi.authenticatedClient(tabA);
    const snapshot = await readSettledExpenseEffectSnapshot(authorityClient, {
      orgId,
      title,
      refs: EXPENSE_AUTHORITY_REFS,
    });
    const authoritative = snapshot.expenses.find((row) => row.id === expenseId);
    if (!authoritative) {
      throw new BrowserSwarmOracleInconclusiveError(
        "the synthetic race expense is missing from backend authority",
      );
    }
    const race = evaluateConcurrentEditRace({
      tabs: [
        { tab: "A", intendedAmount: intended.A, ...outcomeA },
        { tab: "B", intendedAmount: intended.B, ...outcomeB },
      ],
      authoritative: { amount: authoritative.amount, status: authoritative.status },
      staleRetry,
    });
    const effect =
      race.winningAmount === null
        ? null
        : evaluateExpenseSingleEffect(snapshot, { amount: race.winningAmount, status: "PAID" });
    const violations = [...race.violations, ...(effect?.violations ?? [])];

    const passed = violations.length === 0;
    const backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, {
      attack: "MULTI_TAB_RACE",
      orgId,
      nonce,
      expenseId,
      setup: { amount: setupAmount, status: "PENDING" },
      tabs: { A: outcomeA, B: outcomeB },
      staleRetry,
      snapshot,
      race,
      effect,
      violations,
    });
    cleanupStarted = true;
    const artifacts = [...(await runtimeApi.finish(runtime)), backendArtifact];

    return {
      missionId: context.mission.id,
      workerId: context.worker.workerId,
      startedAt,
      completedAt: new Date().toISOString(),
      oracle: {
        kind: "IDEMPOTENCY_SINGLE_EFFECT",
        passed,
        summary: passed
          ? `Two tabs paid the same expense concurrently; exactly one (tab ${race.winner}) won, the loser and its stale retry were refused by the posting lock, and the backend holds one posting of the winning amount.`
          : "Concurrent-tab race breached single economic effect: " + violations.join("; "),
      },
      artifacts,
    };
  } catch (error) {
    return runtimeApi.rethrowAfterCleanup(runtime, error, cleanupStarted);
  }
}

export function createEconomicAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
): { DUPLICATE_SUBMIT: BrowserMissionHandler; MULTI_TAB_RACE: BrowserMissionHandler } {
  return {
    DUPLICATE_SUBMIT: (context) => runDuplicateSubmitAttack(runtimeApi, context),
    MULTI_TAB_RACE: (context) => runMultiTabRaceAttack(runtimeApi, context),
  };
}
