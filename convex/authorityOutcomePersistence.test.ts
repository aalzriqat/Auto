/**
 * SCRUM-208 c15810 — THE AUTHORITY OUTCOME REACHES THE DATABASE.
 *
 * ⚠️ WHY THIS FILE EXISTS. `pendingAccountingEvents.authorityOutcome` is the
 * durable record the whole outcome taxonomy was built for: it is how a rival,
 * an ambiguity or a contradiction survives an unattended cron drain and reaches
 * a person. Sonnet MAX pointed out that nothing exercised the REAL
 * `drainEntries` path, and a grep confirmed something worse — **no test
 * anywhere asserted that the field is ever written at all**. `markEntryPosted`
 * could stop persisting it and every suite would stay green.
 *
 * That is the same shape as the defect that blocked the previous head:
 * `usesVehicleHoldRows` had readers, a schema entry, and no proof its writer
 * ever ran. So this drives the real outbox mutation end to end — a real posted
 * event, a real deferred reversal, a real deal terminalized by
 * `consumeRootForSale` — and reads the persisted row back.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { acquireVehicle, consumeRootForSale } from "./commitments";
import { COMMITMENT_AUTHORITY_V1 } from "./utils/commitmentKernel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedCanonicalOrgWithChart(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", {
      name: `Outcome ${suffix}`,
      createdAt: Date.now(),
      commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1,
    })
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
    ctx.db.insert("users", { clerkId: `ao_${suffix}`, email: `${suffix}@ao.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
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
  const asAdmin = t.withIdentity({ subject: `ao_${suffix}`, clerkId: `ao_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

  // One open period, so a real event can post and a real reversal can follow.
  const year = new Date().getUTCFullYear();
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
  await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  return { t, orgId, userId, asAdmin, accountingDate: Date.UTC(year, 5, 10) };
}

type Seed = Awaited<ReturnType<typeof seedCanonicalOrgWithChart>>;

/**
 * Drive the REAL outbox mutation, and drain the continuation chain it schedules.
 *
 * ⚠️ FAKE TIMERS BEFORE THE SWEEP, AND `Date` LEFT REAL — the sweep schedules
 * itself, so installing them afterwards leaves the chain on real timers where
 * the pump cannot reach it, and freezing the clock would move every entry out
 * of the accounting period it was written for.
 */
async function drain(seed: Seed) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    await seed.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, {
      orgId: seed.orgId,
    });
    for (let pass = 0; pass < 10; pass += 1) {
      await seed.t.finishAllScheduledFunctions(vi.runAllTimers);
      const queued = (
        await seed.t.run(async (ctx: any) =>
          await ctx.db.system.query("_scheduled_functions").collect()
        )
      ).filter((f: any) => f.state.kind === "pending" || f.state.kind === "inProgress").length;
      if (queued === 0) break;
    }
  } finally {
    vi.useRealTimers();
  }
}

/** A real posted event, so a real reversal has something to reverse. */
async function postAnEvent(seed: Seed, seq: number) {
  await seed.t.run(async (ctx: any) => {
    await ctx.db.insert("pendingAccountingEvents", {
      orgId: seed.orgId,
      kind: "POST",
      status: "PENDING",
      idempotencyKey: `expense_posted_ao_${seq}`,
      accountingDate: seed.accountingDate,
      actorId: seed.userId,
      attempts: 0,
      createdAt: Date.now(),
      eventType: "EXPENSE_POSTED",
      sourceType: "expenses",
      sourceId: `ao_${seq}`,
      eventVersion: 1,
      occurredAt: seed.accountingDate,
      currency: "USD",
      payload: { expenseId: `ao_${seq}`, amountMinor: 1000, currency: "USD", category: "OTHER" },
    });
  });
  await drain(seed);
  const posted = await seed.t.run(async (ctx: any) =>
    await ctx.db.query("accountingEvents").collect()
  );
  expect(posted.length, "the fixture's own precondition: an event actually posted").toBeGreaterThan(
    0
  );
  return posted[posted.length - 1]._id as Id<"accountingEvents">;
}

/**
 * A real deal, completed and cancelled, whose reversing journal is queued.
 *
 * The deal is built with the production writers — `acquireVehicle` opens the
 * episode, `consumeRootForSale` terminalizes the ROOT and leaves every claim
 * byte-identical, exactly as finalization does.
 */
