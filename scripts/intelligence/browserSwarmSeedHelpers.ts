/**
 * The seed steps the CONS-1, ACC-1 and LIFE-1 MONEY_BOUNDARY missions share, so each mission's own file holds only
 * what is particular to its scenario: a run-unique synthetic VIN, the organization's currency, the approver seat
 * with a customer and a finance company, an approved application, the gap agreement through handover, and the
 * chart-of-accounts key map. Every step is the mission's own public product command, in the order the missions
 * issued them before, and every refusal keeps the caller's fail-closed handling (`command` retries a rate limit,
 * `refusalIsInconclusive` turns a product refusal into INCONCLUSIVE).
 */
import { createHash } from "node:crypto";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { probe } from "./browserSwarmBoundaryOracle";
import type { BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import { untilAborted } from "./browserSwarmEconomicAttacks";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";

export type MissionCommand = <T>(run: () => Promise<T>) => Promise<T>;
export type MissionRefusal = <T>(run: () => Promise<T>, refused: string) => Promise<T>;
type ApproverSeat = Awaited<ReturnType<BoundaryMissionEnv["openSeat"]>>;

export function inconclusive(message: string): never {
  throw new BrowserSwarmOracleInconclusiveError(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) inconclusive(`${label} returned a non-array response`);
  return value;
}

/** 17 uppercase characters, unique to the run, free of the letters a VIN forbids. `prefix` is five such characters naming the mission. */
export function syntheticVin(prefix: string, nonce: string): string {
  return prefix + createHash("sha256").update(nonce).digest("hex").slice(0, 12).toUpperCase();
}

/** Chart account id to its system key (the account code when it has none), from `chartOfAccounts.list`. */
export function chartKeysById(chart: readonly unknown[]): Map<string, string> {
  const keyOf = new Map<string, string>();
  for (const account of chart) {
    if (!isRecord(account) || typeof account._id !== "string") continue;
    const key = typeof account.systemKey === "string" ? account.systemKey : typeof account.code === "string" ? account.code : null;
    if (key !== null) keyOf.set(account._id, key);
  }
  return keyOf;
}

export async function readChartKeys(env: BoundaryMissionEnv, command: MissionCommand): Promise<Map<string, string>> {
  const org = env.orgId as Id<"organizations">;
  return chartKeysById(asArray(await command(() => env.client.query(api.chartOfAccounts.list, { orgId: org })), "chartOfAccounts.list"));
}

/**
 * The organization's own denomination, read before anything is seeded and recorded in the evidence. When it is
 * unreadable the mission is unjudged (nothing was seeded) and null is returned: the caller returns.
 */
export async function readOrgCurrency(env: BoundaryMissionEnv): Promise<string | null> {
  const settings: unknown = await untilAborted(
    env.signal,
    env.client.query(api.orgSettings.get, { orgId: env.orgId as Id<"organizations"> }),
  );
  const currency = isRecord(settings) && typeof settings.currency === "string" ? settings.currency : null;
  env.detail.currency = currency;
  if (currency === null) {
    env.unjudged("the organization's currency is unreadable, so no amount of the scenario can be expressed or judged; nothing was seeded");
  }
  return currency;
}

/**
 * The MANAGER seat approves what the OWNER seat submits (a split dealership means no deal can be approved), then
 * a customer, the eligibility status and a finance company that accepts it. Null, with the mission unjudged,
 * when the approver signed in to another organization.
 */
export async function seedFinancedCustomer(
  env: BoundaryMissionEnv,
  command: MissionCommand,
  seed: { lastName: string; ltvPercent: number },
) {
  const { client, orgId, nonce } = env;
  const org = orgId as Id<"organizations">;
  const approver = await env.openSeat("approver");
  if (approver.orgId !== orgId) {
    env.unjudged("the approver seat signed in to a different organization, so the deal could not be approved; nothing was seeded");
    return null;
  }
  const customerId = await command(() => client.mutation(api.customers.create, { orgId: org, firstName: "Swarm", lastName: seed.lastName }));
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
      defaultLtvPercent: seed.ltvPercent,
      adminFees: 0,
      acceptedStatuses: [statusId],
      isActive: true,
    }),
  );
  return { approver, customerId, statusId, companyId };
}

