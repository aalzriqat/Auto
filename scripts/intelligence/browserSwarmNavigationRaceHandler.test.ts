import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import { browserMissionTimeoutMs, type BrowserMissionEvidence } from "./browserAttackSwarm";
import { readSettledLedger } from "./browserSwarmBoundaryAttacks";
import type { BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { NAVIGATION_RACE_LEDGER_WAIT_BOUND_MS, createNavigationRaceAttackHandlers } from "./browserSwarmNavigationRaceAttack";

/**
 * SCRUM-350 LIFE-1 — handler-level tests for NAVIGATION_RACE.
 *
 * The real handler runs end to end against a scripted backend ledger and a
 * scripted expenses screen. A correct product either applies the interrupted
 * "Reverse & Delete" exactly once or not at all, never lists a reversed
 * expense after a reload, and lets the reversal be repeated to exactly one.
 * Each fault flips one fact, so every judgement in the handler is pinned by a
 * verdict that changes when its wiring is removed. No browser is launched.
 */

interface Faults {
  /** The interrupted request never reaches the backend (the page went first). */
  requestLost?: boolean;
  /** The interrupted request reaches the backend twice. */
  duplicateOnLand?: boolean;
  /** The interrupted request marks the original reversed and writes no reversal. */
  halfApplied?: boolean;
  /** The reloaded screen keeps listing a reversed expense. */
  staleRow?: boolean;
  /** History back does not leave the expenses screen. */
  backStaysPut?: boolean;
  /** History forward does not come back to the expenses screen. */
  forwardStaysAway?: boolean;
  /** History forward lands on another screen that also shows a Record Expense button. */
  forwardLandsElsewhere?: boolean;
  /** The click on Reverse & Delete fails inside the browser. */
  clickThrows?: boolean;
  /** The reason is never accepted, so the dialog is not armed (the row never opens). */
  rowMissing?: boolean;
  /** The reload fails. */
  reloadThrows?: boolean;
  /** The repeat from the returned screen fails because its dialog cannot be driven. */
  repeatUnreachable?: boolean;
  /** The posting is made in a currency other than the organization's. */
  wrongCurrency?: boolean;
  /** After a reload the list data has not arrived yet: no row, sentinel included, is shown. */
  listNeverLoads?: boolean;
  /** The reversal also reverses the other, unrelated posted expense. */
  sentinelTouched?: boolean;
  /** Once the reversal was clicked, the sentinel's ledger can no longer be read. */
  sentinelAfterReadFails?: boolean;
  /** The repeat's click fails inside the browser although the reloaded screen shows the expense. */
  repeatClickThrows?: boolean;
  /**
   * The seeded expense does not post inline. "drains": the outbox tick posts it after many ledger reads, with a
   * waiting row until then. "stuck": a waiting row that never posts. "failed": a failed row (raw error text).
   * "none": it never posts and nothing is queued.
   */
  queuedPost?: "drains" | "stuck" | "failed" | "none";
  /** The outbox cannot be read. */
  outboxUnreadable?: boolean;
  /** The newest PENDING page is full (200 rows), with or without the seeded expense's own row in it. */
  outboxPage?: "full";
}

/** Ledger reads of the seeded expense before the outbox tick posts a "drains" row; more than one settle phase reads. */
const TICK_AFTER_READS = 60;
const RAW_OUTBOX_REASON = "Waiting on a predecessor: customer 4471 deal D-93";
const RAW_OUTBOX_ERROR ="Error: internal posting failure for customer 4471";

interface FakeEvent {
  sourceId: string;
  _id: string;
  eventType: string;
  status: string;
  reversalOfEventId: string | null;
  reversedByEventId: string | null;
  journalEntryId: string | null;
}

interface FakeLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  scale: number;
  currency: string;
}

class World {
  readonly calls: string[] = [];
  readonly created: string[] = [];
  events: FakeEvent[] = [];
  journals: Record<string, FakeLine[]> = {};
  url = "about:blank";
  history: string[] = [];
  forward: string[] = [];
  phase: "closed" | "confirm" | "reversal" = "closed";
  reason = "";
  reloads = 0;

  constructor(readonly faults: Faults) {}

