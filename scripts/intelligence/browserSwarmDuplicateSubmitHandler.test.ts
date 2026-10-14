import type { Page, WebSocketRoute } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import {
  createEconomicAttackHandlers,
  openFreshDialog,
  type MissionBrowser,
  type MissionBrowserRuntime,
} from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import { CreateExpenseSchema } from "../../convex/validations/expenses";

/**
 * SCRUM-826 O1/O2/R-1 — handler-level tests for DUPLICATE_SUBMIT.
 *
 * The real handler runs end to end against a scripted fake: a Playwright page
 * whose expense dialog transmits real Convex sync frames through the real
 * ConvexSyncObserver, a fake backend that implements same-key replay and
 * fingerprint refusal, and an authenticated client that reads that backend
 * through the real authority reader. Faults are injected into the backend so
 * each wiring decision in the handler (reply judgement, Phase B refusal,
 * settle classification, server-replay refusal, evidence on every exit) is
 * pinned by a verdict that changes when the wiring is removed.
 */

const FINGERPRINT = "Idempotency key reused with different request content";

/** Intent faults match the run-unique title by its suffix: "-rapid", "-lost", "-control". */
interface Faults {
  /** Every create of this intent is refused by the backend (a product refusal). */
  refuseSuffix?: string;
  /** The backend never answers a create of this intent (a harness-side stall). */
  silentSuffix?: string;
  /** Socket retries of this intent are refused as fingerprint conflicts (volatile input). */
  volatileSuffix?: string;
  /** A server-side exact replay is refused by the backend. */
  refuseHttpReplay?: boolean;
  /** A server-side replay fails in transport (no backend verdict). */
  httpTransportFailure?: boolean;
  /** A server-side replay is refused because the harness session lapsed (P2). */
  httpSessionLapse?: boolean;
  /** Socket creates of this intent are refused because the browser session lapsed (P2). */
  lapseSuffix?: string;
  /**
   * A socket create of this intent commits TWO records (a duplicate effect)
   * and the client sees a lapsed-session refusal (Opus P2-S ordering case).
   */
  lapseDuplicateSuffix?: string;
  /** A socket create of this intent commits once, but the client sees a lapsed-session refusal (C-2). */
  lapseCommitSuffix?: string;
  /** Every expense of this intent carries two POSTED economic events (a double posting). */
  doublePostSuffix?: string;
  /** The first socket create of this intent commits an extra record (a duplicate effect, Opus S1). */
  duplicateSuffix?: string;
  /** Only the first socket attempt of this intent is refused for a lapsed session (Opus S1). */
  lapseFirstSuffix?: string;
  /** A server-side conflicting replay (same key, changed amount) is accepted (Opus S2). */
  acceptConflict?: boolean;
  /** Browser cleanup fails after the verdict (Opus L-A). */
  finishFails?: boolean;
  /** The first backend evidence write fails (Opus L-B). */
  evidenceFailsOnce?: boolean;
  /** The first N backend evidence writes fail (Codex C-3). */
  evidenceFailures?: number;
  /**
   * A browser-session lapse covering the next N socket attempts, opening at
   * the first "-lost" attempt (Opus F1: it spans the lost save and the
   * control's first click).
   */
  sessionLapseFromLost?: number;
  /** After the connection drops, the client does not resend this intent (Opus ORD). */
  noResendSuffix?: string;
  /** The client never transmits this intent's save (Opus ORD-R). */
  noTransmitSuffix?: string;
  /** The backend answers this intent's saves only after `ms` (design D2). */
  delayReply?: { suffix: string; ms: number };
  /** A reopened dialog keeps the previous dialog's values instead of resetting (design D1 P2). */
  staleForm?: boolean;
  /** Every submit of this intent mints a new command identity (a per-click key, Codex DS-2). */
  keyPerSubmitSuffix?: string;
  /** The authority read of this intent's economic events fails (Codex DS-2). */
  authorityFails?: RegExp;
  /** After the drop, the client's new connection never hears from the server (Codex DS-1). */
  reconnectSilent?: boolean;
  /** After the drop, the client reconnects and resends only after this delay (Opus N1). */
  resendDelayMs?: number;
  /** Every backend authority read fails: the preview read path is down (E7/DS-2). */
  authorityDown?: boolean;
  /** The client never retires its command identity: every dialog reuses one key (E7). */
  sharedKey?: boolean;
}

interface ExpenseRecord {
  _id: string;
  title: string;
  amount: number;
  status: string;
}

class FakeBackend {
  readonly expenses: ExpenseRecord[] = [];
  /** Authority reads served, so a test can prove an aborted mission stopped reading (D5). */
  queryCount = 0;
  private readonly keys = new Map<string, { fingerprint: string; id: string }>();

  constructor(readonly faults: Faults) {}

