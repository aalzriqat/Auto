import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FunctionArgs } from "convex/server";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

type Input = FunctionArgs<typeof api.accountingCutover.draftOpeningBalance>;
type Allocation = Extract<NonNullable<Input["allocations"]>[number], { kind: Kind }> & {
  supplierId?: Id<"suppliers">; supplierSnapshotVersion?: number;
};
type Kind = "SUPPLIER_PAYABLE" | "SUPPLIER_RECOVERABLE" | "OTHER_PAYABLE";
const tables = Object.keys(schema.tables);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture(kind: Kind = "SUPPLIER_PAYABLE") {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  registerRateLimiter(t);
  const ids = await t.run(async ctx => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic P5", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "p5-owner", email: "owner@example.test" });
    const reviewerId = await ctx.db.insert("users", { clerkId: "p5-reviewer", email: "reviewer@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: ALL_PERMISSIONS });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("memberships", { orgId, userId: reviewerId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    await ctx.db.insert("supplierRegistryState", { orgId, version: 0 });
    return { orgId, userId };
  });
  const owner = t.withIdentity({ subject: "p5-owner" });
  const reviewer = t.withIdentity({ subject: "p5-reviewer" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId: ids.orgId });
  const year = new Date().getUTCFullYear();
  const asOfDate = Date.UTC(year, 0, 1);
  await owner.mutation(api.accountingPeriods.create, { orgId: ids.orgId, startDate: asOfDate,
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId: ids.orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId: ids.orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId: ids.orgId });
  const account = (key: string) => {
    const row = accounts.find(candidate => candidate.systemKey === key);
    if (!row) throw new Error("Missing fixture account " + key);
    return row._id;
  };
  const accountId = kind === "OTHER_PAYABLE"
    ? await owner.mutation(api.chartOfAccounts.create, { orgId: ids.orgId, code: "P5-OTHER", name: "Other creditor", type: "LIABILITY", normalBalance: "CREDIT" })
    : account(kind === "SUPPLIER_RECOVERABLE" ? "RECEIVABLE_FROM_SUPPLIERS" : "ACCOUNTS_PAYABLE_SUPPLIERS");
  const supplierId = await seedSupplier(t, { ...ids, displayName: "Canonical supplier", version: 3 });
  const allocationBase = { rowKey: "supplier", accountId, amountMinor: 100_003,
    counterpartyName: "Forged client name", title: "Synthetic opening balance", supplierId,
    supplierSnapshotVersion: 999 };
  const allocation: Allocation = kind === "SUPPLIER_RECOVERABLE"
    ? { ...allocationBase, kind, purpose: "CLAIM" } : { ...allocationBase, kind };
  const recovery = kind === "SUPPLIER_RECOVERABLE";
  const payload: Input = { orgId: ids.orgId, expectedCurrency: "JOD", asOfDate, allocations: [allocation], lines: [
    { accountId, debitMinor: recovery ? 100_003 : 0, creditMinor: recovery ? 0 : 100_003 },
    { accountId: account("RETAINED_EARNINGS"), debitMinor: recovery ? 0 : 100_003, creditMinor: recovery ? 100_003 : 0 },
  ] };
  return { t, ...ids, owner, reviewer, account, supplierId, allocation, payload };
}
type Setup = Awaited<ReturnType<typeof fixture>>;

async function rows(s: Setup) {
  return s.t.run(async ctx => ({
    payables: await ctx.db.query("vehicleSupplierPayables").collect(),
    recoveries: await ctx.db.query("supplierCostRecoveries").collect(),
    drafts: await ctx.db.query("openingBalanceDrafts").collect(),
  }));
}
async function refuse(s: Setup, call: () => Promise<unknown>, code: string) {
  const before = await dbSnapshot(s.t, tables);
  await expect(call()).rejects.toMatchObject({ data: { code } });
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
}
async function post(s: Setup) {
  return s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, s.payload);
}