  private postSeeded(): void {
    const currency = this.faults.wrongCurrency ? "USD" : "JOD";
    this.events.push({
      sourceId: "exp1",
      _id: "e1",
      eventType: "EXPENSE_POSTED",
      status: "POSTED",
      reversalOfEventId: null,
      reversedByEventId: null,
      journalEntryId: "j1",
    });
    this.journals.j1 = [
      { accountId: "expense", debitMinor: 59_000, creditMinor: 0, scale: 3, currency },
      { accountId: "cash", debitMinor: 0, creditMinor: 59_000, scale: 3, currency },
    ];
  }

  call(name: string, args: Record<string, unknown>): unknown {
    this.calls.push(`owner:${name}`);
    switch (name) {
      case "orgSettings:get":
        return { currency: "JOD" };
      case "expenses:create": {
        this.created.push(String(args.title));
        if (this.created.length === 2) {
          this.events.push({
            sourceId: "exp2",
            _id: "s1",
            eventType: "EXPENSE_POSTED",
            status: "POSTED",
            reversalOfEventId: null,
            reversedByEventId: null,
            journalEntryId: "sj1",
          });
          this.journals.sj1 = [
            { accountId: "expense", debitMinor: 61_000, creditMinor: 0, scale: 3, currency: "JOD" },
            { accountId: "cash", debitMinor: 0, creditMinor: 61_000, scale: 3, currency: "JOD" },
          ];
          return "exp2";
        }
        if (this.faults.queuedPost) return "exp1";
        this.postSeeded();
        return "exp1";
      }
      case "accountingOutbox:listPending": {
        if (this.faults.outboxUnreadable) throw new Error("outbox unavailable");
        const queued = this.faults.queuedPost;
        const waiting = queued === "drains" ? !this.events.some((row) => row.sourceId === "exp1") : queued === "stuck";
        const status = waiting ? "PENDING" : queued === "failed" ? "FAILED" : null;
        const own =
          status === null || args.status !== status
            ? []
            : [
                {
                  kind: "POST",
                  status,
                  sourceType: "expenses",
                  sourceId: "exp1",
                  eventType: "EXPENSE_POSTED",
                  attempts: status === "FAILED" ? 10 : 0,
                  reason: RAW_OUTBOX_REASON,
                  lastError: status === "FAILED" ? RAW_OUTBOX_ERROR : undefined,
                  payload: { amountMinor: 59_000 },
                },
              ];
        // Other sources' rows; a page filled to the server cap (200) is the newest page only.
        const others = (count: number) =>
          Array.from({ length: count }, (_, index) => ({
            kind: "POST",
            status: args.status,
            sourceType: "expenses",
            sourceId: `someone-elses-${index}`,
            eventType: "EXPENSE_POSTED",
            attempts: 0,
          }));
        if (this.faults.outboxPage === "full" && args.status === "PENDING") return [...own, ...others(200 - own.length)];
        return [...own, ...others(1)];
      }
      case "accountingLedger:listAccountingEvents":
        this.calls.push(`read:${String(args.sourceId)}`);
        if (
          this.faults.queuedPost === "drains" &&
          args.sourceId === "exp1" &&
          this.calls.filter((call) => call === "read:exp1").length > TICK_AFTER_READS &&
          !this.events.some((row) => row.sourceId === "exp1")
        ) {
          this.postSeeded();
        }
        if (this.faults.sentinelAfterReadFails && args.sourceId === "exp2" && this.calls.includes("ui:click Reverse & Delete")) {
          throw new Error("ledger unavailable");
        }
        return this.events.filter((row) => row.sourceId === args.sourceId).map(({ sourceId: _source, ...row }) => ({ ...row }));
      case "accountingLedger:getJournalEntry":
        return { lines: this.journals[String(args.journalEntryId)] ?? [] };
      default:
        throw new Error(`unscripted backend call ${name}`);
    }
  }

  get reversed(): boolean {
    return this.events.some((row) => row.eventType === "JOURNAL_REVERSAL");
  }

  private reverse(): void {
    if (this.reversed) throw new ConvexError("Expense not found.");
    const index = this.events.filter((row) => row.eventType === "JOURNAL_REVERSAL").length;
    const id = `e${index + 2}`;
    const journalId = `j${index + 2}`;
    this.journals[journalId] = (this.journals.j1 ?? []).map((row) => ({
      ...row,
      debitMinor: row.creditMinor,
      creditMinor: row.debitMinor,
    }));
    const original = this.events.find((row) => row._id === "e1");
    if (original && index === 0) {
      original.status = "REVERSED";
      original.reversedByEventId = id;
    }
    this.events.push({
      sourceId: "exp1",
      _id: id,
      eventType: "JOURNAL_REVERSAL",
      status: "POSTED",
      reversalOfEventId: "e1",
      reversedByEventId: null,
      journalEntryId: journalId,
    });
  }

