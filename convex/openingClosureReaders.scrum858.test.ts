// @vitest-environment node
// SCRUM-858 slice 1 — reconciliation readers for the opening-balance families that had none
// (staff advances, supplier recoverables, partner capital) plus the custom-control payable case.
//
// Owner ruling 2026-10-28 (binding): a difference is REPORTED under the fixed label and NEVER
// "resolved" by posting a journal, plug, clearing line or equity entry. Every tamper test therefore
// asserts that the ledger is byte-for-byte unchanged after the reader ran.
import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { settleScheduledOnly, withFrozenScheduler } from "../test-utils/outboxWork";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  OPENING_DIFFERENCE_WARNING_BY_FAMILY,
  OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY,
} from "./utils/closeWarnings";

const LABEL_EN = "Unexplained opening-balance reconciliation difference";
const LABEL_AR = "فرق أرصدة افتتاحية غير مفسر قيد المطابقة";

// Synthetic balances. Debits 170_000 = advance 100_000 + recoverable 50_000 + custom recoverable 20_000;
// credits 170_000 = capital 80_000 + custom payable 30_000 + retained-earnings offset 60_000.
async function fixture() {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST closure readers", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "closure-owner", email: "owner@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "closure-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const staffRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: staffRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, employeeId };
  });
  const owner = t.withIdentity({ subject: "closure-owner" });
  const { orgId, employeeId } = ids;
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const partnerA = await owner.mutation(api.partnerEquity.add, { orgId, partnerName: "Synthetic A", idempotencyKey: "closure-partner-a" });
  const partnerB = await owner.mutation(api.partnerEquity.add, { orgId, partnerName: "Synthetic B", idempotencyKey: "closure-partner-b" });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const bySystemKey = (key: string) => {
    const row = accounts.find((account) => account.systemKey === key);
    if (!row) throw new Error(`Missing synthetic account ${key}`);
    return row;
  };
  const advances = bySystemKey("EMPLOYEE_ADVANCES");
  const receivable = bySystemKey("RECEIVABLE_FROM_SUPPLIERS");
  const capital = bySystemKey("PARTNER_CAPITAL");
  const retained = bySystemKey("RETAINED_EARNINGS");
  const customAsset = await owner.mutation(api.chartOfAccounts.create, { orgId, code: "1998",
    name: "Synthetic declared recoverable control", type: "ASSET", normalBalance: "DEBIT",
    currencyRestriction: "JOD", isControlAccount: true, allowManualPosting: false });
  const customEquity = await owner.mutation(api.chartOfAccounts.create, { orgId, code: "3998",
    name: "Synthetic explicit capital", type: "EQUITY", normalBalance: "CREDIT" });
  const customLiability = await owner.mutation(api.chartOfAccounts.create, { orgId, code: "1999",
    name: "Synthetic declared payable control", type: "LIABILITY", normalBalance: "CREDIT",
    currencyRestriction: "JOD", isControlAccount: true, allowManualPosting: false });
  const payload = { orgId, expectedCurrency: "JOD", asOfDate,
    lines: [
      { accountId: advances._id, debitMinor: 100_000, creditMinor: 0 },
      { accountId: receivable._id, debitMinor: 50_000, creditMinor: 0 },
      { accountId: customAsset, debitMinor: 20_000, creditMinor: 0 },
      { accountId: capital._id, debitMinor: 0, creditMinor: 50_000 },
      { accountId: customEquity, debitMinor: 0, creditMinor: 30_000 },
      { accountId: customLiability, debitMinor: 0, creditMinor: 30_000 },
      { accountId: retained._id, debitMinor: 0, creditMinor: 60_000 },
    ],
    allocations: [
      { kind: "EMPLOYEE_ADVANCE" as const, rowKey: "adv-1", accountId: advances._id, userId: employeeId,
        amountMinor: 100_000, note: "Synthetic historical remaining debt" },
      { kind: "SUPPLIER_RECOVERABLE" as const, rowKey: "rec-system", accountId: receivable._id, amountMinor: 50_000,
        counterpartyName: "Synthetic supplier", title: "Synthetic system-control claim", purpose: "CLAIM" as const },
      { kind: "SUPPLIER_RECOVERABLE" as const, rowKey: "rec-custom", accountId: customAsset, amountMinor: 20_000,
        counterpartyName: "Synthetic supplier", title: "Synthetic custom-control claim", purpose: "CLAIM" as const },
      { kind: "PARTNER_CAPITAL" as const, rowKey: "cap-a", accountId: capital._id, partnerId: partnerA, amountMinor: 50_000 },
      { kind: "PARTNER_CAPITAL" as const, rowKey: "cap-b", accountId: customEquity, partnerId: partnerB, amountMinor: 30_000 },
      { kind: "OTHER_PAYABLE" as const, rowKey: "pay-custom", accountId: customLiability, amountMinor: 30_000,
        counterpartyName: "Synthetic creditor", title: "Synthetic custom-control obligation" },
    ] };
  await settleScheduledOnly(t, orgId);
  await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload);
  return { t, owner, orgId, partnerA, partnerB, periodId: period._id };
}

