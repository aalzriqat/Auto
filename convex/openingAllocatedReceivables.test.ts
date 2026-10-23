import { expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import { quiesceScheduler, settleScheduledOnly, withFrozenScheduler } from "../test-utils/outboxWork";

// Explicit synthetic allocations, not the owner's real guide or a balancing
// ruling. This slice cannot certify the other opening families or onboarding UI.
async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST allocated opening", createdAt: Date.now() });
    const ownerId = await ctx.db.insert("users", { clerkId: "allocated-owner", email: "owner@example.test" });
    const approverId = await ctx.db.insert("users", { clerkId: "allocated-approver", email: "approver@example.test" });
    const ownerRole = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    const financeRole = await ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: ["view:finance", "manage:finance", "approve:requests"] });
    await ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRole });
    await ctx.db.insert("memberships", { orgId, userId: approverId, roleId: financeRole });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    const customerA = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "A" });
    const customerB = await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "B" });
    return { orgId, customerA, customerB, ownerId };
  });
  const owner = t.withIdentity({ subject: "allocated-owner" });
  const approver = t.withIdentity({ subject: "allocated-approver" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const period = (await owner.query(api.accountingPeriods.list, { orgId: ids.orgId }))[0];
  if (!period) throw new Error("Missing fixture period");
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId, activeOnly: true });
  const ar = accounts.find((account) => account.systemKey === "ACCOUNTS_RECEIVABLE_CUSTOMERS");
  const retained = accounts.find((account) => account.systemKey === "RETAINED_EARNINGS");
  if (!ar || !retained) throw new Error("Missing fixture control accounts");
  const payload = { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate,
    lines: [{ accountId: ar._id, debitMinor: 350_000, creditMinor: 0 }, { accountId: retained._id, debitMinor: 0, creditMinor: 350_000 }],
    allocations: [
      { kind: "CUSTOMER_RECEIVABLE" as const, rowKey: "customer-a", accountId: ar._id, customerId: ids.customerA,
        amountMinor: 100_000, title: "Synthetic historical A", dueDate: asOfDate },
      { kind: "CUSTOMER_RECEIVABLE" as const, rowKey: "customer-b", accountId: ar._id, customerId: ids.customerB,
        amountMinor: 250_000, title: "Synthetic historical B", dueDate: asOfDate },
    ] };
  return { t, owner, approver, ...ids, asOfDate, payload, period };
}

async function financialState(seed: Awaited<ReturnType<typeof fixture>>) {
  return seed.t.run(async (ctx) => ({ drafts: await ctx.db.query("openingBalanceDrafts").collect(),
    journals: await ctx.db.query("journalEntries").collect(), lines: await ctx.db.query("journalLines").collect(),
    events: await ctx.db.query("accountingEvents").collect(), pending: await ctx.db.query("pendingAccountingEvents").collect(),
    legacy: await ctx.db.query("receivables").collect(), canonical: await ctx.db.query("receivableDocuments").collect(),
    snapshots: await ctx.db.query("accountBalanceSnapshots").collect(),
    approvals: await ctx.db.query("collectionApprovalRequests").collect(),
    commands: await ctx.db.query("commandIdempotency").collect(),
    payments: await ctx.db.query("collectionPayments").collect(),
    canonicalPayments: await ctx.db.query("canonicalPayments").collect(),
    paymentAllocations: await ctx.db.query("paymentAllocations").collect() }));
}

