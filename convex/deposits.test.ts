import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_dep_1", email: "dep@test.com", name: "Deposit User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_dep_approver", email: "dep.approver@test.com", name: "Deposit Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asUser = t.withIdentity({ subject: "user_dep_1", clerkId: "user_dep_1" });
  const asApprover = t.withIdentity({ subject: "user_dep_approver", clerkId: "user_dep_approver" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A333333",
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 500,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Nora", lastName: "Khaled" })
  );

  return { t, orgId, userId, approverId, customerId, vehicleId, asUser, asApprover };
}

async function makeQuote(t: any, asUser: any, orgId: any, customerId: any, vehicleId: any, leadId?: any) {
  return await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    leadId,
    vehiclePrice: 22000,
    downPayment: 2000,
    termMonths: 0,
  });
}

describe("deposits.create", () => {
  test("places a vehicle on hold and records a DEPOSIT transaction", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);

    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 1500,
    });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("HELD");
      expect(deposit?.holdActive).toBe(true);
      expect(deposit?.amount).toBe(1500);

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("RESERVED");

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(tx?.category).toBe("DEPOSIT");
      expect(tx?.type).toBe("IN");
      expect(tx?.amount).toBe(1500);
      expect(tx?.description).toContain("عربون للعرض");
      expect(tx?.description).toContain(quoteId.toString());
      expect(tx?.description).toContain("Mazda CX-5");
      expect(tx?.description).toContain("Nora Khaled");
    });
  });

  test("a second deposit from a different quote on the same vehicle does not error (soft warning, not a hard block)", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId1 = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    await asUser.mutation(api.deposits.create, { orgId, quoteId: quoteId1, amount: 1000 });

    const customer2Id = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Saleh" })
    );
    const quoteId2 = await makeQuote(t, asUser, orgId, customer2Id, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, { orgId, quoteId: quoteId2, amount: 2000 })
    ).resolves.toBeDefined();

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("RESERVED");
    });
  });
});

describe("deposits.release", () => {
  test("REFUNDED releases the vehicle hold and books a reversing OUT transaction", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { orgId, depositId, resolution: "REFUNDED" });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("REFUNDED");
      expect(deposit?.holdActive).toBe(false);

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("AVAILABLE");

      const outTx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("type"), "OUT"))
        .first();
      expect(outTx?.amount).toBe(1500);
      expect(outTx?.category).toBe("DEPOSIT");
      expect(outTx?.description).toContain("استرداد عربون");
      expect(outTx?.description).toContain(quoteId.toString());
    });
  });

  test("FORFEITED releases the hold without a reversing transaction", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { orgId, depositId, resolution: "FORFEITED" });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("FORFEITED");

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("AVAILABLE");

      const outTx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("type"), "OUT"))
        .first();
      expect(outTx).toBeNull();
    });
  });
});

describe("sales.create resolves deposits", () => {
  test("a sale created from a quote resolves its deposit to APPLIED and excludes it from the sale transaction amount", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 2000 });

    await asUser.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 22000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      quoteId,
    });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("APPLIED");
      expect(deposit?.holdActive).toBe(false);

      const saleTx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("category"), "VEHICLE_SALE"))
        .first();
      // 22000 sale price minus the 2000 already booked as a DEPOSIT transaction
      expect(saleTx?.amount).toBe(20000);
    });
  });
});

describe("applications deposit hooks", () => {
  test("rejecting an application releases the vehicle hold but leaves the deposit HELD", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "REJECTED" });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("HELD");
      expect(deposit?.holdActive).toBe(false);

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("AVAILABLE");
    });
  });

  test("finalizing a deal resolves the deposit to APPLIED", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("APPLIED");

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");
    });
  });
});
