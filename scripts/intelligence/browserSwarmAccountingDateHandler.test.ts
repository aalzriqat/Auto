import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { createAccountingDateAttackHandlers } from "./browserSwarmAccountingDateAttack";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-795 (retargeting SCRUM-849 ACC-3) — handler-level tests for ACCOUNTING_DATE_BOUNDARY judged by
 * STATE_TRANSITION, now an EXPECTED-REFUSAL attack on the CREATE door only: manual journals are off for the pilot, so
 * `createManualJournal` must be refused with the pilot message and change nothing. The approve door is out of this
 * mission's scope (the swarm lane never holds the legacy draft); it is covered by
 * convex/manualJournalsPilotOff.scrum795.test.ts and the trusted-main E2E.
 *
 * The real handler runs end to end against a scripted two-seat backend. Every literal below is written out by
 * hand, never taken from the production scenario, and each fault flips exactly one fact of the product's
 * behaviour. No browser is launched.
 */
interface Faults {
  /** There is no legacy pending draft on the preview (every preview but trusted-main E2E). */
  noLegacyDraft?: boolean;
  /** The switch is off for create only: the draft is prepared. */
  createAccepted?: boolean;
  /** Create is refused, but for a reason that is not the pilot switch. */
  createOtherRefusal?: boolean;
  /** Create is refused with the pilot message, yet a journal carrying the memo was posted. */
  createConsumesDraft?: boolean;
  createAltersDraft?: boolean;
  createWritesJournal?: boolean;
  /** Create is refused with the pilot message, yet a draft carrying the memo was prepared. */
  createWritesDraft?: boolean;
  /** Another source writes a journal during the attempts (not the refused memo). */
  strayJournalAppears?: boolean;
  /** Another source changes an existing journal during the attempts. */
  existingJournalChanges?: boolean;
  /** The organization-wide journal list is not a page. */
  orgListMalformed?: boolean;
  /** The pending list is not an array. */
  pendingMalformed?: boolean;
  /** The pending list serves the legacy draft with malformed lines. */
  pendingRowMalformed?: boolean;
  /** Journal pages hold one row each, so only real cursor pagination reaches the last row. */
  smallPages?: boolean;
  /** The chart offers fewer than two accounts that accept manual posting. */
  fewAccounts?: boolean;
  screenFails?: boolean;
}

interface Draft {
  id: string;
  memo: string;
  accountingDate: number;
  lines: { accountId: string; debitMinor: number; creditMinor: number }[];
  status: string;
  createdBy: string;
  reviewedBy?: string;
}

interface Entry {
  _id: string;
  memo: string;
  periodId: string;
  accountingDate: number;
  status: string;
}

const PILOT_MESSAGE = "Manual journal entries are turned off during the pilot. Nothing has been changed.";
const LEGACY_DATE = Date.UTC(2026, 6, 1, 12);

class World {
  readonly calls: string[] = [];
  readonly argsOf: { name: string; actor: string; args: Record<string, unknown> }[] = [];
  readonly drafts = new Map<string, Draft>();
  readonly entries = new Map<string, Entry>();
  private nextId = 0;

  constructor(readonly faults: Faults) {
    this.entries.set("je-existing", { _id: "je-existing", memo: "sale 1", periodId: "period-now", accountingDate: LEGACY_DATE, status: "POSTED" });
    if (!faults.noLegacyDraft) {
      this.drafts.set("draft-legacy", {
        id: "draft-legacy",
        memo: "legacy pending draft",
        accountingDate: LEGACY_DATE,
        lines: [
          { accountId: "acct-x", debitMinor: 500, creditMinor: 0 },
          { accountId: "acct-y", debitMinor: 0, creditMinor: 500 },
        ],
        status: "PENDING_APPROVAL",
        createdBy: "owner",
      });
    }
  }

  private id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  private addEntry(memo: string): string {
    const id = this.id("je");
    this.entries.set(id, { _id: id, memo, periodId: "period-now", accountingDate: Date.now(), status: "POSTED" });
    return id;
  }

