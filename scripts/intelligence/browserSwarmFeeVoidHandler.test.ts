import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";
import { createMoneyBoundaryAttackHandlers } from "./browserSwarmMoneyBoundaryAttack";

/**
 * SCRUM-350 LIFE-1 — handler-level tests for MONEY_BOUNDARY judged by STATE_TRANSITION.
 *
 * The real handler runs end to end against a scripted two-seat backend. The scenario: two
 * dealership-paid ownership-transfer costs (50 and 20 JOD, scale 1,000) on one approved deal, the
 * first reconciled, both paid directly by bank transfer. Voiding the first must reverse its 50,000
 * payment exactly once and touch nothing else. Every literal below is written out by hand, never
 * taken from the production scenario, and each fault flips exactly one fact of the product's
 * behaviour. No browser is launched.
 */
interface Faults {
  /** The void leaves the payment on the books. */
  noReversal?: boolean;
  /** The reversal carries no link to the payment it takes back. */
  unlinkedReversal?: boolean;
  /** The reversal is one minor unit short. */
  shortReversal?: boolean;
  /** The reversal repeats the payment's sides instead of mirroring them. */
  sameSideReversal?: boolean;
  /** The original stays POSTED, not linked forward to its reversal. */
  originalNotMarked?: boolean;
  /** The void rewrites the posted journal in place. */
  originalRewritten?: boolean;
  /** A repeated void reverses again. */
  repeatReverses?: boolean;
  /** A repeated void is refused. */
  repeatRefused?: boolean;
  /** The void re-posts the payment after reversing it. */
  repost?: boolean;
  /** The void also takes the other cost's payment back. */
  siblingReversed?: boolean;
  /** The voided cost stays a live line on the deal. */
  voidedLineStays?: boolean;
  /** The other cost's line loses its direct payment when the first is voided. */
  siblingLineLosesPayment?: boolean;
  /** The payment is credited to cash instead of the bank. */
  paidToCash?: boolean;
  /** The payment never leaves PENDING. */
  neverPosts?: boolean;
  /** The reversal is queued and never drains (no period open). */
  reversalPending?: boolean;
  /** The product refuses the cost / the reconcile / the payment. */
  feeRefused?: boolean;
  reconcileRefused?: boolean;
  payRefused?: boolean;
  /** The product refuses to create the bank the payments name. */
  bankCreateRefused?: boolean;
  /** The product refuses the first void. */
  voidRefused?: boolean;
  noSettings?: boolean;
  unknownCurrency?: boolean;
  seatsSplit?: boolean;
  screenFails?: boolean;
  /** The chart cannot name the bank account. */
  bankUnnamed?: boolean;
}

interface Line {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  currency: string;
  scale: number;
}

interface Event {
  _id: string;
  sourceId: string;
  eventType: string;
  status: string;
  journalEntryId: string;
  reversalOfEventId?: string;
  reversedByEventId?: string;
}

interface Fee {
  amount: number;
  paid: boolean;
  voided: boolean;
}

const ACCOUNTS = ["OWNERSHIP_TRANSFER_EXPENSE", "BANK_ACCOUNT", "CASH_ON_HAND"];

class World {
  readonly calls: string[] = [];
  readonly argsOf: { name: string; args: Record<string, unknown> }[] = [];
  readonly fees = new Map<string, Fee>();
  private readonly events: Event[] = [];
  private readonly journals = new Map<string, Line[]>();
  private nextId = 0;
  private voids = 0;

  constructor(readonly faults: Faults) {}

  id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  private line(key: string, debitMinor: number, creditMinor: number): Line {
    return { accountId: `acct-${key}`, debitMinor, creditMinor, currency: "JOD", scale: 3 };
  }

  private journal(lines: Line[]): string {
    const id = this.id("je");
    this.journals.set(id, lines);
    return id;
  }

  private post(feeId: string, amount: number): void {
    const bank = this.faults.paidToCash ? "CASH_ON_HAND" : "BANK_ACCOUNT";
    this.events.push({
      _id: this.id("ev"),
      sourceId: feeId,
      eventType: "HANDOVER_COST_PAID_DIRECT",
      status: this.faults.neverPosts ? "PENDING" : "POSTED",
      journalEntryId: this.journal([this.line("OWNERSHIP_TRANSFER_EXPENSE", amount, 0), this.line(bank, 0, amount)]),
    });
  }

