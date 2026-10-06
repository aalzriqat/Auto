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
import { api, internal } from "./_generated/api";
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

async function seed(tag: string, vehicleCount: 1 | 2, limits = false) {
  const t = convexTestWithComponents(schema, MODULE_GLOB, { transactionLimits: limits });
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

  test("S4: a payout of unrelated free money cannot decide a share whose reversal has not posted", async () => {
    // Closed period: the application sits at REVERSING until the journal reversal
    // posts. The row holds MORE than that share, so the free part alone would
    // satisfy the old "paid >= share" test and clear a share still spent on the books.
    const s = await cancelledWithDeposit("s4Reversing");
    const depositId = await depositIdOf(s);
    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.get(depositId))!;
      await ctx.db.patch(depositId, {
        amount: deposit.amount * 2,
        amountMinor: (deposit.amountMinor ?? deposit.amount * SCALE) * 2,
      });
      const app = (await ctx.db.query("depositApplications").collect()).find((a) => a.orgId === s.orgId)!;
      await ctx.db.patch(app._id, { status: "REVERSING" });
    });
    await release(s, depositId, "REFUNDED");
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["PENDING"]);
    expect(await status(s)).not.toBe("AVAILABLE");
    // Once the reversal is proved posted the same payout does decide it.
    await s.t.run(async (ctx) => {
      const app = (await ctx.db.query("depositApplications").collect()).find((a) => a.orgId === s.orgId)!;
      await ctx.db.patch(app._id, { status: "REVERSED" });
    });
    await release(s, depositId, "REFUNDED");
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["RELEASED"]);
  });

  test("B1: decided history beyond 50 rows cannot hide a live share from the deposit predicates", async () => {
    const s = await cancelledWithDeposit("b1History");
    const depositId = await depositIdOf(s);
    const [live] = await pendingRows(s);
    await s.t.run(async (ctx) => {
      // The live share must be the NEWEST row, so a bounded scan of history misses it.
      await ctx.db.delete(live._id);
      for (let i = 0; i < 55; i++) {
        const { _id, _creationTime, ...copy } = live;
        await ctx.db.insert("depositCancellationPendings", {
          ...copy, applicationId: live.applicationId, status: "RELEASED", createdAt: live.createdAt - 1 - i,
        });
      }
      const { _id: _liveId, _creationTime: _liveTime, ...liveCopy } = live;
      await ctx.db.insert("depositCancellationPendings", liveCopy);
    });
    await expect(
      s.asManager.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId })
    ).rejects.toThrow(/awaiting a refund or forfeiture decision/);
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

// ─── Batch 2: runtime limit + exit guards ────────────────────────────────────

