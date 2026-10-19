import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// The pilot switch is ON in the build (convex/dealCommissionsPilot.test.ts pins
// that). These tests exercise the certified-by-test behaviour with it off.
vi.mock("./utils/dealCommissionLines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/dealCommissionLines")>()),
  DEAL_COMMISSION_LINES_PILOT_DISABLED: false,
}));

const ADMIN = ["view:commissions", "manage:commissions", "view:sales", "create:sales", "view:vehicles", "edit:sales"];

async function seed(
  t: ReturnType<typeof convexTestWithComponents>,
  suffix: string,
  permissions: string[] = ADMIN,
  currency = "JOD"
) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() }));
  const mkUser = (name: string) =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: `${name}_${suffix}`, email: `${name}.${suffix}@example.com`, name });
      return userId;
    });
  const userId = await mkUser("admin");
  const buyerAgent = await mkUser("buyer");
  const executor = await mkUser("exec");
  const outsider = await mkUser("outsider");
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Admin", permissions }));
  for (const member of [userId, buyerAgent, executor]) {
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: member, roleId }));
  }
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency, currencySymbol: currency, enabledPaymentTypes: [], commissionMode: "MANUAL" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN-${suffix}`, make: "Kia", model: "K5", year: 2024, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 15000, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", email: `${suffix}@example.com` })
  );
  const asAdmin = t.withIdentity({ subject: `admin_${suffix}`, clerkId: `admin_${suffix}` });
  const saleId = await asAdmin.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  return { orgId, userId, buyerAgent, executor, outsider, saleId, asAdmin };
}

describe("dealCommissions: several lines on one deal", () => {
  test("the owner's example: purchase 50 + sale 50 + execution 25 JOD totals 125 JOD", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "example");
    // The salesperson's sale commission lives on the sale row (existing path).
    await s.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId: s.saleId, commissionAmount: 50 });
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 50,
    });
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "EXECUTION", employeeId: s.executor, amount: 25, note: "Dar Al Tamweel file",
    });

    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.currency).toBe("JOD");
    expect(view.salesperson.amountMinor).toBe(50_000);
    expect(view.lines.map((l) => [l.kind, l.amountMinor, l.employeeName])).toEqual([
      ["PURCHASE", 50_000, "buyer"],
      ["EXECUTION", 25_000, "exec"],
    ]);
    expect(view.totalMinor).toBe(125_000);
    expect(view.salePending).toBe(false);
  });

  test("an undecided sale commission is pending, not zero", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "pending");
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 10,
    });
    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.salePending).toBe(true);
    expect(view.salesperson.amountMinor).toBeNull();
    expect(view.totalMinor).toBe(10_000);
  });

  test("a line posts nothing to the ledger and leaves the sale commission untouched", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "noledger");
    const before = await t.run(async (ctx) => ({
      events: (await ctx.db.query("accountingEvents").collect()).length,
      sale: (await ctx.db.get(s.saleId))?.commissionAmount ?? null,
    }));
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "EXECUTION", employeeId: s.executor, amount: 25,
    });
    const after = await t.run(async (ctx) => ({
      events: (await ctx.db.query("accountingEvents").collect()).length,
      sale: (await ctx.db.get(s.saleId))?.commissionAmount ?? null,
    }));
    expect(after).toEqual(before);
  });

  test("removing a line keeps the row for history and drops it from the total", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "remove");
    const lineId = await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 40,
    });
    await s.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: s.orgId, lineId });
    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.lines).toEqual([]);
    expect(view.totalMinor).toBe(0);
    const rows = await t.run((ctx) => ctx.db.query("dealCommissionLines").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].removedAt).toBeTypeOf("number");
    // And it can be registered again.
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 45,
    });
  });
});

describe("dealCommissions: refusals", () => {
  async function addArgs(s: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) {
    return { orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE" as const, employeeId: s.buyerAgent, amount: 10, ...over };
  }

  test.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], [10.0001]])("amount %s is refused", async (amount) => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, `amt${String(amount).replace(/\W/g, "")}`);
    await expect(s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s, { amount }))).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("dealCommissionLines").collect())).toHaveLength(0);
  });

  test("the same employee and type twice is refused (double-click guard)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "dup");
    await s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s));
    await expect(s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s))).rejects.toThrow(/already has a commission/);
  });

  test("an employee outside the organization is refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "outsider");
    await expect(
      s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s, { employeeId: s.outsider }))
    ).rejects.toThrow(/not an active member/);
  });

  test("another organization's sale is not found", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const a = await seed(t, "orgA");
    const b = await seed(t, "orgB");
    await expect(
      a.asAdmin.mutation(api.dealCommissions.addLine, { ...(await addArgs(a)), saleId: b.saleId })
    ).rejects.toThrow(/Sale not found/);
    await expect(a.asAdmin.query(api.dealCommissions.forSale, { orgId: a.orgId, saleId: b.saleId })).rejects.toThrow(/Sale not found/);
  });

  test("a caller without manage:commissions cannot write, and without view:commissions cannot read", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const viewer = await seed(t, "viewer", ["view:commissions", "view:sales", "create:sales", "view:vehicles"]);
    await expect(viewer.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(viewer))).rejects.toThrow(/Forbidden/);
    const view = await viewer.asAdmin.query(api.dealCommissions.forSale, { orgId: viewer.orgId, saleId: viewer.saleId });
    expect(view.canManage).toBe(false);

    const blind = await seed(t, "blind", ["view:sales", "create:sales", "view:vehicles"]);
    await expect(
      blind.asAdmin.query(api.dealCommissions.forSale, { orgId: blind.orgId, saleId: blind.saleId })
    ).rejects.toThrow(/Forbidden/);
  });

  test("a cancelled sale cannot be given a line, and its total counts as zero", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "cancelled");
    await s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s));
    await t.run((ctx) => ctx.db.patch(s.saleId, { status: "CANCELLED" }));
    await expect(
      s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s, { kind: "EXECUTION", employeeId: s.executor }))
    ).rejects.toThrow(/cancelled sale/);
    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.totalMinor).toBe(0);
  });

  test("a 3-decimal amount is exact in JOD and refused in USD", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const jod = await seed(t, "jod3");
    await jod.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(jod, { amount: 12.345 }));
    const view = await jod.asAdmin.query(api.dealCommissions.forSale, { orgId: jod.orgId, saleId: jod.saleId });
    expect(view.totalMinor).toBe(12_345);

    const usd = await seed(t, "usd3", ADMIN, "USD");
    await expect(usd.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(usd, { amount: 12.345 }))).rejects.toThrow(/at most 2 decimals/);
  });

  test("writes are audited", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "audit");
    const lineId = await s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s));
    await s.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: s.orgId, lineId });
    const actions = (await t.run((ctx) => ctx.db.query("financialAuditLog").collect())).map((r) => r.actionType);
    expect(actions).toEqual(expect.arrayContaining(["ADD_DEAL_COMMISSION_LINE", "REMOVE_DEAL_COMMISSION_LINE"]));
  });
});
