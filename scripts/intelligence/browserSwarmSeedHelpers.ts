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
 * SCRUM-54 / SCRUM-878: a bank-funded purchase and every bank-transfer payment name the physical bank the money left. This
 * creates the one fresh zero-balance bank, in the organization's own denomination, through the product's command (never a
 * pre-existing bank) on the disposable preview, and returns its id. The caller creates it BEFORE the car that names it and
 * reuses the id for every later payment. The OWNER seat (`env.client`) creates it: the approver may lack MANAGE_FINANCE.
 * `label` names the mission in the bank's name; `refused` completes "the product refused to create the bank ..." and keeps
 * the mission's own INCONCLUSIVE wording, so a refused bank is never a pass.
 */
export function createSwarmBank(
  env: BoundaryMissionEnv,
  refusalIsInconclusive: MissionRefusal,
  currency: string,
  mission: { label: string; refused: string },
): Promise<Id<"bankAccounts">> {
  return refusalIsInconclusive(
    () =>
      env.client.mutation(api.bankAccounts.create, {
        orgId: env.orgId as Id<"organizations">,
        name: `Swarm ${mission.label} bank ${env.nonce}`,
        currency,
        openingBalanceMinor: 0,
        openingBalanceDate: Date.now(),
      }),
    mission.refused,
  );
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

  const served: unknown = await command(() => approver.client.query(api.applications.get, { orgId: org, applicationId }));
  const gapStamp = isRecord(served) && typeof served.economicsStamp === "string" ? served.economicsStamp : null;
  if (gapStamp === null) inconclusive("the product issued no economics stamp for the gap agreement, so the deal cannot proceed");
  await refusalIsInconclusive(
    () =>
      approver.client.mutation(api.financingEconomics.resolveAppraisalGap, {
        orgId: org,
        applicationId,
        economicsStamp: gapStamp,
        customerGapShareMinor: gap.customerShareMinor,
        dealerGapShareMinor: gap.dealerShareMinor,
        customerGapCashToDealerMinor: gap.customerShareMinor,
        customerGapInstallmentToDealerMinor: 0,
        customerGapToFinanceCompanyMinor: 0,
      }),
    `the product refused the gap agreement for the independently derived net shortfall of ${gap.shortfallMinor} (customer ${gap.customerShareMinor}, dealership ${gap.dealerShareMinor})`,
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
