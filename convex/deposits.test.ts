import { convexTestWithComponents } from "../test-utils/convexTest";
import { registerHandover } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

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
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
  test("rejects OTHER as a deposit method", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500, method: "OTHER" })
    ).rejects.toThrow(/OTHER is not accepted/i);
  });

  test("places a vehicle on hold and records a DEPOSIT transaction", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);

    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(),
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

  test("a second deposit from an UNRELATED quote on the same vehicle is refused (SCRUM-195)", async () => {
    // BEHAVIOUR CHANGED DELIBERATELY, BY OWNER RULING c15589. This used to be a
    // soft warning: a second customer could put money on a car the first
    // customer's deposit was already holding, and the system recorded both.
    // That is the double-sell this authority exists to prevent, so it is now a
    // hard refusal.
    //
    // The assertion is not weakened. It is inverted and then STRENGTHENED: the
    // old version proved only that nothing threw, and never looked at what the
    // second deposit did to the deal that already held the car.
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId1 = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId: quoteId1, amount: 1000 });

    const customer2Id = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Saleh" })
    );
    const quoteId2 = await makeQuote(t, asUser, orgId, customer2Id, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId: quoteId2, amount: 2000 })
    ).rejects.toThrow(/already committed to another deal/i);

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("RESERVED");
      // Refused BEFORE any side effect: one deposit, one root, and the car
      // still belongs to the deal that had it.
      const deposits = await ctx.db.query("deposits").collect();
      expect(deposits.length).toBe(1);
      const roots = await ctx.db.query("commitmentRoots").collect();
      expect(roots.length).toBe(1);
      expect(roots[0].customerId).toEqual(customerId);
    });
  });

  test("rejects non-positive and sub-minor deposit amounts", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 0 })
    ).rejects.toThrow(/greater than 0/i);

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 0.0001 })
    ).rejects.toThrow(/decimal places|minor-unit/i);
  });

  test("rejects deposits in a currency different from the organization currency", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(),
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

    await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 21_000 });

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1_001 })
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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(), orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH" });

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
      expect(canonicalRefund?.method).toBe("CASH");
    });
  });

  test("rejects a refund with no refund method", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await expect(
      asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(), orgId, depositId, resolution: "REFUNDED" })
    ).rejects.toThrow(/refund payment method is required/i);
  });

  test("a BANK_TRANSFER refund credits Bank Account, not Cash on Hand", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    await openAccountingPeriod(asUser, orgId);
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(),
      orgId, depositId, resolution: "REFUNDED", refundMethod: "BANK_TRANSFER",
    });

    const bankAccount = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT")).unique()
    );
    const cashOnHand = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "CASH_ON_HAND")).unique()
    );
    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "deposits").eq("sourceId", depositId.toString()))
        .filter((q) => q.eq(q.field("eventType"), "DEPOSIT_REFUNDED"))
        .first()
    );
    expect(event).not.toBeNull();
    expect(event!.status).toBe("POSTED");
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect()
    );
    expect(lines.find((l) => l.accountId === bankAccount!._id)?.creditMinor).toBe(1_500_000);
    expect(lines.some((l) => l.accountId === cashOnHand!._id)).toBe(false);
  });

  test("a PAYMENT_LINK refund credits Bank Account, not Cash on Hand", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    await openAccountingPeriod(asUser, orgId);
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(),
      orgId, depositId, resolution: "REFUNDED", refundMethod: "PAYMENT_LINK",
    });

    const bankAccount = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT")).unique()
    );
    const cashOnHand = await t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "CASH_ON_HAND")).unique()
    );
    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "deposits").eq("sourceId", depositId.toString()))
        .filter((q) => q.eq(q.field("eventType"), "DEPOSIT_REFUNDED"))
        .first()
    );
    expect(event).not.toBeNull();
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect()
    );
    expect(lines.find((l) => l.accountId === bankAccount!._id)?.creditMinor).toBe(1_500_000);
    expect(lines.some((l) => l.accountId === cashOnHand!._id)).toBe(false);
  });

  test("rejects OTHER as a refund method", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await expect(
      asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(),
        orgId, depositId, resolution: "REFUNDED", refundMethod: "OTHER",
      })
    ).rejects.toThrow(/OTHER is not accepted/i);
  });

  test("ledger enrichment uses each transaction's exact deposit link", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const firstQuoteId = await makeQuote(t, asUser, orgId, customerId, vehicleId);
    const firstDepositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(),
      orgId,
      quoteId: firstQuoteId,
      amount: 1500,
    });

    const secondCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Saleh" })
    );
    // PREMISE CORRECTED, ASSERTION UNTOUCHED (owner ruling c15589). This
    // fixture used to put the second customer's deposit on the SAME vehicle
    // as the first — which SCRUM-195 now refuses, because it is the
    // double-sell the commitment authority exists to prevent. The subject
    // here is ledger enrichment resolving EACH transaction's own deposit
    // link, and that needs two distinct deposits, not two deals on one car.
    // So the second deal gets its own vehicle and the assertions below are
    // unchanged.
    const secondVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A555555",
        make: "Toyota",
        model: "Corolla",
        year: 2022,
        color: "Silver",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 900,
        sellingPrice: 18000,
        status: "AVAILABLE" as const,
        createdAt: Date.now(),
      })
    );
    const secondQuoteId = await makeQuote(t, asUser, orgId, secondCustomerId, secondVehicleId);
    const secondDepositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(),
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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(), orgId, depositId, resolution: "FORFEITED" });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(), orgId, depositId, resolution: "FORFEITED" });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(), orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH" });

    await expect(
      asApprover.mutation(api.deposits.voidDeposit, { orgId, depositId })
    ).rejects.toThrow(/HELD/i);
  });

  test("voided deposits are excluded from the cumulative deposit cap", async () => {
    const { orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await makeQuote(null, asUser, orgId, customerId, vehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 21000 });

    await asApprover.mutation(api.deposits.voidDeposit, { orgId, depositId });

    await expect(
      asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 21000 })
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

  async function makeSecondVehicle(t: any, orgId: any): Promise<Id<"vehicles">> {
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

    await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5000 });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5000 });

    await asApprover.mutation(api.deposits.release, { idempotencyKey: crypto.randomUUID(), orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH" });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5000 });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5000 });

    // A quote with more than one car cannot be finalized until somebody says
    // how its one deposit divides between them — the split is the customer's
    // decision, not something the prices imply. See depositAllocation.ts.
    await asUser.mutation(api.deposits.allocateToVehicles, {
      orgId,
      quoteId,
      allocations: [
        { vehicleId, amount: 3000 },
        { vehicleId: secondVehicleId, amount: 2000 },
      ],
    });

    await asUser.mutation(api.sales.completeFromQuote, { idempotencyKey: crypto.randomUUID(), orgId, quoteId });

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

  test("cancelling every sale row of a multi-vehicle deal frees every vehicle and leaves each share awaiting a decision", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5000 });
    await asUser.mutation(api.deposits.allocateToVehicles, {
      orgId,
      quoteId,
      allocations: [
        { vehicleId, amount: 3000 },
        { vehicleId: secondVehicleId, amount: 2000 },
      ],
    });

    const saleIds = await asUser.mutation(api.sales.completeFromQuote, { idempotencyKey: crypto.randomUUID(), orgId, quoteId });

    // Unwinding the whole deal cancels each vehicle's own sale row in turn, and
    // each cancellation touches only its own car.
    //
    // This used to put every hold on the quote back on, from whichever
    // cancellation ran first — so cancelling car A re-reserved car B while B's
    // sale was still live. Now each share lands in RELEASED_AWAITING_DECISION
    // and its car comes off hold: the money is not committed to anything until
    // somebody says what happens to it, and the car is free to be sold to
    // somebody else in the meantime.
    for (const saleId of saleIds) {
      await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });
    }

    await t.run(async (ctx) => {
      const primary = await ctx.db.get(vehicleId);
      const secondary = await ctx.db.get(secondVehicleId);
      expect(primary?.status).toBe("AVAILABLE");
      expect(secondary?.status).toBe("AVAILABLE");

      // The money is back on the books as held — it was never refunded.
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("HELD");
      expect(deposit?.holdActive).toBe(true);

      const holds = (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.depositId === depositId
      );
      expect(holds).toHaveLength(2);
      expect(holds.every((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION")).toBe(true);
      // Each slice keeps its own amount, so neither car's share drifted onto
      // the other during the unwind.
      expect(holds.map((h) => h.allocatedAmountMinor).sort((a, b) => a! - b!)).toEqual([
        2_000_000, 3_000_000,
      ]);

      // Both applications were backed out, each against its own journal.
      const applications = (await ctx.db.query("depositApplications").collect()).filter(
        (a) => a.depositId === depositId
      );
      expect(applications).toHaveLength(2);
      expect(applications.every((a) => a.status === "REVERSED")).toBe(true);
    });
  });

  test("listByVehicle surfaces a multi-vehicle deposit for its secondary vehicle too", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const secondVehicleId = await makeSecondVehicle(t, orgId);
    const quoteId = await makeMultiVehicleQuote(t, asUser, orgId, customerId, vehicleId, secondVehicleId);
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 5000 });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 2000 });

    const saleId = await asUser.mutation(api.sales.create, { idempotencyKey: crypto.randomUUID(),
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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

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
    const depositId = await asUser.mutation(api.deposits.create, { idempotencyKey: crypto.randomUUID(), orgId, quoteId, amount: 1500 });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await registerHandover(asUser, api, orgId, applicationId);
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId });

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("APPLIED");

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");
    });
  });
});

