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
  classifyIntentExercise,
  classifyServerReplayFailure,
  evaluateCommandIdentityLifetime,
  evaluateConcurrentEditRace,
  evaluateExpenseSingleEffect,
  evaluateIntentReplies,
  FINGERPRINT_CONFLICT_TEXT,
  isAuthenticationLapse,
  VerdictLedger,
  type ExpenseEffectSnapshot,
  type IntentReplyRow,
  type IntentRepliesVerdict,
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
const FINGERPRINT_CONFLICT = FINGERPRINT_CONFLICT_TEXT;
const UI_STEP_TIMEOUT_MS = 20_000;
/** How long the race barrier waits for the second tab's save frame. */
const RACE_BARRIER_TIMEOUT_MS = 10_000;
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
  /** Observer sequence at which the frame was forwarded to the backend. */
  sentSeq: number | null;
}

interface ObservedResponse {
  pageLabel: string;
  requestId: number;
  /** Title of the intent whose attempt this replies to, when known. */
  title: string | undefined;
  success: boolean;
  errorText?: string;
  /** Observer sequence at which the backend's response arrived. */
  receivedSeq: number;
  /** True when the harness withheld this reply (the injected lost response). */
  withheld: boolean;
}

type SocketFrame = string | Buffer;

/**
 * A two-request start line. Each listed page's first matching mutation is
 * held (with every later frame of that page, so socket order is preserved)
 * until every listed page has sent one; then all are forwarded back to back.
 * Both edits are therefore in flight before either can be answered — the
 * overlap a race needs, instead of trusting Promise.all on two clicks
 * (SCRUM-826 F2). On timeout the held frames are released unchanged and the
 * barrier stays unsatisfied, which the handler reports as inconclusive.
 */
interface RaceBarrier {
  title: string;
  labels: ReadonlySet<string>;
  held: Map<string, () => void>;
  satisfied: boolean;
  released: boolean;
}

/**
 * Observes every Convex sync socket a page opens. It forwards every frame
 * unchanged, records the mutations that match `udfPattern` and their
 * responses, and — only when armed for one title — withholds that mutation's
 * response once and drops the connection, which is exactly a lost response:
 * the server committed, the client never heard, and the client reconnects and
 * retries. Nothing is forged or rewritten.
 */
export class ConvexSyncObserver {
  readonly mutations: ObservedMutation[] = [];
  readonly responses: ObservedResponse[] = [];
  readonly withheld: { title: string; requestId: number }[] = [];
  private armedTitle: string | null = null;
  private readonly trackedRequests = new Set<string>();
  private sequence = 0;
  private barrier: RaceBarrier | null = null;

  constructor(private readonly udfPattern: RegExp) {}

  /** Holds the first matching mutation of each listed page until all have sent one. */
  armRaceBarrier(title: string, labels: readonly string[]): void {
    this.barrier = {
      title,
      labels: new Set(labels),
      held: new Map(),
      satisfied: false,
      released: false,
    };
  }

  get raceBarrierSatisfied(): boolean {
    return this.barrier?.satisfied ?? false;
  }

  /** Forwards anything still held, unchanged. Idempotent. */
  releaseRaceBarrier(): void {
    const barrier = this.barrier;
    if (!barrier || barrier.released) return;
    barrier.released = true;
    for (const flush of barrier.held.values()) flush();
  }

  private nextSeq(): number {
    this.sequence += 1;
    return this.sequence;
  }

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

  /** Every backend reply to an attempt of the intent titled `title`, in arrival order. */
  repliesFor(title: string): IntentReplyRow[] {
    return this.responses
      .filter((response) => response.title === title)
      .map((response) => ({
        requestId: response.requestId,
        success: response.success,
        withheld: response.withheld,
        ...(response.errorText === undefined ? {} : { errorText: response.errorText }),
      }));
  }

  responseFor(pageLabel: string, requestId: number): ObservedResponse | undefined {
    return [...this.responses]
      .reverse()
      .find((response) => response.pageLabel === pageLabel && response.requestId === requestId);
  }

