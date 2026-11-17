// @vitest-environment node
/** SCRUM-956 c25206: shipped pilot configuration, public mutations, synthetic data only.
 * convex-test proves transaction logic in its serial harness, not native OCC or pilot certification.
 */
import { beforeAll, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { assertPilotCertifyingConfig } from "../test-utils/pilotConfigParity";
import schema from "./schema";
import { api } from "./_generated/api";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.ts");

// Like socialContactProvenance, warm lazy UDF/component modules in suite setup.
// The source-parity scan and a cold seed take seconds on a loaded Windows host;
// allow 30s for this one-time work, retaining the default 5s test deadline.
// No fixture escapes setup: every test still seeds its own complete database.
beforeAll(async () => {
  assertPilotCertifyingConfig();
  await seed();
  await import("./openingDepositRefunds");
}, 30_000);

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
  return { t, owner, maker, ...fixture, deposit, draftId: typedDraftId, periodId: period._id,
    cashId: cash._id, liabilityId: liability._id, bankControlId: bankControl._id };
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
  const audits = await s.t.run(ctx => ctx.db.query("financialAuditLog").collect());
  expect(audits.filter(entry => entry.resourceId === s.deposit._id && entry.description === "Opening deposit refund paid"))
    .toMatchObject([{
      orgId: s.orgId, actorId: s.ownerId, actionType: "RESOLVE_DEPOSIT_ALLOCATION",
      before: { status: "HELD", reservationKey },
      after: { status: "REFUNDED", paymentId: result.paymentId, journalEntryId: result.journalEntryId, payoutDate: request.payoutDate },
    }]);
  const lines = await s.t.run(ctx => ctx.db.query("journalLines").withIndex("by_journal_entry", q => q.eq("journalEntryId", result.journalEntryId)).collect());
  expect(lines).toHaveLength(2);
  expect(lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountId: s.cashId, debitMinor: 0, creditMinor: 10_000 }),
    expect.objectContaining({ accountId: s.liabilityId, debitMinor: 10_000, creditMinor: 0 }),
  ]));
  const before = await artifacts(s);
  expect(await s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, request)).toEqual(result);
  await expect(s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, {
    ...request, payoutReference: "DIFFERENT-RECEIPT",
  })).rejects.toThrow("Idempotency key reused with different request content.");
  expect(await artifacts(s)).toEqual(before);
});

test("956 the opening approver can reserve, cancel unpaid, and settle a new cash reservation", async () => {
  const s = await seed();
  expect(s.deposit.createdBy).toBe(s.makerId);
  const reservation = await s.maker.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "opening-approver-reserve",
  });
  await expect(s.maker.query(api.openingRefundCustody.openingRefundReservation, row(s))).resolves.toMatchObject(reservation);
  const before = await artifacts(s);
  await s.maker.mutation(api.openingDepositRefunds.cancelOpeningRefundReservation, {
    ...row(s), ...reservation, confirmedUnpaid: true, reason: "No cash was handed over",
  });
  expect((await artifacts(s)).payments).toBe(before.payments);
  const next = await s.maker.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "opening-approver-reserve-next",
  });
  const paid = await s.maker.mutation(api.openingDepositRefunds.recordOpeningRefund, { ...payout(s), ...next });
  expect(await s.t.run(ctx => ctx.db.get(paid.paymentId))).toMatchObject({ amountMinor: 10_000, method: "CASH", direction: "OUT" });
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toMatchObject({ status: "REFUNDED", resolvedBy: s.makerId });
});

test.each([
  ["before reservation", Date.UTC(2026, 5, 9), "The payout date cannot be before the refund was reserved."],
  ["after today", Date.UTC(2026, 5, 11), "Enter a valid refund date on or before today."],
  ["not a calendar day", Date.UTC(2026, 5, 10, 1), "Enter a valid refund date on or before today."],
] as const)("956 cash payout refuses a date %s without writes", async (_case, payoutDate, message) => {
  vi.useFakeTimers({ now: Date.UTC(2026, 5, 8, 12), toFake: ["Date"] });
  try {
    const s = await seed();
    vi.setSystemTime(Date.UTC(2026, 5, 10, 12));
    const { reservationKey } = await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
      ...row(s), method: "CASH", idempotencyKey: "cash-date",
    });
    const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
    const before = await artifacts(s);
    await expect(s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, {
      ...payout(s), reservationKey, payoutDate,
    })).rejects.toThrow(message);
    expect(await artifacts(s)).toEqual(before);
    expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
  } finally {
    vi.useRealTimers();
  }
});