  /** The click on Reverse & Delete: whether the request lands is the race. */
  clickReverse(): void {
    if (this.faults.clickThrows) throw new Error("Timeout 20000ms exceeded.");
    if (this.faults.repeatClickThrows && this.calls.includes("ui:click Reverse & Delete")) {
      throw new Error("Timeout 20000ms exceeded.");
    }
    this.calls.push("ui:click Reverse & Delete");
    if (this.faults.sentinelTouched) {
      const sentinel = this.events.find((row) => row._id === "s1");
      if (sentinel) sentinel.status = "REVERSED";
    }
    if (this.faults.requestLost && this.calls.filter((c) => c === "ui:click Reverse & Delete").length === 1) return;
    if (this.faults.halfApplied && this.calls.filter((c) => c === "ui:click Reverse & Delete").length === 1) {
      const original = this.events.find((row) => row._id === "e1");
      if (original) {
        original.status = "REVERSED";
        original.reversedByEventId = "e2";
      }
      return;
    }
    this.reverse();
    if (this.faults.duplicateOnLand) {
      this.events.push({
        sourceId: "exp1",
        _id: "e9",
        eventType: "JOURNAL_REVERSAL",
        status: "POSTED",
        reversalOfEventId: "e1",
        reversedByEventId: null,
        journalEntryId: "j9",
      });
      this.journals.j9 = this.journals.j2 ?? [];
    }
    this.phase = "closed";
  }

  /**
   * Fake ordering assumption: both rows sit on one page of one ascending list (target created first), so
   * the sentinel being shown is what the handler takes as "the list has loaded"; the real list's load order
   * is documented at `readRowListing` and is not exercised here.
   */
  rowListed(id: "exp1" | "exp2"): boolean {
    if (this.faults.rowMissing) return false;
    if (this.faults.listNeverLoads && this.reloads > 0) return false;
    if (id === "exp2") return true;
    if (this.faults.repeatUnreachable && this.reloads > 0 && !this.reversed) return false;
    return !this.reversed || this.faults.staleRow === true;
  }
}

class FakeLocator {
  constructor(
    private readonly world: World,
    private readonly key: string,
  ) {}

  first(): FakeLocator {
    return this;
  }

  last(): FakeLocator {
    return this;
  }

  getByRole(role: string, options?: { name?: string }): FakeLocator {
    return new FakeLocator(this.world, `${this.key}>${role}:${options?.name ?? ""}`);
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.world, `${this.key}>${selector}`);
  }

  private isRow(): boolean {
    return this.key === "#row-exp1";
  }

  async fill(): Promise<void> {
    if (this.key === "dialog>#reversal-reason") {
      this.world.calls.push("ui:type reason");
      this.world.reason = "typed";
    }
  }

  async waitFor(options?: { state?: string }): Promise<void> {
    if (this.isRow() && !this.world.rowListed("exp1")) throw new Error("Timeout 20000ms exceeded.");
    if (this.key === "dialog>#reversal-reason" && this.world.phase !== "reversal") throw new Error("Timeout 20000ms exceeded.");
    if (this.key === "dialog" && options?.state === "hidden" && this.world.phase !== "closed") {
      throw new Error("Timeout 20000ms exceeded.");
    }
    if (this.key === "button:Record Expense" && this.world.url.includes("dashboard")) throw new Error("Timeout 20000ms exceeded.");
  }

  async click(): Promise<void> {
    if (this.key === "#row-exp1>button:") {
      this.world.calls.push("ui:open delete dialog");
      this.world.phase = "confirm";
    } else if (this.key === "dialog>button:Delete Permanently") {
      this.world.calls.push("ui:delete permanently");
      this.world.phase = "reversal";
    } else if (this.key === "dialog>button:Reverse & Delete") {
      this.world.clickReverse();
    }
  }

  async isVisible(): Promise<boolean> {
    if (this.isRow()) return this.world.rowListed("exp1");
    if (this.key === "#row-exp2") return this.world.rowListed("exp2");
    return this.key === "dialog" ? this.world.phase !== "closed" : false;
  }
}

