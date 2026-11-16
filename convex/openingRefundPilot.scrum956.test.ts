// @vitest-environment node
/** SCRUM-956 c25206: shipped pilot configuration, public mutations, synthetic data only.
 * convex-test proves transaction logic in its serial harness, not native OCC or pilot certification.
 */
import { beforeAll, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { assertPilotCertifyingConfig } from "../test-utils/pilotConfigParity";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.ts");

beforeAll(() => {
  assertPilotCertifyingConfig();
});

async function seed() {
  const t = convexTestWithComponents(schema, modules);
  const fixture = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic 956 pilot", createdAt: Date.now() });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"] });
    const template = DEFAULT_ROLE_TEMPLATES.find(role => role.name === "OWNER");
    if (!template) throw new Error("Missing owner template");
    const ownerId = await ctx.db.insert("users", { clerkId: "pilot956-owner", email: "owner@example.test" });
    const makerId = await ctx.db.insert("users", { clerkId: "pilot956-maker", email: "maker@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: template.permissions });
    const makerRole = await ctx.db.insert("roles", { orgId, name: "Opening approver", permissions: template.permissions, isSystemOwnerRole: false });
    const ownerMembership = await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: makerId, roleId: makerRole });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Refund" });
    const bankAccountId = await ctx.db.insert("bankAccounts", { orgId, name: "Synthetic USD bank", currency: "USD",
      openingBalanceMinor: 0, openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: true,
      createdBy: ownerId, createdAt: Date.now(), updatedAt: Date.now() });
    return { orgId, ownerId, makerId, ownerMembership, customerId, bankAccountId };
  });
  const owner = t.withIdentity({ subject: "pilot956-owner" });
  const maker = t.withIdentity({ subject: "pilot956-maker" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: fixture.orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, { orgId: fixture.orgId,
    startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: fixture.orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId: fixture.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: fixture.orgId });
  const cash = accounts.find(row => row.systemKey === "CASH_ON_HAND");
  const liability = accounts.find(row => row.systemKey === "CUSTOMER_DEPOSITS_LIABILITY");
  const bankControl = accounts.find(row => row.systemKey === "BANK_ACCOUNT");
  if (!cash || !liability || !bankControl) throw new Error("Missing accounts");
  const { draftId } = await owner.mutation(api.accountingCutover.draftOpeningBalance, {
    orgId: fixture.orgId, expectedCurrency: "USD", asOfDate: Date.now(),
    lines: [{ accountId: cash._id, debitMinor: 10_000, creditMinor: 0 }, { accountId: liability._id, debitMinor: 0, creditMinor: 10_000 }],
    allocations: [{ kind: "CUSTOMER_DEPOSIT", rowKey: "pilot956-deposit", accountId: liability._id,
      customerId: fixture.customerId, amountMinor: 10_000, depositKind: "SECURITY", title: "Synthetic security" }],
  });
  const typedDraftId = await t.run(async ctx => ctx.db.normalizeId("openingBalanceDrafts", draftId));
  if (!typedDraftId) throw new Error("Invalid opening draft identity");
  await maker.mutation(api.accountingCutover.approveOpeningBalance, { orgId: fixture.orgId, draftId: typedDraftId, expectedVersion: 0 });
  const deposit = await t.run(ctx => ctx.db.query("deposits").withIndex("by_org_customer",
    q => q.eq("orgId", fixture.orgId).eq("customerId", fixture.customerId)).unique());
  if (!deposit) throw new Error("Missing approved opening deposit");
  return { t, owner, maker, ...fixture, deposit, periodId: period._id, cashId: cash._id, liabilityId: liability._id, bankControlId: bankControl._id };
}
type Seed = Awaited<ReturnType<typeof seed>>;
const row = (s: Seed) => ({ orgId: s.orgId, depositId: s.deposit._id });
const payout = (s: Seed) => ({ ...row(s), reservationKey: "historical-bank", payoutReference: "SYNTHETIC-OUT-956",
  payoutDate: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()), idempotencyKey: "pilot956-payout" });