type Seed = Awaited<ReturnType<typeof fixture>>;

async function ledger(seed: Seed) {
  return seed.t.run(async (ctx) => ({
    journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(),
    snapshots: await ctx.db.query("accountBalanceSnapshots").collect(),
    events: await ctx.db.query("accountingEvents").collect(),
    pending: await ctx.db.query("pendingAccountingEvents").collect(),
    accounts: await ctx.db.query("chartOfAccounts").collect(),
  }));
}

async function readers(seed: Seed) {
  const { owner, orgId } = seed;
  return {
    advances: await owner.query(api.accountingReports.employeeAdvancesReconciliation, { orgId }),
    recoverables: await owner.query(api.accountingReports.supplierRecoverablesReconciliation, { orgId }),
    partners: await owner.query(api.accountingReports.partnerCapitalReconciliation, { orgId }),
    payables: await owner.query(api.accountingReports.supplierPayablesReconciliation, { orgId }),
  };
}

test("an untampered public opening reconciles on every family, with no difference label", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const result = await readers(seed);
  expect(result.advances.byCurrency.JOD).toMatchObject({ glBalanceMinor: 100_000, subledgerBalanceMinor: 100_000, discrepancyMinor: 0 });
  expect(result.recoverables.byCurrency.JOD).toMatchObject({ glBalanceMinor: 70_000, subledgerBalanceMinor: 70_000, discrepancyMinor: 0 });
  expect(result.partners.byCurrency.JOD).toMatchObject({ glBalanceMinor: 80_000, subledgerBalanceMinor: 80_000, discrepancyMinor: 0 });
  expect(result.payables.byCurrency.JOD).toMatchObject({ glBalanceMinor: 30_000, subledgerBalanceMinor: 30_000, discrepancyMinor: 0 });
  for (const family of Object.values(result)) {
    expect(family).toMatchObject({ status: "AVAILABLE", isReconciled: true, unexplainedOpeningDifference: null });
  }
}));

