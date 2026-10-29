import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { createConsignmentAttackHandlers, type ConsignmentAttackOptions } from "./browserSwarmConsignmentAttack";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";

/**
 * SCRUM-350 CONS-1 v3 — handler-level tests for CONSIGNMENT_ECONOMICS.
 *
 * The real handler runs end to end against a scripted two-seat backend. The
 * scenario is a 20,000 consigned car (supplier owed 15,000) quoted at 20,000 to an
 * 85% financier that approves only 18,000, with a 200 deposit and a net shortfall
 * of 1,700 of which the customer pays 1,000. A correct product therefore posts
 * revenue of 19,000 − 15,000 − 2,500 = 1,500, where a margin measured on the
 * price would post 2,500: the two differ, so this scenario can certify.
 *
 * Every literal below is written out by hand (a `Plan`), never taken from the
 * production scenario builder, so a wrong figure in the builder cannot make both
 * sides agree. Each fault flips exactly one fact of the sale posting or of the
 * product's answers. No browser is launched.
 */

/** The figures the scripted product expects and posts, in JOD minor units (scale 1,000). */
interface Plan {
  ltv: number;
  depositMajor: number;
  quotation: number;
  approved: number;
  firstPayment: number;
  customerShare: number;
  dealerShare: number;
  /** The forward the product says is due: deposit + contribution. */
  forward: number;
  contra: number;
  commission: number;
}

const V3: Plan = {
  ltv: 85,
  depositMajor: 200,
  quotation: 20_000_000,
  approved: 18_000_000,
  firstPayment: 200_000,
  customerShare: 1_000_000,
  dealerShare: 700_000,
  forward: 2_700_000,
  contra: 2_500_000,
  commission: 4_000_000,
};

/** A 100% financier approving 19,000 with a 1,000 gap: approved + gap equals the price, so nothing is discriminated. */
const FILLED_GAP: Plan = {
  ...V3,
  ltv: 100,
  approved: 19_000_000,
  dealerShare: 0,
  forward: 200_000,
  contra: 0,
  commission: 5_000_000,
};
/** The handler options that run FILLED_GAP: the scripted product's plan and the scenario figures that match it. */
const FILLED_GAP_RUN = { plan: FILLED_GAP, figures: { ltvPercent: 100, approvedMajor: 19_000 } };

interface Faults {
  /** Posts the sale as dealership stock: gross revenue, COGS and inventory. */
  grossRecognition?: boolean;
  /** Commission one minor unit above the independent margin. */
  overstatedCommission?: boolean;
  /** The supplier is owed less than his entitlement. */
  shortSupplier?: boolean;
  /** Posts a balanced entry whose margin is measured on the sale price instead of approved + gap. */
  priceBasis?: boolean;
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
  /** The product refuses the gap agreement (its net shortfall differs from the scenario's). */
  gapRefused?: boolean;
  /** The product refuses the forward (its due amount differs from the scenario's). */
  forwardRefused?: boolean;
  /** The product serves no economics stamp for the gap agreement. */
  noGapStamp?: boolean;
  /** The posted journal carries an extra line on an account the chart does not list. */
  unmappedAccount?: boolean;
  /** finalizeDeal answers with another, unrelated sale (other vehicle, customer, application). */
  unrelatedSale?: boolean;
  /** Besides the posted sale, the sale holds an event that FAILED to post. */
  failedEvent?: boolean;
  /** The only event the sale holds is a SALE_COMPLETED that FAILED. */
  failedOnly?: boolean;
  /** The SALE_COMPLETED is POSTED but names no journal entry. */
  postedWithoutJournal?: boolean;
  /** An event the sale's query returned belongs to another source. */
  foreignSource?: boolean;
  /** The journal behind the posted event is not itself POSTED. */
  journalNotPosted?: boolean;
  /** The journal read back for the event names another accounting event. */
  journalOfOtherEvent?: boolean;
  /** A journal line carries a non-finite amount. */
  nanAmount?: boolean;
  /** A journal line carries a negative amount. */
  negativeAmount?: boolean;
  /** A journal line carries a debit and a credit at once. */
  bothSidesAmount?: boolean;
  /** The sales screen cannot be opened for the screenshot. */
  screenFails?: boolean;
  /** The first N vehicle creates hit the write rate limit ("Try again in 1s"). */
  rateLimitVehicleTimes?: number;
  /** The journal is right, but no supplier payable row exists for the sale. */
  payableAbsent?: boolean;
  /** The supplier payable row owes 14,000 instead of the 15,000 entitlement. */
  payableWrongAmount?: boolean;
  /** The supplier payable row is in USD. */
  payableWrongCurrency?: boolean;
  /** The supplier payable row names another sale (the car's row is attached to the wrong sale). */
  payableWrongSale?: boolean;
  /** The supplier payable row names another vehicle. */
  payableWrongVehicle?: boolean;
  /** Two supplier payable rows exist for the sale. */
  payableDuplicate?: boolean;
  /** A second payable row names this car under another sale, beside the correct one. */
  payableStrayForCar?: boolean;
  /** The supplier payable is already PAID in full. */
  payablePaid?: boolean;
  /** The supplier payable row is cancelled. */
  payableCancelled?: boolean;
  /** sourcingPayables.list is refused (the seat lacks VIEW_FINANCE). */
  payablesRefused?: boolean;
  /** sourcingPayables.list answers with something that is not a list. */
  payablesNotAList?: boolean;
  /** One payable row carries an amount that is not a number. */
  payableRowMalformed?: boolean;
}

