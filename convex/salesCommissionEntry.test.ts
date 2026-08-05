import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Mock the rate limiter so we don't need to register the Convex component.
vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * MANUAL commission mode had no entry point. `listCommissions` admitted a sale
 * only if it already carried a positive commission (or, in an AUTO mode, was a
 * completed sale flagged for a missing cost basis). In MANUAL both clauses fail
 * for a fresh sale, so the page was empty — and `setCommissionAmount` is only
 * reachable from a row on that page. A closed loop: the first amount could
 * never be entered.
 *
 * These tests pin the loop open. Every one of them fails against the pre-fix
 * `listCommissions`, most of them because the row simply is not there.
 */

type Ids = Awaited<ReturnType<typeof seedCommissionOrg>>;

async function seedCommissionOrg(
  t: ReturnType<typeof convexTestWithComponents>,
  suffix: string,
  permissions: string[] = [
    "create:sales",
    "view:sales",
    "edit:sales",
    "view:vehicles",
    "view:commissions",
    "manage:commissions",
  ]
) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Commission Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `comm_${suffix}`,
      email: `${suffix}@example.com`,
      name: "Test User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN-${suffix}`,
      make: "Honda",
      model: "Accord",
      year: 2020,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 50000,
      sellingPrice: 15000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "John",
      lastName: "Doe",
      email: `${suffix}.customer@example.com`,
    })
  );
  return {
    orgId,
    userId,
    vehicleId,
    customerId,
    asAdmin: t.withIdentity({ subject: `comm_${suffix}`, clerkId: `comm_${suffix}` }),
  };
}

async function setMode(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Ids["orgId"],
  commissionMode: "MANUAL" | "AUTO_MEMBER"
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: "USD",
      currencySymbol: "$",
      enabledPaymentTypes: [],
      commissionMode,
    });
  });
}

async function completedSale(
  ids: Pick<Ids, "orgId" | "vehicleId" | "customerId" | "userId" | "asAdmin">,
  salePrice = 15000
) {
  return await ids.asAdmin.mutation(api.sales.create, {
    orgId: ids.orgId,
    vehicleId: ids.vehicleId,
    customerId: ids.customerId,
    salespersonId: ids.userId,
    salePrice,
    saleDate: Date.now(),
    status: "COMPLETED",
    financingType: "CASH",
  });
}

