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
  "edit:sales",
  "view:sales",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
  "view:finance",
  "register:vehicle_handover",
  "register:expected_payment",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
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

async function openAccountingPeriod(asUser: any, orgId: any) {
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
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
      expect(deposit?.amountMinor).toBe(1_500_000);
      expect(deposit?.currency).toBe("JOD");
      expect(deposit?.method).toBe("CASH");
      expect(deposit?.canonicalPaymentId).toBeTruthy();
      const canonicalPayment = deposit?.canonicalPaymentId
        ? await ctx.db.get(deposit.canonicalPaymentId)
        : null;
      expect(canonicalPayment?.direction).toBe("IN");
      expect(canonicalPayment?.method).toBe("CASH");
      expect(canonicalPayment?.amountMinor).toBe(1_500_000);

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("RESERVED");

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(tx?.category).toBe("DEPOSIT");
      expect(tx?.type).toBe("IN");
      expect(tx?.amount).toBe(1500);
      expect(tx?.depositId).toBe(depositId);
      expect(tx?.description).toContain("Deposit for quote");
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

  test("rejects non-positive and sub-minor deposit amounts", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 0 })
    ).rejects.toThrow(/greater than 0/i);

    await expect(
      asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 0.0001 })
    ).rejects.toThrow(/decimal places|minor-unit/i);
  });

  test("rejects deposits in a currency different from the organization currency", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, {
        orgId,
        quoteId,
        amount: 100,
        currency: "USD",
      })
    ).rejects.toThrow(/organization currency/i);
  });

  test("caps cumulative active deposits at the quote amount", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);

    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 21_000 });

    await expect(
      asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1_001 })
    ).rejects.toThrow(/cannot exceed the quote amount/i);
  });

  test("rejects idempotency key reuse with different deposit content", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);

    await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 1000,
      idempotencyKey: "deposit_reuse",
    });

    await expect(
      asUser.mutation(api.deposits.create, {
        orgId,
        quoteId,
        amount: 1001,
        idempotencyKey: "deposit_reuse",
      })
    ).rejects.toThrow(/different request content/i);
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
      expect(outTx?.depositId).toBe(depositId);
      expect(outTx?.description).toContain("Deposit refund");
      expect(outTx?.description).toContain(quoteId.toString());

      const refundPayment = await ctx.db
        .query("collectionPayments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .filter((q) => q.eq(q.field("direction"), "OUT"))
        .first();
      expect(refundPayment?.canonicalPaymentId).toBeTruthy();
      const canonicalRefund = refundPayment?.canonicalPaymentId
        ? await ctx.db.get(refundPayment.canonicalPaymentId)
        : null;
      expect(canonicalRefund?.direction).toBe("OUT");
      expect(canonicalRefund?.method).toBe("OTHER");
    });
  });

  test("ledger enrichment uses each transaction's exact deposit link", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const firstQuoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const firstDepositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId: firstQuoteId,
      amount: 1500,
    });

    const secondCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Saleh" })
    );
    const secondQuoteId = await makeQuote(t, asUser, orgId, secondCustomerId, vehicleId);
    const secondDepositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId: secondQuoteId,
      amount: 1500,
    });

    const ledger = await asUser.query(api.transactions.list, {
      orgId,
      paginationOpts: { cursor: null, numItems: 10 },
    });
    const depositRows = ledger.page.filter((row) => row.category === "DEPOSIT");
    const rowByDepositId = new Map(depositRows.map((row) => [row.depositId, row]));

    expect(rowByDepositId.get(firstDepositId)?.quoteReference).toBe(firstQuoteId.toString());
    expect(rowByDepositId.get(firstDepositId)?.customerName).toBe("Nora Khaled");
    expect(rowByDepositId.get(secondDepositId)?.quoteReference).toBe(secondQuoteId.toString());
    expect(rowByDepositId.get(secondDepositId)?.customerName).toBe("Omar Saleh");
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

  test("FORFEITED posts a deposit forfeiture accounting event when accounting is open", async () => {
    const { orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    await openAccountingPeriod(asUser, orgId);
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { orgId, depositId, resolution: "FORFEITED" });

    const events = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId,
      sourceType: "deposits",
      sourceId: depositId.toString(),
    });
    const forfeiture = events.find((event) => event.eventType === "DEPOSIT_FORFEITED");
    expect(forfeiture).toBeTruthy();
    expect(forfeiture?.status).toBe("POSTED");
  });
});