const SCALE = 1_000;
const ACCOUNTS = [
  "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES",
  "ACCOUNTS_PAYABLE_FINANCE_COMPANIES",
  "ACCOUNTS_PAYABLE_SUPPLIERS",
  "ACCOUNTS_RECEIVABLE_CUSTOMERS",
  "CUSTOMER_DEPOSITS_LIABILITY",
  "SALES_CONSIDERATION_REDUCTIONS",
  "CONSIGNMENT_COMMISSION_REVENUE",
  "SALES_REVENUE",
  "COST_OF_VEHICLES_SOLD",
  "VEHICLE_INVENTORY",
];

/** Every key of every object inside `value`, however deep. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
}

class World {
  readonly calls: string[] = [];
  readonly argsOf: { name: string; args: Record<string, unknown> }[] = [];
  readonly vins: string[] = [];
  private nextId = 0;
  private vehicleRateLimits = 0;
  private saleId: string | null = null;
  private gapResolved = false;
  private handedOver = false;
  private forwarded = false;
  private depositHeld = false;
  private readonly seeded = { vehicle: "", customer: "", application: "" };

  constructor(
    readonly faults: Faults,
    readonly plan: Plan,
  ) {}

  id(prefix: string): string {
    this.nextId += 1;
    return `${prefix}${this.nextId}`;
  }

  get soldSaleId(): string | null {
    return this.saleId;
  }

  get seededVehicleId(): string {
    return this.seeded.vehicle;
  }

  private lines(): { accountId: string; debitMinor: number; creditMinor: number; currency: string; scale: number }[] {
    const currency = "JOD";
    const plan = this.plan;
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
    // Index 1 is the supplier payable: the amount faults below rewrite it.
    const correct = [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", plan.approved, 0),
      line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, (this.faults.shortSupplier ? 14_000 : 15_000) * SCALE),
      line("CONSIGNMENT_COMMISSION_REVENUE", 0, plan.commission + (this.faults.overstatedCommission ? 1 : 0)),
      line("ACCOUNTS_RECEIVABLE_CUSTOMERS", plan.customerShare, 0),
      line("CUSTOMER_DEPOSITS_LIABILITY", plan.firstPayment, 0),
      line("SALES_CONSIDERATION_REDUCTIONS", plan.contra, 0),
      line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, plan.forward),
    ];
    if (this.faults.priceBasis) {
      // Balanced and wrong: the customer's receivable and the commission both rise by the same
      // 1,000 (price − approved − gap), as if the margin were taken on the 20,000 price.
      correct[2] = line("CONSIGNMENT_COMMISSION_REVENUE", 0, 5_000 * SCALE);
      correct[3] = line("ACCOUNTS_RECEIVABLE_CUSTOMERS", 2_000 * SCALE, 0);
    }
    if (this.faults.nanAmount) correct[1] = { ...correct[1]!, creditMinor: Number.NaN };
    if (this.faults.negativeAmount) correct[1] = { ...correct[1]!, debitMinor: -1_000, creditMinor: 15_001_000 };
    if (this.faults.bothSidesAmount) correct[1] = { ...correct[1]!, debitMinor: 7 };
    // Balanced hidden pair: nothing in the mapped lines betrays it.
    return this.faults.unmappedAccount
      ? [...correct, line("HIDDEN_COGS", 15_000 * SCALE, 0), line("HIDDEN_INVENTORY", 0, 15_000 * SCALE)]
      : correct;
  }

  call(actor: "owner" | "manager", name: string, a: Record<string, unknown>): unknown {
    this.calls.push(`${actor}:${name}`);
    this.argsOf.push({ name, args: a });
    const plan = this.plan;
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
        if (a.defaultLtvPercent !== plan.ltv) throw new ConvexError("company LTV is not the scenario's");
        return this.id("company");
      case "suppliers:create":
        // SCRUM-868 P2: the consignment supplier master the SOURCED car is created against.
        return { supplierId: this.id("sup") };
      case "vehicles:create":
        if (typeof a.sourcedSupplierId !== "string" || "sourcedFromName" in a) {
          throw new ConvexError("scenario named the supplier by text instead of by master id");
        }
        if (this.vehicleRateLimits < (this.faults.rateLimitVehicleTimes ?? 0)) {
          this.vehicleRateLimits += 1;
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
        if (a.vehiclePrice !== 20_000 || a.downPayment !== 0) throw new ConvexError("quote is not the 20,000 car with no down payment");
        return this.id("quote");
      case "deposits:create":
        if (actor !== "owner") throw new ConvexError("deposit is taken by the primary seat");
        if (a.amount !== plan.depositMajor || a.method !== "CASH") throw new ConvexError("deposit is not the scenario's");
        this.depositHeld = true;
        return this.id("deposit");
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
        if (a.submittedQuotationMinor !== plan.quotation) throw new ConvexError("quotation is not in minor units");
        if (a.customerFirstPaymentMinor !== plan.firstPayment) throw new ConvexError("first payment is not the deposit in minor units");
        return null;
      case "financingEconomics:approveDealerPurchaseAmount":
        if (a.approvedAmountMinor !== plan.approved) throw new ConvexError("approval is not in minor units");
        if (actor !== "manager") throw new ConvexError("approval must come from the second seat");
        return null;
      case "applications:get":
        if (actor !== "manager") throw new ConvexError("the gap is read by the approver seat");
        return this.faults.noGapStamp ? { _id: this.seeded.application } : { _id: this.seeded.application, economicsStamp: "stamp-1" };
      case "financingEconomics:resolveAppraisalGap":
        if (actor !== "manager") throw new ConvexError("the gap is resolved by the approver seat");
        if (a.economicsStamp !== "stamp-1") throw new ConvexError("stale economics stamp");
        if (this.faults.gapRefused) throw new ConvexError("The gap shares must add up to the net shortfall.");
        if (
          a.customerGapShareMinor !== plan.customerShare ||
          a.dealerGapShareMinor !== plan.dealerShare ||
          a.customerGapCashToDealerMinor !== plan.customerShare ||
          a.customerGapInstallmentToDealerMinor !== 0 ||
          a.customerGapToFinanceCompanyMinor !== 0
        ) {
          throw new ConvexError("The gap shares must add up to the net shortfall.");
        }
        this.gapResolved = true;
        return null;
      case "applications:handoverStamp":
        return { stamp: "s" };
      case "applications:registerVehicleHandover":
        if (!this.gapResolved) throw new ConvexError("the gap must be resolved before handover");
        this.handedOver = true;
        return null;
      case "applications:registerExpectedPayment":
        return null;
      case "financeDealCosts:recordDealFee":
        return this.id("fee");
      case "financeDealCosts:reconcileDealFee":
        return null;
      case "financeCompanyForward:recordFinanceCompanyForward":
        if (actor !== "manager") throw new ConvexError("the forward is paid by the approver seat");
        if (!this.handedOver) throw new ConvexError("the forward needs a handover first");
        if (typeof a.paidAt !== "number" || a.paidAt > Date.now()) throw new ConvexError("paidAt is in the future");
        // SCRUM-54: the product refuses a bank on cash; this scenario pays cash and names none.
        if (a.method !== "CASH" || a.bankAccountId !== undefined) throw new ConvexError("A bank account applies only to a bank transfer, card or cheque payment.");
        if (this.faults.forwardRefused || a.expectedAmountMinor !== plan.forward) {
          throw new ConvexError("The amount due to the finance company has changed.");
        }
        this.forwarded = true;
        return null;
      case "applications:finalizeDeal":
        if (!this.forwarded) throw new ConvexError("the forward to the finance company has not been paid");
        if (!this.depositHeld) throw new ConvexError("no deposit is held");
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
        const source = { sourceType: "sales", sourceId: this.saleId };
        if (this.faults.neverPosts) return [{ _id: "ev-p", eventType: "SALE_COMPLETED", status: "PENDING", ...source }];
        if (this.faults.failedOnly) return [{ _id: "ev-f", eventType: "SALE_COMPLETED", status: "FAILED", ...source }];
        const event = {
          _id: "ev-1",
          eventType: "SALE_COMPLETED",
          status: "POSTED",
          ...(this.faults.postedWithoutJournal ? {} : { journalEntryId: "je-1" }),
          ...source,
          ...(this.faults.foreignSource ? { sourceId: "sale-other" } : {}),
        };
        if (this.faults.failedEvent) return [event, { _id: "ev-f", eventType: "DEPOSIT_RECEIVED", status: "FAILED", ...source }];
        return this.faults.duplicateEvent ? [event, { ...event, _id: "ev-2", journalEntryId: "je-2" }] : [event];
      }
      case "accountingLedger:getJournalEntry":
        // The duplicate event posts the same economics again: only the count is wrong.
        return {
          entry: {
            _id: a.journalEntryId,
            status: this.faults.journalNotPosted ? "DRAFT" : "POSTED",
            accountingEventId: this.faults.journalOfOtherEvent ? "ev-other" : a.journalEntryId === "je-2" ? "ev-2" : "ev-1",
          },
          lines: this.faults.duplicateEvent && a.journalEntryId === "je-2" ? [] : this.lines(),
        };
      case "sourcingPayables:list": {
        if (actor !== "owner") throw new ConvexError("the payables are read by the primary seat");
        if (this.faults.payablesRefused) throw new ConvexError("Forbidden: Missing required permissions");
        if (this.faults.payablesNotAList) return { rows: [] };
        const row = (over: Record<string, unknown> = {}) => ({
          _id: this.id("pay"),
          orgId: "org1",
          vehicleId: this.seeded.vehicle,
          saleId: this.saleId,
          sourcedFromName: "Swarm Supplier",
          amountDue: 15_000,
          currency: "JOD",
          status: "PENDING",
          vehicleDesc: "2022 Toyota Camry-cons1",
          ...over,
        });
        // The organization's list always holds another sale's payable, so a reader that does not filter is caught.
        const unrelated = row({ vehicleId: "veh-other", saleId: "sale-other", amountDue: 999 });
        const faults = this.faults;
        const own = row({
          ...(faults.payableWrongAmount ? { amountDue: 14_000 } : {}),
          ...(faults.payableWrongCurrency ? { currency: "USD" } : {}),
          ...(faults.payableWrongSale ? { saleId: "sale-other" } : {}),
          ...(faults.payableWrongVehicle ? { vehicleId: "veh-other" } : {}),
          ...(faults.payablePaid ? { status: "PAID", amountPaid: 15_000 } : {}),
          ...(faults.payableCancelled ? { status: "CANCELLED" } : {}),
          ...(faults.payableRowMalformed ? { amountDue: "15000" } : {}),
        });
        if (faults.payableAbsent) return [unrelated];
        return [
          unrelated,
          own,
          ...(faults.payableDuplicate ? [row()] : []),
          ...(faults.payableStrayForCar ? [row({ saleId: "sale-earlier" })] : []),
        ];
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

function harness(
  faults: Faults = {},
  options: {
    signal?: AbortSignal;
    finishFails?: boolean;
    oracle?: string;
    onSleep?: (ms: number) => void;
    plan?: Plan;
    figures?: ConsignmentAttackOptions["figures"];
  } = {},
) {
  const world = new World(faults, options.plan ?? V3);
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
  const sleeps: number[] = [];
  const handler = createConsignmentAttackHandlers(runtimeApi, {
    sleep: async (ms) => {
      sleeps.push(ms);
      options.onSleep?.(ms);
    },
    pollMs: 1,
    postingWaitMs: 500,
    uiSettleMs: 0,
    ...(options.figures ? { figures: options.figures } : {}),
  }).CONSIGNMENT_ECONOMICS;
  if (!handler) throw new Error("no handler registered for CONSIGNMENT_ECONOMICS");
  return { run: () => handler(context), world, evidence, opened, sleeps };
}

/** Runs the handler and returns whatever it ended in, a result or the error it threw. */
const settle = (h: { run: () => Promise<unknown> }): Promise<unknown> => h.run().catch((thrown: unknown) => thrown);