test("posted readback keeps the immutable allocated amount even when live receivable changes", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const initial = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(initial).toMatchObject({ journalStatus: "POSTED", currency: "JOD" });
  expect(initial?.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ rowKey: "customer-a", kind: "CUSTOMER_RECEIVABLE",
      amountMinor: 100_000, partyId: seed.customerA, recordAvailable: true }),
  ]));
  const receivable = (await financialState(seed)).legacy.find((row) => row.customerId === seed.customerA);
  if (!receivable) throw new Error("Missing synthetic opening receivable");
  await seed.t.run((ctx) => ctx.db.patch(receivable._id, { originalAmount: 1 }));
  const changed = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(changed?.rows.find((row) => row.rowKey === "customer-a")?.amountMinor).toBe(100_000);
  await seed.t.run((ctx) => ctx.db.patch(receivable._id, { canonicalReceivableDocumentId: undefined }));
  const brokenLink = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(brokenLink?.rows.find((row) => row.rowKey === "customer-a")?.recordAvailable).toBe(false);
});

test("opening AR refuses a receipt effective before its posted basis", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const priorYear = new Date(seed.asOfDate).getUTCFullYear() - 1;
  const priorDate = seed.asOfDate - 86_400_000;
  await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId,
    startDate: Date.UTC(priorYear, 0, 1), endDate: priorDate,
    fiscalYear: priorYear, periodNumber: 1 });
  const priorPeriod = (await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId }))
    .find((period) => period.fiscalYear === priorYear);
  if (!priorPeriod) throw new Error("Missing synthetic prior period");
  await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: priorPeriod._id });
  const debt = (await financialState(seed)).legacy.find((row) => row.customerId === seed.customerA);
  if (!debt) throw new Error("Missing synthetic opening debt");
  const early = {
    orgId: seed.orgId, receivableId: debt._id, customerId: debt.customerId, amount: 40,
    method: "CASH", paymentDate: priorDate, idempotencyKey: "opening-prior-receipt",
  } as const;
  const before = await financialState(seed);
  await expect(seed.owner.mutation(api.collections.recordPayment, early)).rejects.toThrow("cannot precede");
  await expect(seed.owner.mutation(api.collections.recordPayment, early)).rejects.toThrow("cannot precede");
  await expect(seed.owner.mutation(api.collections.recordPayment,
    { ...early, paymentDate: Number.NaN, idempotencyKey: "opening-invalid-date" })).rejects.toThrow("finite timestamp");
  expect(await financialState(seed)).toEqual(before);
  const historical = await seed.owner.query(api.accountingReports.subledgerReconciliation,
    { orgId: seed.orgId, toDate: priorDate });
  expect(historical.byCurrency.JOD?.discrepancyMinor ?? 0).toBe(0);
  const snapshot = await seed.owner.query(api.accountingReports.trialBalance,
    { orgId: seed.orgId, toDate: priorDate });
  expect(snapshot.rows.find((row) => row.accountId === seed.payload.lines[0].accountId)?.netMinor ?? 0).toBe(0);
  await seed.t.run((ctx) => ctx.db.patch(debt._id, { openingBalanceDraftId: undefined }));
  const markerRemoved = await financialState(seed);
  await expect(seed.owner.mutation(api.collections.recordPayment,
    { ...early, idempotencyKey: "opening-prior-marker-removed" })).rejects.toThrow("cannot precede");
  await expect(seed.owner.mutation(api.collections.requestApproval, { orgId: seed.orgId,
    receivableId: debt._id, requestType: "CANCEL_RECEIVABLE",
    reason: "Synthetic opening correction refusal" })).rejects.toThrow("separate finance review");
  expect(await financialState(seed)).toEqual(markerRemoved);
  await withFrozenScheduler(async () => seed.owner.mutation(api.collections.recordPayment,
    { ...early, paymentDate: seed.asOfDate, idempotencyKey: "opening-on-basis" }));
  const after = await financialState(seed);
  expect(after.payments).toHaveLength(before.payments.length + 1);
  expect((await seed.owner.query(api.accountingReports.trialBalance,
    { orgId: seed.orgId, toDate: priorDate })).rows
    .find((row) => row.accountId === seed.payload.lines[0].accountId)?.netMinor ?? 0).toBe(0);
});

