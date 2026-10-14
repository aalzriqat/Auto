/**
 * SCRUM-350 CONS-1 — executable CONSIGNMENT_ECONOMICS browser attack.
 *
 * Drives a financed sale of a SOURCED (consigned) car end to end through the
 * product's own public commands, on the isolated, marker-gated disposable
 * preview, with run-unique synthetic data: customer, finance company, a
 * 20,000 car the supplier is owed 15,000 for, a deal approved at 20,000 and
 * routed THROUGH_DEALERSHIP, finalized by the OWNER seat after the MANAGER seat
 * approves. It then reads the sale's posted journal back through the same
 * permission-checked queries an accountant uses and judges it against figures
 * computed here (browserSwarmConsignmentOracle.ts), never from the product:
 * the dealership recognizes only the 5,000 spread, the supplier is owed his
 * 15,000, and the car's price, cost and inventory never reach revenue, COGS or
 * inventory.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the
 * fail-closed rule) is the shared runBoundaryMission: a posting that never
 * settles, a deal that cannot be finalized, or a setup the product refuses is
 * INCONCLUSIVE or a harness error — never a pass.
 *
 * ⚠️ This mission cannot PASS yet. The scenario approves the whole price, so a
 * margin measured on the price cannot be told from one measured on the
 * financier's approval; while that holds it ends INCONCLUSIVE with
 * `APPROVED_VS_PRICE_BASIS` in the evidence (a proven breach is still a breach).
 * It becomes certifiable only when an approved < price case with a resolved
 * customer gap is seeded and judged (oracle: `customerGapMinor`).
 *
 * Not covered, and recorded as such in the evidence: a nonzero dealership
 * contribution (its contra-revenue treatment is judged by the oracle, but this
 * scenario seeds none), a customer reservation deposit and its forward to the
 * financier, the DIRECT_TO_SUPPLIER route, and cancellation or reversal of the
 * sale. The records the run creates stay in the disposable preview; a finalized
 * deal is posted financial history and is never deleted.
 */
