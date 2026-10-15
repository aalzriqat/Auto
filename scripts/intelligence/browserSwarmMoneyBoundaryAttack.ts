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
import { createHash } from "node:crypto";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { describeError } from "./browserSwarmBoundaryOracle";
import { runBoundaryMission, type BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import {
  MISSION_TIMING_DEFAULTS,
  PAID_AT_SKEW_MS,
  asArray,
  inconclusive,
  isRecord,
  isSaleCompleted,
  missionCommands,
  readSettledSaleLedger,
  realSleep,
  type ConsignmentAttackOptions,
  type MissionTiming,
} from "./browserSwarmConsignmentAttack";
import { untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
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

/** 17 uppercase characters, unique to the run, free of the letters a VIN forbids. */
function syntheticVin(nonce: string): string {
  return "MNYB1" + createHash("sha256").update(nonce).digest("hex").slice(0, 12).toUpperCase();
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
      const settings: unknown = await untilAborted(signal, client.query(api.orgSettings.get, { orgId: org }));
      const currency = isRecord(settings) && typeof settings.currency === "string" ? settings.currency : null;
      detail.currency = currency;
      if (currency === null) {
        env.unjudged("the organization's currency is unreadable, so no amount of the scenario can be expressed or judged; nothing was seeded");
        return;
      }
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

      // The MANAGER seat approves what the OWNER seat submits. A split dealership means no deal can be approved.
      const approver = await env.openSeat("approver");
      if (approver.orgId !== orgId) {
        env.unjudged("the approver seat signed in to a different organization, so the deal could not be approved; nothing was seeded");
        return;
      }

      const customerId = await command(() =>
        client.mutation(api.customers.create, { orgId: org, firstName: "Swarm", lastName: `Boundary-${nonce}` }),
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
          defaultLtvPercent: scenario.ltvPercent,
          // The admin fee below is recorded as the dealership's own cost; the company configures none.
          adminFees: 0,
          acceptedStatuses: [statusId],
          isActive: true,
        }),
      );
      const vehicleId = await command(() =>
        client.mutation(api.vehicles.create, {
          orgId: org,
          vin: syntheticVin(nonce),
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

      const quoteId = await command(() =>
        client.mutation(api.quotes.saveQuote, {
          orgId: org,
          customerId,
          vehicleId,
          vehiclePrice: figures.priceMajor,
          downPayment: 0,
          termMonths: 48,
          mode: "CONFIGURED_FINANCE_COMPANY",
          companyId,
          customerEligibilityStatusIds: [statusId],
          totalFinancedAmount: figures.priceMajor,
        }),
      );
      // The customer's reservation deposit: also the first payment the dealership later forwards to the financier.
      await command(() =>
        client.mutation(api.deposits.create, {
          orgId: org,
          quoteId,
          amount: figures.depositMajor,
          method: "CASH",
          idempotencyKey: `${nonce}-deposit`,
        }),
      );
      const applicationId = await command(() => client.mutation(api.applications.createFromQuote, { orgId: org, quoteId }));
      detail.applicationId = String(applicationId);
      await command(() => client.mutation(api.applications.updateStatus, { orgId: org, applicationId, status: "UNDER_REVIEW" }));
      await command(() => approver.client.mutation(api.applications.updateStatus, { orgId: org, applicationId, status: "APPROVED" }));
      await command(() =>
        client.mutation(api.financingEconomics.recordSubmittedQuotation, {
          orgId: org,
          applicationId,
          submittedQuotationMinor: scenario.quotationMinor,
          source: "MANUAL_ENTRY",
          customerFirstPaymentMinor: scenario.firstPaymentMinor,
        }),
      );
      await command(() =>
        approver.client.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
          orgId: org,
          applicationId,
          approvedAmountMinor: expectation.approvedMinor,
          basis: "MANUAL",
          notes: "Swarm approval below the quotation.",
        }),
      );

      // The product's own validation cross-checks the independently derived shortfall: it refuses shares that
      // do not sum to ITS net shortfall. That refusal is inconclusive, never a pass and never a silent re-derivation.
      const served: unknown = await command(() => approver.client.query(api.applications.get, { orgId: org, applicationId }));
      const gapStamp = isRecord(served) && typeof served.economicsStamp === "string" ? served.economicsStamp : null;
      if (gapStamp === null) inconclusive("the product issued no economics stamp for the gap agreement, so the deal cannot proceed");
      await refusalIsInconclusive(
        () =>
          approver.client.mutation(api.financingEconomics.resolveAppraisalGap, {
            orgId: org,
            applicationId,
            economicsStamp: gapStamp,
            customerGapShareMinor: scenario.customerShareMinor,
            dealerGapShareMinor: scenario.dealerShareMinor,
            customerGapCashToDealerMinor: scenario.customerShareMinor,
            customerGapInstallmentToDealerMinor: 0,
            customerGapToFinanceCompanyMinor: 0,
          }),
        `the product refused the gap agreement for the independently derived net shortfall of ${scenario.shortfallMinor} (customer ${scenario.customerShareMinor}, dealership ${scenario.dealerShareMinor})`,
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
      // Read the fee back: an accepted command is not proof the stored line is the dealership-paid, reconciled 300
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
        storedFee.status === "RECONCILED";
      if (!feeReadBack) {
        env.unjudged(
          `the stored admin fee is not exactly one reconciled, dealership-paid ${expectation.adminFeeMinor} ${currency} line outside the settlement for this application (${fees.length} fee line(s) read back), so the posting is not judged against this scenario`,
        );
        return;
      }
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

      const chart = asArray(await command(() => client.query(api.chartOfAccounts.list, { orgId: org })), "chartOfAccounts.list");
      const keyOf = new Map<string, string>();
      for (const account of chart) {
        if (!isRecord(account) || typeof account._id !== "string") continue;
        const key = typeof account.systemKey === "string" ? account.systemKey : typeof account.code === "string" ? account.code : null;
        if (key !== null) keyOf.set(account._id, key);
      }
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
    MONEY_BOUNDARY: (context) => runBoundaryMission(runtimeApi, context, moneyBoundarySpec(options, figures)),
  };
}
