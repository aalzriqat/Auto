import type { Page, WebSocketRoute } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserOracleKind } from "./browserAttackSwarm";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { createNetworkRecoveryHandler } from "./browserSwarmNetworkRecoveryAttack";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-350 — handler-level tests for NETWORK_RECOVERY.
 *
 * The real handler runs end to end through the real ConvexSyncObserver against
 * a scripted web client: a Playwright page whose expense dialog transmits real
 * Convex sync frames, a client that reconnects with a delay and resends every
 * unanswered mutation, and a fake backend with same-key replay. Faults are
 * injected into the client or the backend so each judgement in the handler
 * (single effect, state consistency, unjudged outage, refused control) is
 * pinned by a verdict that changes when the wiring is removed.
 */

interface Faults {
  /** After the outage the client never resends the lost save. */
  noResend?: boolean;
  /** The client resends under a fresh command identity (a per-attempt key). */
  resendNewKey?: boolean;
  /** The backend answers the resent save with success but stores nothing. */
  dropRetry?: boolean;
  /** The dialog closes as "saved" when the connection drops, without any reply. */
  closeOnDrop?: boolean;
  /** The backend refuses saves whose title ends with this suffix. */
  refuseSuffix?: string;
  /** The page never transmits the outage intent through the observed socket. */
  noTransmitSuffix?: string;
  /** The page's sync socket was opened before routing was attached, so the route never sees it. */
  socketBypassesRoute?: boolean;
  /** After the connection drops the client never opens another. */
  neverReconnects?: boolean;
}

interface ExpenseRecord {
  _id: string;
  title: string;
  amount: number;
  status: string;
}

class FakeBackend {
  readonly expenses: ExpenseRecord[] = [];
  private readonly keys = new Map<string, string>();

  constructor(readonly faults: Faults) {}

  create(args: Record<string, unknown>, retried: boolean): { ok: true; id: string } | { ok: false; message: string } {
    const title = String(args.title);
    if (this.faults.refuseSuffix && title.endsWith(this.faults.refuseSuffix)) {
      return { ok: false, message: "Expense recording is not allowed for this account." };
    }
    const key = String(args.idempotencyKey);
    const existing = this.keys.get(key);
    if (existing) return { ok: true, id: existing };
    const id = "exp" + (this.expenses.length + 1);
    if (retried && this.faults.dropRetry) return { ok: true, id };
    this.expenses.push({ _id: id, title, amount: Number(args.amount), status: String(args.status ?? "PAID") });
    this.keys.set(key, id);
    return { ok: true, id };
  }