  private reverse(feeId: string): void {
    const original = this.events.find((event) => event.sourceId === feeId && event.eventType === "HANDOVER_COST_PAID_DIRECT");
    if (!original) return;
    const lines = this.journals.get(original.journalEntryId) ?? [];
    const f = this.faults;
    const mirror = lines.map((entry) =>
      f.sameSideReversal
        ? { ...entry }
        : { ...entry, debitMinor: entry.creditMinor - (f.shortReversal && entry.creditMinor > 0 ? 1 : 0), creditMinor: entry.debitMinor - (f.shortReversal && entry.debitMinor > 0 ? 1 : 0) },
    );
    const reversal: Event = {
      _id: this.id("ev"),
      sourceId: feeId,
      eventType: "JOURNAL_REVERSAL",
      status: f.reversalPending ? "PENDING" : "POSTED",
      journalEntryId: this.journal(mirror),
      ...(f.unlinkedReversal ? {} : { reversalOfEventId: original._id }),
    };
    this.events.push(reversal);
    if (!f.originalNotMarked) {
      original.status = "REVERSED";
      original.reversedByEventId = reversal._id;
    }
    if (f.originalRewritten) this.journals.set(original.journalEntryId, lines.map((entry) => ({ ...entry, debitMinor: entry.debitMinor + (entry.debitMinor > 0 ? 1 : 0), creditMinor: entry.creditMinor + (entry.creditMinor > 0 ? 1 : 0) })));
  }

  private paidFromBankId: string | null = null;

  private listed(): Record<string, unknown>[] {
    return [...this.fees.entries()]
      .filter(([, fee]) => !fee.voided || this.faults.voidedLineStays)
      .map(([id, fee]) => ({
        _id: id,
        actualAmountMinor: fee.amount,
        directPayment:
          fee.paid && !(this.faults.siblingLineLosesPayment && this.voids > 0 && !fee.voided)
            ? { version: 1, amountMinor: fee.amount, method: "BANK_TRANSFER" }
            : undefined,
      }));
  }

