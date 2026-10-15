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
 * SCRUM-849 ACC-3 — handler-level tests for ACCOUNTING_DATE_BOUNDARY judged by STATE_TRANSITION.
 *
 * The real handler runs end to end against a scripted two-seat backend that behaves like the product:
 * `approveManualJournal` posts a draft to its declared date in the period covering it and refuses a CLOSED
 * period with the product's own message. Every literal below is written out by hand, never taken from the
 * production scenario, and each fault flips exactly one fact of the product's behaviour. No browser is launched.
 */
interface Faults {
  /** The approval stamps the entry, and every line, with the approval time in the period covering today (the SCRUM-50 defect). */
  wrongDate?: boolean;
  /** Only the lines are stamped with the approval time. */
  lineWrongDate?: boolean;
  /** The entry is dated right but filed under the period covering today. */
  wrongPeriod?: boolean;
  /** Approving into the CLOSED period succeeds and writes the journal there. */
  closedAccepted?: boolean;
  /** Approving into the CLOSED period is refused, but the journal is posted into the open window anyway. */
  closedRetarget?: boolean;
  /** The closed-period refusal is stated, but a journal for the draft was written into this period (any period). */
  closedRefusedButWrittenIn?: string;
  /** Organization-wide journal rows are served without a status. */
  orgRowsWithoutStatus?: boolean;
  /** The closed-period refusal is stated, but the earlier posted journal was moved to another period, or voided. */
  closedMutatesExisting?: "period" | "status";
  /** The closed-period refusal is stated, but the draft's money and reviewer were changed while it stays pending. */
  closedAlteredByRefusal?: boolean;
  /** The pending list serves the refused draft with malformed lines. */
  pendingRowMalformed?: boolean;
  /** From the second organization-wide page on, `isDone` stays false while the cursor repeats the request's, or is empty. */
  cursorStalls?: "repeat" | "empty";
  /** The organization-wide journal list is not a page. */
  orgListMalformed?: boolean;
  /** Journal pages hold one row each, so only real cursor pagination reaches the last row. */
  smallPages?: boolean;
  /** The refusal consumes the draft. */
  closedConsumes?: boolean;
  /** The refusal reopens the closed period. */
  closedReopens?: boolean;
  /** The approval is refused for a reason that is not the closed period. */
  closedOtherRefusal?: boolean;
  /** The windows already exist, the closed one closed (a re-run on the same preview). */
  windowsExist?: boolean;
  /** The product refuses to prepare, to post or to close. */
  createRefused?: boolean;
  postRefused?: boolean;
  closeBlocked?: boolean;
  closeRefused?: boolean;
  /** The chart offers fewer than two accounts that accept manual posting. */
  fewAccounts?: boolean;
  seatsSplit?: boolean;
  screenFails?: boolean;
  /** Reads: the posted journal is absent, malformed, or a journal list is longer than a page. */
  journalMissing?: boolean;
  journalMalformed?: boolean;
  listTruncated?: boolean;
  periodListMalformed?: boolean;
  /** From this 1-based `accountingPeriods:list` call on, the closed window is missing from the list. */
  closedPeriodVanishesFromListCall?: number;
  /** The pending list is not an array. */
  pendingMalformed?: boolean;
  /** The approval returns no journal id. */
  noJournalId?: boolean;
}

interface Period {
  _id: string;
  startDate: number;
  endDate: number;
  status: string;
}

interface Line {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  accountingDate: number;
}

interface Entry {
  _id: string;
  memo: string;
  periodId: string;
  accountingDate: number;
  status: string;
  lines: Line[];
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

const FEB_2020 = { startDate: Date.UTC(2020, 1, 1), endDate: Date.UTC(2020, 2, 1) - 1 };
const JAN_2020 = { startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2020, 1, 1) - 1 };
const CLOSED_MESSAGE = "The accounting period covering 2020-01-15 is CLOSED. Manual journal posting not allowed.";

class World {
  readonly calls: string[] = [];
  readonly argsOf: { name: string; actor: string; args: Record<string, unknown> }[] = [];
  readonly periods = new Map<string, Period>();
  readonly drafts = new Map<string, Draft>();
  readonly entries = new Map<string, Entry>();
  private nextId = 0;
  private periodListCalls = 0;
  private listCalls = 0;

