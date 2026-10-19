import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionEvidence } from "./browserAttackSwarm";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { createStaleUiAttackHandlers } from "./browserSwarmStaleUiAttack";

/**
 * SCRUM-350 LIFE-1 — handler-level tests for STALE_UI.
 *
 * The real handler runs end to end against a scripted backend ledger and a
 * scripted expenses screen. A correct product posts the expense once, reverses
 * it once when the backend is asked, refuses the stale screen's late
 * "Reverse & Delete" ("Expense not found.") and announces that refusal, and the
 * ledger does not move. Each fault flips exactly one fact, so every judgement in
 * the handler is pinned by a verdict that changes when its wiring is removed.
 * No browser is launched.
 */

interface Faults {
  /** The screen announces success for the late reversal whatever the backend said. */
  lyingScreen?: boolean;
  /** The screen shows nothing after the late click. */
  silentScreen?: boolean;
  /** The screen answers the late click with a message that is not the expense-not-found refusal. */
  unclassifiedToast?: boolean;
  /** The product closes the dialog by itself once the expense is reversed. */
  dialogWithdraws?: boolean;
  /** The backend reverses the expense a second time when the stale screen asks. */
  secondReversalAccepted?: boolean;
  /** The reason is never accepted, so "Reverse & Delete" stays disabled. */
  neverArmed?: boolean;
  /** The server-side reversal hits the write rate limit. */
  serverReversalRateLimited?: boolean;
  /** The server-side reversal is accepted but nothing is reversed. */
  serverReversalNoEffect?: boolean;
  /** The posted expense never shows on the expenses screen. */
  rowMissing?: boolean;
  /** The late click on Reverse & Delete fails inside the browser. */
  lateClickThrows?: boolean;
  /** The posting is made in a currency other than the organization's. */
  wrongCurrency?: boolean;
}

const GONE = "Expense not found.";

interface FakeEvent {
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
  phase: "closed" | "confirm" | "reversal" = "closed";
  reason = "";
  reversedOnce = false;
  lateClicked = false;
  private toast: "success" | "refusal" | "unclassified" | null = null;

  constructor(readonly faults: Faults) {}

  call(name: string, args: Record<string, unknown>, via: "owner" | "ui" = "owner"): unknown {
    this.calls.push(`${via}:${name}`);
    switch (name) {
      case "orgSettings:get":
        return { currency: "JOD" };
      case "expenses:create": {
        this.created.push(String(args.title));
        const currency = this.faults.wrongCurrency ? "USD" : "JOD";
        this.events.push({
          _id: "e1",
          eventType: "EXPENSE_POSTED",
          status: "POSTED",
          reversalOfEventId: null,
          reversedByEventId: null,
          journalEntryId: "j1",
        });
        this.journals.j1 = [
          { accountId: "expense", debitMinor: 53_000, creditMinor: 0, scale: 3, currency },
          { accountId: "cash", debitMinor: 0, creditMinor: 53_000, scale: 3, currency },
        ];
        return "exp1";
      }
      case "accountingLedger:listAccountingEvents":
        return this.events.map((row) => ({ ...row }));
      case "accountingLedger:getJournalEntry":
        return { lines: this.journals[String(args.journalEntryId)] ?? [] };
      case "expenses:reverseExpense":
        return this.reverse(via);
      default:
        throw new Error(`unscripted backend call ${name}`);
    }
  }

  private reverse(via: "owner" | "ui"): null {
    if (this.faults.serverReversalRateLimited && via === "owner") throw new ConvexError("Rate limit exceeded. Try again in 1s");
    if (this.faults.serverReversalNoEffect && via === "owner") return null;
    if (this.reversedOnce && !this.faults.secondReversalAccepted) throw new ConvexError(GONE);
    const id = this.events.some((row) => row.eventType === "JOURNAL_REVERSAL") ? "e3" : "e2";
    const journalId = id === "e2" ? "j2" : "j3";
    this.journals[journalId] = (this.journals.j1 ?? []).map((row) => ({
      ...row,
      debitMinor: row.creditMinor,
      creditMinor: row.debitMinor,
    }));
    const original = this.events.find((row) => row._id === "e1");
    if (original && !this.reversedOnce) {
      original.status = "REVERSED";
      original.reversedByEventId = id;
    }
    this.events.push({
      _id: id,
      eventType: "JOURNAL_REVERSAL",
      status: "POSTED",
      reversalOfEventId: "e1",
      reversedByEventId: null,
      journalEntryId: journalId,
    });
    this.reversedOnce = true;
    return null;
  }