test.each(["SUPPLIER_PAYABLE", "SUPPLIER_RECOVERABLE", "OTHER_PAYABLE"] as const)("direct opening stores the master snapshot for %s", async kind => {
  const s = await fixture(kind);
  await post(s);
  const stored = await rows(s);
  const obligations = [...stored.payables, ...stored.recoveries];
  expect(obligations.map(row => ({ supplierId: row.supplierId, name: row.sourcedFromName, version: row.supplierSnapshotVersion })))
    .toEqual([{ supplierId: s.supplierId, name: "Canonical supplier", version: 3 }]);
  expect(stored.drafts[0]?.allocations).toEqual([{ ...s.allocation, counterpartyName: "Canonical supplier", supplierSnapshotVersion: 3 }]);
  expect(await s.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId }))
    .toMatchObject({ rows: [{ recordAvailable: true, amountMinor: 100_003 }] });
});

test("approval captures one current master snapshot after a rename", async () => {
  const s = await fixture("SUPPLIER_RECOVERABLE");
  const { draftId } = await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
  await s.owner.mutation(api.suppliers.update, { orgId: s.orgId, supplierId: s.supplierId, expectedVersion: 3,
    displayName: "Renamed supplier", reason: "Synthetic rename" });
  const draft = (await rows(s)).drafts.find(row => String(row._id) === draftId);
  if (!draft) throw new Error("Missing draft");
  await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId: draft._id, expectedVersion: 0 });
  const stored = await rows(s);
  expect(stored.recoveries.map(row => [row.supplierId, row.sourcedFromName, row.supplierSnapshotVersion, row.amountDueMinor]))
    .toEqual([[s.supplierId, "Renamed supplier", 4, 100_003]]);
  expect(stored.drafts[0]?.allocations).toEqual([{ ...s.allocation, counterpartyName: "Renamed supplier", supplierSnapshotVersion: 4 }]);
});

const invalidIdentities = ["missing", "name-only", "foreign", "deleted", "inactive"] as const;
async function refusesPreparation(kind: "SUPPLIER_PAYABLE" | "SUPPLIER_RECOVERABLE", door: "draft" | "direct", invalid: typeof invalidIdentities[number]) {
      const s = await fixture(kind);
      if (invalid === "foreign") await s.t.run(async ctx => {
        const orgId = await ctx.db.insert("organizations", { name: "Foreign", createdAt: Date.now() });
        await ctx.db.patch(s.supplierId, { orgId });
      });
      if (invalid === "deleted") await s.t.run(ctx => ctx.db.delete(s.supplierId));
      if (invalid === "inactive") await s.owner.mutation(api.suppliers.deactivate, { orgId: s.orgId, supplierId: s.supplierId, reason: "Synthetic" });
      const allocation = { ...s.allocation };
      if (invalid === "missing" || invalid === "name-only") {
        delete allocation.supplierId;
        delete allocation.supplierSnapshotVersion;
        allocation.counterpartyName = invalid === "missing" ? "" : "Canonical supplier";
      }
      const code = invalid === "inactive" ? "SUPPLIER_INACTIVE" : "SUPPLIER_NOT_FOUND";
      await refuse(s, () => s.owner.mutation(door === "draft" ? api.accountingCutover.draftOpeningBalance : api.accountingCutover.postOpeningBalanceDirect,
        { ...s.payload, allocations: [allocation] }), invalid === "missing" || invalid === "name-only" ? "SUPPLIER_IDENTITY_REQUIRED" : code);
}
test.each(invalidIdentities)("draft SUPPLIER_PAYABLE refuses %s identity atomically", invalid => refusesPreparation("SUPPLIER_PAYABLE", "draft", invalid));
test.each(invalidIdentities)("direct SUPPLIER_PAYABLE refuses %s identity atomically", invalid => refusesPreparation("SUPPLIER_PAYABLE", "direct", invalid));
test.each(invalidIdentities)("draft SUPPLIER_RECOVERABLE refuses %s identity atomically", invalid => refusesPreparation("SUPPLIER_RECOVERABLE", "draft", invalid));
test.each(invalidIdentities)("direct SUPPLIER_RECOVERABLE refuses %s identity atomically", invalid => refusesPreparation("SUPPLIER_RECOVERABLE", "direct", invalid));