class FakePage {
  constructor(private readonly world: World) {}

  url(): string {
    return this.world.url;
  }

  async goto(url: string): Promise<void> {
    this.world.calls.push(`ui:goto ${url}`);
    if (this.world.url !== "about:blank") this.world.history.push(this.world.url);
    this.world.forward = [];
    this.world.url = url;
  }

  async goBack(): Promise<null> {
    this.world.calls.push("ui:back");
    if (this.world.faults.backStaysPut) return null;
    const previous = this.world.history.pop();
    if (previous !== undefined) {
      this.world.forward.push(this.world.url);
      this.world.url = previous;
    }
    return null;
  }

  async goForward(): Promise<null> {
    this.world.calls.push("ui:forward");
    if (this.world.faults.forwardStaysAway) return null;
    if (this.world.faults.forwardLandsElsewhere) {
      this.world.url = "/org1/leads";
      return null;
    }
    const next = this.world.forward.pop();
    if (next !== undefined) {
      this.world.history.push(this.world.url);
      this.world.url = next;
    }
    return null;
  }

  async reload(): Promise<void> {
    this.world.calls.push("ui:reload");
    if (this.world.faults.reloadThrows) throw new Error("Navigation failed");
    this.world.reloads += 1;
    this.world.phase = "closed";
    this.world.reason = "";
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.world, selector);
  }

  getByRole(role: string, options?: { name?: string }): FakeLocator {
    return new FakeLocator(this.world, options?.name ? `${role}:${options.name}` : role);
  }
}

function harness(faults: Faults = {}, options: { signal?: AbortSignal; finishFails?: boolean; oracle?: string } = {}) {
  const world = new World(faults);
  const evidence: Record<string, unknown>[] = [];
  const opened: { finished: boolean }[] = [];
  const runtimeApi: MissionBrowserRuntime = {
    open: async () => {
      const entry = { finished: false };
      opened.push(entry);
      const runtime: MissionBrowser = {
        browser: {} as MissionBrowser["browser"],
        browserContext: { entry } as unknown as MissionBrowser["browserContext"],
        page: new FakePage(world) as unknown as Page,
        paths: { root: "r", trace: "t", screenshot: "s", backendState: "backend-state.json" },
      };
      return runtime;
    },
    finish: async (runtime) => {
      (runtime.browserContext as unknown as { entry: { finished: boolean } }).entry.finished = true;
      if (options.finishFails) throw new AggregateError([new Error("trace stop failed")], "cleanup failed");
      return ["trace.zip", "final.png"];
    },
    rethrowAfterCleanup: async (_runtime, error) => {
      throw error;
    },
    writeBackendEvidence: async (paths, value) => {
      evidence.push(JSON.parse(JSON.stringify(value)) as Record<string, unknown>);
      return paths.backendState;
    },
    resolveOrgRoute: async () => "org1",
    authenticatedClient: async () => {
      const run = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>) =>
        Promise.resolve().then(() => world.call(getFunctionName(ref), args));
      return { query: run, mutation: run } as unknown as ConvexHttpClient;
    },
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family: "NAVIGATION_RACE", oracle: options.oracle ?? "STATE_TRANSITION" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createNavigationRaceAttackHandlers(runtimeApi, {
    sleep: async () => undefined,
    pollMs: 1,
    postingWaitMs: 500,
    queuedPostingExtraMs: 300,
    raceSettleMs: 0,
    uiSettleMs: 0,
  }).NAVIGATION_RACE;
  if (!handler) throw new Error("no handler registered for NAVIGATION_RACE");
  return { run: (): Promise<BrowserMissionEvidence> => handler(context), world, evidence, opened };
}

const settle = (h: { run: () => Promise<unknown> }): Promise<unknown> => h.run().catch((thrown: unknown) => thrown);

const inconclusive = async (faults: Faults, pattern: RegExp) => {
  const h = harness(faults);
  const error = await settle(h);
  expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  expect((error as Error).message).toMatch(pattern);
  expect(h.evidence).toHaveLength(1);
  expect(h.evidence[0]).toMatchObject({ outcome: "INCONCLUSIVE" });
  expect(h.opened.every((entry) => entry.finished)).toBe(true);
  return h;
};