test("956 a closed accounting period refuses a new cash refund reservation without writes", async () => {
  const s = await seed();
  const period = { orgId: s.orgId, periodId: s.periodId };
  const checklist = await s.owner.query(api.accountingPeriods.closeChecklist, period);
  await s.owner.mutation(api.accountingPeriods.close, {
    ...period, acknowledgedWarnings: checklist.warnings, overrideReason: "Synthetic close before reservation",
  });

  const before = await artifacts(s);
  await expect(s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "closed-cash-period",
  })).rejects.toThrow(/period/i);
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(s.deposit);
});

test("956 across organizations the same custodian cannot pay, cancel or read a reserved deposit", async () => {
  const s = await seed();
  const { reservationKey } = await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "foreign-refund-input",
  });
  const orgId = await s.t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic foreign custody input", createdAt: Date.now() });
    const roleId = await ctx.db.insert("roles", { orgId, name: "Other org approver", permissions: [PERMISSIONS.APPROVE_REQUESTS] });
    await ctx.db.insert("memberships", { orgId, roleId, userId: s.ownerId });
    return orgId;
  });
  const foreign = { orgId, depositId: s.deposit._id };
  const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
  const before = await artifacts(s);

  await expect(s.owner.mutation(api.openingDepositRefunds.recordOpeningRefund, {
    ...payout(s), ...foreign, reservationKey,
  })).rejects.toThrow("Deposit not found.");
  await expect(s.owner.mutation(api.openingDepositRefunds.cancelOpeningRefundReservation, {
    ...foreign, reservationKey, confirmedUnpaid: true, reason: "Synthetic cancellation",
  })).rejects.toThrow("Deposit not found.");
  await expect(s.owner.query(api.openingRefundCustody.openingRefundReservation, foreign))
    .rejects.toThrow("Deposit not found.");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
});

test("956 a second approver who knows the key cannot settle or cancel another custodian's reservation", async () => {
  const s = await seed();
  const { reservationKey } = await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "holder-only",
  });
  const other = await s.t.run(async ctx => {
    const subject = "pilot956-other-approver";
    const userId = await ctx.db.insert("users", { clerkId: subject, email: "other-approver@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "Second approver", permissions: [PERMISSIONS.APPROVE_REQUESTS] });
    await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
    return subject;
  });
  const approver = s.t.withIdentity({ subject: other });
  const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
  const before = await artifacts(s);

  await expect(approver.mutation(api.openingDepositRefunds.recordOpeningRefund, {
    ...payout(s), reservationKey,
  })).rejects.toThrow(/only the approver holding the active opening refund reservation/i);
  await expect(approver.mutation(api.openingDepositRefunds.cancelOpeningRefundReservation, {
    ...row(s), reservationKey, confirmedUnpaid: true, reason: "Synthetic cancellation",
  })).rejects.toThrow(/only the approver holding the active opening refund reservation/i);
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
});

test("956 an opening with a refund reserved cannot be voided", async () => {
  const s = await seed();
  await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "protect-opening-void",
  });
  const opening = await s.t.run(ctx => ctx.db.get(s.draftId));
  const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
  const before = await artifacts(s);

  await expectCode(s.owner.mutation(api.openingBalanceMaintenance.requestVoid, {
    orgId: s.orgId, draftId: s.draftId, reason: "Synthetic opening void while custody is pending",
  }), "OPENING_VOID_CONFLICT");
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.draftId))).toEqual(opening);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);
});

async function reserveForPriorApprover(s: Seed) {
  const subject = "pilot956-prior";
  const { membershipId, roleId, userId } = await s.t.run(async ctx => {
    const userId = await ctx.db.insert("users", { clerkId: subject, email: "prior@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "Prior approver", permissions: [PERMISSIONS.APPROVE_REQUESTS] });
    const membershipId = await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
    return { membershipId, roleId, userId };
  });
  const actor = s.t.withIdentity({ subject });
  const { reservationKey } = await actor.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "old-custody" });
  const request = { ...row(s), expectedReservationKey: reservationKey, idempotencyKey: "new-custody",
    confirmedPaymentControlTransferred: true as const, reason: "Synthetic payment control transferred" };
  return { actor, membershipId, roleId, userId, reservationKey, request };
}