test("ordinary OTHER_PAYABLE without a supplier posts and settles", async () => {
  const s = await fixture("OTHER_PAYABLE");
  const allocation = { ...s.allocation, supplierId: undefined, supplierSnapshotVersion: 999, counterpartyName: "Ordinary creditor" };
  s.payload.allocations = [allocation];
  await post(s);
  const payable = (await rows(s)).payables[0];
  expect(payable?.supplierId).toBeUndefined();
  expect(payable?.supplierSnapshotVersion).toBeUndefined();
  await s.owner.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId: payable._id, paymentMethod: "CASH", idempotencyKey: "p5-other" });
  expect((await rows(s)).payables[0]).toMatchObject({ status: "PAID", amountPaid: 100.003, sourcedFromName: "Ordinary creditor" });
});

test.each(["SUPPLIER_PAYABLE", "SUPPLIER_RECOVERABLE"] as const)("identified inactive %s settles once and keeps its snapshot on retry", async kind => {
  const s = await fixture(kind);
  await post(s);
  await s.owner.mutation(api.suppliers.deactivate, { orgId: s.orgId, supplierId: s.supplierId, reason: "Synthetic" });
  const stored = await rows(s);
  const call = () => kind === "SUPPLIER_PAYABLE"
    ? s.owner.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId: stored.payables[0]._id, paymentMethod: "CASH", idempotencyKey: "p5-payment" })
    : s.owner.mutation(api.supplierCostRecoveries.recordReceipt, { orgId: s.orgId, recoveryId: stored.recoveries[0]._id, amountMinor: 40_001,
      method: "CASH", receivedDate: Date.now() - 1, idempotencyKey: "p5-receipt" });
  const first = await call();
  const beforeRetry = await dbSnapshot(s.t, tables);
  expect(await call()).toEqual(first);
  expect(await dbSnapshot(s.t, tables)).toEqual(beforeRetry);
  const after = await rows(s);
  expect([...after.payables, ...after.recoveries][0]).toMatchObject({ supplierId: s.supplierId, sourcedFromName: "Canonical supplier", supplierSnapshotVersion: 3 });
});

test.each(["SUPPLIER_PAYABLE", "SUPPLIER_RECOVERABLE"] as const)("%s basis rejects a same-name different supplier and one-sided identity", async kind => {
  const s = await fixture(kind);
  await post(s);
  const otherId = await seedSupplier(s.t, { orgId: s.orgId, userId: s.userId, displayName: "Canonical supplier", version: 3 });
  const stored = await rows(s);
  const obligation = [...stored.payables, ...stored.recoveries][0];
  for (const supplierId of [otherId, undefined]) {
    await s.t.run(ctx => ctx.db.patch(obligation._id, { supplierId }));
    const result = await s.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId });
    expect(result).toMatchObject({ rows: [{ recordAvailable: false }] });
  }
  await s.t.run(ctx => ctx.db.patch(obligation._id, { supplierId: s.supplierId, sourcedFromName: "Another display snapshot" }));
  expect(await s.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId }))
    .toMatchObject({ rows: [{ recordAvailable: true }] });
});

test.each(["SUPPLIER_PAYABLE", "SUPPLIER_RECOVERABLE"] as const)("legacy id-less %s remains readable but refuses new settlement", async kind => {
  const s = await fixture(kind);
  await post(s);
  const stored = await rows(s);
  const obligation = [...stored.payables, ...stored.recoveries][0];
  await s.t.run(async ctx => {
    await ctx.db.patch(obligation._id, { supplierId: undefined, supplierSnapshotVersion: undefined });
    const allocations = stored.drafts[0].allocations?.map(row => {
      if (!("counterpartyName" in row)) return row;
      const legacy = { ...row } as Allocation;
      delete legacy.supplierId;
      delete legacy.supplierSnapshotVersion;
      return legacy;
    });
    await ctx.db.patch(stored.drafts[0]._id, { allocations });
  });
  const before = await dbSnapshot(s.t, tables);
  expect(await s.owner.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: s.orgId }))
    .toMatchObject({ rows: [{ recordAvailable: true }] });
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
  await refuse(s, () => kind === "SUPPLIER_PAYABLE"
    ? s.owner.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId: stored.payables[0]._id, paymentMethod: "CASH", idempotencyKey: "legacy" })
    : s.owner.mutation(api.supplierCostRecoveries.recordReceipt, { orgId: s.orgId, recoveryId: stored.recoveries[0]._id, amountMinor: 40_001,
      method: "CASH", receivedDate: Date.now() - 1, idempotencyKey: "legacy" }), "SUPPLIER_IDENTITY_UNRESOLVED");
});

