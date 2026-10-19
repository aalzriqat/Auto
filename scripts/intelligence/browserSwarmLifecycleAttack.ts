/**
 * SCRUM-350 LIFE-1 — executable LIFECYCLE_REVERSAL / STATE_TRANSITION browser
 * attack: voiding one of two deposits held against the same car.
 *
 * Different transition from ACC-2's posted-expense reversal (that one judges
 * REVERSAL_RECONCILIATION on a single record). This one judges a STATE
 * transition with a survivor: the invariant (see browserSwarmLifecycleOracle.ts)
 * is that the void unwinds the voided deposit's own effects without erasing the
 * independently surviving obligation beside it.
 *
 * Scenario, through the product's own public commands on the isolated,
 * marker-gated disposable preview, with run-unique synthetic data: a customer, a
 * SOURCED car (consignment: no acquisition posting), a 20,000 CASH quote, and
 * TWO held reservation deposits on that quote, 200 and 300. The first is voided
 * "as recorded in error" by the approver seat, then asked to void, refund and
 * forfeit again; each must be refused and move nothing. Judged only on backend
 * authority: the deposit rows (`deposits.listByVehicle`), their canonical payments
 * (`subledger.getPaymentBalance`), the ledger events and journals
 * (`accountingLedger`), and the car (`vehicles.get`), read before the
 * void, after it, and after the repeated attempts.
 *
 * Proof boundary, recorded in the evidence: no screen calls `deposits.voidDeposit`,
 * so the void is a direct authenticated backend call by the approver seat, never a
 * click; the browser opens the vehicles screen only so its screenshot is part of
 * the evidence, and nothing on that screen is judged. A flow that cannot be set
 * up, a void the product refuses, or a state that cannot be read is INCONCLUSIVE
 * (unjudged), never a pass.
 *
 * Not covered: applying a deposit to a sale and cancelling it, a deposit already
 * forwarded to the finance company, the collection-payment mirror row (an org-wide
 * paginated `collections.listPayments` read exists, but this mission does not read
 * it; the canonical payment IS judged, through `subledger.getPaymentBalance`),
 * the receipt's account classification, the vehicle commitment claims, and voiding
 * into a closed accounting period. Each deposit is voided in cleanup, registered as
 * soon as it exists, so the car is not left held; cleanup never deletes a record.
 */
import { createHash } from "node:crypto";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  describeError,
  judgeRefusedAttempt,
  probe,
  type LedgerEvent,
  type LedgerLine,
  type LedgerSnapshot,
  type ProbeOutcome,
} from "./browserSwarmBoundaryOracle";
import type { BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  evaluateDepositVoidTransition,
  type DepositLifecycleState,
  type DepositView,
  type PaymentView,
} from "./browserSwarmLifecycleOracle";
import { untilAborted } from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";

export interface LifecycleAttackOptions {
  /** Replaces real waiting so tests run instantly. */
  sleep: (ms: number) => Promise<void>;
  /** Poll interval while waiting on the ledger. */
  pollMs: number;
  /** How long the ledger may take to settle after a deposit or a void. */
  postingWaitMs: number;
  /** How long the vehicles screen may take to load for the screenshot. */
  uiSettleMs: number;
}

export const DEPOSIT_VOID_FIGURES = {
  priceMajor: 20_000,
  voidedMajor: 200,
  survivorMajor: 300,
  sourceCostMajor: 15_000,
} as const;

/** `deposits.voidDeposit` of a deposit that is already gone. */
const VOID_AGAIN_REFUSAL = /deposit not found in this organization/i;
/** `deposits.release` of a deposit that is no longer HELD. */
const RESOLVED_REFUSAL = /already been resolved/i;
/** A cleanup void of a deposit that is already voided, gone or resolved has nothing left to do. */
const ALREADY_GONE_REFUSAL = /not found in this organization|only held|already been resolved/i;
const RATE_LIMIT_TEXT = /rate limit exceeded[^\d]{0,40}(\d{1,6})s/i;
const RATE_LIMIT_RETRIES = 3;
const LEDGER_ROW_LIMIT = 200;
const LEDGER_MAX_READS = 40;

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