  private create(actor: string, a: Record<string, unknown>): unknown {
    const f = this.faults;
    if (f.createOtherRefusal) throw new ConvexError("Rate limit exceeded. Try again in 3s.");
    if (f.createAccepted) {
      const draftId = this.id("draft");
      this.drafts.set(draftId, { id: draftId, memo: String(a.memo), accountingDate: Number(a.accountingDate), lines: a.lines as Draft["lines"], status: "PENDING_APPROVAL", createdBy: actor });
      return { alreadyCreated: false, draftId };
    }
    if (f.createConsumesDraft) this.drafts.get("draft-legacy")!.status = "REJECTED";
    if (f.createAltersDraft) {
      const legacy = this.drafts.get("draft-legacy")!;
      legacy.lines = legacy.lines.map((line, index) => (index === 0 ? { ...line, debitMinor: line.debitMinor + 1 } : line));
    }
    if (f.createWritesJournal) this.addEntry(String(a.memo));
    if (f.createWritesDraft) {
      const draftId = this.id("draft");
      this.drafts.set(draftId, { id: draftId, memo: String(a.memo), accountingDate: Number(a.accountingDate), lines: a.lines as Draft["lines"], status: "PENDING_APPROVAL", createdBy: actor });
    }
    if (f.strayJournalAppears) this.addEntry("someone else's sale");
    if (f.existingJournalChanges) (this.entries.get("je-existing") as Entry).status = "VOIDED";
    throw new ConvexError({ code: "MANUAL_JOURNALS_DISABLED", message: PILOT_MESSAGE });
  }

  call(actor: "owner" | "manager", name: string, a: Record<string, unknown>): unknown {
    this.calls.push(`${actor}:${name}`);
    this.argsOf.push({ name, actor, args: a });
    const f = this.faults;
    switch (name) {
      case "chartOfAccounts:list":
        return f.fewAccounts
          ? [{ _id: "acct-d", allowManualPosting: true, active: true }]
          : [
              { _id: "acct-a-inactive", allowManualPosting: true, active: false },
              { _id: "acct-b-restricted", allowManualPosting: true, active: true, currencyRestriction: "USD" },
              { _id: "acct-c-system", allowManualPosting: false, active: true },
              { _id: "acct-d", allowManualPosting: true, active: true },
              { _id: "acct-e", allowManualPosting: true, active: true },
            ];
      case "financialAudit:createManualJournal":
        return this.create(actor, a);
      case "financialAudit:listPendingManualJournals":
        if (f.pendingMalformed) return { drafts: [] };
        return [...this.drafts.values()]
          .filter((d) => d.status === "PENDING_APPROVAL")
          .map((d) => ({
            _id: d.id,
            _creationTime: 1,
            orgId: "org1",
            status: d.status,
            memo: d.memo,
            lines: f.pendingRowMalformed ? "not an array" : d.lines,
            accountingDate: d.accountingDate,
            idempotencyKey: `key-${d.id}`,
            createdBy: d.createdBy,
            createdAt: 1,
            ...(d.reviewedBy === undefined ? {} : { reviewedBy: d.reviewedBy }),
            creatorName: "Owner",
          }));
      case "accountingLedger:listJournalEntries": {
        if (f.orgListMalformed) return "not a page";
        const rows = [...this.entries.values()];
        const options = a.paginationOpts as { numItems: number; cursor: string | null };
        const start = options.cursor === null ? 0 : Number(options.cursor);
        const next = start + (f.smallPages ? 1 : options.numItems);
        return { page: rows.slice(start, next), isDone: next >= rows.length, continueCursor: next >= rows.length ? "end" : String(next) };
      }
      default:
        throw new Error(`unscripted backend call ${name}`);
    }
  }
}

class FakePage {
  constructor(
    private readonly world: World,
    readonly seat: MissionSeat,
    readonly resolvedOrgId: string,
  ) {}

  async goto(url: string): Promise<void> {
    if (this.world.faults.screenFails) throw new Error("Timeout 15000ms exceeded.");
    this.world.calls.push(`ui:goto ${url}`);
  }
}

