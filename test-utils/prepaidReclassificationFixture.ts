import { makeFunctionReference } from "convex/server";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ReclassPreview, ReclassStatus } from "../convex/openingPrepaidReclassification";
import { convexTestWithComponents, registerRateLimiter } from "./convexTest";

/**
 * SCRUM-961: one synthetic organization shaped like the production case (a posted opening whose single prepaid
 * schedule has one recognised month and an employee-advance amount hidden inside it). Nothing here names a real
 * person or organization; the figures are the owner's, in minor units (1 JOD = 1000).
 */
export type Harness = ReturnType<typeof convexTestWithComponents>;

export interface ReclassLine { userId: Id<"users">; amountMinor: number }
export type RequestArgs = { orgId: Id<"organizations">; scheduleId: Id<"prepaidExpenseSchedules">; lines: ReclassLine[]; reason: string };
export type ApproveArgs = { orgId: Id<"organizations">; reclassificationId: string; expectedTotalMinor: number; expectedTrueUpMinor: number };
export type DismissArgs = { orgId: Id<"organizations">; reclassificationId: string };

export const requestReclass = makeFunctionReference<"mutation", RequestArgs, { reclassificationId: string; version: number }>(
  "openingPrepaidReclassification:requestPrepaidReclassification");
export const approveReclass = makeFunctionReference<"mutation", ApproveArgs,
  { eventId: Id<"accountingEvents">; journalEntryId: Id<"journalEntries">; advanceIds: Id<"employeeAdvances">[]; trueUpMinor: number }>(
  "openingPrepaidReclassification:approvePrepaidReclassification");
export const dismissReclass = makeFunctionReference<"mutation", DismissArgs, null>(
  "openingPrepaidReclassification:dismissPrepaidReclassification");
export const reclassStatus = makeFunctionReference<"query", { orgId: Id<"organizations">; scheduleId: Id<"prepaidExpenseSchedules"> }, ReclassStatus>(
  "openingPrepaidReclassification:prepaidReclassificationStatus");
export const previewReclass = makeFunctionReference<"query", { orgId: Id<"organizations">; scheduleId: Id<"prepaidExpenseSchedules">; totalMinor: number }, ReclassPreview>(
  "openingPrepaidReclassification:previewPrepaidReclassification");
const FINANCE_PAYROLL = ["view:finance", "manage:finance", "view:payroll", "manage:payroll", "view:cost_price", "view:reports"];

/** `splitAtMonth` (1..11) cuts the year into two open periods: January to the month before it, and that month to December. */
export interface SeedOptions { totalMinor?: number; termMonths?: number; recognizedMonths?: number; splitAtMonth?: number }