/**
 * SCRUM-313 — the GENERATION-AWARE command identity for `deposits.release`.
 *
 * This command is the one place in the protected topology where neither naive
 * identity works, and both wrong answers have already shipped:
 *
 *   - a key derived from (deposit, resolution) and held forever made the SECOND
 *     genuine payout replay the first one's stored result: no money moved, and
 *     the operator was told the customer had been refunded;
 *   - a key minted per ATTEMPT escaped that by surrendering retry safety, so a
 *     lost response plus one more tap is two payouts.
 *
 * The reason content cannot decide it is economic, not incidental: `release`
 * pays out whatever is currently FREE on the row. Two genuine payouts of the
 * same deposit with the same resolution and the same refund method are
 * byte-identical requests — and, as the tests below execute rather than assume,
 * that is a REAL operational sequence: the free part is refunded today, and the
 * rest once the car it was held against falls away.
 *
 * What separates them is state the SERVER owns: `releaseCount`, incremented
 * inside the same `ctx.db.patch` that moves the money
 * (`convex/utils/depositHelpers.ts`). The client puts that observed generation
 * in the intent, so:
 *
 *   same generation + same decision -> same key   -> a retry is deduped;
 *   an advanced generation          -> a new key  -> a genuine payout proceeds.
 *
 * EVIDENCE BOUNDARY: `convex-test` is repository behaviour. It serialises
 * everything and models NO OCC, so nothing here proves anything about two
 * CONCURRENT releases with distinct keys racing for one free balance. That is
 * named explicitly as a runtime-rehearsal obligation, not something these tests
 * quietly cover.
 */