  create(
    args: Record<string, unknown>,
    via: "socket" | "http",
  ): { ok: true; id: string } | { ok: false; message: string } {
    const title = String(args.title);
    const amount = Number(args.amount);
    const key = String(args.idempotencyKey);
    if (this.faults.refuseSuffix && title.endsWith(this.faults.refuseSuffix)) {
      return { ok: false, message: "Expense recording is not allowed for this account." };
    }
    // The real backend validator: a synthetic title it rejects is a refusal.
    if (!CreateExpenseSchema.shape.title.safeParse(title).success) {
      return { ok: false, message: "Title is too long" };
    }
    const fingerprint = title + "|" + amount;
    const existing = this.keys.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        if (via === "http" && this.faults.acceptConflict) {
          const conflictId = "exp" + (this.expenses.length + 1);
          this.expenses.push({ _id: conflictId, title, amount, status: String(args.status ?? "PAID") });
          return { ok: true, id: conflictId };
        }
        return { ok: false, message: FINGERPRINT };
      }
      if (via === "http" && this.faults.refuseHttpReplay) return { ok: false, message: FINGERPRINT };
      if (
        via === "socket" &&
        this.faults.volatileSuffix &&
        title.endsWith(this.faults.volatileSuffix)
      ) {
        return { ok: false, message: FINGERPRINT };
      }
      return { ok: true, id: existing.id };
    }
    const id = "exp" + (this.expenses.length + 1);
    this.expenses.push({ _id: id, title, amount, status: String(args.status ?? "PAID") });
    this.keys.set(key, { fingerprint, id });
    return { ok: true, id };
  }

  query(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "expenses:list":
        return { page: this.expenses, isDone: true, continueCursor: "" };
      case "accountingLedger:listAccountingEvents": {
        const id = String(args.sourceId);
        const event = {
          _id: "ev-" + id,
          eventType: "EXPENSE_POSTED",
          status: "POSTED",
          idempotencyKey: "expense_posted_" + id,
          journalEntryId: "je-" + id,
        };
        const title = this.expenses.find((row) => row._id === id)?.title ?? "";
        if (this.faults.authorityFails?.test(title)) {
          throw new Error("authority read failed: listAccountingEvents returned 500");
        }
        const doublePost = this.faults.doublePostSuffix;
        return doublePost && title.endsWith(doublePost)
          ? [event, { ...event, _id: "ev2-" + id }]
          : [event];
      }
      case "accountingOutbox:listPending":
        return [];
      case "accountingLedger:getJournalEntry": {
        const id = String(args.journalEntryId).replace(/^je-/, "");
        const expense = this.expenses.find((row) => row._id === id);
        const minor = Math.round((expense?.amount ?? 0) * 1000);
        return {
          lines: [
            { debitMinor: minor, creditMinor: 0, scale: 3, currency: "JOD" },
            { debitMinor: 0, creditMinor: minor, scale: 3, currency: "JOD" },
          ],
        };
      }
      default:
        throw new Error("unexpected query " + name);
    }
  }
}

interface Dialog {
  title: string;
  amount: number;
  key: string;
}

/**
 * The web client, modal-faithful (SCRUM-826 D6), mirroring ExpenseDialog:
 * - one dialog at a time; it stays open until a save succeeds or Cancel;
 * - while it is open, Radix hides the page trigger, so the page's
 *   "Record Expense" button resolves to the dialog's own submit button;
 * - the submit button is not actionable while a save is in flight
 *   ("Saving…"); Cancel always is;
 * - ANY successful reply closes whatever dialog is open (onOpenChange(false));
 * - closing retires the command identity; reopening resets the form to
 *   title "" and amount 0 (unless the staleForm fault is set);
 * - one sync socket, replies arrive asynchronously; after a drop the client
 *   reconnects and resends every unanswered mutation.
 * `log` records UI actions so every test can assert the handler's modal
 * discipline: it never clicks the page trigger over an open dialog and never
 * cancels a dialog while a save is in flight.
 */
class FakeApp {
  readonly log: string[] = [];
  private routeHandler: ((socket: WebSocketRoute) => void) | null = null;
  private fromPage: ((frame: string) => void) | null = null;
  private fromServer: ((frame: string) => void) | null = null;
  private readonly pending = new Map<number, string>();
  private nextRequestId = 0;
  private nextKey = 0;
  private dialog: Dialog | null = null;
  private lastValues = { title: "", amount: 0 };
  private lapsedOnce = false;
  private lapseRemaining = -1;
  private connections = 0;

  constructor(private readonly backend: FakeBackend) {}

  get dialogOpen(): boolean {
    return this.dialog !== null;
  }

  async routeWebSocket(_matcher: unknown, handler: (socket: WebSocketRoute) => void): Promise<void> {
    this.routeHandler = handler;
    this.connect();
  }