async function artifacts(s: Seed) {
  return s.t.run(async ctx => ({
    payments: (await ctx.db.query("canonicalPayments").collect()).length,
    collections: (await ctx.db.query("collectionPayments").collect()).length,
    journals: (await ctx.db.query("journalEntries").collect()).length,
    journalLines: (await ctx.db.query("journalLines").collect()).length,
    financialAudit: (await ctx.db.query("financialAuditLog").collect()).length,
    adminAudit: (await ctx.db.query("adminAuditLog").collect()).length,
    idempotency: (await ctx.db.query("commandIdempotency").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    pending: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    transactions: (await ctx.db.query("transactions").collect()).length,
  }));
}

async function expectCode(call: Promise<unknown>, code: string) {
  let caught: unknown;
  try { await call; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ConvexError);
  if (!(caught instanceof ConvexError)) throw new Error("Expected coded refusal");
  expect(caught.data).toMatchObject({ code });
}

async function historicalBankReservation(s: Seed) {
  await s.t.run(ctx => ctx.db.patch(s.deposit._id, { openingRefundReservation: {
    key: "historical-bank", method: "BANK_TRANSFER", bankAccountId: s.bankAccountId,
    reservedBy: s.ownerId, reservedAt: Date.now(), periodId: s.periodId,
  } }));
}

test("956 pilot refuses bank reservation without writes and cash remains reservable", async () => {
  const s = await seed();
  const before = await artifacts(s);
  await expectCode(s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "BANK_TRANSFER", bankAccountId: s.bankAccountId, idempotencyKey: "bank-reserve" }), "OPENING_REFUND_BANK_PILOT_DISABLED");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(s.deposit);
  const cash = await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "bank-reserve" });
  expect(cash).toEqual({ reservationKey: "bank-reserve" });
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toMatchObject({ status: "HELD", amountMinor: 10_000,
    openingRefundReservation: { method: "CASH", reservedBy: s.ownerId } });
});

test("956 pilot refuses payout from a historical bank reservation without writes", async () => {
  const s = await seed();
  await historicalBankReservation(s);
  const before = await artifacts(s);
  const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
  await expectCode(s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, payout(s)), "OPENING_REFUND_BANK_PILOT_DISABLED");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
});

test("956 pilot cash reservation cannot disguise a bank account without writes", async () => {
  const s = await seed();
  const before = await artifacts(s);
  await expect(s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", bankAccountId: s.bankAccountId, idempotencyKey: "disguised-bank" }))
    .rejects.toThrow("A cash refund cannot name a bank account.");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(s.deposit);
});

test("956 pilot refuses bank return without writes even for a finance owner", async () => {
  const s = await seed();
  // Model a completed pre-pilot bank payout without opening the shipped pilot switch.
  // The ordinary cash command creates a fully posted event, then synthetic fixture I/O
  // supplies the historical bank identity read by the return command.
  const cash = await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "historical-refund" });
  const paid = await s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, { ...payout(s), ...cash });
  await s.t.run(async ctx => {
    const payment = await ctx.db.get(paid.paymentId);
    if (!payment?.accountingEventId) throw new Error("Missing historical payout event");
    const event = await ctx.db.get(payment.accountingEventId);
    if (!event) throw new Error("Missing historical payout");
    await ctx.db.patch(payment._id, { method: "BANK_TRANSFER",
      idempotencyKey: `opening_deposit_refund_transfer_${s.bankAccountId}_SYNTHETIC-OUT-956` });
    await ctx.db.patch(event._id, { payload: { ...event.payload, paymentMethod: "BANK_TRANSFER", bankAccountId: s.bankAccountId } });
    const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", paid.journalEntryId)).collect();
    const outgoing = lines.find(line => line.accountId === s.cashId && line.creditMinor === 10_000);
    if (!outgoing) throw new Error("Missing historical payout credit");
    await ctx.db.patch(outgoing._id, { accountId: s.bankControlId, bankAccountId: s.bankAccountId });
  });
  const statementLineId = await s.t.run(ctx => ctx.db.insert("bankStatementLines", { orgId: s.orgId, bankAccountId: s.bankAccountId,
    statementDate: Date.now(), amountMinor: 10_000, description: "Returned SYNTHETIC-OUT-956 credit RETURN-956",
    status: "UNMATCHED", importBatchId: "synthetic-956", createdBy: s.makerId, createdAt: Date.now() }));
  const before = await artifacts(s);
  const statement = await s.t.run(ctx => ctx.db.get(statementLineId));
  await expectCode(s.owner.mutation(api.openingRefundReturns.recordBankReturn, { orgId: s.orgId, statementLineId,
    originalRefundReference: "SYNTHETIC-OUT-956", bankReturnReference: "RETURN-956", confirmedIndependentBankEvidence: true,
    bankEvidenceReference: "Synthetic bank evidence", idempotencyKey: "bank-return" }), "OPENING_REFUND_BANK_PILOT_DISABLED");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(statementLineId))).toEqual(statement);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toMatchObject({ status: "REFUNDED", refundedAmountMinor: 10_000 });
});