  /** The screen's reaction to the late click: honest unless a fault says otherwise. */
  clickReverse(): void {
    if (this.faults.lateClickThrows) throw new Error("Timeout 20000ms exceeded.");
    this.lateClicked = true;
    this.calls.push("ui:click Reverse & Delete");
    try {
      this.call("expenses:reverseExpense", {}, "ui");
      this.toast = "success";
    } catch {
      this.toast = "refusal";
    }
    if (this.faults.lyingScreen) this.toast = "success";
    if (this.faults.silentScreen) this.toast = null;
    if (this.faults.unclassifiedToast) this.toast = "unclassified";
  }

  reverseActionVisible(): boolean {
    return this.phase === "reversal" && !(this.reversedOnce && this.faults.dialogWithdraws);
  }

  toastKind(): "success" | "refusal" | "unclassified" | null {
    return this.toast;
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

  private isReverse(): boolean {
    return this.key === "dialog>button:Reverse & Delete";
  }

  async fill(): Promise<void> {
    if (this.key === "dialog>#reversal-reason" && !this.world.faults.neverArmed) {
      this.world.calls.push("ui:type reason");
      this.world.reason = "typed";
    }
  }

  async waitFor(): Promise<void> {
    if (this.isRow() && this.world.faults.rowMissing) throw new Error("Timeout 20000ms exceeded.");
    if (this.key === "dialog>#reversal-reason" && this.world.phase !== "reversal") throw new Error("Timeout 20000ms exceeded.");
  }

  async click(): Promise<void> {
    if (this.key === "#row-exp1>button:") {
      this.world.calls.push("ui:open delete dialog");
      this.world.phase = "confirm";
    } else if (this.key === "dialog>button:Delete Permanently") {
      this.world.calls.push("ui:delete permanently");
      this.world.phase = "reversal";
    } else if (this.isReverse()) {
      this.world.clickReverse();
    }
  }

  async isVisible(): Promise<boolean> {
    if (this.isRow()) return true;
    if (this.isReverse()) return this.world.reverseActionVisible();
    // The "other" toast selector negates the success one, so it is recognised first.
    if (this.key.includes(":not([data-type='success'])")) {
      const kind = this.world.toastKind();
      return kind === "refusal" || kind === "unclassified";
    }
    if (this.key.includes("[data-type='success']")) return this.world.toastKind() === "success";
    return false;
  }

  async isEnabled(): Promise<boolean> {
    return this.isReverse() && this.world.reverseActionVisible() && this.world.reason !== "";
  }

  async innerText(): Promise<string> {
    return this.world.toastKind() === "unclassified" ? "Rate limit exceeded. Try again in 3s" : GONE;
  }
}

class FakePage {
  constructor(private readonly world: World) {}

  async goto(url: string): Promise<void> {
    this.world.calls.push(`ui:goto ${url}`);
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(this.world, selector.startsWith("#row-") ? selector : selector.replace(/\s+/g, " "));
  }

  getByRole(role: string): FakeLocator {
    return new FakeLocator(this.world, role);
  }
}

function harness(
  faults: Faults = {},
  options: { signal?: AbortSignal; finishFails?: boolean; oracle?: string } = {},
) {
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
    mission: { id: "mission-1", family: "STALE_UI", oracle: options.oracle ?? "UI_BACKEND_AUTHORITY" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createStaleUiAttackHandlers(runtimeApi, {
    sleep: async () => undefined,
    pollMs: 1,
    uiSettleMs: 0,
  }).STALE_UI;
  if (!handler) throw new Error("no handler registered for STALE_UI");
  return { run: (): Promise<BrowserMissionEvidence> => handler(context), world, evidence, opened };
}

/** Runs the handler and returns whatever it ended in, a result or the error it threw. */
const settle = (h: { run: () => Promise<unknown> }): Promise<unknown> => h.run().catch((thrown: unknown) => thrown);

/** Asserts the mission ended INCONCLUSIVE for `pattern`, with its evidence written and every browser finished. */
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

/** Asserts the mission ended in a proven breach whose summary names `pattern`. */
const breach = async (faults: Faults, pattern: RegExp) => {
  const h = harness(faults);
  const result = await h.run();
  expect(result.oracle).toMatchObject({ kind: "UI_BACKEND_AUTHORITY", passed: false });
  expect(result.oracle.summary).toMatch(pattern);
  expect(h.evidence[0]).toMatchObject({ attack: "STALE_UI" });
  expect(h.evidence[0]?.violations).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  return h;
};

describe("SCRUM-350 STALE_UI handler: a correct product", () => {
  it("passes only after the ledger was read before, after the server-side reversal and after the stale click", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle).toMatchObject({ kind: "UI_BACKEND_AUTHORITY", passed: true });
    expect(result.artifacts).toEqual(["trace.zip", "final.png", "backend-state.json"]);

    // The order is the attack: action armed on the page, THEN the server-side reversal, THEN the late click.
    const order = h.world.calls.filter((call) =>
      ["ui:type reason", "owner:expenses:reverseExpense", "ui:click Reverse & Delete"].includes(call),
    );
    expect(order).toEqual(["ui:type reason", "owner:expenses:reverseExpense", "ui:click Reverse & Delete"]);
    // The late click really reached the backend and was refused there, not merely clicked.
    expect(h.world.calls).toContain("ui:expenses:reverseExpense");
    expect(h.world.calls.filter((call) => call === "owner:expenses:reverseExpense")).toHaveLength(1);
    expect(h.world.events.filter((row) => row.eventType === "JOURNAL_REVERSAL")).toHaveLength(1);

    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "STALE_UI",
      oracle: "UI_BACKEND_AUTHORITY",
      orgId: "org1",
      expenseId: "exp1",
      expectedCurrency: "JOD",
      violations: [],
      unjudged: [],
      observed: { actionArmedBeforeChange: true, actionAfterChange: "OFFERED", screenAnswer: "REFUSAL_TOAST" },
    });
    expect(h.opened).toHaveLength(1);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
  });

  it("plants a run-unique synthetic expense and keeps screen text out of the evidence", async () => {
    const h = harness();
    await h.run();
    expect(h.world.created).toHaveLength(1);
    expect(h.world.created[0]).toMatch(/^swarm-.+-posted$/);
    const text = JSON.stringify(h.evidence);
    expect(text).not.toContain("Expense not found");
    expect(text).not.toContain("Rate limit");
  });
});