/** 17 uppercase characters, unique to the run, free of the letters a VIN forbids (I, O and Q). */
export function syntheticVin(nonce: string): string {
  return "LFSD1" + createHash("sha256").update(nonce).digest("hex").slice(0, 12).toUpperCase();
}

/** This mission's cap on one rate-limit wait (not a product limit); the mission timeout ends anything longer. */
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

async function readLedger(client: ConvexHttpClient, orgId: string, depositId: string): Promise<LedgerSnapshot> {
  const raw = asArray(
    await client.query(api.accountingLedger.listAccountingEvents, {
      orgId: orgId as Id<"organizations">,
      sourceType: "deposits",
      sourceId: depositId,
      limit: LEDGER_ROW_LIMIT,
    }),
    "listAccountingEvents",
  );
  if (raw.length >= LEDGER_ROW_LIMIT) inconclusive(`accounting events for deposit ${depositId} may be truncated`);
  const events: LedgerEvent[] = raw.map((row) => {
    if (!isRecord(row) || typeof row._id !== "string" || typeof row.eventType !== "string" || typeof row.status !== "string") {
      return inconclusive("listAccountingEvents returned a malformed row");
    }
    return {
      id: row._id,
      eventType: row.eventType,
      status: row.status,
      reversalOfEventId: typeof row.reversalOfEventId === "string" ? row.reversalOfEventId : null,
      reversedByEventId: typeof row.reversedByEventId === "string" ? row.reversedByEventId : null,
      journalEntryId: typeof row.journalEntryId === "string" ? row.journalEntryId : null,
    };
  });
  const journals: Record<string, LedgerLine[]> = {};
  for (const event of events) {
    if (!event.journalEntryId || event.journalEntryId in journals) continue;
    const entry: unknown = await client.query(api.accountingLedger.getJournalEntry, {
      orgId: orgId as Id<"organizations">,
      journalEntryId: event.journalEntryId as Id<"journalEntries">,
    });
    if (entry === null) continue;
    if (!isRecord(entry)) inconclusive("getJournalEntry returned a malformed response");
    journals[event.journalEntryId] = asArray(entry.lines, "journal lines").map((line) => {
      if (
        !isRecord(line) ||
        typeof line.debitMinor !== "number" ||
        typeof line.creditMinor !== "number" ||
        typeof line.scale !== "number" ||
        typeof line.currency !== "string"
      ) {
        return inconclusive(`journal ${event.journalEntryId} has a malformed line`);
      }
      return {
        accountId: typeof line.accountId === "string" ? line.accountId : null,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        scale: line.scale,
        currency: line.currency,
      };
    });
  }
  return { events, journals };
}

function parseDeposit(rows: readonly unknown[], depositId: string): { view: DepositView; paymentId: string | null } | null {
  for (const row of rows) {
    if (!isRecord(row) || typeof row._id !== "string") return inconclusive("deposits.listByVehicle returned a malformed row");
    if (row._id !== depositId) continue;
    if (typeof row.status !== "string") return inconclusive(`deposit ${depositId} carries no status`);
    return {
      view: {
        id: row._id,
        status: row.status,
        isDeleted: row.isDeleted === true,
        holdActive: row.holdActive === true,
        amountMinor: typeof row.amountMinor === "number" ? row.amountMinor : null,
        releasedAmountMinor: typeof row.releasedAmountMinor === "number" ? row.releasedAmountMinor : 0,
        payment: null,
      },
      paymentId: typeof row.canonicalPaymentId === "string" ? row.canonicalPaymentId : null,
    };
  }
  return null;
}