const breach = async (faults: Faults, pattern: RegExp) => {
  const h = harness(faults);
  const result = await h.run();
  expect(result.oracle).toMatchObject({ kind: "STATE_TRANSITION", passed: false });
  expect(result.oracle.summary).toMatch(pattern);
  expect(h.evidence[0]).toMatchObject({ attack: "NAVIGATION_RACE" });
  expect(h.evidence[0]?.violations).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  return h;
};

const reversals = (h: { world: World }): number => h.world.events.filter((row) => row.eventType === "JOURNAL_REVERSAL").length;

describe("SCRUM-350 NAVIGATION_RACE handler: a correct product", () => {
  it("passes when the interrupted request landed, with the click before the back and forward navigation", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle).toMatchObject({ kind: "STATE_TRANSITION", passed: true });
    expect(result.artifacts).toEqual(["trace.zip", "final.png", "backend-state.json"]);

    const order = h.world.calls.filter((call) => ["ui:click Reverse & Delete", "ui:back", "ui:forward", "ui:reload"].includes(call));
    expect(order).toEqual(["ui:click Reverse & Delete", "ui:back", "ui:forward", "ui:reload"]);
    expect(reversals(h)).toBe(1);
    // The dialog had already closed when history went back: the run is judged, and claims no overlap.
    expect(h.evidence[0]).toMatchObject({
      dialogOpenAtBack: false,
      sentinelVisible: true,
      sentinelId: "exp2",
      ledger: {
        repeatPerformed: false,
        sentinelPosted: { events: [expect.objectContaining({ id: "s1", status: "POSTED" })] },
        sentinelAfter: { events: [expect.objectContaining({ id: "s1", status: "POSTED" })] },
      },
    });
    expect(result.oracle.summary).not.toMatch(/was interrupted/i);
    expect(result.oracle.summary).toMatch(/not established/);
    expect(h.evidence[0]).toMatchObject({
      attack: "NAVIGATION_RACE",
      oracle: "STATE_TRANSITION",
      orgId: "org1",
      expenseId: "exp1",
      expectedCurrency: "JOD",
      violations: [],
      unjudged: [],
      raceOutcome: "APPLIED",
      race: { clickIssued: true, leftScreen: true, returned: true },
      screenRow: "NOT_LISTED",
    });
    expect(h.opened).toHaveLength(1);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
  });

  it("passes when the request was lost, by repeating the reversal from the returned screen to exactly one", async () => {
    const h = harness({ requestLost: true });
    const result = await h.run();
    expect(result.oracle).toMatchObject({ passed: true });
    expect(h.world.calls.filter((call) => call === "ui:click Reverse & Delete")).toHaveLength(2);
    expect(reversals(h)).toBe(1);
    expect(h.evidence[0]).toMatchObject({
      raceOutcome: "NOT_APPLIED",
      screenRow: "LISTED",
      dialogOpenAtBack: true,
      ledger: { repeatPerformed: true },
      violations: [],
      unjudged: [],
    });
  });

  it("plants a run-unique synthetic expense and keeps screen text out of the evidence", async () => {
    const h = harness();
    await h.run();
    expect(h.world.created).toHaveLength(2);
    expect(h.world.created[0]).toMatch(/^swarm-.+-posted$/);
    expect(h.world.created[1]).toMatch(/^swarm-.+-sentinel$/);
    expect(JSON.stringify(h.evidence)).not.toContain("Timeout");
  });
});

