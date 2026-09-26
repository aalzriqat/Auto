import { TestConvex } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
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
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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
      isSystemOwnerRole: true,
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
    return await asUser.mutation(api.sales.create, { idempotencyKey: crypto.randomUUID(),
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
    // The event is sourced on the APPLICATION — this deposit against this car —
    // not on the deposit alone. One row can be applied once per car it was
    // allocated across, and a shared source made every reversal ambiguous.
    expect(appliedRecords[0].sourceId).toContain(depositId.toString());
    expect(appliedRecords[0].payload).toMatchObject({
      depositId: depositId.toString(),
      amountMinor: 150000,
      currency: "USD",
    });
  });

  // SCRUM-263 (Sol D2): proving that applying a deposit invents no cash takes
  // more than finding no cash line; an application that never posted would
  // pass that. The liability must be discharged once, posted, onto customer
  // AR, and no receipt of any kind may appear beside it.
  test("an applied deposit posts DR deposit liability / CR customer AR once, and records no receipt", async () => {
    const { t, orgId, createQuote, createHeldDeposit, completeSale } =
      await seedFinanceLifecycleDealer();
    // An OPEN period, so the application posts rather than queueing; a queued
    // one is precisely the case a no-cash-line assertion cannot tell apart.
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const asOwner = t.withIdentity({ subject: "fl3_user", clerkId: "fl3_user" });
    await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
    const fiscalYear = new Date().getUTCFullYear();
    await asOwner.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear,
      periodNumber: 1,
    });
    const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
    await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    const quoteId = await createQuote();
    const depositId = await createHeldDeposit(quoteId, 1500);

    await completeSale({ quoteId });

    const posted = await t.run(async (ctx) => {
      const events = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_eventType", (q) => q.eq("orgId", orgId).eq("eventType", "DEPOSIT_APPLIED"))
        .take(100);
      const pending = (
        await ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
          .take(1000)
      ).filter((event) => event.eventType === "DEPOSIT_APPLIED");
      const applications = (await ctx.db.query("depositApplications").take(100))
        .filter((row) => row.depositId === depositId)
        .map((row) => ({ status: row.status, treatment: row.treatment, key: row.eventIdempotencyKey }));
      const eventStates = events.map((event) => ({ status: event.status, key: event.idempotencyKey }));
      const entryStatuses: string[] = [];
      const lines: Array<{ key: string | null; debit: number; credit: number }> = [];
      for (const event of events) {
        const entries = await ctx.db
          .query("journalEntries")
          .withIndex("by_accounting_event", (q) => q.eq("accountingEventId", event._id))
          .take(10);
        for (const entry of entries) {
          entryStatuses.push(entry.status);
          const entryLines = await ctx.db
            .query("journalLines")
            .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
            .take(100);
          for (const line of entryLines) {
            const account = await ctx.db.get(line.accountId);
            lines.push({ key: account?.systemKey ?? null, debit: line.debitMinor, credit: line.creditMinor });
          }
        }
      }
      return { events: events.length, pending: pending.length, lines, applications, eventStates, entryStatuses };
    });

    expect(posted.pending).toBe(0);
    expect(posted.events).toBe(1);
    // Posted is observed, not inferred from the lines (Sol D2-STATUS): the
    // application is APPLIED, and the one event it names and that event's
    // one journal entry are both POSTED. A DRAFT or PENDING leftover carrying
    // the same two lines would satisfy every line assertion below.
    expect(posted.applications).toEqual([
      { status: "APPLIED", treatment: "CUSTOMER_RECEIVABLE", key: posted.eventStates[0]?.key },
    ]);
    expect(posted.eventStates.map((event) => event.status)).toEqual(["POSTED"]);
    expect(posted.entryStatuses).toEqual(["POSTED"]);
    expect(posted.lines).toEqual(
      expect.arrayContaining([
        { key: "CUSTOMER_DEPOSITS_LIABILITY", debit: 150000, credit: 0 },
        { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", debit: 0, credit: 150000 },
      ])
    );
    expect(posted.lines).toHaveLength(2);

    // The only receipt is the deposit's OWN, under its idempotent identity:
    // this fixture inserts the deposit row directly, so that receipt is
    // materialised at application rather than at recording. Applying it adds
    // no receipt of its own and no collection payment.
    const receipts = await t.run(async (ctx) => ({
      collection: (await ctx.db.query("collectionPayments").take(1000)).length,
      canonicalKeys: (await ctx.db.query("canonicalPayments").take(1000)).map((row) => row.idempotencyKey),
    }));
    expect(receipts).toEqual({
      collection: 0,
      canonicalKeys: [`deposit_received_${depositId}`],
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
    // Each application's source names its own deposit; the vehicle suffix is
    // what keeps two applications of the SAME deposit apart.
    expect(
      appliedRecords.map((record) => record.sourceId.split(":")[0]).sort()
    ).toEqual([firstDepositId.toString(), secondDepositId.toString()].sort());

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
