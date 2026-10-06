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

// ─── S5: legacy rows are backfilled fail-closed ──────────────────────────────

describe("SCRUM-712 S5: backfill of cancelled sales that predate the table", () => {
  const backfill = (s: Seed, dryRun: boolean) =>
    s.t.mutation(internal.migrateDepositCancellationPendings.backfillDepositCancellationPendings, {
      orgId: s.orgId, dryRun,
    });
  /** A legacy world: the cancellation happened, but wrote no pending row and freed the car. */
  const asLegacy = async (s: Seed) => {
    await s.t.run(async (ctx) => {
      for (const row of await ctx.db.query("depositCancellationPendings").collect()) await ctx.db.delete(row._id);
      await ctx.db.patch(s.vehicleA, { status: "AVAILABLE" });
    });
  };

  test("dry run writes nothing; the real run records PENDING and locks the car; a re-run is a no-op", async () => {
    const s = await cancelledWithDeposit("s5Basic");
    await asLegacy(s);
    const dry = await backfill(s, true);
    expect(dry).toMatchObject({ created: 1, quarantined: 0, dryRun: true });
    expect(await pendingRows(s)).toHaveLength(0);

    const real = await backfill(s, false);
    expect(real).toMatchObject({ created: 1, quarantined: 0 });
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["PENDING"]);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleA))!.status)).toBe("RESERVED");

    const again = await backfill(s, true);
    expect(again).toMatchObject({ created: 0, quarantined: 0, alreadyRecorded: 1 });
  });

  test("a share whose money was already refunded is decided, not re-opened", async () => {
    const s = await cancelledWithDeposit("s5Decided");
    const depositId = (await s.t.run((ctx) => ctx.db.query("deposits").collect())).find((d) => d.orgId === s.orgId)!._id;
    await s.asManager.mutation(api.deposits.release, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH",
    });
    await asLegacy(s);
    expect(await backfill(s, false)).toMatchObject({ created: 0, quarantined: 0, decided: 1 });
    expect(await pendingRows(s)).toHaveLength(0);
  });

  test("a car already sold on is quarantined for a human, never guessed", async () => {
    const s = await cancelledWithDeposit("s5Quarantine");
    await asLegacy(s);
    await s.t.run((ctx) => ctx.db.patch(s.vehicleA, { status: "SOLD" }));
    expect(await backfill(s, false)).toMatchObject({ created: 0, quarantined: 1 });
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["QUARANTINED"]);
    // The sold car keeps its sold status; the quarantined share is reported, not dropped.
    expect(await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleA))!.status)).toBe("SOLD");
  });

  test("B2: a slice resolved as OTHER paid nothing out, so it is quarantined, not 'decided'", async () => {
    const s = await seed("s5Other", 2);
    await payDeposit(s, 1_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId: s.quoteId,
      allocations: [{ vehicleId: s.vehicleA, amount: 400 }, { vehicleId: s.vehicleB!, amount: 600 }],
    });
    const sale = await sell(s, s.vehicleA, PRICE_A);
    await cancel(s, sale);
    await asLegacy(s);
    await s.t.run(async (ctx) => {
      const hold = (await ctx.db.query("depositVehicleHolds").collect()).find((h) => h.vehicleId === s.vehicleA)!;
      await ctx.db.patch(hold._id, { allocationStatus: "RESOLVED", resolutionTreatment: "OTHER" });
    });
    expect(await backfill(s, false)).toMatchObject({ decided: 0, created: 0, quarantined: 1 });
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["QUARANTINED"]);
  });

  test("F3: a whole-row share whose deposit was applied again later is superseded", async () => {
    const s = await cancelledWithDeposit("s5Superseded");
    await asLegacy(s);
    await s.t.run(async (ctx) => {
      const first = (await ctx.db.query("depositApplications").collect()).find((a) => a.orgId === s.orgId)!;
      const { _id, _creationTime, ...copy } = first;
      await ctx.db.insert("depositApplications", { ...copy, appliedAt: first.appliedAt + 1_000 });
    });
    expect(await backfill(s, false)).toMatchObject({ superseded: 1, created: 1 });
    // Only the newest application owns the money, so only it carries a share.
    expect(await pendingRows(s)).toHaveLength(1);
  });

  test("F2: a quarantined share leaves only through the audited exit, which re-syncs the car", async () => {
    const s = await cancelledWithDeposit("s5Exit");
    const [row] = await pendingRows(s);
    await s.t.run((ctx) => ctx.db.patch(row._id, { status: "QUARANTINED" }));
    const resolve = (over: Partial<{ actorId: Id<"users">; reason: string; resolution: "RELEASED" | "FORFEITED" | "PENDING" }>) =>
      s.t.mutation(internal.migrateDepositCancellationPendings.resolveQuarantinedPending, {
        orgId: s.orgId, pendingId: row._id, actorId: s.userId, reason: "refunded by bank on 2026-05-01",
        resolution: "RELEASED", ...over,
      });
    await expect(resolve({ reason: "   " })).rejects.toThrow(/reason is required/);
    const nobody = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "nobody", email: "n@e.com", name: "N" }));
    await expect(resolve({ actorId: nobody })).rejects.toThrow();
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["QUARANTINED"]);
    // The reinstated deposit is the only other thing holding the car; release it so the exit alone decides.
    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)!;
      await ctx.db.patch(deposit._id, { holdActive: false });
    });
    await resolve({});
    const [done] = await pendingRows(s);
    expect(done).toMatchObject({ status: "RELEASED", resolvedBy: s.userId });
    expect(done.resolutionReference).toMatch(/refunded by bank/);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(s.vehicleA))!.status)).not.toBe("RESERVED");
    await expect(resolve({})).rejects.toThrow(/Only a quarantined/);
  });

  test("another organization's applications are never touched", async () => {
    const a = await cancelledWithDeposit("s5OrgA");
    const b = await cancelledWithDeposit("s5OrgB");
    await asLegacy(a);
    // Running org B's backfill on B's world (separate t) cannot see A at all; and A's
    // run only scans A's applications.
    expect(await backfill(a, false)).toMatchObject({ scanned: 1, created: 1 });
    expect(await pendingRows(b)).toHaveLength(1);
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

  test("Codex F2: with 60 successive applications on one deposit exactly the newest carries a share", async () => {
    vi.useFakeTimers();
    try {
      const s = await cancelledWithDeposit("sib60");
      await s.t.run(async (ctx) => {
        for (const row of await ctx.db.query("depositCancellationPendings").collect()) await ctx.db.delete(row._id);
        await ctx.db.patch(s.vehicleA, { status: "AVAILABLE" });
      });
      await s.t.run(async (ctx) => {
        const first = (await ctx.db.query("depositApplications").collect()).find((a) => a.orgId === s.orgId)!;
        const { _id, _creationTime, ...copy } = first;
        for (let i = 1; i < 60; i++) await ctx.db.insert("depositApplications", { ...copy, appliedAt: first.appliedAt + i });
      });
      const first = await s.t.mutation(
        internal.migrateDepositCancellationPendings.backfillDepositCancellationPendings,
        { orgId: s.orgId, dryRun: false }
      );
      expect(first.status).toBe("SCHEDULED");
      await s.t.finishAllScheduledFunctions(vi.runAllTimers);
      const rows = await pendingRows(s);
      expect(rows).toHaveLength(1);
      const newest = await s.t.run(async (ctx) => {
        const apps = await ctx.db.query("depositApplications").collect();
        return apps[apps.length - 1]._id;
      });
      expect(rows[0].applicationId).toBe(newest);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a terminal quarantine resolution is refused while the sale reversal has not posted", async () => {
    const s = await cancelledWithDeposit("exitReversing");
    const [row] = await pendingRows(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(row._id, { status: "QUARANTINED" });
      await ctx.db.patch(row.applicationId, { status: "REVERSING" });
    });
    const resolve = (resolution: "RELEASED" | "FORFEITED" | "PENDING") =>
      s.t.mutation(internal.migrateDepositCancellationPendings.resolveQuarantinedPending, {
        orgId: s.orgId, pendingId: row._id, actorId: s.userId, reason: "checked", resolution,
      });
    await expect(resolve("RELEASED")).rejects.toThrow(/reversal has not posted/);
    await expect(resolve("FORFEITED")).rejects.toThrow(/reversal has not posted/);
    expect((await pendingRows(s)).map((r) => r.status)).toEqual(["QUARANTINED"]);
    expect(await s.t.run((ctx) => hasPendingDisposition(ctx, s.orgId, s.vehicleA))).toBe(true);
  });

  test("a quarantined share cannot go back to PENDING when no refund door is open for it", async () => {
    const s = await cancelledWithDeposit("exitNoDoor");
    const [row] = await pendingRows(s);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(row._id, { status: "QUARANTINED" });
      await ctx.db.patch(row.depositId, { status: "VOIDED" });
    });
    await expect(
      s.t.mutation(internal.migrateDepositCancellationPendings.resolveQuarantinedPending, {
        orgId: s.orgId, pendingId: row._id, actorId: s.userId, reason: "checked", resolution: "PENDING",
      })
    ).rejects.toThrow(/No refund or forfeiture door/);
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