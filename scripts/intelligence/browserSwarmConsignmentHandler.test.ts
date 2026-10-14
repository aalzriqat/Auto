import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { createConsignmentAttackHandlers } from "./browserSwarmConsignmentAttack";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-350 CONS-1 — handler-level tests for CONSIGNMENT_ECONOMICS.
 *
 * The real handler runs end to end against a scripted two-seat backend whose
 * sale posting is the only thing each fault changes. A correct product posts the
 * agent basis (commission on the 5,000 spread, the supplier owed 15,000); each
 * fault flips exactly one fact, so every judgement in the handler is pinned by a
 * verdict that changes when the wiring is removed. No browser is launched.
 */

interface Faults {
  /** Posts the sale as dealership stock: gross revenue, COGS and inventory. */
  grossRecognition?: boolean;
  /** Commission one minor unit above the independent margin. */
  overstatedCommission?: boolean;
  /** The supplier is owed less than his entitlement. */
  shortSupplier?: boolean;
  /** The sale never reaches a posted journal. */
  neverPosts?: boolean;
  /** Two SALE_COMPLETED events for one sale. */
  duplicateEvent?: boolean;
  /** The organization's settings are unreadable. */
  noSettings?: boolean;
  /** The organization is denominated in a currency with no known scale. */
  unknownCurrency?: boolean;
  /** The approver signs in to a different organization. */
  seatsSplit?: boolean;
  /** The stored vehicle is not the consigned car the scenario created. */
  vehicleStoredAsStock?: boolean;
  /** The finalized sale does not record the chosen route. */
  routeNotRecorded?: boolean;
  /** The product refuses the approval. */
  approvalRefused?: boolean;
  /** The posted journal carries an extra line on an account the chart does not list. */
  unmappedAccount?: boolean;
  /** finalizeDeal answers with another, unrelated sale (other vehicle, customer, application). */
  unrelatedSale?: boolean;
  /** The sales screen cannot be opened for the screenshot. */
  screenFails?: boolean;
  /** The first vehicle create hits the write rate limit. */
  rateLimitVehicleOnce?: boolean;
}

const SCALE = 1_000;
const ACCOUNTS = [
  "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES",
  "ACCOUNTS_PAYABLE_SUPPLIERS",
  "CONSIGNMENT_COMMISSION_REVENUE",
  "SALES_REVENUE",
  "COST_OF_VEHICLES_SOLD",
  "VEHICLE_INVENTORY",
];

class World {
  readonly calls: string[] = [];
  readonly vins: string[] = [];
  readonly actorOf = new Map<string, "owner" | "manager">();
  private nextId = 0;
  private vehicleRateLimited = false;
  private saleId: string | null = null;
  private readonly seeded = { vehicle: "", customer: "", application: "" };
  private reads = 0;

  constructor(readonly faults: Faults) {}

