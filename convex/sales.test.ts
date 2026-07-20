import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Mock the rate limiter so we don't need to register the Convex component
vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedSalesOrg(t: ReturnType<typeof convexTest>, suffix: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Test Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}`,
      email: `${suffix}@example.com`,
      name: "Test User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Admin",
      permissions: [
        "create:sales",
        "view:sales",
        "edit:sales",
        "delete:sales",
        "create:vehicles",
        "view:vehicles",
        "view:commissions",
        "manage:commissions",
      ],
    })
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
    asAdmin: t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` }),
  };
}

describe("Sales Mutations", () => {
  test("Creating a sale marks the vehicle as SOLD and creates a ledger transaction", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));

    // Provide a mocked getValidatedEnv implementation or mocked ENV since auth/env hooks might run
    // convex-test handles auth simulation differently. Let's just run it as an admin.
    
    // Seed Org
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", { 
        name: "Test Dealer", 
        createdAt: Date.now() 
      });
    });

    // Seed User
    const userId = await t.run(async (ctx) => {
      return await ctx.db.insert("users", {
        clerkId: "user_213",
        email: "test@example.com",
        name: "Test User",
      });
    });

    // Seed Role
    const roleId = await t.run(async (ctx) => {
      return await ctx.db.insert("roles", {
        orgId,
        name: "Admin",
        permissions: [
          "create:sales",
          "view:sales",
          "edit:sales",
          "delete:sales",
          "create:vehicles",
          "view:vehicles",
          "edit:vehicles"
        ],
      });
    });

    // Seed Membership
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        orgId,
        userId,
        roleId,
      });
    });

    // Mock Authentication
    const asAdmin = t.withIdentity({ subject: "user_213", clerkId: "user_213" });

    // Seed Vehicle
    const vehicleId = await t.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A000000",
        make: "Honda",
        model: "Accord",
        year: 2020,
        color: "Black",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 50000,
        sellingPrice: 15000,
        status: "AVAILABLE",
      });
    });

    // Seed Customer
    const customerId = await t.run(async (ctx) => {
      return await ctx.db.insert("customers", {
        orgId,
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      });
    });

    // Act: Create Sale
    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    expect(saleId).toBeDefined();

    // Assert side effects
    await t.run(async (ctx) => {
      // Vehicle should be SOLD
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");

      // Transaction should be recorded
      const tx = await ctx.db.query("transactions")
        .withIndex("by_org", q => q.eq("orgId", orgId))
        .first();
      expect(tx).toBeDefined();
      expect(tx?.amount).toBe(15000);
      expect(tx?.category).toBe("VEHICLE_SALE");
      expect(tx?.type).toBe("IN");
      expect(tx?.customerId).toBe(customerId);
      expect(tx?.description).toContain("Sale of vehicle");
      expect(tx?.description).toContain("Honda Accord");
      expect(tx?.description).toContain("John Doe");
    });
  });

  test("Creating a sale from a quote closes the quote's exact lead as WON", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));

    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_quote_1", email: "quote@example.com", name: "Quote User" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Admin",
        permissions: [
          "create:sales",
          "view:sales",
          "edit:sales",
          "create:vehicles",
          "view:vehicles",
          "edit:vehicles",
        ],
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asAdmin = t.withIdentity({ subject: "user_quote_1", clerkId: "user_quote_1" });

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A111111",
        make: "Honda",
        model: "Civic",
        year: 2021,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 10000,
        sellingPrice: 12000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Jane", lastName: "Smith" })
    );

    // A second, unrelated open lead for the same customer+vehicle pair — the
    // exact leadId match should close ONLY the lead the quote came from,
    // unlike the old fuzzy customerId+vehicleId match which would close both.
    const otherLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Walk-in", stage: "NEW" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Walk-in", stage: "NEGOTIATION" })
    );

    const quoteId = await asAdmin.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      leadId,
      vehiclePrice: 12000,
      downPayment: 2000,
      termMonths: 0,
    });

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 12000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
      quoteId,
    });

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.quoteId).toBe(quoteId);
      expect(sale?.leadId).toBe(leadId);

      const closedLead = await ctx.db.get(leadId);
      expect(closedLead?.stage).toBe("WON");

      const untouchedLead = await ctx.db.get(otherLeadId);
      expect(untouchedLead?.stage).toBe("NEW");
    });
  });

  test("creating a draft sale does not run completion side effects", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "draft_1");

    const saleId = await asAdmin.mutation(api.sales.createDraft, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "PENDING",
      financingType: "CASH",
    });

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.status).toBe("PENDING");
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("AVAILABLE");
      const tx = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(tx).toHaveLength(0);
    });
  });

  test("sale completion must use the explicit completeDraft transition", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "draft_2");

    await expect(
      asAdmin.mutation(api.sales.create, {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 15000,
        saleDate: Date.now(),
        status: "PENDING" as "COMPLETED",
        financingType: "CASH",
      })
    ).rejects.toThrow();

    const saleId = await asAdmin.mutation(api.sales.createDraft, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      financingType: "CASH",
    });

    await expect(asAdmin.mutation(api.sales.update, { orgId, saleId, status: "COMPLETED" })).rejects.toThrow();

    await asAdmin.mutation(api.sales.completeDraft, {
      orgId,
      saleId,
      idempotencyKey: "complete-draft-test",
    });

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.status).toBe("COMPLETED");
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");
      const tx = await ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(tx).toHaveLength(1);
      expect(tx[0].category).toBe("VEHICLE_SALE");
    });
  });

  test("completed sale financial fields and commission amounts are locked", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "locked_1");

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    await expect(asAdmin.mutation(api.sales.update, { orgId, saleId, salePrice: 14000 })).rejects.toThrow(
      /completed sale financial fields are locked/i
    );
    await expect(
      asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 500 })
    ).rejects.toThrow(/commission amounts are locked/i);

    await t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      expect(sale?.salePrice).toBe(15000);
      expect(sale?.commissionAmount).toBeUndefined();
    });
  });
});