  constructor(readonly faults: Faults) {
    const now = new Date();
    this.periods.set("period-now", {
      _id: "period-now",
      startDate: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      endDate: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1,
      status: "OPEN",
    });
    if (faults.windowsExist) {
      this.periods.set("period-feb", { _id: "period-feb", ...FEB_2020, status: "OPEN" });
      this.periods.set("period-jan", { _id: "period-jan", ...JAN_2020, status: "CLOSED" });
    }
  }

  private id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  private covering(date: number): Period | undefined {
    return [...this.periods.values()].find((period) => period.startDate <= date && period.endDate >= date);
  }

  private post(draft: Draft, period: Period, accountingDate: number): string {
    const f = this.faults;
    const id = this.id("je");
    const stamped = f.wrongDate || f.lineWrongDate ? Date.now() : accountingDate;
    this.entries.set(id, {
      _id: id,
      memo: draft.memo,
      periodId: f.wrongPeriod ? "period-now" : period._id,
      accountingDate: f.wrongDate ? Date.now() : accountingDate,
      status: "POSTED",
      lines: draft.lines.map((line) => ({ ...line, accountingDate: stamped })),
    });
    draft.status = "POSTED";
    return id;
  }

  private approve(actor: string, draftId: string): unknown {
    const f = this.faults;
    const draft = this.drafts.get(draftId);
    if (!draft || draft.status !== "PENDING_APPROVAL") throw new ConvexError("This manual journal has already been resolved.");
    if (draft.createdBy === actor) throw new ConvexError("Manual journal reviewer cannot be the same as the poster.");
    if (f.postRefused && draft.accountingDate >= FEB_2020.startDate) throw new ConvexError("Rate limit exceeded. Try again in 3s.");
    const period = this.covering(draft.accountingDate);
    if (!period) throw new ConvexError("No accounting period covers that date.");
    if (period.status === "CLOSED" || period.status === "LOCKED") {
      if (f.closedOtherRefusal) throw new ConvexError("Rate limit exceeded. Try again in 3s.");
      if (f.closedAccepted) {
        const journalId = this.post(draft, period, draft.accountingDate);
        return { resourceId: journalId, journalId };
      }
      if (f.closedRefusedButWrittenIn !== undefined) {
        // The product states the closed-period refusal, yet a journal for this draft now sits in another period.
        this.post(draft, { ...period, _id: f.closedRefusedButWrittenIn }, draft.accountingDate);
        draft.status = "PENDING_APPROVAL";
        throw new ConvexError(CLOSED_MESSAGE);
      }
      if (f.closedMutatesExisting !== undefined) {
        // The closed-period refusal is stated, yet the journal posted earlier was moved or voided.
        const posted = [...this.entries.values()][0] as Entry;
        if (f.closedMutatesExisting === "period") posted.periodId = "period-mar";
        else posted.status = "VOIDED";
        throw new ConvexError(CLOSED_MESSAGE);
      }
      if (f.closedAlteredByRefusal) {
        draft.lines = draft.lines.map((line, index) => (index === 0 ? { ...line, debitMinor: line.debitMinor + 1 } : line));
        draft.reviewedBy = "manager";
        throw new ConvexError(CLOSED_MESSAGE);
      }
      if (f.closedRetarget) {
        const journalId = this.post(draft, this.periods.get("period-feb") as Period, draft.accountingDate);
        return { resourceId: journalId, journalId };
      }
      if (f.closedConsumes) draft.status = "REJECTED";
      if (f.closedReopens) period.status = "OPEN";
      throw new ConvexError(CLOSED_MESSAGE);
    }
    const journalId = this.post(draft, period, draft.accountingDate);
    return f.noJournalId ? { resourceId: journalId } : { resourceId: journalId, journalId };
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
              { _id: "acct-f", allowManualPosting: true, active: true },
              { _id: "acct-d", allowManualPosting: true, active: true },
              { _id: "acct-e", allowManualPosting: true, active: true },
            ];
      case "accountingPeriods:list": {
        this.periodListCalls += 1;
        if (f.periodListMalformed) return [{ _id: "p" }];
        const vanished = f.closedPeriodVanishesFromListCall !== undefined && this.periodListCalls >= f.closedPeriodVanishesFromListCall;
        return [...this.periods.values()].filter((period) => !(vanished && period._id === "period-jan"));
      }
      case "accountingPeriods:create": {
        const id = a.startDate === FEB_2020.startDate ? "period-feb" : "period-jan";
        this.periods.set(id, { _id: id, startDate: a.startDate as number, endDate: a.endDate as number, status: a.openImmediately ? "OPEN" : "FUTURE" });
        return id;
      }
      case "accountingPeriods:closeChecklist":
        return { canClose: !f.closeBlocked, blockers: f.closeBlocked ? ["1 manual journal entry is awaiting approval."] : [], warnings: [] };
      case "accountingPeriods:close": {
        if (f.closeRefused) throw new ConvexError("Forbidden: Only the organization owner can close a period that has open blockers.");
        if (!Array.isArray(a.acknowledgedWarnings)) throw new ConvexError("every warning must be acknowledged");
        if ([...this.drafts.values()].some((draft) => draft.status === "PENDING_APPROVAL")) {
          throw new ConvexError("This period cannot be closed yet: 1 manual journal entry is awaiting approval.");
        }
        (this.periods.get(String(a.periodId)) as Period).status = "CLOSED";
        return a.periodId;
      }
      case "financialAudit:createManualJournal": {
        if (f.createRefused) throw new ConvexError("A manual journal must state the accounting date the entry belongs to.");
        if (typeof a.accountingDate !== "number") throw new ConvexError("A manual journal must state the accounting date the entry belongs to.");
        const draftId = this.id("draft");
        this.drafts.set(draftId, {
          id: draftId,
          memo: String(a.memo),
          accountingDate: a.accountingDate,
          lines: a.lines as Draft["lines"],
          status: "PENDING_APPROVAL",
          createdBy: actor,
        });
        return { alreadyCreated: false, draftId };
      }
      case "financialAudit:approveManualJournal":
        return this.approve(actor, String(a.draftId));
      case "financialAudit:rejectManualJournal": {
        const draft = this.drafts.get(String(a.draftId));
        if (!draft || draft.status !== "PENDING_APPROVAL") throw new ConvexError("This manual journal has already been resolved.");
        draft.status = "REJECTED";
        return null;
      }
      case "financialAudit:listPendingManualJournals":
        if (f.pendingMalformed) return { drafts: [] };
        // The full pending draft document, as the product serves it, plus the preparer's display name.
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
      case "accountingLedger:getJournalEntry": {
        const entry = this.entries.get(String(a.journalEntryId));
        if (!entry || f.journalMissing) return null;
        if (f.journalMalformed) return { entry: "not an entry" };
        const { lines, ...header } = entry;
        return { entry: header, lines, event: null, period: null };
      }
      case "accountingLedger:listJournalEntries": {
        this.listCalls += 1;
        if (f.listTruncated) return { page: [], isDone: false, continueCursor: `more-${this.listCalls}` };
        if (f.orgListMalformed && a.periodId === undefined) return "not a page";
        if (f.cursorStalls !== undefined && a.periodId === undefined) {
          const requested = (a.paginationOpts as { cursor: string | null }).cursor;
          if (requested === null) return { page: [], isDone: false, continueCursor: "1" };
          return { page: [], isDone: false, continueCursor: f.cursorStalls === "repeat" ? requested : "" };
        }
        // Insertion order, served through a real cursor: the cursor is the offset of the next row.
        const rows = [...this.entries.values()]
          .filter((entry) => a.periodId === undefined || entry.periodId === a.periodId)
          .map(({ lines: _lines, ...header }) => (f.orgRowsWithoutStatus && a.periodId === undefined ? { ...header, status: undefined } : header));
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
      const fake = new FakePage(world, seat, faults.seatsSplit && seat === "approver" ? "org-other" : "org1");
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

describe("SCRUM-849 ACC-3 accounting-date handler: the discriminating scenario", () => {
  it("PASSES a correct product: the declared date posts to its period and the closed period refuses", async () => {
    const h = harness();
    const result = (await h.run()) as { oracle: { passed: boolean; kind: string; summary: string } };
    expect(result.oracle).toMatchObject({ passed: true, kind: "STATE_TRANSITION" });
    expect(h.opened.map((entry) => entry.seat).sort()).toEqual(["approver", "primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    expect(h.world.calls).toContain("ui:goto /org1/accounting");
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "ACCOUNTING_DATE_BOUNDARY",
      oracle: "STATE_TRANSITION",
      refused: { entriesInClosedBefore: [], entriesInClosedAfter: [], draftStillPending: true },
      unjudged: [],
      violations: [],
    });
    // What the scenario did not exercise is stated, so no result is read as more than it proved.
    expect(h.evidence[0]?.notExercised).toEqual([
      "MANUAL_JOURNAL_FORM",
      "LOCKED_PERIOD",
      "UNOPENED_OR_UNCOVERED_PERIOD",
      "OUTBOX_POSTING",
      "PERIOD_REOPEN",
    ]);
    expect(result.oracle.summary).toMatch(/Not read: the manual-journal form, a LOCKED period/);
  });

  it("drives the public commands in order: the closed window is closed before any draft exists, and the poster never approves", async () => {
    const h = harness();
    await h.run();
    const names = h.world.calls.filter((call) => /accountingPeriods:|financialAudit:/.test(call));
    const firstDraft = names.indexOf("owner:financialAudit:createManualJournal");
    expect(names.indexOf("owner:accountingPeriods:close")).toBeGreaterThan(-1);
    expect(names.indexOf("owner:accountingPeriods:close")).toBeLessThan(firstDraft);
    expect(names.filter((call) => call === "owner:financialAudit:createManualJournal")).toHaveLength(2);
    expect(names.filter((call) => call === "manager:financialAudit:approveManualJournal")).toHaveLength(2);
    expect(names.filter((call) => /owner:financialAudit:approveManualJournal/.test(call))).toEqual([]);
    const drafts = h.world.argsOf.filter((entry) => entry.name === "financialAudit:createManualJournal");
    expect(drafts.map((entry) => entry.args.accountingDate)).toEqual([Date.UTC(2020, 1, 15, 12), Date.UTC(2020, 0, 15, 12)]);
    // The first two eligible accounts: not the inactive, currency-restricted or non-manual ones.
    for (const draft of drafts) {
      expect(draft.args.lines).toEqual([
        { accountId: "acct-d", debitMinor: 12_345, creditMinor: 0 },
        { accountId: "acct-e", debitMinor: 0, creditMinor: 12_345 },
      ]);
    }
    const periods = h.world.argsOf.filter((entry) => entry.name === "accountingPeriods:create");
    expect(periods.map((entry) => [entry.args.fiscalYear, entry.args.periodNumber, entry.args.openImmediately])).toEqual([
      [2020, 1, true],
      [2020, 2, true],
    ]);
    const close = h.world.argsOf.find((entry) => entry.name === "accountingPeriods:close");
    expect(close?.args).not.toHaveProperty("overrideReason");
    // The refused draft is rejected at cleanup so it cannot hold up a later period close.
    const closedDraft = [...h.world.drafts.values()].find((draft) => draft.accountingDate === Date.UTC(2020, 0, 15, 12));
    expect(closedDraft?.status).toBe("REJECTED");
    expect(h.world.calls).toContain("manager:financialAudit:rejectManualJournal");
  });

  it("PASSES on a re-run: existing windows are reused, nothing is created or closed again", async () => {
    const h = harness({ windowsExist: true });
    const result = (await h.run()) as { oracle: { passed: boolean } };
    expect(result.oracle.passed).toBe(true);
    expect(h.world.calls.filter((call) => /accountingPeriods:(create|close)/.test(call))).toEqual([]);
  });
});

describe("SCRUM-849 ACC-3 accounting-date handler: wrong-date negative controls", () => {
  it("FAILS a journal stamped with the approval time (the SCRUM-50 defect)", async () => {
    await breach(
      { wrongDate: true },
      /the entry carries accountingDate \d+, not the declared 1581768000000, the approval time/,
      /line 1 carries accountingDate \d+, not the declared 1581768000000/,
    );
  });

  it("FAILS a journal whose lines alone are stamped with the approval time", async () => {
    await breach({ lineWrongDate: true }, /line 1 carries accountingDate \d+, not the declared 1581768000000/);
  });

  it("FAILS a journal dated right but filed under the period covering today", async () => {
    await breach({ wrongPeriod: true }, /the entry sits in period period-now, not period-feb/);
  });
});

describe("SCRUM-849 ACC-3 accounting-date handler: closed-period negative controls", () => {
  it("FAILS an approval into the CLOSED period that was accepted and wrote the journal there", async () => {
    await breach(
      { closedAccepted: true },
      /approving a draft dated into the CLOSED period was accepted/,
      /the closed period now holds journal\(s\) \[je\d+\]/,
    );
  });

  it("FAILS a refused-looking approval that retargeted the journal into the open window", async () => {
    await breach({ closedRetarget: true }, /approving a draft dated into the CLOSED period was accepted/, /the refused journal was posted anyway, into period period-feb/);
  });

  it("FAILS a refusal that consumed the draft, and one that reopened the period", async () => {
    await breach({ closedConsumes: true }, /the refused draft is no longer pending/);
    await breach({ closedReopens: true }, /the closed period is OPEN after the refused approval/);
  });

  // The two windows are not the whole ledger: a journal written for the refused draft into ANY period must be seen.
  it("FAILS a refusal that silently wrote the journal into a THIRD period, found through real cursor pagination", async () => {
    const h = await breach(
      { closedRefusedButWrittenIn: "period-mar", smallPages: true },
      /the refused journal was posted anyway, into period period-mar as je\d+(?!\d|, outside)/,
    );
    // The organization-wide reads carry no periodId and walk the cursor chain to the end.
    const orgReads = h.world.argsOf.filter((entry) => entry.name === "accountingLedger:listJournalEntries" && entry.args.periodId === undefined);
    expect(orgReads.length).toBeGreaterThanOrEqual(3);
    expect(orgReads.map((entry) => (entry.args.paginationOpts as { cursor: string | null }).cursor)).toContain("1");
  });

  it("FAILS the same third-period write with full-size pages", async () => {
    await breach({ closedRefusedButWrittenIn: "period-mar" }, /posted anyway, into period period-mar/);
  });

  it("PASSES a correct product whose journal pages hold one row each", async () => {
    const result = (await harness({ smallPages: true }).run()) as { oracle: { passed: boolean } };
    expect(result.oracle.passed).toBe(true);
  });

  it("FAILS a refusal that altered the still-pending draft's money and reviewer", async () => {
    await breach({ closedAlteredByRefusal: true }, /the refused draft's lines changed from/, /the refused draft's reviewedBy changed from nothing to manager/);
  });
});

describe("SCRUM-849 ACC-3 accounting-date handler: never a pass without a judged outcome", () => {
  it("is INCONCLUSIVE when the closed-period approval is refused for another reason", async () => {
    await inconclusive({ closedOtherRefusal: true }, /approving a draft dated into the CLOSED period: failed for a reason that is not an authorization refusal/);
  });

  it("is INCONCLUSIVE when the product refuses the setup, the first posting or the close", async () => {
    await inconclusive({ createRefused: true }, /the product refused to prepare the declared manual journal: A manual journal must state/);
    await inconclusive({ postRefused: true }, /the product refused to post the journal declared inside the open window: Rate limit exceeded/);
    await inconclusive({ closeRefused: true }, /the product refused to close the closed window: Forbidden/);
  });

  it("is INCONCLUSIVE when the closed window cannot close without an override, never closing it by force", async () => {
    const h = await inconclusive({ closeBlocked: true }, /could not be closed without an override/);
    expect(h.world.calls).not.toContain("owner:accountingPeriods:close");
    expect(h.world.calls).not.toContain("owner:financialAudit:createManualJournal");
  });

  it("is INCONCLUSIVE, with nothing seeded, when the chart has fewer than two manual-posting accounts or the seats are split", async () => {
    const few = await inconclusive({ fewAccounts: true }, /fewer than two active, currency-free accounts/);
    expect(few.world.calls.filter((call) => /financialAudit:|accountingPeriods:/.test(call))).toEqual([]);
    const split = await inconclusive({ seatsSplit: true }, /approver seat signed in to a different organization/);
    expect(split.world.calls).toEqual([]);
  });

  it("is INCONCLUSIVE when a read is absent, malformed or truncated: the posted journal, the period list, a journal list, the pending list", async () => {
    // An absent posted journal is unjudged, not clean: the mission cannot pass.
    await inconclusive({ journalMissing: true }, /the posted journal was not read/);
    await inconclusive({ journalMalformed: true }, /getJournalEntry returned a malformed response/);
    await inconclusive({ periodListMalformed: true }, /accountingPeriods\.list returned a malformed period/);
    await inconclusive({ listTruncated: true }, /could not be read to completion/);
    await inconclusive({ orgListMalformed: true }, /journals of the organization.* malformed/);
    // isDone stays false but the cursor makes no progress: never a partial list judged as complete.
    await inconclusive({ cursorStalls: "repeat" }, /journals of the organization came back malformed: no cursor to continue from/);
    await inconclusive({ cursorStalls: "empty" }, /journals of the organization came back malformed: no cursor to continue from/);
    await inconclusive({ pendingRowMalformed: true }, /refused draft was not read before the approval/);
    await inconclusive({ noJournalId: true }, /approveManualJournal returned no journal id/);
    const pending = await settle(harness({ pendingMalformed: true }));
    expect(pending).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((pending as Error).message).toMatch(/listPendingManualJournals returned a non-array response/);
  });

  // Reread calls: 1 readWindow(closed), 2 readWindow(open), 3 the reread after closing (fresh preview) or before the
  // refused approval (re-run). A reread that returns nothing must never fall back to the stale pre-close period.
  it("is INCONCLUSIVE when the closed window disappears on the reread after it was closed", async () => {
    const h = await inconclusive({ closedPeriodVanishesFromListCall: 3 }, /closed window was not readable again after it was closed/);
    expect(h.world.calls).not.toContain("owner:financialAudit:createManualJournal");
  });

  it("is INCONCLUSIVE when the closed window disappears on the reread before the refused approval", async () => {
    const h = await inconclusive({ windowsExist: true, closedPeriodVanishesFromListCall: 3 }, /closed window was not readable again before the refused approval/);
    expect(h.world.argsOf.filter((entry) => entry.name === "financialAudit:approveManualJournal" && entry.actor === "manager")).toHaveLength(1);
  });

  it("is INCONCLUSIVE, never a pass, when an existing journal was moved or voided during the refused approval", async () => {
    await inconclusive({ closedMutatesExisting: "period" }, /existing journal\(s\) \[je\d+ \(periodId\)\] changed during the refused approval/);
    await inconclusive({ closedMutatesExisting: "status" }, /existing journal\(s\) \[je\d+ \(status\)\] changed during the refused approval/);
  });

  it("is INCONCLUSIVE when a journal row on the organization-wide read carries no readable status", async () => {
    await inconclusive({ orgRowsWithoutStatus: true }, /carry no readable status/);
  });

  it("is INCONCLUSIVE when the accounting screen cannot be opened for the screenshot", async () => {
    await inconclusive({ screenFails: true }, /accounting screen could not be opened for the screenshot/);
  });

  it("still reports a proven breach when the accounting screen cannot be opened for the screenshot", async () => {
    const h = await breach({ wrongDate: true, screenFails: true }, /not the declared/);
    // The breach is PARTIAL: proven, with the unreachable screen recorded beside it as unjudged.
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      phase: "PARTIAL",
      violations: expect.arrayContaining([expect.stringMatching(/not the declared/)]),
      unjudged: [expect.stringMatching(/accounting screen could not be opened for the screenshot/)],
    });
  });

  it("refuses a mission for an oracle the scenario does not judge, before touching the backend", async () => {
    const h = harness({}, { oracle: "TENANT_ISOLATION" });
    await expect(h.run()).rejects.toThrow(/does not judge the TENANT_ISOLATION oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("does not hide a proven breach behind a browser-cleanup failure", async () => {
    const result = (await harness({ wrongDate: true }, { finishFails: true }).run()) as { oracle: { passed: boolean; summary: string } };
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
    expect(h.world.calls.filter((call) => /financialAudit:|accountingPeriods:/.test(call))).toEqual([]);
  });
});