test("956 pilot historical bank reservation stays readable and cancellable to the earlier held state", async () => {
  const s = await seed();
  await historicalBankReservation(s);
  expect(await s.owner.query(api.openingRefundCustody.openingRefundReservation, row(s)))
    .toEqual({ reservationKey: "historical-bank", method: "BANK_TRANSFER", bankAccountName: "Synthetic USD bank" });
  const before = await artifacts(s);
  await s.owner.mutation(api.openingDepositRefunds.cancelOpeningRefundReservation, { ...row(s), reservationKey: "historical-bank",
    confirmedUnpaid: true, reason: "Synthetic bank payout never happened" });
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(s.deposit);
  expect(await s.owner.query(api.openingRefundCustody.openingRefundReservation, row(s))).toBeNull();
  expect(await artifacts(s)).toEqual({ ...before, financialAudit: before.financialAudit + 1 });
});

test("956 pilot cash payout posts literal cents once and replay creates no artifacts", async () => {
  const s = await seed();
  const { reservationKey } = await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "pilot-cash" });
  const request = { ...payout(s), reservationKey };
  const result = await s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, request);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toMatchObject({ status: "REFUNDED", amountMinor: 10_000,
    refundedAmountMinor: 10_000, releasedAmountMinor: 10_000 });
  expect(await s.t.run(ctx => ctx.db.get(result.paymentId))).toMatchObject({ method: "CASH", amountMinor: 10_000, direction: "OUT", status: "SETTLED" });
  expect((await artifacts(s)).payments).toBe(1);
  expect((await artifacts(s)).collections).toBe(1);
  const lines = await s.t.run(ctx => ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", result.journalEntryId)).collect());
  expect(lines).toHaveLength(2);
  expect(lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: s.cashId, debitMinor: 0, creditMinor: 10_000 }),
    expect.objectContaining({ accountId: s.liabilityId, debitMinor: 10_000, creditMinor: 0 }),
  ]));
  const before = await artifacts(s);
  expect(await s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, request)).toEqual(result);
  expect(await artifacts(s)).toEqual(before);
});