import { createHash } from "node:crypto";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { describeError } from "./browserSwarmBoundaryOracle";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  discriminatesApprovedFromPrice,
  evaluateConsignmentEconomics,
  toMinor,
  type ConsignmentExpectation,
  type ConsignmentLine,
} from "./browserSwarmConsignmentOracle";
import { untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";

export interface ConsignmentAttackOptions {
  /** Replaces real waiting so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval while waiting on the ledger. */
  pollMs?: number;
  /** How long the finalized sale may take to reach the ledger. */
  postingWaitMs?: number;
  /** How long the sales screen may take to load for the screenshot. */
  uiSettleMs?: number;
}

const DEFAULTS = { pollMs: 500, postingWaitMs: 30_000, uiSettleMs: 15_000 } as const;
const RATE_LIMIT_TEXT = /rate limit exceeded[^\d]{0,40}(\d{1,6})s/i;
const RATE_LIMIT_RETRIES = 3;
const LEDGER_ROW_LIMIT = 200;
const LEDGER_MAX_READS = 40;

/** The scenario, in major units. Nothing is read back from the product to derive an expectation. */
const PRICE_MAJOR = 20_000;
const ENTITLEMENT_MAJOR = 15_000;
const APPROVED_MAJOR = 20_000;

function inconclusive(message: string): never {
  throw new BrowserSwarmOracleInconclusiveError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) inconclusive(`${label} returned a non-array response`);
  return value;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 17 uppercase characters, unique to the run, free of the letters a VIN forbids. */
function syntheticVin(nonce: string): string {
  return "CNSG1" + createHash("sha256").update(nonce).digest("hex").slice(0, 12).toUpperCase();
}

const EVENT_STATUSES = ["PENDING", "POSTED", "FAILED", "REVERSED"] as const;

interface SaleLedger {
  events: { id: string; eventType: string; status: string; journalEntryId: string | null }[];
  journals: { id: string; eventId: string; status: string }[];
  lines: ConsignmentLine[];
  /** Account ids a journal line posted to that the chart cannot name. */
  unmappedAccountIds: string[];
  /** Product failures the read itself proves: a FAILED or REVERSED event, a POSTED one with no journal, a journal that is not POSTED. */
  defects: string[];
}

function isSaleCompleted(event: SaleLedger["events"][number], status: string): boolean {
  return event.eventType === "SALE_COMPLETED" && event.status === status;
}

/** Leaves what has been read so far in the evidence (`complete` once the whole read finished), so a thrown read still does. */
function recordLedger(env: BoundaryMissionEnv, ledger: SaleLedger, complete: boolean, reads: number): void {
  env.detail.ledger = {
    complete,
    reads,
    events: [...ledger.events],
    journals: [...ledger.journals],
    lines: [...ledger.lines],
    unmappedAccountIds: [...ledger.unmappedAccountIds],
    defects: [...ledger.defects],
  };
}

async function readSaleLedger(
  env: BoundaryMissionEnv,
  saleId: string,
  keyOf: ReadonlyMap<string, string>,
  reads: number,
): Promise<SaleLedger> {
  const org = env.orgId as Id<"organizations">;
  const ledger: SaleLedger = { events: [], journals: [], lines: [], unmappedAccountIds: [], defects: [] };
  const record = (complete: boolean): void => recordLedger(env, ledger, complete, reads);
  /** Inconclusive, with what was read before the problem kept as evidence. */
  const fail: (message: string) => never = (message) => {
    record(false);
    return inconclusive(message);
  };
  const raw = asArray(
    await env.client.query(api.accountingLedger.listAccountingEvents, {
      orgId: org,
      sourceType: "sales",
      sourceId: saleId,
      limit: LEDGER_ROW_LIMIT,
    }),
    "listAccountingEvents",
  );
  if (raw.length >= LEDGER_ROW_LIMIT) fail(`accounting events for sale ${saleId} may be truncated`);
  for (const row of raw) {
    if (
      !isRecord(row) ||
      typeof row._id !== "string" ||
      typeof row.eventType !== "string" ||
      typeof row.status !== "string" ||
      !(EVENT_STATUSES as readonly string[]).includes(row.status)
    ) {
      fail("listAccountingEvents returned a malformed row");
    }
    if (row.sourceType !== "sales" || row.sourceId !== saleId) {
      fail(`accounting event ${row._id} belongs to ${String(row.sourceType)}/${String(row.sourceId)}, not sales/${saleId}`);
    }
    ledger.events.push({
      id: row._id,
      eventType: row.eventType,
      status: row.status,
      journalEntryId: typeof row.journalEntryId === "string" ? row.journalEntryId : null,
    });
  }
  record(false);

  for (const event of ledger.events) {
    const label = `event ${event.id} (${event.eventType})`;
    if (event.status === "FAILED") ledger.defects.push(`${label} FAILED to post`);
    if (event.status === "REVERSED") ledger.defects.push(`${label} was REVERSED on a sale that was only just finalized`);
    if (event.status !== "POSTED") continue;
    if (event.journalEntryId === null) {
      ledger.defects.push(`${label} is POSTED but names no journal entry`);
      continue;
    }
    const entry: unknown = await env.client.query(api.accountingLedger.getJournalEntry, {
      orgId: org,
      journalEntryId: event.journalEntryId as Id<"journalEntries">,
    });
    if (!isRecord(entry) || !isRecord(entry.entry)) fail(`journal ${event.journalEntryId} could not be read back`);
    const header = entry.entry;
    if (header._id !== event.journalEntryId || typeof header.status !== "string") {
      fail(`journal ${event.journalEntryId} came back with another identity or no status`);
    }
    ledger.journals.push({ id: event.journalEntryId, eventId: event.id, status: header.status });
    if (header.status !== "POSTED") {
      ledger.defects.push(`journal ${event.journalEntryId} (${label}) has status ${header.status}, not POSTED`);
    }
    for (const line of asArray(entry.lines, "journal lines")) {
      if (
        !isRecord(line) ||
        typeof line.accountId !== "string" ||
        typeof line.debitMinor !== "number" ||
        typeof line.creditMinor !== "number" ||
        typeof line.scale !== "number" ||
        typeof line.currency !== "string" ||
        !Number.isFinite(line.debitMinor) ||
        !Number.isFinite(line.creditMinor) ||
        !Number.isFinite(line.scale)
      ) {
        fail(`journal ${event.journalEntryId} has a malformed line`);
      }
      // An account the chart cannot name could be COGS, inventory or revenue in disguise: never judge around it.
      const key = keyOf.get(line.accountId);
      if (key === undefined) {
        if (!ledger.unmappedAccountIds.includes(line.accountId)) ledger.unmappedAccountIds.push(line.accountId);
        continue;
      }
      ledger.lines.push({
        key,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        currency: line.currency,
        scale: line.scale,
        entryId: event.journalEntryId,
        accountId: line.accountId,
      });
    }
  }
  record(true);
  if (ledger.unmappedAccountIds.length > 0) {
    inconclusive(
      `the sale's journals post to ${ledger.unmappedAccountIds.length} account(s) that are not in the chart (${ledger.unmappedAccountIds.join(", ")}), so the lines cannot be judged`,
    );
  }
  return ledger;
}

/**
 * Two consecutive identical reads that include the sale's own POSTED entry: the
 * outbox drains asynchronously. A sale whose SALE_COMPLETED stays FAILED for the
 * whole window (with nothing posted or pending) is returned as it stands: that
 * is the product's failure to post, to be judged, not a wait that ran out.
 */
async function readSettledSaleLedger(
  env: BoundaryMissionEnv,
  options: Required<ConsignmentAttackOptions>,
  saleId: string,
  keyOf: ReadonlyMap<string, string>,
): Promise<SaleLedger> {
  const deadline = Date.now() + options.postingWaitMs;
  let reads = 0;
  const read = async (): Promise<SaleLedger> => {
    reads += 1;
    return untilAborted(env.signal, readSaleLedger(env, saleId, keyOf, reads));
  };
  const has = (ledger: SaleLedger, status: string): boolean => ledger.events.some((event) => isSaleCompleted(event, status));
  const noPending = (ledger: SaleLedger): boolean => ledger.events.every((event) => event.status !== "PENDING");
  const isPosted = (ledger: SaleLedger): boolean => has(ledger, "POSTED") && noPending(ledger);
  const failedForGood = (ledger: SaleLedger): boolean => has(ledger, "FAILED") && !has(ledger, "POSTED") && noPending(ledger);
  let previous = await read();
  while (reads < LEDGER_MAX_READS && Date.now() < deadline) {
    await untilAborted(env.signal, options.sleep(options.pollMs));
    const current = await read();
    if (isPosted(current) && JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  if (failedForGood(previous)) return previous;
  const last = previous.events.map((event) => `${event.eventType}=${event.status}`).join(", ") || "no events";
  return inconclusive(`the ledger state for sale ${saleId} did not settle with a posted SALE_COMPLETED entry (last read: ${last})`);
}

function consignmentEconomicsSpec(options: Required<ConsignmentAttackOptions>) {
  return {
    attack: "CONSIGNMENT_ECONOMICS",
    seat: "primary" as const,
    oracles: ["ECONOMIC_AUTHORITY" as const],
    passSummary:
      "A financed sale of a consigned car recognized only the dealership's 5,000 spread as revenue, owed the supplier his 15,000 entitlement, and never posted the car's price, cost or inventory as the dealership's own, read from the sale's posted journal against independently computed figures.",
    breachSummary: "A financed consigned sale was not recognized on the agent basis",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;

      /** One product command, waiting out the product's own write rate limit. */
      const command = async <T>(run: () => Promise<T>): Promise<T> => {
        for (let retries = 0; retries < RATE_LIMIT_RETRIES; retries += 1) {
          try {
            return await untilAborted(signal, run());
          } catch (error) {
            const wait = RATE_LIMIT_TEXT.exec(describeError(error));
            if (!wait) throw error;
            await untilAborted(signal, options.sleep((Number(wait[1]) + 1) * 1000));
          }
        }
        // The retries are spent: this last attempt's failure, a rate limit included, propagates.
        return untilAborted(signal, run());
      };

      // The denomination is the organization's own, read before anything is seeded.
      const settings: unknown = await untilAborted(signal, client.query(api.orgSettings.get, { orgId: org }));
      const currency = isRecord(settings) && typeof settings.currency === "string" ? settings.currency : null;
      detail.currency = currency;
      const priceMinor = currency === null ? null : toMinor(PRICE_MAJOR, currency);
      const entitlementMinor = currency === null ? null : toMinor(ENTITLEMENT_MAJOR, currency);
      const approvedMinor = currency === null ? null : toMinor(APPROVED_MAJOR, currency);
      if (currency === null || priceMinor === null || entitlementMinor === null || approvedMinor === null) {
        env.unjudged(
          "the organization's currency is unreadable or has no known minor-unit scale, so no amount of the scenario can be expressed or judged; nothing was seeded",
        );
        return;
      }

      // Computed from the scenario's own figures before anything is seeded, so every non-pass states what was expected.
      const expectation: ConsignmentExpectation = {
        currency,
        priceMinor,
        approvedMinor,
        entitlementMinor,
        contributionMinor: 0,
        route: "THROUGH_DEALERSHIP",
      };
      detail.expected = expectation;
      detail.notExercised = ["DEALERSHIP_CONTRIBUTION", "CUSTOMER_DEPOSIT_FORWARD", "DIRECT_TO_SUPPLIER", "REVERSAL"];
      // Approved equals price here, so a margin measured on the price would pass too. A pass would certify
      // a property this scenario cannot tell apart, so the mission is UNAVAILABLE (never a pass) until an
      // approved < price case with a resolved customer gap is seeded. Breaches it can still prove are reported.
      const discriminates = discriminatesApprovedFromPrice(expectation);
      detail.notDiscriminated = discriminates ? [] : ["APPROVED_VS_PRICE_BASIS"];
      if (!discriminates) {
        env.unjudged(
          `UNAVAILABLE (APPROVED_VS_PRICE_BASIS): the scenario seeds approved = price (${approvedMinor} minor units), so a margin measured on the price is indistinguishable from one measured on the financier's approval; CONSIGNMENT_ECONOMICS cannot be certified until an approved < price case with a resolved customer gap is seeded`,
        );
      }

      // The MANAGER seat approves what the OWNER seat submits. A split dealership means no deal can be approved.
      const approver = await env.openSeat("approver");
      if (approver.orgId !== orgId) {
        env.unjudged("the approver seat signed in to a different organization, so the deal could not be approved; nothing was seeded");
        return;
      }

      const customerId = await command(() =>
        client.mutation(api.customers.create, { orgId: org, firstName: "Swarm", lastName: `Consigned-${nonce}` }),
      );
      await command(() => client.mutation(api.orgCustomerStatuses.seed, { orgId: org }));
      const statuses = asArray(await command(() => client.query(api.orgCustomerStatuses.list, { orgId: org })), "orgCustomerStatuses.list");
      const status = statuses.find((row) => isRecord(row) && row.isActive === true);
      if (!isRecord(status) || typeof status._id !== "string") {
        inconclusive("no active customer eligibility status exists after seeding");
      }
      const statusId = status._id as Id<"orgCustomerStatuses">;
      const companyId = await command(() =>
        client.mutation(api.finance.createCompany, {
          orgId: org,
          name: `Swarm Finance ${nonce}`,
          profitRate: 5,
          maxTermMonths: 60,
          gracePeriodMonths: 0,
          defaultLtvPercent: 100,
          adminFees: 0,
          acceptedStatuses: [statusId],
          isActive: true,
        }),
      );
      const supplierName = `Swarm Supplier ${nonce}`;
      const vehicleId = await command(() =>
        client.mutation(api.vehicles.create, {
          orgId: org,
          vin: syntheticVin(nonce),
          make: "Toyota",
          model: "Camry-cons1",
          year: 2022,
          mileage: 800,
          color: "Blue",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: PRICE_MAJOR,
          sourceType: "SOURCED",
          sourcedFromName: supplierName,
          // The supplier's ENTITLEMENT, not a purchase price: the car was never the dealership's.
          sourceCost: ENTITLEMENT_MAJOR,
          status: "AVAILABLE",
          idempotencyKey: `${nonce}-vehicle`,
        }),
      );
      detail.vehicleId = String(vehicleId);

      // The product must have recorded the car as consigned at the supplier's price; otherwise the scenario is not the one judged.
      const stored: unknown = await command(() => client.query(api.vehicles.get, { orgId: org, vehicleId }));
      if (!isRecord(stored) || stored.sourceType !== "SOURCED" || stored.sourceCost !== ENTITLEMENT_MAJOR) {
        env.unjudged("the stored vehicle is not the SOURCED car at the supplier's entitlement the scenario created, so it is not the case judged");
        return;
      }

      const quoteId = await command(() =>
        client.mutation(api.quotes.saveQuote, {
          orgId: org,
          customerId,
          vehicleId,
          vehiclePrice: PRICE_MAJOR,
          downPayment: 0,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          customerEligibilityStatusIds: [statusId],
          totalFinancedAmount: PRICE_MAJOR,
        }),
      );
      const applicationId = await command(() => client.mutation(api.applications.createFromQuote, { orgId: org, quoteId }));
      detail.applicationId = String(applicationId);
      await command(() => client.mutation(api.applications.updateStatus, { orgId: org, applicationId, status: "UNDER_REVIEW" }));
      await command(() => approver.client.mutation(api.applications.updateStatus, { orgId: org, applicationId, status: "APPROVED" }));
      await command(() =>
        client.mutation(api.applications.setSupplierSettlementRoute, { orgId: org, applicationId, route: "THROUGH_DEALERSHIP" }),
      );
      await command(() =>
        client.mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: org,
          applicationId,
          submittedQuotationMinor: approvedMinor,
          source: "MANUAL_ENTRY",
        }),
      );
      await command(() =>
        approver.client.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
          orgId: org,
          applicationId,
          approvedAmountMinor: approvedMinor,
          basis: "MANUAL",
          notes: "Swarm approval of the full vehicle price.",
        }),
      );
      const economicsStamp = await command(() => client.query(api.applications.handoverStamp, { orgId: org, applicationId }));
      if (!economicsStamp) inconclusive("the product issued no economics stamp for the handover, so the deal cannot proceed");
      await command(() => client.mutation(api.applications.registerVehicleHandover, { orgId: org, applicationId, economicsStamp }));
      await command(() =>
        client.mutation(api.applications.registerExpectedPayment, {
          orgId: org,
          applicationId,
          method: "BANK_TRANSFER",
          expectedDate: Date.now(),
        }),
      );
      await command(() =>
        client.mutation(api.financeDealCosts.recordLegalInvoice, {
          orgId: org,
          applicationId,
          legalInvoiceAmountMinor: approvedMinor,
          legalInvoiceNumber: `SWARM-${nonce}`.slice(0, 60),
          legalInvoiceDate: Date.now(),
          issuedTo: "FINANCE_COMPANY",
        }),
      );
      const feeId = await command(() =>
        client.mutation(api.financeDealCosts.recordDealFee, {
          expectedCurrency: currency,
          idempotencyKey: `${nonce}-zero-fee`,
          orgId: org,
          applicationId,
          feeType: "OTHER_CLOSING_EXPENSE",
          paidBy: "DEALER",
          paidTo: "OTHER",
          accountingTreatment: "SELLING_EXPENSE",
          deductedFromSettlement: false,
          actualAmountMinor: 0,
          description: "No closing costs.",
        }),
      );
      await command(() =>
        client.mutation(api.financeDealCosts.reconcileDealFee, {
          orgId: org,
          feeId,
          notes: "No fee to settle.",
          expectedActualAmountMinor: 0,
          expectedActualEvidenceRevision: 0,
        }),
      );
      const saleId = String(
        await command(() =>
          client.mutation(api.applications.finalizeDeal, { idempotencyKey: `${nonce}-finalize`, orgId: org, applicationId }),
        ),
      );
      detail.saleId = saleId;

      // The deal must have closed on the route that was chosen, or the sale judged is not this scenario's.
      const sale: unknown = await command(() => client.query(api.sales.get, { orgId: org, saleId: saleId as Id<"sales"> }));
      detail.settlementRoute = isRecord(sale) ? (sale.supplierSettlementRoute ?? null) : null;
      if (!isRecord(sale) || sale.supplierSettlementRoute !== "THROUGH_DEALERSHIP") {
        env.unjudged("the finalized sale does not record the THROUGH_DEALERSHIP route the scenario chose, so it is not the case judged");
        return;
      }
      // The journal read below is this mission's evidence only if the sale is the one this scenario seeded.
      const sameIdentity =
        String(sale.vehicleId) === String(vehicleId) &&
        String(sale.customerId) === String(customerId) &&
        String(sale.applicationId) === String(applicationId) &&
        String(sale._id) === saleId &&
        sale.salePrice === PRICE_MAJOR;
      if (!sameIdentity) {
        env.unjudged("the finalized sale is not the vehicle, customer, application and price this scenario seeded, so its journal is not this mission's evidence");
        return;
      }

      // The screen a dealer sees; its screenshot is part of the mission's evidence.
      try {
        await untilAborted(signal, page.goto(`/${orgId}/sales`, { waitUntil: "domcontentloaded", timeout: options.uiSettleMs }));
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(`the sales screen could not be opened for the screenshot (${describeError(error)})`);
        return;
      }

      const chart = asArray(await command(() => client.query(api.chartOfAccounts.list, { orgId: org })), "chartOfAccounts.list");
      const keyOf = new Map<string, string>();
      for (const account of chart) {
        if (!isRecord(account) || typeof account._id !== "string") continue;
        const key = typeof account.systemKey === "string" ? account.systemKey : typeof account.code === "string" ? account.code : null;
        if (key !== null) keyOf.set(account._id, key);
      }
      // Every read, including one that throws, leaves its events, journals and account ids in the evidence.
      const ledger = await readSettledSaleLedger(env, options, saleId, keyOf);
      const completed = ledger.events.filter((event) => isSaleCompleted(event, "POSTED"));

      if (ledger.defects.length > 0) env.judge({ violations: ledger.defects, unjudged: [] });
      if (completed.length !== 1) {
        env.judge({
          violations: [`the sale holds ${completed.length} posted SALE_COMPLETED events, expected exactly one economic occurrence`],
          unjudged: [],
        });
      }
      env.judge(evaluateConsignmentEconomics(expectation, ledger.lines));
    },
  };
}

export function createConsignmentAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: ConsignmentAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: Required<ConsignmentAttackOptions> = {
    sleep: overrides.sleep ?? realSleep,
    pollMs: overrides.pollMs ?? DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? DEFAULTS.postingWaitMs,
    uiSettleMs: overrides.uiSettleMs ?? DEFAULTS.uiSettleMs,
  };
  return {
    CONSIGNMENT_ECONOMICS: (context) => runBoundaryMission(runtimeApi, context, consignmentEconomicsSpec(options)),
  };
}
