/**
 * SCRUM-712 S1 — cancelling a completed sale leaves one PENDING disposition per
 * deposit share it consumed, created in the cancellation transaction.
 *
 * Invariant: a cancelled-sale deposit share is a first-class PENDING record until
 * somebody refunds or forfeits exactly that share. S1 only proves the record is
 * written once, per share, with the right identity; the doors that must honour it
 * are S2/S3.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hasPendingDisposition } from "./utils/depositCancellationPending";
import { syncVehicleHoldStatus } from "./utils/depositHelpers";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "confirm:finance_disbursement",
  "view:sales", "create:sales", "edit:sales", "delete:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "manage:finance", "view:finance", "view:expenses", "view:reports",
  "reopen:accounting_periods",
];
const PRICE_A = 3_000;
const PRICE_B = 20_000;
const SCALE = 1000;

async function seed(tag: string, vehicleCount: 1 | 2) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Pend ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Sales" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_m`, email: `${tag}m@e.com`, name: "Manager" })
  );
  const managerRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Manager", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const makeVehicle = async (suffix: string, price: number) =>
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VINPEND${tag}${suffix}`, make: "Toyota", model: `M${suffix}`,
        year: 2024, mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: price, status: "AVAILABLE", sourceType: "STOCK",
        purchasePrice: Math.round(price * 0.8),
      })
    );
  const vehicleA = await makeVehicle("A", PRICE_A);
  const vehicleB = vehicleCount === 2 ? await makeVehicle("B", PRICE_B) : null;
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId: vehicleA,
      vehiclePrice: vehicleB ? PRICE_A + PRICE_B : PRICE_A,
      ...(vehicleB
        ? { vehicleItems: [{ vehicleId: vehicleA, unitPrice: PRICE_A }, { vehicleId: vehicleB, unitPrice: PRICE_B }] }
        : {}),
      downPayment: 0, termMonths: 0, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );
  return { t, orgId, userId, asUser, asManager, customerId, vehicleA, vehicleB, quoteId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const payDeposit = (s: Seed, amount: number) =>
  s.asUser.mutation(api.deposits.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId: s.quoteId, amount, method: "CASH" as const,
  });
const sell = (s: Seed, vehicleId: Id<"vehicles">, salePrice: number) =>
  s.asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId,
    salespersonId: s.userId, salePrice, saleDate: Date.now(), status: "COMPLETED" as const, quoteId: s.quoteId,
  });
const cancel = (s: Seed, saleId: Id<"sales">) =>
  s.asManager.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" as const });
const pendingRows = (s: Seed) =>
  s.t.run((ctx) => ctx.db.query("depositCancellationPendings").collect());

describe("SCRUM-712 S1: cancelling a completed sale writes a PENDING per consumed share", () => {
  test("shared deposit: only the cancelled car's share is pending, with exact identity", async () => {
    const s = await seed("shared", 2);
    await payDeposit(s, 5_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId: s.quoteId,
      allocations: [{ vehicleId: s.vehicleA, amount: 3_000 }, { vehicleId: s.vehicleB!, amount: 2_000 }],
    });
    await sell(s, s.vehicleA, PRICE_A);
    const saleB = await sell(s, s.vehicleB!, PRICE_B);

    await cancel(s, saleB);

    const rows = await pendingRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: s.orgId, vehicleId: s.vehicleB, saleId: saleB, status: "PENDING", amountMinor: 2_000 * SCALE,
    });
    expect(rows[0].holdId).toBeDefined();
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleB!))).toBe(true);
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleA))).toBe(false);
  });

  test("direct (single-vehicle) deposit: the whole row is the share, no hold id", async () => {
    const s = await seed("direct", 1);
    await payDeposit(s, 1_000);
    const sale = await sell(s, s.vehicleA, PRICE_A);

    await cancel(s, sale);

    const rows = await pendingRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vehicleId: s.vehicleA, saleId: sale, status: "PENDING", amountMinor: 1_000 * SCALE });
    expect(rows[0].holdId).toBeUndefined();
  });

  test("a sale with no deposit leaves nothing pending", async () => {
    const s = await seed("nodeposit", 1);
    const sale = await sell(s, s.vehicleA, PRICE_A);
    await cancel(s, sale);
    expect(await pendingRows(s)).toHaveLength(0);
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleA))).toBe(false);
  });

  test("tenant isolation: another org's predicate never sees the row", async () => {
    const s = await seed("tenant", 1);
    await payDeposit(s, 1_000);
    const sale = await sell(s, s.vehicleA, PRICE_A);
    await cancel(s, sale);
    const otherOrg = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, otherOrg, s.vehicleA))).toBe(false);
  });

  test("re-cancelling the already cancelled sale does not duplicate the share", async () => {
    const s = await seed("replay", 1);
    await payDeposit(s, 1_000);
    const sale = await sell(s, s.vehicleA, PRICE_A);
    await cancel(s, sale);
    await cancel(s, sale).catch(() => undefined);
    expect(await pendingRows(s)).toHaveLength(1);
  });
});

// ─── S2: the doors refuse while a share is undecided ─────────────────────────

const PENDING_MESSAGE = /still needs a refund or forfeiture decision/;

async function cancelledWithDeposit(tag: string) {
  const s = await seed(tag, 1);
  await payDeposit(s, 1_000);
  const sale = await sell(s, s.vehicleA, PRICE_A);
  await cancel(s, sale);
  expect(await pendingRows(s)).toHaveLength(1);
  return s;
}

describe("SCRUM-712 S2: a pending share locks the car for everybody", () => {
  test("a new sale of the car is refused, for the same customer", async () => {
    const s = await cancelledWithDeposit("resaleSame");
    await expect(sell(s, s.vehicleA, PRICE_A)).rejects.toThrow(PENDING_MESSAGE);
  });

  test("a new walk-in sale to a DIFFERENT customer is refused too", async () => {
    const s = await cancelledWithDeposit("resaleOther");
    const other = await s.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: s.orgId, firstName: "Rival", lastName: "Buyer" })
    );
    await expect(
      s.asUser.mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleA, customerId: other,
        salespersonId: s.userId, salePrice: PRICE_A, saleDate: Date.now(), status: "COMPLETED" as const,
      })
    ).rejects.toThrow(PENDING_MESSAGE);
  });

  test("a direct move to AVAILABLE is refused", async () => {
    const s = await cancelledWithDeposit("statusAvail");
    await s.t.run((ctx) => ctx.db.patch(s.vehicleA, { status: "IN_INSPECTION" }));
    await expect(
      s.asUser.mutation(api.vehicles.update, { orgId: s.orgId, vehicleId: s.vehicleA, status: "AVAILABLE" })
    ).rejects.toThrow(PENDING_MESSAGE);
    // Staying where it is is not a move, and is not refused.
    await expect(
      s.asUser.mutation(api.vehicles.update, { orgId: s.orgId, vehicleId: s.vehicleA, status: "IN_INSPECTION" })
    ).resolves.toBeDefined();
  });

  test("a sourced car cannot be marked arrived onto the lot", async () => {
    const s = await cancelledWithDeposit("arrived");
    await s.t.run((ctx) => ctx.db.patch(s.vehicleA, { status: "SOURCING", sourceType: "SOURCED" }));
    await expect(
      s.asUser.mutation(api.vehicles.markSourcedVehicleArrived, { orgId: s.orgId, vehicleId: s.vehicleA })
    ).rejects.toThrow(PENDING_MESSAGE);
  });

  test("another car in the same org is unaffected", async () => {
    const s = await seed("isolated", 2);
    await payDeposit(s, 1_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId: s.quoteId,
      allocations: [{ vehicleId: s.vehicleA, amount: 400 }, { vehicleId: s.vehicleB!, amount: 600 }],
    });
    const saleA = await sell(s, s.vehicleA, PRICE_A);
    await cancel(s, saleA);
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleA))).toBe(true);
    await expect(sell(s, s.vehicleB!, PRICE_B)).resolves.toBeDefined();
  });
});

// ─── S3: only a refund or forfeiture decides the share, and it frees the car ─

describe("SCRUM-712 S3: exits", () => {
  const release = (s: Seed, depositId: Id<"deposits">, resolution: "REFUNDED" | "FORFEITED") =>
    s.asManager.mutation(api.deposits.release, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, depositId, resolution,
      ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
    });
  const depositIdOf = (s: Seed) =>
    s.t.run(async (ctx) => (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!._id);
  const status = (s: Seed) => s.t.run(async (ctx) => (await ctx.db.get(s.vehicleA))!.status);

  test("while pending the car is not advertised as available", async () => {
    const s = await cancelledWithDeposit("lockedStatus");
    expect(await status(s)).not.toBe("AVAILABLE");
  });

  test("even with every other hold gone, the status writer keeps the car off AVAILABLE", async () => {
    // releaseHoldForApplicationQuote and friends clear holdActive and re-sync. The
    // pending share is the only thing left holding the car, and it must be enough.
    const s = await cancelledWithDeposit("syncLock");
    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!;
      await ctx.db.patch(deposit._id, { holdActive: false });
      await syncVehicleHoldStatus(ctx, s.vehicleA);
    });
    expect(await status(s)).toBe("RESERVED");
  });

  test("refunding the reinstated whole-row deposit decides the share and frees the car", async () => {
    const s = await cancelledWithDeposit("refundDirect");
    await release(s, await depositIdOf(s), "REFUNDED");
    const rows = await pendingRows(s);
    expect(rows.map((r) => r.status)).toEqual(["RELEASED"]);
    expect(rows[0].resolvedAt).toBeDefined();
    expect(await status(s)).toBe("AVAILABLE");
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleA))).toBe(false);
  });

  test("forfeiting it decides the share as FORFEITED", async () => {
    const s = await cancelledWithDeposit("forfeitDirect");
    await release(s, await depositIdOf(s), "FORFEITED");
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["FORFEITED"]);
    expect(await status(s)).toBe("AVAILABLE");
  });

  test("voiding the deposit as 'recorded in error' is refused while its share is pending", async () => {
    const s = await cancelledWithDeposit("voidRefused");
    await expect(
      s.asManager.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId: await depositIdOf(s) })
    ).rejects.toThrow(/awaiting a refund or forfeiture decision/);
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["PENDING"]);
  });

  test("a quarantined share keeps blocking exactly like a pending one", async () => {
    const s = await cancelledWithDeposit("quarantine");
    const [row] = await pendingRows(s);
    await s.t.run((ctx) => ctx.db.patch(row._id, { status: "QUARANTINED" }));
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleA))).toBe(true);
    await release(s, await depositIdOf(s), "REFUNDED");
    // A human reconciliation, never a side effect of a payout.
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["QUARANTINED"]);
    await expect(sell(s, s.vehicleA, PRICE_A)).rejects.toThrow(PENDING_MESSAGE);
  });
});