describe("SCRUM-350 NAVIGATION_RACE handler: breaches", () => {
  it("fails a duplicate reversal produced when the interrupted request lands", async () => {
    const h = await breach({ duplicateOnLand: true }, /2 reversal events/);
    expect(reversals(h)).toBe(2);
  });

  it("fails a half-applied reversal: the original marked reversed with no reversal event", async () => {
    await breach({ halfApplied: true }, /submitted reversal and navigation changed/);
  });

  it("fails a reloaded screen that still lists an expense the ledger shows as reversed", async () => {
    await breach({ staleRow: true }, /still lists an expense the ledger shows as reversed/);
  });

  it("fails an unreversed expense the loaded reloaded screen no longer lists, even though the repeat cannot be driven", async () => {
    const h = await breach({ requestLost: true, repeatUnreachable: true }, /does not list an expense the ledger shows as unreversed/);
    // The final ledger was never read; the afterRace that was read is recorded as such.
    expect(h.evidence[0]).toMatchObject({
      screenRow: "NOT_LISTED",
      sentinelVisible: true,
      ledger: { repeatPerformed: false, final: null, afterRace: { events: [expect.objectContaining({ id: "e1", status: "POSTED" })] } },
    });
    expect(h.evidence[0]?.unjudged).toEqual([expect.stringMatching(/was not repeated/)]);
  });

  it("still delivers a proven target breach when the sentinel cannot be read afterwards", async () => {
    const h = await breach({ staleRow: true, sentinelAfterReadFails: true }, /still lists an expense the ledger shows as reversed/);
    expect(h.evidence[0]).toMatchObject({ sentinelAfterError: "ledger unavailable", ledger: { sentinelAfter: null } });
    expect(h.evidence[0]?.unjudged).toEqual([expect.stringMatching(/could not be read after the race/)]);
  });

  it("fails a reversal that also moves another posted expense's ledger", async () => {
    const h = await breach({ sentinelTouched: true }, /sentinel expense's ledger across the race changed/);
    // The breach evidence carries both snapshots, so the movement can be read from it.
    expect(h.evidence[0]).toMatchObject({
      ledger: {
        sentinelPosted: { events: [expect.objectContaining({ id: "s1", status: "POSTED" })] },
        sentinelAfter: { events: [expect.objectContaining({ id: "s1", status: "REVERSED" })] },
      },
    });
  });

  it("fails a posting made in a currency other than the organization's", async () => {
    await breach({ wrongCurrency: true }, /organization's currency is JOD/);
  });

  it("still delivers a proven breach when browser evidence cleanup fails", async () => {
    const h = harness({ staleRow: true }, { finishFails: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed/);
  });
});

describe("SCRUM-350 NAVIGATION_RACE handler: never a vacuous pass", () => {
  it("is INCONCLUSIVE when history back does not leave the expenses screen", async () => {
    await inconclusive({ backStaysPut: true }, /history back did not leave/);
  });

  it("is INCONCLUSIVE when history forward does not return to the expenses screen", async () => {
    await inconclusive({ forwardStaysAway: true }, /history forward did not return/);
  });

  it("pins returned=false when forward lands off the expenses screen although a Record Expense button is visible", async () => {
    const h = await inconclusive({ forwardLandsElsewhere: true }, /history forward did not return/);
    expect(h.evidence[0]).toMatchObject({ race: { clickIssued: true, leftScreen: true, returned: false } });
    expect(h.world.calls).not.toContain("ui:reload");
  });

  it("reports the failed premise without re-reading the sentinel after the click", async () => {
    const h = await inconclusive({ backStaysPut: true }, /history back did not leave/);
    const click = h.world.calls.indexOf("ui:click Reverse & Delete");
    expect(h.world.calls.slice(click)).not.toContain("read:exp2");
    // No after-read happened, so none is claimed: every after state is recorded as unavailable, none as a copy of posted.
    expect(h.evidence[0]).toMatchObject({
      ledger: {
        repeatPerformed: false,
        posted: { events: [expect.objectContaining({ id: "e1" })] },
        sentinelPosted: { events: [expect.objectContaining({ id: "s1" })] },
        afterRace: null,
        final: null,
        sentinelAfter: null,
      },
    });
    expect(h.evidence[0]?.unjudged).toEqual([expect.stringMatching(/history back did not leave/)]);
  });

  it("is INCONCLUSIVE, never a pass, when the sentinel cannot be read after a clean race", async () => {
    const h = await inconclusive({ sentinelAfterReadFails: true }, /could not be read after the race/);
    expect(h.evidence[0]).toMatchObject({ sentinelAfterError: "ledger unavailable", ledger: { sentinelAfter: null } });
  });

  it("is INCONCLUSIVE, with no navigation, when the click fails inside the browser", async () => {
    const h = await inconclusive({ clickThrows: true }, /was not clicked/);
    expect(h.world.calls).not.toContain("ui:back");
    expect(h.evidence[0]).toMatchObject({ raceError: "Timeout 20000ms exceeded." });
  });

  it("is INCONCLUSIVE, with no click, when the screen cannot be driven to the armed action", async () => {
    const h = await inconclusive({ rowMissing: true }, /could not be driven to an armed Reverse & Delete/);
    expect(h.world.calls).not.toContain("ui:click Reverse & Delete");
    expect(h.world.calls).not.toContain("ui:back");
  });

  it("is INCONCLUSIVE when the reload fails, however clean the ledger is", async () => {
    const h = await inconclusive({ reloadThrows: true }, /reloaded expenses screen was not read/);
    expect(h.evidence[0]).toMatchObject({ reloadError: "Navigation failed" });
  });

  it("is INCONCLUSIVE when the list never loads after the reload, however absent the reversed expense looks", async () => {
    // Before the sentinel check this passed: the target row was simply not there yet.
    const h = await inconclusive({ listNeverLoads: true }, /reloaded expenses screen was not read/);
    expect(h.evidence[0]).toMatchObject({ sentinelVisible: false });
    expect(reversals(h)).toBe(1);
  });

  it("is INCONCLUSIVE when a lost request cannot be repeated and nothing else disagrees", async () => {
    const h = await inconclusive({ requestLost: true, repeatClickThrows: true }, /was not repeated from the returned screen/);
    expect(h.evidence[0]).toMatchObject({
      repeatError: "Timeout 20000ms exceeded.",
      screenRow: "LISTED",
      ledger: { repeatPerformed: false, final: null, afterRace: { events: [expect.objectContaining({ id: "e1" })] } },
    });
    expect(reversals(h)).toBe(0);
  });

  it("reports an aborted mission as an abort, not as a verdict", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));
    const h = harness({}, { signal: controller.signal });
    const error = await settle(h);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.world.calls).not.toContain("owner:expenses:create");
  });
});