test("opening AR cheque clearance refuses a date before its basis", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const debt = (await financialState(seed)).legacy.find((row) => row.customerId === seed.customerA);
  if (!debt) throw new Error("Missing synthetic opening debt");
  const bankAccountId = await seed.owner.mutation(api.bankAccounts.create, { orgId: seed.orgId,
    name: "Synthetic receipt bank", currency: "JOD", openingBalanceMinor: 0,
    openingBalanceDate: seed.asOfDate });
  const chequeId = await seed.owner.mutation(api.collections.registerCheque, { orgId: seed.orgId,
    receivableId: debt._id, customerId: seed.customerA, bank: "Synthetic Bank",
    chequeNumber: "SYN-OPEN-1", chequeDate: seed.asOfDate, amount: 40 });
  const before = await financialState(seed);
  const early = { orgId: seed.orgId, chequeId, bankAccountId,
    clearedAt: seed.asOfDate - 1, idempotencyKey: "opening-early-clear" };
  await expect(seed.owner.mutation(api.collections.clearCheque, early)).rejects.toThrow("cannot precede");
  await expect(seed.owner.mutation(api.collections.clearCheque, early)).rejects.toThrow("cannot precede");
  const clock = vi.spyOn(Date, "now").mockReturnValue(seed.asOfDate - 1);
  try {
    await expect(seed.owner.mutation(api.collections.clearCheque, { orgId: seed.orgId,
      chequeId, bankAccountId, idempotencyKey: "opening-omitted-early-clear" })).rejects.toThrow("cannot precede");
  } finally { clock.mockRestore(); }
  expect(await financialState(seed)).toEqual(before);
  expect((await seed.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("HELD");
  await withFrozenScheduler(async () => seed.owner.mutation(api.collections.clearCheque,
    { ...early, clearedAt: seed.asOfDate, idempotencyKey: "opening-on-basis-clear" }));
  expect((await financialState(seed)).payments).toHaveLength(before.payments.length + 1);
});

test("opening AR retained-credit application refuses a date before its basis", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const debt = (await financialState(seed)).legacy.find((row) => row.customerId === seed.customerA);
  if (!debt) throw new Error("Missing synthetic opening debt");
  await withFrozenScheduler(async () => seed.owner.mutation(api.collections.recordPayment, {
    orgId: seed.orgId, customerId: seed.customerA, amount: 40, method: "CASH",
    paymentDate: seed.asOfDate, idempotencyKey: "opening-retained-source",
  }));
  const [movement] = await seed.t.run((ctx) => ctx.db.query("receiptMovements").collect());
  if (!movement) throw new Error("Missing synthetic retained receipt");
  const before = await financialState(seed);
  const early = { orgId: seed.orgId, receiptMovementId: movement._id, receivableId: debt._id,
    requestedAmount: 40, appliedAt: seed.asOfDate - 1, idempotencyKey: "opening-early-application" };
  await expect(seed.owner.mutation(api.collections.applyRetainedCredit, early)).rejects.toThrow("cannot precede");
  expect(await financialState(seed)).toEqual(before);
  await withFrozenScheduler(async () => seed.owner.mutation(api.collections.applyRetainedCredit,
    { ...early, appliedAt: seed.asOfDate, idempotencyKey: "opening-on-basis-application" }));
  expect((await financialState(seed)).legacy.find((row) => row._id === debt._id)?.outstandingAmount).toBe(60);
});

test("legacy duplicate AR mapping refuses before opening writes", async () => {
  const seed = await fixture();
  const duplicate = await seed.t.run((ctx) => ctx.db.insert("chartOfAccounts", {
    orgId: seed.orgId, code: "QA-DUPLICATE-AR", name: "Synthetic legacy AR duplicate",
    type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, allowManualPosting: false,
    active: true, systemKey: "ACCOUNTS_RECEIVABLE_CUSTOMERS", createdAt: Date.now(), updatedAt: Date.now(),
  }));
  const payload = { ...seed.payload,
    lines: seed.payload.lines.map((line, index) => index === 0 ? { ...line, accountId: duplicate } : line),
    allocations: seed.payload.allocations.map((row) => ({ ...row, accountId: duplicate })),
  };
  const before = await financialState(seed);
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload))
    .rejects.toThrow("Opening receivables must use the account used by native collections.");
  expect(await financialState(seed)).toEqual(before);
});

