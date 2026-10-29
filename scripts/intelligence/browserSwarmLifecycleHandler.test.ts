import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { CreateVehicleSchema } from "../../convex/validations/vehicles";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { createBoundaryAttackHandlers } from "./browserSwarmBoundaryAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-350 LIFE-1 — handler-level tests for LIFECYCLE_REVERSAL judged as a
 * STATE_TRANSITION: voiding one of two deposits held against the same car.
 *
 * The real handler (through the real boundary registry, so the dispatch on the
 * mission's oracle is under test too) runs end to end against a scripted
 * two-seat backend: the OWNER takes the deposits, the MANAGER voids. The fake
 * enforces the product's real refusal texts. A correct product takes 200 and
 * 300 JOD (scale 1,000), voids the 200, and leaves the 300, its posting and the
 * reserved car alone. Each fault breaks exactly one fact, and every figure is
 * written out by hand, never taken from the production scenario. No browser is
 * launched.
 */

interface Faults {
  /** The void reverses every receipt on the quote, the survivor's included. */
  voidKillsSurvivor?: boolean;
  /** The void frees the car although the surviving deposit still holds it. */
  voidFreesCar?: boolean;
  /** The void marks the deposit VOIDED but posts no reversal. */
  voidNoReversal?: boolean;
  voidDoubleReversal?: boolean;
  voidNonMirror?: boolean;
  /** The void leaves the deposit HELD. */
  voidLeavesHeld?: boolean;
  /** The void rewrites the voided deposit's receipt journal instead of reversing it. */
  voidRewritesReceipt?: boolean;
  voidRefused?: boolean;
  /** A second void is accepted and reverses the receipt again. */
  voidAgainAccepted?: boolean;
  /** A refund of the voided deposit is accepted and pays out. */
  refundAccepted?: boolean;
  /** A forfeit of the voided deposit is refused for a reason that is not "already resolved". */
  forfeitRefusedOtherwise?: boolean;
  /** Receipts stay PENDING for good. */
  neverPosts?: boolean;
  /** The car is not reserved by a deposit. */
  carNotReserved?: boolean;
  /** The deposits post 1 minor unit short. */
  wrongAmount?: boolean;
  settings?: "missing";
  seatsSplit?: boolean;
  screenFails?: boolean;
  /** The first void is refused; later voids (the mission's cleanup) are accepted. */
  voidRefusedOnce?: boolean;
  /** The second deposit is refused for a reason that is not a rate limit. */
  secondDepositRefused?: boolean;
  /** The void leaves the deposit's canonical payment SETTLED. */
  paymentNotVoided?: boolean;
  /** The void also voids the surviving deposit's canonical payment. */
  voidKillsSurvivorPayment?: boolean;
  /** The subledger read returns nothing. */
  paymentUnreadable?: boolean;
  /** The void also posts a refund event on the voided deposit. */
  extraRefundEvent?: boolean;
  /** The car cannot be read once the void has happened. */
  carUnreadableAfterVoid?: boolean;
  /** Every write answers with a rate limit demanding this many seconds. */
  rateLimitSeconds?: number;
}

interface Line {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  scale: number;
  currency: string;
}
interface Event {
  _id: string;
  eventType: string;
  status: string;
  reversalOfEventId?: string;
  reversedByEventId?: string;
  journalEntryId: string;
  depositId: string;
}
interface Deposit {
  _id: string;
  status: string;
  isDeleted: boolean;
  holdActive: boolean;
  amount: number;
  amountMinor: number;
  releasedAmountMinor: number;
  canonicalPaymentId: string;
}
interface Payment {
  _id: string;
  status: string;
  amountMinor: number;
}

const SCALE = 1_000;

class World {
  readonly calls: string[] = [];
  readonly deposits: Deposit[] = [];
  readonly events: Event[] = [];
  readonly journals = new Map<string, Line[]>();
  readonly payments = new Map<string, Payment>();
  /** Every write attempted, refused or not, in order. */
  readonly writes: string[] = [];
  vehicleStatus = "AVAILABLE";
  private voidedOnce = false;
  private next = 0;

  constructor(readonly faults: Faults) {}

  private id(prefix: string): string {
    this.next += 1;
    return `${prefix}-${this.next}`;
  }

  private receipt(deposit: Deposit): void {
    const journalEntryId = this.id("je");
    const minor = deposit.amountMinor - (this.faults.wrongAmount ? 1 : 0);
    this.journals.set(journalEntryId, [
      { accountId: "acc-cash", debitMinor: minor, creditMinor: 0, scale: 3, currency: "JOD" },
      { accountId: "acc-liability", debitMinor: 0, creditMinor: minor, scale: 3, currency: "JOD" },
    ]);
    this.events.push({
      _id: this.id("ev"),
      eventType: "DEPOSIT_RECEIVED",
      status: this.faults.neverPosts ? "PENDING" : "POSTED",
      journalEntryId,
      depositId: deposit._id,
    });
  }

  private reverse(depositId: string): void {
    const original = this.events.find((event) => event.depositId === depositId && event.eventType === "DEPOSIT_RECEIVED" && event.status === "POSTED");
    if (!original) return;
    const lines = this.journals.get(original.journalEntryId)!;
    const journalEntryId = this.id("je");
    this.journals.set(
      journalEntryId,
      lines.map((line) => ({
        ...line,
        debitMinor: this.faults.voidNonMirror ? line.debitMinor : line.creditMinor,
        creditMinor: this.faults.voidNonMirror ? line.creditMinor : line.debitMinor,
      })),
    );
    const reversalId = this.id("ev");
    this.events.push({ _id: reversalId, eventType: "JOURNAL_REVERSAL", status: "POSTED", reversalOfEventId: original._id, journalEntryId, depositId });
    original.status = "REVERSED";
    original.reversedByEventId = reversalId;
  }

  private find(depositId: unknown): Deposit | undefined {
    return this.deposits.find((deposit) => deposit._id === depositId);
  }

  private voidPayment(deposit: Deposit): void {
    this.payments.get(deposit.canonicalPaymentId)!.status = "VOIDED";
  }

  call(actor: "owner" | "manager", name: string, a: Record<string, unknown>): unknown {
    this.calls.push(`${actor}:${name}`);
    const isWrite = ["customers:create", "vehicles:create", "quotes:saveQuote", "deposits:create", "deposits:voidDeposit", "deposits:release"].includes(name);
    if (isWrite) {
      this.writes.push(name);
      if (this.faults.rateLimitSeconds !== undefined) {
        throw new ConvexError(`Rate limit exceeded. Try again in ${this.faults.rateLimitSeconds}s.`);
      }
    }
    switch (name) {
      case "orgSettings:get":
        return this.faults.settings === "missing" ? null : { currency: "JOD" };
      case "customers:create":
        return this.id("cust");
      case "suppliers:create":
        // SCRUM-868 P2: the consignment supplier master the SOURCED car is created against.
        return { supplierId: this.id("sup") };
      case "vehicles:create": {
        if (typeof a.sourcedSupplierId !== "string" || "sourcedFromName" in a) {
          throw new ConvexError("scenario named the supplier by text instead of by master id");
        }
        // The product's own validation: a VIN with I, O or Q never reaches the table.
        const parsed = CreateVehicleSchema.safeParse(a);
        if (!parsed.success) throw new ConvexError(parsed.error.issues.map((issue) => issue.message).join("; "));
        return this.id("veh");
      }
      case "quotes:saveQuote":
        return this.id("quote");
      case "vehicles:get":
        if (this.faults.carUnreadableAfterVoid && this.voidedOnce) return null;
        return { _id: "veh-3", status: this.vehicleStatus, sourceType: "SOURCED" };
      case "subledger:getPaymentBalance": {
        const payment = this.payments.get(a.paymentId as string);
        if (!payment || this.faults.paymentUnreadable) return null;
        return { payment, unappliedMinor: payment.status === "SETTLED" ? payment.amountMinor : 0 };
      }
      case "deposits:create": {
        if (actor !== "owner") throw new ConvexError("Forbidden: Missing required permissions");
        if (this.faults.secondDepositRefused && this.deposits.length === 1) throw new ConvexError("Quote is not open for deposits.");
        const amount = a.amount as number;
        const paymentId = this.id("pay");
        this.payments.set(paymentId, { _id: paymentId, status: "SETTLED", amountMinor: amount * SCALE });
        const deposit: Deposit = {
          _id: this.id("dep"),
          status: "HELD",
          isDeleted: false,
          holdActive: !this.faults.carNotReserved,
          amount,
          amountMinor: amount * SCALE,
          releasedAmountMinor: 0,
          canonicalPaymentId: paymentId,
        };
        this.deposits.push(deposit);
        if (!this.faults.carNotReserved) this.vehicleStatus = "RESERVED";
        this.receipt(deposit);
        return deposit._id;
      }
      case "deposits:listByVehicle":
        return [...this.deposits].reverse();
      case "accountingLedger:listAccountingEvents":
        return this.events.filter((event) => event.depositId === a.sourceId).map(({ depositId, ...event }) => ({ ...event, sourceType: "deposits", sourceId: depositId }));
      case "accountingLedger:getJournalEntry": {
        const lines = this.journals.get(a.journalEntryId as string);
        return lines ? { entry: { _id: a.journalEntryId }, lines } : null;
      }
      case "deposits:voidDeposit": {
        if (actor !== "manager") throw new ConvexError("Forbidden: Missing required permissions");
        if (this.faults.voidRefused) throw new ConvexError("Forbidden: Missing required permissions");
        if (this.faults.voidRefusedOnce && !this.voidedOnce) {
          this.voidedOnce = true;
          throw new ConvexError("Forbidden: Missing required permissions");
        }
        const deposit = this.find(a.depositId);
        if (!deposit || deposit.isDeleted) {
          if (deposit && this.faults.voidAgainAccepted) {
            this.reverse(deposit._id);
            return deposit._id;
          }
          throw new ConvexError("Deposit not found in this organization.");
        }
        if (deposit.status !== "HELD") throw new ConvexError("Only HELD deposits can be voided.");
        if (!this.faults.voidLeavesHeld) {
          deposit.status = "VOIDED";
          deposit.isDeleted = true;
          deposit.holdActive = false;
        }
        if (this.faults.voidRewritesReceipt) {
          const receipt = this.events.find((event) => event.depositId === deposit._id)!;
          this.journals.set(receipt.journalEntryId, this.journals.get(receipt.journalEntryId)!.map((line) => ({ ...line, debitMinor: line.debitMinor + 1 })));
        } else if (!this.faults.voidNoReversal) {
          this.reverse(deposit._id);
          if (this.faults.voidDoubleReversal) {
            const second = this.id("ev");
            const first = this.events.find((event) => event.eventType === "JOURNAL_REVERSAL" && event.depositId === deposit._id)!;
            this.events.push({ ...first, _id: second });
          }
        }
        if (!this.faults.paymentNotVoided && !this.faults.voidLeavesHeld) this.voidPayment(deposit);
        if (this.faults.extraRefundEvent) {
          const journalEntryId = this.id("je");
          this.journals.set(journalEntryId, [
            { accountId: "acc-liability", debitMinor: deposit.amountMinor, creditMinor: 0, scale: 3, currency: "JOD" },
            { accountId: "acc-cash", debitMinor: 0, creditMinor: deposit.amountMinor, scale: 3, currency: "JOD" },
          ]);
          this.events.push({ _id: this.id("ev"), eventType: "DEPOSIT_REFUNDED", status: "POSTED", journalEntryId, depositId: deposit._id });
        }
        if (this.faults.voidKillsSurvivor) {
          for (const other of this.deposits) if (other._id !== deposit._id) this.reverse(other._id);
        }
        if (this.faults.voidKillsSurvivorPayment) {
          for (const other of this.deposits) if (other._id !== deposit._id) this.voidPayment(other);
        }
        this.voidedOnce = true;
        const stillHeld = this.deposits.some((other) => other.status === "HELD" && other.holdActive);
        if (!stillHeld || this.faults.voidFreesCar) this.vehicleStatus = "AVAILABLE";
        return deposit._id;
      }
      case "deposits:release": {
        if (actor !== "manager") throw new ConvexError("Forbidden: Missing required permissions");
        const deposit = this.find(a.depositId);
        if (!deposit) throw new ConvexError("Deposit not found in this organization.");
        if (a.resolution === "FORFEITED" && this.faults.forfeitRefusedOtherwise) throw new ConvexError("Rate limit exceeded. Try again in 3s.");
        if (deposit.status !== "HELD") {
          if (a.resolution === "REFUNDED" && this.faults.refundAccepted) {
            deposit.releasedAmountMinor = deposit.amountMinor;
            return deposit._id;
          }
          throw new ConvexError("This deposit has already been resolved.");
        }
        throw new Error("the scripted product only releases a voided deposit in these tests");
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

function harness(faults: Faults = {}, options: { oracle?: string; signal?: AbortSignal; finishFails?: boolean } = {}) {
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
    mission: { id: "mission-1", family: "LIFECYCLE_REVERSAL", oracle: options.oracle ?? "STATE_TRANSITION" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const sleeps: number[] = [];
  const handler = createBoundaryAttackHandlers(runtimeApi, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pollMs: 1,
    postingWaitMs: 500,
    uiSettleMs: 0,
  }).LIFECYCLE_REVERSAL;
  if (!handler) throw new Error("no handler registered for LIFECYCLE_REVERSAL");
  return { run: () => handler(context), world, evidence, opened, sleeps };
}

const settle = (h: { run: () => Promise<unknown> }): Promise<unknown> => h.run().catch((thrown: unknown) => thrown);

/** Asserts a proven breach whose summary names `pattern`, with evidence written and every seat finished. */
const breach = async (faults: Faults, pattern: RegExp) => {
  const h = harness(faults);
  const result = (await h.run()) as { oracle: { passed: boolean; summary: string } };
  expect(result.oracle.passed).toBe(false);
  expect(result.oracle.summary).toMatch(pattern);
  expect(h.evidence).toHaveLength(1);
  expect(h.opened.every((entry) => entry.finished)).toBe(true);
  return h;
};

/** Asserts the mission ended INCONCLUSIVE for `pattern`: never a pass, never a breach. */
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

describe("SCRUM-350 LIFECYCLE_REVERSAL / STATE_TRANSITION handler: a correct product", () => {
  it("PASSES: only the voided deposit is unwound, the survivor and the reserved car are untouched, repeats move nothing", async () => {
    const h = harness();
    const result = (await h.run()) as { oracle: { kind: string; passed: boolean } };
    expect(result.oracle).toMatchObject({ kind: "STATE_TRANSITION", passed: true });

    expect(h.world.deposits.map((deposit) => [deposit.amount, deposit.status])).toEqual([
      [200, "VOIDED"],
      [300, "VOIDED"], // the survivor, voided only by the mission's own cleanup after it was judged
    ]);
    // Read states are the evidence: judged BEFORE cleanup freed the car.
    const states = h.evidence[0]!.states as Record<string, { survivor: { status: string }; vehicleStatus: string }>;
    expect(states.before!.survivor.status).toBe("HELD");
    expect(states.afterVoid!.survivor.status).toBe("HELD");
    expect(states.afterVoid!.vehicleStatus).toBe("RESERVED");
    expect(states.afterAttempts!.vehicleStatus).toBe("RESERVED");

    expect(h.evidence[0]).toMatchObject({
      attack: "LIFECYCLE_REVERSAL",
      oracle: "STATE_TRANSITION",
      lifecycle: "DEPOSIT_VOID_WITH_SURVIVOR",
      currency: "JOD",
      unjudged: [],
      violations: [],
      scenario: { voidedMajor: 200, survivorMajor: 300, priceMajor: 20_000 },
    });
    expect((h.evidence[0]!.notExercised as string[])).toContain("SCREEN_VOID_ACTION");
    expect(h.evidence[0]!.voidVia).toMatch(/backend mutation/);
    expect(h.evidence[0]!.probes).toEqual([
      { label: "deposits.voidDeposit (second request)", outcome: "REFUSED", message: "Deposit not found in this organization." },
      { label: "deposits.release REFUNDED (voided deposit)", outcome: "REFUSED", message: "This deposit has already been resolved." },
      { label: "deposits.release FORFEITED (voided deposit)", outcome: "REFUSED", message: "This deposit has already been resolved." },
    ]);
    expect(h.world.calls).toContain("ui:goto /org1/vehicles");
    expect(h.opened.map((entry) => entry.seat).sort()).toEqual(["approver", "primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
  });

  it("takes the deposits with the OWNER and voids with the MANAGER, voiding the first deposit and not the second", async () => {
    const h = harness();
    await h.run();
    const voids = h.world.calls.filter((call) => call.endsWith("deposits:voidDeposit"));
    expect(h.world.calls.filter((call) => call === "owner:deposits:create")).toHaveLength(2);
    // The transition, a refused repeat, then cleanup of each deposit: the voided one is already gone
    // (tolerated), the survivor is really voided.
    expect(voids).toHaveLength(4);
    expect(h.world.deposits.map((deposit) => deposit.status)).toEqual(["VOIDED", "VOIDED"]);
  });

  it("reads both deposits' canonical payments, and no screenshot claim covers the mirror row", async () => {
    const h = harness();
    await h.run();
    expect(h.world.calls.filter((call) => call.endsWith("subledger:getPaymentBalance")).length).toBeGreaterThanOrEqual(6);
    const states = h.evidence[0]!.states as Record<string, { voided: { payment: { status: string } }; survivor: { payment: { status: string } } }>;
    expect(states.before!.voided.payment.status).toBe("SETTLED");
    expect(states.afterVoid!.voided.payment.status).toBe("VOIDED");
    expect(states.afterVoid!.survivor.payment.status).toBe("SETTLED");
    expect(h.evidence[0]!.notExercised).toContain("COLLECTION_PAYMENT_MIRROR_ROW");
  });

  it("creates the vehicle with a VIN the product's own validation accepts", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBeDefined();
    expect(h.world.writes).toContain("vehicles:create");
  });

  it("refuses a mission for an oracle it does not judge, before touching the backend", async () => {
    const h = harness({}, { oracle: "UI_BACKEND_AUTHORITY" });
    await expect(h.run()).rejects.toThrow(/does not judge the UI_BACKEND_AUTHORITY oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("stops touching the backend once the mission is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));
    const h = harness({}, { signal: controller.signal });
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    expect(h.world.calls).toEqual([]);
  });

  it("never writes a credential or a connection string into the evidence", async () => {
    const h = harness();
    await h.run();
    expect(JSON.stringify(h.evidence)).not.toMatch(/token|secret|password|bearer|https?:\/\//i);
  });
});

describe("SCRUM-350 LIFECYCLE_REVERSAL / STATE_TRANSITION handler: breaches", () => {
  it("catches the counterexample: a void that also reverses the surviving deposit's receipt", async () => {
    const h = await breach({ voidKillsSurvivor: true }, /changed the surviving deposit's ledger postings/);
    expect(h.evidence[0]!.violations).toEqual(expect.arrayContaining([expect.stringMatching(/surviving deposit/)]));
  });

  it("catches the counterexample: a void that frees the car while the surviving deposit holds it", async () => {
    await breach({ voidFreesCar: true }, /released the car \(AVAILABLE\) while the surviving deposit still holds it/);
  });

  it("reports a deposit that stays HELD after its void", async () => {
    await breach({ voidLeavesHeld: true }, /voided deposit is HELD, not VOIDED/);
  });

  it("reports a void that posts no reversal", async () => {
    await breach({ voidNoReversal: true }, /no reversal event/);
  });

  it("reports a void that posts two reversals", async () => {
    await breach({ voidDoubleReversal: true }, /2 reversal events/);
  });

  it("reports a reversal that does not mirror the receipt", async () => {
    await breach({ voidNonMirror: true }, /does not mirror the receipt/);
  });

  it("reports a receipt rewritten in place instead of reversed", async () => {
    await breach({ voidRewritesReceipt: true }, /rewritten instead of reversed/);
  });

  it("reports a second void that is accepted", async () => {
    await breach({ voidAgainAccepted: true }, /voidDeposit \(second request\) was accepted/);
  });

  it("reports a refund of the voided deposit that is accepted and pays out", async () => {
    await breach({ refundAccepted: true }, /release REFUNDED \(voided deposit\) was accepted/);
  });

  it("reports a receipt posted for the wrong amount, even though the reversal mirrors it", async () => {
    await breach({ wrongAmount: true }, /moves 199999 minor units but 200000 were deposited/);
  });

  it("reports a void that leaves the voided deposit's canonical payment SETTLED", async () => {
    await breach({ paymentNotVoided: true }, /canonical payment is SETTLED, not VOIDED/);
  });

  it("reports a void that also voids the surviving deposit's canonical payment", async () => {
    await breach({ voidKillsSurvivorPayment: true }, /changed the surviving deposit from/);
  });

  it("reports an extra refund event on the voided deposit's ledger", async () => {
    await breach({ extraRefundEvent: true }, /unexpected event \(DEPOSIT_REFUNDED\)/);
  });

  it("reports a breach beside a browser cleanup failure, hiding neither", async () => {
    const h = harness({ voidFreesCar: true }, { finishFails: true });
    const result = (await h.run()) as { oracle: { passed: boolean; summary: string } };
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed/);
  });
});

describe("SCRUM-350 LIFECYCLE_REVERSAL / STATE_TRANSITION handler: never a vacuous pass", () => {
  it("is INCONCLUSIVE when the product refuses the void, so the transition was never exercised", async () => {
    await inconclusive({ voidRefused: true }, /refused to void the deposit.*could not be judged/);
  });

  it("is INCONCLUSIVE when a forfeit is refused for a reason that is not 'already resolved'", async () => {
    await inconclusive({ forfeitRefusedOtherwise: true }, /release FORFEITED \(voided deposit\): failed for a reason that is not an authorization refusal/);
  });

  it("is INCONCLUSIVE when the receipts never post", async () => {
    await inconclusive({ neverPosts: true }, /did not settle after both deposits were taken/);
  });

  it("is INCONCLUSIVE when the car is not reserved, so its release could not be judged", async () => {
    await inconclusive({ carNotReserved: true }, /not RESERVED, before the void/);
  });

  it("is INCONCLUSIVE, and seeds nothing, when the organization's settings are unreadable", async () => {
    const h = await inconclusive({ settings: "missing" }, /currency is unreadable/);
    expect(h.world.deposits).toHaveLength(0);
  });

  it("is INCONCLUSIVE, and seeds nothing, when the approver seat is in another organization", async () => {
    const h = await inconclusive({ seatsSplit: true }, /approver seat signed in to a different organization/);
    expect(h.world.deposits).toHaveLength(0);
  });

  it("is INCONCLUSIVE when the vehicles screen cannot be opened, so the screenshot would not show the car", async () => {
    await inconclusive({ screenFails: true }, /vehicles screen could not be opened/);
  });

  it("is INCONCLUSIVE, never a breach, when the car's status cannot be read after the void", async () => {
    await inconclusive({ carUnreadableAfterVoid: true }, /car's status could not be read after the void/);
  });

  it("is INCONCLUSIVE, never a pass, when the canonical payments cannot be read", async () => {
    await inconclusive({ paymentUnreadable: true }, /canonical payment could not be read before the void/);
  });

  it("voids the first deposit in cleanup when the second deposit is refused", async () => {
    const h = harness({ secondDepositRefused: true });
    const error = await settle(h);
    expect((error as Error).message).toMatch(/Quote is not open for deposits/);
    expect(h.world.deposits.map((deposit) => deposit.status)).toEqual(["VOIDED"]);
    expect(h.world.writes).not.toContain("customers:softDelete");
  });

  it("voids both deposits in cleanup when the product refuses the void", async () => {
    const h = harness({ voidRefusedOnce: true });
    const error = await settle(h);
    expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect(h.world.deposits.map((deposit) => deposit.status)).toEqual(["VOIDED", "VOIDED"]);
  });

  it("stops after a bounded number of rate-limit waits, each capped, and throws the last error", async () => {
    const h = harness({ rateLimitSeconds: 999_999 });
    const error = await settle(h);
    expect((error as Error).message).toMatch(/Rate limit exceeded/);
    expect(h.world.writes).toEqual(["customers:create", "customers:create", "customers:create", "customers:create"]);
    expect(h.sleeps).toEqual([60_000, 60_000, 60_000]);
  });
});