describe("SCRUM-851 NAVIGATION_RACE handler: a posting that waits in the outbox", () => {
  const seededReads = (h: { world: World }): number => h.world.calls.filter((call) => call === "read:exp1").length;
  const timeoutEvidence = (h: { evidence: Record<string, unknown>[] }): Record<string, unknown> =>
    (h.evidence[0]?.ledgerSettleTimeouts as Record<string, unknown>[])[0] as Record<string, unknown>;

  it("waits past the inline wait for a row the outbox verifiably holds, and judges the posting once it lands", async () => {
    const h = harness({ queuedPost: "drains" });
    const result = await h.run();
    expect(result.oracle).toMatchObject({ kind: "STATE_TRANSITION", passed: true });
    expect(seededReads(h)).toBeGreaterThan(TICK_AFTER_READS);
    expect(h.world.calls).toContain("owner:accountingOutbox:listPending");
  });

  it("is INCONCLUSIVE, with the last ledger read and the waiting row, when the queued row never posts", async () => {
    const h = await inconclusive({ queuedPost: "stuck" }, /exp1 did not settle \(0 event\(s\) read, 1 queued post\(s\), wait extended\)/);
    expect(timeoutEvidence(h)).toEqual({
      sourceType: "expenses",
      sourceId: "exp1",
      extendedForQueuedPost: true,
      lastRead: [],
      outbox: "COMPLETE",
      queuedPosts: [{ kind: "POST", status: "PENDING", eventType: "EXPENSE_POSTED", attempts: 0, hasError: false }],
      outboxPagesWithoutMatch: [],
    });
    expect(seededReads(h)).toBeGreaterThan(100);
    // The outbox row's free text can hold tenant data: only structure is published.
    expect(JSON.stringify(h.evidence)).not.toContain(RAW_OUTBOX_REASON);
    expect(JSON.stringify(h.evidence)).not.toContain("4471");
  });

  it("does not extend the wait for a failed row, and publishes no raw error text", async () => {
    const h = await inconclusive({ queuedPost: "failed" }, /1 queued post\(s\)\)/);
    expect(timeoutEvidence(h)).toMatchObject({
      extendedForQueuedPost: false,
      queuedPosts: [{ status: "FAILED", attempts: 10, hasError: true }],
    });
    expect(seededReads(h)).toBeLessThanOrEqual(40);
    expect(JSON.stringify(h.evidence)).not.toContain(RAW_OUTBOX_ERROR);
    expect(JSON.stringify(h.evidence)).not.toContain("someone-elses");
  });

  it("does not extend the wait when a complete page shows nothing queued", async () => {
    const h = await inconclusive({ queuedPost: "none" }, /0 queued post\(s\)\)/);
    expect(timeoutEvidence(h)).toMatchObject({ extendedForQueuedPost: false, outbox: "COMPLETE", queuedPosts: [] });
    expect(seededReads(h)).toBeLessThanOrEqual(40);
  });

  it("does not read an unreadable outbox as empty, nor extend the wait for it", async () => {
    const h = await inconclusive({ queuedPost: "stuck", outboxUnreadable: true }, /outbox unreadable/);
    expect(timeoutEvidence(h)).toMatchObject({ extendedForQueuedPost: false, outbox: "UNREADABLE", queuedPosts: null });
    expect(seededReads(h)).toBeLessThanOrEqual(40);
  });

  it("does not infer absence from a full newest page without the source: the inspection is incomplete and fails closed", async () => {
    const h = await inconclusive({ queuedPost: "none", outboxPage: "full" }, /outbox inspection incomplete, newest page full/);
    const evidence = timeoutEvidence(h);
    expect(evidence).toMatchObject({ extendedForQueuedPost: false, outbox: "INCOMPLETE", outboxPagesWithoutMatch: ["PENDING"] });
    expect((h.evidence[0]?.reason as string) ?? "").not.toMatch(/0 queued post/);
    expect(seededReads(h)).toBeLessThanOrEqual(40);
  });

  it("still extends for a waiting row found in a full page", async () => {
    const h = await inconclusive({ queuedPost: "stuck", outboxPage: "full" }, /1 queued post\(s\), wait extended/);
    expect(timeoutEvidence(h)).toMatchObject({ extendedForQueuedPost: true, outbox: "COMPLETE" });
    expect(seededReads(h)).toBeGreaterThan(100);
  });

  it("spends the extension once across the mission's ledger reads, and records no extension for a read after it is spent", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const detail: Record<string, unknown> = {};
      const client = {
        query: async (ref: FunctionReference<"query">, args: unknown) => {
          const name = getFunctionName(ref);
          if (name === "accountingLedger:listAccountingEvents") return [];
          if (name === "accountingOutbox:listPending") {
            return (args as { status: string }).status !== "PENDING"
              ? []
              : [{ kind: "POST", sourceType: "expenses", sourceId: "exp-a", eventType: "EXPENSE_POSTED", attempts: 0 }];
          }
          throw new Error(`unscripted ${name}`);
        },
      };
      const env = { client, orgId: "org1", signal: new AbortController().signal, detail } as unknown as BoundaryMissionEnv;
      const options = {
        pollMs: 10,
        postingWaitMs: 100,
        sleep: async (ms: number) => {
          now += ms;
        },
      };
      const extraWait = { remainingMs: 300 };
      const started = now;
      await expect(readSettledLedger(env, options, "exp-a", { extraWait, until: () => false })).rejects.toBeInstanceOf(
        BrowserSwarmOracleInconclusiveError,
      );
      const first = now - started;
      expect(first).toBeGreaterThanOrEqual(100 + 300);
      expect(first).toBeLessThanOrEqual(100 + 300 + 3 * options.pollMs);
      expect(extraWait.remainingMs).toBe(0);

      const secondStarted = now;
      await expect(readSettledLedger(env, options, "exp-a", { extraWait, until: () => false })).rejects.toBeInstanceOf(
        BrowserSwarmOracleInconclusiveError,
      );
      expect(now - secondStarted).toBeLessThanOrEqual(100 + 2 * options.pollMs);
      const timeouts = detail.ledgerSettleTimeouts as { extendedForQueuedPost: boolean }[];
      expect(timeouts.map((timeout) => timeout.extendedForQueuedPost)).toEqual([true, false]);
    } finally {
      clock.mockRestore();
    }
  });

  it("leaves room in the mission budget for every ledger wait plus the screen steps", () => {
    const timeoutMs = browserMissionTimeoutMs("NAVIGATION_RACE");
    // Healthy screen steps (navigations, dialog, race settle, reload, repeat) are measured in tens of seconds.
    expect(timeoutMs - NAVIGATION_RACE_LEDGER_WAIT_BOUND_MS).toBeGreaterThanOrEqual(60_000);
    expect(NAVIGATION_RACE_LEDGER_WAIT_BOUND_MS).toBe(5 * 20_000 + 60_000);
  });
});

describe("SCRUM-350 NAVIGATION_RACE handler: mission contract", () => {
  it("refuses a mission whose oracle it does not judge", async () => {
    const h = harness({}, { oracle: "UI_BACKEND_AUTHORITY" });
    await expect(h.run()).rejects.toThrow(/NAVIGATION_RACE does not judge the UI_BACKEND_AUTHORITY oracle/);
    expect(h.world.calls).toEqual([]);
  });
});