test.each(["DIRECT", "PREPARE", "APPROVE"] as const)("opening rechecks account currency restriction at %s without writes", async (route) => {
  const seed = await fixture();
  let draftId;
  if (route === "APPROVE") {
    await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
    const draft = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
    if (!draft) throw new Error("Missing prepared opening");
    draftId = draft._id;
  }
  // Use the actual chart management door, including a change after preparation.
  await seed.owner.mutation(api.chartOfAccounts.update, {
    orgId: seed.orgId, accountId: seed.payload.lines[0].accountId, currencyRestriction: "USD",
  });
  const before = await financialState(seed);
  const result = route === "DIRECT"
    ? seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload)
    : route === "PREPARE"
      ? seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload)
      : seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draftId! });
  await expect(result).rejects.toThrow("An opening account uses a different currency.");
  expect(await financialState(seed)).toEqual(before);
});

test.each(["DIRECT", "TWO_PERSON"] as const)("%s opening creates explicitly allocated native AR once, including historical as-of readback", async (route) => {
  const seed = await fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    if (route === "DIRECT") await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
    else {
      await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
      const pending = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
      if (!pending) throw new Error("Missing prepared allocation draft");
      await seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: pending._id });
    }
  } finally { clock.mockRestore(); }
  const state = await financialState(seed);
  expect(state.journals).toHaveLength(1);
  expect(state.lines).toHaveLength(2);
  expect(state.events).toHaveLength(0);
  expect(state.pending).toHaveLength(0);
  expect(state.legacy).toHaveLength(2);
  expect(state.canonical).toHaveLength(2);
  expect(new Set(state.canonical.map((row) => row.documentNumber)).size).toBe(2);
  expect(state.drafts[0]).toMatchObject({ status: "POSTED", allocations: seed.payload.allocations,
    autoApproved: route === "DIRECT" });
  for (const row of state.legacy) {
    expect(row).toMatchObject({ openingBalanceDraftId: state.drafts[0]._id });
    expect(state.canonical.filter((canonical) => canonical.sourceType === "legacy_receivable" && canonical.sourceId === row._id))
      .toHaveLength(1);
    expect(state.canonical.find((canonical) => canonical._id === row.canonicalReceivableDocumentId))
      .toMatchObject({ sourceType: "legacy_receivable", sourceId: row._id, customerId: row.customerId,
        issueDate: seed.asOfDate, currency: "JOD", originalAmountMinor: Math.round(row.originalAmount * 1000) });
  }
  const historical = await seed.owner.query(api.accountingReports.subledgerReconciliation, { orgId: seed.orgId, toDate: seed.asOfDate });
  expect(historical.byCurrency.JOD).toMatchObject({ glArBalanceMinor: 350_000, subledgerOutstandingMinor: 350_000,
    discrepancyMinor: 0, isReconciled: true });
  expect(await seed.owner.query(api.accountingReports.subledgerReconciliation, {
    orgId: seed.orgId, toDate: seed.asOfDate - 1,
  })).toEqual({ currencies: [], byCurrency: {}, isReconciled: true });
  const debts = await seed.owner.query(api.collections.listReceivables, { orgId: seed.orgId, paginationOpts: { numItems: 10, cursor: null } });
  expect(debts.page).toHaveLength(2);
  const beforeRetry = await financialState(seed);
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload)).rejects.toThrow();
  expect(await financialState(seed)).toEqual(beforeRetry);
});

