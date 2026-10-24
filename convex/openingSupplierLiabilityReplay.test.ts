/** Synthetic discovery controls, not acceptance of a new opening family.
 * No guide figures/identities, fake sales, historical expenses or payments.
 */
import { expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const template = DEFAULT_ROLE_TEMPLATES.find(role => role.name === "OWNER");
  if (!template) throw new Error("Missing native owner template");
  const { orgId, identity: owner } = await seedOrgWithMember(t, {
    clerkId: "opening_remaining_owner", roleName: "OWNER", permissions: [...template.permissions],
  });
  await t.run(async ctx => {
    const membership = await ctx.db.query("memberships").withIndex("by_org", q => q.eq("orgId", orgId)).first();
    if (!membership) throw new Error("Missing fixture membership");
    await ctx.db.patch(membership.roleId, { isSystemOwnerRole: true });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year, periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const account = (key: string) => {
    const row = accounts.find(candidate => candidate.systemKey === key);
    if (!row) throw new Error("Missing synthetic account " + key);
    return row._id;
  };
  const effects = () => t.run(async ctx => ({
    journals: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    drafts: (await ctx.db.query("openingBalanceDrafts").collect()).length,
    movements: (await ctx.db.query("receiptMovements").collect()).length,
  }));
  return { t, owner, orgId, account, effects };
}

const allocationRequired = [
  { family: "supplier claim", key: "RECEIVABLE_FROM_SUPPLIERS", policy:"SUPPLIER_RECOVERABLE", debit: true },
  { family: "supplier payable", key: "ACCOUNTS_PAYABLE_SUPPLIERS", policy:"SUPPLIER_PAYABLE", debit: false },
  { family: "commission payable", key: "COMMISSION_PAYABLE", policy:"EMPLOYEE_COMMISSION", debit: false },
  { family: "customer deposit with unresolved owners", key: "CUSTOMER_DEPOSITS_LIABILITY", policy:"UNALLOCATED_LIABILITY", debit: false },
  // Jira candidate only: this does not assert that the private guide has this balance.
  { family: "candidate unapplied customer receipt", key: "UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY", policy:"UNSUPPORTED", debit: false },
];

test.each(allocationRequired)("public policy refuses an unallocated $family before any opening effect", async ({ key, debit, policy }) => {
  const { owner, orgId, account, effects } = await fixture();
  const accountId = account(key);
  const policies = await owner.query(api.accountingCutover.listOpeningAccountPolicies, { orgId });
  expect(policies.find(row => row.accountId === accountId)?.policy).toBe(policy);
  const before = await effects();
  await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId, expectedCurrency: "JOD", asOfDate: Date.now(), lines: [
      { accountId, debitMinor: debit ? 100_000 : 0, creditMinor: debit ? 0 : 100_000 },
      // Test-only balancing amount; not classification of a real opening difference.
      { accountId: account("RETAINED_EARNINGS"), debitMinor: debit ? 0 : 100_000, creditMinor: debit ? 100_000 : 0 },
    ],
  })).rejects.toThrow(policy === "UNSUPPORTED" ? /allocation type that is not supported yet/ : /explicitly declared allocation family/);
  expect(await effects()).toEqual(before);
  expect(await owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId })).toBeNull();
});

test.each([
  { family: "recoverable supplier deposit", type: "ASSET" as const, normalBalance: "DEBIT" as const },
  { family: "named other payable", type: "LIABILITY" as const, normalBalance: "CREDIT" as const },
])("a custom $family is also refused rather than silently accepted as ledger-only", async ({ family, type, normalBalance }) => {
  const { owner, orgId, account, effects } = await fixture();
  const customId = await owner.mutation(api.chartOfAccounts.create, {
    orgId, code: "1999", name: "Synthetic " + family, type, normalBalance, currencyRestriction: "JOD",
  });
  expect((await owner.query(api.accountingCutover.listOpeningAccountPolicies, { orgId }))
    .find(row => row.accountId === customId)?.policy).toBe(type === "ASSET" ? "SUPPLIER_RECOVERABLE" : "DECLARED_LIABILITY");
  const debit = normalBalance === "DEBIT";
  const before = await effects();
  await expect(owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId, expectedCurrency: "JOD", asOfDate: Date.now(), lines: [
      { accountId: customId, debitMinor: debit ? 100_000 : 0, creditMinor: debit ? 0 : 100_000 },
      { accountId: account("RETAINED_EARNINGS"), debitMinor: debit ? 0 : 100_000, creditMinor: debit ? 100_000 : 0 },
    ],
  })).rejects.toThrow(/explicitly declared allocation family/);
  expect(await effects()).toEqual(before);
});

test("the same public setup posts a supported cash opening once without fabricating operational rows", async () => {
  const { owner, orgId, account, effects } = await fixture();
  const result = await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId, expectedCurrency: "JOD", asOfDate: Date.now(), lines: [
      { accountId: account("CASH_ON_HAND"), debitMinor: 100_000, creditMinor: 0 },
      { accountId: account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 100_000 },
    ],
  });
  expect(result.journalId).toBeTruthy();
  expect((await effects()).journals).toBe(1);
  expect(await owner.query(api.supplierReceivables.list, { orgId })).toEqual([]);
  expect((await owner.query(api.supplierCostRecoveries.list, { orgId })).items).toEqual([]);
  expect(await owner.query(api.sourcingPayables.list, { orgId })).toEqual([]);
  expect(await owner.query(api.sales.listCommissions, { orgId, paidStatus: "unpaid" })).toEqual([]);
  expect((await owner.query(api.collections.listRetainedCredits, {
    orgId, paginationOpts: { cursor: null, numItems: 10 },
  })).page).toEqual([]);
});


test("manual journal settlement remains explicitly unavailable in the same valid setup", async () => {
  const { owner, orgId, account, effects } = await fixture();
  const before = await effects();
  await expect(owner.mutation(api.financialAudit.createManualJournal, {
    orgId, memo: "Synthetic settlement containment", idempotencyKey: "remaining-family-manual-settlement",
    accountingDate: Date.now(), lines: [
      { accountId: account("CASH_ON_HAND"), debitMinor: 100_000, creditMinor: 0 },
      { accountId: account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 100_000 },
    ],
  })).rejects.toMatchObject({ data: { code: "MANUAL_JOURNALS_DISABLED" } });
  expect(await effects()).toEqual(before);
});

test("a genuine new unapplied receipt remains readable while the new credit payout door refuses", async () => {
  const { t, owner, orgId, effects } = await fixture();
  const customerId = await t.run(ctx => ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Receipt owner" }));
  await owner.mutation(api.collections.recordPayment, {
    orgId, customerId, amount: 25, method: "CASH", paymentDate: Date.now(),
    idempotencyKey: "remaining-family-current-receipt",
  });
  const credits = await owner.query(api.collections.listRetainedCredits, {
    orgId, customerId, paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(credits.page).toHaveLength(1);
  expect(credits.page[0].remainingUnappliedMinor).toBe(25_000);
  const before = await effects();
  await expect(owner.mutation(api.retainedCreditRefunds.requestRetainedCreditRefund, {
    orgId, receiptMovementId: credits.page[0].receiptMovementId, amountMinor: 25_000,
    method: "BANK_TRANSFER", reason: "Synthetic current receipt payout",
  })).rejects.toMatchObject({ data: { code: "CUSTOMER_CREDIT_PAYOUT_DISABLED" } });
  expect(await effects()).toEqual(before);
});