/** The canonical payment through the permission-checked subledger read; null when it cannot be read. */
async function readPayment(env: BoundaryMissionEnv, paymentId: string | null): Promise<PaymentView | null> {
  if (paymentId === null) return null;
  const result: unknown = await untilAborted(
    env.signal,
    env.client.query(api.subledger.getPaymentBalance, {
      orgId: env.orgId as Id<"organizations">,
      paymentId: paymentId as Id<"canonicalPayments">,
    }),
  );
  if (!isRecord(result) || !isRecord(result.payment)) return null;
  const { payment } = result;
  if (typeof payment._id !== "string" || typeof payment.status !== "string") return null;
  const amountMinor = typeof payment.amountMinor === "number" ? payment.amountMinor : null;
  if (amountMinor === null || typeof result.unappliedMinor !== "number") return null;
  return { id: payment._id, status: payment.status, amountMinor, unappliedMinor: result.unappliedMinor };
}

interface Scenario {
  vehicleId: string;
  voidedId: string;
  survivorId: string;
}

async function readState(env: BoundaryMissionEnv, scenario: Scenario): Promise<DepositLifecycleState> {
  const { client, orgId, signal } = env;
  const org = orgId as Id<"organizations">;
  const rows = asArray(
    await untilAborted(signal, client.query(api.deposits.listByVehicle, { orgId: org, vehicleId: scenario.vehicleId as Id<"vehicles"> })),
    "deposits.listByVehicle",
  );
  const vehicle: unknown = await untilAborted(signal, client.query(api.vehicles.get, { orgId: org, vehicleId: scenario.vehicleId as Id<"vehicles"> }));
  const withPayment = async (parsed: ReturnType<typeof parseDeposit>): Promise<DepositView | null> =>
    parsed ? { ...parsed.view, payment: await readPayment(env, parsed.paymentId) } : null;
  return {
    voided: await withPayment(parseDeposit(rows, scenario.voidedId)),
    survivor: await withPayment(parseDeposit(rows, scenario.survivorId)),
    voidedLedger: await untilAborted(signal, readLedger(client, orgId, scenario.voidedId)),
    survivorLedger: await untilAborted(signal, readLedger(client, orgId, scenario.survivorId)),
    vehicleStatus: isRecord(vehicle) && typeof vehicle.status === "string" ? vehicle.status : null,
  };
}

const ledgerIsWhole = (snapshot: LedgerSnapshot): boolean =>
  snapshot.events.every((event) => event.status !== "PENDING" && (event.journalEntryId === null || event.journalEntryId in snapshot.journals));

/**
 * Two consecutive identical reads that satisfy `until`: the posting outbox drains asynchronously.
 * A ledger that stops changing with nothing pending but never satisfies `until` is returned as it
 * stands: a void that posts no reversal is the product's defect to be judged, not a wait that ran out.
 * Anything still PENDING, unreadable or moving at the deadline is inconclusive.
 */
async function readSettledState(
  env: BoundaryMissionEnv,
  options: LifecycleAttackOptions,
  scenario: Scenario,
  label: string,
  until: (state: DepositLifecycleState) => boolean,
): Promise<DepositLifecycleState> {
  const deadline = Date.now() + options.postingWaitMs;
  let previous = await readState(env, scenario);
  let unchanged = false;
  for (let reads = 1; reads < LEDGER_MAX_READS && Date.now() < deadline; reads += 1) {
    await untilAborted(env.signal, options.sleep(options.pollMs));
    const current = await readState(env, scenario);
    unchanged = JSON.stringify(current) === JSON.stringify(previous);
    if (unchanged && until(current)) return current;
    previous = current;
  }
  if (unchanged && ledgerIsWhole(previous.voidedLedger) && ledgerIsWhole(previous.survivorLedger)) return previous;
  return inconclusive(`the deposits' ledger state did not settle ${label}`);
}

const hasEvent = (snapshot: LedgerSnapshot, eventType: string): boolean =>
  snapshot.events.some((event) => event.eventType === eventType && event.status === "POSTED");

