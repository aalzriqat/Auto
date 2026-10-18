/**
 * SCRUM-350 CONS-1 — executable CONSIGNMENT_ECONOMICS browser attack (finance plan v3).
 *
 * Drives a financed sale of a SOURCED (consigned) car end to end through the
 * product's own public commands, on the isolated, marker-gated disposable
 * preview, with run-unique synthetic data: customer, an 85% finance company, a
 * 20,000 car the supplier is owed 15,000 for, a 200 reservation deposit (also the
 * customer's first payment), a 20,000 quotation the financier approves at only
 * 18,000, and a REAL resolved shortfall (net 1,700: the customer owes the
 * dealership 1,000, agreed as cash and never collected here; the dealership
 * absorbs 700). The deal is routed
 * THROUGH_DEALERSHIP, approved by the MANAGER seat, handed over, its H + D
 * (deposit + contribution) paid to the financier, and finalized by the OWNER
 * seat. No legal invoice is recorded: under plan v3 the server derives the
 * consideration (approved + customer gap) and an invoice is optional evidence.
 *
 * The sale's posted journal is then read back through the same permission-checked
 * queries an accountant uses and judged, account by account, against figures
 * computed in browserSwarmConsignmentOracle.ts, never from the product: revenue
 * is approved + gap − entitlement − contribution (the contribution is
 * contra-revenue), the supplier is owed his 15,000, and the car's price, cost and
 * inventory never reach revenue, COGS or inventory. The supplier's canonical
 * `vehicleSupplierPayables` row, read through the public VIEW_FINANCE-gated
 * `sourcingPayables.list`, is judged beside the journal: one unpaid row for this sale
 * and car owing the independently computed 15,000. A row that cannot be read is
 * INCONCLUSIVE, never a pass.
 *
 * Why this scenario can certify: approved + gap (19,000) differs from the sale
 * price (20,000), so a margin measured on the price would post 1,000 too much and
 * fail. Approved < price alone would not suffice (a gap that fills the difference
 * gives identical figures), so the mission checks that the two revenues differ and
 * ends INCONCLUSIVE with `APPROVED_VS_PRICE_BASIS` otherwise.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the
 * fail-closed rule) is the shared runBoundaryMission: a posting that never
 * settles, a deal that cannot be finalized, a setup the product refuses, or a
 * product that disagrees with the scenario's independently derived shortfall or
 * forward amount is INCONCLUSIVE or a harness error — never a pass.
 *
 * Not covered, and recorded as such in the evidence: the DIRECT_TO_SUPPLIER route,
 * a customer payment made to the finance company, and cancellation or reversal of
 * the sale. Only the journals whose source is the sale and the supplier payable row are
 * read: the deposit-receipt and forward-payment postings and the finance-company and
 * customer receivable subledger rows are not. The records the run creates stay in the disposable preview; a
 * finalized deal is posted financial history and is never deleted.
 */
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { describeError } from "./browserSwarmBoundaryOracle";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  buildConsignmentScenario,
  CONSIGNMENT_FIGURES,
  discriminatesApprovedFromPrice,
  evaluateConsignmentEconomics,
  evaluateSupplierPayable,
  expectedConsignedRevenueMinor,
  priceBasisRevenueMinor,
  type ConsignmentFigures,
  type ConsignmentLine,
  type SupplierPayableRow,
} from "./browserSwarmConsignmentOracle";
import { untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import {
  agreeEconomicsAndHandOver,
  asArray,
  inconclusive,
  isRecord,
  readChartKeys,
  readOrgCurrency,
  seedFinancedCustomer,
  submitApprovedApplication,
  syntheticVin,
} from "./browserSwarmSeedHelpers";

export interface ConsignmentAttackOptions {
  /** Replaces real waiting so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval while waiting on the ledger. */
  pollMs?: number;
  /** How long the finalized sale may take to reach the ledger. */
  postingWaitMs?: number;
  /** How long the sales screen may take to load for the screenshot. */
  uiSettleMs?: number;
  /** Replaces parts of the scenario's figures (major units); tests use it to build a scenario that cannot discriminate. */
  figures?: Partial<ConsignmentFigures>;
}

/** The timing a ledger-reading mission runs with; the figures are resolved separately. */
export type MissionTiming = Required<Omit<ConsignmentAttackOptions, "figures">>;

export const MISSION_TIMING_DEFAULTS = { pollMs: 500, postingWaitMs: 30_000, uiSettleMs: 15_000 } as const;
const RATE_LIMIT_TEXT = /rate limit exceeded[^\d]{0,40}(\d{1,6})s/i;
const RATE_LIMIT_RETRIES = 3;
const LEDGER_ROW_LIMIT = 200;
const LEDGER_MAX_READS = 40;
/** The forward's paid date sits this far in the past so a skewed clock cannot make it "in the future". */
export const PAID_AT_SKEW_MS = 5_000;

export { asArray, inconclusive, isRecord };

export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The two ways a mission issues product commands: waiting out the product's own write rate
 * limit (a bounded number of retries, then the failure propagates), and a command whose
 * refusal disagrees with the scenario's independent figures, which is inconclusive and never
 * a pass.
 */
export function missionCommands(
  env: Pick<BoundaryMissionEnv, "signal">,
  options: Pick<MissionTiming, "sleep">,
): {
  command: <T>(run: () => Promise<T>) => Promise<T>;
  refusalIsInconclusive: <T>(run: () => Promise<T>, refused: string) => Promise<T>;
} {
  const { signal } = env;
  const command = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let retries = 0; ; retries += 1) {
      try {
        return await untilAborted(signal, run());
      } catch (error) {
        const wait = RATE_LIMIT_TEXT.exec(describeError(error));
        // Once the retries are spent, this attempt's failure, a rate limit included, propagates.
        if (!wait || retries >= RATE_LIMIT_RETRIES) throw error;
        await untilAborted(signal, options.sleep((Number(wait[1]) + 1) * 1000));
      }
    }
  };
  const refusalIsInconclusive = async <T>(run: () => Promise<T>, refused: string): Promise<T> => {
    try {
      return await command(run);
    } catch (error) {
      if (signal.aborted) throw error;
      inconclusive(`${refused}: ${describeError(error)}`);
    }
  };
  return { command, refusalIsInconclusive };
}