describe("deposits.voidDeposit", () => {
  test("marks deposit VOIDED, releases vehicle hold, and soft-deletes the original IN transaction", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.voidDeposit, {
      orgId,
      depositId,
      reason: "Created in error",
    });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("VOIDED");
      expect(deposit?.isDeleted).toBe(true);
      expect(deposit?.holdActive).toBe(false);
      expect(deposit?.notes).toBe("Created in error");

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("AVAILABLE");

      // No OUT transaction — a void erases the original IN rather than
      // adding an offsetting OUT (which would look like a refund).
      const outTx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("type"), "OUT"))
        .first();
      expect(outTx).toBeNull();

      // Original IN transaction is soft-deleted.
      const inTx = await ctx.db
        .query("transactions")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .filter((q) => q.eq(q.field("depositId"), depositId))
        .first();
      expect(inTx?.isDeleted).toBe(true);
    });
  });

  test("void unwinds the canonical payment, mirror collection payment, and GL posting", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    await openAccountingPeriod(asUser, orgId);
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.voidDeposit, {
      orgId,
      depositId,
      reason: "Recorded in error",
    });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("VOIDED");

      const canonicalPayment = deposit?.canonicalPaymentId
        ? await ctx.db.get(deposit.canonicalPaymentId)
        : null;
      expect(canonicalPayment?.status).toBe("VOIDED");

      const mirrorPayment = await ctx.db
        .query("collectionPayments")
        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))
        .filter((q) => q.eq(q.field("reference"), `Deposit ${depositId}`))
        .unique();
      expect(mirrorPayment?.status).toBe("VOIDED");
      expect(mirrorPayment?.voidedBy).toBeTruthy();
    });

    const events = await asUser.query(api.accountingLedger.listAccountingEvents, {
      orgId,
      sourceType: "deposits",
      sourceId: depositId.toString(),
    });
    const received = events.find((event) => event.eventType === "DEPOSIT_RECEIVED");
    expect(received?.status).toBe("REVERSED");
  });

  test("rejects void on an already-resolved deposit", async () => {
    const { orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { orgId, depositId, resolution: "REFUNDED" });

    await expect(
      asApprover.mutation(api.deposits.voidDeposit, { orgId, depositId })
    ).rejects.toThrow(/HELD/i);
  });

  test("voided deposits are excluded from the cumulative deposit cap", async () => {
    const { orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 21000 });

    await asApprover.mutation(api.deposits.voidDeposit, { orgId, depositId });

    await expect(
      asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 21000 })
    ).resolves.toBeDefined();
  });
});