export function depositVoidTransitionSpec(options: LifecycleAttackOptions) {
  return {
    attack: "LIFECYCLE_REVERSAL",
    seat: "primary" as const,
    oracles: ["STATE_TRANSITION" as const],
    passSummary:
      "Voiding one of two deposits held against the same car moved only that deposit HELD to VOIDED and reversed only its own receipt with one linked mirror journal; the voided deposit's canonical payment was voided, the surviving deposit, its canonical payment, its ledger posting and the car's reservation were untouched, and a repeated void, refund and forfeit of the voided deposit were each refused and changed nothing. The void was a backend call: no screen exposes it.",
    breachSummary: "A deposit void did not unwind exactly its own effects",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const figures = DEPOSIT_VOID_FIGURES;

      /** One product command, waiting out the product's own write rate limit. */
      const command = async <T>(run: () => Promise<T>): Promise<T> => {
        for (let retries = 0; retries < RATE_LIMIT_RETRIES; retries += 1) {
          try {
            return await untilAborted(signal, run());
          } catch (error) {
            const wait = RATE_LIMIT_TEXT.exec(describeError(error));
            if (!wait) throw error;
            await untilAborted(signal, options.sleep(Math.min((Number(wait[1]) + 1) * 1000, RATE_LIMIT_MAX_WAIT_MS)));
          }
        }
        // The last attempt after the bounded waits: its own error, rate limit or not, is the one thrown.
        return await untilAborted(signal, run());
      };
      const attempt = async (label: string, refusal: RegExp, run: () => Promise<unknown>): Promise<ProbeOutcome> => {
        const outcome = await probe(() => untilAborted(signal, run()), refusal, signal);
        const probes = (detail.probes ??= []) as { label: string; outcome: string; message?: string }[];
        probes.push({ label, outcome: outcome.kind, ...("message" in outcome ? { message: outcome.message } : {}) });
        return outcome;
      };

      detail.lifecycle = "DEPOSIT_VOID_WITH_SURVIVOR";
      detail.voidVia = "backend mutation by the approver seat (no screen exposes deposits.voidDeposit)";
      detail.notExercised = [
        "SCREEN_VOID_ACTION",
        "APPLY_TO_SALE_AND_CANCEL",
        "DEPOSIT_FORWARDED_TO_FINANCE_COMPANY",
        "COLLECTION_PAYMENT_MIRROR_ROW",
        "RECEIPT_ACCOUNT_CLASSIFICATION",
        "VEHICLE_COMMITMENT_CLAIMS",
        "CLOSED_PERIOD_VOID",
      ];

      const settings: unknown = await untilAborted(signal, client.query(api.orgSettings.get, { orgId: org }));
      const currency = isRecord(settings) && typeof settings.currency === "string" ? settings.currency : null;
      detail.currency = currency;
      if (currency === null) {
        env.unjudged("the organization's currency is unreadable, so no deposit amount can be judged; nothing was seeded");
        return;
      }
      const approver = await env.openSeat("approver");
      if (approver.orgId !== orgId) {
        env.unjudged("the approver seat signed in to a different organization, so the deposit could not be voided; nothing was seeded");
        return;
      }

      const customerId = await command(() =>
        client.mutation(api.customers.create, { orgId: org, firstName: "Swarm", lastName: `Deposits-${nonce}` }),
      );
      const vehicleId = await command(() =>
        client.mutation(api.vehicles.create, {
          orgId: org,
          vin: syntheticVin(nonce),
          make: "Toyota",
          model: "Camry-life1",
          year: 2022,
          mileage: 800,
          color: "Blue",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: figures.priceMajor,
          sourceType: "SOURCED",
          sourcedFromName: `Swarm Supplier ${nonce}`,
          sourceCost: figures.sourceCostMajor,
          status: "AVAILABLE",
          idempotencyKey: `${nonce}-vehicle`,
        }),
      );
      const quoteId = await command(() =>
        client.mutation(api.quotes.saveQuote, {
          orgId: org,
          customerId,
          vehicleId,
          mode: "CASH",
          vehiclePrice: figures.priceMajor,
          downPayment: 0,
          termMonths: 0,
        }),
      );
      // Each deposit is customer money held against the car the moment it exists, so its cleanup is
      // registered right then: a refusal of a later step must not leave it HELD. Cleanup only voids;
      // a deposit already voided or resolved is the goal reached, and no record is ever deleted.
      const deposit = async (amount: number, suffix: string): Promise<string> => {
        const id = String(
          await command(() =>
            client.mutation(api.deposits.create, {
              orgId: org,
              quoteId,
              amount,
              method: "CASH",
              idempotencyKey: `${nonce}-deposit-${suffix}`,
            }),
          ),
        );
        env.onCleanup(`void the ${suffix} deposit`, async () => {
          try {
            await approver.client.mutation(api.deposits.voidDeposit, {
              orgId: org,
              depositId: id as Id<"deposits">,
              reason: `${nonce} mission cleanup`,
            });
          } catch (error) {
            if (!ALREADY_GONE_REFUSAL.test(describeError(error))) throw error;
          }
        });
        return id;
      };
      const voidedId = await deposit(figures.voidedMajor, "voided");
      const survivorId = await deposit(figures.survivorMajor, "survivor");
      const scenario: Scenario = { vehicleId: String(vehicleId), voidedId, survivorId };
      detail.scenario = { ...scenario, quoteId: String(quoteId), ...figures };

      const received = (state: DepositLifecycleState): boolean =>
        hasEvent(state.voidedLedger, "DEPOSIT_RECEIVED") &&
        hasEvent(state.survivorLedger, "DEPOSIT_RECEIVED") &&
        ledgerIsWhole(state.voidedLedger) &&
        ledgerIsWhole(state.survivorLedger);
      const before = await readSettledState(env, options, scenario, "after both deposits were taken", received);

      // The canonical correction. A product that refuses it means the transition was never exercised.
      try {
        await command(() =>
          approver.client.mutation(api.deposits.voidDeposit, {
            orgId: org,
            depositId: voidedId as Id<"deposits">,
            reason: `${nonce} recorded in error`,
          }),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        detail.before = before;
        env.unjudged(`the product refused to void the deposit (${describeError(error)}), so the void transition could not be judged`);
        return;
      }
      const afterVoid = await readSettledState(
        env,
        options,
        scenario,
        "after the void",
        (state) => hasEvent(state.voidedLedger, "JOURNAL_REVERSAL") && ledgerIsWhole(state.voidedLedger) && ledgerIsWhole(state.survivorLedger),
      );

      // The voided deposit may leave no other way: each of these must be refused and move nothing.
      const voidAgain = await attempt("deposits.voidDeposit (second request)", VOID_AGAIN_REFUSAL, () =>
        approver.client.mutation(api.deposits.voidDeposit, { orgId: org, depositId: voidedId as Id<"deposits">, reason: `${nonce} repeated` }),
      );
      env.judge(judgeRefusedAttempt("deposits.voidDeposit (second request)", voidAgain));
      for (const [resolution, refundMethod] of [["REFUNDED", "CASH"], ["FORFEITED", undefined]] as const) {
        const label = `deposits.release ${resolution} (voided deposit)`;
        const outcome = await attempt(label, RESOLVED_REFUSAL, () =>
          approver.client.mutation(api.deposits.release, {
            orgId: org,
            depositId: voidedId as Id<"deposits">,
            resolution,
            ...(refundMethod ? { refundMethod } : {}),
            idempotencyKey: `${nonce}-release-${resolution}`,
          }),
        );
        env.judge(judgeRefusedAttempt(label, outcome));
      }
      const afterAttempts = await readSettledState(env, options, scenario, "after the repeated attempts", () => true);

      // The screen a dealer sees; its screenshot is part of the evidence and nothing on it is judged.
      try {
        await untilAborted(signal, page.goto(`/${orgId}/vehicles`, { waitUntil: "domcontentloaded", timeout: options.uiSettleMs }));
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(`the vehicles screen could not be opened for the screenshot (${describeError(error)})`);
      }

      detail.states = { before, afterVoid, afterAttempts };
      env.judge(
        evaluateDepositVoidTransition({
          before,
          afterVoid,
          afterAttempts,
          voidedAmountMajor: figures.voidedMajor,
          survivorAmountMajor: figures.survivorMajor,
          expectedCurrency: currency,
        }),
      );
    },
  };
}