const tampers: ReadonlyArray<{
  name: string;
  family: "advances" | "recoverables" | "partners" | "payables";
  expectedMinor: number;
  tamper: (seed: Seed) => Promise<unknown>;
}> = [
  { name: "staff advance recovered without a ledger entry", family: "advances", expectedMinor: 1_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = await ctx.db.query("employeeAdvances").first();
      if (!row) throw new Error("Missing opening advance");
      await ctx.db.patch(row._id, { recoveredMinor: 1_000 });
    }) },
  { name: "staff advance soft-deleted", family: "advances", expectedMinor: 100_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = await ctx.db.query("employeeAdvances").first();
      if (!row) throw new Error("Missing opening advance");
      await ctx.db.patch(row._id, { isDeleted: true });
    }) },
  { name: "staff advance marked written off without a ledger entry", family: "advances", expectedMinor: 100_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = await ctx.db.query("employeeAdvances").first();
      if (!row) throw new Error("Missing opening advance");
      await ctx.db.patch(row._id, { status: "WRITTEN_OFF" });
    }) },
  { name: "opening draft header lost while its journal remains (staff advance also part-recovered)", family: "advances", expectedMinor: 1_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const advance = await ctx.db.query("employeeAdvances").first();
      if (!advance) throw new Error("Missing opening advance");
      await ctx.db.patch(advance._id, { recoveredMinor: 1_000 });
      for (const draft of await ctx.db.query("openingBalanceDrafts").collect()) await ctx.db.delete(draft._id);
    }) },
  { name: "opening journal marked REVERSED while its draft remains (staff advance also part-recovered)", family: "advances", expectedMinor: 1_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const advance = await ctx.db.query("employeeAdvances").first();
      const journal = (await ctx.db.query("journalEntries").collect()).find((row) => row.category === "OPENING_BALANCE");
      if (!advance || !journal) throw new Error("Missing opening advance or journal");
      await ctx.db.patch(advance._id, { recoveredMinor: 1_000 });
      await ctx.db.patch(journal._id, { status: "REVERSED" });
    }) },
  { name: "staff advance row deleted", family: "advances", expectedMinor: 100_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = await ctx.db.query("employeeAdvances").first();
      if (!row) throw new Error("Missing opening advance");
      await ctx.db.delete(row._id);
    }) },
  { name: "system-control supplier recoverable partly recovered without a ledger entry", family: "recoverables", expectedMinor: 2_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = (await ctx.db.query("supplierCostRecoveries").collect()).find((r) => r.origin === "OPENING" && r.amountDueMinor === 50_000);
      if (!row) throw new Error("Missing system-control recovery");
      await ctx.db.patch(row._id, { amountRecoveredMinor: 2_000 });
    }) },
  { name: "supplier recoverable marked PARTIALLY_RECOVERED with 2_000 recovered and no ledger entry", family: "recoverables", expectedMinor: 2_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = (await ctx.db.query("supplierCostRecoveries").collect()).find((r) => r.origin === "OPENING" && r.amountDueMinor === 50_000);
      if (!row) throw new Error("Missing system-control recovery");
      await ctx.db.patch(row._id, { amountRecoveredMinor: 2_000, status: "PARTIALLY_RECOVERED" });
    }) },
  { name: "supplier recoverable marked RECOVERED though only 2_000 was recovered", family: "recoverables", expectedMinor: 2_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = (await ctx.db.query("supplierCostRecoveries").collect()).find((r) => r.origin === "OPENING" && r.amountDueMinor === 50_000);
      if (!row) throw new Error("Missing system-control recovery");
      await ctx.db.patch(row._id, { amountRecoveredMinor: 2_000, status: "RECOVERED" });
    }) },
  { name: "custom-control supplier recoverable row deleted", family: "recoverables", expectedMinor: 20_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = (await ctx.db.query("supplierCostRecoveries").collect()).find((r) => r.origin === "OPENING" && r.amountDueMinor === 20_000);
      if (!row) throw new Error("Missing custom-control recovery");
      await ctx.db.delete(row._id);
    }) },
  { name: "partner opening balance raised without a ledger entry", family: "partners", expectedMinor: -700,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const partner = await ctx.db.get(seed.partnerA);
      if (!partner) throw new Error("Missing partner");
      await ctx.db.patch(partner._id, { openingBalanceMinor: (partner.openingBalanceMinor ?? 0) + 700 });
    }) },
  { name: "partner row removed", family: "partners", expectedMinor: 30_000,
    tamper: (seed) => seed.t.run((ctx) => ctx.db.patch(seed.partnerB, { isDeleted: true })) },
  { name: "custom-control payable cancelled without a ledger entry", family: "payables", expectedMinor: 30_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = await ctx.db.query("vehicleSupplierPayables").first();
      if (!row) throw new Error("Missing opening payable");
      await ctx.db.patch(row._id, { status: "CANCELLED" });
    }) },
  { name: "custom-control payable row deleted", family: "payables", expectedMinor: 30_000,
    tamper: (seed) => seed.t.run(async (ctx) => {
      const row = await ctx.db.query("vehicleSupplierPayables").first();
      if (!row) throw new Error("Missing opening payable");
      await ctx.db.delete(row._id);
    }) },
];

async function expectTamperReportedNotPosted({ family, expectedMinor, tamper }: (typeof tampers)[number]) {
  const seed = await fixture();
  await tamper(seed);
  const before = await ledger(seed);
  const result = (await readers(seed))[family];
  expect(result.status).toBe("AVAILABLE");
  expect(result.byCurrency.JOD?.discrepancyMinor).toBe(expectedMinor);
  expect(result.isReconciled).toBe(false);
  expect(result.unexplainedOpeningDifference).toEqual({
    label: { en: LABEL_EN, ar: LABEL_AR },
    currencies: ["JOD"],
  });
  // Owner ruling 2026-10-28: reported, never resolved. No journal, line, snapshot, event or account moved.
  expect(await ledger(seed)).toEqual(before);
}