describe("SCRUM-712 batch 2", () => {
  test("F2: asking about 4,500 cars costs no index range per car while a share exists in the org", async () => {
    // Under the platform's 4096-ranges-per-execution ceiling the old per-car range
    // read throws here; the org-level vehicle set answers every car for free.
    const s = await seed("f2Lim", 1, true);
    await payDeposit(s, 1_000);
    await cancel(s, await sell(s, s.vehicleA, PRICE_A));
    const answers = await s.t.run(async (ctx) => {
      let blocked = 0;
      for (let i = 0; i < 4_500; i++) if (await hasPendingDisposition(ctx, s.orgId, s.vehicleA)) blocked++;
      return blocked;
    });
    expect(answers).toBe(4_500);
  });

  test("L1: reconcileVehicleHolds does not preview a release the write would refuse", async () => {
    const s = await cancelledWithDeposit("s5Reconcile");
    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!;
      await ctx.db.patch(deposit._id, { holdActive: false });
    });
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["PENDING"]);
    const out = await s.t.mutation(internal.migrations.reconcileVehicleHolds, { orgId: s.orgId, dryRun: true });
    expect(out.released.filter((r) => r.vehicleId === s.vehicleA.toString())).toEqual([]);
  });

  test("Codex R3-1: fifty shares of the SAME sale never block, and a foreign one beyond them always does", async () => {
    const s = await cancelledWithDeposit("sale50");
    const [row] = await pendingRows(s);
    const { hasPendingDispositionExceptSale } = await import("./utils/depositCancellationPending");
    const other = await s.t.run(async (ctx) => {
      const copy = (await ctx.db.get(row.saleId))!;
      const { _id, _creationTime, ...rest } = copy;
      const otherSale = await ctx.db.insert("sales", { ...rest });
      const { _id: _rid, _creationTime: _rt, ...shareCopy } = row;
      for (let i = 0; i < 49; i++) await ctx.db.insert("depositCancellationPendings", { ...shareCopy });
      return otherSale;
    });
    // 50 rows now, all this sale's: the old take(50) page was full and said "blocked".
    expect(await s.t.run((ctx) => hasPendingDispositionExceptSale(ctx, s.orgId, row.vehicleId, row.saleId))).toBe(false);
    await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...shareCopy } = row;
      await ctx.db.insert("depositCancellationPendings", { ...shareCopy, saleId: other });
    });
    expect(await s.t.run((ctx) => hasPendingDispositionExceptSale(ctx, s.orgId, row.vehicleId, row.saleId))).toBe(true);
  });

  test("Opus L1: a foreign QUARANTINED share blocks the sale's own restoration just like a PENDING one", async () => {
    const s = await cancelledWithDeposit("foreignQuar");
    const [row] = await pendingRows(s);
    const { hasPendingDispositionExceptSale } = await import("./utils/depositCancellationPending");
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(row.saleId))!;
      const { _id, _creationTime, ...saleCopy } = sale;
      const other = await ctx.db.insert("sales", { ...saleCopy });
      const { _id: _rid, _creationTime: _rt, ...shareCopy } = row;
      await ctx.db.insert("depositCancellationPendings", { ...shareCopy, saleId: other, status: "QUARANTINED" });
    });
    expect(await s.t.run((ctx) => hasPendingDispositionExceptSale(ctx, s.orgId, row.vehicleId, row.saleId))).toBe(true);
  });
  test("R3-2: an org with more than 200 blocking shares still blocks the car that sorts past the cap", async () => {
    const s = await cancelledWithDeposit("cap202");
    const [row] = await pendingRows(s);
    const lastVehicle = await s.t.run(async (ctx) => {
      const base = (await ctx.db.get(s.vehicleA))!;
      const { _id, _creationTime, ...vehicleCopy } = base;
      const { _id: _rid, _creationTime: _rt, ...shareCopy } = row;
      let last = s.vehicleA;
      for (let i = 0; i < 202; i++) {
        last = await ctx.db.insert("vehicles", { ...vehicleCopy, vin: `CAP${i}VIN${i}` });
        await ctx.db.insert("depositCancellationPendings", { ...shareCopy, vehicleId: last });
      }
      return last;
    });
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, lastVehicle))).toBe(true);
    const clean = await s.t.run(async (ctx) => {
      const base = (await ctx.db.get(s.vehicleA))!;
      const { _id, _creationTime, ...vehicleCopy } = base;
      return await ctx.db.insert("vehicles", { ...vehicleCopy, vin: "CAPCLEANVIN" });
    });
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, clean))).toBe(false);
  });
  test("a share of ANOTHER sale still refuses the cancellation's authority restoration", async () => {
    const s = await cancelledWithDeposit("exemptOther");
    const [row] = await pendingRows(s);
    const otherSale = await s.t.run(async (ctx) => {
      const copy = (await ctx.db.get((await ctx.db.query("sales").collect())[0]._id))!;
      const { _id, _creationTime, ...rest } = copy;
      return await ctx.db.insert("sales", { ...rest });
    });
    const { hasPendingDispositionExceptSale } = await import("./utils/depositCancellationPending");
    expect(await s.t.run((ctx) => hasPendingDispositionExceptSale(ctx, s.orgId, row.vehicleId, row.saleId))).toBe(false);
    expect(await s.t.run((ctx) => hasPendingDispositionExceptSale(ctx, s.orgId, row.vehicleId, otherSale))).toBe(true);
  });
});

// ─── Q34: legacy payouts stay neutral; the post-clear liveness read is exact ─

