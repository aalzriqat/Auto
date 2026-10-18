import type { Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import type { BrowserMissionExecutionContext } from "./browserAttackSwarmExecutor";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import type { MissionBrowser, MissionBrowserRuntime, MissionSeat } from "./browserSwarmEconomicAttacks";
import { createMoneyBoundaryAttackHandlers, type MoneyBoundaryAttackOptions } from "./browserSwarmMoneyBoundaryAttack";

/**
 * SCRUM-350 ACC-1 — handler-level tests for MONEY_BOUNDARY.
 *
 * The real handler runs end to end against a scripted two-seat backend. The scenario is a
 * 20,000 car the dealership bought for 15,000, quoted at 20,000 to an 85% financier that
 * approves only 18,000, with a 200 deposit, a net shortfall of 1,700 of which the customer
 * pays 1,000, and a 300 admin fee the dealership pays itself. A correct product posts
 * revenue of 19,000 (not the 20,000 price), owes the financier the full 18,000, and relieves
 * 15,000 of inventory.
 *
 * Every literal below is written out by hand (a `Plan`, and the lines in `lines()`), never
 * taken from the production scenario builder, so a wrong figure there cannot make both sides
 * agree. Each fault flips exactly one fact of the posting or of the product's answers. No
 * browser is launched.
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
  /** The dealership-paid admin fee. */
  adminFee: number;
  /** The sale revenue K = approved + customer gap. */
  revenue: number;
}

const ACC1: Plan = {
  ltv: 85,
  depositMajor: 200,
  quotation: 20_000_000,
  approved: 18_000_000,
  firstPayment: 200_000,
  customerShare: 1_000_000,
  dealerShare: 700_000,
  forward: 2_700_000,
  contra: 2_500_000,
  adminFee: 300_000,
  revenue: 19_000_000,
};

/** A 100% financier approving 19,000 with a 1,000 gap: approved + gap equals the price and no contribution exists. */
const EQUAL_BASIS: Plan = { ...ACC1, ltv: 100, approved: 19_000_000, dealerShare: 0, forward: 200_000, contra: 0, revenue: 20_000_000 };
const EQUAL_BASIS_RUN = { plan: EQUAL_BASIS, figures: { ltvPercent: 100, approvedMajor: 19_000 } };

interface Faults {
  /** Posts revenue on the 20,000 price, raising the customer receivable by the same 1,000 so the entry balances. */
  priceBasis?: boolean;
  /** The financier receivable is net of the 300 admin fee, the fee posted as an expense. */
  feeNetted?: boolean;
  /** Posts the sale on agent basis: a commission and a supplier payable, no revenue, COGS or inventory. */
  agentBasis?: boolean;
  /** The deposit is debited to cash instead of releasing the deposit liability. */
  depositToCash?: boolean;
  /** Inventory is relieved by one minor unit less than the car's cost. */
  inventoryShort?: boolean;
  /** The sale never reaches a posted journal. */
  neverPosts?: boolean;
  /** The sale is POSTED but its journal has no lines. */
  emptyJournal?: boolean;
  /** Two SALE_COMPLETED events for one sale. */
  duplicateEvent?: boolean;
  /** The organization's settings are unreadable. */
  noSettings?: boolean;
  /** The organization is denominated in a currency with no known scale. */
  unknownCurrency?: boolean;
  /** The approver signs in to a different organization. */
  seatsSplit?: boolean;
  /** The stored vehicle is a consigned car, not the dealership's own. */
  vehicleStoredAsSourced?: boolean;
  /** The stored vehicle's purchase price is not the scenario's. */
  vehicleWrongCost?: boolean;
  /** The product refuses the gap agreement. */
  gapRefused?: boolean;
  /** The product refuses the forward. */
  forwardRefused?: boolean;
  /** The product refuses to record the admin fee. */
  feeRefused?: boolean;
  /** The product refuses the direct payment of the admin fee. */
  feePaymentRefused?: boolean;
  /** The fee list reads back something other than one reconciled dealership-paid fee line. */
  feeReadback?: "wrongAmount" | "twoLines" | "deducted" | "notReconciled" | "otherApplication" | "empty" | "unpaid";
  /** finalizeDeal answers with a sale of another organization. */
  saleOtherOrg?: boolean;
  /** The product refuses to reconcile the admin fee. */
  feeReconcileRefused?: boolean;
  /** The product serves no economics stamp for the gap agreement. */
  noGapStamp?: boolean;
  /** The posted journal carries an extra line on an account the chart cannot name. */
  unmappedAccount?: boolean;
  /** finalizeDeal answers with another, unrelated sale. */
  unrelatedSale?: boolean;
  /** Besides the posted sale, the sale holds an event that FAILED to post. */
  failedEvent?: boolean;
  /** The sales screen cannot be opened for the screenshot. */
  screenFails?: boolean;
  /** The first N vehicle creates hit the write rate limit. */
  rateLimitVehicleTimes?: number;
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
  "CASH_ON_HAND",
  "SELLING_EXPENSES",
];

