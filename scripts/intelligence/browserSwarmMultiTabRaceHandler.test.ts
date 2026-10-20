import type { Page, WebSocketRoute } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import {
  createEconomicAttackHandlers,
  MULTI_TAB_RACE_AMOUNTS,
  type MissionBrowser,
  type MissionBrowserRuntime,
} from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-826 (CodeRabbit 4250443729) — handler-level tests for MULTI_TAB_RACE.
 *
 * The real handler runs end to end against a scripted fake: two Playwright
 * tabs whose edit dialogs transmit real Convex sync frames through the real
 * ConvexSyncObserver and its race barrier, a fake backend that implements the
 * posting lock, and an authenticated client read through the real authority
 * reader. The tests pin two contracts the handler must share with
 * DUPLICATE_SUBMIT:
 * - abort (D5): an aborted mission stops touching the preview — it never
 *   starts the synthetic setup write and stops polling and reading promptly;
 * - conclusion (C-3): a proven breach survives a browser-cleanup failure and a
 *   transient evidence-write failure; a pass is never certified without both.
 */

const LOCKED = "Posted expenses are locked";

interface Faults {
  /** The backend accepts both concurrent saves (no posting lock): a breach. */
  noPostingLock?: boolean;
  /** The backend never answers an update (a harness-side stall). */
  silentUpdates?: boolean;
  /** Browser cleanup fails after the verdict. */
  finishFails?: boolean;
  /** The first N backend evidence writes fail. */
  evidenceFailures?: number;
  /** Abort the mission when the handler asks for the setup client. */
  abortAtSetupClient?: boolean;
  /** Abort the mission this many ms after the first update is transmitted. */
  abortAfterUpdateMs?: number;
}

interface ExpenseRecord {
  _id: string;
  title: string;
  amount: number;
  status: string;
  postedAmount: number | null;
}

class FakeBackend {
  readonly expenses: ExpenseRecord[] = [];
  queryCount = 0;
  setupWrites = 0;

  constructor(readonly faults: Faults) {}

  create(args: Record<string, unknown>): string {
    this.setupWrites += 1;
    const id = "exp" + (this.expenses.length + 1);
    this.expenses.push({
      _id: id,
      title: String(args.title),
      amount: Number(args.amount),
      status: String(args.status),
      postedAmount: null,
    });
    return id;
  }

  update(args: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
    const row = this.expenses.find((expense) => expense._id === String(args.id));
    if (!row) return { ok: false, message: "Expense not found" };
    if (row.status === "PAID" && !this.faults.noPostingLock) return { ok: false, message: LOCKED };
    row.amount = Number(args.amount);
    row.status = String(args.status);
    if (row.status === "PAID" && row.postedAmount === null) row.postedAmount = row.amount;
    return { ok: true };
  }