const EVENT_STATUSES = ["PENDING", "POSTED", "FAILED", "REVERSED"] as const;

export interface SaleLedger {
  events: { id: string; eventType: string; status: string; journalEntryId: string | null }[];
  journals: { id: string; eventId: string; status: string }[];
  lines: ConsignmentLine[];
  /** Account ids a journal line posted to that the chart cannot name. */
  unmappedAccountIds: string[];
  /** Product failures the read itself proves: a FAILED or REVERSED event, a POSTED one with no journal, a journal that is not POSTED. */
  defects: string[];
}

export function isSaleCompleted(event: SaleLedger["events"][number], status: string): boolean {
  return event.eventType === "SALE_COMPLETED" && event.status === status;
}

async function readSaleLedger(
  env: BoundaryMissionEnv,
  saleId: string,
  keyOf: ReadonlyMap<string, string>,
  reads: number,
): Promise<SaleLedger> {
  const org = env.orgId as Id<"organizations">;
  const ledger: SaleLedger = { events: [], journals: [], lines: [], unmappedAccountIds: [], defects: [] };
  // The evidence holds this read's live arrays, so whatever was read before a throw (of any kind) stays in it;
  // `complete` turns true only once the whole read finished.
  const evidence = { complete: false, reads, ...ledger };
  env.detail.ledger = evidence;
  const raw = asArray(
    await env.client.query(api.accountingLedger.listAccountingEvents, {
      orgId: org,
      sourceType: "sales",
      sourceId: saleId,
      limit: LEDGER_ROW_LIMIT,
    }),
    "listAccountingEvents",
  );
  if (raw.length >= LEDGER_ROW_LIMIT) inconclusive(`accounting events for sale ${saleId} may be truncated`);
  for (const row of raw) {
    if (
      !isRecord(row) ||
      typeof row._id !== "string" ||
      typeof row.eventType !== "string" ||
      typeof row.status !== "string" ||
      !(EVENT_STATUSES as readonly string[]).includes(row.status)
    ) {
      inconclusive("listAccountingEvents returned a malformed row");
    }
    if (row.sourceType !== "sales" || row.sourceId !== saleId) {
      inconclusive(`accounting event ${row._id} belongs to ${String(row.sourceType)}/${String(row.sourceId)}, not sales/${saleId}`);
    }
    ledger.events.push({
      id: row._id,
      eventType: row.eventType,
      status: row.status,
      journalEntryId: typeof row.journalEntryId === "string" ? row.journalEntryId : null,
    });
  }

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
    if (!isRecord(entry) || !isRecord(entry.entry)) inconclusive(`journal ${event.journalEntryId} could not be read back`);
    const header = entry.entry;
    if (header._id !== event.journalEntryId || typeof header.status !== "string") {
      inconclusive(`journal ${event.journalEntryId} came back with another identity or no status`);
    }
    // The lines below are this event's evidence only if the journal says it was posted for this event.
    if (header.accountingEventId !== event.id) {
      inconclusive(`journal ${event.journalEntryId} belongs to accounting event ${String(header.accountingEventId)}, not ${event.id}`);
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
        inconclusive(`journal ${event.journalEntryId} has a malformed line`);
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
  evidence.complete = true;
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
export async function readSettledSaleLedger(
  env: BoundaryMissionEnv,
  options: MissionTiming,
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

/**
 * Every supplier payable the organization lists (`sourcingPayables.list`: public, VIEW_FINANCE-gated,
 * all of the organization's rows). A row this read cannot interpret is inconclusive, never skipped.
 */
function parseSupplierPayables(raw: unknown): SupplierPayableRow[] {
  return asArray(raw, "sourcingPayables.list").map((row) => {
    if (
      !isRecord(row) ||
      typeof row._id !== "string" ||
      typeof row.vehicleId !== "string" ||
      (row.saleId !== undefined && typeof row.saleId !== "string") ||
      typeof row.currency !== "string" ||
      typeof row.amountDue !== "number" ||
      !Number.isFinite(row.amountDue) ||
      (row.amountPaid !== undefined && (typeof row.amountPaid !== "number" || !Number.isFinite(row.amountPaid))) ||
      typeof row.status !== "string"
    ) {
      return inconclusive("sourcingPayables.list returned a malformed supplier payable row");
    }
    return {
      id: row._id,
      saleId: row.saleId ?? null,
      vehicleId: row.vehicleId,
      currency: row.currency,
      amountDueMajor: row.amountDue,
      amountPaidMajor: row.amountPaid ?? 0,
      status: row.status,
    };
  });
}

function consignmentEconomicsSpec(options: MissionTiming, figures: Readonly<ConsignmentFigures>) {
  return {
    attack: "CONSIGNMENT_ECONOMICS",
    seat: "primary" as const,
    oracles: ["ECONOMIC_AUTHORITY" as const],
    passSummary:
      "A financed sale of a consigned car, approved below its price with a resolved customer gap and a forwarded deposit, posted a sale journal (the entries whose source is the sale) that recognized revenue on the approved amount plus the customer's gap (less the supplier's entitlement and the dealership's contribution), recorded the supplier's entitlement, the financier's receivable and the amount owed onward to the financier (forwarded deposit and contribution) in the sale journal, and never posted the car's price, cost or inventory as the dealership's own; the supplier's canonical payable row agreed with the entitlement. Judged against independently computed figures. Not read: the deposit-receipt and forward-payment postings, and the finance-company and customer receivable subledger rows.",
    breachSummary: "A financed consigned sale was not recognized on the agent basis",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const { command, refusalIsInconclusive } = missionCommands(env, options);

      // The denomination is the organization's own, read before anything is seeded.
      const currency = await readOrgCurrency(env);
      if (currency === null) return;
      const built = buildConsignmentScenario(currency, figures);
      if (!built.ok) {
        env.unjudged(`${built.reason}; nothing was seeded`);
        return;
      }
      const { scenario } = built;
      const { expectation } = scenario;

      // Computed from the scenario's own figures before anything is seeded, so every non-pass states what was expected.
      detail.expected = expectation;
      detail.scenario = {
        quotationMinor: scenario.quotationMinor,
        ltvPercent: scenario.ltvPercent,
        firstPaymentMinor: scenario.firstPaymentMinor,
        depositMinor: scenario.depositMinor,
        netShortfallMinor: scenario.shortfallMinor,
        customerShareMinor: scenario.customerShareMinor,
        dealerShareMinor: scenario.dealerShareMinor,
        forwardDueMinor: scenario.forwardDueMinor,
        expectedRevenueMinor: expectedConsignedRevenueMinor(expectation),
        priceBasisRevenueMinor: priceBasisRevenueMinor(expectation),
      };
      // No legal invoice is recorded: the server derives the consideration (approved + customer gap), and an invoice is optional evidence.
      detail.invoiceSeeded = false;
      detail.notExercised = [
        "DIRECT_TO_SUPPLIER",
        "CUSTOMER_PAYMENT_TO_FINANCE_COMPANY",
        "CUSTOMER_GAP_COLLECTION",
        "REVERSAL",
        // Read nowhere: only the journals whose source is this sale, and the supplier payable row, are judged.
        "DEPOSIT_RECEIPT_AND_FORWARD_PAYMENT_POSTINGS",
        "FINANCE_COMPANY_RECEIVABLE_SUBLEDGER",
        "CUSTOMER_RECEIVABLE_SUBLEDGER",
      ];
      // When approved + the customer's gap equals the price, a margin measured on the price gives the same
      // figures. A pass would then certify a property the scenario cannot tell apart, so the mission is
      // UNAVAILABLE (never a pass). Breaches it can still prove are reported.
      const discriminates = discriminatesApprovedFromPrice(expectation);
      detail.notDiscriminated = discriminates ? [] : ["APPROVED_VS_PRICE_BASIS"];
      if (!discriminates) {
        env.unjudged(
          `UNAVAILABLE (APPROVED_VS_PRICE_BASIS): approved (${expectation.approvedMinor}) plus the customer's gap (${scenario.customerShareMinor}) equals the sale price (${expectation.priceMinor}), so a margin measured on the price is indistinguishable from one measured on the financier's approval; CONSIGNMENT_ECONOMICS cannot be certified until the two revenues differ`,
        );
      }

      const customer = await seedFinancedCustomer(env, command, { lastName: `Consigned-${nonce}`, ltvPercent: scenario.ltvPercent });
      if (customer === null) return;
      const { approver, customerId } = customer;
      const supplierName = `Swarm Supplier ${nonce}`;
      const vehicleId = await command(() =>
        client.mutation(api.vehicles.create, {
          orgId: org,
          vin: syntheticVin("CNSG1", nonce),
          make: "Toyota",
          model: "Camry-cons1",
          year: 2022,
          mileage: 800,
          color: "Blue",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: figures.priceMajor,
          sourceType: "SOURCED",
          sourcedFromName: supplierName,
          // The supplier's ENTITLEMENT, not a purchase price: the car was never the dealership's.
          sourceCost: figures.entitlementMajor,
          status: "AVAILABLE",
          idempotencyKey: `${nonce}-vehicle`,
        }),
      );
      detail.vehicleId = String(vehicleId);

      // The product must have recorded the car as consigned at the supplier's price; otherwise the scenario is not the one judged.
      const stored: unknown = await command(() => client.query(api.vehicles.get, { orgId: org, vehicleId }));
      if (!isRecord(stored) || stored.sourceType !== "SOURCED" || stored.sourceCost !== figures.entitlementMajor) {
        env.unjudged("the stored vehicle is not the SOURCED car at the supplier's entitlement the scenario created, so it is not the case judged");
        return;
      }

      // The customer's reservation deposit is also the first payment the dealership later forwards to the financier.
      const applicationId = await submitApprovedApplication(env, command, customer, {
        vehicleId,
        priceMajor: figures.priceMajor,
        depositMajor: figures.depositMajor,
      });
      await command(() =>
        client.mutation(api.applications.setSupplierSettlementRoute, { orgId: org, applicationId, route: "THROUGH_DEALERSHIP" }),
      );
      await agreeEconomicsAndHandOver(env, { command, refusalIsInconclusive }, approver,applicationId, {
        quotationMinor: scenario.quotationMinor,
        firstPaymentMinor: scenario.firstPaymentMinor,
        approvedMinor: expectation.approvedMinor,
        shortfallMinor: scenario.shortfallMinor,
        customerShareMinor: scenario.customerShareMinor,
        dealerShareMinor: scenario.dealerShareMinor,
      });
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
      // H + D must reach the financier before the sale can close. `expectedAmountMinor` is the independently
      // derived figure: the product refuses unless it equals its own due amount, which cross-checks both.
      await refusalIsInconclusive(
        () =>
          approver.client.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
            orgId: org,
            applicationId,
            method: "BANK_TRANSFER",
            paidAt: Date.now() - PAID_AT_SKEW_MS,
            expectedAmountMinor: scenario.forwardDueMinor,
            idempotencyKey: `${nonce}-forward`,
          }),
        `the product refused the forward to the financier of the independently derived ${scenario.forwardDueMinor} (deposit ${scenario.depositMinor} plus contribution ${expectation.contributionMinor})`,
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
        sale.salePrice === figures.priceMajor;
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

      const keyOf = await readChartKeys(env, command);
      // Every read, including one that throws, leaves what it read (events, journals, account ids) in the evidence.
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

      // The journal is not the supplier's record: what the dealership settles him from is the canonical
      // payable row. A correct journal beside a missing or wrong row is a defect, and a row that cannot
      // be read is no pass: a refused read is unjudged and a malformed one is inconclusive.
      let raw: unknown;
      try {
        raw = await command(() => client.query(api.sourcingPayables.list, { orgId: org }));
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(
          `the canonical supplier payable could not be read through sourcingPayables.list (${describeError(error)}), so the supplier's record is unverified although the journal was judged`,
        );
        return;
      }
      const payables = parseSupplierPayables(raw);
      detail.supplierPayables = payables.filter((row) => row.saleId === saleId || row.vehicleId === String(vehicleId));
      env.judge(evaluateSupplierPayable(expectation, { saleId, vehicleId: String(vehicleId) }, payables));
    },
  };
}

export function createConsignmentAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: ConsignmentAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: MissionTiming = {
    sleep: overrides.sleep ?? realSleep,
    pollMs: overrides.pollMs ?? MISSION_TIMING_DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? MISSION_TIMING_DEFAULTS.postingWaitMs,
    uiSettleMs: overrides.uiSettleMs ?? MISSION_TIMING_DEFAULTS.uiSettleMs,
  };
  const figures: ConsignmentFigures = { ...CONSIGNMENT_FIGURES, ...overrides.figures };
  return {
    CONSIGNMENT_ECONOMICS: (context) => runBoundaryMission(runtimeApi, context, consignmentEconomicsSpec(options, figures)),
  };
}