  private connect(): void {
    if (!this.routeHandler) return;
    let closed = false;
    const server = {
      send: (frame: string) => {
        const parsed = JSON.parse(frame) as { type: string; requestId: number; args: unknown[] };
        if (parsed.type !== "Mutation") return;
        const args = parsed.args[0] as Record<string, unknown>;
        const title = String(args.title);
        const faults = this.backend.faults;
        const deliver = (reply: Record<string, unknown>): void => {
          const delay = faults.delayReply && title.endsWith(faults.delayReply.suffix) ? faults.delayReply.ms : 0;
          setTimeout(() => {
            if (!closed) this.fromServer?.(JSON.stringify({ type: "MutationResponse", requestId: parsed.requestId, ...reply }));
          }, delay);
        };
        const lapsed = {
          success: false,
          result: "Server Error",
          errorData: { code: "UNAUTHENTICATED", message: "Not authenticated" },
        };
        if (faults.silentSuffix && title.endsWith(faults.silentSuffix)) return;
        if (faults.sessionLapseFromLost !== undefined && this.lapseRemaining < 0 && title.endsWith("-lost")) {
          this.lapseRemaining = faults.sessionLapseFromLost;
        }
        if (this.lapseRemaining > 0) {
          this.lapseRemaining -= 1;
          deliver(lapsed);
          return;
        }
        const duplicateFirst = faults.duplicateSuffix;
        if (
          duplicateFirst &&
          title.endsWith(duplicateFirst) &&
          !this.backend.expenses.some((row) => row.title === title)
        ) {
          this.backend.create({ ...args, idempotencyKey: "extra-" + parsed.requestId }, "socket");
        }
        if (faults.lapseFirstSuffix && title.endsWith(faults.lapseFirstSuffix) && !this.lapsedOnce) {
          this.lapsedOnce = true;
          deliver(lapsed);
          return;
        }
        const duplicate = Boolean(faults.lapseDuplicateSuffix && title.endsWith(faults.lapseDuplicateSuffix));
        if (duplicate) {
          this.backend.create({ ...args, idempotencyKey: "dup-a" }, "socket");
          this.backend.create({ ...args, idempotencyKey: "dup-b" }, "socket");
        }
        const committedThenLapsed = Boolean(faults.lapseCommitSuffix && title.endsWith(faults.lapseCommitSuffix));
        if (committedThenLapsed) this.backend.create(args, "socket");
        if (duplicate || committedThenLapsed || (faults.lapseSuffix && title.endsWith(faults.lapseSuffix))) {
          deliver(lapsed);
          return;
        }
        const outcome = this.backend.create(args, "socket");
        deliver({ success: outcome.ok, result: outcome.ok ? outcome.id : outcome.message });
      },
      onMessage: (handler: (frame: string) => void) => {
        this.fromServer = handler;
      },
      close: async () => undefined,
    };
    const route = {
      connectToServer: () => server,
      onMessage: (handler: (frame: string) => void) => {
        this.fromPage = handler;
      },
      send: (frame: string) => this.deliverToPage(frame),
      close: async () => {
        if (closed) return;
        closed = true;
        // The client reconnects and resends every unanswered mutation (after
        // resendDelayMs, a correct but slow client — Opus N1).
        setTimeout(() => {
          this.connect();
          for (const frame of this.pending.values()) {
            const skip = this.backend.faults.noResendSuffix;
            const title = String((JSON.parse(frame) as { args: { title: string }[] }).args[0].title);
            if (skip && title.endsWith(skip)) continue;
            this.fromPage?.(frame);
          }
        }, this.backend.faults.resendDelayMs ?? 0);
      },
    } as unknown as WebSocketRoute;
    this.routeHandler(route);
    // A healthy connection hears from the server (a query Transition) right
    // after it opens; a silent reconnect never does (DS-1).
    this.connections += 1;
    if (!(this.backend.faults.reconnectSilent && this.connections > 1)) {
      setTimeout(() => {
        if (!closed) this.fromServer?.(JSON.stringify({ type: "Transition", startVersion: {}, endVersion: {}, modifications: [] }));
      }, 0);
    }
  }

  private deliverToPage(frame: string): void {
    const parsed = JSON.parse(frame) as { type: string; requestId: number; success: boolean };
    if (parsed.type !== "MutationResponse") return;
    this.pending.delete(parsed.requestId);
    // The dialog component awaits its save and then closes itself — whichever
    // dialog happens to be open by then.
    if (parsed.success) this.closeDialog();
  }

  private closeDialog(): void {
    if (!this.dialog) return;
    this.lastValues = { title: this.dialog.title, amount: this.dialog.amount };
    this.dialog = null;
  }

  clickTrigger(): void {
    if (this.dialog) {
      // The trigger is aria-hidden; the locator resolves to the dialog's submit.
      this.log.push("trigger-on-open-dialog");
      this.clickSubmit();
      return;
    }
    this.nextKey += 1;
    const values = this.backend.faults.staleForm ? this.lastValues : { title: "", amount: 0 };
    this.dialog = { ...values, key: this.backend.faults.sharedKey ? "key-shared" : "key-" + this.nextKey };
    this.log.push("open");
  }

  clickSubmit(): void {
    if (!this.dialog) throw new Error("Timeout: no Record Expense button in an open dialog");
    if (this.pending.size > 0) {
      throw new Error("Timeout: the Record Expense button is not actionable while a save is in flight");
    }
    this.submit();
  }

  cancel(): void {
    if (!this.dialog) throw new Error("Timeout: no Cancel button in an open dialog");
    this.log.push(this.pending.size > 0 ? "cancel-in-flight" : "cancel");
    this.closeDialog();
  }

  fill(label: string, value: string): void {
    if (!this.dialog) throw new Error("no dialog open");
    if (label === "title") this.dialog.title = value;
    if (label === "amount") this.dialog.amount = Number(value);
  }

  inputValue(label: string): string {
    if (!this.dialog) throw new Error("no dialog open");
    return label === "title" ? this.dialog.title : String(this.dialog.amount);
  }

  submit(): void {
    const dialog = this.dialog;
    if (!dialog) throw new Error("no dialog open");
    this.nextRequestId += 1;
    const requestId = this.nextRequestId;
    const frame = JSON.stringify({
      type: "Mutation",
      requestId,
      udfPath: "expenses:create",
      args: [
        {
          orgId: "org1",
          title: dialog.title,
          amount: dialog.amount,
          status: "PAID",
          idempotencyKey:
            this.backend.faults.keyPerSubmitSuffix && dialog.title.endsWith(this.backend.faults.keyPerSubmitSuffix)
              ? dialog.key + "-" + requestId
              : dialog.key,
        },
      ],
    });
    const noTransmit = this.backend.faults.noTransmitSuffix;
    if (noTransmit && dialog.title.endsWith(noTransmit)) return;
    this.pending.set(requestId, frame);
    this.fromPage?.(frame);
  }