  call(actor: "owner" | "manager", name: string, a: Record<string, unknown>): unknown {
    this.calls.push(`${actor}:${name}`);
    this.argsOf.push({ name, args: a });
    const f = this.faults;
    switch (name) {
      case "orgSettings:get":
        if (f.noSettings) return null;
        return { currency: f.unknownCurrency ? "XXX" : "JOD" };
      case "customers:create":
        return this.id("cust");
      case "orgCustomerStatuses:seed":
        return null;
      case "orgCustomerStatuses:list":
        return [{ _id: "status-1", isActive: true }];
      case "finance:createCompany":
        return this.id("company");
      case "vehicles:create":
        if (a.sourceType !== "STOCK" || a.purchasePrice !== 15_000) throw new ConvexError("scenario sent a car other than the dealership's own stock");
        return this.id("veh");
      case "quotes:saveQuote":
        return this.id("quote");
      case "applications:createFromQuote":
        return "app1";
      case "applications:updateStatus":
        if (a.status === "APPROVED" && actor !== "manager") throw new ConvexError("approval must come from the second seat");
        return null;
      case "financeDealCosts:recordDealFee": {
        if (f.feeRefused) throw new ConvexError("A paid date is required for a cost with an actual amount.");
        if (
          a.paidBy !== "DEALER" ||
          a.deductedFromSettlement !== false ||
          a.accountingTreatment !== "OWNERSHIP_TRANSFER_EXPENSE" ||
          a.expectedCurrency !== "JOD" ||
          (a.actualAmountMinor !== 50_000 && a.actualAmountMinor !== 20_000)
        ) {
          throw new ConvexError("the cost is not a dealership-paid 50 or 20");
        }
        const feeId = this.id("fee");
        this.fees.set(feeId, { amount: a.actualAmountMinor as number, paid: false, voided: false });
        return feeId;
      }
      case "financeDealCosts:reconcileDealFee":
        if (f.reconcileRefused) throw new ConvexError("The fee has changed since it was reviewed.");
        if (a.expectedActualAmountMinor !== this.fees.get(String(a.feeId))?.amount) throw new ConvexError("reconciled amount is not the cost's");
        return null;
      case "bankAccounts:create":
        if (actor !== "owner") throw new ConvexError("the bank is created by the primary seat");
        if (f.bankCreateRefused) throw new ConvexError("You do not have permission to manage finance.");
        if (a.currency !== "JOD" || a.openingBalanceMinor !== 0) throw new ConvexError("the bank is not a zero-balance account in the organization's currency");
        this.paidFromBankId = this.id("bank");
        return this.paidFromBankId;
      case "financeDealCosts:recordDirectFeePayment": {
        const fee = this.fees.get(String(a.feeId));
        if (f.payRefused) throw new ConvexError("The chart of accounts has not been initialized.");
        // SCRUM-54: the payment names the bank the scenario created, never a defaulted one.
        if (this.paidFromBankId === null || a.bankAccountId !== this.paidFromBankId) throw new ConvexError("Select the bank account this payment was made from.");
        if (!fee || a.method !== "BANK_TRANSFER" || a.expectedAmountMinor !== fee.amount) throw new ConvexError("the payment is not the cost's at the pinned amount");
        fee.paid = true;
        this.post(String(a.feeId), fee.amount);
        return a.feeId;
      }
      case "financeDealCosts:voidDealFee": {
        const feeId = String(a.feeId);
        const fee = this.fees.get(feeId);
        if (!fee) throw new ConvexError("Cost not found.");
        if (fee.voided) {
          if (f.repeatRefused) throw new ConvexError("This cost has already been removed.");
          if (f.repeatReverses) this.reverse(feeId);
          return feeId;
        }
        if (f.voidRefused) throw new ConvexError("Removing a cost that has been reconciled needs more authority.");
        fee.voided = true;
        this.voids += 1;
        if (!f.noReversal) this.reverse(feeId);
        if (f.repost) this.post(feeId, fee.amount);
        if (f.siblingReversed) for (const [other, entry] of this.fees) if (other !== feeId && entry.paid) this.reverse(other);
        return feeId;
      }
      case "financeDealCosts:listDealCosts":
        return { fees: this.listed() };
      case "chartOfAccounts:list":
        return ACCOUNTS.filter((key) => !(f.bankUnnamed && key === "BANK_ACCOUNT")).map((key) => ({ _id: `acct-${key}`, systemKey: key, code: "0000" }));
      case "accountingLedger:listAccountingEvents":
        if (a.sourceType !== "financeDealFees") throw new ConvexError("the ledger of a cost is read by its own source");
        return this.events.filter((event) => event.sourceId === a.sourceId).map((event) => ({ ...event, sourceType: "financeDealFees" }));
      case "accountingLedger:getJournalEntry":
        return { entry: { _id: a.journalEntryId, status: "POSTED" }, lines: this.journals.get(String(a.journalEntryId)) ?? [] };
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
    mission: { id: "mission-1", family: "MONEY_BOUNDARY", oracle: options.oracle ?? "STATE_TRANSITION" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createMoneyBoundaryAttackHandlers(runtimeApi, {
    sleep: async () => undefined,
    pollMs: 1,
    postingWaitMs: 500,
    uiSettleMs: 0,
  }).MONEY_BOUNDARY;
  if (!handler) throw new Error("no handler registered for MONEY_BOUNDARY");
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
  const result = (await harness(faults).run()) as { oracle: { passed: boolean; summary: string } };
  expect(result.oracle.passed).toBe(false);
  for (const pattern of patterns) expect(result.oracle.summary).toMatch(pattern);
};

describe("SCRUM-350 LIFE-1 fee void handler: the discriminating scenario", () => {
  it("PASSES a correct product: the 50 payment reversed once, the 20 payment and line untouched, a retry a no-op", async () => {
    const h = harness();
    const result = (await h.run()) as { oracle: { passed: boolean; kind: string; summary: string } };
    expect(result.oracle).toMatchObject({ passed: true, kind: "STATE_TRANSITION" });
    expect(h.opened.map((entry) => entry.seat).sort()).toEqual(["approver", "primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    expect(h.world.calls).toContain("ui:goto /org1/applications/app1/deal");
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "MONEY_BOUNDARY",
      oracle: "STATE_TRANSITION",
      currency: "JOD",
      expected: { voidedMinor: 50_000, survivingMinor: 20_000, expenseKey: "OWNERSHIP_TRANSFER_EXPENSE", bankKey: "BANK_ACCOUNT" },
      repeatAccepted: true,
      unjudged: [],
      violations: [],
    });
    // What the scenario did not exercise is stated, so no result is read as more than it proved.
    expect(h.evidence[0]?.notExercised).toEqual([
      "DEAL_CANCELLATION",
      "AMOUNT_EDIT_REVERSAL",
      "CUSTODY_PAID_COST",
      "CLOSED_PERIOD_REVERSAL",
      "COCKPIT_VOID_BUTTON",
      "VOID_BOOKKEEPING_FIELDS",
      "SALE_DEPOSIT_AND_REFUND_REVERSALS",
    ]);
    expect(result.oracle.summary).toMatch(/Not read: any other un-happen path, a closed period, the cockpit's void button/);
  });

  it("drives the public product commands in order: both costs paid directly before the first is voided, twice", async () => {
    const h = harness();
    await h.run();
    const calls = h.world.calls.filter((call) => /financeDealCosts:/.test(call));
    const firstVoid = calls.indexOf("owner:financeDealCosts:voidDealFee");
    expect(calls.filter((call) => call === "owner:financeDealCosts:recordDirectFeePayment")).toHaveLength(2);
    expect(calls.lastIndexOf("owner:financeDealCosts:recordDirectFeePayment")).toBeLessThan(firstVoid);
    expect(calls.filter((call) => call === "owner:financeDealCosts:voidDealFee")).toHaveLength(2);
    expect(calls.filter((call) => call === "owner:financeDealCosts:reconcileDealFee")).toHaveLength(1);
    const pays = h.world.argsOf.filter((entry) => entry.name === "financeDealCosts:recordDirectFeePayment");
    expect(pays.map((entry) => entry.args.expectedAmountMinor)).toEqual([50_000, 20_000]);
    expect(pays.every((entry) => entry.args.method === "BANK_TRANSFER")).toBe(true);
    // SCRUM-54: both payments name the one bank the mission created first.
    expect(h.world.calls.filter((call) => call === "owner:bankAccounts:create")).toHaveLength(1);
    expect(h.world.calls.indexOf("owner:bankAccounts:create")).toBeLessThan(h.world.calls.indexOf("owner:financeDealCosts:recordDirectFeePayment"));
    expect(new Set(pays.map((entry) => entry.args.bankAccountId)).size).toBe(1);
    expect(pays[0].args.bankAccountId).toEqual(expect.any(String));
    const fees = h.world.argsOf.filter((entry) => entry.name === "financeDealCosts:recordDealFee");
    expect(fees.map((entry) => entry.args.actualAmountMinor)).toEqual([50_000, 20_000]);
    expect(h.world.calls.filter((call) => /sales|finalizeDeal|deposits:/.test(call))).toEqual([]);
    // The product refuses a priced owned car with no declared payment method. Paid outright, so not ON_ACCOUNT (no supplier payable).
    const create = h.world.argsOf.find((entry) => entry.name === "vehicles:create");
    expect(create?.args).toMatchObject({ sourceType: "STOCK", purchasePrice: 15_000, purchasePaymentMethod: "BANK_TRANSFER" });
    expect(create?.args).not.toHaveProperty("purchaseSupplierName");
  });

  it("FAILS a void that leaves the payment on the books", async () => {
    await breach({ noReversal: true }, /the ledger holds 0 reversal events for one direct payment/);
  });

  it("FAILS a reversal that is unlinked, one unit short, or on the payment's own sides", async () => {
    await breach({ unlinkedReversal: true }, /the reversal is not linked to the direct payment it takes back/);
    await breach({ shortReversal: true }, /the reversal journal does not mirror the posted journal/);
    await breach({ sameSideReversal: true }, /the reversal journal does not mirror the posted journal/);
  });

  it("FAILS an original that is not linked to its reversal, and posted history rewritten in place", async () => {
    await breach({ originalNotMarked: true }, /the original direct payment is not linked to its reversal/);
    await breach({ originalRewritten: true }, /the posted journal lines were rewritten instead of reversed/);
  });

  it("FAILS a void that re-posts the payment, or leaves the voided line live", async () => {
    await breach({ repost: true }, /the void left 2 direct payment events/);
    await breach({ voidedLineStays: true }, /the voided cost is still a live line on the deal after the void/);
  });

  it("FAILS a void that also takes back the other cost's payment, or strips its line", async () => {
    await breach({ siblingReversed: true }, /the surviving cost's ledger across the void changed/);
    await breach({ siblingLineLosesPayment: true }, /the surviving cost lost its recorded amount, its direct payment or its line/);
  });

  it("FAILS a retry that reverses again", async () => {
    await breach({ repeatReverses: true }, /the voided cost's ledger across the repeated void changed/);
  });

  it("FAILS a payment posted to cash instead of the bank, before it judges the void", async () => {
    await breach({ paidToCash: true }, /the direct payment moved \[CASH_ON_HAND\|0\|50000, OWNERSHIP_TRANSFER_EXPENSE\|50000\|0\]/);
  });
});

describe("SCRUM-350 LIFE-1 fee void handler: never a pass without a judged transition", () => {
  it("is INCONCLUSIVE when the payment never leaves PENDING, naming what was waited for", async () => {
    await inconclusive({ neverPosts: true }, /did not settle/);
  });

  it("is INCONCLUSIVE, not a breach, while the reversal is still queued behind a period that is not open", async () => {
    await inconclusive({ reversalPending: true }, /ledger state for financeDealFees\/fee\d+ did not settle/);
  });

  it("is INCONCLUSIVE when the product refuses the setup or the void", async () => {
    await inconclusive({ feeRefused: true }, /the product refused the dealership-paid voided cost of 50000: A paid date is required/);
    await inconclusive({ reconcileRefused: true }, /the product refused to reconcile the voided cost of 50000/);
    await inconclusive({ payRefused: true }, /the product refused the direct payment of the voided cost of 50000/);
    // SCRUM-54: no bank, no payment - and nothing downstream (payment, void) is attempted.
    const noBank = await inconclusive({ bankCreateRefused: true }, /the product refused to create the bank the dealership-paid costs leave/);
    expect(noBank.world.calls).toContain("owner:bankAccounts:create");
    expect(noBank.world.calls.filter((call) => /recordDirectFeePayment|voidDealFee/.test(call))).toEqual([]);
    await inconclusive({ voidRefused: true }, /the product refused to void the directly paid cost: Removing a cost that has been reconciled/);
  });

  it("is INCONCLUSIVE when a retry is refused, because the idempotent answer was not observed", async () => {
    const h = await inconclusive({ repeatRefused: true }, /product refused the repeated void/);
    expect(h.evidence[0]).toMatchObject({ repeatRefusal: "This cost has already been removed." });
  });

  it("is INCONCLUSIVE, with nothing seeded, for an unreadable or unknown currency", async () => {
    const unreadable = await inconclusive({ noSettings: true }, /currency is unreadable/);
    expect(unreadable.world.calls).toEqual(["owner:orgSettings:get"]);
    const unknown = await inconclusive({ unknownCurrency: true }, /not two distinct whole positive amounts in XXX/);
    expect(unknown.world.calls).toEqual(["owner:orgSettings:get"]);
  });

  it("is INCONCLUSIVE when the seats are split, the screen cannot be opened, or the chart cannot name the bank", async () => {
    await inconclusive({ seatsSplit: true }, /approver seat signed in to a different organization/);
    await inconclusive({ screenFails: true }, /deal screen could not be opened for the screenshot/);
    await inconclusive({ bankUnnamed: true }, /the direct payment posted to an account the chart cannot name/);
  });

  it("refuses a mission for an oracle neither scenario judges, before touching the backend", async () => {
    const h = harness({}, { oracle: "TENANT_ISOLATION" });
    await expect(h.run()).rejects.toThrow(/does not judge the TENANT_ISOLATION oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("does not hide a proven breach behind a browser-cleanup failure", async () => {
    const result = (await harness({ noReversal: true }, { finishFails: true }).run()) as { oracle: { passed: boolean; summary: string } };
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
    expect(h.world.calls.filter((call) => /financeDealCosts:/.test(call))).toEqual([]);
  });
});