test.each([
  [350_001, "Customer opening allocations must match the receivable control balance."],
  ...[Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5].map((amount) =>
    [amount, "Opening allocation amounts must be positive whole minor-unit values."] as const),
] as const)("invalid allocation amount %s refuses without financial writes", async (amountMinor, message) => {
  const seed = await fixture();
  const before = await financialState(seed);
  const payload = { ...seed.payload, allocations: [{ ...seed.payload.allocations[0], amountMinor }] };
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload)).rejects.toThrow(message);
  expect(await financialState(seed)).toEqual(before);
});

test("duplicate source identity refuses even when total allocation balances", async () => {
  const seed = await fixture();
  const before = await financialState(seed);
  const payload = { ...seed.payload, allocations: seed.payload.allocations.map((row) => ({ ...row, rowKey: "duplicate" })) };
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload)).rejects.toThrow("Opening allocation row keys must be unique.");
  expect(await financialState(seed)).toEqual(before);
});

test("foreign customer allocation refuses without writes", async () => {
  const seed = await fixture();
  const foreignCustomer = await seed.t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST outsider", createdAt: Date.now() });
    return ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Foreign" });
  });
  const before = await financialState(seed);
  const payload = { ...seed.payload, allocations: seed.payload.allocations.map((row) => ({ ...row, customerId: foreignCustomer })) };
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload)).rejects.toThrow("Opening customer not found in this organization.");
  expect(await financialState(seed)).toEqual(before);
});

test("approval revalidates a customer deleted after preparation and preserves the pending draft", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.draftOpeningBalance, seed.payload);
  const draft = await seed.t.run((ctx) => ctx.db.query("openingBalanceDrafts").unique());
  if (!draft) throw new Error("Missing prepared allocation draft");
  await seed.owner.mutation(api.customers.softDelete, { orgId: seed.orgId, customerId: seed.customerA });
  const before = await financialState(seed);
  await expect(seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId: draft._id })).rejects.toThrow("Opening customer is unavailable.");
  expect(await financialState(seed)).toEqual(before);
});

test("a reset-in-progress organization cannot acquire a new opening position", async () => {
  const seed = await fixture();
  await seed.t.run((ctx) => ctx.db.patch(seed.orgId, { financialResetGeneration: 1, financialResetCompletedGeneration: 0 }));
  const before = await financialState(seed);
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload))
    .rejects.toThrow("An organization with a financial reset in progress cannot post an opening balance.");
  expect(await financialState(seed)).toEqual(before);
});

test("unallocated and unsupported operational controls refuse instead of posting partial onboarding", async () => {
  const seed = await fixture();
  const before = await financialState(seed);
  const { allocations: _allocations, ...unallocated } = seed.payload;
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, unallocated))
    .rejects.toThrow("Customer opening allocations must match the receivable control balance.");
  const partnerControl = (await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId, activeOnly: true }))
    .find((account) => account.systemKey === "PARTNER_CAPITAL");
  if (!partnerControl) throw new Error("Missing fixture partner control");
  const unsupported = { ...seed.payload, lines: [seed.payload.lines[0], { accountId: partnerControl._id, debitMinor: 0, creditMinor: 350_000 }] };
  await expect(seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, unsupported))
    .rejects.toThrow("Partner opening allocations must match each capital account's credit balance.");
  expect(await financialState(seed)).toEqual(before);
});