test("pending legacy draft can acquire a supplier through edit and stale approval refuses", async () => {
  const s = await fixture();
  const legacy = { ...s.allocation };
  delete legacy.supplierId;
  delete legacy.supplierSnapshotVersion;
  const draftId = await s.t.run(ctx => ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "PENDING_APPROVAL",
    lines: s.payload.lines, asOfDate: s.payload.asOfDate, currency: "JOD", allocations: [legacy], createdBy: s.userId, createdAt: Date.now() }));
  const before = await dbSnapshot(s.t, tables);
  await s.owner.query(api.accountingCutover.listPendingOpeningBalanceDrafts, { orgId: s.orgId });
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
  await refuse(s, () => s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId, expectedVersion: 0 }), "SUPPLIER_IDENTITY_REQUIRED");
  await s.owner.mutation(api.accountingCutover.editOpeningBalanceDraft, { ...s.payload, draftId });
  await refuse(s, () => s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId, expectedVersion: 0 }), "OPENING_DRAFT_CHANGED");
  await s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId, expectedVersion: 1 });
  expect((await rows(s)).payables[0]).toMatchObject({ supplierId: s.supplierId, sourcedFromName: "Canonical supplier", supplierSnapshotVersion: 3 });
});

test("repeating direct posting cannot add another opening", async () => {
  const s = await fixture();
  await post(s);
  const before = await dbSnapshot(s.t, tables);
  await expect(post(s)).rejects.toThrow(/already been posted/);
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
});

const invalidReviewedIdentities = ["missing", "foreign", "deleted", "inactive"] as const;
async function refusesReviewed(kind: "SUPPLIER_PAYABLE" | "SUPPLIER_RECOVERABLE", door: "edit" | "approve", invalid: typeof invalidReviewedIdentities[number]) {
      const s = await fixture(kind);
      await s.owner.mutation(api.accountingCutover.draftOpeningBalance, s.payload);
      const draft = (await rows(s)).drafts[0];
      const allocation = { ...s.allocation };
      if (invalid === "missing") {
        delete allocation.supplierId;
        delete allocation.supplierSnapshotVersion;
        if (door === "approve") await s.t.run(ctx => ctx.db.patch(draft._id, { allocations: [allocation] }));
      }
      if (invalid === "foreign") await s.t.run(async ctx => {
        const orgId = await ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() });
        await ctx.db.patch(s.supplierId, { orgId });
      });
      if (invalid === "deleted") await s.t.run(ctx => ctx.db.delete(s.supplierId));
      if (invalid === "inactive") await s.owner.mutation(api.suppliers.deactivate, { orgId: s.orgId, supplierId: s.supplierId, reason: "Synthetic" });
      let code = "SUPPLIER_NOT_FOUND";
      if (invalid === "missing") code = "SUPPLIER_IDENTITY_REQUIRED";
      if (invalid === "inactive") code = "SUPPLIER_INACTIVE";
      await refuse(s, () => door === "edit"
        ? s.owner.mutation(api.accountingCutover.editOpeningBalanceDraft, { ...s.payload, draftId: draft._id, allocations: [allocation] })
        : s.reviewer.mutation(api.accountingCutover.approveOpeningBalance, { orgId: s.orgId, draftId: draft._id, expectedVersion: 0 }), code);
}
test.each(invalidReviewedIdentities)("edit SUPPLIER_PAYABLE revalidates %s supplier before any write", invalid => refusesReviewed("SUPPLIER_PAYABLE", "edit", invalid));
test.each(invalidReviewedIdentities)("approve SUPPLIER_PAYABLE revalidates %s supplier before any write", invalid => refusesReviewed("SUPPLIER_PAYABLE", "approve", invalid));
test.each(invalidReviewedIdentities)("edit SUPPLIER_RECOVERABLE revalidates %s supplier before any write", invalid => refusesReviewed("SUPPLIER_RECOVERABLE", "edit", invalid));
test.each(invalidReviewedIdentities)("approve SUPPLIER_RECOVERABLE revalidates %s supplier before any write", invalid => refusesReviewed("SUPPLIER_RECOVERABLE", "approve", invalid));