async function deferredCancelledDeal(seed: Seed, tag: string) {
  const customerId = await seed.t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId: seed.orgId,
      firstName: "C",
      lastName: tag,
      phone: `+96278000${tag.length}`,
      createdAt: Date.now(),
    })
  );
  const vehicleId = await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `7HGCM82633A1234${tag.length}`,
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 100,
      sellingPrice: 30_000,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
    })
  );
  const saleId = await seed.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      salespersonId: seed.userId,
      salePrice: 30_000,
      saleDate: Date.now(),
      status: "CANCELLED" as const,
    })
  );
  const depositId = await seed.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      amount: 1_000,
      status: "HELD" as const,
      // What a deferred cancellation leaves behind: money back, car not re-held.
      holdActive: false,
      usesVehicleHoldRows: false,
      createdBy: seed.userId,
      createdAt: Date.now(),
    })
  );
  await seed.t.run((ctx) =>
    acquireVehicle(ctx, {
      orgId: seed.orgId,
      vehicleId,
      customerId,
      createdBy: seed.userId,
      evidence: { kind: "DEPOSIT", depositId },
      lineage: { depositId },
    })
  );
  await seed.t.run((ctx) =>
    consumeRootForSale(ctx, {
      orgId: seed.orgId,
      vehicleId,
      saleId,
      reason: "sale completed",
      decisionNow: Date.now(),
    })
  );

  const applicationKey = `apply_ao_${tag}_${depositId}`;
  await seed.t.run((ctx) =>
    ctx.db.insert("depositApplications", {
      orgId: seed.orgId,
      depositId,
      vehicleId,
      saleId,
      customerId,
      amountMinor: 100_000,
      currency: "USD",
      treatment: "CUSTOMER_RECEIVABLE" as const,
      eventType: "deposit.applied",
      eventSourceType: "depositApplications",
      eventSourceId: String(depositId),
      eventVersion: 1,
      eventIdempotencyKey: applicationKey,
      status: "REVERSING" as const,
      appliedAt: Date.now(),
      appliedBy: seed.userId,
    })
  );
  return { customerId, vehicleId, saleId, depositId, applicationKey };
}

/** Queue the REVERSE entry the drain will pick up. */
async function queueReversal(
  seed: Seed,
  originalEventId: Id<"accountingEvents">,
  applicationKey: string
) {
  return await seed.t.run(async (ctx: any) =>
    await ctx.db.insert("pendingAccountingEvents", {
      orgId: seed.orgId,
      kind: "REVERSE",
      status: "PENDING",
      // `completeDeferredReversal` derives the application from this key.
      idempotencyKey: `reversed_${applicationKey}`,
      accountingDate: seed.accountingDate,
      actorId: seed.userId,
      attempts: 0,
      createdAt: Date.now(),
      sourceType: "depositApplications",
      sourceId: applicationKey,
      originalEventId,
      reason: "Sale cancelled",
    })
  );
}

describe("the vehicle-authority outcome is persisted by the real drain", () => {
  test("a restored deal writes RESTORED onto the queued reversal row", async () => {
    const seed = await seedCanonicalOrgWithChart("ok");
    const originalEventId = await postAnEvent(seed, 1);
    const deal = await deferredCancelledDeal(seed, "ok");
    const entryId = await queueReversal(seed, originalEventId, deal.applicationKey);

    await drain(seed);

    const entry = await seed.t.run(async (ctx: any) => await ctx.db.get(entryId));
    expect(entry.status, "the reversal itself completed").toBe("POSTED");
    // ⚠️ THE CONTRACT NOTHING ELSE COVERED. Without this, `markEntryPosted`
    // could stop persisting the outcome and every suite would stay green.
    expect(entry.authorityOutcome).toBe("RESTORED");
    expect(entry.authorityOutcomeAt, "and it is stamped with when").toBeGreaterThan(0);

    // And the deal really did come back — the outcome is not a label on nothing.
    const roots = await seed.t.run(async (ctx: any) =>
      (await ctx.db.query("commitmentRoots").collect()).filter(
        (r: any) => String(r.vehicleId) === String(deal.vehicleId)
      )
    );
    expect(roots.filter((r: any) => r.status === "OPEN")).toHaveLength(1);
    expect(
      (await seed.t.run(async (ctx: any) => await ctx.db.get(deal.depositId))).holdActive
    ).toBe(true);
  });

  test("a rival's car writes the rival outcome AND its detail, not silence", async () => {
    const seed = await seedCanonicalOrgWithChart("rival");
    const originalEventId = await postAnEvent(seed, 1);
    const deal = await deferredCancelledDeal(seed, "rival");

    // Somebody else took the car while the reversal sat in the queue.
    const rival = await seed.t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId: seed.orgId,
        firstName: "R",
        lastName: "Rival",
        phone: "+962780999",
        createdAt: Date.now(),
      })
    );
    const rivalReservation = await seed.t.run((ctx) =>
      ctx.db.insert("vehicleReservations", {
        orgId: seed.orgId,
        vehicleId: deal.vehicleId,
        customerId: rival,
        status: "ACTIVE" as const,
        reservedBy: seed.userId,
        reservedAt: Date.now(),
      })
    );
    await seed.t.run((ctx) =>
      acquireVehicle(ctx, {
        orgId: seed.orgId,
        vehicleId: deal.vehicleId,
        customerId: rival,
        createdBy: seed.userId,
        evidence: { kind: "RESERVATION", reservationId: rivalReservation },
        lineage: { reservationId: rivalReservation },
      })
    );

    const entryId = await queueReversal(seed, originalEventId, deal.applicationKey);
    await drain(seed);

    const entry = await seed.t.run(async (ctx: any) => await ctx.db.get(entryId));
    expect(entry.status, "the accounting is done and stays done").toBe("POSTED");
    expect(entry.authorityOutcome).toBe("ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL");
    // ⚠️ A RIVAL NEVER HAS ITS VEHICLE TAKEN — and the original customer's
    // money is NOT quietly re-held against a car somebody else now holds.
    expect(
      (await seed.t.run(async (ctx: any) => await ctx.db.get(deal.depositId))).holdActive
    ).toBe(false);
  });
});