describe("C3: automatic commission requires a recorded purchase cost", () => {
  async function setAutoMemberMode(
    t: ReturnType<typeof convexTest>,
    orgId: any,
    userId: any,
    rate: number
  ) {
    await t.run(async (ctx) => {
      const memberships = await ctx.db.query("memberships").collect();
      const m = memberships.find((x: any) => x.orgId === orgId && x.userId === userId);
      await ctx.db.patch(m!._id, { commissionRate: rate });
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "USD",
        currencySymbol: "$",
        enabledPaymentTypes: [],
        commissionMode: "AUTO_MEMBER",
      });
    });
  }

  test("no purchase cost => auto commission is zero (not commissioned on full sale price)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "c3_nocost");
    // AUTO_MEMBER @ 10%, but the seeded vehicle has NO purchasePrice.
    await setAutoMemberMode(t, orgId, userId, 10);

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    // Pre-fix behavior would have been 15000 * 10% = 1500 (commission on the
    // full sale price). With the fix, no cost => no commission.
    expect(sale?.commissionAmount == null || sale?.commissionAmount === 0).toBe(true);
  });

  test("with purchase cost, auto commission still computes on profit", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "c3_cost");
    await setAutoMemberMode(t, orgId, userId, 10);
    await t.run((ctx) => ctx.db.patch(vehicleId, { purchasePrice: 10000 }));

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    // profit = 15000 - 10000 = 5000; 10% => 500
    expect(sale?.commissionAmount).toBe(500);
  });

  test("a ZERO purchase cost is treated as missing, not as a real cost", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "c3_zero");
    await setAutoMemberMode(t, orgId, userId, 10);
    // 0 passes a naive `!= null` check but would commission on ~the full sale
    // price (15000 * 10% = 1500) — exactly what the guard exists to prevent.
    await t.run((ctx) => ctx.db.patch(vehicleId, { purchasePrice: 0 }));

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount == null || sale?.commissionAmount === 0).toBe(true);
  });

  test("a SOURCED vehicle with a sourceCost is commissioned normally (not flagged as missing cost)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "c3_sourced");
    await setAutoMemberMode(t, orgId, userId, 10);
    // SOURCED vehicles carry their cost in sourceCost, not purchasePrice.
    await t.run((ctx) => ctx.db.patch(vehicleId, { sourceType: "SOURCED", sourceCost: 12000 }));

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    // profit = 15000 - 12000 = 3000; 10% => 300. A purchasePrice-only check
    // would wrongly zero this out.
    expect(sale?.commissionAmount).toBe(300);
  });

  test("recalculateCommission books the commission after the missing cost is corrected", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "c3_recalc");
    await setAutoMemberMode(t, orgId, userId, 10);

    // Completes with NO cost => no commission computed, sale flagged.
    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });
    let rows = await asAdmin.query(api.sales.listCommissions, { orgId });
    expect(rows.find((r) => r._id === saleId)?.missingPurchaseCost).toBe(true);

    // Manager fixes the vehicle cost → the row flips to "needs recalculation".
    await t.run((ctx) => ctx.db.patch(vehicleId, { purchasePrice: 10000 }));
    rows = await asAdmin.query(api.sales.listCommissions, { orgId });
    const flagged = rows.find((r) => r._id === saleId);
    expect(flagged?.missingPurchaseCost).toBe(false);
    expect(flagged?.needsRecalculation).toBe(true);

    // Recalculate: computes on profit AND books the accrual completion skipped.
    const result = await asAdmin.mutation(api.sales.recalculateCommission, { orgId, saleId });
    expect(result.commissionAmount).toBe(500);
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBe(500);
    const accrual = await t.run((ctx) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
        )
        .first()
    );
    expect(accrual).not.toBeNull();

    // One-shot: a second recalculation is rejected (amount now exists).
    await expect(
      asAdmin.mutation(api.sales.recalculateCommission, { orgId, saleId })
    ).rejects.toThrow(/already has a commission/i);
  });
});