/**
 * A financed quote on the vehicle (with the customer's reservation deposit when `depositMajor` is given: also the
 * first payment the dealership later forwards to the financier), the application created from it, and its
 * progression UNDER_REVIEW (primary seat) then APPROVED (approver seat). Returns the application id.
 */
export async function submitApprovedApplication(
  env: BoundaryMissionEnv,
  command: MissionCommand,
  customer: NonNullable<Awaited<ReturnType<typeof seedFinancedCustomer>>>,
  deal: { vehicleId: Id<"vehicles">; priceMajor: number; depositMajor?: number },
) {
  const { client, orgId, nonce, detail } = env;
  const org = orgId as Id<"organizations">;
  const { approver, customerId, statusId, companyId } = customer;
  const quoteId = await command(() =>
    client.mutation(api.quotes.saveQuote, {
      orgId: org,
      customerId,
      vehicleId: deal.vehicleId,
      vehiclePrice: deal.priceMajor,
      downPayment: 0,
      termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId,
      customerEligibilityStatusIds: [statusId],
      totalFinancedAmount: deal.priceMajor,
    }),
  );
  if (deal.depositMajor !== undefined) {
    const amount = deal.depositMajor;
    await command(() =>
      client.mutation(api.deposits.create, { orgId: org, quoteId, amount, method: "CASH", idempotencyKey: `${nonce}-deposit` }),
    );
  }
  const applicationId = await command(() => client.mutation(api.applications.createFromQuote, { orgId: org, quoteId }));
  detail.applicationId = String(applicationId);
  await command(() => client.mutation(api.applications.updateStatus, { orgId: org, applicationId, status: "UNDER_REVIEW" }));
  await command(() => approver.client.mutation(api.applications.updateStatus, { orgId: org, applicationId, status: "APPROVED" }));
  return applicationId;
}

/** The owner ruling behind the refusal the missions attack. */
export const GAP_REFUSAL_RULING = "SCRUM-760 c23812 #10";

/**
 * Why a scenario that states a customer gap owed to the dealership cannot be seeded, or null when it states none.
 * The pilot cannot collect such a gap, so the product (rightly) refuses the agreement and the deal never closes; a
 * mission that submitted it would judge nothing. Missions ask before seeding anything, and the gap step asks again.
 */
export function customerGapOwedProblem(customerShareMinor: number): string | null {
  return customerShareMinor === 0
    ? null
    : `the scenario states a customer gap of ${customerShareMinor} owed to the dealership, which the pilot refuses (${GAP_REFUSAL_RULING}), so the deal could not be closed`;
}

/** The refusal text of FINANCED_CUSTOMER_GAP_UNCOLLECTABLE_REFUSED (convex/utils/saleDebtContainment.ts); no other refusal says it. */
export const UNCOLLECTABLE_GAP_REFUSAL = /customer would still owe the dealership part of the gap/i;

/** The economics stamp the application serves now, or null when it serves none. */
async function readEconomicsStamp(
  command: MissionCommand,
  approver: ApproverSeat,
  org: Id<"organizations">,
  applicationId: Id<"financeApplications">,
): Promise<string | null> {
  const served: unknown = await command(() => approver.client.query(api.applications.get, { orgId: org, applicationId }));
  return isRecord(served) && typeof served.economicsStamp === "string" ? served.economicsStamp : null;
}

/**
 * Attacks the refusal itself (SCRUM-760 c23812 #10): an agreement that leaves the customer owing the dealership the
 * whole net shortfall must be refused, and the refusal must come before any write, so the application serves the
 * same economics stamp afterwards. Acceptance, or a changed stamp, is a breach; a refusal for any other reason, or a
 * lapsed session, is unjudged. The deal then goes on with the agreement the pilot accepts.
 */