describe("SCRUM-350 STALE_UI handler: breaches", () => {
  it("fails a stale screen that announces a reversal the backend had already made", async () => {
    await breach({ lyingScreen: true }, /announced a reversal although the expense had already been reversed/);
  });

  it("fails a backend that reverses the same posted expense a second time for the stale screen", async () => {
    const h = await breach({ secondReversalAccepted: true }, /reversal events/);
    expect(h.world.events.filter((row) => row.eventType === "JOURNAL_REVERSAL")).toHaveLength(2);
    expect(h.evidence[0]?.violations).toEqual(
      expect.arrayContaining([expect.stringMatching(/ledger across the stale reversal request changed/)]),
    );
  });

  it("fails a posting made in a currency other than the organization's", async () => {
    await breach({ wrongCurrency: true }, /organization's currency is JOD/);
  });

  it("still delivers a proven breach when browser evidence cleanup fails", async () => {
    const h = harness({ lyingScreen: true }, { finishFails: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed/);
  });
});

describe("SCRUM-350 STALE_UI handler: never a vacuous pass", () => {
  it("is INCONCLUSIVE for a silent screen, however clean the ledger is", async () => {
    await inconclusive({ silentScreen: true }, /gave no answer/);
  });

  it("is INCONCLUSIVE for a message that is not the product's expense-not-found refusal", async () => {
    await inconclusive({ unclassifiedToast: true }, /not the product's "Expense not found" refusal/);
  });

  it("is INCONCLUSIVE when the product closes the dialog itself, and says no stale click was taken", async () => {
    const h = await inconclusive({ dialogWithdraws: true }, /withdrew the reversal action/);
    expect(h.world.lateClicked).toBe(false);
  });

  it("is INCONCLUSIVE when the late click fails inside the browser", async () => {
    const h = await inconclusive({ lateClickThrows: true }, /gave no answer/);
    expect(h.evidence[0]).toMatchObject({ lateClickError: "Timeout 20000ms exceeded." });
  });

  it("is INCONCLUSIVE when the action was never armed, whatever the screen later says", async () => {
    await inconclusive({ neverArmed: true, lyingScreen: true }, /no armed stale action/);
  });

  it("is INCONCLUSIVE, and makes no reversal, when the screen cannot be driven to the armed action", async () => {
    const h = await inconclusive({ rowMissing: true }, /could not be driven to an armed Reverse & Delete/);
    expect(h.world.calls).not.toContain("owner:expenses:reverseExpense");
    expect(h.world.calls).not.toContain("ui:click Reverse & Delete");
  });

  it("is INCONCLUSIVE when the server-side reversal is refused, and never clicks the stale dialog", async () => {
    const h = await inconclusive({ serverReversalRateLimited: true }, /server-side reversal did not go through/);
    expect(h.world.calls).not.toContain("ui:click Reverse & Delete");
  });

  it("is INCONCLUSIVE when the server-side reversal leaves no reversal in the ledger", async () => {
    const h = await inconclusive({ serverReversalNoEffect: true, lyingScreen: true }, /did not settle/);
    expect(h.world.calls).not.toContain("ui:click Reverse & Delete");
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

describe("SCRUM-350 STALE_UI handler: mission contract", () => {
  it("refuses a mission whose oracle it does not judge", async () => {
    const h = harness({}, { oracle: "STATE_TRANSITION" });
    await expect(h.run()).rejects.toThrow(/STALE_UI does not judge the STATE_TRANSITION oracle/);
    expect(h.world.calls).toEqual([]);
  });
});