export async function seedPrepaidReclass(t: Harness, options: SeedOptions = {}) {
  registerRateLimiter(t);
  const totalMinor = options.totalMinor ?? 7_748_000;
  const termMonths = options.termMonths ?? 6;
  const recognizedMonths = options.recognizedMonths ?? 1;
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST SCRUM-961", createdAt: now });
    const otherOrgId = await ctx.db.insert("organizations", { name: "QA TEST SCRUM-961 other", createdAt: now });
    const user = (clerkId: string) => ctx.db.insert("users", { clerkId, email: `${clerkId}@example.test` });
    const ownerId = await user("s961-owner");
    const preparerId = await user("s961-preparer");
    const reviewerId = await user("s961-reviewer");
    const financeOnlyId = await user("s961-finance-only");
    const firstId = await user("s961-first");
    const secondId = await user("s961-second");
    const outsiderId = await user("s961-outsider");
    const payrollViewerId = await user("s961-payroll-viewer");
    const crossOrgAdminId = await user("s961-cross-org-admin");
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const accountantRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: FINANCE_PAYROLL });
    const financeOnlyRole = await ctx.db.insert("roles", { orgId, name: "FINANCE_ONLY", permissions: ["view:finance", "manage:finance", "view:cost_price"] });
    const salesRole = await ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:finance"] });
    // Reads the audit log (manage:finance) and payroll (view:payroll) but does not manage payroll: the widest non-manager.
    const payrollViewerRole = await ctx.db.insert("roles", { orgId, name: "PAYROLL_VIEWER", permissions: ["view:finance", "manage:finance", "view:payroll", "view:cost_price", "view:reports"] });
    const otherRole = await ctx.db.insert("roles", { orgId: otherOrgId, name: "SALES", permissions: ["view:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: preparerId, roleId: accountantRole });
    await ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId: accountantRole });
    await ctx.db.insert("memberships", { orgId, userId: financeOnlyId, roleId: financeOnlyRole });
    await ctx.db.insert("memberships", { orgId, userId: payrollViewerId, roleId: payrollViewerRole });
    // The first beneficiary can also act as a finance and payroll user, so the beneficiary rule has a case to refuse.
    await ctx.db.insert("memberships", { orgId, userId: firstId, roleId: accountantRole });
    await ctx.db.insert("memberships", { orgId, userId: secondId, roleId: salesRole });
    await ctx.db.insert("memberships", { orgId: otherOrgId, userId: outsiderId, roleId: otherRole });
    // Fully authorised (finance and payroll management) in the OTHER organization, and a member of nothing else: only the row ownership check can refuse it.
    const otherAdminRole = await ctx.db.insert("roles", { orgId: otherOrgId, name: "ACCOUNTANT", permissions: FINANCE_PAYROLL });
    await ctx.db.insert("memberships", { orgId: otherOrgId, userId: crossOrgAdminId, roleId: otherAdminRole });
    for (const orgKey of [orgId, otherOrgId]) {
      await ctx.db.insert("subscriptions", { orgId: orgKey, plan: "professional", status: "active", createdAt: now, updatedAt: now });
      await ctx.db.insert("orgSettings", { orgId: orgKey, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    }
    for (const userId of [firstId, secondId]) {
      await ctx.db.insert("employeeCompensation", { orgId, userId, monthlySalaryMinor: 1_000_000, currency: "JOD",
        effectiveFrom: Date.UTC(new Date().getUTCFullYear() - 1, 0, 1), active: true, createdAt: now, updatedAt: now });
    }
    return { orgId, otherOrgId, ownerId, preparerId, reviewerId, financeOnlyId, firstId, secondId, outsiderId, payrollViewerId, crossOrgAdminId };
  });
  const as = (subject: string) => t.withIdentity({ subject });
  const owner = as("s961-owner");
  const preparer = as("s961-preparer");
  const reviewer = as("s961-reviewer");
  const financeOnly = as("s961-finance-only");
  const payrollViewer = as("s961-payroll-viewer");
  const first = as("s961-first");
  const outsider = as("s961-outsider");
  const crossOrgAdmin = as("s961-cross-org-admin");
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const split = options.splitAtMonth;
  const bounds = split === undefined
    ? [[asOfDate, Date.UTC(year, 11, 31, 23, 59, 59, 999)]]
    : [[asOfDate, Date.UTC(year, split, 1) - 1], [Date.UTC(year, split, 1), Date.UTC(year, 11, 31, 23, 59, 59, 999)]];
  for (const [index, [startDate, endDate]] of bounds.entries()) {
    await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate, endDate, fiscalYear: year, periodNumber: index + 1 });
  }
  const periods = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  const [period] = periods;
  if (!period) throw new Error("Missing synthetic period");
  for (const row of periods) await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: row._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const account = (key: string) => {
    const row = accounts.find((candidate) => candidate.systemKey === key);
    if (!row) throw new Error(`Missing system account ${key}`);
    return row._id;
  };
  const prepaid = account("PREPAID_EXPENSES");
  await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate,
    lines: [
      { accountId: prepaid, debitMinor: totalMinor, creditMinor: 0 },
      { accountId: account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: totalMinor },
    ],
    allocations: [{ kind: "PREPAID_EXPENSE" as const, rowKey: "s961-prepaid", accountId: prepaid, amountMinor: totalMinor,
      title: "Synthetic establishment expenses", expenseSystemKey: "GENERAL_EXPENSE", startYearMonth: `${year}-01`, termMonths,
      attestedUnexpiredBenefit: true }] as never });
  const schedule = await t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").unique());
  if (!schedule) throw new Error("Missing synthetic opening schedule");
  const month = (index: number) => `${year}-${String(index + 1).padStart(2, "0")}`;
  const recognize = async (index: number) => t.mutation(internal.prepaidExpenses.amortizePrepaidExpenseForMonth, {
    orgId: ids.orgId, scheduleId: schedule._id, yearMonth: month(index), occurredAt: Date.UTC(year, index, 28), systemActorId: ids.ownerId });
  for (let index = 0; index < recognizedMonths; index++) await recognize(index);
  return { t, ...ids, owner, preparer, reviewer, financeOnly, payrollViewer, first, outsider, crossOrgAdmin, period, periods, year, asOfDate, account,
    scheduleId: schedule._id, month, recognize, totalMinor, termMonths };
}
export type Seed = Awaited<ReturnType<typeof seedPrepaidReclass>>;

/** The Bloom request: 470 and 150 JOD to two people. */
export function bloomLines(s: Seed): ReclassLine[] {
  return [{ userId: s.firstId, amountMinor: 470_000 }, { userId: s.secondId, amountMinor: 150_000 }];
}

export function requestArgs(s: Seed, lines: ReclassLine[] = bloomLines(s), reason = "Employee advances recorded inside the opening prepaid schedule"): RequestArgs {
  return { orgId: s.orgId, scheduleId: s.scheduleId, lines, reason };
}

/** Request as the preparer and return the figures the approver's screen shows. */
export async function requestAndPreview(s: Seed, lines: ReclassLine[] = bloomLines(s)) {
  const { reclassificationId } = await s.preparer.mutation(requestReclass, requestArgs(s, lines));
  const status = await s.reviewer.query(reclassStatus, { orgId: s.orgId, scheduleId: s.scheduleId });
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  return { reclassificationId, expectedTotalMinor: total, expectedTrueUpMinor: status.pending?.trueUpMinor ?? 0 };
}

export function approveArgs(s: Seed, request: Awaited<ReturnType<typeof requestAndPreview>>): ApproveArgs {
  return { orgId: s.orgId, reclassificationId: request.reclassificationId, expectedTotalMinor: request.expectedTotalMinor,
    expectedTrueUpMinor: request.expectedTrueUpMinor };
}

async function every(s: Seed, table: string): Promise<unknown[]> {
  return s.t.run((ctx) => (ctx.db as unknown as { query(name: string): { collect(): Promise<unknown[]> } }).query(table).collect());
}

/** Every table a reclassification may touch, for "nothing was written" and "nothing else moved" assertions. */
export async function ledgerState(s: Seed) {
  const tables = ["journalEntries", "journalLines", "accountingEvents", "accountBalanceSnapshots", "employeeAdvances",
    "prepaidExpenseSchedules", "financialAuditLog", "pendingAccountingEvents", "openingBalanceDrafts", "partnerEquity",
    "openingPrepaidReclassifications"];
  const entries = await Promise.all(tables.map(async (table) => [table, await every(s, table)] as const));
  return Object.fromEntries(entries);
}

/** The refusal code of a rejected call, or undefined when it succeeded. */
export async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? `UNCODED:${String(error)}`;
  }
  return undefined;
}