test.each(tampers)("$name is reported as an unexplained opening difference and nothing is posted", (entry) => withFrozenScheduler(() => expectTamperReportedNotPosted(entry)));

// One literally named, non-parameterized check per family, so each regression-library record can bind
// an exact title (a parameterized title cannot be bound). Same assertions as the table above.
function tamperCase(name: string) {
  const entry = tampers.find((row) => row.name === name);
  if (!entry) throw new Error(`Missing tamper case ${name}`);
  return entry;
}

test("a staff advance recovered without a ledger entry is reported as an unexplained opening difference and nothing is posted", () =>
  withFrozenScheduler(() => expectTamperReportedNotPosted(tamperCase("staff advance recovered without a ledger entry"))));

test("a supplier recoverable row deleted from a custom control is reported as an unexplained opening difference and nothing is posted", () =>
  withFrozenScheduler(() => expectTamperReportedNotPosted(tamperCase("custom-control supplier recoverable row deleted"))));

test("a partner opening balance raised without a ledger entry is reported as an unexplained opening difference and nothing is posted", () =>
  withFrozenScheduler(() => expectTamperReportedNotPosted(tamperCase("partner opening balance raised without a ledger entry"))));

test("a custom-control supplier payable cancelled without a ledger entry is reported as an unexplained opening difference and nothing is posted", () =>
  withFrozenScheduler(() => expectTamperReportedNotPosted(tamperCase("custom-control payable cancelled without a ledger entry"))));

test("a public partner contribution and draw stay reconciled, and a lost draw is reported", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
    orgId: seed.orgId, partnerId: seed.partnerA, type: "CONTRIBUTION", amountMinor: 4_000, paymentMethod: "CASH", idempotencyKey: "closure-contribution",
  });
  await seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
    orgId: seed.orgId, partnerId: seed.partnerA, type: "DRAW", amountMinor: 10_000, paymentMethod: "CASH", idempotencyKey: "closure-draw",
  });
  await settleScheduledOnly(seed.t, seed.orgId);
  const reconciled = (await readers(seed)).partners;
  expect(reconciled).toMatchObject({ status: "AVAILABLE", unexplainedOpeningDifference: null });
  // 80_000 opening + 4_000 contribution - 10_000 draw, on both sides.
  expect(reconciled.byCurrency.JOD).toMatchObject({ glBalanceMinor: 74_000, subledgerBalanceMinor: 74_000, discrepancyMinor: 0 });
  await seed.t.run(async (ctx) => {
    const draw = (await ctx.db.query("partnerEquityTransactions").collect()).find((row) => row.type === "DRAW");
    if (!draw) throw new Error("Missing draw movement");
    await ctx.db.delete(draw._id);
  });
  const before = await ledger(seed);
  const lost = (await readers(seed)).partners;
  // The draw's debit to Partner Drawings is still in the GL; the subledger forgot it.
  expect(lost.byCurrency.JOD).toMatchObject({ glBalanceMinor: 74_000, subledgerBalanceMinor: 84_000, discrepancyMinor: -10_000 });
  expect(lost.unexplainedOpeningDifference?.label.en).toBe(LABEL_EN);
  expect(await ledger(seed)).toEqual(before);
}));