  async waitHidden(timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (this.dialog) {
      if (Date.now() >= deadline) throw new Error("Timeout: the dialog stayed open");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

class FakeLocator {
  constructor(
    private readonly app: FakeApp,
    private readonly path: string,
  ) {}

  getByRole(role: string, options?: { name?: string | RegExp }): FakeLocator {
    return new FakeLocator(this.app, `${this.path}>${role}:${String(options?.name ?? "")}`);
  }

  getByLabel(label: string | RegExp): FakeLocator {
    const field = label === "Title / Description" ? "title" : "amount";
    return new FakeLocator(this.app, `${this.path}>label:${field}`);
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.app, `${this.path}>${selector}`);
  }

  async waitFor(options?: { state?: string; timeout?: number }): Promise<void> {
    if (this.path === "dialog" && options?.state === "hidden") {
      await this.app.waitHidden(options.timeout ?? 30_000);
      return;
    }
    if (this.path === "dialog>heading:Record Expense" && !this.app.dialogOpen) {
      throw new Error("Timeout: the dialog heading never appeared");
    }
  }

  async isVisible(): Promise<boolean> {
    return this.path === "dialog" ? this.app.dialogOpen : true;
  }

  async click(): Promise<void> {
    if (this.path === "page>button:Record Expense") this.app.clickTrigger();
    else if (this.path === "dialog>button:Record Expense") this.app.clickSubmit();
    else if (this.path === "dialog>button:Cancel") this.app.cancel();
    else throw new Error("unexpected click " + this.path);
  }

  async fill(value: string): Promise<void> {
    this.app.fill(this.path.endsWith("label:title") ? "title" : "amount", value);
  }

  async inputValue(): Promise<string> {
    return this.app.inputValue(this.path.endsWith("label:title") ? "title" : "amount");
  }

  async evaluate(fn: (form: { requestSubmit(): void }) => void): Promise<void> {
    fn({ requestSubmit: () => this.app.submit() });
  }
}

function fakePage(app: FakeApp): Page {
  const root = new FakeLocator(app, "page");
  return {
    routeWebSocket: (matcher: unknown, handler: (socket: WebSocketRoute) => void) =>
      app.routeWebSocket(matcher, handler),
    goto: async () => null,
    getByRole: (role: string, options?: { name?: string }) =>
      role === "dialog" ? new FakeLocator(app, "dialog") : root.getByRole(role, options),
  } as unknown as Page;
}

function fakeClient(backend: FakeBackend): ConvexHttpClient {
  return {
    mutation: async (ref: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      if (getFunctionName(ref) !== "expenses:create") throw new Error("unexpected mutation");
      if (backend.faults.httpTransportFailure) throw new TypeError("fetch failed");
      if (backend.faults.httpSessionLapse) {
        throw new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
      }
      const outcome = backend.create(args, "http");
      if (!outcome.ok) throw new ConvexError(outcome.message);
      return outcome.id;
    },
    query: async (ref: FunctionReference<"query">, args: Record<string, unknown>) => {
      backend.queryCount += 1;
      if (backend.faults.authorityDown) throw new Error("authority read failed: preview read path unavailable");
      return backend.query(getFunctionName(ref), args);
    },
  } as unknown as ConvexHttpClient;
}

interface Harness {
  run(): Promise<Awaited<ReturnType<ReturnType<typeof createEconomicAttackHandlers>["DUPLICATE_SUBMIT"]>>>;
  evidence: Record<string, unknown>[];
  backend: FakeBackend;
  app: FakeApp;
}

interface HarnessOptions {
  /** Phase timeouts; small by default so a blocked phase costs milliseconds. */
  uiStepMs?: number;
  lostResponseRecoveryMs?: number;
  signal?: AbortSignal;
  /** Manifest run id and worker id; the defaults are short. */
  runId?: string;
  workerId?: string;
}

/** Every harness built by a test, checked for modal discipline after it (D1/D2). */
const built: Harness[] = [];

afterEach(() => {
  for (const h of built.splice(0)) {
    // Never click the page trigger over an open dialog (D1 P1), never
    // cancel a dialog whose save is still in flight (D2).
    expect(h.app.log).not.toContain("trigger-on-open-dialog");
    expect(h.app.log).not.toContain("cancel-in-flight");
  }
});

function harness(faults: Faults = {}, options: HarnessOptions = {}): Harness {
  const backend = new FakeBackend(faults);
  const app = new FakeApp(backend);
  const evidence: Record<string, unknown>[] = [];
  let evidenceFailed = false;
  let evidenceWriteFailures = 0;
  const runtime: MissionBrowser = {
    browser: {} as MissionBrowser["browser"],
    browserContext: {} as MissionBrowser["browserContext"],
    page: fakePage(app),
    paths: { root: "r", trace: "t", screenshot: "s", backendState: "backend-state.json" },
  };
  const runtimeApi: MissionBrowserRuntime = {
    open: async () => runtime,
    finish: async () => {
      if (faults.finishFails) {
        throw new AggregateError([new Error("trace stop failed")], "cleanup failed");
      }
      return ["trace.zip"];
    },
    rethrowAfterCleanup: async (_runtime, error) => {
      throw error;
    },
    writeBackendEvidence: async (paths, value) => {
      if (faults.evidenceFailsOnce && !evidenceFailed) {
        evidenceFailed = true;
        throw new Error("disk full");
      }
      if (evidenceWriteFailures < (faults.evidenceFailures ?? 0)) {
        evidenceWriteFailures += 1;
        throw new Error("disk full");
      }
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async () => "org1",
    authenticatedClient: async () => fakeClient(backend),
  };
  const context = {
    manifest: { runId: options.runId ?? "run-1" },
    worker: { workerId: options.workerId ?? "worker-1" },
    mission: { id: "mission-1", family: "DUPLICATE_SUBMIT" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createEconomicAttackHandlers(runtimeApi, {
    duplicateSubmitTimeouts: {
      uiStepMs: options.uiStepMs ?? 200,
      lostResponseRecoveryMs: options.lostResponseRecoveryMs ?? 400,
      // The fake backend is static once a phase ends; settle fast.
      settleMs: 25,
    },
  }).DUPLICATE_SUBMIT;
  const entry: Harness = { run: () => handler(context), evidence, backend, app };
  built.push(entry);
  return entry;
}

describe("SCRUM-826 DUPLICATE_SUBMIT handler", () => {
  it("passes a correct product and writes backend evidence (control)", async () => {
    const h = harness();
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(true);
    expect(h.backend.expenses).toHaveLength(3);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].violations).toEqual([]);
  }, 30_000);

  // SCRUM-826 D1 (Codex, 758c64586): every synthetic title must be valid
  // backend input, or its refusal is a false product breach. The manifest
  // accepts run ids of up to 81 characters; the expense title cap is 100.
  for (const runId of ["r".repeat(39), "a" + "b.c_d-".repeat(13) + "ee"]) {
    it(`D1: a valid ${runId.length}-character run id still yields backend-valid titles`, async () => {
      expect(runId).toMatch(/^[a-z0-9][a-z0-9._-]{0,80}$/);
      const h = harness({}, { runId, workerId: "worker-12" });
      const evidence = await h.run();
      expect(evidence.oracle.passed).toBe(true);
      expect(h.backend.expenses).toHaveLength(3);
      for (const expense of h.backend.expenses) {
        expect(CreateExpenseSchema.shape.title.safeParse(expense.title).success).toBe(true);
      }
    }, 30_000);
  }

  it("O1: a fingerprint refusal of a same-intent rapid retry is a breach", async () => {
    const h = harness({ volatileSuffix: "-rapid" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused with a fingerprint conflict/);
  }, 30_000);

  it("O2: a backend refusal of the lost intent is a breach, not a harness error", async () => {
    const h = harness({ refuseSuffix: "-lost" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-lost: attempt \d+ was refused/);
    expect(h.evidence).toHaveLength(1);
    // Ledger redesign: the attack continues past the un-injected fault, so
    // the verdict is a PARTIAL breach carrying the unjudged retry path.
    expect(h.evidence[0].phase).toBe("PARTIAL");
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/never injected/);
  }, 30_000);

  it("O2: a backend refusal of the fresh control intent is a breach, not 'never exercised'", async () => {
    const h = harness({ refuseSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-control: attempt \d+ was refused/);
  }, 30_000);

  it("R-1: a backend refusal of the exact server replay is a breach with evidence", async () => {
    const h = harness({ refuseHttpReplay: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/refused an exact replay of the transmitted command/);
    expect(h.evidence).toHaveLength(1);
    expect((h.evidence[0].replay as { refused?: string }).refused).toMatch(
      /Idempotency key reused with different request content/,
    );
  }, 30_000);

  it("a transport failure on the server replay stays a harness error, with evidence", async () => {
    const h = harness({ httpTransportFailure: true });
    await expect(h.run()).rejects.toThrow(/fetch failed/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("HARNESS_ERROR");
  }, 30_000);

  it("a lost intent the backend never answered stays inconclusive, with evidence", async () => {
    const h = harness({ silentSuffix: "-lost" });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("C-1: a rapid-retry refusal survives a later unanswered lost intent as a breach", async () => {
    const h = harness({ volatileSuffix: "-rapid", silentSuffix: "-lost" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused with a fingerprint conflict/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].phase).toBe("PARTIAL");
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/never injected/);
  }, 30_000);

  it("C-1: a rapid-retry refusal survives a later harness failure (transport) as a breach", async () => {
    const h = harness({ volatileSuffix: "-rapid", httpTransportFailure: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused with a fingerprint conflict/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].phase).toBe("INTERRUPTED");
    expect(String(h.evidence[0].interruptedBy)).toMatch(/fetch failed/);
  }, 30_000);

  it("C-1: a rapid-retry refusal survives a later unanswered control intent as a breach", async () => {
    const h = harness({ volatileSuffix: "-rapid", silentSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused with a fingerprint conflict/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].phase).toBe("PARTIAL");
  }, 30_000);

  it("C-1: an exact-replay refusal survives a later unanswered control intent as a breach", async () => {
    const h = harness({ refuseHttpReplay: true, silentSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/refused an exact replay of the transmitted command/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].phase).toBe("PARTIAL");
  }, 30_000);

  it("P2: a lapsed harness session on the server replay is inconclusive, never a breach", async () => {
    const h = harness({ httpSessionLapse: true });
    await expect(h.run()).rejects.toThrow(/lapsed harness session/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("P2: a lapsed browser session on the lost intent is inconclusive, never a breach", async () => {
    const h = harness({ lapseSuffix: "-lost" });
    await expect(h.run()).rejects.toThrow(/harness lost authentication/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("P2: a lapsed browser session on the control intent is inconclusive, never a breach", async () => {
    const h = harness({ lapseSuffix: "-control" });
    await expect(h.run()).rejects.toThrow(/harness lost authentication/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("P2-S: a duplicate economic effect stays a breach even when a session lapse also occurred", async () => {
    const h = harness({ lapseDuplicateSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-control: /);
    expect(h.backend.expenses.filter((row) => row.title.endsWith("-control"))).toHaveLength(2);
    expect(h.evidence).toHaveLength(1);
  }, 30_000);

  it("C-2: a double posting stays a breach when the unconfirmed intent's reply lapsed", async () => {
    const h = harness({ lapseCommitSuffix: "-control", doublePostSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-control: expected exactly 1 economic posting/);
    expect(h.evidence).toHaveLength(1);
  }, 30_000);

  it("C-2 control: a committed intent whose reply lapsed, with a clean effect, stays inconclusive", async () => {
    const h = harness({ lapseCommitSuffix: "-control" });
    await expect(h.run()).rejects.toThrow(/harness lost authentication/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("S1 controls: a duplicate effect alone is a breach; one lapsed attempt alone is not", async () => {
    for (const suffix of ["-rapid", "-lost"]) {
      const h = harness({ duplicateSuffix: suffix });
      const evidence = await h.run();
      expect(evidence.oracle.passed).toBe(false);
      expect(evidence.oracle.summary).toContain(`${suffix}: expected exactly 1 expense record`);
    }
    const lapsed = harness({ lapseFirstSuffix: "-rapid" });
    const outcome = await lapsed.run().then(
      (evidence) => (evidence.oracle.passed ? "PASS" : "BREACH"),
      () => "THROWN",
    );
    expect(outcome).not.toBe("BREACH");
  }, 60_000);

  const intents = ["-rapid", "-lost", "-control"] as const;
  const disruptions = [
    { name: "lapse", faults: (suffix: string): Faults => ({ lapseSuffix: suffix }) },
    { name: "unanswered", faults: (suffix: string): Faults => ({ silentSuffix: suffix }) },
  ];
  for (const disruption of disruptions) {
    for (const disrupted of intents) {
      for (const duplicated of intents) {
        if (disrupted === duplicated) continue;
        // An unanswered save blocks every LATER UI phase (D2), so a later
        // intent is never exercised and cannot carry a duplicate; that
        // ordering is pinned separately below.
        if (
          disruption.name === "unanswered" &&
          intents.indexOf(disrupted) < intents.indexOf(duplicated)
        ) {
          continue;
        }
        it(`S1: a duplicate on ${duplicated} stays a breach whatever the ${disruption.name} on ${disrupted}`, async () => {
          const h = harness({ ...disruption.faults(disrupted), duplicateSuffix: duplicated });
          const evidence = await h.run();
          expect(evidence.oracle.passed).toBe(false);
          expect(evidence.oracle.summary).toContain(`${duplicated}: expected exactly 1 expense record`);
          expect(h.evidence).toHaveLength(1);
        }, 30_000);
      }
    }
  }

  it("S1 (R-B): one lapsed rapid attempt does not mask a lost-intent duplicate", async () => {
    const h = harness({ lapseFirstSuffix: "-rapid", duplicateSuffix: "-lost" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toContain("-lost: expected exactly 1 expense record");
  }, 30_000);

  it("S2: an accepted conflicting replay survives a later unanswered control intent", async () => {
    const alone = await harness({ acceptConflict: true }).run();
    expect(alone.oracle.passed).toBe(false);
    const h = harness({ acceptConflict: true, silentSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(
      /conflicting replay under an existing command identity was accepted/,
    );
  }, 60_000);

  it("S1: a duplicate effect is still found when a harness failure aborts before settlement", async () => {
    const h = harness({ duplicateSuffix: "-rapid", httpTransportFailure: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toContain("-rapid: expected exactly 1 expense record");
    expect(h.evidence[0].phase).toBe("INTERRUPTED");
  }, 30_000);

  it("L-A/C-3: a browser cleanup failure after an interrupted breach keeps the breach and reports the cleanup", async () => {
    const h = harness({ volatileSuffix: "-rapid", httpTransportFailure: true, finishFails: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused/);
    expect(evidence.oracle.summary).toMatch(/cleanup failed/);
    expect(evidence.artifacts).toEqual(["backend-state.json"]);
    expect(h.evidence[0].phase).toBe("INTERRUPTED");
  }, 30_000);

  it("L-A: when no breach evidence can be written, the original failure carries the evidence failure as its cause", async () => {
    const h = harness({ volatileSuffix: "-rapid", httpTransportFailure: true, evidenceFailures: 2 });
    const thrown = await h.run().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).cause)).toMatch(/disk full/);
  }, 30_000);

  it("L-B: an undelivered interrupted breach is labelled as a breach in the fallback evidence", async () => {
    const h = harness({ volatileSuffix: "-rapid", httpTransportFailure: true, evidenceFailures: 2 });
    await expect(h.run()).rejects.toBeDefined();
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("BREACH_UNDELIVERED");
    expect(JSON.stringify(h.evidence[0].violations)).toMatch(/-rapid: attempt \d+ was refused/);
  }, 30_000);

  it("C-3: a browser cleanup failure after a normally concluded breach keeps CONFIRMED_BREACH", async () => {
    const h = harness({ volatileSuffix: "-rapid", finishFails: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused/);
    expect(evidence.oracle.summary).toMatch(/cleanup failed/);
    expect(evidence.artifacts).toEqual(["backend-state.json"]);
    expect(h.evidence).toHaveLength(1);
    expect(JSON.stringify(h.evidence[0].violations)).toMatch(/-rapid: attempt \d+ was refused/);
  }, 30_000);

  it("C-3: one failed evidence write after a normally concluded breach keeps CONFIRMED_BREACH", async () => {
    const h = harness({ volatileSuffix: "-rapid", evidenceFailures: 1 });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused/);
    expect(h.evidence).toHaveLength(1);
    expect(JSON.stringify(h.evidence[0].violations)).toMatch(/-rapid: attempt \d+ was refused/);
  }, 30_000);

  it("C-3: a normally concluded breach whose evidence cannot be written is labelled BREACH_UNDELIVERED, never certified", async () => {
    const h = harness({ volatileSuffix: "-rapid", evidenceFailures: 2 });
    await expect(h.run()).rejects.toBeDefined();
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("BREACH_UNDELIVERED");
    expect(JSON.stringify(h.evidence[0].violations)).toMatch(/-rapid: attempt \d+ was refused/);
  }, 30_000);

  it("C-3 control: a clean run whose browser cleanup fails is not certified as a pass", async () => {
    const h = harness({ finishFails: true });
    await expect(h.run()).rejects.toThrow(/cleanup failed/);
  }, 30_000);

  it("C-2: an earlier intent's proven double posting survives a later unexercised intent", async () => {
    const h = harness({ doublePostSuffix: "-rapid", silentSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: expected exactly 1 economic posting/);
    expect(h.evidence).toHaveLength(1);
  }, 30_000);
});

/**
 * SCRUM-826 circuit-breaker redesign (Jira c22983 + c22984): explicit phase
 * preconditions (D1), the exit protocol (D2), one verdict composition (D3),
 * the conclusion contract (D4) and bounded, abortable recovery (D5), all on
 * the modal-faithful fake (D6). Each case reproduces a reviewer finding.
 */
describe("SCRUM-826 DUPLICATE_SUBMIT phase state machine", () => {
  it("F1-R: a session lapse over the lost save and the control's first click is never a shared-identity breach", async () => {
    const h = harness({ sessionLapseFromLost: 2 });
    const outcome = await h.run().then(
      (evidence) => (evidence.oracle.passed ? "PASS" : "BREACH: " + evidence.oracle.summary),
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(String((outcome as Error).message)).toMatch(/harness lost authentication/);
    // The control ran in its own fresh dialog under its own identity.
    expect(h.app.log.filter((entry) => entry === "open")).toHaveLength(3);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("F1-N: a product refusal of the lost save is still a breach on the modal UI", async () => {
    const h = harness({ refuseSuffix: "-lost" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-lost: attempt \d+ was refused/);
    expect(evidence.oracle.summary).not.toMatch(/shared a command identity/);
  }, 30_000);

  it("ORD: a client that never retries after the lost response is a breach", async () => {
    const h = harness({ noResendSuffix: "-lost" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/did not retry the command after the lost response/);
  }, 30_000);

  it("ORD-R: the retry proof survives a control intent that was never transmitted", async () => {
    const h = harness({ noResendSuffix: "-lost", noTransmitSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/did not retry the command after the lost response/);
  }, 30_000);

  it("R1: an intent that was never transmitted is unjudged, and every other intent is still settled", async () => {
    const h = harness({ noTransmitSuffix: "-control" });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
    expect(h.evidence[0].reports as unknown[]).toHaveLength(3);
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/-control\W+ was never confirmed/);
  }, 30_000);

  it("D2: a lost save still in flight at its deadline blocks the control phase; nothing is cancelled under it", async () => {
    const h = harness({ delayReply: { suffix: "-lost", ms: 1_500 } }, { lostResponseRecoveryMs: 300 });
    const thrown = await h.run().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(String((thrown as Error).message)).toMatch(/unanswered save in flight/);
    // The control intent was never opened, filled or transmitted.
    expect(h.app.log.filter((entry) => entry === "open")).toHaveLength(2);
    expect(h.backend.expenses.some((row) => row.title.endsWith("-control"))).toBe(false);
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/Phase D \(fresh control intent\) was not run/);
  }, 30_000);

  it("D2: an unanswered rapid save blocks the later UI phases instead of overlapping them", async () => {
    const h = harness({ silentSuffix: "-rapid", duplicateSuffix: "-lost" });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.app.log.filter((entry) => entry === "open")).toHaveLength(1);
    expect(h.backend.expenses.some((row) => row.title.endsWith("-lost"))).toBe(false);
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/Phase B \(lost response\) was not run/);
  }, 30_000);

  it("D1 P2: a dialog that reopens with a stale form is never reused for a new intent", async () => {
    const h = harness({ staleForm: true });
    await expect(h.run()).rejects.toThrow(/did not open with a fresh form/);
    expect(h.backend.expenses.some((row) => row.title.endsWith("-lost"))).toBe(false);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
  }, 30_000);

  it("D1 P2 control: a fresh form on every phase passes", async () => {
    const h = harness();
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(true);
    expect(h.app.log).toEqual(["open", "open", "open"]);
  }, 30_000);

  it("D5: an aborted mission stops at once and reads nothing more from the preview", async () => {
    const controller = new AbortController();
    const h = harness({ silentSuffix: "-lost" }, { lostResponseRecoveryMs: 20_000, signal: controller.signal });
    const startedAt = Date.now();
    const running = h.run().then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const readsAtAbort = h.backend.queryCount;
    controller.abort(new Error("mission timeout"));
    const thrown = await running;
    expect(String((thrown as Error).message)).toMatch(/mission timeout/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(h.backend.queryCount).toBe(readsAtAbort);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("HARNESS_ERROR");
  }, 30_000);

  it("D5: a breach already proven when the mission is aborted is still concluded", async () => {
    const controller = new AbortController();
    const h = harness(
      { volatileSuffix: "-rapid", silentSuffix: "-lost" },
      { lostResponseRecoveryMs: 20_000, signal: controller.signal },
    );
    const running = h.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort(new Error("mission timeout"));
    const evidence = await running;
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: attempt \d+ was refused with a fingerprint conflict/);
    expect(evidence.artifacts.length).toBeGreaterThan(0);
  }, 30_000);

  // Codex DS-1: "the client did not retry" is a breach only after a retry
  // opportunity was positively observed: the recovery window ran to its end
  // AND the client was back on a connection the server answered.
  it("DS-1: an abort inside the lost-response recovery window is never a no-retry breach", async () => {
    const controller = new AbortController();
    const h = harness({ noResendSuffix: "-lost" }, { lostResponseRecoveryMs: 20_000, signal: controller.signal });
    const running = h.run().then(
      (evidence) => evidence,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 5_000;
    while (h.backend.expenses.filter((row) => row.title.endsWith("-lost")).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("mission timeout"));
    const settled = await running;
    expect(settled).toBeInstanceOf(Error);
    expect(String((settled as Error).message)).toMatch(/mission timeout/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).not.toBe("BREACH");
    expect(JSON.stringify(h.evidence[0].violations ?? [])).not.toMatch(/did not retry/);
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/retry window .*interrupted/);
  }, 30_000);

  it("N1: a correct client whose retry is still pending at the abort is never a no-retry breach", async () => {
    const controller = new AbortController();
    const h = harness({ resendDelayMs: 1_500 }, { lostResponseRecoveryMs: 10_000, signal: controller.signal });
    const running = h.run().then(
      (evidence) => evidence,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 5_000;
    while (h.backend.expenses.filter((row) => row.title.endsWith("-lost")).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort(new Error("mission timeout"));
    const settled = await running;
    expect(settled).toBeInstanceOf(Error);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("HARNESS_ERROR");
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/retry window .*interrupted/);
  }, 30_000);

  it("N1 control: the same slow but correct client passes when the window is allowed to elapse", async () => {
    const h = harness({ resendDelayMs: 1_500 }, { lostResponseRecoveryMs: 10_000 });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(true);
    expect(h.backend.expenses.filter((row) => row.title.endsWith("-lost"))).toHaveLength(1);
  }, 30_000);

  it("DS-1: a reconnect the server never answered is unjudged, not a no-retry breach", async () => {
    const h = harness({ noResendSuffix: "-lost", reconnectSilent: true });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("INCONCLUSIVE");
    expect(JSON.stringify(h.evidence[0].unjudged)).toMatch(/never heard from the server again/);
  }, 30_000);

  it("DS-1 control: a healthy reconnect with no resend over the full window is still a breach", async () => {
    const h = harness({ noResendSuffix: "-lost" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-lost: the client did not retry the command after the lost response/);
  }, 30_000);

  // Codex DS-2: a transmitted identity breach is witnessed on the wire; a
  // failed backend read cannot un-witness it.
  it("DS-2: an identity breach survives a failed authority read of the same intent", async () => {
    const h = harness({ keyPerSubmitSuffix: "-rapid", authorityFails: /-rapid$/ });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: one intent was transmitted under \d+ distinct command identities/);
    expect(evidence.artifacts.length).toBeGreaterThan(0);
  }, 30_000);

  it("E7: distinct intents transmitted under one shared identity are a breach (control)", async () => {
    const h = harness({ sharedKey: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/distinct user intents shared a command identity/);
  }, 30_000);

  it("E7/DS-2: a shared identity is still proven when every backend read fails", async () => {
    const h = harness({ sharedKey: true, authorityDown: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/distinct user intents shared a command identity/);
  }, 30_000);

  it("DS-2 control: the same failed read with one stable identity stays a harness error, never a pass", async () => {
    const h = harness({ authorityFails: /-rapid$/ });
    await expect(h.run()).rejects.toThrow(/authority read failed/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).not.toBe("PASS");
    expect(h.evidence[0].outcome).not.toBe("BREACH");
  }, 30_000);

  it("D1 P1: a phase never opens over a dialog that is still open", async () => {
    const backend = new FakeBackend({});
    const app = new FakeApp(backend);
    app.clickTrigger();
    app.fill("title", "previous intent");
    const opening = await openFreshDialog(fakePage(app), "Phase D", 200, new AbortController().signal);
    expect(opening.kind).toBe("REFUSED");
    expect(opening.kind === "REFUSED" ? opening.reason : "").toMatch(/a dialog was still open/);
    // Nothing was clicked: the open dialog was neither resubmitted nor reused.
    expect(app.log).toEqual(["open"]);
  });

  it("D4/R4: a browser cleanup failure is recorded in the fallback evidence of an unconcluded run", async () => {
    const h = harness({ httpTransportFailure: true, finishFails: true });
    const thrown = await h.run().then(
      () => null,
      (error: unknown) => error,
    );
    expect(String((thrown as Error).message)).toMatch(/fetch failed/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("HARNESS_ERROR");
    expect(String(h.evidence[0].cleanupFailure)).toMatch(/cleanup failed/);
  }, 30_000);
});