test.each(["PREPARE", "LEGACY_APPROVE"] as const)("unallocated partner capital refuses at %s without financial writes", async (route) => {
  const seed = await fixture();
  const accounts = await seed.owner.query(api.chartOfAccounts.list, { orgId: seed.orgId, activeOnly: true });
  const cash = accounts.find((account) => account.systemKey === "CASH_ON_HAND");
  const partner = accounts.find((account) => account.systemKey === "PARTNER_CAPITAL");
  if (!cash || !partner) throw new Error("Missing synthetic control accounts");
  const lines = [{ accountId: cash._id, debitMinor: 1_000, creditMinor: 0 },
    { accountId: partner._id, debitMinor: 0, creditMinor: 1_000 }];
  // A pre-upgrade pending draft has no allocation fields. Approval must not
  // silently turn its partner control into a ledger-only opening.
  const draftId = route === "LEGACY_APPROVE" ? await seed.t.run((ctx) => ctx.db.insert("openingBalanceDrafts", {
    orgId: seed.orgId, status: "PENDING_APPROVAL", currency: "JOD", asOfDate: seed.asOfDate,
    lines, createdBy: seed.ownerId, createdAt: Date.now(),
  })) : undefined;
  const before = await financialState(seed);
  if (route === "PREPARE") {
    await expect(seed.owner.mutation(api.accountingCutover.draftOpeningBalance, { orgId: seed.orgId,
      expectedCurrency: "JOD", asOfDate: seed.asOfDate, lines })).rejects.toThrow("Partner opening allocations must match each capital account's credit balance.");
  } else {
    if (!draftId) throw new Error("Missing synthetic legacy pending draft");
    await expect(seed.approver.mutation(api.accountingCutover.approveOpeningBalance, { orgId: seed.orgId, draftId }))
      .rejects.toThrow("Partner opening allocations must match each capital account's credit balance.");
  }
  expect(await financialState(seed)).toEqual(before);
});

test("equal amounts for the same customer remain distinct source rows", async () => {
  const seed = await fixture();
  const payload = { ...seed.payload, allocations: seed.payload.allocations.map((row) =>
    ({ ...row, customerId: seed.customerA, amountMinor: 175_000 })) };
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, payload);
  const state = await financialState(seed);
  expect(state.legacy).toHaveLength(2);
  expect(state.legacy.every((row) => row.customerId === seed.customerA && row.originalAmount === 175)).toBe(true);
  const results = state.drafts[0]?.allocationResults;
  expect(results).toHaveLength(2);
  if (!results || !results.every((row) => row.kind === "CUSTOMER_RECEIVABLE")) throw new Error("Expected only customer opening results");
  expect(new Set(results?.map((row) => row.rowKey)).size).toBe(2);
  expect(new Set(results?.map((row) => row.receivableId)).size).toBe(2);
  expect(new Set(results?.map((row) => row.canonicalReceivableDocumentId)).size).toBe(2);
  expect(state.lines).toHaveLength(2);
});