// Ordinary operations with NO opening: the GL control accounts must come from the chart itself,
// not only from an opening's allocations. This is what keeps ordinary (non-opening) flows reconciled.
test("ordinary advances, supplier costs and partner contributions reconcile with no opening at all", () => withFrozenScheduler(async () => {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const { orgId, employeeId } = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST ordinary flows", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "closure-ordinary-owner", email: "owner@example.test" });
    const employeeId = await ctx.db.insert("users", { clerkId: "closure-ordinary-employee", email: "employee@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const staffRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: staffRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, employeeId };
  });
  const owner = t.withIdentity({ subject: "closure-ordinary-owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  if (!period) throw new Error("Missing synthetic period");
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const vehicleId = await t.run((ctx) => ctx.db.insert("vehicles", { orgId, vin: "VINCLOSURE858", make: "Toyota", model: "Camry",
    year: 2024, mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE",
    sourceType: "SOURCED", sourcedFromName: "Synthetic supplier", sourceCost: 9_500 } as never));
  const partnerId = await owner.mutation(api.partnerEquity.add, { orgId, partnerName: "Synthetic ordinary", idempotencyKey: "closure-ordinary-partner" });
  await owner.mutation(api.payroll.recordAdvance, { orgId, userId: employeeId, amount: 25, method: "CASH", idempotencyKey: "closure-ordinary-advance" });
  await owner.mutation(api.expenses.create, { orgId, vehicleId, title: "Synthetic supplier-borne cost", amount: 200,
    date: Date.now() - 60_000, category: "TRANSPORT", status: "PAID", paymentMethod: "CASH", costBearer: "SUPPLIER",
    idempotencyKey: "closure-ordinary-expense" } as never);
  await owner.mutation(api.partnerEquity.recordEquityMovement, { orgId, partnerId, type: "CONTRIBUTION", amountMinor: 4_000,
    paymentMethod: "CASH", idempotencyKey: "closure-ordinary-contribution" });
  await settleScheduledOnly(t, orgId);
  const advances = await owner.query(api.accountingReports.employeeAdvancesReconciliation, { orgId });
  const recoverables = await owner.query(api.accountingReports.supplierRecoverablesReconciliation, { orgId });
  const partners = await owner.query(api.accountingReports.partnerCapitalReconciliation, { orgId });
  expect(advances.byCurrency.JOD).toMatchObject({ glBalanceMinor: 25_000, subledgerBalanceMinor: 25_000, discrepancyMinor: 0 });
  expect(recoverables.byCurrency.JOD).toMatchObject({ glBalanceMinor: 200_000, subledgerBalanceMinor: 200_000, discrepancyMinor: 0 });
  expect(partners.byCurrency.JOD).toMatchObject({ glBalanceMinor: 4_000, subledgerBalanceMinor: 4_000, discrepancyMinor: 0 });
  for (const family of [advances, recoverables, partners]) {
    expect(family).toMatchObject({ status: "AVAILABLE", isReconciled: true, unexplainedOpeningDifference: null });
  }
}));

test("the same difference without any opening history is reported but not labelled an opening difference", () => withFrozenScheduler(async () => {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST no opening", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "closure-no-opening-owner", email: "owner@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    await ctx.db.insert("employeeAdvances", { orgId, userId: ownerId, amountMinor: 5_000, recoveredMinor: 0, currency: "JOD",
      date: Date.now(), status: "OUTSTANDING", createdAt: Date.now(), updatedAt: Date.now() });
    return orgId;
  });
  const owner = t.withIdentity({ subject: "closure-no-opening-owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const result = await owner.query(api.accountingReports.employeeAdvancesReconciliation, { orgId });
  expect(result.byCurrency.JOD?.discrepancyMinor).toBe(-5_000);
  expect(result.unexplainedOpeningDifference).toBeNull();
}));

test.each(["PENDING", "FAILED"] as const)("a %s posting makes the readers unavailable instead of reporting a false difference", (status) => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run(async (ctx) => {
    const owner = await ctx.db.query("users").first();
    if (!owner) throw new Error("Missing synthetic actor");
    await ctx.db.insert("pendingAccountingEvents", {
      orgId: seed.orgId, kind: "POST", status, eventType: "EMPLOYEE_ADVANCE_PAID",
      idempotencyKey: "synthetic-pending", accountingDate: Date.now(), actorId: owner._id,
      sourceType: "employeeAdvances", sourceId: "synthetic", attempts: 0, createdAt: Date.now(),
    });
  });
  const result = await readers(seed);
  for (const family of [result.advances, result.recoverables, result.partners]) {
    expect(family).toMatchObject({ status: "UNAVAILABLE", unavailableReason: "PENDING_POSTINGS", isReconciled: false });
  }
}));

// The close checklist is where finance actually sees these. Warnings are fixed constants because
// the close mutation matches acknowledged warnings verbatim.
const OPENING_WARNING_TEXTS: readonly string[] = [
  ...Object.values(OPENING_DIFFERENCE_WARNING_BY_FAMILY),
  ...Object.values(OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY),
];
const openingWarnings = (warnings: readonly string[]) => warnings.filter((warning) => OPENING_WARNING_TEXTS.includes(warning));