test("identified opening payable supports partial payment and dispute; legacy supplier does neither", async () => {
  const s = await fixture();
  await post(s);
  const payable = (await rows(s)).payables[0];
  await s.owner.mutation(api.sourcingPayables.recordPartialPayment, { orgId: s.orgId, payableId: payable._id,
    amount: 40.001, paymentMethod: "CASH", idempotencyKey: "p5-partial" });
  expect((await rows(s)).payables[0]).toMatchObject({ amountDue: 100.003, amountPaid: 40.001, supplierId: s.supplierId });
  await s.owner.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId: payable._id, disputed: true, reason: "Synthetic", idempotencyKey: "p5-dispute" });
  const stored = await rows(s);
  await s.t.run(async ctx => {
    await ctx.db.patch(payable._id, { supplierId: undefined, supplierSnapshotVersion: undefined });
    await ctx.db.patch(stored.drafts[0]._id, { allocations: stored.drafts[0].allocations?.map(row => {
      if (!("supplierId" in row)) return row;
      const legacy = { ...row }; delete legacy.supplierId; delete legacy.supplierSnapshotVersion; return legacy;
    }) });
  });
  await refuse(s, () => s.owner.mutation(api.sourcingPayables.recordPartialPayment, { orgId: s.orgId, payableId: payable._id,
    amount: 10.001, paymentMethod: "CASH", idempotencyKey: "p5-legacy-partial" }), "SUPPLIER_IDENTITY_UNRESOLVED");
  await refuse(s, () => s.owner.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId: payable._id,
    disputed: false, idempotencyKey: "p5-legacy-dispute" }), "SUPPLIER_IDENTITY_UNRESOLVED");
});

test("unrelated employee opening allocations still post without supplier metadata", async () => {
  const s = await fixture();
  const accountId = s.account("EMPLOYEE_ADVANCES");
  await s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, { ...s.payload, lines: [
    { accountId, debitMinor: 100_003, creditMinor: 0 },
    { accountId: s.account("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 100_003 },
  ], allocations: [{ kind: "EMPLOYEE_ADVANCE", rowKey: "employee", accountId, amountMinor: 100_003, userId: s.userId }] });
  expect((await rows(s)).payables).toEqual([]);
  expect(await s.t.run(async ctx => (await ctx.db.query("employeeAdvances").collect()).map(row => row.amountMinor))).toEqual([100_003]);
});

test("unexpected snapshot runtime failure logs privately and rolls back with a generic error", async () => {
  const s = await fixture();
  const before = await dbSnapshot(s.t, tables);
  const originalFreeze = Object.freeze;
  const fault = new Error("Synthetic private snapshot runtime failure");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  // Fault the runtime primitive used to freeze a master snapshot, not a
  // business helper. The public mutation still executes the real resolver.
  const freeze = vi.spyOn(Object, "freeze").mockImplementation(<T>(value: T): Readonly<T> => {
    if (value && typeof value === "object" && "supplierId" in value && value.supplierId === s.supplierId) throw fault;
    return originalFreeze(value);
  });
  try {
    await expect(post(s)).rejects.toMatchObject({ data: "An unexpected error occurred. Please try again later." });
    expect(log).toHaveBeenCalledWith(fault);
  } finally {
    freeze.mockRestore();
    log.mockRestore();
  }
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
});