async function attackUncollectableGapRefusal(
  env: BoundaryMissionEnv,
  step: {
    command: MissionCommand;
    approver: ApproverSeat;
    org: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    gapStamp: string;
    shortfallMinor: number;
  },
): Promise<void> {
  const { command, approver, org, applicationId, gapStamp, shortfallMinor } = step;
  const attempt = await probe(
    () =>
      command(() =>
        approver.client.mutation(api.financingEconomics.resolveAppraisalGap, {
          orgId: org,
          applicationId,
          economicsStamp: gapStamp,
          customerGapShareMinor: shortfallMinor,
          dealerGapShareMinor: 0,
          customerGapCashToDealerMinor: shortfallMinor,
          customerGapInstallmentToDealerMinor: 0,
          customerGapToFinanceCompanyMinor: 0,
        }),
      ),
    UNCOLLECTABLE_GAP_REFUSAL,
    env.signal,
  );
  const label = `a gap agreement leaving the customer owing the dealership ${shortfallMinor} (${GAP_REFUSAL_RULING})`;
  switch (attempt.kind) {
    case "ACCEPTED":
      env.judge({ violations: [`${label} was accepted`], unjudged: [] });
      return inconclusive("the refused gap agreement was accepted, so the deal is no longer the scenario judged");
    case "REFUSED":
      env.judge({ violations: [], unjudged: [] });
      break;
    case "LAPSED":
      env.judge({ violations: [], unjudged: [`${label}: the harness session lapsed, so the call proves nothing about the refusal`] });
      return;
    case "UNCLASSIFIED":
      env.judge({
        violations: [],
        unjudged: [`${label}: failed for a reason other than the pilot's customer-gap refusal (${attempt.message}), so the refusal is unproven`],
      });
      return;
  }
  const after = await readEconomicsStamp(command, approver, org, applicationId);
  env.judge({
    violations: after === gapStamp ? [] : [`the refused gap agreement changed the application's economics (stamp ${gapStamp} became ${after ?? "none"}): the refusal came after a write`],
    unjudged: [],
  });
  if (after !== gapStamp) inconclusive("the refused gap agreement changed the application, so the deal is no longer the scenario judged");
}

/**
 * The financier's quotation and the approval below it, the appraisal-gap agreement and the vehicle handover, then
 * the expected payment. The product's own validation cross-checks the independently derived shortfall: it refuses
 * shares that do not sum to ITS net shortfall, and that refusal is inconclusive, never a pass and never a silent
 * re-derivation.
 */
export async function agreeEconomicsAndHandOver(
  env: BoundaryMissionEnv,
  refusal: { command: MissionCommand; refusalIsInconclusive: MissionRefusal },
  approver: ApproverSeat,
  applicationId: Id<"financeApplications">,
  gap: {
    quotationMinor: number;
    firstPaymentMinor: number;
    approvedMinor: number;
    shortfallMinor: number;
    customerShareMinor: number;
    dealerShareMinor: number;
  },
): Promise<void> {
  const { client, orgId } = env;
  const org = orgId as Id<"organizations">;
  const { command, refusalIsInconclusive } = refusal;
  await command(() =>
    client.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: org,
      applicationId,
      submittedQuotationMinor: gap.quotationMinor,
      source: "MANUAL_ENTRY",
      customerFirstPaymentMinor: gap.firstPaymentMinor,
    }),
  );
  await command(() =>
    approver.client.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: org,
      applicationId,
      approvedAmountMinor: gap.approvedMinor,
      basis: "MANUAL",
      notes: "Swarm approval below the quotation.",
    }),
  );

  const gapStamp = await readEconomicsStamp(command, approver, org, applicationId);
  if (gapStamp === null) inconclusive("the product issued no economics stamp for the gap agreement, so the deal cannot proceed");
  const statedGap = customerGapOwedProblem(gap.customerShareMinor);
  if (statedGap !== null) inconclusive(statedGap);
  await attackUncollectableGapRefusal(env, { command, approver, org, applicationId, gapStamp, shortfallMinor: gap.shortfallMinor });
  await refusalIsInconclusive(
    () =>
      approver.client.mutation(api.financingEconomics.resolveAppraisalGap, {
        orgId: org,
        applicationId,
        economicsStamp: gapStamp,
        // The dealership absorbs the whole net shortfall: nothing is owed to it, so the deal can be handed over and closed.
        customerGapShareMinor: 0,
        dealerGapShareMinor: gap.shortfallMinor,
        customerGapCashToDealerMinor: 0,
        customerGapInstallmentToDealerMinor: 0,
        customerGapToFinanceCompanyMinor: 0,
      }),
    `the product refused the gap agreement for the independently derived net shortfall of ${gap.shortfallMinor} (the dealership absorbs all of it)`,
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
}