  id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  private lines(): { accountId: string; debitMinor: number; creditMinor: number; currency: string; scale: number }[] {
    const currency = "JOD";
    const line = (key: string, debitMinor: number, creditMinor: number) => ({
      accountId: `acct-${key}`,
      debitMinor,
      creditMinor,
      currency,
      scale: 3,
    });
    if (this.faults.grossRecognition) {
      return [
        line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000 * SCALE, 0),
        line("SALES_REVENUE", 0, 20_000 * SCALE),
        line("COST_OF_VEHICLES_SOLD", 15_000 * SCALE, 0),
        line("VEHICLE_INVENTORY", 0, 15_000 * SCALE),
      ];
    }
    const correct = [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", 20_000 * SCALE, 0),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, (this.faults.shortSupplier ? 14_000 : 15_000) * SCALE),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000 * SCALE + (this.faults.overstatedCommission ? 1 : 0)),
    ];
    // Balanced hidden pair: nothing in the mapped lines betrays it.
    return this.faults.unmappedAccount
      ? [...correct, line("HIDDEN_COGS", 15_000 * SCALE, 0), line("HIDDEN_INVENTORY", 0, 15_000 * SCALE)]
      : correct;
  }

  call(actor: "owner" | "manager", name: string, a: Record<string, unknown>): unknown {
    this.calls.push(`${actor}:${name}`);
    switch (name) {
      case "orgSettings:get":
        if (this.faults.noSettings) return null;
        return { currency: this.faults.unknownCurrency ? "XXX" : "JOD" };
      case "customers:create":
        this.seeded.customer = this.id("cust");
        return this.seeded.customer;
      case "orgCustomerStatuses:seed":
        return null;
      case "orgCustomerStatuses:list":
        return [{ _id: "status-1", isActive: true }];
      case "finance:createCompany":
        return this.id("company");
      case "vehicles:create":
        if (this.faults.rateLimitVehicleOnce && !this.vehicleRateLimited) {
          this.vehicleRateLimited = true;
          throw new ConvexError("Rate limit exceeded. Try again in 1s");
        }
        this.vins.push(String(a.vin));
        if (a.sourceType !== "SOURCED" || a.sourceCost !== 15_000 || a.sellingPrice !== 20_000) {
          throw new ConvexError("scenario sent a car other than the consigned one");
        }
        this.seeded.vehicle = this.id("veh");
        return this.seeded.vehicle;
      case "vehicles:get":
        return this.faults.vehicleStoredAsStock
          ? { sourceType: "STOCK", purchasePrice: 15_000 }
          : { sourceType: "SOURCED", sourceCost: 15_000 };
      case "quotes:saveQuote":
        return this.id("quote");
      case "applications:createFromQuote":
        this.seeded.application = this.id("app");
        return this.seeded.application;
      case "applications:updateStatus":
        if (a.status === "APPROVED" && this.faults.approvalRefused) throw new ConvexError("Forbidden: Missing required permissions");
        if (a.status === "APPROVED" && actor !== "manager") throw new ConvexError("approval must come from the second seat");
        return null;
      case "applications:setSupplierSettlementRoute":
        return null;
      case "financingEconomics:recordSubmittedQuotation":
        if (a.submittedQuotationMinor !== 20_000 * SCALE) throw new ConvexError("quotation is not in minor units");
        return null;
      case "financingEconomics:approveDealerPurchaseAmount":
        if (a.approvedAmountMinor !== 20_000 * SCALE) throw new ConvexError("approval is not in minor units");
        if (actor !== "manager") throw new ConvexError("approval must come from the second seat");
        return null;
      case "applications:handoverStamp":
        return { stamp: "s" };
      case "applications:registerVehicleHandover":
      case "applications:registerExpectedPayment":
        return null;
      case "financeDealCosts:recordLegalInvoice":
        if (a.legalInvoiceAmountMinor !== 20_000 * SCALE) throw new ConvexError("invoice is not in minor units");
        return null;
      case "financeDealCosts:recordDealFee":
        return this.id("fee");
      case "financeDealCosts:reconcileDealFee":
        return null;
      case "applications:finalizeDeal":
        this.saleId = this.id("sale");
        return this.saleId;
      case "sales:get":
        return {
          _id: this.saleId,
          supplierSettlementRoute: this.faults.routeNotRecorded ? undefined : "THROUGH_DEALERSHIP",
          vehicleId: this.faults.unrelatedSale ? "veh-other" : this.seeded.vehicle,
          customerId: this.faults.unrelatedSale ? "cust-other" : this.seeded.customer,
          applicationId: this.faults.unrelatedSale ? "app-other" : this.seeded.application,
          salePrice: 20_000,
        };
      case "chartOfAccounts:list":
        return ACCOUNTS.map((key) => ({ _id: `acct-${key}`, systemKey: key, code: "0000" }));
      case "accountingLedger:listAccountingEvents": {
        this.reads += 1;
        if (this.faults.neverPosts) return [{ _id: "ev-p", eventType: "SALE_COMPLETED", status: "PENDING" }];
        const event = { _id: "ev-1", eventType: "SALE_COMPLETED", status: "POSTED", journalEntryId: "je-1" };
        return this.faults.duplicateEvent ? [event, { ...event, _id: "ev-2", journalEntryId: "je-2" }] : [event];
      }
      case "accountingLedger:getJournalEntry":
        // The duplicate event posts the same economics again: only the count is wrong.
        return { entry: { _id: a.journalEntryId }, lines: this.faults.duplicateEvent && a.journalEntryId === "je-2" ? [] : this.lines() };
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
    mission: { id: "mission-1", family: "CONSIGNMENT_ECONOMICS", oracle: options.oracle ?? "ECONOMIC_AUTHORITY" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const handler = createConsignmentAttackHandlers(runtimeApi, {
    sleep: async () => undefined,
    pollMs: 1,
    postingWaitMs: 500,
    uiSettleMs: 0,
  }).CONSIGNMENT_ECONOMICS;
  if (!handler) throw new Error("no handler registered for CONSIGNMENT_ECONOMICS");
  return { run: () => handler(context), world, evidence, opened };
}

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: mission contract", () => {
  it("passes a correct product, judges the ECONOMIC_AUTHORITY oracle and records trace, screenshot and backend state", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle).toMatchObject({ kind: "ECONOMIC_AUTHORITY", passed: true });
    // One trace and screenshot per seat, then the single backend-state record.
    expect(result.artifacts).toEqual(["trace.zip", "final.png", "trace.zip", "final.png", "backend-state.json"]);
    expect(h.opened.map((entry) => entry.seat).sort()).toEqual(["approver", "primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "CONSIGNMENT_ECONOMICS",
      oracle: "ECONOMIC_AUTHORITY",
      violations: [],
      currency: "JOD",
      settlementRoute: "THROUGH_DEALERSHIP",
      expected: {
        priceMinor: 20_000_000,
        approvedMinor: 20_000_000,
        entitlementMinor: 15_000_000,
        contributionMinor: 0,
        route: "THROUGH_DEALERSHIP",
      },
    });
    // What the scenario did not exercise is stated, so a pass is not read as more than it proved.
    expect(h.evidence[0]?.notExercised).toEqual([
      "DEALERSHIP_CONTRIBUTION",
      "CUSTOMER_DEPOSIT_FORWARD",
      "DIRECT_TO_SUPPLIER",
      "REVERSAL",
    ]);
    expect(h.world.calls).toContain("ui:goto /org1/sales");
  });

  it("seeds the car with a VIN the product accepts: 17 uppercase characters with no I, O or Q", async () => {
    const h = harness();
    await h.run();
    expect(h.world.vins).toHaveLength(1);
    expect(h.world.vins[0]).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
  });

  it("drives the deal through the two seats: the OWNER submits and the MANAGER approves", async () => {
    const h = harness();
    await h.run();
    expect(h.world.calls).toContain("manager:applications:updateStatus");
    expect(h.world.calls).toContain("manager:financingEconomics:approveDealerPurchaseAmount");
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
  });

  it("refuses a mission for an oracle it does not judge, before touching the backend", async () => {
    const h = harness({}, { oracle: "UI_BACKEND_AUTHORITY" });
    await expect(h.run()).rejects.toThrow(/does not judge the UI_BACKEND_AUTHORITY oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("never passes when browser evidence cleanup fails", async () => {
    const h = harness({}, { finishFails: true });
    await expect(h.run()).rejects.toThrow(/browser evidence cleanup failed/);
  });

  it("stops touching the backend once the mission is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));
    const h = harness({}, { signal: controller.signal });
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    expect(h.world.calls).toEqual([]);
  });

  it("waits out the product's write rate limit and still passes", async () => {
    const h = harness({ rateLimitVehicleOnce: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.calls.filter((call) => call === "owner:vehicles:create")).toHaveLength(2);
  });

  it("never writes a credential or a connection string into the evidence", async () => {
    const h = harness();
    await h.run();
    const text = JSON.stringify(h.evidence);
    expect(text).not.toMatch(/token|secret|password|bearer|https?:\/\//i);
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: breaches", () => {
  it("reports a CONFIRMED breach, with its evidence written, when the car's gross price is recognized as revenue", async () => {
    const h = harness({ grossRecognition: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/gross price was recognized/);
    expect(result.oracle.summary).toMatch(/SALES_REVENUE was touched/);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]?.violations).not.toEqual([]);
    expect(result.artifacts).toContain("backend-state.json");
  });

  it("reports a breach for commission one minor unit above the independent margin", async () => {
    const result = await harness({ overstatedCommission: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/recognized revenue is 5000001 minor units, expected 5000000/);
  });

  it("reports a breach when the supplier is not owed his entitlement", async () => {
    const result = await harness({ shortSupplier: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/supplier payable is 14000000/);
  });

  it("reports a breach for a duplicated economic occurrence", async () => {
    const result = await harness({ duplicateEvent: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/2 posted SALE_COMPLETED events/);
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: never a vacuous pass", () => {
  const inconclusive = async (faults: Faults, pattern: RegExp) => {
    const h = harness(faults);
    const error = await h.run().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((error as Error).message).toMatch(pattern);
    // The evidence says why, labelled by what went wrong; no pass-shaped artifact exists.
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({ outcome: "INCONCLUSIVE" });
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    return h;
  };

  it("is inconclusive when the sale never reaches a posted journal", async () => {
    await inconclusive({ neverPosts: true }, /did not settle with a posted SALE_COMPLETED entry/);
  });

  it("is inconclusive, and seeds nothing, when the organization's settings are unreadable", async () => {
    const h = await inconclusive({ noSettings: true }, /currency is unreadable/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is inconclusive, and seeds nothing, when the currency has no known scale", async () => {
    const h = await inconclusive({ unknownCurrency: true }, /no known minor-unit scale/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is inconclusive, and seeds nothing, when the approver seat is in another organization", async () => {
    const h = await inconclusive({ seatsSplit: true }, /different organization/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is inconclusive when the stored vehicle is not the consigned car the scenario created", async () => {
    await inconclusive({ vehicleStoredAsStock: true }, /not the SOURCED car/);
  });

  it("is inconclusive, never a pass, when the posted journal hides a line on an account the chart does not list", async () => {
    // The mapped lines alone are a perfect agent-basis posting; only the unnamed pair betrays it.
    await inconclusive({ unmappedAccount: true }, /not in the chart/);
  });

  it("is inconclusive, never a pass, when finalizeDeal answers with an unrelated sale", async () => {
    const h = await inconclusive({ unrelatedSale: true }, /not the vehicle, customer, application and price this scenario seeded/);
    // The unrelated sale's journal was never read as this mission's evidence.
    expect(h.world.calls).not.toContain("owner:accountingLedger:listAccountingEvents");
  });

  it("is inconclusive when the finalized sale does not record the chosen route", async () => {
    await inconclusive({ routeNotRecorded: true }, /THROUGH_DEALERSHIP route/);
  });

  it("is inconclusive when the sales screen cannot be opened, so the screenshot would not show the deal", async () => {
    await inconclusive({ screenFails: true }, /sales screen could not be opened/);
  });

  it("is a harness error, not a pass, when the product refuses the approval", async () => {
    const h = harness({ approvalRefused: true });
    await expect(h.run()).rejects.toThrow(/Missing required permissions/);
    expect(h.evidence[0]).toMatchObject({ outcome: "HARNESS_ERROR" });
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });
});