/** A second vehicle + customer so a second sale is a genuinely separate row. */
async function extraVehicleAndCustomer(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Ids["orgId"],
  suffix: string
) {
  return await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN-${suffix}-2`,
      make: "Kia",
      model: "K5",
      year: 2024,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 10,
      sellingPrice: 15000,
      status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", {
      orgId,
      firstName: "Second",
      lastName: "Buyer",
      email: `second.${suffix}@example.com`,
    });
    return { vehicleId, customerId };
  });
}

describe("MANUAL mode: the commissions page is an entry point, not a dead end", () => {
  test("a completed MANUAL sale with no commission is listed as NOT_SET", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_entry");
    await setMode(t, ids.orgId, "MANUAL");

    const saleId = await completedSale(ids);

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    const row = rows.find((r) => r._id === saleId);
    // Pre-fix this was `undefined` — the sale was simply absent from the page,
    // which is why the first amount could never be entered.
    expect(row).toBeDefined();
    expect(row?.commissionStatus).toBe("NOT_SET");
    expect(row?.commissionAmount).toBeUndefined();
    expect(row?.canSetAmount).toBe(true);
  });

  test("the first commission can be set from that row and the status advances to UNPAID", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_first");
    await setMode(t, ids.orgId, "MANUAL");
    const saleId = await completedSale(ids);

    await ids.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: ids.orgId,
      saleId,
      commissionAmount: 250,
    });

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    const row = rows.find((r) => r._id === saleId);
    expect(row?.commissionAmount).toBe(250);
    expect(row?.commissionStatus).toBe("UNPAID");
  });

  test("zero is a decision, not an absence: NO_COMMISSION, and it leaves the review queue", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_zero");
    await setMode(t, ids.orgId, "MANUAL");
    const saleId = await completedSale(ids);

    await ids.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: ids.orgId,
      saleId,
      commissionAmount: 0,
    });

    const all = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(all.find((r) => r._id === saleId)?.commissionStatus).toBe("NO_COMMISSION");

    const notSet = await ids.asAdmin.query(api.sales.listCommissions, {
      orgId: ids.orgId,
      paidStatus: "not_set",
    });
    expect(notSet.find((r) => r._id === saleId)).toBeUndefined();
  });

  test("not_set returns only undecided rows; unpaid still returns everything unsettled", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_filter");
    await setMode(t, ids.orgId, "MANUAL");

    const undecided = await completedSale(ids);
    const extra = await extraVehicleAndCustomer(t, ids.orgId, "manual_filter");
    const decided = await completedSale({ ...ids, ...extra });
    await ids.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: ids.orgId,
      saleId: decided,
      commissionAmount: 300,
    });

    const notSet = await ids.asAdmin.query(api.sales.listCommissions, {
      orgId: ids.orgId,
      paidStatus: "not_set",
    });
    expect(notSet.map((r) => r._id)).toEqual([undecided]);

    // "unpaid" keeps its original meaning — everything not yet settled — so an
    // existing saved view does not silently lose rows.
    const unpaid = await ids.asAdmin.query(api.sales.listCommissions, {
      orgId: ids.orgId,
      paidStatus: "unpaid",
    });
    expect([...unpaid.map((r) => r._id)].sort()).toEqual([undecided, decided].sort());

    const paid = await ids.asAdmin.query(api.sales.listCommissions, {
      orgId: ids.orgId,
      paidStatus: "paid",
    });
    expect(paid).toHaveLength(0);
  });

  test("a PENDING draft is not listed — only a completed sale earns a commission decision", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_draft");
    await setMode(t, ids.orgId, "MANUAL");

    const draftId = await ids.asAdmin.mutation(api.sales.createDraft, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      customerId: ids.customerId,
      salespersonId: ids.userId,
      salePrice: 15000,
      saleDate: Date.now(),
      financingType: "CASH",
    });

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(rows.find((r) => r._id === draftId)).toBeUndefined();
  });

  test("AUTO mode is unchanged: a completed sale that computed a zero commission is still not listed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "auto_zero");
    await setMode(t, ids.orgId, "AUTO_MEMBER");
    // A cost basis exists, so AUTO computes a real number — zero, because the
    // member carries no commission rate. That is a computed decision, not a
    // NOT_SET row, and AUTO mode's listing behaviour must not change here.
    await t.run((ctx) => ctx.db.patch(ids.vehicleId, { purchasePrice: 10000 }));

    const saleId = await completedSale(ids);
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBe(0);

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(rows.find((r) => r._id === saleId)).toBeUndefined();
  });

  test("the wider MANUAL listing stays inside the tenant", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const mine = await seedCommissionOrg(t, "iso_mine");
    const theirs = await seedCommissionOrg(t, "iso_theirs");
    await setMode(t, mine.orgId, "MANUAL");
    await setMode(t, theirs.orgId, "MANUAL");

    const theirSale = await completedSale(theirs);
    const mySale = await completedSale(mine);

    const rows = await mine.asAdmin.query(api.sales.listCommissions, { orgId: mine.orgId });
    expect(rows.map((r) => r._id)).toEqual([mySale]);

    // And the cross-tenant write is refused, not silently applied.
    await expect(
      mine.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: mine.orgId,
        saleId: theirSale,
        commissionAmount: 999,
      })
    ).rejects.toThrow(/not found/i);
    const untouched = await t.run((ctx) => ctx.db.get(theirSale));
    expect(untouched?.commissionAmount).toBeUndefined();
  });

  test("a salesperson without manage:commissions sees only their own rows", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_scope");
    await setMode(t, ids.orgId, "MANUAL");

    const repUserId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "comm_manual_scope_rep",
        email: "scope.rep@example.com",
        name: "Rep Two",
      })
    );
    const repRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: ids.orgId, name: "Rep", permissions: ["view:commissions"] })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: ids.orgId, userId: repUserId, roleId: repRoleId })
    );
    const asRep = t.withIdentity({
      subject: "comm_manual_scope_rep",
      clerkId: "comm_manual_scope_rep",
    });

    const adminSale = await completedSale(ids);

    // The rep asks for somebody else's rows; the server forces the scope back
    // to their own, which is empty.
    const rows = await asRep.query(api.sales.listCommissions, {
      orgId: ids.orgId,
      salespersonId: ids.userId,
    });
    expect(rows).toHaveLength(0);
    expect(rows.find((r) => r._id === adminSale)).toBeUndefined();

    // Reading is allowed; deciding the amount is not.
    await expect(
      asRep.mutation(api.sales.setCommissionAmount, {
        orgId: ids.orgId,
        saleId: adminSale,
        commissionAmount: 100,
      })
    ).rejects.toThrow();
  });

  test("a cancelled sale cannot be given a commission, and is not listed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_cancel");
    await setMode(t, ids.orgId, "MANUAL");

    const saleId = await completedSale(ids);
    await t.run((ctx) => ctx.db.patch(saleId, { status: "CANCELLED" }));

    await expect(
      ids.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: ids.orgId,
        saleId,
        commissionAmount: 400,
      })
    ).rejects.toThrow(/cancelled sale/i);

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(rows.find((r) => r._id === saleId)).toBeUndefined();
  });

  test("a negative amount is rejected instead of being silently clamped to zero", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_negative");
    await setMode(t, ids.orgId, "MANUAL");
    const saleId = await completedSale(ids);

    await expect(
      ids.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: ids.orgId,
        saleId,
        commissionAmount: -500,
      })
    ).rejects.toThrow(/negative/i);

    // Pre-fix `Math.max(0, -500)` stored 0 — a decision nobody made, and one
    // that would silently move the row out of the review queue.
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBeUndefined();
  });

  test("a paid commission leaves the editable set", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_paid");
    await setMode(t, ids.orgId, "MANUAL");
    const saleId = await completedSale(ids);

    await ids.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: ids.orgId,
      saleId,
      commissionAmount: 400,
    });
    await ids.asAdmin.mutation(api.sales.markCommissionPaid, {
      orgId: ids.orgId,
      saleId,
      paymentMethod: "CASH",
    });

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    const row = rows.find((r) => r._id === saleId);
    expect(row?.commissionStatus).toBe("PAID");
    expect(row?.canSetAmount).toBe(false);

    await expect(
      ids.asAdmin.mutation(api.sales.setCommissionAmount, {
        orgId: ids.orgId,
        saleId,
        commissionAmount: 900,
      })
    ).rejects.toThrow(/paid commission/i);
  });

  test("an undecided row cannot be marked paid — there is nothing to pay", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_paynotset");
    await setMode(t, ids.orgId, "MANUAL");
    const saleId = await completedSale(ids);

    await expect(
      ids.asAdmin.mutation(api.sales.markCommissionPaid, {
        orgId: ids.orgId,
        saleId,
        paymentMethod: "CASH",
      })
    ).rejects.toThrow(/no commission amount/i);

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionPaidAt).toBeUndefined();
  });

  test("a soft-deleted completed sale never enters the review queue", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedCommissionOrg(t, "manual_deleted");
    await setMode(t, ids.orgId, "MANUAL");
    const saleId = await completedSale(ids);
    await t.run((ctx) => ctx.db.patch(saleId, { isDeleted: true, deletedAt: Date.now() }));

    const rows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(rows.find((r) => r._id === saleId)).toBeUndefined();
  });
});

/**
 * The point of opening the entry point is that the money actually reaches the
 * salesperson. This walks the full path the change makes reachable for the
 * first time — undecided sale → hand-entered amount → payroll run → payment —
 * and proves the amount is settled exactly once.
 */
describe("MANUAL entry point through to payroll settlement", () => {
  async function seedPayrollCapableOrg(
    t: ReturnType<typeof convexTestWithComponents>,
    suffix: string
  ) {
    const ids = await seedCommissionOrg(t, suffix, [
      "create:sales",
      "view:sales",
      "view:vehicles",
      "view:commissions",
      "manage:commissions",
      "view:payroll",
      "manage:payroll",
    ]);
    await t.run(async (ctx) => {
      // Owner role: exempt from the self-beneficiary separation-of-duties guard,
      // so a one-person dealership can approve and pay its own run.
      // `ctx.db` is widened to a generic data model inside a helper typed off
      // `ReturnType<typeof convexTestWithComponents>`, so `.withIndex` does not
      // typecheck here — collect and filter instead.
      const membership = (await ctx.db.query("memberships").collect()).find(
        (m: any) => m.orgId === ids.orgId && m.userId === ids.userId
      );
      await ctx.db.patch(membership!.roleId, { isSystemOwnerRole: true });
      await ctx.db.insert("orgSettings", {
        orgId: ids.orgId,
        currency: "USD",
        currencySymbol: "$",
        enabledPaymentTypes: [],
        commissionMode: "MANUAL",
      });
    });
    return ids;
  }

  test("a hand-entered commission is swept into a run, paid once, and never swept again", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedPayrollCapableOrg(t, "manual_payroll");

    const saleDate = Date.UTC(2026, 6, 15); // 2026-07-15
    const saleId = await ids.asAdmin.mutation(api.sales.create, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      customerId: ids.customerId,
      salespersonId: ids.userId,
      salePrice: 15000,
      saleDate,
      status: "COMPLETED",
      financingType: "CASH",
    });

    // Before the amount is decided, payroll has nothing to sweep.
    const beforeRows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(beforeRows.find((r) => r._id === saleId)?.commissionStatus).toBe("NOT_SET");
    await expect(
      ids.asAdmin.mutation(api.payroll.createRun, {
        orgId: ids.orgId,
        periodYear: 2026,
        periodMonth: 7,
      })
    ).rejects.toThrow();

    await ids.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: ids.orgId,
      saleId,
      commissionAmount: 250,
    });

    const runId = await ids.asAdmin.mutation(api.payroll.createRun, {
      orgId: ids.orgId,
      periodYear: 2026,
      periodMonth: 7,
    });
    const items = await ids.asAdmin.query(api.payroll.listRunItems, { orgId: ids.orgId, runId });
    expect(items).toHaveLength(1);
    // USD has scale 2, so 250.00 is 25000 minor units — integer arithmetic all
    // the way through, no floating-point drift.
    expect(items[0].commissionMinor).toBe(25000);
    expect(items[0].commissionSaleIds).toEqual([saleId]);
    expect(items[0].grossMinor).toBe(25000);

    await ids.asAdmin.mutation(api.payroll.approveRun, { orgId: ids.orgId, runId });
    await ids.asAdmin.mutation(api.payroll.payRun, { orgId: ids.orgId, runId, method: "CASH" });

    const paid = await t.run((ctx) => ctx.db.get(saleId));
    expect(paid?.commissionPaidAt).toBeTypeOf("number");
    expect(paid?.commissionAmount).toBe(250);

    const afterRows = await ids.asAdmin.query(api.sales.listCommissions, { orgId: ids.orgId });
    expect(afterRows.find((r) => r._id === saleId)?.commissionStatus).toBe("PAID");

    // The next period must not find it again — a settled commission is gone
    // from the unpaid population, so the run has nothing to build.
    await expect(
      ids.asAdmin.mutation(api.payroll.createRun, {
        orgId: ids.orgId,
        periodYear: 2026,
        periodMonth: 8,
      })
    ).rejects.toThrow();

    // Exactly one payslip payment event for the whole lifecycle.
    const payEvents = await t.run(async (ctx) =>
      (await ctx.db.query("pendingAccountingEvents").collect()).filter(
        (e) => e.orgId === ids.orgId && e.idempotencyKey.startsWith("payroll_paid_")
      )
    );
    expect(payEvents).toHaveLength(1);
  });

  test("paying a commission directly first means payroll cannot pay it again", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const ids = await seedPayrollCapableOrg(t, "manual_direct");

    const saleId = await ids.asAdmin.mutation(api.sales.create, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      customerId: ids.customerId,
      salespersonId: ids.userId,
      salePrice: 15000,
      saleDate: Date.UTC(2026, 6, 10),
      status: "COMPLETED",
      financingType: "CASH",
    });
    await ids.asAdmin.mutation(api.sales.setCommissionAmount, {
      orgId: ids.orgId,
      saleId,
      commissionAmount: 250,
    });
    await ids.asAdmin.mutation(api.sales.markCommissionPaid, {
      orgId: ids.orgId,
      saleId,
      paymentMethod: "CASH",
    });

    await expect(
      ids.asAdmin.mutation(api.payroll.createRun, {
        orgId: ids.orgId,
        periodYear: 2026,
        periodMonth: 7,
      })
    ).rejects.toThrow();
  });
});
