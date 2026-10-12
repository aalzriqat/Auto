import type { Page, WebSocketRoute } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import {
  createEconomicAttackHandlers,
  type MissionBrowser,
  type MissionBrowserRuntime,
} from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";

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
}

interface ExpenseRecord {
  _id: string;
  title: string;
  amount: number;
  status: string;
}

class FakeBackend {
  readonly expenses: ExpenseRecord[] = [];
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
  requestIds: Set<number>;
  confirmed: boolean;
}

/** The web client: one expense dialog at a time, one sync socket, reconnect + resend. */
class FakeApp {
  private routeHandler: ((socket: WebSocketRoute) => void) | null = null;
  private fromPage: ((frame: string) => void) | null = null;
  private fromServer: ((frame: string) => void) | null = null;
  private readonly pending = new Map<number, string>();
  private nextRequestId = 0;
  private nextKey = 0;
  private dialog: Dialog | null = null;
  private lapsedOnce = false;

  constructor(private readonly backend: FakeBackend) {}

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
        const silent = this.backend.faults.silentSuffix;
        if (silent && String(args.title).endsWith(silent)) return;
        const title = String(args.title);
        const duplicateFirst = this.backend.faults.duplicateSuffix;
        if (
          duplicateFirst &&
          title.endsWith(duplicateFirst) &&
          !this.backend.expenses.some((row) => row.title === title)
        ) {
          this.backend.create({ ...args, idempotencyKey: "extra-" + parsed.requestId }, "socket");
        }
        const lapseFirst = this.backend.faults.lapseFirstSuffix;
        if (lapseFirst && title.endsWith(lapseFirst) && !this.lapsedOnce) {
          this.lapsedOnce = true;
          const firstRefusal = JSON.stringify({
            type: "MutationResponse",
            requestId: parsed.requestId,
            success: false,
            result: "Server Error",
            errorData: { code: "UNAUTHENTICATED", message: "Not authenticated" },
          });
          if (!closed) this.fromServer?.(firstRefusal);
          return;
        }
        const lapse = this.backend.faults.lapseSuffix;
        const lapseDuplicate = this.backend.faults.lapseDuplicateSuffix;
        const duplicate = Boolean(lapseDuplicate && String(args.title).endsWith(lapseDuplicate));
        if (duplicate) {
          this.backend.create({ ...args, idempotencyKey: "dup-a" }, "socket");
          this.backend.create({ ...args, idempotencyKey: "dup-b" }, "socket");
        }
        const lapseCommit = this.backend.faults.lapseCommitSuffix;
        const committedThenLapsed = Boolean(
          lapseCommit && String(args.title).endsWith(lapseCommit),
        );
        if (committedThenLapsed) this.backend.create(args, "socket");
        if (
          duplicate ||
          committedThenLapsed ||
          (lapse && String(args.title).endsWith(lapse))
        ) {
          const refusal = JSON.stringify({
            type: "MutationResponse",
            requestId: parsed.requestId,
            success: false,
            result: "Server Error",
            errorData: { code: "UNAUTHENTICATED", message: "Not authenticated" },
          });
          if (!closed) this.fromServer?.(refusal);
          return;
        }
        const outcome = this.backend.create(args, "socket");
        const reply = JSON.stringify({
          type: "MutationResponse",
          requestId: parsed.requestId,
          success: outcome.ok,
          result: outcome.ok ? outcome.id : outcome.message,
        });
        if (!closed) this.fromServer?.(reply);
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
        // The client reconnects and resends every unanswered mutation.
        setTimeout(() => {
          this.connect();
          for (const frame of this.pending.values()) this.fromPage?.(frame);
        }, 0);
      },
    } as unknown as WebSocketRoute;
    this.routeHandler(route);
  }

  private deliverToPage(frame: string): void {
    const parsed = JSON.parse(frame) as { type: string; requestId: number; success: boolean };
    if (parsed.type !== "MutationResponse") return;
    this.pending.delete(parsed.requestId);
    if (parsed.success && this.dialog?.requestIds.has(parsed.requestId)) {
      this.dialog.confirmed = true;
    }
  }

  openDialog(): void {
    this.nextKey += 1;
    this.dialog = {
      title: "",
      amount: 0,
      key: "key-" + this.nextKey,
      requestIds: new Set(),
      confirmed: false,
    };
  }

  fill(label: string, value: string): void {
    if (!this.dialog) throw new Error("no dialog open");
    if (label === "title") this.dialog.title = value;
    if (label === "amount") this.dialog.amount = Number(value);
  }

  submit(): void {
    const dialog = this.dialog;
    if (!dialog) throw new Error("no dialog open");
    this.nextRequestId += 1;
    const requestId = this.nextRequestId;
    dialog.requestIds.add(requestId);
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
          idempotencyKey: dialog.key,
        },
      ],
    });
    this.pending.set(requestId, frame);
    this.fromPage?.(frame);
  }

  async dialogHidden(): Promise<void> {
    for (let tick = 0; tick < 20; tick += 1) {
      if (this.dialog?.confirmed) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("Timeout: the dialog stayed open");
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

  async waitFor(options?: { state?: string }): Promise<void> {
    if (this.path === "dialog" && options?.state === "hidden") await this.app.dialogHidden();
  }

  async click(): Promise<void> {
    if (this.path === "page>button:Record Expense") this.app.openDialog();
    else if (this.path === "dialog>button:Record Expense") this.app.submit();
    else throw new Error("unexpected click " + this.path);
  }

  async fill(value: string): Promise<void> {
    this.app.fill(this.path.endsWith("label:title") ? "title" : "amount", value);
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
    query: async (ref: FunctionReference<"query">, args: Record<string, unknown>) =>
      backend.query(getFunctionName(ref), args),
  } as unknown as ConvexHttpClient;
}

interface Harness {
  run(): Promise<Awaited<ReturnType<ReturnType<typeof createEconomicAttackHandlers>["DUPLICATE_SUBMIT"]>>>;
  evidence: Record<string, unknown>[];
  backend: FakeBackend;
}

function harness(faults: Faults = {}): Harness {
  const backend = new FakeBackend(faults);
  const app = new FakeApp(backend);
  const evidence: Record<string, unknown>[] = [];
  let evidenceFailed = false;
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
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async () => "org1",
    authenticatedClient: async () => fakeClient(backend),
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family: "DUPLICATE_SUBMIT" },
    signal: new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createEconomicAttackHandlers(runtimeApi).DUPLICATE_SUBMIT;
  return { run: () => handler(context), evidence, backend };
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

  it("L-A: a cleanup failure after an interrupted breach is reported, not lost", async () => {
    const h = harness({ volatileSuffix: "-rapid", httpTransportFailure: true, finishFails: true });
    const thrown = await h.run().then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).cause)).toMatch(/cleanup failed/);
    expect(h.evidence[0].phase).toBe("INTERRUPTED");
  }, 30_000);

  it("L-B: an undelivered interrupted breach is labelled as a breach in the fallback evidence", async () => {
    const h = harness({ volatileSuffix: "-rapid", httpTransportFailure: true, evidenceFailsOnce: true });
    await expect(h.run()).rejects.toBeDefined();
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("BREACH_UNDELIVERED");
    expect(JSON.stringify(h.evidence[0].violations)).toMatch(/-rapid: attempt \d+ was refused/);
  }, 30_000);

  it("C-2: an earlier intent's proven double posting survives a later unexercised intent", async () => {
    const h = harness({ doublePostSuffix: "-rapid", silentSuffix: "-control" });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/-rapid: expected exactly 1 economic posting/);
    expect(h.evidence).toHaveLength(1);
  }, 30_000);
});