test.each(["LIVE", "ARCHIVED"] as const)("%s customer's historical AR collects once and its closed-period report agrees with snapshots", async (customerState) => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const state = await financialState(seed);
  const debt = state.legacy.find((row) => row.customerId === seed.customerA);
  if (!debt || !debt.canonicalReceivableDocumentId) throw new Error("Missing linked opening debt");
  if (customerState === "ARCHIVED") {
    await seed.owner.mutation(api.customers.softDelete, { orgId: seed.orgId, customerId: seed.customerA });
    expect(await seed.t.run((ctx) => ctx.db.get(seed.customerA))).toMatchObject({ isDeleted: true });
  }
  const visible = await seed.owner.query(api.collections.listReceivables, { orgId: seed.orgId,
    paginationOpts: { numItems: 10, cursor: null } });
  expect(visible.page.find((row) => row._id === debt._id)).toMatchObject({ outstandingAmount: 100 });
  const payment = { orgId: seed.orgId, receivableId: debt._id, customerId: debt.customerId, amount: 25,
    method: "CASH" as const, paymentDate: Date.now(), idempotencyKey: "opening-collection-readback" };
  await seed.owner.mutation(api.collections.recordPayment, payment);
  const collected = await financialState(seed);
  expect(state.lines.every((line) => collected.lines.some((row) => JSON.stringify(row) === JSON.stringify(line)))).toBe(true);
  expect(collected.lines.filter((line) => !state.lines.some((row) => row._id === line._id))).toHaveLength(2);
  expect(collected.legacy.find((row) => row._id === debt._id)?.outstandingAmount).toBe(75);
  const postedReadback = await seed.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: seed.orgId });
  expect(postedReadback?.rows.find((row) => !row.restricted && row.partyId === debt.customerId))
    .toMatchObject({ amountMinor: 100_000, documentId: debt._id, recordAvailable: true });
  expect((await seed.owner.query(api.subledger.getReceivableBalance, { orgId: seed.orgId,
    receivableDocumentId: debt.canonicalReceivableDocumentId }))?.outstandingMinor).toBe(75_000);
  expect((await seed.owner.query(api.accountingReports.subledgerReconciliation, { orgId: seed.orgId })).byCurrency.JOD)
    .toMatchObject({ glArBalanceMinor: 325_000, subledgerOutstandingMinor: 325_000, discrepancyMinor: 0, isReconciled: true });
  await seed.owner.mutation(api.collections.recordPayment, payment);
  expect(await financialState(seed)).toEqual(collected);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.period._id });
  expect(checklist.canClose).toBe(true);
  await seed.owner.mutation(api.accountingPeriods.close, { orgId: seed.orgId, periodId: seed.period._id,
    acknowledgedWarnings: checklist.warnings });
  const closed = await seed.owner.query(api.accountingReports.trialBalance, { orgId: seed.orgId, toDate: seed.period.endDate });
  expect(closed.rows.find((row) => row.accountId === seed.payload.lines[0].accountId)?.netMinor).toBe(325_000);
  const arSnapshot = (await financialState(seed)).snapshots.filter((row) => row.accountId === seed.payload.lines[0].accountId);
  expect(arSnapshot.reduce((sum, row) => sum + row.runningDebitMinor - row.runningCreditMinor, 0)).toBe(325_000);
  expect(await seed.owner.query(api.accountingReports.subledgerReconciliation, {
    orgId: seed.orgId, toDate: seed.asOfDate - 1,
  })).toEqual({ currencies: [], byCurrency: {}, isReconciled: true });
});

const openingChangeMessage = "Changes and refunds for opening-balance debts require a separate finance review. Nothing has changed.";

test("an opening receipt queued in a new year posts once when its period opens without inventing origination", async () => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const checklist = await seed.owner.query(api.accountingPeriods.closeChecklist, { orgId: seed.orgId, periodId: seed.period._id });
  expect(checklist.canClose).toBe(true);
  await seed.owner.mutation(api.accountingPeriods.close, { orgId: seed.orgId, periodId: seed.period._id,
    acknowledgedWarnings: checklist.warnings });
  await quiesceScheduler(seed.t);
  const before = await financialState(seed);
  const debt = before.legacy.find((row) => row.customerId === seed.customerA);
  if (!debt) throw new Error("Missing opening debt");
  const nextYear = new Date(seed.asOfDate).getUTCFullYear() + 1;
  const paymentDate = Date.UTC(nextYear, 0, 2, 12);
  const clock = vi.spyOn(Date, "now").mockReturnValue(paymentDate);
  const payment = { orgId: seed.orgId, receivableId: debt._id, customerId: debt.customerId, amount: 40,
    method: "CASH" as const, paymentDate, idempotencyKey: "opening-queued-receipt" };
  try {
    await withFrozenScheduler(async () => {
      await seed.owner.mutation(api.collections.recordPayment, payment);
      const queued = await financialState(seed);
      expect(queued.lines).toEqual(before.lines);
      expect(queued.pending.filter((row) => row.eventType === "COLLECTION_PAYMENT" && row.status === "PENDING"))
        .toHaveLength(1);
      expect(queued.legacy.find((row) => row._id === debt._id)?.outstandingAmount).toBe(60);
      await seed.owner.mutation(api.accountingPeriods.create, { orgId: seed.orgId,
        startDate: Date.UTC(nextYear, 0, 1), endDate: Date.UTC(nextYear, 11, 31, 23, 59, 59, 999),
        fiscalYear: nextYear, periodNumber: 1 });
      const nextPeriod = (await seed.owner.query(api.accountingPeriods.list, { orgId: seed.orgId }))
        .find((row) => row.fiscalYear === nextYear);
      if (!nextPeriod) throw new Error("Missing receipt period");
      await seed.owner.mutation(api.accountingPeriods.open, { orgId: seed.orgId, periodId: nextPeriod._id });
      // Pump only the work the real period-open route scheduled; do not supply
      // a missing drain or manufacture claim/attempt identities in this test.
      await settleScheduledOnly(seed.t, seed.orgId);
    });
    const posted = await financialState(seed);
    expect(posted.events.map((row) => row.eventType)).toEqual(["COLLECTION_PAYMENT"]);
    expect(posted.pending.filter((row) => row.status !== "POSTED")).toEqual([]);
    expect(posted.lines.filter((row) => !before.lines.some((old) => old._id === row._id))).toHaveLength(2);
    expect((await seed.owner.query(api.accountingReports.subledgerReconciliation, { orgId: seed.orgId })).byCurrency.JOD)
      .toMatchObject({ glArBalanceMinor: 310_000, subledgerOutstandingMinor: 310_000, discrepancyMinor: 0, isReconciled: true });
    const historical = await seed.owner.query(api.accountingReports.trialBalance, { orgId: seed.orgId, toDate: seed.period.endDate });
    expect(historical.rows.find((row) => row.accountId === seed.payload.lines[0].accountId)?.netMinor).toBe(350_000);
    await seed.owner.mutation(api.collections.recordPayment, payment);
    expect(await financialState(seed)).toEqual(posted);
  } finally { clock.mockRestore(); }
});

