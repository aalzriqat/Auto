import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { seedBank } from "../test-utils/bankFixture";
import { renameSupplier, seedSupplier } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { fromMinorUnits } from "./utils/money";

const modules = import.meta.glob("./**/*.ts");
const tables = Object.keys(schema.tables);

// Freeze the scheduler clock so pre-existing jobs cannot change state while
// a refusal's no-write snapshot is measured. No application module is mocked.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function setup() {
  const t = convexTestWithComponents(schema, modules);
  registerRateLimiter(t);
  const orgId = await t.run(ctx => ctx.db.insert("organizations", { name: "P4b", createdAt: Date.now() }));
  const userId = await t.run(ctx => ctx.db.insert("users", { clerkId: "p4b", email: "p4b@example.test", name: "Owner" }));
  await t.run(async ctx => {
    const roleId = await ctx.db.insert("roles", { orgId, name: "Owner", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  });
  const owner = t.withIdentity({ subject: "p4b", clerkId: "p4b" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const supplierId = await seedSupplier(t, { orgId, userId, displayName: "Canonical supplier", version: 3 });
  const vehicleId = await t.run(ctx => ctx.db.insert("vehicles", {
    orgId, vin: "P4A-CAR", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
    color: "White", fuelType: "Gas", transmission: "Auto", status: "AVAILABLE",
    sellingPrice: fromMinorUnits(12500000, "JOD"), sourceType: "SOURCED",
    sourceCost: fromMinorUnits(9500000, "JOD"), sourcedFromName: "Intake snapshot", sourcedSupplierId: supplierId,
  }));
  const payeeId = await seedSupplier(t, { orgId, userId, displayName: "Garage", version: 2 });
  const args = {
    orgId, vehicleId, vendorSupplierId: payeeId, vendor: "Spoofed garage", title: "Supplier transport", amount: fromMinorUnits(200000, "JOD"),
    date: Date.now() - 60000, category: "TRANSPORT" as const, status: "PAID" as const,
    costBearer: "SUPPLIER" as const, paymentMethod: "CASH" as const, idempotencyKey: "p4b-cost",
  };
  return { t, orgId, userId, owner, supplierId, payeeId, vehicleId, args };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function refused(s: Setup, call: () => Promise<unknown>, code: string) {
  const before = await dbSnapshot(s.t, tables);
  const scheduled = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  await expect(call()).rejects.toMatchObject({ data: { code } });
  expect(await dbSnapshot(s.t, tables)).toEqual(before);
  expect(await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
}

describe("SCRUM-868 P4b expense parties", () => {
  test.each([
    ["VAT", "A supplier-borne cost cannot carry VAT."],
    ["prepaid", "A prepaid expense cannot be borne by the supplier."],
    ["stock", "Only a sourced (consigned) vehicle's cost can be borne by the supplier."],
    ["precision", "The amount is finer than the currency allows, so it cannot be recovered exactly."],
  ] as const)("SCRUM-389 %s refusal preserves its reason without a supplier role code", async (kind, reason) => {
    const s = await setup();
    if (kind === "stock") await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourceType: "STOCK" }));
    const before = await dbSnapshot(s.t, tables);
    await expect(s.owner.mutation(api.expenses.create, {
      ...s.args,
      taxAmount: kind === "VAT" ? fromMinorUnits(1000, "JOD") : undefined,
      isPrepaid: kind === "prepaid",
      amortizationMonths: kind === "prepaid" ? 2 : undefined,
      amount: kind === "precision" ? fromMinorUnits(200000.1, "JOD") : s.args.amount,
    })).rejects.toMatchObject({ data: reason });
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
  });

  test.each(["PENDING", "PAID"] as const)("%s stores distinct canonical parties and never trusts a typed payee name", async status => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status });
    expect(await s.t.run(ctx => ctx.db.get(id))).toMatchObject({
      costBearerSupplierId: s.supplierId, vendorSupplierId: s.payeeId, vendor: "Garage",
    });
    if (status === "PENDING") await s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, status: "PAID", vendorSupplierId: s.payeeId,
    });
    const recovery = await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique());
    expect(recovery).toMatchObject({ supplierId: s.supplierId, amountDueMinor: 200000, amountRecoveredMinor: 0 });
    expect(await s.t.run(ctx => ctx.db.query("vehicleSupplierPayables").collect())).toEqual([]);
    const accounts = await s.t.run(ctx => ctx.db.query("chartOfAccounts").collect());
    const lines = await s.t.run(ctx => ctx.db.query("journalLines").collect());
    expect(lines.map(line => ({ key: accounts.find(a => a._id === line.accountId)?.systemKey,
      debit: line.debitMinor, credit: line.creditMinor })).sort((a,b) => a.debit-b.debit)).toEqual([
      { key: "CASH_ON_HAND", debit: 0, credit: 200000 },
      { key: "RECEIVABLE_FROM_SUPPLIERS", debit: 200000, credit: 0 },
    ]);
    expect(await s.owner.query(api.expenses.totalByVehicle, { orgId: s.orgId, vehicleId: s.vehicleId })).toBe(0);
  });

  test.each(["bearer", "payee"] as const)("foreign or deleted %s is refused with the existing code", async party => {
    for (const kind of ["foreign", "deleted"] as const) {
      const s = await setup();
      const id = party === "bearer" ? s.supplierId : s.payeeId;
      await s.t.run(async ctx => {
        if (kind === "deleted") await ctx.db.delete(id);
        else {
          const orgId = await ctx.db.insert("organizations", { name: "Foreign", createdAt: Date.now() });
          await ctx.db.patch(id, { orgId });
        }
      });
      await refused(s, () => s.owner.mutation(api.expenses.create, s.args),
        party === "bearer" ? "SUPPLIER_IDENTITY_UNRESOLVED" : "SUPPLIER_NOT_FOUND");
    }
  });

  test("client cannot send a bearer id on create or edit", async () => {
    const s = await setup();
    const forged = { ...s.args, costBearerSupplierId: s.payeeId };
    await expect(s.owner.mutation(api.expenses.create, forged)).rejects.toThrow(/Unexpected field/);
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    const edit = { orgId: s.orgId, expenseId: id, costBearerSupplierId: s.payeeId };
    const before = await dbSnapshot(s.t, tables);
    await expect(s.owner.mutation(api.expenses.update, edit)).rejects.toThrow(/Unexpected field/);
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
  });

  test("mobile-shaped name-only create and status-only supplier payment refuse server-side", async () => {
    const s = await setup();
    const { vendorSupplierId: _payee, ...mobile } = s.args;
    await refused(s, () => s.owner.mutation(api.expenses.create, mobile), "SUPPLIER_IDENTITY_REQUIRED");
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    await refused(s, () => s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, status: "PAID",
    }), "SUPPLIER_IDENTITY_REQUIRED");
  });

  test("new inactive bearer refuses; accepted pending cost completes without refreshing payee snapshot", async () => {
    const s = await setup();
    await s.t.run(ctx => ctx.db.patch(s.supplierId, { status: "INACTIVE" }));
    await refused(s, () => s.owner.mutation(api.expenses.create, s.args), "SUPPLIER_INACTIVE");
    await s.t.run(ctx => ctx.db.patch(s.supplierId, { status: "ACTIVE" }));
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    await renameSupplier(s.t, s.payeeId, "Renamed garage");
    await s.t.run(async ctx => {
      await ctx.db.patch(s.supplierId, { status: "INACTIVE" });
      await ctx.db.patch(s.payeeId, { status: "INACTIVE" });
    });
    await refused(s, () => s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, amount: fromMinorUnits(300000, "JOD"), vendorSupplierId: s.payeeId,
    }), "SUPPLIER_INACTIVE");
    await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, status: "PAID", vendorSupplierId: s.payeeId });
    expect(await s.t.run(ctx => ctx.db.get(id))).toMatchObject({ vendor: "Garage", vendorSupplierId: s.payeeId, costBearerSupplierId: s.supplierId });
  });

  test("payee-only pending edit never posts or reclassifies, and paid identity is immutable", async () => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    const newPayee = await seedSupplier(s.t, { orgId: s.orgId, userId: s.userId, displayName: "Second garage" });
    const moneyTables = ["transactions", "journalLines", "accountingEvents", "pendingAccountingEvents", "supplierCostRecoveries", "vehicleSupplierPayables"];
    const before = await dbSnapshot(s.t, moneyTables);
    await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, vendorSupplierId: newPayee, vendor: "Spoof" });
    expect(await dbSnapshot(s.t, moneyTables)).toEqual(before);
    expect(await s.t.run(ctx => ctx.db.get(id))).toMatchObject({ vendor: "Second garage", costBearer: "SUPPLIER", costBearerSupplierId: s.supplierId });
    await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, status: "PAID", vendorSupplierId: newPayee });
    expect(await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique())).toMatchObject({ supplierId: s.supplierId, amountDueMinor: 200000 });
    expect(await s.t.run(ctx => ctx.db.query("vehicleSupplierPayables").collect())).toEqual([]);
    await refused(s, () => s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, vendorSupplierId: s.payeeId }), "SUPPLIER_LINK_FROZEN");
    await refused(s, () => s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, vendor: "Rewritten" }), "SUPPLIER_LINK_FROZEN");
  });

  test("paid supplier expense without a vendor accepts a web notes-only edit without other changes", async () => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, s.args);
    await s.t.run(ctx => ctx.db.patch(id, { vendor: undefined }));
    const before = await dbSnapshot(s.t, tables);
    const scheduled = await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
    await s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, vendor: "", notes: "Retained history",
    });
    const after = await dbSnapshot(s.t, tables);
    expect(after).toEqual({
      ...before,
      notifications: [...before.notifications, {
        _id: expect.any(String), _creationTime: expect.any(Number),
        orgId: s.orgId, userId: s.userId, type: "expense.updated",
        category: "finance", priority: "low", isRead: false,
        link: `/${s.orgId}/expenses?highlightId=${id}`, data: { actorName: "Owner" },
      }],
      expenses: before.expenses.map(row => {
        if (typeof row === "object" && row !== null && "_id" in row && row._id === id) {
          return { ...row, notes: "Retained history" };
        }
        return row;
      }),
    });
    expect(await s.t.run(ctx => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
  });

  test("legacy read and notes edit preserve absent identity while new payment refuses", async () => {
    const s = await setup();
    const id = await s.t.run(ctx => ctx.db.insert("expenses", {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Legacy", amount: fromMinorUnits(200000, "JOD"),
      date: s.args.date, category: "TRANSPORT", status: "PENDING", costBearer: "SUPPLIER", vendor: "Old garage",
    }));
    await s.t.run(ctx => ctx.db.delete(s.supplierId));
    const before = await dbSnapshot(s.t, tables);
    const result = await s.owner.query(api.expenses.list, { orgId: s.orgId, paginationOpts: { numItems: 10, cursor: null } });
    expect(result.page[0]).toMatchObject({ _id: id, vendor: "Old garage" });
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
    await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, notes: "Retained history" });
    const row = await s.t.run(ctx => ctx.db.get(id));
    expect(row).not.toHaveProperty("costBearerSupplierId");
    expect(row).not.toHaveProperty("vendorSupplierId");
    expect(row).toMatchObject({ vendor: "Old garage", notes: "Retained history" });
    await expect(s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, status: "PAID", vendorSupplierId: s.payeeId })).rejects.toMatchObject({ data: { code: "SUPPLIER_IDENTITY_UNRESOLVED" } });
  });

  test("retry after rename and deactivation is idempotent and retains the first parties", async () => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, s.args);
    await renameSupplier(s.t, s.payeeId, "Renamed garage");
    await s.t.run(async ctx => { await ctx.db.patch(s.payeeId, { status: "INACTIVE" }); await ctx.db.patch(s.supplierId, { status: "INACTIVE" }); });
    const before = await dbSnapshot(s.t, tables);
    expect(await s.owner.mutation(api.expenses.create, s.args)).toBe(id);
    expect(await dbSnapshot(s.t, tables)).toEqual(before);
  });

  test("showroom expense keeps its existing free-text payee", async () => {
    const s = await setup();
    const { vendorSupplierId: _payee, ...args } = s.args;
    const id = await s.owner.mutation(api.expenses.create, { ...args, costBearer: "SHOWROOM", vendor: "Office shop" });
    expect(await s.t.run(ctx => ctx.db.get(id))).toMatchObject({ vendor: "Office shop", costBearer: "SHOWROOM" });
    expect(await s.t.run(ctx => ctx.db.get(id))).not.toHaveProperty("vendorSupplierId");
  });

  test("pending bearer switch clears both canonical identities without creating a money effect", async () => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    await s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, costBearer: "SHOWROOM" });
    const row = await s.t.run(ctx => ctx.db.get(id));
    expect(row).toMatchObject({ costBearer: "SHOWROOM", vendor: "Garage" });
    expect(row).not.toHaveProperty("costBearerSupplierId");
    expect(row).not.toHaveProperty("vendorSupplierId");
    expect(await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").collect())).toEqual([]);
    await refused(s, () => s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, vendorSupplierId: s.payeeId,
    }), "SUPPLIER_ROLE_CONFLICT");
  });

  test("inactive payee cannot take a new cost and a stale bearer cannot be paid", async () => {
    const s = await setup();
    await s.t.run(ctx => ctx.db.patch(s.payeeId, { status: "INACTIVE" }));
    await refused(s, () => s.owner.mutation(api.expenses.create, s.args), "SUPPLIER_INACTIVE");
    await s.t.run(ctx => ctx.db.patch(s.payeeId, { status: "ACTIVE" }));
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING" });
    // Corrupt/stale imported linkage must not silently retarget a pending obligation.
    await s.t.run(ctx => ctx.db.patch(s.vehicleId, { sourcedSupplierId: s.payeeId }));
    await refused(s, () => s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, status: "PAID", vendorSupplierId: s.payeeId,
    }), "SUPPLIER_IDENTITY_UNRESOLVED");
  });


  test("web first payment completes an accepted inactive obligation with its first method and bank choice", async () => {
    for (const paymentMethod of ["CASH", "BANK_TRANSFER"] as const) {
      const s = await setup();
      const bankAccountId = paymentMethod === "BANK_TRANSFER" ? await seedBank(s.t, s.orgId) : undefined;
      // Exact web create shape: PENDING has no selected payment method or bank.
      const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING", paymentMethod: undefined });
      await s.t.run(async ctx => {
        await ctx.db.patch(s.supplierId, { status: "INACTIVE" });
        await ctx.db.patch(s.payeeId, { status: "INACTIVE" });
      });
      await s.owner.mutation(api.expenses.update, {
        orgId: s.orgId, expenseId: id, status: "PAID", vendorSupplierId: s.payeeId,
        paymentMethod, bankAccountId, taxAmount: 0, isPrepaid: false,
      });
      expect(await s.t.run(ctx => ctx.db.get(id))).toMatchObject({
        status: "PAID", amount: fromMinorUnits(200000, "JOD"), paymentMethod, vendor: "Garage",
        vendorSupplierId: s.payeeId, costBearerSupplierId: s.supplierId,
      });
      expect(await s.t.run(ctx => ctx.db.query("supplierCostRecoveries").unique())).toMatchObject({ supplierId: s.supplierId, amountDueMinor: 200000 });
    }
  });

  test("mobile-shaped pending amount increase requires explicit payee confirmation", async () => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING", paymentMethod: undefined });
    await refused(s, () => s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, amount: fromMinorUnits(300000, "JOD"),
    }), "SUPPLIER_IDENTITY_REQUIRED");
    // The web-shaped economic edit remains available with explicit party confirmation.
    await s.owner.mutation(api.expenses.update, {
      orgId: s.orgId, expenseId: id, amount: fromMinorUnits(300000, "JOD"), vendorSupplierId: s.payeeId,
    });
    expect(await s.t.run(ctx => ctx.db.get(id))).toMatchObject({ amount: fromMinorUnits(300000, "JOD"), costBearerSupplierId: s.supplierId });
  });


  test("supplier economic edit doors share the explicit payee confirmation gate", async () => {
    const s = await setup();
    const id = await s.owner.mutation(api.expenses.create, { ...s.args, status: "PENDING", paymentMethod: undefined });
    // Literal door census, independent of the production predicate. Design missed payment;
    // the first implementation then missed amount edits (SCRUM-868 P4b advisory review).
    const edits = [
      { amount: fromMinorUnits(300000, "JOD") }, { title: "Changed title" },
      { category: "REPAIR" }, { date: s.args.date + 86400000 }, { taxAmount: 1 },
      { vehicleId: null }, { paymentMethod: "BANK_TRANSFER" }, { status: "PAID" },
      { isPrepaid: true, amortizationMonths: 2 }, { amortizationMonths: 2 },
    ] as const;
    for (const edit of edits) {
      await refused(s, () => s.owner.mutation(api.expenses.update, { orgId: s.orgId, expenseId: id, ...edit }), "SUPPLIER_IDENTITY_REQUIRED");
    }
  });

});