/** Asserts the mission ended INCONCLUSIVE for `pattern`, with its evidence written and every seat finished. */
const inconclusive = async (faults: Faults, pattern: RegExp) => {
  const h = harness(faults);
  const error = await settle(h);
  expect(error).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  expect((error as Error).message).toMatch(pattern);
  // The evidence says why, labelled by what went wrong; no pass-shaped artifact exists.
  expect(h.evidence).toHaveLength(1);
  expect(h.evidence[0]).toMatchObject({ outcome: "INCONCLUSIVE" });
  expect(h.opened.every((entry) => entry.finished)).toBe(true);
  return h;
};

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler v3: the discriminating scenario", () => {
  it("PASSES a correct product, whose revenue (1,500) differs from the price-basis revenue (2,500)", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
    expect(h.world.calls).toContain("ui:goto /org1/sales");
    expect(h.opened.map((entry) => entry.seat).sort()).toEqual(["approver", "primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "CONSIGNMENT_ECONOMICS",
      oracle: "ECONOMIC_AUTHORITY",
      currency: "JOD",
      settlementRoute: "THROUGH_DEALERSHIP",
      notDiscriminated: [],
      unjudged: [],
      violations: [],
      invoiceSeeded: false,
      expected: {
        priceMinor: 20_000_000,
        approvedMinor: 18_000_000,
        entitlementMinor: 15_000_000,
        contributionMinor: 2_500_000,
        depositForwardMinor: 200_000,
        customerGapMinor: 1_000_000,
        route: "THROUGH_DEALERSHIP",
      },
      scenario: {
        quotationMinor: 20_000_000,
        ltvPercent: 85,
        firstPaymentMinor: 200_000,
        netShortfallMinor: 1_700_000,
        customerShareMinor: 1_000_000,
        dealerShareMinor: 700_000,
        forwardDueMinor: 2_700_000,
        expectedRevenueMinor: 1_500_000,
        priceBasisRevenueMinor: 2_500_000,
      },
      ledger: { complete: true },
    });
    // What the scenario did not exercise is stated, so no result is read as more than it proved.
    expect(h.evidence[0]?.notExercised).toEqual([
      "DIRECT_TO_SUPPLIER",
      "CUSTOMER_PAYMENT_TO_FINANCE_COMPANY",
      "CUSTOMER_GAP_COLLECTION",
      "REVERSAL",
      "DEPOSIT_RECEIPT_AND_FORWARD_PAYMENT_POSTINGS",
      "FINANCE_COMPANY_RECEIVABLE_SUBLEDGER",
      "CUSTOMER_RECEIVABLE_SUBLEDGER",
    ]);
    expect(result.oracle.summary).toMatch(/Not read: the deposit-receipt and forward-payment postings/);
  });

  it("FAILS a product that measures the margin on the sale price, which approved < price alone would not have caught", async () => {
    const h = harness({ priceBasis: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/recognized revenue is 2500000 minor units, expected 1500000/);
    expect(result.oracle.summary).toMatch(/the margin was measured on the sale price 20000000 instead of the approved amount plus the customer's gap/);
    expect(result.oracle.summary).toMatch(/commission revenue is 5000000 minor units, expected the margin 4000000/);
    expect(result.oracle.summary).toMatch(/the receivable from the customer is 2000000 minor units, expected the gap 1000000/);
    expect(h.evidence[0]).toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(/measured on the sale price/)]) });
  });

  it("seeds no legal invoice: no invoice command is called and no argument carries an invoice field", async () => {
    const h = harness();
    await h.run();
    expect(h.world.calls.filter((call) => /invoice/i.test(call))).toEqual([]);
    expect(h.world.argsOf.flatMap((entry) => keysDeep(entry.args)).filter((key) => /invoice/i.test(key))).toEqual([]);
    expect(JSON.stringify(h.world.argsOf)).not.toMatch(/SWARM-|legalInvoice/);
  });

  it("is INCONCLUSIVE (UNAVAILABLE), never a pass, when approved plus the gap equals the price", async () => {
    const h = harness({}, FILLED_GAP_RUN);
    const outcome = await settle(h);
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((outcome as Error).message).toMatch(/UNAVAILABLE.*APPROVED_VS_PRICE_BASIS/);
    // The whole scenario still ran and was read, so the operator can see what was not certified.
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
    expect(h.evidence[0]).toMatchObject({
      outcome: "INCONCLUSIVE",
      notDiscriminated: ["APPROVED_VS_PRICE_BASIS"],
      unjudged: [expect.stringMatching(/APPROVED_VS_PRICE_BASIS/)],
      scenario: { expectedRevenueMinor: 5_000_000, priceBasisRevenueMinor: 5_000_000 },
    });
  });

  it("still reports a proven breach when the scenario cannot discriminate, with the gap stated alongside it", async () => {
    const h = harness({ grossRecognition: true }, FILLED_GAP_RUN);
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(h.evidence[0]).toMatchObject({ phase: "PARTIAL", unjudged: [expect.stringMatching(/APPROVED_VS_PRICE_BASIS/)] });
  });

  it("is INCONCLUSIVE, and seeds nothing, when the scenario's figures cannot form a shortfall", async () => {
    // Approved at the quotation leaves no shortfall to share, so the customer's 1,000 has nothing to cover.
    const h = harness({}, { figures: { approvedMajor: 20_000 } });
    const outcome = await settle(h);
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((outcome as Error).message).toMatch(/net shortfall/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is INCONCLUSIVE, and seeds nothing, when the scenario's figures leave the oracle no margin to judge", async () => {
    // An entitlement equal to the approval is refused by the builder, not discovered after the deal is finalized.
    const h = harness({}, { figures: { entitlementMajor: 18_000 } });
    const outcome = await settle(h);
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((outcome as Error).message).toMatch(/positive margin.*nothing was seeded/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is INCONCLUSIVE when the product refuses the gap agreement for the independently derived shortfall", async () => {
    const h = await inconclusive({ gapRefused: true }, /refused the gap agreement for the independently derived net shortfall of 1700000 \(customer 1000000, dealership 700000\)/);
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });

  it("is INCONCLUSIVE when the product serves no economics stamp for the gap agreement", async () => {
    await inconclusive({ noGapStamp: true }, /no economics stamp for the gap agreement/);
  });

  it("is INCONCLUSIVE when the product refuses the forward of the independently derived H + D", async () => {
    const h = await inconclusive({ forwardRefused: true }, /refused the forward to the financier of the independently derived 2700000 \(deposit 200000 plus contribution 2500000\)/);
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });

  it("orders the deal: deposit, then the gap, handover, the forward, and only then finalize", async () => {
    const h = harness();
    await h.run();
    const order = [
      "owner:deposits:create",
      "manager:financingEconomics:resolveAppraisalGap",
      "owner:applications:registerVehicleHandover",
      "manager:financeCompanyForward:recordFinanceCompanyForward",
      "owner:applications:finalizeDeal",
    ].map((call) => h.world.calls.indexOf(call));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: mission contract", () => {
  it("seeds the car with a VIN the product accepts: 17 uppercase characters with no I, O or Q", async () => {
    const h = harness();
    await settle(h);
    expect(h.world.vins).toHaveLength(1);
    expect(h.world.vins[0]).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
  });

  it("drives the deal through the two seats: the OWNER submits and the MANAGER approves", async () => {
    const h = harness();
    await settle(h);
    expect(h.world.calls).toContain("manager:applications:updateStatus");
    expect(h.world.calls).toContain("manager:financingEconomics:approveDealerPurchaseAmount");
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
  });

  it("refuses a mission for an oracle it does not judge, before touching the backend", async () => {
    const h = harness({}, { oracle: "UI_BACKEND_AUTHORITY" });
    await expect(h.run()).rejects.toThrow(/does not judge the UI_BACKEND_AUTHORITY oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("reports a browser cleanup failure beside a proven breach, never hiding either", async () => {
    const h = harness({ grossRecognition: true }, { finishFails: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed/);
  });

  it("stops touching the backend once the mission is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));
    const h = harness({}, { signal: controller.signal });
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    expect(h.world.calls).toEqual([]);
  });

  it("waits out the product's write rate limit and still runs the scenario to a pass", async () => {
    const h = harness({ rateLimitVehicleTimes: 1 });
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.evidence[0]).toMatchObject({ ledger: { complete: true } });
    expect(h.world.calls.filter((call) => call === "owner:vehicles:create")).toHaveLength(2);
    // "Try again in 1s" is waited out for one second more than it asks.
    expect(h.sleeps.filter((ms) => ms === 2_000)).toHaveLength(1);
  });

  it("retries a rate-limited command exactly three times: the fourth attempt goes through", async () => {
    const h = harness({ rateLimitVehicleTimes: 3 });
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.evidence[0]).toMatchObject({ ledger: { complete: true } });
    expect(h.world.calls.filter((call) => call === "owner:vehicles:create")).toHaveLength(4);
    expect(h.sleeps.filter((ms) => ms === 2_000)).toHaveLength(3);
  });

  it("throws the rate limit once the three retries are spent, and goes no further", async () => {
    const h = harness({ rateLimitVehicleTimes: 4 });
    await expect(h.run()).rejects.toThrow(/Rate limit exceeded/);
    expect(h.world.calls.filter((call) => call === "owner:vehicles:create")).toHaveLength(4);
    // One wait between each pair of attempts, none after the last.
    expect(h.sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
    expect(h.evidence[0]).toMatchObject({ outcome: "HARNESS_ERROR" });
  });

  it("makes no further attempt when the mission is aborted while waiting out a rate limit", async () => {
    const controller = new AbortController();
    const h = harness(
      { rateLimitVehicleTimes: 4 },
      { signal: controller.signal, onSleep: () => controller.abort(new Error("mission timed out")) },
    );
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    expect(h.world.calls.filter((call) => call === "owner:vehicles:create")).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({ outcome: "HARNESS_ERROR" });
  });

  it("never writes a credential or a connection string into the evidence", async () => {
    const h = harness();
    await settle(h);
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
    expect(result.oracle.summary).toMatch(/recognized revenue is 1500001 minor units, expected 1500000/);
    expect(result.oracle.summary).toMatch(/commission revenue is 4000001 minor units, expected the margin 4000000/);
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

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: the canonical supplier payable", () => {
  it("reads the payables through the public list on the primary seat, with the organization only, and keeps this sale's row as evidence", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    const reads = h.world.argsOf.filter((entry) => entry.name === "sourcingPayables:list");
    expect(reads).toEqual([{ name: "sourcingPayables:list", args: { orgId: "org1" } }]);
    expect(h.world.calls).toContain("owner:sourcingPayables:list");
    // Only the rows of this sale or car are kept; the unrelated sale's 999 row is not evidence.
    expect(h.evidence[0]?.supplierPayables).toEqual([
      {
        id: expect.stringMatching(/^pay/),
        saleId: h.world.soldSaleId,
        vehicleId: h.world.seededVehicleId,
        currency: "JOD",
        amountDueMajor: 15_000,
        amountPaidMajor: 0,
        status: "PENDING",
      },
    ]);
  });

  // In every case below the sale's journal is correct: the only defect is in the canonical supplier record.
  const breaches: [string, Faults, RegExp][] = [
    ["no payable row exists for the sale", { payableAbsent: true }, /no supplier payable row exists for sale sale\d+, although the journal credits the supplier 15000000/],
    ["the payable owes 14,000 instead of the 15,000 entitlement", { payableWrongAmount: true }, /owes 14000000 minor units, expected the supplier's entitlement 15000000/],
    ["the payable is denominated in another currency", { payableWrongCurrency: true }, /is denominated USD, not JOD/],
    ["the car's payable is attached to another sale", { payableWrongSale: true }, /is for this car but names sale sale-other, not sale sale\d+/],
    ["the payable names another vehicle", { payableWrongVehicle: true }, /is for vehicle veh-other, not the sold car veh\d+/],
    ["two payable rows exist for the sale", { payableDuplicate: true }, /2 supplier payable rows exist for sale/],
    ["another payable names this car under an earlier sale", { payableStrayForCar: true }, /is for this car but names sale sale-earlier/],
    ["the payable is already paid in full", { payablePaid: true }, /has status PAID, expected an unpaid one/],
    ["the payable is cancelled", { payableCancelled: true }, /has status CANCELLED, expected an unpaid one/],
  ];
  for (const [title, faults, pattern] of breaches) {
    it(`reports a breach, never a pass, with a correct journal when ${title}`, async () => {
      const h = harness(faults);
      const result = await h.run();
      expect(result.oracle.passed).toBe(false);
      expect(result.oracle.summary).toMatch(pattern);
      // The ledger side is clean: the breach is the supplier record alone.
      expect(result.oracle.summary).not.toMatch(/recognized revenue|commission revenue|supplier payable is \d/);
      expect(h.evidence[0]).toMatchObject({ violations: expect.arrayContaining([expect.stringMatching(pattern)]), unjudged: [] });
    });
  }

  it("is INCONCLUSIVE, never a pass, when the seat is refused the payable list, and says the supplier record is unverified", async () => {
    const h = await inconclusive({ payablesRefused: true }, /canonical supplier payable could not be read.*Missing required permissions.*unverified/);
    expect(h.world.calls).toContain("owner:sourcingPayables:list");
    // The journal was read and judged first, and its evidence is kept.
    expect(h.evidence[0]).toMatchObject({ ledger: { complete: true } });
  });

  it("is INCONCLUSIVE when the payable list is not a list", async () => {
    await inconclusive({ payablesNotAList: true }, /sourcingPayables\.list returned a non-array response/);
  });

  it("is INCONCLUSIVE when a payable row carries an amount that is not a number", async () => {
    await inconclusive({ payableRowMalformed: true }, /malformed supplier payable row/);
  });

  it("still reports a proven journal breach when the payable list is refused, with the unread record stated beside it", async () => {
    const h = harness({ overstatedCommission: true, payablesRefused: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/commission revenue is 4000001/);
    expect(h.evidence[0]).toMatchObject({
      phase: "PARTIAL",
      unjudged: [expect.stringMatching(/canonical supplier payable could not be read/)],
    });
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: B2 line amounts", () => {
  it("reports a breach for a negative journal line amount", async () => {
    const result = await harness({ negativeAmount: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/ACCOUNTS_PAYABLE_SUPPLIERS line .* not a nonnegative safe integer/);
  });

  it("reports a breach for a journal line that carries a debit and a credit at once", async () => {
    const result = await harness({ bothSidesAmount: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/carries both a debit and a credit/);
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: B4 event and journal failures", () => {
  it("reports a breach, naming the event, when the sale holds an event that FAILED to post", async () => {
    const h = harness({ failedEvent: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/event ev-f \(DEPOSIT_RECEIVED\) FAILED/);
    expect(h.evidence[0]).toMatchObject({ violations: [expect.stringMatching(/ev-f/)] });
  });

  it("reports a breach, not an inconclusive wait, when the only SALE_COMPLETED FAILED", async () => {
    const h = harness({ failedOnly: true });
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/event ev-f \(SALE_COMPLETED\) FAILED/);
    expect(result.oracle.summary).toMatch(/0 posted SALE_COMPLETED events/);
  });

  it("reports a breach when a POSTED event names no journal entry", async () => {
    const result = await harness({ postedWithoutJournal: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/event ev-1 \(SALE_COMPLETED\) is POSTED but names no journal entry/);
  });

  it("reports a breach when the journal behind a posted event is not itself POSTED", async () => {
    const result = await harness({ journalNotPosted: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/journal je-1 .* status DRAFT, not POSTED/);
  });

  it("is inconclusive, never a pass, when a returned event belongs to another source", async () => {
    await inconclusive({ foreignSource: true }, /belongs to sales\/sale-other, not sales\/sale\d+/);
  });

  it("is inconclusive, never a pass, when the journal read back belongs to another accounting event", async () => {
    await inconclusive({ journalOfOtherEvent: true }, /journal je-1 belongs to accounting event ev-other, not ev-1/);
  });

  it("is inconclusive when a journal line carries a non-finite amount", async () => {
    await inconclusive({ nanAmount: true }, /malformed line/);
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: B5 evidence survives a non-pass", () => {
  it("keeps the expectation and the last ledger read when the ledger never settles", async () => {
    const h = harness({ neverPosts: true });
    await settle(h);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      outcome: "INCONCLUSIVE",
      expected: { approvedMinor: 18_000_000, entitlementMinor: 15_000_000, route: "THROUGH_DEALERSHIP" },
      ledger: { complete: true, events: [{ id: "ev-p", eventType: "SALE_COMPLETED", status: "PENDING" }] },
    });
    expect((h.evidence[0]?.ledger as { reads: number }).reads).toBeGreaterThan(1);
  });

  it("keeps the unmapped account id when the journal posts to an account the chart cannot name", async () => {
    const h = harness({ unmappedAccount: true });
    await settle(h);
    expect(h.evidence[0]).toMatchObject({
      outcome: "INCONCLUSIVE",
      ledger: {
        unmappedAccountIds: ["acct-HIDDEN_COGS", "acct-HIDDEN_INVENTORY"],
        journals: [{ id: "je-1", eventId: "ev-1", status: "POSTED" }],
      },
    });
  });

  it("keeps event, journal and account ids in the evidence of a breach", async () => {
    const h = harness({ grossRecognition: true });
    await h.run();
    expect(h.evidence[0]).toMatchObject({
      expected: { approvedMinor: 18_000_000 },
      ledger: {
        complete: true,
        events: [{ id: "ev-1", eventType: "SALE_COMPLETED", status: "POSTED", journalEntryId: "je-1" }],
        journals: [{ id: "je-1", eventId: "ev-1", status: "POSTED" }],
        lines: expect.arrayContaining([
          expect.objectContaining({ accountId: "acct-SALES_REVENUE", entryId: "je-1", key: "SALES_REVENUE" }),
        ]),
      },
    });
  });
});

describe("SCRUM-350 CONSIGNMENT_ECONOMICS handler: never a vacuous pass", () => {
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
    // The mapped lines alone are a perfect posting; only the unnamed pair betrays it.
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