class World {
  readonly calls: string[] = [];
  readonly argsOf: { name: string; args: Record<string, unknown> }[] = [];
  readonly vins: string[] = [];
  private nextId = 0;
  private vehicleRateLimits = 0;
  private saleId: string | null = null;
  private feeId = "";
  private gapResolved = false;
  private handedOver = false;
  private forwarded = false;
  private feePaid = false;
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

  private lines(): { accountId: string; debitMinor: number; creditMinor: number; currency: string; scale: number }[] {
    const plan = this.plan;
    const faults = this.faults;
    const line = (key: string, debitMinor: number, creditMinor: number) => ({
      accountId: `acct-${key}`,
      debitMinor,
      creditMinor,
      currency: "JOD",
      scale: 3,
    });
    if (faults.emptyJournal) return [];
    if (faults.agentBasis) {
      // Balanced, the same bottom line (19,000 − 2,500 − 15,000), and on the wrong accounts entirely.
      return [
        line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", plan.approved, 0),
        line("ACCOUNTS_RECEIVABLE_CUSTOMERS", plan.customerShare, 0),
        line("CUSTOMER_DEPOSITS_LIABILITY", plan.firstPayment, 0),
        line("SALES_CONSIDERATION_REDUCTIONS", plan.contra, 0),
        line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, plan.forward),
        line("ACCOUNTS_PAYABLE_SUPPLIERS", 0, 15_000 * SCALE),
        line("CONSIGNMENT_COMMISSION_REVENUE", 0, plan.revenue - 15_000 * SCALE),
      ];
    }
    const correct = [
      line("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES", plan.approved - (faults.feeNetted ? 300 * SCALE : 0), 0),
      line("ACCOUNTS_RECEIVABLE_CUSTOMERS", plan.customerShare + (faults.priceBasis ? 1_000 * SCALE : 0), 0),
      faults.depositToCash ? line("CASH_ON_HAND", plan.firstPayment, 0) : line("CUSTOMER_DEPOSITS_LIABILITY", plan.firstPayment, 0),
      line("SALES_CONSIDERATION_REDUCTIONS", plan.contra, 0),
      line("COST_OF_VEHICLES_SOLD", 15_000 * SCALE, 0),
      line("ACCOUNTS_PAYABLE_FINANCE_COMPANIES", 0, plan.forward),
      line("SALES_REVENUE", 0, plan.revenue + (faults.priceBasis ? 1_000 * SCALE : 0)),
      line("VEHICLE_INVENTORY", 0, 15_000 * SCALE - (faults.inventoryShort ? 1 : 0)),
    ];
    if (faults.feeNetted) correct.push(line("SELLING_EXPENSES", 300 * SCALE, 0));
    if (faults.inventoryShort) correct.push(line("SELLING_EXPENSES", 1, 0));
    // Balanced hidden pair: nothing in the mapped lines betrays it.
    return faults.unmappedAccount
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
        if (a.adminFees !== 0) throw new ConvexError("the company must configure no fee: the admin fee is the dealership's own");
        return this.id("company");
      case "vehicles:create":
        if (this.vehicleRateLimits < (this.faults.rateLimitVehicleTimes ?? 0)) {
          this.vehicleRateLimits += 1;
          throw new ConvexError("Rate limit exceeded. Try again in 1s");
        }
        this.vins.push(String(a.vin));
        if (a.sourceType !== "STOCK" || a.purchasePrice !== 15_000 || a.sellingPrice !== 20_000 || "sourceCost" in a) {
          throw new ConvexError("scenario sent a car other than the dealership's own stock");
        }
        this.seeded.vehicle = this.id("veh");
        return this.seeded.vehicle;
      case "vehicles:get":
        if (this.faults.vehicleStoredAsSourced) return { sourceType: "SOURCED", sourceCost: 15_000, purchasePrice: 15_000 };
        return { sourceType: "STOCK", purchasePrice: this.faults.vehicleWrongCost ? 14_000 : 15_000 };
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
        if (a.status === "APPROVED" && actor !== "manager") throw new ConvexError("approval must come from the second seat");
        return null;
      case "applications:setSupplierSettlementRoute":
        throw new ConvexError("This vehicle is dealership stock, so there is no supplier to settle with and no settlement route to choose.");
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
        if (
          this.faults.gapRefused ||
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
        if (this.faults.feeRefused) throw new ConvexError("A paid date is required for a cost with an actual amount.");
        if (
          a.deductedFromSettlement !== false ||
          a.actualAmountMinor !== plan.adminFee ||
          a.paidBy !== "DEALER" ||
          a.expectedCurrency !== "JOD" ||
          typeof a.paidAt !== "number" ||
          a.paidAt > Date.now()
        ) {
          throw new ConvexError("the fee is not the dealership-paid 300 admin fee");
        }
        this.feeId = this.id("fee");
        return this.feeId;
      case "financeDealCosts:reconcileDealFee":
        if (this.faults.feeReconcileRefused) throw new ConvexError("The fee has changed since it was reviewed.");
        if (a.expectedActualAmountMinor !== plan.adminFee) throw new ConvexError("reconciled amount is not the fee's");
        return null;
      case "financeDealCosts:recordDirectFeePayment":
        if (this.faults.feePaymentRefused) throw new ConvexError("This cost cannot be paid directly.");
        if (
          actor !== "owner" ||
          a.feeId !== this.feeId ||
          a.method !== "BANK_TRANSFER" ||
          a.expectedAmountMinor !== plan.adminFee ||
          typeof a.paidAt !== "number" ||
          a.paidAt > Date.now() ||
          typeof a.idempotencyKey !== "string"
        ) {
          throw new ConvexError("the payment is not the dealership's 300 admin fee by bank transfer");
        }
        this.feePaid = true;
        return null;
      case "financeDealCosts:listDealCosts": {
        const mode = this.faults.feeReadback;
        if (mode === "empty") return { fees: [] };
        const fee = {
          _id: this.feeId,
          applicationId: mode === "otherApplication" ? "app-other" : this.seeded.application,
          currency: "JOD",
          actualAmountMinor: mode === "wrongAmount" ? plan.adminFee - 1 : plan.adminFee,
          paidBy: "DEALER",
          deductedFromSettlement: mode === "deducted",
          status: mode === "notReconciled" ? "ACTUAL_RECORDED" : "RECONCILED",
          handoverPayment: this.feePaid && mode !== "unpaid" ? "PAID_DIRECT" : "UNPAID",
        };
        return { fees: mode === "twoLines" ? [fee, { ...fee, _id: "fee-extra" }] : [fee] };
      }
      case "financeCompanyForward:recordFinanceCompanyForward":
        if (actor !== "manager") throw new ConvexError("the forward is paid by the approver seat");
        if (!this.handedOver) throw new ConvexError("the forward needs a handover first");
        // The product's own guard: a dealership-paid cost with no recorded payment blocks the forward.
        if (!this.feePaid) throw new ConvexError("A dealership-paid cost has no recorded payment, so the forward is refused.");
        if (typeof a.paidAt !== "number" || a.paidAt > Date.now()) throw new ConvexError("paidAt is in the future");
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
          orgId: this.faults.saleOtherOrg ? "org-other" : "org1",
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
        const event = { _id: "ev-1", eventType: "SALE_COMPLETED", status: "POSTED", journalEntryId: "je-1", ...source };
        if (this.faults.failedEvent) return [event, { _id: "ev-f", eventType: "DEPOSIT_RECEIVED", status: "FAILED", ...source }];
        return this.faults.duplicateEvent ? [event, { ...event, _id: "ev-2", journalEntryId: "je-2" }] : [event];
      }
      case "accountingLedger:getJournalEntry":
        return {
          entry: { _id: a.journalEntryId, status: "POSTED", accountingEventId: a.journalEntryId === "je-2" ? "ev-2" : "ev-1" },
          lines: this.faults.duplicateEvent && a.journalEntryId === "je-2" ? [] : this.lines(),
        };
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
    plan?: Plan;
    figures?: MoneyBoundaryAttackOptions["figures"];
  } = {},
) {
  const world = new World(faults, options.plan ?? ACC1);
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
    mission: { id: "mission-1", family: "MONEY_BOUNDARY", oracle: options.oracle ?? "ECONOMIC_AUTHORITY" },
    signal: options.signal ?? new AbortController().signal,
  } as unknown as BrowserMissionExecutionContext;
  const sleeps: number[] = [];
  const handler = createMoneyBoundaryAttackHandlers(runtimeApi, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    pollMs: 1,
    postingWaitMs: 500,
    uiSettleMs: 0,
    ...(options.figures ? { figures: options.figures } : {}),
  }).MONEY_BOUNDARY;
  if (!handler) throw new Error("no handler registered for MONEY_BOUNDARY");
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
  expect(h.evidence).toHaveLength(1);
  expect(h.evidence[0]).toMatchObject({ outcome: "INCONCLUSIVE" });
  expect(h.opened.every((entry) => entry.finished)).toBe(true);
  return h;
};