  private bridge(socket: WebSocketRoute, pageLabel: string): void {
    const server = socket.connectToServer();
    // Frames held behind the race barrier, in page order. While non-null,
    // every frame from this page queues so the socket order never changes.
    let queue: { message: SocketFrame; record?: ObservedMutation }[] | null = null;
    const forward = (message: SocketFrame, record?: ObservedMutation): void => {
      if (record) record.sentSeq = this.nextSeq();
      server.send(message);
    };
    socket.onMessage((message) => {
      const frame = parseConvexMutationRequest(message, this.udfPattern);
      let record: ObservedMutation | undefined;
      if (frame) {
        const title = typeof frame.args.title === "string" ? frame.args.title : undefined;
        record = { pageLabel, ...frame, title, sentSeq: null };
        this.mutations.push(record);
        this.trackedRequests.add(pageLabel + "#" + frame.requestId);
      }
      if (queue) {
        queue.push({ message, record });
        return;
      }
      const barrier = this.barrier;
      if (
        record &&
        barrier &&
        !barrier.released &&
        barrier.labels.has(pageLabel) &&
        !barrier.held.has(pageLabel) &&
        record.title === barrier.title
      ) {
        const held: { message: SocketFrame; record?: ObservedMutation }[] = [{ message, record }];
        queue = held;
        barrier.held.set(pageLabel, () => {
          queue = null;
          for (const entry of held) forward(entry.message, entry.record);
        });
        if (barrier.held.size === barrier.labels.size) {
          barrier.satisfied = true;
          this.releaseRaceBarrier();
        }
        return;
      }
      forward(message, record);
    });
    server.onMessage((message) => {
      const response = parseConvexMutationResponse(message);
      if (response && this.trackedRequests.has(pageLabel + "#" + response.requestId)) {
        const request = [...this.mutations]
          .reverse()
          .find(
            (mutation) =>
              mutation.pageLabel === pageLabel && mutation.requestId === response.requestId,
          );
        const observed: ObservedResponse = {
          pageLabel,
          ...response,
          title: request?.title,
          receivedSeq: this.nextSeq(),
          withheld: false,
        };
        this.responses.push(observed);
        if (
          this.armedTitle !== null &&
          request?.title === this.armedTitle &&
          response.success
        ) {
          observed.withheld = true;
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
  /** Null when the intent was not exercised and no record could be judged. */
  effect: ReturnType<typeof evaluateExpenseSingleEffect> | null;
  identity: ReturnType<typeof evaluateCommandIdentityLifetime>;
  replies: IntentReplyRow[];
  replyVerdict: IntentRepliesVerdict;
  /** Why this intent cannot be judged as a whole; null when it can. */
  inconclusive: string | null;
  /**
   * Title-prefixed violations that are proof on their own (backend effect,
   * transmitted identity, client-visible refusal), whether or not the intent
   * was exercised (SCRUM-826 C-2).
   */
  proven: string[];
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
  const replies = observer.repliesFor(intent.title);
  const replyVerdict = evaluateIntentReplies(intent.title, replies);
  const matching = snapshot.expenses.filter((row) => row.title === intent.title).length;
  const exercise = classifyIntentExercise({
    uiConfirmed: intent.uiConfirmed,
    backendRecords: matching,
    refusedReplies: replyVerdict.refused,
  });
  const expected = { amount: intent.amount, status: "PAID" as const };
  let effect: ReturnType<typeof evaluateExpenseSingleEffect> | null = null;
  if (exercise !== "NOT_EXERCISED") {
    effect = evaluateExpenseSingleEffect(snapshot, expected);
  } else if (matching > 0) {
    // SCRUM-826 C-2: an unexercised intent whose record nevertheless exists
    // in the settled snapshot is still judged on that record — a double
    // posting is proof whether or not the client saw a reply. A record that
    // is absent proves nothing here, and an unreadable ledger stays
    // unjudged rather than becoming a verdict.
    try {
      effect = evaluateExpenseSingleEffect(snapshot, expected);
    } catch (error) {
      if (!(error instanceof BrowserSwarmOracleInconclusiveError)) throw error;
    }
  }
  const proven = [
    ...(effect?.violations ?? []).map((violation) => `${intent.title}: ${violation}`),
    ...identity.violations.map((violation) => `${intent.title}: ${violation}`),
    // Already prefixed with the intent title; session lapses are excluded (P2).
    ...replyVerdict.violations,
  ];
  let inconclusive: string | null = null;
  if (exercise === "NOT_EXERCISED") {
    // The client never reported success, the backend refused nothing it
    // could see, and holds at most one record: the attack was not exercised.
    // Inconclusive, never a pass; any proof above is still reported
    // (SCRUM-826 O2/C-2).
    inconclusive =
      replyVerdict.authenticationLapses > 0
        ? `intent "${intent.title}" received ${replyVerdict.authenticationLapses} reply(ies) refused for a lapsed session and was never confirmed; the harness lost authentication (SCRUM-826 P2)`
        : `intent "${intent.title}" was never confirmed by the client (backend holds ${matching}, no refusal reply); the attack was not exercised`;
  } else if (
    replyVerdict.authenticationLapses > 0 &&
    (effect?.violations.length ?? 0) === 0 &&
    identity.violations.length === 0
  ) {
    // A lapsed session makes the reply-based verdict unjudgeable (SCRUM-826
    // P2). A proven backend effect or identity breach still stands.
    inconclusive = `intent "${intent.title}" received ${replyVerdict.authenticationLapses} reply(ies) refused for a lapsed session; the harness lost authentication (SCRUM-826 P2)`;
  }
  return {
    inconclusive,
    proven,
    title: intent.title,
    amount: intent.amount,
    uiConfirmed: intent.uiConfirmed,
    transmittedAttempts: observed.length,
    identities,
    snapshot,
    effect,
    identity,
    replies,
    replyVerdict,
  };
}

async function runDuplicateSubmitAttack(
  runtimeApi: MissionBrowserRuntime,
  context: BrowserMissionExecutionContext,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const runtime = await runtimeApi.open(context);
  let cleanupStarted = false;
  const observer = new ConvexSyncObserver(CREATE_EXPENSE_UDF);
  const nonce = attackNonce(context);
  let resolvedOrgId: string | null = null;
  const rapid = { title: nonce + "-rapid", amount: 41 };
  const lost = { title: nonce + "-lost", amount: 43 };
  const control = { title: nonce + "-control", amount: 47 };
  /**
   * The single verdict authority (SCRUM-826 S1/C-1/C-2). Every proof is
   * recorded the moment it is observed and never retracted; a phase that
   * cannot be judged only adds an unjudged reason and the attack continues,
   * so every phase gets the chance to produce proof. The decision is
   * independent of the order in which proof and lapses/stalls happened.
   */
  const ledger = new VerdictLedger();
  const reports = new Map<string, IntentReport>();
  let concluding = false;

  /** Settles one intent into the ledger. Never throws for an unjudgeable intent. */
  const settleInto = async (
    client: ConvexHttpClient,
    orgId: string,
    intent: { title: string; amount: number; uiConfirmed: boolean },
  ): Promise<IntentReport> => {
    const report = await settleIntent(client, orgId, observer, intent);
    reports.set(intent.title, report);
    ledger.prove(...report.proven);
    if (report.inconclusive) ledger.unjudgeable(report.inconclusive);
    return report;
  };

  /** Client-visible refusals are proof whenever they were seen (lapses excluded, P2). */
  const proveObservedRefusals = (): void => {
    for (const title of [rapid.title, lost.title, control.title]) {
      const verdict = evaluateIntentReplies(title, observer.repliesFor(title));
      ledger.prove(...verdict.violations);
      if (verdict.authenticationLapses > 0) {
        ledger.unjudgeable(
          `intent "${title}" received ${verdict.authenticationLapses} reply(ies) refused for a lapsed session; the harness lost authentication (SCRUM-826 P2)`,
        );
      }
    }
  };

  /** Writes the backend evidence and returns the mission's oracle verdict. */
  const conclude = async (
    violations: readonly string[],
    detail: Record<string, unknown>,
  ): Promise<BrowserMissionEvidence> => {
    concluding = true;
    const passed = violations.length === 0;
    const backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, {
      attack: "DUPLICATE_SUBMIT",
      orgId: resolvedOrgId,
      nonce,
      ...detail,
      lostResponse: observer.withheld,
      replies: observer.responses,
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
          ? "Rapid resubmits, a lost response with client retry, an exact server replay and a fresh control intent each produced exactly one expense and one economic posting, every client-visible reply accepted the intent, and the conflicting replay was refused."
          : "Duplicate-submit attack breached single economic effect: " + violations.join("; "),
      },
      artifacts,
    };
  };

  try {
    const { page } = runtime;
    await observer.attach(page, "tab-1");

    const orgId = await runtimeApi.resolveOrgRoute(page);
    if (!orgId) throw new Error("DUPLICATE_SUBMIT could not resolve the authenticated organization route.");
    resolvedOrgId = orgId;
    await gotoExpenses(page, orgId);

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
    // The fault withholds only a SUCCESSFUL reply. If it never fired, the
    // retry path is unjudged — but the attack continues, so the later phases
    // can still produce proof; a refusal of the lost intent is itself proof
    // (SCRUM-826 O2), recorded with the other observed replies.
    const lostInjected = observer.withheld.some((entry) => entry.title === lost.title);
    if (!lostInjected) {
      ledger.unjudgeable(
        "the lost-response fault was never injected; the retry path was not exercised",
      );
    }

    // Phase C — server-side replay of the exact transmitted command, then a
    // conflicting replay under the same identity with a changed amount.
    const client = await runtimeApi.authenticatedClient(page);
    const rapidFrame = observer.mutationsFor(rapid.title)[0];
    let replay:
      | { accepted: true; result: unknown }
      | { accepted: false; message: string }
      | null = null;
    let conflict: { accepted: boolean; message: string } | null = null;
    if (!rapidFrame) {
      ledger.unjudgeable("no transmitted create command was observed for the rapid intent");
    } else {
      const replayArgs = jsonToConvex(rapidFrame.args as JSONValue) as FunctionArgs<
        typeof api.expenses.create
      >;
      // An exact replay must return the original record. A backend refusal
      // is the product's verdict on replay semantics (SCRUM-826 R1); a lapse
      // of the harness session is unjudged (P2); a transport or unidentified
      // failure aborts as a harness error.
      try {
        replay = { accepted: true, result: await client.mutation(api.expenses.create, replayArgs) };
      } catch (error) {
        if (isAuthenticationLapse(error)) {
          ledger.unjudgeable(
            "the exact server replay was refused for a lapsed harness session (SCRUM-826 P2)",
          );
        } else if (classifyServerReplayFailure(error) === "BACKEND_REFUSED") {
          replay = {
            accepted: false,
            message: error instanceof Error ? error.message : String(error),
          };
          ledger.prove(
            "the backend refused an exact replay of the transmitted command: " + replay.message,
          );
        } else {
          throw error;
        }
      }
      if (replay !== null) {
        try {
          await client.mutation(api.expenses.create, {
            ...replayArgs,
            amount: rapid.amount + 30,
          });
          conflict = { accepted: true, message: "" };
          // Proof the moment it is observed (SCRUM-826 S2).
          ledger.prove("a conflicting replay under an existing command identity was accepted");
        } catch (error) {
          conflict = {
            accepted: false,
            message: error instanceof Error ? error.message : String(error),
          };
          if (!FINGERPRINT_CONFLICT.test(conflict.message)) {
            ledger.unjudgeable(
              "the conflicting replay was refused for an unrelated reason: " + conflict.message,
            );
          }
        }
      }
    }

    // Phase D — control: a genuinely new intent from a fresh dialog must be a
    // new command identity and exactly one new record (retirement works).
    const controlDialog = await openRecordDialog(page);
    await fillNewExpense(controlDialog, control);
    await controlDialog.getByRole("button", { name: "Record Expense", exact: true }).click();
    const controlConfirmed = await dialogClosedAfterSuccess(controlDialog, UI_STEP_TIMEOUT_MS);

    const authorityClient = await runtimeApi.authenticatedClient(page);
    const rapidReport = await settleInto(authorityClient, orgId, {
      ...rapid,
      uiConfirmed: rapidConfirmed,
    });
    const lostReport = await settleInto(authorityClient, orgId, {
      ...lost,
      uiConfirmed: lostConfirmed,
    });
    const controlReport = await settleInto(authorityClient, orgId, {
      ...control,
      uiConfirmed: controlConfirmed,
    });
    proveObservedRefusals();

    if (lostInjected && lostReport.transmittedAttempts < 2) {
      ledger.prove(
        `${lost.title}: the client did not retry the command after the lost response (${lostReport.transmittedAttempts} attempt)`,
      );
    }
    if (replay?.accepted && rapidReport.effect !== null) {
      if (String(replay.result) !== String(rapidReport.effect.expenseId)) {
        ledger.prove(
          `replaying the transmitted command returned ${String(replay.result)} instead of the original expense ${String(rapidReport.effect.expenseId)}`,
        );
      }
    }
    // Only identities that were actually transmitted can collide.
    const keys = [rapidReport, lostReport, controlReport]
      .map((report) => report.identity.key)
      .filter((key): key is string => typeof key === "string");
    if (new Set(keys).size !== keys.length) {
      ledger.prove("distinct user intents shared a command identity: " + keys.join(", "));
    }

    const detail = {
      replay:
        replay === null
          ? null
          : {
              ...(replay.accepted
                ? { result: String(replay.result) }
                : { refused: replay.message }),
              conflict,
            },
      reports: [...reports.values()],
    };
    const decision = ledger.decide();
    if (decision.kind === "BREACH") {
      return await conclude(decision.violations, {
        ...detail,
        ...(decision.unjudged.length > 0 ? { phase: "PARTIAL", unjudged: decision.unjudged } : {}),
      });
    }
    if (decision.kind === "INCONCLUSIVE") {
      // Never a pass. The catch below writes the evidence.
      throw new BrowserSwarmOracleInconclusiveError(decision.reason);
    }
    return await conclude([], detail);
  } catch (error) {
    let undelivered: string[] | null = null;
    if (!cleanupStarted && !concluding) {
      // A harness failure aborted the attack. Proof already observed is a
      // product verdict and must survive it (SCRUM-826 C-1/C-2/S1): gather the
      // observed refusals and, best effort, settle every intent not yet
      // settled, then decide from the ledger.
      proveObservedRefusals();
      if (resolvedOrgId !== null) {
        try {
          const recoveryClient = await runtimeApi.authenticatedClient(runtime.page);
          for (const intent of [rapid, lost, control]) {
            if (reports.has(intent.title)) continue;
            try {
              await settleInto(recoveryClient, resolvedOrgId, { ...intent, uiConfirmed: false });
            } catch {
              // Unreadable now; the original failure stands for this intent.
            }
          }
        } catch {
          // No authority client; decide from what was already observed.
        }
      }
      const decision = ledger.decide();
      if (decision.kind === "BREACH") {
        try {
          return await conclude(decision.violations, {
            phase: "INTERRUPTED",
            interruptedBy: error instanceof Error ? error.message : String(error),
            unjudged: decision.unjudged,
            mutations: observer.mutations,
            reports: [...reports.values()],
          });
        } catch (concludeError) {
          // Evidence or cleanup failed while concluding. The original failure
          // is reported, carrying the cleanup failure as its cause (L-A), and
          // an undelivered breach is labelled as one (L-B).
          if (error instanceof Error && error.cause === undefined) error.cause = concludeError;
          if (!cleanupStarted) undelivered = decision.violations;
        }
      }
    }
    if (!cleanupStarted) {
      // Every run that fails to conclude still leaves its backend evidence
      // behind, so an operator can tell a harness fault from a hidden product
      // refusal (SCRUM-826 O2/R-1). Best effort: the error stays the result.
      try {
        await runtimeApi.writeBackendEvidence(runtime.paths, {
          attack: "DUPLICATE_SUBMIT",
          outcome:
            undelivered !== null
              ? "BREACH_UNDELIVERED"
              : error instanceof BrowserSwarmOracleInconclusiveError
                ? "INCONCLUSIVE"
                : "HARNESS_ERROR",
          ...(undelivered !== null ? { violations: undelivered } : {}),
          unjudged: ledger.unjudged,
          reason: error instanceof Error ? error.message : String(error),
          orgId: resolvedOrgId,
          nonce,
          mutations: observer.mutations,
          replies: observer.responses,
          lostResponse: observer.withheld,
        });
      } catch {
        // The original error is reported regardless.
      }
    }
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
): Promise<
  TabOutcome & {
    requestId?: number;
    transmittedAmount?: unknown;
    sentSeq?: number | null;
    responseSeq?: number;
  }
> {
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
        const evidence = {
          requestId: request.requestId,
          transmittedAmount: request.args.amount,
          sentSeq: request.sentSeq,
          responseSeq: response.receivedSeq,
        };
        return response.success
          ? { outcome: "SUCCESS", ...evidence }
          : { outcome: "REFUSED", message: response.errorText ?? "", ...evidence };
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

    // Both tabs pay the same expense with different amounts. The barrier
    // holds whichever save reaches the socket first until the other has been
    // sent too, so both are in flight before either can be answered.
    observer.armRaceBarrier(title, ["tab-a", "tab-b"]);
    await Promise.all([
      dialogA.getByRole("button", { name: "Save Changes", exact: true }).click(),
      dialogB.getByRole("button", { name: "Save Changes", exact: true }).click(),
    ]);
    const barrierDeadline = Date.now() + RACE_BARRIER_TIMEOUT_MS;
    while (!observer.raceBarrierSatisfied && Date.now() < barrierDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const overlapped = observer.raceBarrierSatisfied;
    observer.releaseRaceBarrier();
    if (!overlapped) {
      throw new BrowserSwarmOracleInconclusiveError(
        "both tabs' saves never reached the backend socket together; the race was not exercised",
      );
    }
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
      ordering: [
        { tab: "A", sentSeq: outcomeA.sentSeq ?? null, responseSeq: outcomeA.responseSeq ?? null },
        { tab: "B", sentSeq: outcomeB.sentSeq ?? null, responseSeq: outcomeB.responseSeq ?? null },
      ],
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
