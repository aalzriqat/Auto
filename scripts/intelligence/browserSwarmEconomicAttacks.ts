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
import { createHash, randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs } from "convex/server";
import { jsonToConvex, type JSONValue } from "convex/values";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CreateExpenseSchema } from "../../convex/validations/expenses";
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
  type CommandIdentityVerdict,
  type ExpenseEffectSnapshot,
  type IntentReplyRow,
  type IntentRepliesVerdict,
  type LedgerDecision,
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

/** The two authenticated QA seats a mission browser can be opened as. */
export type MissionSeat = "primary" | "approver";

/** The shared, egress-contained mission browser lifecycle from the handler module. */
export interface MissionBrowserRuntime {
  /** `seat` defaults to the primary OWNER seat; the approver is the dealership's MANAGER. */
  open(context: BrowserMissionExecutionContext, seat?: MissionSeat): Promise<MissionBrowser>;
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

export const CREATE_EXPENSE_UDF = /^expenses(\.js)?:create$/;
const UPDATE_EXPENSE_UDF = /^expenses(\.js)?:update$/;
const FINGERPRINT_CONFLICT = FINGERPRINT_CONFLICT_TEXT;
export const UI_STEP_TIMEOUT_MS = 20_000;
/** How long the race barrier waits for the second tab's save frame. */
const RACE_BARRIER_TIMEOUT_MS = 10_000;
const LOST_RESPONSE_RECOVERY_TIMEOUT_MS = 60_000;

export const EXPENSE_AUTHORITY_REFS: ExpenseAuthorityRefs = {
  listExpenses: api.expenses.list,
  listAccountingEvents: api.accountingLedger.listAccountingEvents,
  listPendingOutbox: api.accountingOutbox.listPending,
  getJournalEntry: api.accountingLedger.getJournalEntry,
};

/** Room reserved after a nonce for the longest intent suffix ("-control"). */
const ATTACK_TITLE_SUFFIX_BUDGET = 16;

/**
 * A run-unique synthetic title stem. Every title built from it must be VALID
 * backend input: a refusal of an invalid title would read as a product breach
 * (SCRUM-826 D1). The length is bounded by construction, whatever the run id;
 * the full run id is kept as a digest so long ids sharing a prefix stay apart.
 */
export function attackNonce(context: BrowserMissionExecutionContext): string {
  const leaf = (value: string, max: number) => value.replace(/[^A-Za-z0-9-]/g, "-").slice(0, max);
  const runId = context.manifest.runId;
  const nonce = [
    "swarm",
    leaf(runId, 12),
    createHash("sha256").update(runId).digest("hex").slice(0, 10),
    leaf(context.worker.workerId, 12),
    leaf(context.mission.family.toLowerCase(), 16),
    Date.now().toString(36),
    // A CSPRNG suffix: the oracle relies on titles being run-unique nonces.
    randomBytes(6).toString("hex"),
  ].join("-");
  const titleMax = CreateExpenseSchema.shape.title.maxLength;
  if (titleMax !== null && nonce.length + ATTACK_TITLE_SUFFIX_BUDGET > titleMax) {
    throw new Error(
      `Synthetic attack title would exceed the backend title limit (${titleMax}); refusing to run an attack whose refusal could not be judged`,
    );
  }
  return nonce;
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
  readonly withheld: { title: string; requestId: number; pageLabel: string; connection: number }[] = [];
  /** Sync connections, numbered in the order the pages opened them (Codex DS-1). */
  private connections = 0;
  /** Connections on which the server was heard after they opened, per page label. */
  private readonly answeredConnections = new Map<string, Set<number>>();
  private armedTitle: string | null = null;
  /** SCRUM-350: an outage that swallows one request and refuses reconnects for a while. */
  private outage: { title: string; durationMs: number; until: number | null } | null = null;
  readonly dropped: { title: string; requestId: number; pageLabel: string; connection: number }[] = [];
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

  /** Ends the lost-response fault whether or not it fired (SCRUM-826 D1 P3). */
  disarmLostResponse(): void {
    this.armedTitle = null;
  }

  /**
   * SCRUM-350 NETWORK_RECOVERY: the request never arrives. The first mutation
   * of `title` is swallowed before it reaches the server, the connection is
   * dropped, and every reconnect is refused for `durationMs`; afterwards the
   * network is back. The complement of the lost response, where the server
   * committed and only the reply was lost.
   */
  armOutage(title: string, durationMs: number): void {
    this.outage = { title, durationMs, until: null };
  }

  /** Ends the outage whether or not it fired. */
  disarmOutage(): void {
    this.outage = null;
  }

  /** Mutations of `title` the outage swallowed before the server saw them. */
  droppedFor(title: string): readonly { requestId: number }[] {
    return this.dropped.filter((entry) => entry.title === title);
  }

  /**
   * True when, after the outage dropped the connection that carried `title`,
   * the same page was back on a NEWER connection and the server was heard on
   * it: the client had a positively observed chance to resend.
   */
  reconnectedAfterOutage(title: string): boolean {
    const fault = this.dropped.find((entry) => entry.title === title);
    if (!fault) return false;
    const heard = this.answeredConnections.get(fault.pageLabel);
    return heard !== undefined && [...heard].some((connection) => connection > fault.connection);
  }

  /**
   * Transmitted attempts of `title` that no delivered reply has answered. A
   * withheld reply never reached the client, so it answers nothing.
   */
  unansweredFor(title: string): ObservedMutation[] {
    return this.mutationsFor(title).filter(
      (mutation) =>
        !this.responses.some(
          (response) =>
            !response.withheld &&
            response.pageLabel === mutation.pageLabel &&
            response.requestId === mutation.requestId,
        ),
    );
  }

  /**
   * SCRUM-826 DS-1: true when, after the lost-response fault dropped the
   * connection that carried `title`, the same page was back on a NEWER
   * connection and the server was heard on it. Only then did the client have
   * a positively observed opportunity to retry.
   */
  reconnectedAfterLostResponse(title: string): boolean {
    const fault = this.withheld.find((entry) => entry.title === title);
    if (!fault) return false;
    const heard = this.answeredConnections.get(fault.pageLabel);
    return heard !== undefined && [...heard].some((connection) => connection > fault.connection);
  }

  /** True once the client received a successful reply for an attempt of `title`. */
  acceptedReplyDelivered(title: string): boolean {
    return this.responses.some(
      (response) => response.title === title && response.success && !response.withheld,
    );
  }

  /** Waits, bounded, until every transmitted attempt of `title` was answered. */
  async waitUntilAnswered(title: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      if (this.unansweredFor(title).length === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, timeoutMs)));
    }
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
    const outage = this.outage;
    if (outage?.until != null && Date.now() < outage.until) {
      // The network is still down: this connection never reaches the server.
      void socket.close({ code: 4001, reason: "swarm-injected-network-outage" });
      return;
    }
    const server = socket.connectToServer();
    this.connections += 1;
    const connection = this.connections;
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
      const outageNow = this.outage;
      if (record && outageNow && outageNow.until === null && record.title === outageNow.title) {
        // The network goes down with this request in flight: it is lost
        // before the server, and the connection is dropped.
        outageNow.until = Date.now() + outageNow.durationMs;
        this.dropped.push({
          title: outageNow.title,
          requestId: record.requestId,
          pageLabel,
          connection,
        });
        void socket.close({ code: 4001, reason: "swarm-injected-network-outage" });
        void server.close();
        return;
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
      const heard = this.answeredConnections.get(pageLabel) ?? new Set<number>();
      heard.add(connection);
      this.answeredConnections.set(pageLabel, heard);
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
          this.withheld.push({
            title: this.armedTitle,
            requestId: response.requestId,
            pageLabel,
            connection,
          });
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

export async function gotoExpenses(page: Page, orgId: string, timeout = UI_STEP_TIMEOUT_MS): Promise<void> {
  await page.goto("/" + orgId + "/expenses", { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Record Expense", exact: true })
    .waitFor({ state: "visible", timeout });
}

/** Settles `work` or rejects the moment the mission is aborted (SCRUM-826 D5). */
export function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

type DialogOpening = { kind: "OPEN"; dialog: Locator } | { kind: "REFUSED"; reason: string };

/** How long a just-opened dialog may take to apply its reset before it counts as stale. */
const FRESH_FORM_SETTLE_MS = 2_000;

/**
 * Opens the Record Expense dialog for a NEW intent, or says why it cannot
 * (SCRUM-826 D1). P1: no dialog may be open — while one is, Radix hides the
 * page trigger and "Record Expense" resolves to that dialog's own submit
 * button, so a click would resubmit the previous intent. P2: the dialog must
 * be a closed-to-open transition showing the reset defaults (title "" and
 * amount 0), read once the reset has had time to apply; a stale form is
 * never reused for a new intent.
 */
export async function openFreshDialog(
  page: Page,
  phase: string,
  timeout: number,
  signal: AbortSignal,
): Promise<DialogOpening> {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) {
    return {
      kind: "REFUSED",
      reason: `${phase}: a dialog was still open, so the page trigger would resolve to its submit button (D1 P1)`,
    };
  }
  await page.getByRole("button", { name: "Record Expense", exact: true }).click({ timeout });
  await dialog
    .getByRole("heading", { name: "Record Expense" })
    .waitFor({ state: "visible", timeout });
  const deadline = Date.now() + Math.min(timeout, FRESH_FORM_SETTLE_MS);
  for (;;) {
    signal.throwIfAborted();
    const title = await dialog.getByLabel("Title / Description").inputValue({ timeout });
    const amount = await dialog.getByLabel(/^Amount \(/).inputValue({ timeout });
    if (title === "" && (amount === "" || Number(amount) === 0)) return { kind: "OPEN", dialog };
    if (Date.now() >= deadline) {
      return {
        kind: "REFUSED",
        reason: `${phase}: the dialog did not open with a fresh form (title ${JSON.stringify(title)}, amount ${JSON.stringify(amount)}) (D1 P2)`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export type PhaseExit =
  | { kind: "CONFIRMED" }
  | { kind: "CLOSED_UNCONFIRMED" }
  | { kind: "CANCELLED" }
  | { kind: "BLOCKED"; reason: string };

/**
 * Ends one UI phase (SCRUM-826 D2). Every transmitted attempt of the intent
 * must be answered before the UI moves on: a save still in flight at the
 * deadline BLOCKS every later UI phase, because a late reply would close (or
 * be attributed to) the next dialog. The dialog is never cancelled while a
 * save is in flight. The phase is CONFIRMED only when the dialog is hidden
 * AND the client received an accepted reply for this intent's own title.
 */
export async function exitPhase(
  observer: ConvexSyncObserver,
  dialog: Locator,
  title: string,
  waitMs: number,
  uiStepMs: number,
  signal: AbortSignal,
): Promise<PhaseExit> {
  const startedAt = Date.now();
  await untilAborted(signal, dialogClosedAfterSuccess(dialog, waitMs));
  const remaining = Math.max(0, waitMs - (Date.now() - startedAt));
  const answered = await observer.waitUntilAnswered(title, remaining, signal);
  if (!answered) {
    return {
      kind: "BLOCKED",
      reason: `intent "${title}" still had an unanswered save in flight when its phase ended; no later dialog may open over it (D2)`,
    };
  }
  if (!(await dialog.isVisible())) {
    return observer.acceptedReplyDelivered(title)
      ? { kind: "CONFIRMED" }
      : { kind: "CLOSED_UNCONFIRMED" };
  }
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click({ timeout: uiStepMs });
  const dismissed = await untilAborted(signal, dialogClosedAfterSuccess(dialog, uiStepMs));
  return dismissed
    ? { kind: "CANCELLED" }
    : { kind: "BLOCKED", reason: `intent "${title}": the dialog could not be dismissed (D2)` };
}

export async function fillNewExpense(
  dialog: Locator,
  intent: { title: string; amount: number },
): Promise<void> {
  // Date / category / status / payment method keep their valid defaults
  // (today / OTHER / PAID / CASH): a PAID expense is the money-moving path.
  await dialog.getByLabel("Title / Description").fill(intent.title);
  await dialog.getByLabel(/^Amount \(/).fill(String(intent.amount));
}

/** Waits for the dialog to close, which the client does ONLY after success. */
export async function dialogClosedAfterSuccess(dialog: Locator, timeout: number): Promise<boolean> {
  try {
    await dialog.waitFor({ state: "hidden", timeout });
    return true;
  } catch {
    return false;
  }
}

// ─── DUPLICATE_SUBMIT ────────────────────────────────────────────────────────

export interface IntentReport {
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

export async function settleIntent(
  client: ConvexHttpClient,
  orgId: string,
  observer: ConvexSyncObserver,
  intent: { title: string; amount: number; uiConfirmed: boolean },
  settleMs: number,
): Promise<IntentReport> {
  const snapshot = await readSettledExpenseEffectSnapshot(
    client,
    { orgId, title: intent.title, refs: EXPENSE_AUTHORITY_REFS },
    { settleMs },
  );
  const observed = observer.mutationsFor(intent.title);
  const identities = observed.map((mutation) => mutation.idempotencyKey);
  // SCRUM-826 R1: an intent that was never transmitted has no identity to
  // judge. That is not an error — it must not abort the settlement of the
  // other intents (and with it, their proof); the exercise classification
  // below reports it unjudged.
  const identity: CommandIdentityVerdict =
    identities.length === 0
      ? { passed: true, violations: [], key: null }
      : evaluateCommandIdentityLifetime(identities);
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

/**
 * MULTI_TAB_RACE amounts. They must be pairwise distinct: if a tab's intended
 * amount equals the setup amount, a dropped write by that tab is
 * indistinguishable from its success, and the oracle would PASS a lost update.
 */
export const MULTI_TAB_RACE_AMOUNTS = { setup: 50, A: 60, B: 80 } as const;

/** Timeouts of the DUPLICATE_SUBMIT phases; injectable so tests run the real handler quickly. */
export interface DuplicateSubmitTimeouts {
  uiStepMs: number;
  lostResponseRecoveryMs: number;
  /** Interval between authority reads while waiting for settled state. */
  settleMs: number;
}

/** Production settle interval; matches readSettledExpenseEffectSnapshot's default. */
export const SETTLE_INTERVAL_MS = 1_500;

export interface MultiTabRaceTimeouts {
  /** How long each tab's save may take to be answered. */
  uiStepMs: number;
  /** How long the race barrier waits for the second tab's save frame. */
  barrierMs: number;
  /** Interval between authority reads while waiting for settled state. */
  settleMs: number;
}

export interface EconomicAttackOptions {
  duplicateSubmitTimeouts?: Partial<DuplicateSubmitTimeouts>;
  multiTabRaceTimeouts?: Partial<MultiTabRaceTimeouts>;
}

type ConflictObservation = { accepted: true } | { accepted: false; message: string };

/** What phase C (the server-side replay) observed, as data for the verdict. */
type ServerReplayObservation =
  | { kind: "NOT_RUN" }
  | { kind: "NO_RAPID_FRAME" }
  | { kind: "SESSION_LAPSED" }
  | {
      kind: "RAN";
      replay: { accepted: true; result: string } | { accepted: false; message: string };
      conflict: ConflictObservation | null;
    };

interface DuplicateSubmitObservation {
  intents: readonly { title: string }[];
  rapidTitle: string;
  lostTitle: string;
  reports: ReadonlyMap<string, IntentReport>;
  /** Client-visible replies per intent, judged (lapses excluded from proof, P2). */
  replyVerdicts: ReadonlyMap<string, IntentRepliesVerdict>;
  /** Intents whose dialog opened as a fresh closed-to-open transition (D1). */
  fresh: ReadonlySet<string>;
  lostInjected: boolean;
  lostAttempts: number;
  /**
   * Phase B's recovery window ran to its end: exitPhase returned, so the
   * retry either arrived and was answered or the full wait elapsed (DS-1/N1).
   * False when the phase was aborted or failed before that.
   */
  lostWindowClosed: boolean;
  /** The page was heard on a newer connection after the fault (DS-1). */
  lostReconnected: boolean;
  /**
   * Command identities transmitted per intent, read from the wire. Identity
   * is witnessed on the frames, so it is judged from them and never depends
   * on a backend read succeeding (Codex DS-2).
   */
  transmittedKeys: ReadonlyMap<string, readonly (string | undefined)[]>;
  serverReplay: ServerReplayObservation;
}

function lapseReason(title: string, lapses: number): string {
  return `intent "${title}" received ${lapses} reply(ies) refused for a lapsed session; the harness lost authentication (SCRUM-826 P2)`;
}

/**
 * SCRUM-826 D3 — the ONE verdict composition for DUPLICATE_SUBMIT. The normal
 * conclusion and the interrupted (catch) path both call it with whatever was
 * observed, so a proof can never depend on which path concluded or on the
 * order in which phases failed (F1, R1/ORD-R). Pure: it reads only the
 * observation it is given.
 */
function composeDuplicateSubmitVerdict(observation: DuplicateSubmitObservation): {
  proofs: string[];
  unjudged: string[];
} {
  const proofs: string[] = [];
  const unjudged: string[] = [];
  for (const { title } of observation.intents) {
    const replies = observation.replyVerdicts.get(title);
    // A client-visible refusal is proof whenever it was seen.
    if (replies) proofs.push(...replies.violations);
    const report = observation.reports.get(title);
    if (report) {
      proofs.push(...report.proven);
      if (report.inconclusive) unjudged.push(report.inconclusive);
    } else {
      unjudged.push(`intent "${title}" was not settled against the backend`);
      // The report carries the lapse itself when it exists (R6).
      if (replies && replies.authenticationLapses > 0) {
        unjudged.push(lapseReason(title, replies.authenticationLapses));
      }
      // The report also carries the identity verdict when it exists. Without
      // one, the transmitted identities are still witnessed on the wire, so a
      // failed backend read cannot hide an identity breach (Codex DS-2).
      const keys = observation.transmittedKeys.get(title) ?? [];
      if (keys.length > 0) {
        proofs.push(
          ...evaluateCommandIdentityLifetime(keys).violations.map((violation) => `${title}: ${violation}`),
        );
      }
    }
  }

  // Retry after the lost response. A missing retry is the absence of an
  // event, so it is proof only once a retry opportunity was positively
  // observed: the recovery window ran to its end AND the page was back on a
  // connection the server answered (Codex DS-1, Opus N1). Transmitted
  // attempts alone decide it, whatever happened to any other intent (R1/ORD-R).
  if (observation.lostInjected) {
    if (observation.lostAttempts < 2) {
      if (!observation.lostWindowClosed) {
        unjudged.push(
          `${observation.lostTitle}: the retry window after the lost response was interrupted before it elapsed; a missing retry cannot be judged`,
        );
      } else if (!observation.lostReconnected) {
        unjudged.push(
          `${observation.lostTitle}: after the lost response the client never heard from the server again; it had no observed opportunity to retry`,
        );
      } else {
        proofs.push(
          `${observation.lostTitle}: the client did not retry the command after the lost response (${observation.lostAttempts} attempt)`,
        );
      }
    }
  } else {
    unjudged.push("the lost-response fault was never injected; the retry path was not exercised");
  }

  const serverReplay = observation.serverReplay;
  switch (serverReplay.kind) {
    case "NOT_RUN":
      unjudged.push("the exact server replay was not run");
      break;
    case "NO_RAPID_FRAME":
      unjudged.push("no transmitted create command was observed for the rapid intent");
      break;
    case "SESSION_LAPSED":
      unjudged.push("the exact server replay was refused for a lapsed harness session (SCRUM-826 P2)");
      break;
    case "RAN": {
      const { replay, conflict } = serverReplay;
      if (!replay.accepted) {
        proofs.push("the backend refused an exact replay of the transmitted command: " + replay.message);
      } else {
        const original = observation.reports.get(observation.rapidTitle)?.effect ?? null;
        if (original === null) {
          unjudged.push(
            "the exact replay's result could not be compared: the rapid intent has no settled record",
          );
        } else if (replay.result !== String(original.expenseId)) {
          proofs.push(
            `replaying the transmitted command returned ${replay.result} instead of the original expense ${String(original.expenseId)}`,
          );
        }
      }
      if (conflict === null) {
        unjudged.push("the conflicting replay was not run");
      } else if (conflict.accepted) {
        proofs.push("a conflicting replay under an existing command identity was accepted");
      } else if (!FINGERPRINT_CONFLICT.test(conflict.message)) {
        unjudged.push("the conflicting replay was refused for an unrelated reason: " + conflict.message);
      }
      break;
    }
  }

  // Distinct intents must never share a command identity. Only intents that
  // ran in their own fresh dialog are distinct by construction (D1), and only
  // transmitted identities can collide. Read from the wire, not from reports
  // (Codex DS-2).
  const keys = observation.intents
    .filter(({ title }) => observation.fresh.has(title))
    .map(({ title }) => {
      const transmitted = observation.transmittedKeys.get(title) ?? [];
      return transmitted.length > 0 ? evaluateCommandIdentityLifetime(transmitted).key : null;
    })
    .filter((key): key is string => typeof key === "string");
  if (new Set(keys).size !== keys.length) {
    proofs.push("distinct user intents shared a command identity: " + keys.join(", "));
  }
  return { proofs, unjudged };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runDuplicateSubmitAttack(
  runtimeApi: MissionBrowserRuntime,
  context: BrowserMissionExecutionContext,
  timeouts: DuplicateSubmitTimeouts,
): Promise<BrowserMissionEvidence> {
  const { signal } = context;
  const startedAt = new Date().toISOString();
  const runtime = await runtimeApi.open(context);
  let cleanupStarted = false;
  let concluding = false;
  const observer = new ConvexSyncObserver(CREATE_EXPENSE_UDF);
  const nonce = attackNonce(context);
  let resolvedOrgId: string | null = null;
  const rapid = { title: nonce + "-rapid", amount: 41 };
  const lost = { title: nonce + "-lost", amount: 43 };
  const control = { title: nonce + "-control", amount: 47 };
  const intents = [rapid, lost, control] as const;

  // ── Observation state. The verdict is composed from it, never accumulated.
  /** Why a phase could not be judged (blocked UI, refused dialog, unreadable intent). */
  const phaseUnjudged: string[] = [];
  const reports = new Map<string, IntentReport>();
  const confirmed = new Map<string, boolean>();
  const fresh = new Set<string>();
  let uiBlocked: string | null = null;
  let serverReplay: ServerReplayObservation = { kind: "NOT_RUN" };
  /** Phase B's recovery window ran to its end (DS-1/N1). */
  let lostWindowClosed = false;
  /** The first settlement failure that is not an oracle-inconclusive one. */
  let settlementFailure: unknown = null;

  const decide = (): LedgerDecision => {
    const replyVerdicts = new Map(
      intents.map((intent) => [
        intent.title,
        evaluateIntentReplies(intent.title, observer.repliesFor(intent.title)),
      ]),
    );
    const verdict = composeDuplicateSubmitVerdict({
      intents,
      rapidTitle: rapid.title,
      lostTitle: lost.title,
      reports,
      replyVerdicts,
      fresh,
      lostInjected: observer.withheld.some((entry) => entry.title === lost.title),
      lostAttempts: observer.mutationsFor(lost.title).length,
      lostWindowClosed,
      lostReconnected: observer.reconnectedAfterLostResponse(lost.title),
      transmittedKeys: new Map(
        intents.map((intent) => [
          intent.title,
          observer.mutationsFor(intent.title).map((mutation) => mutation.idempotencyKey),
        ]),
      ),
      serverReplay,
    });
    const ledger = new VerdictLedger();
    ledger.prove(...verdict.proofs);
    for (const reason of [...phaseUnjudged, ...verdict.unjudged]) ledger.unjudgeable(reason);
    return ledger.decide();
  };

  /** Settles every intent not yet settled. An unreadable intent is unjudged, never thrown. */
  const settleAll = async (client: ConvexHttpClient, orgId: string): Promise<void> => {
    for (const intent of intents) {
      if (reports.has(intent.title)) continue;
      signal.throwIfAborted();
      try {
        reports.set(
          intent.title,
          await untilAborted(
            signal,
            settleIntent(
              client,
              orgId,
              observer,
              { ...intent, uiConfirmed: confirmed.get(intent.title) ?? false },
              timeouts.settleMs,
            ),
          ),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        phaseUnjudged.push(`intent "${intent.title}" could not be settled: ${errorText(error)}`);
        if (!(error instanceof BrowserSwarmOracleInconclusiveError) && settlementFailure === null) {
          settlementFailure = error;
        }
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
    const backendEvidence = {
      attack: "DUPLICATE_SUBMIT",
      orgId: resolvedOrgId,
      nonce,
      ...detail,
      lostResponse: observer.withheld,
      replies: observer.responses,
      violations,
    };
    let backendArtifact: string;
    try {
      backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, backendEvidence);
    } catch (writeError) {
      // A pass is never certified without its evidence. A proven breach gets
      // one more attempt, so a transient write fault cannot demote it to a
      // harness error (SCRUM-826 C-3); if that also fails, the catch labels
      // the fallback evidence BREACH_UNDELIVERED and the run is not certified.
      if (passed) throw writeError;
      backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, backendEvidence);
    }
    cleanupStarted = true;
    let browserArtifacts: readonly string[] = [];
    let cleanupFailure: string | null = null;
    try {
      browserArtifacts = await runtimeApi.finish(runtime);
    } catch (finishError) {
      // Screenshot/trace/close failures cannot retract a breach whose backend
      // evidence is already durable (SCRUM-826 C-3). A pass still requires a
      // complete cleanup.
      if (passed) throw finishError;
      cleanupFailure = errorText(finishError);
    }
    const artifacts = [...browserArtifacts, backendArtifact];
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
          : "Duplicate-submit attack breached single economic effect: " +
            violations.join("; ") +
            (cleanupFailure === null
              ? ""
              : " (browser evidence cleanup also failed: " + cleanupFailure + ")"),
      },
      artifacts,
    };
  };

  const replayDetail = (): Record<string, unknown> => ({
    serverReplay: serverReplay.kind,
    replay:
      serverReplay.kind === "RAN"
        ? {
            ...(serverReplay.replay.accepted
              ? { result: serverReplay.replay.result }
              : { refused: serverReplay.replay.message }),
            conflict: serverReplay.conflict,
          }
        : null,
  });

  try {
    const { page } = runtime;
    await observer.attach(page, "tab-1");

    const orgId = await untilAborted(signal, runtimeApi.resolveOrgRoute(page));
    if (!orgId) throw new Error("DUPLICATE_SUBMIT could not resolve the authenticated organization route.");
    resolvedOrgId = orgId;
    await untilAborted(signal, gotoExpenses(page, orgId, timeouts.uiStepMs));

    /**
     * One UI phase under the D1/D2 contract: it runs only while the UI is not
     * blocked, only in a fresh dialog, and it ends only through exitPhase. A
     * phase that cannot run, or cannot end cleanly, is unjudged and blocks
     * every later UI phase; it never produces proof by itself.
     */
    const runUiPhase = async (
      phase: string,
      intent: { title: string; amount: number },
      waitMs: number,
      act: (dialog: Locator) => Promise<void>,
    ): Promise<void> => {
      signal.throwIfAborted();
      if (uiBlocked !== null) {
        phaseUnjudged.push(`${phase} was not run: ${uiBlocked}`);
        return;
      }
      const opening = await untilAborted(
        signal,
        openFreshDialog(page, phase, timeouts.uiStepMs, signal),
      );
      if (opening.kind === "REFUSED") {
        uiBlocked = opening.reason;
        phaseUnjudged.push(opening.reason);
        return;
      }
      fresh.add(intent.title);
      await untilAborted(signal, fillNewExpense(opening.dialog, intent));
      await untilAborted(signal, act(opening.dialog));
      const exit = await exitPhase(
        observer,
        opening.dialog,
        intent.title,
        waitMs,
        timeouts.uiStepMs,
        signal,
      );
      confirmed.set(intent.title, exit.kind === "CONFIRMED");
      if (exit.kind === "BLOCKED") {
        uiBlocked = exit.reason;
        phaseUnjudged.push(exit.reason);
      }
    };

    // Phase A — impatient user: five submits of ONE intent in a single tick,
    // before React can re-render the disabled button (a double-click race).
    await runUiPhase("Phase A (rapid resubmits)", rapid, timeouts.uiStepMs, async (dialog) => {
      await dialog.locator("form").evaluate((form: HTMLFormElement) => {
        for (let attempt = 0; attempt < 5; attempt += 1) form.requestSubmit();
      });
    });

    // Phase B — lost response: the server commits, the response is withheld
    // and the connection dropped; the client reconnects and retries. The
    // fault is disarmed when the phase ends, fired or not (D1 P3).
    try {
      await runUiPhase(
        "Phase B (lost response)",
        lost,
        timeouts.lostResponseRecoveryMs,
        async (dialog) => {
          observer.armLostResponse(lost.title);
          await dialog
            .getByRole("button", { name: "Record Expense", exact: true })
            .click({ timeout: timeouts.uiStepMs });
        },
      );
      // Reached only when exitPhase returned: the retry was answered or the
      // full recovery window elapsed. An abort or failure skips it (DS-1/N1).
      lostWindowClosed = true;
    } finally {
      observer.disarmLostResponse();
    }

    // Phase C — server-side replay of the exact transmitted command, then a
    // conflicting replay under the same identity with a changed amount. It
    // needs no dialog, so it runs even when the UI is blocked.
    signal.throwIfAborted();
    const client = await untilAborted(signal, runtimeApi.authenticatedClient(page));
    const rapidFrame = observer.mutationsFor(rapid.title)[0];
    if (!rapidFrame) {
      serverReplay = { kind: "NO_RAPID_FRAME" };
    } else {
      const replayArgs = jsonToConvex(rapidFrame.args as JSONValue) as FunctionArgs<
        typeof api.expenses.create
      >;
      // An exact replay must return the original record. A backend refusal
      // is the product's verdict on replay semantics (SCRUM-826 R1); a lapse
      // of the harness session is unjudged (P2); a transport or unidentified
      // failure aborts as a harness error.
      let replay: { accepted: true; result: string } | { accepted: false; message: string } | null =
        null;
      try {
        replay = {
          accepted: true,
          result: String(
            await untilAborted(signal, client.mutation(api.expenses.create, replayArgs)),
          ),
        };
      } catch (error) {
        if (signal.aborted) throw error;
        if (isAuthenticationLapse(error)) {
          serverReplay = { kind: "SESSION_LAPSED" };
        } else if (classifyServerReplayFailure(error) === "BACKEND_REFUSED") {
          replay = { accepted: false, message: errorText(error) };
        } else {
          throw error;
        }
      }
      if (replay !== null) {
        serverReplay = { kind: "RAN", replay, conflict: null };
        let conflict: ConflictObservation;
        try {
          await untilAborted(
            signal,
            client.mutation(api.expenses.create, { ...replayArgs, amount: rapid.amount + 30 }),
          );
          conflict = { accepted: true };
        } catch (error) {
          if (signal.aborted) throw error;
          conflict = { accepted: false, message: errorText(error) };
        }
        serverReplay = { kind: "RAN", replay, conflict };
      }
    }

    // Phase D — control: a genuinely new intent from a fresh dialog must be a
    // new command identity and exactly one new record (retirement works).
    await runUiPhase("Phase D (fresh control intent)", control, timeouts.uiStepMs, async (dialog) => {
      await dialog
        .getByRole("button", { name: "Record Expense", exact: true })
        .click({ timeout: timeouts.uiStepMs });
    });

    signal.throwIfAborted();
    const authorityClient = await untilAborted(signal, runtimeApi.authenticatedClient(page));
    await settleAll(authorityClient, orgId);

    const decision = decide();
    const detail = { ...replayDetail(), reports: [...reports.values()] };
    if (decision.kind === "BREACH") {
      return await conclude(decision.violations, {
        ...detail,
        ...(decision.unjudged.length > 0 ? { phase: "PARTIAL", unjudged: decision.unjudged } : {}),
      });
    }
    if (decision.kind === "INCONCLUSIVE") {
      // Never a pass. A settlement that failed for a harness reason is
      // reported as that failure; otherwise the attack is inconclusive. The
      // catch below writes the evidence.
      if (settlementFailure !== null) throw settlementFailure;
      throw new BrowserSwarmOracleInconclusiveError(decision.reason);
    }
    return await conclude([], detail);
  } catch (error) {
    let undelivered: string[] | null = null;
    if (!cleanupStarted && !concluding) {
      // A failure interrupted the attack. Proof already observed is a product
      // verdict and must survive it (SCRUM-826 C-1/C-2/S1). Unless the mission
      // was aborted (D5: stop touching the preview), settle what was not yet
      // settled, best effort; then decide through the same composition.
      if (!signal.aborted && resolvedOrgId !== null) {
        try {
          const recoveryClient = await untilAborted(
            signal,
            runtimeApi.authenticatedClient(runtime.page),
          );
          await settleAll(recoveryClient, resolvedOrgId);
        } catch {
          // Decide from what was already observed.
        }
      }
      const decision = decide();
      if (decision.kind === "BREACH") {
        try {
          return await conclude(decision.violations, {
            phase: "INTERRUPTED",
            interruptedBy: errorText(error),
            unjudged: decision.unjudged,
            mutations: observer.mutations,
            ...replayDetail(),
            reports: [...reports.values()],
          });
        } catch (concludeError) {
          // Evidence or cleanup failed while concluding. The original failure
          // is reported, carrying that failure as its cause (L-A), and an
          // undelivered breach is labelled as one (L-B).
          if (error instanceof Error && error.cause === undefined) error.cause = concludeError;
          if (!cleanupStarted) undelivered = decision.violations;
        }
      }
    } else if (concluding && !cleanupStarted) {
      // The normal conclusion could not write its evidence. A decided breach
      // is still labelled as one in the fallback evidence (SCRUM-826 C-3).
      const decision = decide();
      if (decision.kind === "BREACH") undelivered = decision.violations;
    }
    if (!cleanupStarted) {
      // Every run that fails to conclude still leaves its backend evidence
      // behind, so an operator can tell a harness fault from a hidden product
      // refusal (SCRUM-826 O2/R-1). Browser cleanup runs FIRST so that its
      // failure is recorded in that evidence rather than dropped (D4/R4).
      // Best effort: the original error stays the result.
      cleanupStarted = true;
      let cleanupFailure: string | null = null;
      try {
        await runtimeApi.finish(runtime);
      } catch (finishError) {
        cleanupFailure = errorText(finishError);
        if (error instanceof Error && error.cause === undefined) error.cause = finishError;
      }
      const fallback = decide();
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
          unjudged: fallback.kind === "PASS" ? [] : fallback.unjudged,
          reason: errorText(error),
          cleanupFailure,
          orgId: resolvedOrgId,
          nonce,
          ...replayDetail(),
          reports: [...reports.values()],
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
  timeoutMs: number,
  signal: AbortSignal,
): Promise<
  TabOutcome & {
    requestId?: number;
    transmittedAmount?: unknown;
    sentSeq?: number | null;
    responseSeq?: number;
  }
> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
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
  timeouts: MultiTabRaceTimeouts,
): Promise<BrowserMissionEvidence> {
  const startedAt = new Date().toISOString();
  const { signal } = context;
  const runtime = await runtimeApi.open(context);
  let cleanupStarted = false;
  // Set once a breach is decided, so a conclusion that cannot write its
  // evidence still labels the fallback evidence as a breach (SCRUM-826 C-3).
  let decidedViolations: readonly string[] | null = null;
  let orgId: string | null = null;
  let nonce: string | null = null;
  let expenseId: string | null = null;

  try {
    const tabA = runtime.page;
    const observer = new ConvexSyncObserver(UPDATE_EXPENSE_UDF);
    await untilAborted(signal, observer.attach(tabA, "tab-a"));
    const tabB = await untilAborted(signal, runtime.browserContext.newPage());
    await untilAborted(signal, observer.attach(tabB, "tab-b"));

    const resolvedOrgId = await untilAborted(signal, runtimeApi.resolveOrgRoute(tabA));
    if (!resolvedOrgId) throw new Error("MULTI_TAB_RACE could not resolve the authenticated organization route.");
    orgId = resolvedOrgId;

    // Synthetic setup through the same authenticated, permission-checked
    // command the UI uses: one PENDING (not yet money-moving) expense.
    const runNonce = attackNonce(context);
    nonce = runNonce;
    const title = runNonce + "-race";
    const setupAmount = MULTI_TAB_RACE_AMOUNTS.setup;
    const today = new Date();
    const date = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const setupClient = await untilAborted(signal, runtimeApi.authenticatedClient(tabA));
    // An aborted mission stops touching the preview (D5): the setup write is
    // never started once the mission has been aborted.
    signal.throwIfAborted();
    const createdId = String(
      await untilAborted(
        signal,
        setupClient.mutation(api.expenses.create, {
          idempotencyKey: "swarm-setup:" + runNonce,
          orgId: resolvedOrgId as Id<"organizations">,
          title,
          amount: setupAmount,
          date,
          category: "OTHER",
          status: "PENDING",
        }),
      ),
    );
    expenseId = createdId;

    const dialogA = await untilAborted(signal, openEditDialog(tabA, resolvedOrgId, title, createdId));
    const dialogB = await untilAborted(signal, openEditDialog(tabB, resolvedOrgId, title, createdId));
    const intended = { A: MULTI_TAB_RACE_AMOUNTS.A, B: MULTI_TAB_RACE_AMOUNTS.B } as const;
    await untilAborted(signal, setPaidWithAmount(tabA, dialogA, intended.A));
    await untilAborted(signal, setPaidWithAmount(tabB, dialogB, intended.B));

    // Both tabs pay the same expense with different amounts. The barrier
    // holds whichever save reaches the socket first until the other has been
    // sent too, so both are in flight before either can be answered.
    signal.throwIfAborted();
    observer.armRaceBarrier(title, ["tab-a", "tab-b"]);
    await untilAborted(
      signal,
      Promise.all([
        dialogA.getByRole("button", { name: "Save Changes", exact: true }).click(),
        dialogB.getByRole("button", { name: "Save Changes", exact: true }).click(),
      ]),
    );
    const barrierDeadline = Date.now() + timeouts.barrierMs;
    while (!observer.raceBarrierSatisfied && Date.now() < barrierDeadline) {
      signal.throwIfAborted();
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
      awaitUpdateOutcome(observer, "tab-a", title, 0, timeouts.uiStepMs, signal),
      awaitUpdateOutcome(observer, "tab-b", title, 0, timeouts.uiStepMs, signal),
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
      signal.throwIfAborted();
      await untilAborted(
        signal,
        loser.dialog.getByRole("button", { name: "Save Changes", exact: true }).click(),
      );
      staleRetry = await awaitUpdateOutcome(observer, loser.page, title, before, timeouts.uiStepMs, signal);
    }

    const authorityClient = await untilAborted(signal, runtimeApi.authenticatedClient(tabA));
    signal.throwIfAborted();
    const snapshot = await untilAborted(
      signal,
      readSettledExpenseEffectSnapshot(
        authorityClient,
        { orgId: resolvedOrgId, title, refs: EXPENSE_AUTHORITY_REFS },
        { settleMs: timeouts.settleMs },
      ),
    );
    const authoritative = snapshot.expenses.find((row) => row.id === createdId);
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

    // The verdict is decided. From here on a proven breach is a product
    // verdict that no evidence or cleanup fault may retract (SCRUM-826 C-3).
    const passed = violations.length === 0;
    const backendEvidence: Record<string, unknown> = {
      attack: "MULTI_TAB_RACE",
      orgId: resolvedOrgId,
      nonce: runNonce,
      expenseId: createdId,
      setup: { amount: setupAmount, status: "PENDING" },
      tabs: { A: outcomeA, B: outcomeB },
      staleRetry,
      snapshot,
      race,
      effect,
      violations,
    };
    if (!passed) decidedViolations = violations;
    let backendArtifact: string;
    try {
      backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, backendEvidence);
    } catch (writeError) {
      // A pass is never certified without its evidence. A proven breach gets
      // one more attempt; if that also fails, the catch labels the fallback
      // evidence BREACH_UNDELIVERED and the run is not certified.
      if (passed) throw writeError;
      backendArtifact = await runtimeApi.writeBackendEvidence(runtime.paths, backendEvidence);
    }
    cleanupStarted = true;
    let browserArtifacts: readonly string[] = [];
    let cleanupFailure: string | null = null;
    try {
      browserArtifacts = await runtimeApi.finish(runtime);
    } catch (finishError) {
      // Screenshot/trace/close failures cannot retract a breach whose backend
      // evidence is already durable. A pass still requires a complete cleanup.
      if (passed) throw finishError;
      cleanupFailure = errorText(finishError);
    }

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
          : "Concurrent-tab race breached single economic effect: " +
            violations.join("; ") +
            (cleanupFailure === null
              ? ""
              : " (browser evidence cleanup also failed: " + cleanupFailure + ")"),
      },
      artifacts: [...browserArtifacts, backendArtifact],
    };
  } catch (error) {
    if (decidedViolations !== null && !cleanupStarted) {
      // A decided breach whose evidence could not be written: clean up, then
      // leave fallback evidence labelled as an undelivered breach, best
      // effort. The original error stays the result, so the run is reported
      // as a harness fault and never certified.
      cleanupStarted = true;
      let cleanupFailure: string | null = null;
      try {
        await runtimeApi.finish(runtime);
      } catch (finishError) {
        cleanupFailure = errorText(finishError);
        if (error instanceof Error && error.cause === undefined) error.cause = finishError;
      }
      try {
        await runtimeApi.writeBackendEvidence(runtime.paths, {
          attack: "MULTI_TAB_RACE",
          outcome: "BREACH_UNDELIVERED",
          violations: decidedViolations,
          reason: errorText(error),
          cleanupFailure,
          orgId,
          nonce,
          expenseId,
        });
      } catch {
        // The original error is reported regardless.
      }
    }
    return runtimeApi.rethrowAfterCleanup(runtime, error, cleanupStarted);
  }
}

export function createEconomicAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  options: EconomicAttackOptions = {},
): { DUPLICATE_SUBMIT: BrowserMissionHandler; MULTI_TAB_RACE: BrowserMissionHandler } {
  const duplicateSubmitTimeouts: DuplicateSubmitTimeouts = {
    uiStepMs: options.duplicateSubmitTimeouts?.uiStepMs ?? UI_STEP_TIMEOUT_MS,
    lostResponseRecoveryMs:
      options.duplicateSubmitTimeouts?.lostResponseRecoveryMs ?? LOST_RESPONSE_RECOVERY_TIMEOUT_MS,
    settleMs: options.duplicateSubmitTimeouts?.settleMs ?? SETTLE_INTERVAL_MS,
  };
  const multiTabRaceTimeouts: MultiTabRaceTimeouts = {
    uiStepMs: options.multiTabRaceTimeouts?.uiStepMs ?? UI_STEP_TIMEOUT_MS,
    barrierMs: options.multiTabRaceTimeouts?.barrierMs ?? RACE_BARRIER_TIMEOUT_MS,
    settleMs: options.multiTabRaceTimeouts?.settleMs ?? SETTLE_INTERVAL_MS,
  };
  return {
    DUPLICATE_SUBMIT: (context) =>
      runDuplicateSubmitAttack(runtimeApi, context, duplicateSubmitTimeouts),
    MULTI_TAB_RACE: (context) => runMultiTabRaceAttack(runtimeApi, context, multiTabRaceTimeouts),
  };
}