describe("deposits multi-vehicle holds", () => {
  async function makeMultiVehicleQuote(
    t: any,
    asUser: any,
    orgId: any,
    customerId: any,
    primaryVehicleId: any,
    secondVehicleId: any
  ) {
    return await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId: primaryVehicleId,
      vehicleItems: [
        { vehicleId: primaryVehicleId, unitPrice: 22000 },
        { vehicleId: secondVehicleId, unitPrice: 18000 },
      ],
      mode: "CASH",
      vehiclePrice: 40000,
      downPayment: 0,
      termMonths: 0,
    });
  }

  async function makeSecondVehicle(t: any, orgId: any) {
    return await t.run((ctx: any) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A444444",
        make: "Toyota",
        model: "Camry",
        year: 2022,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 800,
        sellingPrice: 18000,
        status: "AVAILABLE",
      })
    );
  }

  test("recording a deposit on a multi-vehicle quote holds every vehicle, not just the primary", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);

    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 5000 });

    await t.run(async (ctx) => {
      const primary = await ctx.db.get(vehicleId);
      const secondary = await ctx.db.get(secondVehicleId);
      expect(primary?.status).toBe("RESERVED");
      expect(secondary?.status).toBe("RESERVED");
    });
  });

  test("releasing a multi-vehicle deposit restores every held vehicle to AVAILABLE", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 5000 });

    await asApprover.mutation(api.deposits.release, { orgId, depositId, resolution: "REFUNDED" });

    await t.run(async (ctx) => {
      const primary = await ctx.db.get(vehicleId);
      const secondary = await ctx.db.get(secondVehicleId);
      expect(primary?.status).toBe("AVAILABLE");
      expect(secondary?.status).toBe("AVAILABLE");
    });
  });

  test("voiding a multi-vehicle deposit restores every held vehicle to AVAILABLE", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 5000 });

    await asApprover.mutation(api.deposits.voidDeposit, { orgId, depositId, reason: "test" });

    await t.run(async (ctx) => {
      const primary = await ctx.db.get(vehicleId);
      const secondary = await ctx.db.get(secondVehicleId);
      expect(primary?.status).toBe("AVAILABLE");
      expect(secondary?.status).toBe("AVAILABLE");
    });
  });

  test("completing a multi-vehicle quote's sale resolves the deposit and correctly sells every vehicle (none stay stuck RESERVED)", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 5000 });

    await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });

    await t.run(async (ctx) => {
      const primary = await ctx.db.get(vehicleId);
      const secondary = await ctx.db.get(secondVehicleId);
      expect(primary?.status).toBe("SOLD");
      expect(secondary?.status).toBe("SOLD");

      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("APPLIED");
      expect(deposit?.holdActive).toBe(false);
    });
  });

  test("cancelling every sale row of a multi-vehicle deal reactivates every held vehicle, not just the primary", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 5000 });

    const saleIds = await asUser.mutation(api.sales.completeFromQuote, { orgId, quoteId });

    // Unwinding the whole deal cancels each vehicle's own sale row in turn.
    // The first cancellation reactivates the shared deposit (APPLIED -> HELD)
    // and every depositVehicleHolds row; the second sale's own vehicle must
    // still come back on hold even though the deposit itself no longer
    // transitions again on this second call.
    for (const saleId of saleIds) {
      await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });
    }

    await t.run(async (ctx) => {
      const primary = await ctx.db.get(vehicleId);
      const secondary = await ctx.db.get(secondVehicleId);
      expect(primary?.status).toBe("RESERVED");
      expect(secondary?.status).toBe("RESERVED");

      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("HELD");
      expect(deposit?.holdActive).toBe(true);
    });
  });

  test("listByVehicle surfaces a multi-vehicle deposit for its secondary vehicle too", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 5000 });

    const secondaryDeposits = await asUser.query(api.deposits.listByVehicle, {
      orgId,
      vehicleId: secondVehicleId,
    });
    expect(secondaryDeposits.map((d) => d._id)).toContain(depositId);

    const primaryDeposits = await asUser.query(api.deposits.listByVehicle, {
      orgId,
      vehicleId,
    });
    expect(primaryDeposits.map((d) => d._id)).toContain(depositId);
  });
});

describe("sales.create resolves deposits", () => {
  test("a sale created from a quote resolves its deposit to APPLIED and excludes it from the sale transaction amount", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 2000 });

    const saleId = await asUser.mutation(api.sales.create, {
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

      const sale = await ctx.db.get(saleId);
      expect(sale?.canonicalReceivableDocumentId).toBeTruthy();
      const allocations = sale?.canonicalReceivableDocumentId
        ? await ctx.db
            .query("paymentAllocations")
            .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", sale.canonicalReceivableDocumentId!))
            .collect()
        : [];
      expect(allocations.some((allocation) => allocation.amountMinor === 2_000_000)).toBe(true);
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
    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("APPLIED");

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");
    });
  });
});