async function lostCustody(s: Seed) {
  const { membershipId, request } = await reserveForPriorApprover(s);
  await s.t.run(ctx => ctx.db.patch(membershipId, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" }));
  return request;
}

test.each(["missing role", "deleted role", "foreign role", "disabled user"] as const)("956 a custodian with a %s loses refund authority across custody, read and payout", async invalid => {
  const s = await seed();
  const prior = await reserveForPriorApprover(s);
  await expect(s.owner.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, prior.request))
    .rejects.toThrow(/still has refund authority/);
  await s.t.run(async ctx => {
    if (invalid === "missing role") {
      await ctx.db.delete(prior.roleId);
    } else if (invalid === "deleted role") {
      await ctx.db.patch(prior.roleId, { isDeleted: true });
    } else if (invalid === "disabled user") {
      await ctx.db.patch(prior.userId, { disabled: true });
    } else {
      const orgId = await ctx.db.insert("organizations", { name: "Synthetic foreign role", createdAt: Date.now() });
      const roleId = await ctx.db.insert("roles", { orgId, name: "Foreign approver", permissions: [PERMISSIONS.APPROVE_REQUESTS] });
      await ctx.db.patch(prior.membershipId, { roleId });
    }
  });
  const held = await s.t.run(ctx => ctx.db.get(s.deposit._id));
  const before = await artifacts(s);
  await expect(s.owner.query(api.openingRefundCustody.openingRefundReservation, row(s)))
    .resolves.toMatchObject({ canRecover: true, reservationKey: prior.reservationKey });
  const priorRead = prior.actor.query(api.openingRefundCustody.openingRefundReservation, row(s));
  if (invalid === "missing role" || invalid === "disabled user") await expect(priorRead).rejects.toThrow(/membership role|disabled/i);
  else await expect(priorRead).resolves.toBeNull();
  await expect(prior.actor.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "invalid-role-reservation",
  })).rejects.toThrow(/refund authority|membership role|disabled/i);
  await expect(prior.actor.mutation(api.openingDepositRefunds.recordOpeningRefund, {
    ...payout(s), reservationKey: prior.reservationKey,
  })).rejects.toThrow(/refund authority|membership role|disabled/i);
  await expect(prior.actor.mutation(api.openingDepositRefunds.cancelOpeningRefundReservation, {
    ...row(s), reservationKey: prior.reservationKey, reason: "Synthetic cancellation", confirmedUnpaid: true,
  })).rejects.toThrow(/refund authority|membership role|disabled/i);
  expect(await artifacts(s)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toEqual(held);

  const recovery = await s.owner.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, prior.request);
  expect(recovery).toEqual({ reservationKey: "new-custody" });
  expect(await s.owner.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, prior.request)).toEqual(recovery);
  expect(await artifacts(s)).toEqual({ ...before, financialAudit: before.financialAudit + 1, idempotency: before.idempotency + 1 });
});

test("956 the opening approver can recover lost custody when they are a genuine Owner", async () => {
  const s = await seed();
  const request = await lostCustody(s);
  expect(s.deposit.createdBy).toBe(s.makerId);
  await expect(s.maker.query(api.openingRefundCustody.openingRefundReservation, row(s))).resolves.toBeNull();
  await s.t.run(async ctx => {
    const membership = await ctx.db.query("memberships")
      .withIndex("by_org_user", q => q.eq("orgId", s.orgId).eq("userId", s.makerId)).unique();
    if (!membership) throw new Error("Missing opening deposit creator membership");
    await ctx.db.patch(membership.roleId, { isSystemOwnerRole: true });
  });
  const before = await artifacts(s);
  await expect(s.maker.query(api.openingRefundCustody.openingRefundReservation, row(s)))
    .resolves.toMatchObject({ canRecover: true, reservationKey: request.expectedReservationKey });
  await expect(s.maker.mutation(api.openingRefundCustody.recoverOpeningRefundCustody, request))
    .resolves.toEqual({ reservationKey: "new-custody" });
  expect(await artifacts(s)).toEqual({ ...before, financialAudit: before.financialAudit + 1, idempotency: before.idempotency + 1 });
  expect(await s.t.run(ctx => ctx.db.get(s.deposit._id))).toMatchObject({ status: "HELD",
    openingRefundReservation: { key: "new-custody", reservedBy: s.makerId } });
});

test.each(["hard delete", "archive"] as const)("956 admin %s refuses a customer with a reserved opening refund", async action => {
  const s = await seed();
  await s.owner.mutation(api.openingDepositRefunds.reserveOpeningRefund, {
    ...row(s), method: "CASH", idempotencyKey: "protect-admin-customer",
  });
  const readState = () => s.t.run(async ctx => ({
    customer: await ctx.db.get(s.customerId), deposit: await ctx.db.get(s.deposit._id),
  }));
  const before = await readState();
  const beforeArtifacts = await artifacts(s);
  vi.stubEnv("SUPER_ADMIN_EMAILS", "owner@example.test");
  try {
    const target = { table: "customers", id: s.customerId };
    const operation = action === "hard delete"
      ? s.owner.mutation(api.adminData.adminHardDelete, target)
      : s.owner.mutation(api.adminData.adminUpdateRecord, { ...target, patch: { isDeleted: true } });
    await expect(operation).rejects.toThrow(/held opening deposits/i);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(await readState()).toEqual(before);
  expect(await artifacts(s)).toEqual(beforeArtifacts);
});

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