test("the close checklist stays silent for an untampered opening", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(openingWarnings(checklist.warnings)).toEqual([]);
  for (const key of ["employeeAdvancesReconciliation", "supplierRecoverablesReconciliation", "partnerCapitalReconciliation"] as const) {
    expect(checklist[key]).toMatchObject({ status: "AVAILABLE", isReconciled: true });
  }
}));

test.each([
  { name: "advances", family: "EMPLOYEE_ADVANCES" as const, tamper: (seed: Seed) => seed.t.run(async (ctx) => {
    const row = await ctx.db.query("employeeAdvances").first();
    if (!row) throw new Error("Missing advance");
    await ctx.db.patch(row._id, { recoveredMinor: 1_000 });
  }) },
  { name: "supplier recoverables", family: "SUPPLIER_RECOVERABLES" as const, tamper: (seed: Seed) => seed.t.run(async (ctx) => {
    const row = (await ctx.db.query("supplierCostRecoveries").collect()).find((r) => r.origin === "OPENING");
    if (!row) throw new Error("Missing recoverable");
    await ctx.db.patch(row._id, { amountRecoveredMinor: 500 });
  }) },
  { name: "partner capital", family: "PARTNER_CAPITAL" as const, tamper: (seed: Seed) => seed.t.run((ctx) => ctx.db.patch(seed.partnerB, { isDeleted: true })) },
  { name: "supplier payables", family: "SUPPLIER_PAYABLES" as const, tamper: (seed: Seed) => seed.t.run(async (ctx) => {
    const row = await ctx.db.query("vehicleSupplierPayables").first();
    if (!row) throw new Error("Missing opening payable");
    await ctx.db.patch(row._id, { status: "CANCELLED" });
  }) },
])("the close checklist reports a tampered $name opening as an unexplained difference and posts nothing", ({ family, tamper }) => withFrozenScheduler(async () => {
  const seed = await fixture();
  await tamper(seed);
  const before = await ledger(seed);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(openingWarnings(checklist.warnings)).toEqual([OPENING_DIFFERENCE_WARNING_BY_FAMILY[family]]);
  expect(checklist.warnings.some((warning) => warning.startsWith(LABEL_EN))).toBe(true);
  expect(checklist.blockers).toEqual([]);
  expect(await ledger(seed)).toEqual(before);
}));

test("a queued posting makes the close checklist say the opening families could not be reconciled", () => withFrozenScheduler(async () => {
  const seed = await fixture();
  await seed.t.run(async (ctx) => {
    const owner = await ctx.db.query("users").first();
    if (!owner) throw new Error("Missing synthetic actor");
    await ctx.db.insert("pendingAccountingEvents", {
      orgId: seed.orgId, kind: "POST", status: "PENDING", eventType: "EMPLOYEE_ADVANCE_PAID",
      idempotencyKey: "synthetic-pending-checklist", accountingDate: Date.UTC(new Date().getUTCFullYear() + 5, 0, 1), actorId: owner._id,
      sourceType: "employeeAdvances", sourceId: "synthetic", attempts: 0, createdAt: Date.now(),
    });
  });
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.periodId });
  expect(openingWarnings(checklist.warnings)).toEqual(Object.values(OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY));
}));

test("an organization with no opening history gets no opening warning from a queued posting", () => withFrozenScheduler(async () => {
  await import("./accountingOutbox");
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const { orgId, ownerId } = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST no opening checklist", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "closure-no-opening-checklist", email: "owner@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return { orgId, ownerId };
  });
  const owner = t.withIdentity({ subject: "closure-no-opening-checklist" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  if (!period) throw new Error("Missing synthetic period");
  await t.run((ctx) => ctx.db.insert("pendingAccountingEvents", {
    orgId, kind: "POST", status: "PENDING", eventType: "EMPLOYEE_ADVANCE_PAID",
    idempotencyKey: "synthetic-pending-no-opening", accountingDate: Date.UTC(year + 5, 0, 1), actorId: ownerId,
    sourceType: "employeeAdvances", sourceId: "synthetic", attempts: 0, createdAt: Date.now(),
  }));
  const checklist = await owner.query(api.accountingPeriods.closeChecklist, { orgId, periodId: period._id });
  expect(checklist.employeeAdvancesReconciliation.status).toBe("UNAVAILABLE");
  expect(openingWarnings(checklist.warnings)).toEqual([]);
}));