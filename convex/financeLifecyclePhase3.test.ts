import { convexTest, TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedFinanceLifecycleDealer() {
  const t = convexTest(schema, MODULE_GLOB);
  const now = Date.now();

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Finance Lifecycle Dealer", createdAt: now })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "fl3_user",
      email: "fl3@example.com",
      name: "FL3 User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["create:sales", "view:sales", "manage:users"],
    })
  );

  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "USD",
      currencySymbol: "$",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Finance", lastName: "Customer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "FL3VIN001",
      make: "Toyota",
      model: "Corolla",
      year: 2024,
      mileage: 0,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 12000,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );

  const asUser = t.withIdentity({ subject: "fl3_user", clerkId: "fl3_user" });

  async function createQuote() {
    return await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 22000,
        downPayment: 0,
        termMonths: 0,
        status: "ACCEPTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
  }

  async function createHeldDeposit(quoteId: Id<"quotes">, amount: number) {
    return await t.run(async (ctx) => {
      await ctx.db.patch(vehicleId, { status: "RESERVED" as const });
      return await ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        quoteId,
        amount,
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now(),
      });
    });
  }

  async function completeSale(args: { quoteId?: Id<"quotes">; salePrice?: number } = {}) {
    return await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: args.salePrice ?? 22000,
      saleDate: now,
      status: "COMPLETED",
      financingType: "CASH",
      ...(args.quoteId ? { quoteId: args.quoteId } : {}),
    });
  }

  return {
    t,
    orgId,
    customerId,
    vehicleId,
    createQuote,
    createHeldDeposit,
    completeSale,
  };
}

async function listDepositAppliedRecords(
  t: TestConvex<typeof schema>,
  orgId: Id<"organizations">
) {
  return await t.run(async (ctx) => {
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) =>
        q.eq("orgId", orgId).eq("eventType", "DEPOSIT_APPLIED")
      )
      .collect();
    const pending = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
      .filter((q) => q.eq(q.field("eventType"), "DEPOSIT_APPLIED"))
      .collect();

    return [
      ...events.map((event) => ({
        sourceId: event.sourceId,
        payload: event.payload,
      })),
      ...pending.map((event) => ({
        sourceId: event.sourceId,
        payload: event.payload,
      })),
    ];
  });
}

describe("Finance lifecycle phase 3 deposit application hooks", () => {
  test("sale completion with one active quote deposit creates a DEPOSIT_APPLIED record", async () => {
    const { t, orgId, createQuote, createHeldDeposit, completeSale } =
      await seedFinanceLifecycleDealer();
    const quoteId = await createQuote();
    const depositId = await createHeldDeposit(quoteId, 1500);

    await completeSale({ quoteId });

    const appliedRecords = await listDepositAppliedRecords(t, orgId);
    expect(appliedRecords).toHaveLength(1);
    expect(appliedRecords[0].sourceId).toBe(depositId.toString());
    expect(appliedRecords[0].payload).toMatchObject({
      depositId: depositId.toString(),
      amountMinor: 150000,
      currency: "USD",
    });
  });

  test("multiple deposits on the same quote each create a DEPOSIT_APPLIED record", async () => {
    const { t, orgId, createQuote, createHeldDeposit, completeSale } =
      await seedFinanceLifecycleDealer();
    const quoteId = await createQuote();
    const firstDepositId = await createHeldDeposit(quoteId, 1000);
    const secondDepositId = await createHeldDeposit(quoteId, 2500);

    await completeSale({ quoteId });

    const appliedRecords = await listDepositAppliedRecords(t, orgId);
    expect(appliedRecords).toHaveLength(2);
    expect(appliedRecords.map((record) => record.sourceId).sort()).toEqual(
      [firstDepositId.toString(), secondDepositId.toString()].sort()
    );

    await t.run(async (ctx) => {
      const firstDeposit = await ctx.db.get(firstDepositId);
      const secondDeposit = await ctx.db.get(secondDepositId);
      expect(firstDeposit?.status).toBe("APPLIED");
      expect(secondDeposit?.status).toBe("APPLIED");
    });
  });

  test("sale completion without a quote does not create a DEPOSIT_APPLIED record", async () => {
    const { t, orgId, completeSale } = await seedFinanceLifecycleDealer();

    await completeSale();

    const appliedRecords = await listDepositAppliedRecords(t, orgId);
    expect(appliedRecords).toHaveLength(0);
  });

  test("applied deposits total matches the amount subtracted from the sale transaction", async () => {
    const { t, orgId, createQuote, createHeldDeposit, completeSale } =
      await seedFinanceLifecycleDealer();
    const quoteId = await createQuote();
    await createHeldDeposit(quoteId, 1250);
    await createHeldDeposit(quoteId, 2750);

    await completeSale({ quoteId, salePrice: 32000 });

    const appliedRecords = await listDepositAppliedRecords(t, orgId);
    const appliedTotalMinor = appliedRecords.reduce(
      (sum, record) => sum + record.payload.amountMinor,
      0
    );
    const saleTransaction = await t.run(async (ctx) =>
      ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("category"), "VEHICLE_SALE"))
        .first()
    );

    expect(appliedTotalMinor).toBe(400000);
    expect(saleTransaction?.amount).toBe(32000 - appliedTotalMinor / 100);
  });
});
