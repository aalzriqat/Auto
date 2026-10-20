/**
 * SCRUM-350 ACC-1 — executable MONEY_BOUNDARY browser attack.
 *
 * Drives a financed sale of a DEALERSHIP-OWNED car (the principal basis, where CONS-1
 * covers the consigned one) end to end through the product's own public commands, on the
 * isolated, marker-gated disposable preview, with run-unique synthetic data: customer, an
 * 85% finance company, a 20,000 car the dealership bought for 15,000, a 200 deposit (also
 * the customer's first payment), a 20,000 quotation the financier approves at only 18,000,
 * a REAL resolved shortfall (net 1,700: the customer owes the dealership 1,000, agreed as
 * cash and never collected here; the dealership absorbs 700) and a 300 admin fee the
 * dealership pays itself. The deal is approved by the MANAGER seat, handed over, its
 * deposit + contribution paid to the financier, and finalized by the OWNER seat.
 *
 * The sale's posted journal (the entries whose source is the sale) is read back through
 * the same permission-checked queries an accountant uses and judged, account by account
 * and side by side, against figures computed in browserSwarmMoneyBoundaryOracle.ts, never
 * from the product: revenue is the approval plus the customer's gap (19,000, not the
 * 20,000 price), the financier owes the full 18,000 (the admin fee is not netted off it),
 * the deposit liability is released, and the car's 15,000 cost leaves inventory. A
 * balanced entry on the wrong accounts or amounts is a breach.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the fail-closed
 * rule) is the shared runBoundaryMission: a posting that never settles, a deal that cannot
 * be finalized, a setup the product refuses, or a scenario the chosen figures cannot use to
 * tell a wrong basis from the right one is INCONCLUSIVE or a harness error, never a pass.
 *
 * Not covered, and recorded as such in the evidence: a cash sale, tax and dealer-fee income,
 * the consigned car (CONS-1), the vehicle's acquisition posting, the admin fee's own
 * posting, the deposit-receipt and forward-payment postings, the finance-company and
 * customer receivable subledger rows, and cancellation or reversal. The records the run
 * creates stay in the disposable preview; a finalized deal is posted financial history.
 */
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { describeError } from "./browserSwarmBoundaryOracle";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  MISSION_TIMING_DEFAULTS,
  PAID_AT_SKEW_MS,
  isSaleCompleted,
  missionCommands,
  readSettledSaleLedger,
  realSleep,
  type ConsignmentAttackOptions,
  type MissionTiming,
} from "./browserSwarmConsignmentAttack";
import { untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { feeVoidSpec } from "./browserSwarmFeeVoidAttack";
import {
  agreeEconomicsAndHandOver,
  asArray,
  isRecord,
  readChartKeys,
  readOrgCurrency,
  seedFinancedCustomer,
  submitApprovedApplication,
  syntheticVin,
} from "./browserSwarmSeedHelpers";
import {
  MONEY_BOUNDARY_FIGURES,
  buildMoneyBoundaryScenario,
  evaluateMoneyBoundary,
  expectedNetRevenueMinor,
  priceBasisNetRevenueMinor,
  undiscriminatedBases,
  type MoneyBoundaryFigures,
} from "./browserSwarmMoneyBoundaryOracle";

export interface MoneyBoundaryAttackOptions extends Omit<ConsignmentAttackOptions, "figures"> {
  /** Replaces parts of the scenario's figures (major units); tests use it to build a scenario that cannot discriminate. */
  figures?: Partial<MoneyBoundaryFigures>;
}

function moneyBoundarySpec(options: MissionTiming, figures: Readonly<MoneyBoundaryFigures>) {
  return {
    attack: "MONEY_BOUNDARY",
    seat: "primary" as const,
    oracles: ["ECONOMIC_AUTHORITY" as const],
    passSummary:
      "A financed sale of a dealership-owned car, approved below its price with a resolved customer gap, a forwarded deposit and a dealer-paid admin fee, posted a sale journal (the entries whose source is the sale) that recognized revenue on the approved amount plus the customer's gap (less the dealership's contribution), owed the full approval by the financier, released the deposit liability, owed the financier the deposit and contribution onward, relieved the car's cost from inventory, and posted nothing on any other account. Judged account by account against independently computed figures. Not read: the vehicle acquisition, admin fee, deposit-receipt and forward-payment postings, and the finance-company and customer receivable subledger rows.",
    breachSummary: "A financed sale of dealership stock was not posted on the owned-stock basis",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const { command, refusalIsInconclusive } = missionCommands(env, options);

      // The denomination is the organization's own, read before anything is seeded.
      const currency = await readOrgCurrency(env);
      if (currency === null) return;
      const built = buildMoneyBoundaryScenario(currency, figures);
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
        netShortfallMinor: scenario.shortfallMinor,
        customerShareMinor: scenario.customerShareMinor,
        dealerShareMinor: scenario.dealerShareMinor,
        forwardDueMinor: scenario.forwardDueMinor,
        expectedNetRevenueMinor: expectedNetRevenueMinor(expectation),
        priceBasisNetRevenueMinor: priceBasisNetRevenueMinor(expectation),
      };
      detail.notExercised = [
        "CASH_SALE",
        "TAX_AND_DEALER_FEE_INCOME",
        "CONSIGNED_VEHICLE",
        "CUSTOMER_GAP_COLLECTION",
        "REVERSAL",
        // Read nowhere: only the journals whose source is this sale are judged.
        "VEHICLE_ACQUISITION_POSTING",
        "ADMIN_FEE_POSTING",
        "DEPOSIT_RECEIPT_AND_FORWARD_PAYMENT_POSTINGS",
        "FINANCE_COMPANY_RECEIVABLE_SUBLEDGER",
        "CUSTOMER_RECEIVABLE_SUBLEDGER",
      ];
      // A basis the figures cannot tell from the right one would pass unexamined, so the mission is
      // UNAVAILABLE (never a pass). Breaches it can still prove are reported.
      const blind = undiscriminatedBases(expectation);
      detail.notDiscriminated = blind;
      if (blind.length > 0) {
        env.unjudged(
          `UNAVAILABLE (${blind.join(", ")}): the scenario's figures cannot tell ${blind.join(", ")} from the correct posting, so MONEY_BOUNDARY cannot be certified until they can`,
        );
      }

      // The finance company configures no admin fee: the one recorded below is the dealership's own cost.
      const customer = await seedFinancedCustomer(env, command, { lastName: `Boundary-${nonce}`, ltvPercent: scenario.ltvPercent });
      if (customer === null) return;
      const { approver, customerId } = customer;
      const vehicleId = await command(() =>
        client.mutation(api.vehicles.create, {
          orgId: org,
          vin: syntheticVin("MNYB1", nonce),
          make: "Toyota",
          model: "Camry-acc1",
          year: 2022,
          mileage: 800,
          color: "Blue",
          fuelType: "Gasoline",
          transmission: "Automatic",
          sellingPrice: figures.priceMajor,
          sourceType: "STOCK",
          // The dealership's own purchase price: the car is its stock, and its cost leaves inventory at the sale.
          purchasePrice: figures.costMajor,
          // A positive purchase price posts an acquisition, which the product refuses without a declared method. Paid outright, so
          // not ON_ACCOUNT (that would add a supplier payable this scenario does not judge).
          purchasePaymentMethod: "BANK_TRANSFER",
          status: "AVAILABLE",
          idempotencyKey: `${nonce}-vehicle`,
        }),
      );
      detail.vehicleId = String(vehicleId);

      // The product must have recorded the car as the dealership's own at its purchase price; otherwise the scenario is not the one judged.
      const stored: unknown = await command(() => client.query(api.vehicles.get, { orgId: org, vehicleId }));
      if (!isRecord(stored) || stored.sourceType === "SOURCED" || stored.purchasePrice !== figures.costMajor) {
        env.unjudged("the stored vehicle is not the dealership-owned car at the purchase price the scenario created, so it is not the case judged");
        return;
      }

      // The customer's reservation deposit is also the first payment the dealership later forwards to the financier.
      const applicationId = await submitApprovedApplication(env, command, customer, {
        vehicleId,
        priceMajor: figures.priceMajor,
        depositMajor: figures.depositMajor,
      });
      await agreeEconomicsAndHandOver(env, { command, refusalIsInconclusive }, approver, applicationId, {
        quotationMinor: scenario.quotationMinor,
        firstPaymentMinor: scenario.firstPaymentMinor,
        approvedMinor: expectation.approvedMinor,
        shortfallMinor: scenario.shortfallMinor,
        customerShareMinor: scenario.customerShareMinor,
        dealerShareMinor: scenario.dealerShareMinor,
      });
      // The dealership's own admin fee: a cost of the deal, not a deduction from the financier's transfer.
      const feeId = await refusalIsInconclusive(
        () =>
          client.mutation(api.financeDealCosts.recordDealFee, {
            expectedCurrency: currency,
            idempotencyKey: `${nonce}-admin-fee`,
            orgId: org,
            applicationId,
            feeType: "OTHER_CLOSING_EXPENSE",
            paidBy: "DEALER",
            paidTo: "OTHER",
            accountingTreatment: "SELLING_EXPENSE",
            deductedFromSettlement: false,
            actualAmountMinor: expectation.adminFeeMinor,
            paidAt: Date.now() - PAID_AT_SKEW_MS,
            receiptReference: `${nonce}-admin-fee`,
            description: "Dealership-paid admin fee.",
          }),
        `the product refused the dealership-paid admin fee of ${expectation.adminFeeMinor}`,
      );
      await refusalIsInconclusive(
        () =>
          client.mutation(api.financeDealCosts.reconcileDealFee, {
            orgId: org,
            feeId,
            notes: "Admin fee settled.",
            expectedActualAmountMinor: expectation.adminFeeMinor,
            expectedActualEvidenceRevision: 0,
          }),
        `the product refused to reconcile the dealership-paid admin fee of ${expectation.adminFeeMinor}`,
      );
      // SCRUM-54: a bank-transfer payment names the physical bank it left. A fresh zero-balance bank in the organization's
      // own denomination is created through the product's command (never a pre-existing one), on the disposable preview.
      const paidFromBankId = await refusalIsInconclusive(
        () =>
          client.mutation(api.bankAccounts.create, {
            orgId: org,
            name: `Swarm money-boundary bank ${nonce}`,
            currency,
            openingBalanceMinor: 0,
            openingBalanceDate: Date.now(),
          }),
        "the product refused to create the bank the dealership-paid admin fee leaves",
      );
      // The dealership really paid the fee: the finance guard refuses the forward while a dealership-paid cost has no recorded payment.
      await refusalIsInconclusive(
        () =>
          client.mutation(api.financeDealCosts.recordDirectFeePayment, {
            orgId: org,
            feeId,
            method: "BANK_TRANSFER",
            bankAccountId: paidFromBankId,
            paidAt: Date.now() - PAID_AT_SKEW_MS,
            expectedAmountMinor: expectation.adminFeeMinor,
            idempotencyKey: `${nonce}-admin-fee-pay`,
          }),
        `the product refused the direct payment of the dealership-paid admin fee of ${expectation.adminFeeMinor}`,
      );
      // Read the fee back: an accepted command is not proof the stored line is the dealership-paid, reconciled, paid 300
      // that the posting below is judged against.
      const costs: unknown = await command(() => client.query(api.financeDealCosts.listDealCosts, { orgId: org, applicationId }));
      const fees = isRecord(costs) ? asArray(costs.fees, "listDealCosts.fees") : [];
      const [storedFee] = fees;
      const feeReadBack =
        fees.length === 1 &&
        isRecord(storedFee) &&
        String(storedFee._id) === String(feeId) &&
        String(storedFee.applicationId) === String(applicationId) &&
        storedFee.currency === currency &&
        storedFee.actualAmountMinor === expectation.adminFeeMinor &&
        storedFee.paidBy === "DEALER" &&
        storedFee.deductedFromSettlement === false &&
        storedFee.status === "RECONCILED" &&
        storedFee.handoverPayment === "PAID_DIRECT";
      if (!feeReadBack) {
        env.unjudged(
          `the stored admin fee is not exactly one reconciled, dealership-paid ${expectation.adminFeeMinor} ${currency} line outside the settlement for this application (${fees.length} fee line(s) read back), so the posting is not judged against this scenario`,
        );
        return;
      }
      // H + D must reach the financier before the sale can close. `expectedAmountMinor` is the independently
      // derived figure: the product refuses unless it equals its own due amount, which cross-checks both.
      // SCRUM-54: the approver may lack MANAGE_FINANCE and so cannot create a bank; it pays from the one the OWNER created above.
      await refusalIsInconclusive(
        () =>
          approver.client.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
            orgId: org,
            applicationId,
            method: "BANK_TRANSFER",
            bankAccountId: paidFromBankId,
            paidAt: Date.now() - PAID_AT_SKEW_MS,
            expectedAmountMinor: scenario.forwardDueMinor,
            idempotencyKey: `${nonce}-forward`,
          }),
        `the product refused the forward to the financier of the independently derived ${scenario.forwardDueMinor} (deposit ${expectation.depositMinor} plus contribution ${expectation.contributionMinor})`,
      );
      const saleId = String(
        await command(() =>
          client.mutation(api.applications.finalizeDeal, { idempotencyKey: `${nonce}-finalize`, orgId: org, applicationId }),
        ),
      );
      detail.saleId = saleId;

      // The journal read below is this mission's evidence only if the sale is the one this scenario seeded.
      const sale: unknown = await command(() => client.query(api.sales.get, { orgId: org, saleId: saleId as Id<"sales"> }));
      const sameIdentity =
        isRecord(sale) &&
        String(sale.vehicleId) === String(vehicleId) &&
        String(sale.customerId) === String(customerId) &&
        String(sale.applicationId) === String(applicationId) &&
        String(sale._id) === saleId &&
        String(sale.orgId) === String(org) &&
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
      env.judge(evaluateMoneyBoundary(expectation, ledger.lines));
    },
  };
}

export function createMoneyBoundaryAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: MoneyBoundaryAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: MissionTiming = {
    sleep: overrides.sleep ?? realSleep,
    pollMs: overrides.pollMs ?? MISSION_TIMING_DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? MISSION_TIMING_DEFAULTS.postingWaitMs,
    uiSettleMs: overrides.uiSettleMs ?? MISSION_TIMING_DEFAULTS.uiSettleMs,
  };
  const figures: MoneyBoundaryFigures = { ...MONEY_BOUNDARY_FIGURES, ...overrides.figures };
  return {
    // LIFE-1 asks the same family to be judged by STATE_TRANSITION: a distinct scenario (a directly paid cost is
    // voided) with its own oracle. Any other oracle reaches the ACC-1 spec, which refuses it.
    MONEY_BOUNDARY: (context) => {
      const spec = context.mission.oracle === "STATE_TRANSITION" ? feeVoidSpec(options) : moneyBoundarySpec(options, figures);
      return runBoundaryMission(runtimeApi, context, spec);
    },
  };
}