describe("SCRUM-350 MONEY_BOUNDARY handler: the discriminating scenario", () => {
  it("PASSES a correct product, whose net revenue (16,500) differs from the price-basis one (17,500)", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
    expect(h.world.calls).toContain("ui:goto /org1/sales");
    expect(h.opened.map((entry) => entry.seat).sort()).toEqual(["approver", "primary"]);
    expect(h.opened.every((entry) => entry.finished)).toBe(true);
    expect(h.evidence).toHaveLength(1);
    expect(h.evidence[0]).toMatchObject({
      attack: "MONEY_BOUNDARY",
      oracle: "ECONOMIC_AUTHORITY",
      currency: "JOD",
      notDiscriminated: [],
      unjudged: [],
      violations: [],
      expected: {
        priceMinor: 20_000_000,
        costMinor: 15_000_000,
        approvedMinor: 18_000_000,
        contributionMinor: 2_500_000,
        depositMinor: 200_000,
        customerGapMinor: 1_000_000,
        adminFeeMinor: 300_000,
      },
      scenario: {
        quotationMinor: 20_000_000,
        ltvPercent: 85,
        firstPaymentMinor: 200_000,
        netShortfallMinor: 1_700_000,
        customerShareMinor: 1_000_000,
        dealerShareMinor: 700_000,
        forwardDueMinor: 2_700_000,
        expectedNetRevenueMinor: 16_500_000,
        priceBasisNetRevenueMinor: 17_500_000,
      },
      ledger: { complete: true },
    });
    // What the scenario did not exercise is stated, so no result is read as more than it proved.
    expect(h.evidence[0]?.notExercised).toEqual([
      "CASH_SALE",
      "TAX_AND_DEALER_FEE_INCOME",
      "CONSIGNED_VEHICLE",
      "CUSTOMER_GAP_COLLECTION",
      "REVERSAL",
      "VEHICLE_ACQUISITION_POSTING",
      "ADMIN_FEE_POSTING",
      "DEPOSIT_RECEIPT_AND_FORWARD_PAYMENT_POSTINGS",
      "FINANCE_COMPANY_RECEIVABLE_SUBLEDGER",
      "CUSTOMER_RECEIVABLE_SUBLEDGER",
    ]);
    expect(result.oracle.summary).toMatch(/Not read: the vehicle acquisition, admin fee, deposit-receipt and forward-payment postings/);
  });

  it("drives the public product commands for an owned car: a STOCK vehicle at its purchase price, a dealer-paid fee, no settlement route", async () => {
    const h = harness();
    await h.run();
    const create = h.world.argsOf.find((entry) => entry.name === "vehicles:create");
    expect(create?.args).toMatchObject({ sourceType: "STOCK", purchasePrice: 15_000, sellingPrice: 20_000 });
    expect(create?.args).not.toHaveProperty("sourceCost");
    // A positive purchase price posts an acquisition, which the product refuses without a declared method. The dealership paid its
    // own supplier outright (bank transfer): not ON_ACCOUNT, which would add a supplier payable this scenario does not judge.
    expect(create?.args).toMatchObject({ purchasePaymentMethod: "BANK_TRANSFER" });
    expect(create?.args).not.toHaveProperty("purchaseSupplierName");
    expect(h.world.calls.filter((call) => /setSupplierSettlementRoute/.test(call))).toEqual([]);
    const fee = h.world.argsOf.find((entry) => entry.name === "financeDealCosts:recordDealFee");
    expect(fee?.args).toMatchObject({ deductedFromSettlement: false, actualAmountMinor: 300_000, paidBy: "DEALER", expectedCurrency: "JOD" });
    expect(h.world.calls.filter((call) => /invoice/i.test(call))).toEqual([]);
  });

  it("orders the deal: deposit, gap, handover, the fee, the forward, and only then finalize", async () => {
    const h = harness();
    await h.run();
    const order = [
      "owner:deposits:create",
      "manager:financingEconomics:resolveAppraisalGap",
      "owner:applications:registerVehicleHandover",
      "owner:financeDealCosts:recordDealFee",
      "owner:financeDealCosts:reconcileDealFee",
      "owner:financeDealCosts:recordDirectFeePayment",
      "manager:financeCompanyForward:recordFinanceCompanyForward",
      "owner:applications:finalizeDeal",
    ].map((call) => h.world.calls.indexOf(call));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("FAILS revenue measured on the sale price, a balanced entry only per-account judgement catches", async () => {
    const result = await harness({ priceBasis: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/SALES_REVENUE credits 20000000 minor units, expected 19000000/);
    expect(result.oracle.summary).toMatch(/revenue was measured on the sale price 20000000 instead of the approved amount plus the customer's gap 19000000/);
    expect(result.oracle.summary).toMatch(/ACCOUNTS_RECEIVABLE_CUSTOMERS debits 2000000 minor units, expected 1000000/);
  });

  it("FAILS a financier receivable netted of the dealership's own admin fee", async () => {
    const result = await harness({ feeNetted: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/the receivable from the financing company is net of the dealership's own admin fee 300000/);
  });

  it("FAILS agent basis on an owned car, whose bottom line equals the correct posting", async () => {
    const result = await harness({ agentBasis: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/a commission was posted \(debit 0, credit 4000000\) on a car the dealership owns/);
    expect(result.oracle.summary).toMatch(/SALES_REVENUE credits 0 minor units, expected 19000000/);
    expect(result.oracle.summary).toMatch(/COST_OF_VEHICLES_SOLD debits 0 minor units, expected 15000000/);
  });

  it("FAILS a deposit booked to cash, and an inventory relief one minor unit short", async () => {
    const cash = await harness({ depositToCash: true }).run();
    expect(cash.oracle.passed).toBe(false);
    expect(cash.oracle.summary).toMatch(/CUSTOMER_DEPOSITS_LIABILITY debits 0 minor units, expected 200000/);
    const short = await harness({ inventoryShort: true }).run();
    expect(short.oracle.passed).toBe(false);
    expect(short.oracle.summary).toMatch(/VEHICLE_INVENTORY credits 14999999 minor units, expected 15000000/);
  });

  it("is INCONCLUSIVE (UNAVAILABLE), never a pass, when the figures cannot tell the price basis from the right one", async () => {
    const h = harness({}, EQUAL_BASIS_RUN);
    const outcome = await settle(h);
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((outcome as Error).message).toMatch(/UNAVAILABLE \(APPROVED_VS_PRICE_BASIS, CONTRIBUTION_CONTRA_REVENUE\)/);
    // The whole scenario still ran and was read, so the operator can see what was not certified.
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
    expect(h.evidence[0]).toMatchObject({
      outcome: "INCONCLUSIVE",
      notDiscriminated: ["APPROVED_VS_PRICE_BASIS", "CONTRIBUTION_CONTRA_REVENUE"],
    });
  });

  it("still reports a proven breach when the scenario cannot discriminate, with the gap stated alongside it", async () => {
    const h = harness({ agentBasis: true }, EQUAL_BASIS_RUN);
    const result = await h.run();
    expect(result.oracle.passed).toBe(false);
    expect(h.evidence[0]).toMatchObject({ phase: "PARTIAL", unjudged: [expect.stringMatching(/APPROVED_VS_PRICE_BASIS/)] });
  });

  it("is INCONCLUSIVE, and seeds nothing, when the figures cannot form a shortfall for the customer's gap", async () => {
    const h = harness({}, { figures: { approvedMajor: 20_000 } });
    const outcome = await settle(h);
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((outcome as Error).message).toMatch(/net shortfall.*nothing was seeded/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is INCONCLUSIVE when the admin fee is zero: a netting defect would be invisible", async () => {
    const h = harness({}, { plan: { ...ACC1, adminFee: 0 }, figures: { adminFeeMajor: 0 } });
    const outcome = await settle(h);
    expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
    expect((outcome as Error).message).toMatch(/UNAVAILABLE \(SETTLEMENT_FEE_NETTING\)/);
  });
});

describe("SCRUM-350 MONEY_BOUNDARY handler: product answers that disagree with the scenario", () => {
  it("is INCONCLUSIVE when the product refuses the gap agreement for the independently derived shortfall", async () => {
    const h = await inconclusive({ gapRefused: true }, /refused the gap agreement for the independently derived net shortfall of 1700000 \(customer 1000000, dealership 700000\)/);
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });

  it("is INCONCLUSIVE when the product refuses the forward of the independently derived H + D", async () => {
    const h = await inconclusive({ forwardRefused: true }, /refused the forward to the financier of the independently derived 2700000 \(deposit 200000 plus contribution 2500000\)/);
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });

  it("is INCONCLUSIVE when the product refuses the dealership-paid admin fee or its reconciliation", async () => {
    await inconclusive({ feeRefused: true }, /refused the dealership-paid admin fee of 300000: A paid date is required/);
    const h = await inconclusive({ feeReconcileRefused: true }, /refused to reconcile the dealership-paid admin fee of 300000/);
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });

  it("records the dealership's direct admin-fee payment before the forward, so the judged scenario reaches its money oracle", async () => {
    const h = harness();
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    const pay = h.world.argsOf.find((entry) => entry.name === "financeDealCosts:recordDirectFeePayment");
    expect(pay?.args).toMatchObject({ method: "BANK_TRANSFER", expectedAmountMinor: 300_000 });
    // The money oracle ran: the judged sale reached a verdict with its ledger read in full, not merely no throw.
    expect(h.world.calls).toContain("owner:applications:finalizeDeal");
    expect(h.evidence[0]).toMatchObject({ ledger: { complete: true }, violations: [] });
  });

  it("is INCONCLUSIVE, and never forwards, when the product refuses the direct payment of the admin fee", async () => {
    const h = await inconclusive({ feePaymentRefused: true }, /refused the direct payment of the dealership-paid admin fee of 300000: This cost cannot be paid directly/);
    expect(h.world.calls).not.toContain("manager:financeCompanyForward:recordFinanceCompanyForward");
    expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
  });

  it("is INCONCLUSIVE when the product serves no economics stamp for the gap agreement", async () => {
    await inconclusive({ noGapStamp: true }, /no economics stamp for the gap agreement/);
  });

  it("is unjudged when the stored vehicle is a consigned car or has another purchase price", async () => {
    await inconclusive({ vehicleStoredAsSourced: true }, /not the dealership-owned car at the purchase price/);
    await inconclusive({ vehicleWrongCost: true }, /not the dealership-owned car at the purchase price/);
  });

  it("is unjudged when the finalized sale is another vehicle, customer and application", async () => {
    await inconclusive({ unrelatedSale: true }, /not the vehicle, customer, application and price this scenario seeded/);
  });

  it("is unjudged when the finalized sale belongs to another organization", async () => {
    await inconclusive({ saleOtherOrg: true }, /not the vehicle, customer, application and price this scenario seeded/);
  });

  it("is unjudged, and never finalizes, when the stored fee is not exactly one reconciled dealership-paid admin fee", async () => {
    for (const feeReadback of ["wrongAmount", "twoLines", "deducted", "notReconciled", "otherApplication", "empty", "unpaid"] as const) {
      const h = await inconclusive({ feeReadback }, /stored admin fee is not exactly one reconciled, dealership-paid 300000 JOD line/);
      expect(h.world.calls).not.toContain("manager:financeCompanyForward:recordFinanceCompanyForward");
      expect(h.world.calls).not.toContain("owner:applications:finalizeDeal");
    }
  });

  it("is unjudged, and seeds nothing, when the organization's currency is unreadable or has no known scale", async () => {
    for (const faults of [{ noSettings: true }, { unknownCurrency: true }]) {
      const h = harness(faults);
      const outcome = await settle(h);
      expect(outcome).toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
      expect((outcome as Error).message).toMatch(/nothing was seeded/);
      expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
    }
  });

  it("is unjudged when the approver signs in to another organization", async () => {
    const h = await inconclusive({ seatsSplit: true }, /approver seat signed in to a different organization/);
    expect(h.world.calls.filter((call) => /create|finalize/.test(call))).toEqual([]);
  });

  it("is unjudged when the sales screen cannot be opened for the screenshot", async () => {
    await inconclusive({ screenFails: true }, /sales screen could not be opened/);
  });
});

describe("SCRUM-350 MONEY_BOUNDARY handler: never a vacuous pass", () => {
  it("is INCONCLUSIVE when the sale never reaches a posted journal", async () => {
    await inconclusive({ neverPosts: true }, /did not settle with a posted SALE_COMPLETED entry/);
  });

  it("is INCONCLUSIVE, not a pass, when the posted journal has no lines", async () => {
    const h = await inconclusive({ emptyJournal: true }, /no journal line to judge/);
    expect(h.evidence[0]).toMatchObject({ ledger: { complete: true } });
  });

  it("is INCONCLUSIVE when the journal posts to an account the chart cannot name", async () => {
    await inconclusive({ unmappedAccount: true }, /not in the chart/);
  });

  it("FAILS two SALE_COMPLETED events for one sale", async () => {
    const result = await harness({ duplicateEvent: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/2 posted SALE_COMPLETED events, expected exactly one economic occurrence/);
  });

  it("FAILS an event of the sale that FAILED to post", async () => {
    const result = await harness({ failedEvent: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/DEPOSIT_RECEIVED\) FAILED to post/);
  });
});

describe("SCRUM-350 MONEY_BOUNDARY handler: mission contract", () => {
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
    // STATE_TRANSITION is judged by the LIFE-1 fee-void scenario (browserSwarmFeeVoidHandler.test.ts), not by this one.
    const h = harness({}, { oracle: "UI_BACKEND_AUTHORITY" });
    await expect(h.run()).rejects.toThrow(/does not judge the UI_BACKEND_AUTHORITY oracle/);
    expect(h.world.calls).toEqual([]);
  });

  it("waits out the product's write rate limit and still reaches the sale", async () => {
    const h = harness({ rateLimitVehicleTimes: 2 });
    const result = await h.run();
    expect(result.oracle.passed).toBe(true);
    expect(h.sleeps.filter((ms) => ms === 2_000)).toHaveLength(2);
  });

  it("reports a browser cleanup failure beside a proven breach, never hiding either", async () => {
    const result = await harness({ agentBasis: true }, { finishFails: true }).run();
    expect(result.oracle.passed).toBe(false);
    expect(result.oracle.summary).toMatch(/browser evidence cleanup also failed/);
  });

  it("refuses to certify a pass whose browser evidence could not be captured", async () => {
    await expect(harness({}, { finishFails: true }).run()).rejects.toThrow(/browser evidence cleanup failed/);
  });

  it("stops touching the backend once the mission is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("mission timed out"));
    const h = harness({}, { signal: controller.signal });
    await expect(h.run()).rejects.toThrow(/mission timed out/);
    expect(h.world.calls).toEqual([]);
  });
});