  query(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "expenses:list":
        return { page: this.expenses, isDone: true, continueCursor: "" };
      case "accountingLedger:listAccountingEvents": {
        const row = this.expenses.find((expense) => expense._id === String(args.sourceId));
        if (!row || row.postedAmount === null) return [];
        return [
          {
            _id: "ev-" + row._id,
            eventType: "EXPENSE_POSTED",
            status: "POSTED",
            idempotencyKey: "expense_posted_" + row._id,
            journalEntryId: "je-" + row._id,
          },
        ];
      }
      case "accountingOutbox:listPending":
        return [];
      case "accountingLedger:getJournalEntry": {
        const id = String(args.journalEntryId).replace(/^je-/, "");
        const row = this.expenses.find((expense) => expense._id === id);
        const minor = Math.round((row?.postedAmount ?? 0) * 1000);
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

/** One browser tab: its own sync socket and its own edit dialog. */
class FakeTab {
  private fromPage: ((frame: string) => void) | null = null;
  private fromServer: ((frame: string) => void) | null = null;
  private nextRequestId = 0;
  dialog: { id: string; title: string; amount: number; status: string } | null = null;

  constructor(
    private readonly backend: FakeBackend,
    private readonly onFirstUpdate: () => void,
  ) {}

  async routeWebSocket(_matcher: unknown, handler: (socket: WebSocketRoute) => void): Promise<void> {
    const server = {
      send: (frame: string) => {
        const parsed = JSON.parse(frame) as { type: string; requestId: number; args: unknown[] };
        if (parsed.type !== "Mutation") return;
        this.onFirstUpdate();
        if (this.backend.faults.silentUpdates) return;
        const outcome = this.backend.update(parsed.args[0] as Record<string, unknown>);
        setTimeout(() => {
          this.fromServer?.(
            JSON.stringify({
              type: "MutationResponse",
              requestId: parsed.requestId,
              success: outcome.ok,
              result: outcome.ok ? null : outcome.message,
            }),
          );
        }, 0);
      },
      onMessage: (next: (frame: string) => void) => {
        this.fromServer = next;
      },
      close: async () => undefined,
    };
    const route = {
      connectToServer: () => server,
      onMessage: (next: (frame: string) => void) => {
        this.fromPage = next;
      },
      send: (frame: string) => {
        const parsed = JSON.parse(frame) as { type: string; success?: boolean };
        // The edit dialog closes on a successful save and stays open on refusal.
        if (parsed.type === "MutationResponse" && parsed.success) this.dialog = null;
      },
      close: async () => undefined,
    } as unknown as WebSocketRoute;
    handler(route);
  }

  openRow(id: string): void {
    const row = this.backend.expenses.find((expense) => expense._id === id);
    if (!row) throw new Error("Timeout: row #row-" + id + " never appeared");
    this.dialog = { id, title: row.title, amount: row.amount, status: row.status };
  }

  save(): void {
    const dialog = this.dialog;
    if (!dialog) throw new Error("Timeout: no Save Changes button");
    this.nextRequestId += 1;
    this.fromPage?.(
      JSON.stringify({
        type: "Mutation",
        requestId: this.nextRequestId,
        udfPath: "expenses:update",
        args: [{ orgId: "org1", ...dialog }],
      }),
    );
  }
}

class FakeLocator {
  constructor(
    private readonly tab: FakeTab,
    private readonly path: string,
  ) {}

  getByRole(role: string, options?: { name?: string | RegExp }): FakeLocator {
    return new FakeLocator(this.tab, `${this.path}>${role}:${String(options?.name ?? "")}`);
  }

  getByLabel(label: string | RegExp): FakeLocator {
    const field = label === "Payment Status" ? "status" : label === "Title / Description" ? "title" : "amount";
    return new FakeLocator(this.tab, `${this.path}>label:${field}`);
  }

  first(): FakeLocator {
    return this;
  }

  /** Visibility is checked where it matters: opening a missing row throws. */
  async waitFor(): Promise<void> {}

  async fill(value: string): Promise<void> {
    if (this.path.endsWith("label:amount") && this.tab.dialog) this.tab.dialog.amount = Number(value);
  }

  async click(): Promise<void> {
    const row = /^page>#row-([^>]+)>button:$/.exec(this.path);
    if (row) return this.tab.openRow(row[1]);
    if (this.path === "dialog>button:Save Changes") return this.tab.save();
    if (this.path === "dialog>label:status") return;
    if (this.path === "page>option:Paid") {
      if (this.tab.dialog) this.tab.dialog.status = "PAID";
      return;
    }
    throw new Error("unexpected click " + this.path);
  }
}

function fakePage(tab: FakeTab): Page {
  const root = new FakeLocator(tab, "page");
  return {
    routeWebSocket: (matcher: unknown, handler: (socket: WebSocketRoute) => void) =>
      tab.routeWebSocket(matcher, handler),
    goto: async () => null,
    getByRole: (role: string, options?: { name?: string }) =>
      role === "dialog" ? new FakeLocator(tab, "dialog") : root.getByRole(role, options),
    getByPlaceholder: () => new FakeLocator(tab, "page>search"),
    locator: (selector: string) => new FakeLocator(tab, "page>" + selector),
  } as unknown as Page;
}

function fakeClient(backend: FakeBackend): ConvexHttpClient {
  return {
    mutation: async (ref: FunctionReference<"mutation">, args: Record<string, unknown>) => {
      if (getFunctionName(ref) !== "expenses:create") throw new ConvexError("unexpected mutation");
      return backend.create(args);
    },
    query: async (ref: FunctionReference<"query">, args: Record<string, unknown>) => {
      backend.queryCount += 1;
      return backend.query(getFunctionName(ref), args);
    },
  } as unknown as ConvexHttpClient;
}

interface Harness {
  run(): ReturnType<ReturnType<typeof createEconomicAttackHandlers>["MULTI_TAB_RACE"]>;
  evidence: Record<string, unknown>[];
  backend: FakeBackend;
  controller: AbortController;
  /** Authority reads served when the mission was aborted. */
  queriesAtAbort: () => number | null;
}

function harness(faults: Faults = {}): Harness {
  const backend = new FakeBackend(faults);
  const controller = new AbortController();
  let queriesAtAbort: number | null = null;
  const abort = (): void => {
    if (controller.signal.aborted) return;
    queriesAtAbort = backend.queryCount;
    controller.abort(new Error("mission timed out"));
  };
  let updateSeen = false;
  const onFirstUpdate = (): void => {
    if (updateSeen) return;
    updateSeen = true;
    if (faults.abortAfterUpdateMs !== undefined) setTimeout(abort, faults.abortAfterUpdateMs);
  };
  const tabA = new FakeTab(backend, onFirstUpdate);
  const tabB = new FakeTab(backend, onFirstUpdate);
  const evidence: Record<string, unknown>[] = [];
  let evidenceWriteFailures = 0;
  const runtime: MissionBrowser = {
    browser: {} as MissionBrowser["browser"],
    browserContext: { newPage: async () => fakePage(tabB) } as unknown as MissionBrowser["browserContext"],
    page: fakePage(tabA),
    paths: { root: "r", trace: "t", screenshot: "s", backendState: "backend-state.json" },
  };
  const runtimeApi: MissionBrowserRuntime = {
    open: async () => runtime,
    finish: async () => {
      if (faults.finishFails) throw new AggregateError([new Error("trace stop failed")], "cleanup failed");
      return ["trace.zip"];
    },
    rethrowAfterCleanup: async (_runtime, error) => {
      throw error;
    },
    writeBackendEvidence: async (paths, value) => {
      if (evidenceWriteFailures < (faults.evidenceFailures ?? 0)) {
        evidenceWriteFailures += 1;
        throw new Error("disk full");
      }
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async () => "org1",
    authenticatedClient: async () => {
      if (faults.abortAtSetupClient) abort();
      return fakeClient(backend);
    },
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family: "MULTI_TAB_RACE" },
    signal: controller.signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createEconomicAttackHandlers(runtimeApi, {
    multiTabRaceTimeouts: { uiStepMs: 5_000, barrierMs: 2_000, settleMs: 25 },
  }).MULTI_TAB_RACE;
  return {
    run: () => handler(context),
    evidence,
    backend,
    controller,
    queriesAtAbort: () => queriesAtAbort,
  };
}

describe("SCRUM-826 MULTI_TAB_RACE handler", () => {
  it("passes a backend that enforces the posting lock (control)", async () => {
    const h = harness();
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(true);
    expect(evidence.artifacts).toEqual(["trace.zip", "backend-state.json"]);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].violations).toEqual([]);
    const row = h.backend.expenses[0];
    expect(row.status).toBe("PAID");
    expect([MULTI_TAB_RACE_AMOUNTS.A, MULTI_TAB_RACE_AMOUNTS.B]).toContain(row.amount);
  }, 30_000);

  it("detects a backend without the posting lock (breach control)", async () => {
    const h = harness({ noPostingLock: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/exactly one tab to win/);
  }, 30_000);

  it("C-3: a browser-cleanup failure cannot retract a proven breach", async () => {
    const h = harness({ noPostingLock: true, finishFails: true });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(evidence.oracle.summary).toMatch(/exactly one tab to win/);
    expect(evidence.oracle.summary).toMatch(/browser evidence cleanup also failed: cleanup failed/);
    expect(evidence.artifacts).toEqual(["backend-state.json"]);
    expect(h.evidence).toHaveLength(1);
  }, 30_000);

  it("C-3: a transient evidence-write failure cannot demote a proven breach", async () => {
    const h = harness({ noPostingLock: true, evidenceFailures: 1 });
    const evidence = await h.run();
    expect(evidence.oracle.passed).toBe(false);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].violations).not.toEqual([]);
  }, 30_000);

  it("C-3: a breach whose evidence cannot be written is labelled BREACH_UNDELIVERED, never certified", async () => {
    const h = harness({ noPostingLock: true, evidenceFailures: 2 });
    await expect(h.run()).rejects.toThrow(/disk full/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0].outcome).toBe("BREACH_UNDELIVERED");
    expect(h.evidence[0].violations).not.toEqual([]);
  }, 30_000);

  it("a pass is never certified when browser cleanup fails", async () => {
    const h = harness({ finishFails: true });
    await expect(h.run()).rejects.toThrow(/cleanup failed/);
  }, 30_000);

  it("a pass is never certified when its evidence cannot be written", async () => {
    const h = harness({ evidenceFailures: 1 });
    await expect(h.run()).rejects.toThrow(/disk full/);
  }, 30_000);

  it("D5: an aborted mission never starts the synthetic setup write", async () => {
    const h = harness({ abortAtSetupClient: true });
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    expect(h.backend.setupWrites).toBe(0);
    expect(h.backend.expenses).toHaveLength(0);
  }, 30_000);

  it("D5: an aborted mission stops waiting for replies and never reads authority afterwards", async () => {
    const h = harness({ silentUpdates: true, abortAfterUpdateMs: 50 });
    const started = Date.now();
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    // Well under the 5 s reply wait: the handler quiesced on the abort.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.queriesAtAbort()).toBe(0);
    expect(h.backend.queryCount).toBe(0);
  }, 30_000);
});