function harness(faults: Faults = {}, options: { signal?: AbortSignal; finishFails?: boolean; oracle?: string } = {}) {
  const world = new World(faults);
  const evidence: Record<string, unknown>[] = [];
  const opened: { seat: MissionSeat; finished: boolean }[] = [];
  const pages = new Map<Page, FakePage>();
  const runtimeApi: MissionBrowserRuntime = {
    open: async (_context, seat = "primary") => {
      const fake = new FakePage(world, seat, "org1");
      const page = fake as unknown as Page;
      pages.set(page, fake);
      const entry = { seat, finished: false };
      opened.push(entry);
      const runtime: MissionBrowser = {
        browser: {} as MissionBrowser["browser"],
        browserContext: { entry } as unknown as MissionBrowser["browserContext"],
        page,
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
    resolveOrgRoute: async (page) => pages.get(page)!.resolvedOrgId,
    authenticatedClient: async (page) => {
      const actor = pages.get(page)!.seat === "primary" ? "owner" : "manager";
      const run = (ref: FunctionReference<"query" | "mutation">, args: Record<string, unknown>) =>
        Promise.resolve().then(() => world.call(actor, getFunctionName(ref), args));
      return { query: run, mutation: run } as unknown as ConvexHttpClient;
    },
  };
  const context = {
    manifest: { runId: "run-1" },
    worker: { workerId: "worker-1" },
    mission: { id: "mission-1", family: "ACCOUNTING_DATE_BOUNDARY", oracle: options.oracle ?? "STATE_TRANSITION" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createAccountingDateAttackHandlers(runtimeApi, {
    sleep: async () => undefined,
    pollMs: 1,
    postingWaitMs: 500,
    uiSettleMs: 0,
  }).ACCOUNTING_DATE_BOUNDARY;
  if (!handler) throw new Error("no handler registered for ACCOUNTING_DATE_BOUNDARY");
  return { run: () => handler(context), world, evidence, opened };
}

const settle = (h: { run: () => Promise<unknown> }): Promise<unknown> => h.run().catch((thrown: unknown) => thrown);

/** Asserts the mission ended INCONCLUSIVE for `pattern`, with its evidence written and every seat finished. */
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

const breach = async (faults: Faults, ...patterns: RegExp[]) => {
  const h = harness(faults);
  const result = (await h.run()) as { oracle: { passed: boolean; summary: string } };
  expect(result.oracle.passed).toBe(false);
  for (const pattern of patterns) expect(result.oracle.summary).toMatch(pattern);
  return h;
};

describe("SCRUM-795 manual-journals-off handler: the discriminating scenario (create door only)", () => {
  it("PASSES a correct product: create is refused with the pilot message and nothing changes", async () => {
    const h = harness();
    const result = (await h.run()) as { oracle: { passed: boolean; kind: string; summary: string } };
    expect(result.oracle).toMatchObject({ passed: true, kind: "STATE_TRANSITION" });
    expect(h.opened.map((entry) => entry.seat)).toEqual(["primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    expect(h.world.calls).toContain("ui:goto /org1/accounting");
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "ACCOUNTING_DATE_BOUNDARY",
      oracle: "STATE_TRANSITION",
      createAttempt: { kind: "REFUSED" },
      unjudged: [],
      violations: [],
    });
    expect(h.evidence[0]?.notExercised).toEqual(["APPROVE_DOOR", "MANUAL_JOURNAL_FORM", "POSTING_RULES_WHILE_OFF", "LOCKED_PERIOD", "OUTBOX_POSTING", "PERIOD_REOPEN"]);
    expect(result.oracle.summary).toMatch(/Not read: the approveManualJournal door/);
  });

  it("attempts create as the owner on a well-formed request, and never calls or claims approve", async () => {
    const h = harness();
    await h.run();
    expect(h.world.calls.filter((call) => /financialAudit:(create|approve)/.test(call))).toEqual(["owner:financialAudit:createManualJournal"]);
    const create = h.world.argsOf.find((entry) => entry.name === "financialAudit:createManualJournal");
    // A well-formed balanced request on the first two eligible accounts: not the inactive, restricted or non-manual ones.
    expect(create?.args.lines).toEqual([
      { accountId: "acct-d", debitMinor: 12_345, creditMinor: 0 },
      { accountId: "acct-e", debitMinor: 0, creditMinor: 12_345 },
    ]);
    expect(create?.args.accountingDate).toBe(Date.UTC(2020, 1, 15, 12));
    expect(h.evidence[0]).not.toHaveProperty("approveAttempt");
    expect(h.world.calls.filter((call) => /reject|accountingPeriods:/.test(call))).toEqual([]);
  });

  it("PASSES the same on a preview with no legacy pending draft, because the mission no longer claims the approve door", async () => {
    const result = (await harness({ noLegacyDraft: true }).run()) as { oracle: { passed: boolean } };
    expect(result.oracle.passed).toBe(true);
  });

  it("PASSES a correct product whose journal pages hold one row each", async () => {
    const result = (await harness({ smallPages: true }).run()) as { oracle: { passed: boolean } };
    expect(result.oracle.passed).toBe(true);
  });
});

describe("SCRUM-795 manual-journals-off handler: negative controls", () => {
  it("FAILS a create that was accepted and prepared a draft", async () => {
    await breach({ createAccepted: true }, /preparing a manual journal while manual journals are off was accepted/);
  });

  it("FAILS a refused-looking create that posted a journal carrying its memo", async () => {
    await breach({ createWritesJournal: true }, /journal carrying the refused memo was posted anyway/);
  });

  it("FAILS a refused-looking create that prepared a draft carrying its memo", async () => {
    await breach({ createWritesDraft: true }, /draft carrying the refused memo was prepared anyway/);
  });

  it("FAILS a refused create that consumed an existing pending draft", async () => {
    await breach({ createConsumesDraft: true }, /left the pending list/);
  });

  it("FAILS a refused create that altered an existing pending draft", async () => {
    await breach({ createAltersDraft: true }, /lines changed/);
  });

  it("FAILS the same breach found through real cursor pagination", async () => {
    await breach({ smallPages: true, createWritesJournal: true }, /journal carrying the refused memo was posted anyway/);
  });
});

describe("SCRUM-795 manual-journals-off handler: a claim that cannot be observed FAILS (AGENTS.md: cannot run is a failure, never a skip)", () => {
  const notIncomplete = (h: ReturnType<typeof harness>) => {
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).not.toMatchObject({ outcome: "INCONCLUSIVE" });
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
  };

  it("FAILS when create is refused for another reason than the pilot switch", async () => {
    const h = await breach({ createOtherRefusal: true }, /preparing a manual journal while manual journals are off was not exercised: it failed for a reason other than the pilot refusal/);
    notIncomplete(h);
  });

  it("FAILS, with nothing attempted, when the chart has fewer than two manual-posting accounts", async () => {
    const h = await breach({ fewAccounts: true }, /nothing was attempted/, /never observed/);
    expect(h.world.calls.filter((call) => /financialAudit:/.test(call))).toEqual([]);
    notIncomplete(h);
  });

  it("FAILS when the pending list cannot be read, so unchanged drafts were never observed", async () => {
    const h = await breach({ pendingMalformed: true }, /pending drafts could not be read/);
    notIncomplete(h);
  });

  it("FAILS when the pending list holds a malformed row", async () => {
    const h = await breach({ pendingRowMalformed: true }, /pending drafts could not be read/);
    notIncomplete(h);
  });

  it("FAILS when the organization journal list is malformed, so an unchanged ledger was never observed", async () => {
    const h = await breach({ orgListMalformed: true }, /journals could not be read/);
    notIncomplete(h);
  });
});

describe("SCRUM-795 manual-journals-off handler: inconclusive, never a pass", () => {
  it("is INCONCLUSIVE when another source writes a journal during the attempt", async () => {
    await inconclusive({ strayJournalAppears: true }, /no link to another source/);
  });

  it("is INCONCLUSIVE when an existing journal changes during the attempt", async () => {
    await inconclusive({ existingJournalChanges: true }, /changed during the refused approval/);
  });

  it("is INCONCLUSIVE when the accounting screen cannot be opened for the screenshot", async () => {
    await inconclusive({ screenFails: true }, /accounting screen could not be opened for the screenshot/);
  });

  it("still reports a proven breach when the accounting screen cannot be opened for the screenshot", async () => {
    const h = await breach({ createAccepted: true, screenFails: true }, /was accepted/);
    // The breach is PARTIAL: proven, with the unreachable screen recorded beside it as unjudged.
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      phase: "PARTIAL",
      violations: expect.arrayContaining([expect.stringMatching(/was accepted/)]),
      unjudged: [expect.stringMatching(/accounting screen could not be opened for the screenshot/)],
    });
  });

  it("refuses a mission for an oracle the scenario does not judge, before touching the backend", async () => {
    const h = harness({}, { oracle: "TENANT_ISOLATION" });
    await expect(h.run()).rejects.toThrow(/does not judge the TENANT_ISOLATION oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("does not hide a proven breach behind a browser-cleanup failure", async () => {
    const result = (await harness({ createAccepted: true }, { finishFails: true }).run()) as { oracle: { passed: boolean; summary: string } };
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed/);
  });

  it("refuses a pass whose browser evidence could not be captured", async () => {
    const error = await settle(harness({}, { finishFails: true }));
    expect(String((error as Error).message)).toMatch(/browser evidence cleanup failed/);
  });

  it("stops touching the preview once aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timeout"));
    const h = harness({}, { signal: controller.signal });
    await expect(h.run()).rejects.toThrow();
    expect(h.world.calls.filter((call) => /financialAudit:/.test(call))).toEqual([]);
  });
});