  query(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "expenses:list":
        return { page: this.expenses, isDone: true, continueCursor: "" };
      case "accountingLedger:listAccountingEvents": {
        const id = String(args.sourceId);
        return [
          {
            _id: "ev-" + id,
            eventType: "EXPENSE_POSTED",
            status: "POSTED",
            idempotencyKey: "expense_posted_" + id,
            journalEntryId: "je-" + id,
          },
        ];
      }
      case "accountingOutbox:listPending":
        return [];
      case "accountingLedger:getJournalEntry": {
        const id = String(args.journalEntryId).replace(/^je-/, "");
        const minor = Math.round((this.expenses.find((row) => row._id === id)?.amount ?? 0) * 1000);
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

const RECONNECT_BACKOFF_MS = 15;

/** The web client: one sync socket, reconnect with backoff, resend every unanswered mutation. */
class FakeApp {
  private routeHandler: ((socket: WebSocketRoute) => void) | null = null;
  private fromPage: ((frame: string) => void) | null = null;
  private fromServer: ((frame: string) => void) | null = null;
  private readonly pending = new Map<number, string>();
  private nextRequestId = 0;
  private nextKey = 0;
  private dialog: Dialog | null = null;
  private connections = 0;

  constructor(private readonly backend: FakeBackend) {}

  get dialogOpen(): boolean {
    return this.dialog !== null;
  }

  async routeWebSocket(_matcher: unknown, handler: (socket: WebSocketRoute) => void): Promise<void> {
    // Playwright routes only sockets opened after the route is attached.
    if (this.backend.faults.socketBypassesRoute) return;
    this.routeHandler = handler;
    this.connect();
  }

  private connect(): void {
    if (!this.routeHandler) return;
    this.fromPage = null;
    this.fromServer = null;
    let closed = false;
    const connectionNumber = this.connections + 1;
    const retried = () => connectionNumber > 1;
    const server = {
      send: (frame: string) => {
        const parsed = JSON.parse(frame) as { type: string; requestId: number; args: unknown[] };
        if (parsed.type !== "Mutation") return;
        const outcome = this.backend.create(parsed.args[0] as Record<string, unknown>, retried());
        setTimeout(() => {
          if (!closed) {
            this.fromServer?.(
              JSON.stringify({
                type: "MutationResponse",
                requestId: parsed.requestId,
                success: outcome.ok,
                result: outcome.ok ? outcome.id : outcome.message,
              }),
            );
          }
        }, 0);
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
        if (this.backend.faults.closeOnDrop && this.dialog) {
          this.pending.clear();
          this.dialog = null;
        }
        if (!this.backend.faults.neverReconnects) setTimeout(() => this.connect(), RECONNECT_BACKOFF_MS);
      },
    } as unknown as WebSocketRoute;
    this.routeHandler(route);
    // A refused connection was closed before the observer attached to it.
    if (this.fromPage === null) return;
    this.connections += 1;
    setTimeout(() => {
      if (closed) return;
      this.fromServer?.(JSON.stringify({ type: "Transition", startVersion: {}, endVersion: {}, modifications: [] }));
      if (this.connections === 1 || this.backend.faults.noResend) return;
      for (const frame of this.pending.values()) {
        const parsed = JSON.parse(frame) as { args: Record<string, unknown>[] };
        if (this.backend.faults.resendNewKey) {
          parsed.args[0] = { ...parsed.args[0], idempotencyKey: String(parsed.args[0].idempotencyKey) + "-retry" };
        }
        this.fromPage?.(JSON.stringify({ ...JSON.parse(frame), args: parsed.args }));
      }
    }, 0);
  }

  private deliverToPage(frame: string): void {
    const parsed = JSON.parse(frame) as { type: string; requestId: number; success: boolean };
    if (parsed.type !== "MutationResponse") return;
    this.pending.delete(parsed.requestId);
    if (parsed.success) this.dialog = null;
  }

  clickTrigger(): void {
    if (this.dialog) return this.clickSubmit();
    this.nextKey += 1;
    this.dialog = { title: "", amount: 0, key: "key-" + this.nextKey };
  }

  clickSubmit(): void {
    const dialog = this.dialog;
    if (!dialog) throw new Error("Timeout: no Record Expense button in an open dialog");
    if (this.pending.size > 0) throw new Error("Timeout: the Record Expense button is not actionable while a save is in flight");
    this.nextRequestId += 1;
    const frame = JSON.stringify({
      type: "Mutation",
      requestId: this.nextRequestId,
      udfPath: "expenses:create",
      args: [{ orgId: "org1", title: dialog.title, amount: dialog.amount, status: "PAID", idempotencyKey: dialog.key }],
    });
    const skip = this.backend.faults.noTransmitSuffix;
    if (skip && dialog.title.endsWith(skip)) return;
    if (this.backend.faults.socketBypassesRoute) {
      // The save travels on the page's own socket, where nothing observes or drops it.
      const outcome = this.backend.create({ title: dialog.title, amount: dialog.amount, status: "PAID", idempotencyKey: dialog.key }, false);
      if (outcome.ok) this.dialog = null;
      return;
    }
    this.pending.set(this.nextRequestId, frame);
    this.fromPage?.(frame);
  }

  cancel(): void {
    this.dialog = null;
  }

  fill(field: "title" | "amount", value: string): void {
    if (!this.dialog) throw new Error("no dialog open");
    if (field === "title") this.dialog.title = value;
    else this.dialog.amount = Number(value);
  }

  inputValue(field: "title" | "amount"): string {
    if (!this.dialog) throw new Error("no dialog open");
    return field === "title" ? this.dialog.title : String(this.dialog.amount);
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
    return new FakeLocator(this.app, `${this.path}>label:${label === "Title / Description" ? "title" : "amount"}`);
  }

  async waitFor(options?: { state?: string; timeout?: number }): Promise<void> {
    if (this.path === "dialog" && options?.state === "hidden") return this.app.waitHidden(options.timeout ?? 30_000);
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
}

function fakePage(app: FakeApp): Page {
  const root = new FakeLocator(app, "page");
  return {
    routeWebSocket: (matcher: unknown, handler: (socket: WebSocketRoute) => void) => app.routeWebSocket(matcher, handler),
    goto: async () => null,
    getByRole: (role: string, options?: { name?: string }) =>
      role === "dialog" ? new FakeLocator(app, "dialog") : root.getByRole(role, options),
  } as unknown as Page;
}

function fakeClient(backend: FakeBackend): ConvexHttpClient {
  return {
    query: async (ref: FunctionReference<"query">, args: Record<string, unknown>) =>
      backend.query(getFunctionName(ref), args),
    mutation: async () => {
      throw new ConvexError("unexpected mutation");
    },
  } as unknown as ConvexHttpClient;
}

function harness(faults: Faults = {}, oracle: BrowserOracleKind = "IDEMPOTENCY_SINGLE_EFFECT") {
  const backend = new FakeBackend(faults);
  const app = new FakeApp(backend);
  const evidence: Record<string, unknown>[] = [];
  const runtime: MissionBrowser = {
    browser: {} as MissionBrowser["browser"],
    browserContext: {} as MissionBrowser["browserContext"],
    page: fakePage(app),
    paths: { root: "r", trace: "t", screenshot: "s", backendState: "backend-state.json" },
  };
  const runtimeApi: MissionBrowserRuntime = {
    open: async () => runtime,
    finish: async () => ["trace.zip"],
    rethrowAfterCleanup: async (_runtime, error) => {
      throw error;
    },
    writeBackendEvidence: async (paths, value) => {
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async () => "org1",
    authenticatedClient: async () => fakeClient(backend),
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family: "NETWORK_RECOVERY", oracle },
    signal: new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createNetworkRecoveryHandler(runtimeApi, {
    uiStepMs: 200,
    outageMs: 60,
    recoveryMs: 800,
    settleMs: 20,
  });
  return { run: () => handler(context), backend, evidence, app };
}

describe("SCRUM-350 NETWORK_RECOVERY handler", () => {
  for (const oracle of ["IDEMPOTENCY_SINGLE_EFFECT", "STATE_TRANSITION"] as const) {
    it(`passes a client that recovers from the outage and resends once (${oracle})`, async () => {
      const h = harness({}, oracle);
      const result = await h.run();
      expect(result.oracle).toMatchObject({ kind: oracle, passed: true });
      expect(h.backend.expenses.map((row) => row.title.replace(/^.*-(outage|control)$/, "$1")).sort((left, right) => left.localeCompare(right))).toEqual([
        "control",
        "outage",
      ]);
      expect(h.evidence).toHaveLength(1);
      const detail = h.evidence[0].outage as { dropped: number; reconnected: boolean; attempts: number };
      expect(detail.dropped).toBe(1);
      expect(detail.reconnected).toBe(true);
      // The lost attempt and its resend were both transmitted by the client.
      expect(detail.attempts).toBe(2);
    }, 30_000);
  }

  it("refuses a mission for an oracle the attack does not judge", async () => {
    const h = harness({}, "UI_BACKEND_AUTHORITY");
    await expect(h.run()).rejects.toThrow(/does not judge the UI_BACKEND_AUTHORITY oracle/);
    expect(h.backend.expenses).toHaveLength(0);
  });

  it("a resend under a fresh command identity is a breach (one intent, two identities)", async () => {
    const h = harness({ resendNewKey: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/-outage: one intent was transmitted under 2 distinct command identities/);
    // The first attempt never reached the server; only the retried identity committed.
    expect(h.backend.expenses.filter((row) => row.title.endsWith("-outage"))).toHaveLength(1);
  }, 30_000);

  it("a dialog that closed as saved with no backend record is a breach", async () => {
    const h = harness({ closeOnDrop: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/-outage: expected exactly 1 expense record for this intent; backend holds 0/);
  }, 30_000);

  it("a retry the backend acknowledges but never stores is a breach", async () => {
    const h = harness({ dropRetry: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/-outage: expected exactly 1 expense record for this intent; backend holds 0/);
  }, 30_000);

  it("a control save refused after recovery is a breach", async () => {
    const h = harness({ refuseSuffix: "-control" });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/-control: attempt \d+ was refused/);
  }, 30_000);

  it("a client that never resends is unjudged, never a pass", async () => {
    const h = harness({ noResend: true });
    await expect(h.run()).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.evidence.at(-1)).toMatchObject({ outcome: "INCONCLUSIVE" });
  }, 30_000);

  it("a save that succeeds because the outage never fired is unjudged, never a pass", async () => {
    // The socket predates the route, so nothing can swallow the request.
    const h = harness({ socketBypassesRoute: true });
    await expect(h.run()).rejects.toThrow(/the outage never fired/);
    expect(h.backend.expenses).toHaveLength(2);
  }, 30_000);

  it("a recovery with no observed newer connection is unjudged, never a pass", async () => {
    const h = harness({ neverReconnects: true });
    await expect(h.run()).rejects.toThrow(/never heard from on a newer connection/);
  }, 30_000);

  it("an outage that never fires is unjudged, never a pass", async () => {
    const h = harness({ noTransmitSuffix: "-outage" });
    // The branch under test: nothing was observed leaving the page. Any other failure must not satisfy this.
    await expect(h.run()).rejects.toThrow(/the outage never fired: no save of the intent was observed leaving the page/);
    expect(h.evidence.at(-1)).toMatchObject({
      outcome: "INCONCLUSIVE",
      reason: expect.stringContaining("the outage never fired"),
      outage: { dropped: 0 },
    });
    expect(h.backend.expenses.some((row) => row.title.endsWith("-outage"))).toBe(false);
  }, 30_000);
});