describe("SCRUM-712 Q34: slice payouts", () => {
  const OPEN_ROOT = (s: Seed, vehicleId: Id<"vehicles">) => ({
    orgId: s.orgId, vehicleId, customerId: s.customerId, status: "OPEN" as const,
    openedAt: Date.now(), openedBy: s.userId,
  });
  const holdOf = (s: Seed, vehicleId: Id<"vehicles">) =>
    s.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find((h) => h.orgId === s.orgId && h.vehicleId === vehicleId)!
    );
  const resolveSlice = (s: Seed, holdId: Id<"depositVehicleHolds">, treatment: "REFUND_TO_CUSTOMER" | "FORFEITED") =>
    s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId, holdId, treatment,
      ...(treatment === "REFUND_TO_CUSTOMER" ? { refundMethod: "CASH" as const } : { reason: "Walked away" }),
    });
  // A slice released while the deal was alive: NO pending row exists for it.
  async function legacySlice(tag: string) {
    const s = await seed(tag, 2);
    await payDeposit(s, 5_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId: s.quoteId,
      allocations: [{ vehicleId: s.vehicleA, amount: 3_000 }, { vehicleId: s.vehicleB!, amount: 2_000 }],
    });
    await s.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: s.orgId, quoteId: s.quoteId, vehicleId: s.vehicleA,
    });
    expect(await pendingRows(s)).toHaveLength(0);
    return { s, hold: await holdOf(s, s.vehicleA) };
  }

  for (const treatment of ["REFUND_TO_CUSTOMER", "FORFEITED"] as const) {
    test(`legacy ${treatment}: two OPEN roots and no pending row — the payout succeeds untouched`, async () => {
      const { s, hold } = await legacySlice(`legacy2root${treatment}`);
      const rootIds = await s.t.run(async (ctx) => [
        await ctx.db.insert("commitmentRoots", OPEN_ROOT(s, s.vehicleA)),
        await ctx.db.insert("commitmentRoots", OPEN_ROOT(s, s.vehicleA)),
      ]);
      await resolveSlice(s, hold._id, treatment);
      const roots = await s.t.run(async (ctx) => Promise.all(rootIds.map((id) => ctx.db.get(id))));
      expect(roots.map((r) => r!.status)).toEqual(["OPEN", "OPEN"]);
      expect((await s.t.run((ctx) => ctx.db.get(hold._id)))!.allocationStatus).toBe("RESOLVED");
    });
  }

  // A shared deposit whose cancelled sale left a pending share on the car's slice.
  async function cancelledSlice(tag: string) {
    const s = await seed(tag, 2);
    await payDeposit(s, 5_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId: s.quoteId,
      allocations: [{ vehicleId: s.vehicleA, amount: 3_000 }, { vehicleId: s.vehicleB!, amount: 2_000 }],
    });
    await sell(s, s.vehicleA, PRICE_A);
    const saleB = await sell(s, s.vehicleB!, PRICE_B);
    await cancel(s, saleB);
    const [row] = await pendingRows(s);
    return { s, row, hold: (await s.t.run((ctx) => ctx.db.get(row.holdId!)))! };
  }
  // 51 stale non-HELD rows still flagged holdActive, THEN one live HELD row: the
  // bounded legacy reader sees only the stale ones.
  async function staleThenLive(s: Seed, vehicleId: Id<"vehicles">) {
    await s.t.run(async (ctx) => {
      const [template] = (await ctx.db.query("deposits").collect()).filter((d) => d.orgId === s.orgId);
      const { _id, _creationTime, ...copy } = template;
      for (let i = 0; i < 51; i++) {
        await ctx.db.insert("deposits", { ...copy, vehicleId, status: "VOIDED", holdActive: true, idempotencyKey: `stale-${i}` });
      }
      await ctx.db.insert("deposits", { ...copy, vehicleId, status: "HELD", holdActive: true, idempotencyKey: "live" });
    });
  }
  const vehicleStatus = (s: Seed, v: Id<"vehicles">) => s.t.run(async (ctx) => (await ctx.db.get(v))!.status);

  test("newly cleared slice: 51 stale rows plus a live hold keep the car RESERVED", async () => {
    const { s, row, hold } = await cancelledSlice("sliceStale");
    expect(hold.allocationStatus).toBe("RELEASED_AWAITING_DECISION");
    await staleThenLive(s, s.vehicleB!);
    await resolveSlice(s, row.holdId!, "REFUND_TO_CUSTOMER");
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["RELEASED"]);
    expect(await vehicleStatus(s, s.vehicleB!)).toBe("RESERVED");
  });

  test("newly cleared whole row: 51 stale rows plus a live hold keep the car RESERVED and its root open", async () => {
    const s = await cancelledWithDeposit("wholeStale");
    const depositId = await s.t.run(async (ctx) => (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!._id);
    await staleThenLive(s, s.vehicleA);
    const rootId = await s.t.run((ctx) => ctx.db.insert("commitmentRoots", OPEN_ROOT(s, s.vehicleA)));
    await s.asManager.mutation(api.deposits.release, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH" as const,
    });
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["RELEASED"]);
    expect(await vehicleStatus(s, s.vehicleA)).toBe("RESERVED");
    expect((await s.t.run((ctx) => ctx.db.get(rootId)))!.status).toBe("OPEN");
  });

  test("shared share: a second share of the SAME car still outstanding keeps it RESERVED", async () => {
    const { s, row } = await cancelledSlice("anotherShare");
    await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...copy } = row;
      await ctx.db.insert("depositCancellationPendings", { ...copy, holdId: undefined, applicationId: row.applicationId });
    });
    await resolveSlice(s, row.holdId!, "FORFEITED");
    expect((await pendingRows(s)).map((r) => r.status).sort()).toEqual(["FORFEITED", "PENDING"]);
    expect(await vehicleStatus(s, s.vehicleB!)).toBe("RESERVED");
  });

  test("replay: the second resolution is refused and the cleared share stays cleared", async () => {
    const { s, row } = await cancelledSlice("replaySlice");
    await resolveSlice(s, row.holdId!, "REFUND_TO_CUSTOMER");
    await expect(resolveSlice(s, row.holdId!, "REFUND_TO_CUSTOMER")).rejects.toThrow(/has not been released/i);
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["RELEASED"]);
  });

  test("deferred reversal: refused while the application is REVERSING, clears once REVERSED", async () => {
    const { s, row } = await cancelledSlice("deferredSlice");
    await s.t.run(async (ctx) => ctx.db.patch(row.applicationId, { status: "REVERSING" }));
    await expect(resolveSlice(s, row.holdId!, "REFUND_TO_CUSTOMER")).rejects.toThrow();
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["PENDING"]);
    expect(await vehicleStatus(s, s.vehicleB!)).not.toBe("AVAILABLE");
    await s.t.run(async (ctx) => ctx.db.patch(row.applicationId, { status: "REVERSED" }));
    await resolveSlice(s, row.holdId!, "REFUND_TO_CUSTOMER");
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["RELEASED"]);
  });
});