describe("deposits.release · generation-aware command identity", () => {
  async function multiVehicleQuote(asUser: any, orgId: any, customerId: any, a: any, b: any) {
    return await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: 22000 },
        { vehicleId: b, unitPrice: 18000 },
      ],
      mode: "CASH",
      vehiclePrice: 40000,
      downPayment: 0,
      termMonths: 0,
    });
  }

  async function secondVehicle(t: any, orgId: any) {
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

  /**
   * A deposit whose free part is only PART of the row: 5000 taken, 3000 of it
   * committed to the two cars on the deal, so 2000 is free to pay out now and
   * the rest becomes free later. This is the shape that makes a second genuine
   * payout possible at all — a fully free deposit closes on its first release.
   */
  async function partiallyCommittedDeposit() {
    const s = await setup();
    await openAccountingPeriod(s.asUser, s.orgId);
    const v2 = await secondVehicle(s.t, s.orgId);
    const quoteId = await multiVehicleQuote(s.asUser, s.orgId, s.customerId, s.vehicleId, v2);
    const depositId = await s.asUser.mutation(api.deposits.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      quoteId,
      amount: 5000,
    });
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId,
      quoteId,
      allocations: [
        { vehicleId: s.vehicleId, amount: 2000 },
        { vehicleId: v2, amount: 1000 },
      ],
    });
    return { ...s, v2, quoteId, depositId };
  }

  const readDeposit = (t: any, depositId: any) => t.run((ctx: any) => ctx.db.get(depositId));

  const countRefundsOut = (t: any, orgId: any) =>
    t.run(async (ctx: any) => {
      const rows = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q: any) => q.eq("orgId", orgId))
        .collect();
      return rows.filter((r: any) => r.type === "OUT" && r.category === "DEPOSIT" && !r.isDeleted);
    });

  test("PROOF 1 — a same-generation retry pays ONCE", async () => {
    const { t, orgId, depositId, asApprover } = await partiallyCommittedDeposit();

    // The client observed releaseCount 0 and built its intent from it. The
    // response to the first call never arrived, so the key was never retired
    // and the operator submitted again with the SAME key and the SAME content.
    const gen0Key = "release-deposit:dep:REFUNDED:CASH:gen0";
    const args = { orgId, depositId, resolution: "REFUNDED" as const, refundMethod: "CASH" as const };

    await asApprover.mutation(api.deposits.release, { ...args, idempotencyKey: gen0Key });
    await asApprover.mutation(api.deposits.release, { ...args, idempotencyKey: gen0Key });

    const deposit = await readDeposit(t, depositId);
    // One payout, not two: the free 2000 left the business once.
    expect(deposit?.releasedAmountMinor).toBe(2_000_000);
    expect(deposit?.refundedAmountMinor).toBe(2_000_000);
    // The generation advanced exactly once, which is what makes the NEXT
    // genuine payout distinguishable from this retry.
    expect(deposit?.releaseCount).toBe(1);
    // And the money moved once in the ledger, not just in the deposit row.
    expect(await countRefundsOut(t, orgId)).toHaveLength(1);
  });

  test("PROOF 2 — the same key with a DIFFERENT decision is refused, not silently deduped", async () => {
    const { orgId, depositId, asApprover } = await partiallyCommittedDeposit();
    const gen0Key = "release-deposit:dep:REFUNDED:CASH:gen0";

    await asApprover.mutation(api.deposits.release, {
      idempotencyKey: gen0Key,
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    // Refunding to a bank account is a DIFFERENT command from refunding cash.
    // If the client ever reused one key across that change, the server must say
    // so rather than quietly returning the cash refund's stored result — which
    // would report a bank transfer that never happened.
    await expect(
      asApprover.mutation(api.deposits.release, {
        idempotencyKey: gen0Key,
        orgId,
        depositId,
        resolution: "REFUNDED",
        refundMethod: "BANK_TRANSFER",
      })
    ).rejects.toThrow(/different request content/i);
  });

  test("PROOF 3 — the NEXT generation is a new command and the second genuine payout proceeds", async () => {
    const { t, orgId, quoteId, vehicleId, v2, depositId, asUser, asApprover } =
      await partiallyCommittedDeposit();

    await asApprover.mutation(api.deposits.release, {
      idempotencyKey: "release-deposit:dep:REFUNDED:CASH:gen0",
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });
    const afterFirst = await readDeposit(t, depositId);
    expect(afterFirst?.releaseCount).toBe(1);
    // The row is NOT closed — one car's share is still committed to the deal.
    expect(afterFirst?.status).toBe("HELD");

    // The second car falls away, freeing its share. This is the real sequence
    // the original incident described, not a contrived one.
    await asUser.mutation(api.deposits.allocateToVehicles, {
      orgId,
      quoteId,
      allocations: [
        { vehicleId, amount: 2000 },
        { vehicleId: v2, amount: 0 },
      ],
    });

    // The client now observes releaseCount 1, so its intent — and therefore its
    // key — is a new generation. Same resolution, same method, same everything
    // else: ONLY the generation separates this from the payout above.
    await asApprover.mutation(api.deposits.release, {
      idempotencyKey: "release-deposit:dep:REFUNDED:CASH:gen1",
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    const afterSecond = await readDeposit(t, depositId);
    expect(afterSecond?.releaseCount).toBe(2);
    // 2000 then 1000 — the second genuine payout was NOT suppressed.
    expect(afterSecond?.releasedAmountMinor).toBe(3_000_000);
    expect(afterSecond?.refundedAmountMinor).toBe(3_000_000);
    expect(await countRefundsOut(t, orgId)).toHaveLength(2);
  });

  test("PROOF 4 — a STALE generation would suppress a genuine payout, which is why it must advance", async () => {
    const { t, orgId, quoteId, vehicleId, v2, depositId, asUser, asApprover } =
      await partiallyCommittedDeposit();

    const gen0Key = "release-deposit:dep:REFUNDED:CASH:gen0";
    await asApprover.mutation(api.deposits.release, {
      idempotencyKey: gen0Key,
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });
    await asUser.mutation(api.deposits.allocateToVehicles, {
      orgId,
      quoteId,
      allocations: [
        { vehicleId, amount: 2000 },
        { vehicleId: v2, amount: 0 },
      ],
    });

    // The genuinely-new payout submitted under the OLD generation's key. The
    // command log recognises the key, returns the stored result, and pays
    // NOTHING — while reporting success. This is the original incident, and it
    // is reproduced here deliberately: it is the exact failure the generation
    // exists to prevent, and it stays reproducible for as long as a key can be
    // reused across a completed payout.
    await asApprover.mutation(api.deposits.release, {
      idempotencyKey: gen0Key,
      orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });

    const deposit = await readDeposit(t, depositId);
    // Still one payout: the second 1000 did not move, despite a successful call.
    expect(deposit?.releasedAmountMinor).toBe(2_000_000);
    expect(deposit?.releaseCount).toBe(1);
    expect(await countRefundsOut(t, orgId)).toHaveLength(1);

    // The client cannot produce that stale key, for two independent reasons,
    // and BOTH are pinned in `hooks/useCommandIdentity.test.tsx`: the observed
    // generation advances after a confirmed payout, and the identity is retired
    // on success so even a stale read mints afresh. This test states the cost of
    // getting it wrong; those state that it is not gettable wrong.
  });
});
