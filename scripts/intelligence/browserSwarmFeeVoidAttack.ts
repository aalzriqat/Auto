/**
 * SCRUM-350 LIFE-1 — executable MONEY_BOUNDARY / STATE_TRANSITION browser attack.
 *
 * Owner invariant: a new way to SPEND creates reversal obligations on every path that
 * un-happens it. The spend here is a cost the DEALERSHIP pays directly (SCRUM-443); the
 * un-happen path is `voidDealFee`, which must take that payment back off the books.
 *
 * On the isolated, marker-gated disposable preview, with run-unique synthetic data, the
 * mission drives the product's own public commands: an approved financed application, then
 * two dealership-paid ownership-transfer costs on it (50 and 20), the first reconciled, both
 * paid directly by bank transfer. It reads both payments from the ledger, voids the first,
 * voids it again, and reads the ledger and the deal's cost lines after each step. The verdict
 * (browserSwarmFeeVoidOracle.ts) is the server's own state: the 50 payment untouched and
 * taken back by exactly one linked mirror reversal, the voided line gone, the 20 payment and
 * line exactly as they were, and the repeated void a no-op.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the fail-closed
 * rule) is the shared runBoundaryMission: a payment that never posts, a setup the product
 * refuses, or a premise that did not hold is INCONCLUSIVE or a harness error, never a pass.
 *
 * Not covered, and recorded as such in the evidence: every other un-happen path (an amount
 * edit, which also reverses the payment; custody-paid costs; deposits, refunds, the sale
 * itself), a period that is closed when the payment is taken back, the void through the
 * cockpit's own button (the commands are the product's public API; the deal screen is only
 * opened for its screenshot), and the void's own bookkeeping (voidedAt, voidedBy, reason),
 * which no public query serves. Deal cancellation is not a reversal path to measure here:
 * `cancelApplication` never calls `reverseDirectFeePayment` (only an amount edit and
 * `voidDealFee` do), so a cancelled deal keeps its direct payments posted; whether that is
 * intended is an open product question this mission does not answer. The records the run
 * creates stay in the disposable preview.
 */
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { describeError } from "./browserSwarmBoundaryOracle";
import { readSettledLedger } from "./browserSwarmBoundaryAttacks";
import type { BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import { PAID_AT_SKEW_MS, missionCommands, type MissionTiming } from "./browserSwarmConsignmentAttack";
import { untilAborted } from "./browserSwarmEconomicAttacks";
import {
  DIRECT_PAYMENT_EVENT,
  FEE_VOID_BANK_KEY,
  FEE_VOID_EXPENSE_KEY,
  FEE_VOID_FIGURES,
  evaluateDirectFeeVoid,
  feeVoidAmounts,
  type FeeLedgerStages,
  type FeeLineView,
  type FeeVoidFigures,
} from "./browserSwarmFeeVoidOracle";
import type { LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import {
  asArray,
  inconclusive,
  isRecord,
  readChartKeys,
  readOrgCurrency,
  seedFinancedCustomer,
  submitApprovedApplication,
  syntheticVin,
} from "./browserSwarmSeedHelpers";

/** The fee's source in the ledger: events are keyed by the cost line, not the deal. */
const FEE_SOURCE = "financeDealFees";

/** The live cost lines `listDealCosts` serves, reduced to what the mission judges. */
function parseCostLines(raw: unknown): FeeLineView[] {
  const fees = isRecord(raw) ? asArray(raw.fees, "listDealCosts.fees") : inconclusive("listDealCosts returned a malformed response");
  return fees.map((fee) => {
    if (!isRecord(fee) || typeof fee._id !== "string") return inconclusive("listDealCosts returned a malformed cost line");
    const payment = fee.directPayment;
    const paid = isRecord(payment);
    return {
      id: fee._id,
      actualAmountMinor: typeof fee.actualAmountMinor === "number" ? fee.actualAmountMinor : null,
      paymentVersion: paid && typeof payment.version === "number" ? payment.version : null,
      paymentAmountMinor: paid && typeof payment.amountMinor === "number" ? payment.amountMinor : null,
    };
  });
}

/**
 * The void commits its reversal in the same transaction, or queues it (PENDING) when no period is open.
 * Waiting for the queue to drain is the only wait; a reversal that is simply absent is the product's
 * failure, judged by the oracle, never a wait that ran out.
 */
const hasNothingPending = (snapshot: LedgerSnapshot): boolean => snapshot.events.every((event) => event.status !== "PENDING");

const isPaidOnLedger = (snapshot: LedgerSnapshot): boolean =>
  hasNothingPending(snapshot) &&
  snapshot.events.some((event) => event.eventType === DIRECT_PAYMENT_EVENT && event.status === "POSTED" && event.journalEntryId !== null);

export function feeVoidSpec(options: MissionTiming, figures: Readonly<FeeVoidFigures> = FEE_VOID_FIGURES) {
  return {
    attack: "MONEY_BOUNDARY",
    seat: "primary" as const,
    oracles: ["STATE_TRANSITION" as const],
    passSummary:
      "A dealership-paid cost (50) and a second one (20) were each recorded and paid directly by bank transfer; the first was also reconciled. Voiding the first took its payment off the books by exactly one linked, mirrored reversal, left the original posting untouched, removed the line from the deal and re-posted nothing; the second cost's payment, ledger and line were unchanged; a repeated void changed neither the ledger nor the deal. Judged on the server's own state against independently computed figures. Not read: any other un-happen path, a closed period, the cockpit's void button, and the void's own bookkeeping fields.",
    breachSummary: "Voiding a directly paid cost did not take exactly its payment back",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const { command, refusalIsInconclusive } = missionCommands(env, options);

      // The denomination is the organization's own, read before anything is seeded.
      const currency = await readOrgCurrency(env);
      if (currency === null) return;
      const amounts = feeVoidAmounts(figures, currency);
      if (!amounts.ok) {
        env.unjudged(`${amounts.reason}, so the void cannot be told from its sibling; nothing was seeded`);
        return;
      }
      const { voidedMinor, survivingMinor } = amounts;
      detail.expected = { voidedMinor, survivingMinor, expenseKey: FEE_VOID_EXPENSE_KEY, bankKey: FEE_VOID_BANK_KEY };
      detail.notExercised = [
        // The product does not reverse a direct payment on cancellation at all (see the header), so there is nothing to measure.
        "DEAL_CANCELLATION",
        "AMOUNT_EDIT_REVERSAL",
        "CUSTODY_PAID_COST",
        "CLOSED_PERIOD_REVERSAL",
        "COCKPIT_VOID_BUTTON",
        "VOID_BOOKKEEPING_FIELDS",
        "SALE_DEPOSIT_AND_REFUND_REVERSALS",
      ];

      const customer = await seedFinancedCustomer(env, command, { lastName: `FeeVoid-${nonce}`, ltvPercent: 85 });
      if (customer === null) return;
      const vehicleId = await command(() =>
        client.mutation(api.vehicles.create, {
          orgId: org,
          vin: syntheticVin("FEEV1", nonce),
          make: "Toyota",
          model: "Camry-acc3",
          year: 2022,
          mileage: 800,
          color: "Blue",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: 20_000,
          sourceType: "STOCK",
          purchasePrice: 15_000,
          // A priced owned car needs a declared payment method. Paid outright, so not ON_ACCOUNT (no supplier payable).
          purchasePaymentMethod: "BANK_TRANSFER",
          status: "AVAILABLE",
          idempotencyKey: `${nonce}-vehicle`,
        }),
      );
      const applicationId = await submitApprovedApplication(env, command, customer, { vehicleId, priceMajor: 20_000 });

      // SCRUM-54: a bank-transfer payment names the physical bank it left. A fresh zero-balance bank in the organization's
      // own denomination is created through the product's command (never a pre-existing one), on the disposable preview.
      const paidFromBankId = await refusalIsInconclusive(
        () =>
          client.mutation(api.bankAccounts.create, {
            orgId: org,
            name: `Swarm fee-void bank ${nonce}`,
            currency,
            openingBalanceMinor: 0,
            openingBalanceDate: Date.now(),
          }),
        "the product refused to create the bank the dealership-paid costs leave",
      );

      // Two dealership-paid costs on the deal; only the first is reconciled. Each is paid directly, by bank transfer, at
      // the amount the approver saw.
      const recordAndPay = async (label: string, amountMinor: number, reconcile: boolean) => {
        const feeId = await refusalIsInconclusive(
          () =>
            client.mutation(api.financeDealCosts.recordDealFee, {
              expectedCurrency: currency,
              idempotencyKey: `${nonce}-${label}-fee`,
              orgId: org,
              applicationId,
              feeType: "LICENSING",
              paidBy: "DEALER",
              paidTo: "GOVERNMENT",
              // The product's treatment value for an ownership-transfer expense; the account it debits is judged
              // separately, by FEE_VOID_EXPENSE_KEY in the ledger, not assumed from this string.
              accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
              deductedFromSettlement: false,
              actualAmountMinor: amountMinor,
              paidAt: Date.now() - PAID_AT_SKEW_MS,
              receiptReference: `${nonce}-${label}`,
              description: `Dealership-paid ${label} cost.`,
            }),
          `the product refused the dealership-paid ${label} cost of ${amountMinor}`,
        );
        if (reconcile) {
          await refusalIsInconclusive(
            () =>
              client.mutation(api.financeDealCosts.reconcileDealFee, {
                orgId: org,
                feeId,
                notes: "Cost settled.",
                expectedActualAmountMinor: amountMinor,
                expectedActualEvidenceRevision: 0,
              }),
            `the product refused to reconcile the ${label} cost of ${amountMinor}`,
          );
        }
        await refusalIsInconclusive(
          () =>
            client.mutation(api.financeDealCosts.recordDirectFeePayment, {
              orgId: org,
              feeId,
              method: "BANK_TRANSFER",
              bankAccountId: paidFromBankId,
              paidAt: Date.now() - PAID_AT_SKEW_MS,
              expectedAmountMinor: amountMinor,
              idempotencyKey: `${nonce}-${label}-pay`,
            }),
          `the product refused the direct payment of the ${label} cost of ${amountMinor}`,
        );
        return String(feeId);
      };
      const voidedFeeId = await recordAndPay("voided", voidedMinor, true);
      const survivingFeeId = await recordAndPay("surviving", survivingMinor, false);
      detail.voidedFeeId = voidedFeeId;
      detail.survivingFeeId = survivingFeeId;

      const readLines = async (): Promise<FeeLineView[]> =>
        parseCostLines(await command(() => client.query(api.financeDealCosts.listDealCosts, { orgId: org, applicationId })));
      // The two costs' ledgers are independent reads, so they settle side by side inside the mission's time.
      // Both reads are awaited to the end even when one fails, so none outlives the mission.
      const readFees = async (until: (snapshot: LedgerSnapshot) => boolean): Promise<[LedgerSnapshot, LedgerSnapshot]> => {
        const [voided, surviving] = await Promise.allSettled([
          readSettledLedger(env, options, voidedFeeId, { until, sourceType: FEE_SOURCE }),
          readSettledLedger(env, options, survivingFeeId, { until, sourceType: FEE_SOURCE }),
        ]);
        if (voided.status === "rejected") throw voided.reason;
        if (surviving.status === "rejected") throw surviving.reason;
        return [voided.value, surviving.value];
      };

      const linesBeforeVoid = await readLines();
      const [voidedPaid, survivingPaid] = await readFees(isPaidOnLedger);

      // The transition under test: the product's own void of the first cost.
      const voidFee = (reason: string) =>
        client.mutation(api.financeDealCosts.voidDealFee, { orgId: org, feeId: voidedFeeId as Id<"financeDealFees">, reason });
      await refusalIsInconclusive(() => voidFee(`${nonce} wrong cost`), "the product refused to void the directly paid cost");
      const linesAfterVoid = await readLines();
      const [voidedAfterVoid, survivingAfterVoid] = await readFees(hasNothingPending);

      // A retry (a double click, a lost response): the product's answer is read, never assumed.
      let repeatAccepted = true;
      try {
        await command(() => voidFee(`${nonce} wrong cost, again`));
      } catch (error) {
        if (signal.aborted) throw error;
        repeatAccepted = false;
        detail.repeatRefusal = describeError(error);
      }
      const linesAfterRepeat = await readLines();
      const [voidedAfterRepeat, survivingAfterRepeat] = await readFees(hasNothingPending);

      // The screen a dealer sees; its screenshot is part of the mission's evidence.
      try {
        await untilAborted(
          signal,
          page.goto(`/${orgId}/applications/${String(applicationId)}/deal`, { waitUntil: "domcontentloaded", timeout: options.uiSettleMs }),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(`the deal screen could not be opened for the screenshot (${describeError(error)})`);
        return;
      }

      const keyOf = await readChartKeys(env, command);

      const voided: FeeLedgerStages = { paid: voidedPaid, afterVoid: voidedAfterVoid, afterRepeat: voidedAfterRepeat };
      const surviving: FeeLedgerStages = { paid: survivingPaid, afterVoid: survivingAfterVoid, afterRepeat: survivingAfterRepeat };
      const lines = { beforeVoid: linesBeforeVoid, afterVoid: linesAfterVoid, afterRepeat: linesAfterRepeat };
      detail.ledger = { voided, surviving };
      detail.lines = lines;
      detail.repeatAccepted = repeatAccepted;
      env.judge(evaluateDirectFeeVoid({ currency, figures, voidedFeeId, survivingFeeId, keyOf, voided, surviving, lines, repeatAccepted }));
    },
  };
}