test.each(["CANCEL_RECEIVABLE", "REFUND", "RESCHEDULE"] as const)("opening %s request refuses before changing records", async (requestType) => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const row = (await financialState(seed)).legacy.find((debt) => debt.customerId === seed.customerA);
  if (!row) throw new Error("Missing materialized opening debt");
  const before = await financialState(seed);
  await expect(seed.owner.mutation(api.collections.requestApproval, { orgId: seed.orgId, receivableId: row._id,
    requestType, reason: "Synthetic correction refusal", requestedAmount: 25, disbursementMethod: "CASH",
    requestedDueDate: Date.now() + 86_400_000 })).rejects.toThrow(openingChangeMessage);
  expect(await financialState(seed)).toEqual(before);
});

test.each(["CANCEL_RECEIVABLE", "REFUND", "RESCHEDULE"] as const)("stale opening %s approval refuses before writes or replay identity", async (requestType) => {
  const seed = await fixture();
  await seed.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, seed.payload);
  const row = (await financialState(seed)).legacy.find((debt) => debt.customerId === seed.customerA);
  if (!row) throw new Error("Missing materialized opening debt");
  await seed.owner.mutation(api.collections.recordPayment, { orgId: seed.orgId, receivableId: row._id,
    customerId: row.customerId, amount: 25, method: "CASH", paymentDate: Date.now(), idempotencyKey: "opening-native-receipt" });
  const requestId = await seed.t.run((ctx) => ctx.db.insert("collectionApprovalRequests", { orgId: seed.orgId,
    receivableId: row._id, customerId: row.customerId, requestedBy: seed.ownerId, requestType, status: "PENDING",
    requestedAmount: 25, disbursementMethod: "CASH", requestedDueDate: Date.now() + 86_400_000,
    reason: "Synthetic stale request", createdAt: Date.now(), updatedAt: Date.now() }));
  const before = await financialState(seed);
  await expect(seed.approver.mutation(api.collections.respondToApproval, { orgId: seed.orgId, requestId,
    status: "APPROVED", idempotencyKey: "opening-stale-approval" })).rejects.toThrow(openingChangeMessage);
  expect(await financialState(seed)).toEqual(before);
});