async function lostCustody(s: Seed) {
  const membershipId = await s.t.run(async ctx => {
    const userId = await ctx.db.insert("users", { clerkId: "pilot956-prior", email: "prior@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "Prior approver", permissions: [PERMISSIONS.APPROVE_REQUESTS] });
    return ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
  });
  await s.t.withIdentity({ subject: "pilot956-prior" }).mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "old-custody" });
  await s.t.run(ctx => ctx.db.patch(membershipId, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" }));
  return { ...row(s), expectedReservationKey: "old-custody", idempotencyKey: "new-custody",
    confirmedPaymentControlTransferred: true as const, reason: "Synthetic payment control transferred" };
}

test("956 pilot custody recovery succeeds for the genuine owner without moving cents", async () => {
  const s = await seed();
  const request = await lostCustody(s);
  const before = await artifacts(s);
  expect(await s.owner.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, request)).toEqual({ reservationKey: "new-custody" });
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toMatchObject({ status: "HELD", amountMinor: 10_000,
    openingRefundReservation: { reservedBy: s.ownerId, key: "new-custody", method: "CASH" } });
  expect(await artifacts(s)).toEqual({ ...before, financialAudit: before.financialAudit + 1, idempotency: before.idempotency + 1 });
});

test("956 pilot owner can recover and cancel an old bank reservation but cannot pay it", async () => {
  const s = await seed();
  const request = await lostCustody(s);
  await s.t.run(async ctx => {
    const held = await ctx.db.get(s.deposit._id);
    if (!held?.openingRefundReservation) throw new Error("Missing historical custody");
    await ctx.db.patch(s.deposit._id, { openingRefundReservation: {
      ...held.openingRefundReservation, method: "BANK_TRANSFER", bankAccountId: s.bankAccountId,
    } });
  });
  expect(await s.owner.query(api.openingRefundCustody.openingRefundReservation, row(s)))
    .toEqual({ reservationKey: "old-custody", method: "BANK_TRANSFER", canRecover: true });
  await s.owner.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, request);
  const before = await artifacts(s);
  await expectCode(s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, {
    ...payout(s), reservationKey: "new-custody" }), "OPENING_REFUND_BANK_PILOT_DISABLED");
  expect(await artifacts(s)).toEqual(before);
  await s.owner.mutation(api.openingDepositRefunds.cancelOpeningRefundReservation, { ...row(s), reservationKey: "new-custody",
    confirmedUnpaid: true, reason: "Synthetic bank control recovered and no payout made" });
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(s.deposit);
  expect(await artifacts(s)).toEqual({ ...before, financialAudit: before.financialAudit + 1 });
});

test("956 pilot custody recovery refuses every non-owner matrix role without writes", async () => {
  for (const name of ["MANAGER", "SALES", "RECEPTION", "ACCOUNTANT", "SENIOR_ACCOUNTANT", "CUSTOM_ALL"]) {
    const s = await seed();
    const request = await lostCustody(s);
    await s.t.run(async ctx => {
      const template = DEFAULT_ROLE_TEMPLATES.find(role => role.name === (name === "CUSTOM_ALL" ? "OWNER" : name));
      if (!template) throw new Error(`Missing role ${name}`);
      const userId = await ctx.db.insert("users", { clerkId: "pilot956-staff", email: "staff@example.test" });
      const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name, permissions: template.permissions, isSystemOwnerRole: false });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
    });
    const before = await artifacts(s);
    const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
    await expectCode(s.t.withIdentity({ subject: "pilot956-staff" }).mutation(api.openingRefundCustody.recoverOpeningRefundCustody, request), "FORBIDDEN");
    expect(await artifacts(s)).toEqual(before);
    expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
  }
});

test("956 pilot custody recovery refuses impersonation and a foreign owner without writes", async () => {
  const s = await seed();
  const request = await lostCustody(s);
  const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
  const foreign = await s.t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic other org", createdAt: Date.now() });
    const template = DEFAULT_ROLE_TEMPLATES.find(role => role.name === "OWNER");
    if (!template) throw new Error("Missing owner");
    const userId = await ctx.db.insert("users", { clerkId: "pilot956-foreign", email: "foreign@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: template.permissions });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    return { orgId };
  });
  const before = await artifacts(s);
  const other = s.t.withIdentity({ subject: "pilot956-foreign" });
  await expectCode(other.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, request), "UNAUTHORIZED");
  await expect(other.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, { ...request, orgId: foreign.orgId })).rejects.toThrow("Deposit not found.");
  expect(await artifacts(s)).toEqual(before);
  await s.t.run(async ctx => {
    const now = Date.now();
    const impersonationGrantId = await ctx.db.insert("impersonationGrants", { orgId: s.orgId, membershipId: s.ownerMembership,
      actorUserId: s.ownerId, targetUserId: s.makerId, reason: "Synthetic support", grantedAt: now, expiresAt: now + 60_000 });
    await ctx.db.patch(s.ownerMembership, { impersonationGrantId });
  });
  await expect(s.owner.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, request)).rejects.toThrow("An impersonation session cannot recover refund custody.");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
});