describe("C1/C2: MANUAL commission lifecycle", () => {
  async function setManualMode(t: ReturnType<typeof convexTest>, orgId: any) {
    await t.run(async (ctx) => {
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "USD",
        currencySymbol: "$",
        enabledPaymentTypes: [],
        commissionMode: "MANUAL",
      });
    });
  }

  test("a manually-set commission survives sale completion (not wiped)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "manual_preserve");
    await setManualMode(t, orgId);

    // Draft, set the commission by hand, then complete.
    const saleId = await asAdmin.mutation(api.sales.createDraft, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      financingType: "CASH",
    });
    await asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 250 });
    await asAdmin.mutation(api.sales.completeDraft, { orgId, saleId, idempotencyKey: "manual-preserve" });

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    // Pre-fix: completion overwrote this with the mode's value (undefined) and
    // the manual amount was lost.
    expect(sale?.status).toBe("COMPLETED");
    expect(sale?.commissionAmount).toBe(250);
  });

  test("a completed, unpaid MANUAL commission is still editable", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "manual_edit");
    await setManualMode(t, orgId);

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });
    // Pre-fix this threw ("Completed sale commission amounts are locked").
    await asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 300 });

    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBe(300);
  });

  test("paying a MANUAL commission recognizes the accrual, not just the payment", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "manual_pay");
    await setManualMode(t, orgId);

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });
    await asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 400 });
    await asAdmin.mutation(api.sales.markCommissionPaid, { orgId, saleId, paymentMethod: "CASH" });

    // A COMMISSION_ACCRUED event must exist (posted or still queued) so the
    // payment clears a real payable instead of pushing it negative. Pre-fix the
    // MANUAL amount could never be set on a completed sale, so payment (and thus
    // any accrual) was unreachable.
    const accrual = await t.run(async (ctx) => {
      const posted = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "sales").eq("sourceId", `commission_${saleId}`)
        )
        .filter((q) => q.eq(q.field("eventType"), "COMMISSION_ACCRUED"))
        .first();
      const pending = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `commission_accrued_${saleId}`)
        )
        .first();
      return posted ?? pending;
    });
    expect(accrual).not.toBeNull();
  });
});

describe("commission accrual lock respects reversals", () => {
  test("a REVERSED accrual no longer locks a MANUAL commission amount", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, vehicleId, customerId, asAdmin } = await seedSalesOrg(t, "rev_unlock");
    await t.run(async (ctx) => {
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "USD",
        currencySymbol: "$",
        enabledPaymentTypes: [],
        commissionMode: "MANUAL",
      });
    });

    const saleId = await asAdmin.mutation(api.sales.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      salePrice: 15000,
      saleDate: Date.now(),
      status: "COMPLETED",
      financingType: "CASH",
    });
    await asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 300 });

    // Simulate a posted accrual: the amount must now be locked.
    const eventId = await t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId,
        eventType: "COMMISSION_ACCRUED",
        sourceType: "sales",
        sourceId: `commission_${saleId}`,
        eventVersion: 1,
        idempotencyKey: `commission_accrued_${saleId}`,
        occurredAt: Date.now(),
        accountingDate: Date.now(),
        currency: "USD",
        payload: {},
        status: "POSTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    await expect(
      asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 400 })
    ).rejects.toThrow(/already recorded in the ledger/i);

    // Reverse the accrual — the lock's own error message says "Reverse it
    // before changing the amount", so a REVERSED accrual must actually unlock.
    await t.run((ctx) => ctx.db.patch(eventId, { status: "REVERSED" }));
    await asAdmin.mutation(api.sales.setCommissionAmount, { orgId, saleId, commissionAmount: 400 });
    const sale = await t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBe(400);
  });
});
