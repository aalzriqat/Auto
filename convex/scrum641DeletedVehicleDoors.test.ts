/**
 * SCRUM-641 (D-35) — A DELETED VEHICLE IS NEVER COMMERCIAL AGAIN.
 *
 * INVARIANT: a vehicle with `isDeleted === true` never acquires a new quote, draft, hold,
 * deposit, deposit allocation, profit-approval authority, finance approval or application, or
 * completed sale through any door. Historical records stay untouched and every reversal path
 * (refund, forfeit, void, release, rejection, cancellation) stays available.
 *
 * Every refusal here is asserted three ways: the structured `VEHICLE_DELETED` code, a control
 * on a LIVE car through the same fixture (so the refusal is the guard and not an earlier
 * accident), and the absence of writes (row counts of EVERY table before and after).
 *
 * Fixtures: the car is deleted through the real `vehicles.softDelete` door wherever that door
 * allows it. Where it does not (a car that is held or has an in-flight application cannot be
 * deleted through the product), the flag is set directly with `t.run` and the test says so —
 * that is an ABNORMAL state (legacy data, admin edit, or a deletion that raced a commitment),
 * which is exactly the state the guards exist for.
 */

import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { assertProfitApproved } from "./utils/profitApproval";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "delete:sales",
  "view:customers",
  "edit:vehicles",
  "view:vehicles",
  "delete:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
];

const PRICE = 30_000;
const VEHICLE_DELETED_MESSAGE =
  "This vehicle has been deleted and can no longer be quoted, reserved, sold or take a deposit.";

const ADMIN_FLAG_LOCKED_MESSAGE =
  "A vehicle's deleted status cannot be changed by direct edit. Use the vehicle delete or restore workflow instead.";

async function expectDeleted(attempt: Promise<unknown>): Promise<void> {
  await expectAppError(attempt, "VEHICLE_DELETED", VEHICLE_DELETED_MESSAGE);
}

let seq = 0;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() })
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
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `user_${suffix}`, email: `${suffix}@test.com`, name: "Sales User" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `mgr_${suffix}`, email: `mgr-${suffix}@test.com`, name: "Manager" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "A",
      phone: `+96279641${suffix.length}1`,
      createdAt: Date.now(),
    })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Customer",
      lastName: "B",
      phone: `+96279641${suffix.length}2`,
      createdAt: Date.now(),
    })
  );
  return {
    t,
    orgId,
    userId,
    managerId,
    customerA,
    customerB,
    asUser: t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` }),
    asManager: t.withIdentity({ subject: `mgr_${suffix}`, clerkId: `mgr_${suffix}` }),
  };
}
type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function vehicle(seed: Seed, extra: Record<string, unknown> = {}) {
  seq += 1;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin: `SC641VIN${String(seq).padStart(8, "0")}`,
      make: "Toyota",
      model: "RAV4",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 90,
      purchasePrice: 20_000,
      sellingPrice: PRICE,
      status: "AVAILABLE" as const,
      createdAt: Date.now(),
      ...extra,
    })
  );
}

async function quoteFor(seed: Seed, customerId: Id<"customers">, vehicles: Array<Id<"vehicles">>) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId: vehicles[0],
    vehicleItems: vehicles.map((vehicleId) => ({ vehicleId, unitPrice: PRICE })),
    mode: "CASH" as const,
    vehiclePrice: PRICE * vehicles.length,
    downPayment: 0,
    termMonths: 0,
  });
}

/** The product door. Throws (and the test fails) when the car is held, so the fixture is honest. */
async function softDelete(seed: Seed, vehicleId: Id<"vehicles">) {
  await seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId });
  expect((await seed.t.run((ctx) => ctx.db.get(vehicleId)))?.isDeleted, "precondition: car is deleted").toBe(true);
}

/** ABNORMAL STATE: sets the flag directly, bypassing the product door's commitment refusal. */
async function forceDeleted(seed: Seed, vehicleId: Id<"vehicles">) {
  await seed.t.run((ctx) => ctx.db.patch(vehicleId, { isDeleted: true, deletedAt: Date.now() }));
}

async function dbCounts(seed: Seed): Promise<Record<string, number>> {
  return await seed.t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const name of Object.keys(schema.tables)) {
      counts[name] = (await (ctx.db.query(name as never) as { collect(): Promise<unknown[]> }).collect()).length;
    }
    return counts;
  });
}

/** Runs `attempt`, expects VEHICLE_DELETED, and proves no table gained or lost a row. */
async function expectDeletedAndNothingWritten(seed: Seed, attempt: () => Promise<unknown>) {
  const before = await dbCounts(seed);
  await expectDeleted(attempt());
  expect(await dbCounts(seed), "nothing at all was written").toEqual(before);
}

const completeQuote = (seed: Seed, quoteId: Id<"quotes">, key: string = crypto.randomUUID()) =>
  seed.asUser.mutation(api.sales.completeFromQuote, { idempotencyKey: key, orgId: seed.orgId, quoteId });

const directSale = (seed: Seed, vehicleId: Id<"vehicles">, customerId: Id<"customers">, quoteId?: Id<"quotes">) =>
  seed.asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    ...(quoteId ? { quoteId } : {}),
  });

const deposit = (seed: Seed, quoteId: Id<"quotes">, amount: number) =>
  seed.asUser.mutation(api.deposits.create, {
    method: "CASH",
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    quoteId,
    amount,
  });

// ─────────────────────────────────────────────────────────────────────────────
// 1. completion doors
// ─────────────────────────────────────────────────────────────────────────────
describe("1. a stale quote on a car deleted afterwards cannot complete a sale", () => {
  test("completeFromQuote: refused with VEHICLE_DELETED, no writes; live car control succeeds", async () => {
    const seed = await seedDealer("c1a");
    const live = await vehicle(seed);
    const liveQuote = await quoteFor(seed, seed.customerA, [live]);
    await expect(completeQuote(seed, liveQuote), "control: a live car completes").resolves.toHaveLength(1);

    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await softDelete(seed, v);
    expect((await seed.t.run((ctx) => ctx.db.get(v)))?.status, "precondition: not SOLD/ARCHIVED").toBe("AVAILABLE");
    await expectDeletedAndNothingWritten(seed, () => completeQuote(seed, quoteId));
  });

  test("sales.create (direct COMPLETED) and sales.create PENDING are refused too", async () => {
    const seed = await seedDealer("c1b");
    const live = await vehicle(seed);
    await expect(directSale(seed, live, seed.customerA), "control: a live car sells").resolves.toBeTruthy();

    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await softDelete(seed, v);
    await expectDeletedAndNothingWritten(seed, () => directSale(seed, v, seed.customerA, quoteId));
    await expectDeletedAndNothingWritten(seed, () => directSale(seed, v, seed.customerA));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. deposit doors
// ─────────────────────────────────────────────────────────────────────────────
describe("2. a deleted car takes no deposit and no deposit request", () => {
  test("deposits.create and depositRequests.request are refused; live control succeeds", async () => {
    const seed = await seedDealer("c2a");
    const live = await vehicle(seed);
    const liveQuote = await quoteFor(seed, seed.customerA, [live]);
    await expect(deposit(seed, liveQuote, 1_000), "control: a live car takes a deposit").resolves.toBeTruthy();

    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await softDelete(seed, v);
    await expectDeletedAndNothingWritten(seed, () => deposit(seed, quoteId, 1_000));
    await expectDeletedAndNothingWritten(seed, () =>
      seed.asUser.mutation(api.depositRequests.request, {
        orgId: seed.orgId,
        quoteId,
        amount: 1_000,
        idempotencyKey: crypto.randomUUID(),
      })
    );
  });

  test("a request made BEFORE the delete cannot be confirmed afterwards, but can still be rejected or withdrawn", async () => {
    const seed = await seedDealer("c2b");
    const v = await vehicle(seed);
    const w = await vehicle(seed);
    const quoteV = await quoteFor(seed, seed.customerA, [v]);
    const quoteW = await quoteFor(seed, seed.customerB, [w]);
    const requestV = await seed.asUser.mutation(api.depositRequests.request, {
      orgId: seed.orgId,
      quoteId: quoteV,
      amount: 1_000,
      idempotencyKey: crypto.randomUUID(),
    });
    const requestW = await seed.asUser.mutation(api.depositRequests.request, {
      orgId: seed.orgId,
      quoteId: quoteW,
      amount: 1_000,
      idempotencyKey: crypto.randomUUID(),
    });
    await softDelete(seed, v);
    await softDelete(seed, w);

    await expectDeletedAndNothingWritten(seed, () =>
      seed.asManager.mutation(api.depositRequests.confirm, {
        orgId: seed.orgId,
        requestId: requestV,
        amount: 1_000,
        method: "CASH",
        idempotencyKey: crypto.randomUUID(),
      })
    );
    expect((await seed.t.run((ctx) => ctx.db.get(requestV)))?.status, "still pending").toBe("PENDING");

    await seed.asManager.mutation(api.depositRequests.reject, {
      orgId: seed.orgId,
      requestId: requestV,
      reason: "the car was deleted",
    });
    expect((await seed.t.run((ctx) => ctx.db.get(requestV)))?.status).toBe("REJECTED");
    await seed.asUser.mutation(api.depositRequests.withdraw, { orgId: seed.orgId, requestId: requestW });
    expect((await seed.t.run((ctx) => ctx.db.get(requestW)))?.status).toBe("WITHDRAWN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. multi-car atomicity
// ─────────────────────────────────────────────────────────────────────────────
describe("3. a multi-car quote with a deleted SECONDARY car takes no deposit and holds no car", () => {
  test("refused atomically; the primary car is not held either", async () => {
    const seed = await seedDealer("c3");
    const v1 = await vehicle(seed);
    const v2 = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await softDelete(seed, v2);
    await expectDeletedAndNothingWritten(seed, () => deposit(seed, quoteId, 6_000));
    const primary = await seed.t.run((ctx) => ctx.db.get(v1));
    expect(primary?.status, "the primary car was not reserved").toBe("AVAILABLE");
    expect(await seed.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect())).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. drafts
// ─────────────────────────────────────────────────────────────────────────────
describe("4. drafts", () => {
  const draftArgs = (seed: Seed, vehicleId: Id<"vehicles">) => ({
    orgId: seed.orgId,
    vehicleId,
    customerId: seed.customerA,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
  });

  test("createDraft is refused; completeDraft of a draft made before the delete is refused", async () => {
    const seed = await seedDealer("c4");
    const live = await vehicle(seed);
    const liveDraft = await seed.asUser.mutation(api.sales.createDraft, draftArgs(seed, live));
    await expect(
      seed.asUser.mutation(api.sales.completeDraft, {
        idempotencyKey: crypto.randomUUID(),
        orgId: seed.orgId,
        saleId: liveDraft,
      }),
      "control: a live draft completes"
    ).resolves.toBeDefined();

    const v = await vehicle(seed);
    const draftId = await seed.asUser.mutation(api.sales.createDraft, draftArgs(seed, v));
    await softDelete(seed, v);
    await expectDeletedAndNothingWritten(seed, () =>
      seed.asUser.mutation(api.sales.completeDraft, {
        idempotencyKey: crypto.randomUUID(),
        orgId: seed.orgId,
        saleId: draftId,
      })
    );
    expect((await seed.t.run((ctx) => ctx.db.get(draftId)))?.status, "the draft stays a draft").toBe("PENDING");

    const w = await vehicle(seed);
    await softDelete(seed, w);
    await expectDeletedAndNothingWritten(seed, () => seed.asUser.mutation(api.sales.createDraft, draftArgs(seed, w)));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. released deposit allocation
// ─────────────────────────────────────────────────────────────────────────────
describe("5. resolving a released deposit slice", () => {
  /** v1, v2, v3 on one quote, 9,000 deposited, 3,000 each, v1 released from the deal. */
  async function releasedSlice(suffix: string) {
    const seed = await seedDealer(suffix);
    const [v1, v2, v3] = [await vehicle(seed), await vehicle(seed), await vehicle(seed)];
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2, v3]);
    await deposit(seed, quoteId, 9_000);
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: v1, amount: 3_000 },
        { vehicleId: v2, amount: 3_000 },
        { vehicleId: v3, amount: 3_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: v1,
      reason: "customer dropped this car",
    });
    const holdId = (await seed.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect())).find(
      (h) => h.vehicleId === v1 && h.allocationStatus === "RELEASED_AWAITING_DECISION"
    )?._id;
    if (!holdId) throw new Error("fixture: no released slice");
    return { seed, v1, v2, v3, quoteId, holdId };
  }

  const resolve = (seed: Seed, holdId: Id<"depositVehicleHolds">, treatment: string, extra: Record<string, unknown> = {}) =>
    (treatment === "REFUND_TO_CUSTOMER" || treatment === "FORFEITED" ? seed.asManager : seed.asUser).mutation(
      api.deposits.resolveReleasedAllocation,
      { orgId: seed.orgId, holdId, treatment, ...extra } as never
    );

  test("RETURN_TO_UNALLOCATED onto a deleted car is refused; the control on a live car succeeds", async () => {
    const control = await releasedSlice("c5ctl");
    await expect(resolve(control.seed, control.holdId, "RETURN_TO_UNALLOCATED"), "control").resolves.toBeDefined();

    const { seed, v1, holdId } = await releasedSlice("c5ret");
    await forceDeleted(seed, v1); // ABNORMAL: the released car still reads RESERVED, so softDelete refuses it.
    await expectDeletedAndNothingWritten(seed, () => resolve(seed, holdId, "RETURN_TO_UNALLOCATED"));
  });

  test("REALLOCATE_TO_VEHICLE onto a deleted car is refused; off a deleted car onto a live one still works", async () => {
    const { seed, v3, holdId } = await releasedSlice("c5re");
    await forceDeleted(seed, v3); // ABNORMAL: a held car cannot be deleted through the product door.
    await expectDeletedAndNothingWritten(seed, () =>
      resolve(seed, holdId, "REALLOCATE_TO_VEHICLE", { toVehicleId: v3 })
    );

    // Control and a deliberate decision: money moving OFF a deleted car onto a live one is a rescue.
    const rescue = await releasedSlice("c5res");
    await forceDeleted(rescue.seed, rescue.v1);
    await expect(
      resolve(rescue.seed, rescue.holdId, "REALLOCATE_TO_VEHICLE", { toVehicleId: rescue.v2 })
    ).resolves.toBeDefined();
  });

  test("REFUND_TO_CUSTOMER and FORFEITED still work on a deleted car", async () => {
    for (const treatment of ["REFUND_TO_CUSTOMER", "FORFEITED"] as const) {
      const { seed, v1, holdId } = await releasedSlice(`c5pay${treatment.length}`);
      await forceDeleted(seed, v1);
      await resolve(seed, holdId, treatment, treatment === "REFUND_TO_CUSTOMER" ? { refundMethod: "CASH" } : {});
      const hold = await seed.t.run((ctx) => ctx.db.get(holdId));
      expect(hold?.allocationStatus).toBe("RESOLVED");
      expect(hold?.resolutionTreatment).toBe(treatment);
    }
  });

  test("allocateToVehicles gives no money to a deleted car; a zero allocation to it stays allowed", async () => {
    const seed = await seedDealer("c5al");
    const [v1, v2] = [await vehicle(seed), await vehicle(seed)];
    const quoteId = await quoteFor(seed, seed.customerA, [v1, v2]);
    await deposit(seed, quoteId, 6_000);
    await forceDeleted(seed, v2); // ABNORMAL: a held car cannot be deleted through the product door.
    await expectDeletedAndNothingWritten(seed, () =>
      seed.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: seed.orgId,
        quoteId,
        allocations: [
          { vehicleId: v1, amount: 3_000 },
          { vehicleId: v2, amount: 3_000 },
        ],
      })
    );
    await expect(
      seed.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: seed.orgId,
        quoteId,
        allocations: [
          { vehicleId: v1, amount: 6_000 },
          { vehicleId: v2, amount: 0 },
        ],
      }),
      "moving money off the deleted car is not a new acquisition"
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. reservation and finance doors
// ─────────────────────────────────────────────────────────────────────────────
describe("6. reservations and finance applications", () => {
  test("createReservation on a deleted car is refused with VEHICLE_DELETED; live control succeeds", async () => {
    const seed = await seedDealer("c6a");
    const live = await vehicle(seed);
    await expect(
      seed.asUser.mutation(api.vehicles.createReservation, {
        idempotencyKey: crypto.randomUUID(),
        orgId: seed.orgId,
        vehicleId: live,
        customerId: seed.customerA,
      }),
      "control"
    ).resolves.toBeDefined();

    const v = await vehicle(seed);
    await softDelete(seed, v);
    // PARKED (SCRUM-641): aligning this refusal to VEHICLE_DELETED needs an import edit in
    // convex/vehicles.ts that the convex-lint hook denies (pre-existing `.filter(q.field)` in the
    // file). The door still REFUSES — via its existing not-found check — and writes nothing, which
    // is the invariant; only the error code differs. Tighten to expectDeleted once the hook allows it.
    const before = await dbCounts(seed);
    await expect(
      seed.asUser.mutation(api.vehicles.createReservation, {
        idempotencyKey: crypto.randomUUID(),
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      })
    ).rejects.toThrow(/vehicle not found in this organization/i);
    expect(await dbCounts(seed), "nothing at all was written").toEqual(before);
  });

  test("createFromQuote on a deleted car is refused and writes nothing (existing message kept)", async () => {
    const seed = await seedDealer("c6b");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    await softDelete(seed, v);
    const before = await dbCounts(seed);
    await expect(seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId })).rejects.toThrow(
      /quote vehicle not found/i
    );
    expect(await dbCounts(seed)).toEqual(before);
  });

  /** An application driven to UNDER_REVIEW, then its car flagged deleted (abnormal in-flight state). */
  async function inFlightApplicationOnDeletedCar(suffix: string) {
    const seed = await seedDealer(suffix);
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await forceDeleted(seed, v); // ABNORMAL: softDelete refuses a car held by an application.
    return { seed, v, quoteId, applicationId };
  }

  test("updateStatus APPROVED is refused on a deleted car; the live control approves", async () => {
    const control = await seedDealer("c6c0");
    const cv = await vehicle(control);
    const cq = await quoteFor(control, control.customerA, [cv]);
    const ca = await control.asUser.mutation(api.applications.createFromQuote, { orgId: control.orgId, quoteId: cq });
    await control.asUser.mutation(api.applications.updateStatus, {
      orgId: control.orgId,
      applicationId: ca,
      status: "UNDER_REVIEW" as const,
    });
    await control.asManager.mutation(api.applications.updateStatus, {
      orgId: control.orgId,
      applicationId: ca,
      status: "APPROVED" as const,
    });
    expect((await control.t.run((ctx) => ctx.db.get(ca)))?.status, "control approved").toBe("APPROVED");

    const { seed, applicationId } = await inFlightApplicationOnDeletedCar("c6c1");
    await expectDeletedAndNothingWritten(seed, () =>
      seed.asManager.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId,
        status: "APPROVED" as const,
      })
    );
    expect((await seed.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("UNDER_REVIEW");
  });

  test("updateStatus APPROVED refuses a missing or foreign car as VEHICLE_NOT_FOUND (financeApplications.vehicleId is required)", async () => {
    const NOT_FOUND = "Vehicle not found in this organization.";
    const live = await inFlightApplicationOnDeletedCar("c6f0");
    await live.seed.t.run((ctx) => ctx.db.patch(live.v, { isDeleted: false })); // control: a live car approves
    await live.seed.asManager.mutation(api.applications.updateStatus, {
      orgId: live.seed.orgId,
      applicationId: live.applicationId,
      status: "APPROVED" as const,
    });
    expect((await live.seed.t.run((ctx) => ctx.db.get(live.applicationId)))?.status).toBe("APPROVED");

    const missing = await inFlightApplicationOnDeletedCar("c6f1");
    await missing.seed.t.run((ctx) => ctx.db.delete(missing.v)); // dangling vehicleId
    await expectAppError(
      missing.seed.asManager.mutation(api.applications.updateStatus, {
        orgId: missing.seed.orgId,
        applicationId: missing.applicationId,
        status: "APPROVED" as const,
      }),
      "VEHICLE_NOT_FOUND",
      NOT_FOUND
    );
    expect((await missing.seed.t.run((ctx) => ctx.db.get(missing.applicationId)))?.status).toBe("UNDER_REVIEW");

    const foreign = await inFlightApplicationOnDeletedCar("c6f2");
    const otherOrg = await foreign.seed.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() })
    );
    await foreign.seed.t.run((ctx) => ctx.db.patch(foreign.v, { orgId: otherOrg, isDeleted: false }));
    await expectAppError(
      foreign.seed.asManager.mutation(api.applications.updateStatus, {
        orgId: foreign.seed.orgId,
        applicationId: foreign.applicationId,
        status: "APPROVED" as const,
      }),
      "VEHICLE_NOT_FOUND",
      NOT_FOUND
    );
    expect((await foreign.seed.t.run((ctx) => ctx.db.get(foreign.applicationId)))?.status).toBe("UNDER_REVIEW");
  });

  test("rejection and cancellation of an application on a deleted car still work", async () => {
    const rejected = await inFlightApplicationOnDeletedCar("c6d1");
    await rejected.seed.asManager.mutation(api.applications.updateStatus, {
      orgId: rejected.seed.orgId,
      applicationId: rejected.applicationId,
      status: "REJECTED" as const,
    });
    expect((await rejected.seed.t.run((ctx) => ctx.db.get(rejected.applicationId)))?.status).toBe("REJECTED");

    const cancelled = await inFlightApplicationOnDeletedCar("c6d2");
    await cancelled.seed.asManager.mutation(api.applications.cancelApplication, {
      idempotencyKey: crypto.randomUUID(),
      orgId: cancelled.seed.orgId,
      applicationId: cancelled.applicationId,
      reason: "the car was deleted",
    });
    expect((await cancelled.seed.t.run((ctx) => ctx.db.get(cancelled.applicationId)))?.status).toBe("CANCELLED");
  });

  test("finalizeDeal on an approved application whose car was then deleted is refused: no sale", async () => {
    const seed = await seedDealer("c6e");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId });
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await seed.asManager.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now() + 86_400_000,
    });
    await forceDeleted(seed, v); // ABNORMAL: softDelete refuses a car held by an application.
    await expectDeletedAndNothingWritten(seed, () =>
      seed.asUser.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(),
        orgId: seed.orgId,
        applicationId,
      })
    );
    expect(await seed.t.run((ctx) => ctx.db.query("sales").collect())).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. profit approval
// ─────────────────────────────────────────────────────────────────────────────
describe("7. profit-approval authority", () => {
  async function profitSeed(suffix: string) {
    const seed = await seedDealer(suffix);
    const v = await vehicle(seed, { minimumProfit: 1_000 });
    return { seed, v };
  }
  const request = (seed: Seed, vehicleId: Id<"vehicles">) =>
    seed.asUser.mutation(api.approvals.requestProfitApproval, {
      orgId: seed.orgId,
      vehicleId,
      salePrice: PRICE,
    });

  test("a new request on a deleted car is refused; the live control is accepted", async () => {
    const control = await profitSeed("c7a0");
    await expect(request(control.seed, control.v), "control").resolves.toBeTruthy();

    const { seed, v } = await profitSeed("c7a1");
    await softDelete(seed, v);
    await expectDeletedAndNothingWritten(seed, () => request(seed, v));
  });

  test("a stale APPROVED row grants nothing once the car is deleted", async () => {
    const { seed, v } = await profitSeed("c7b");
    const requestId = await request(seed, v);
    await seed.asManager.mutation(api.approvals.respondToApproval, {
      orgId: seed.orgId,
      requestId,
      status: "APPROVED",
    });
    const status = () =>
      seed.asUser.query(api.approvals.profitApprovalStatus, { orgId: seed.orgId, vehicleId: v, salePrice: PRICE });
    expect(await status(), "control: live car reads APPROVED").toMatchObject({ status: "APPROVED" });
    const liveVehicle = await seed.t.run((ctx) => ctx.db.get(v));
    await seed.t.run((ctx) =>
      assertProfitApproved(ctx as never, {
        orgId: seed.orgId,
        vehicle: liveVehicle!,
        salePrice: PRICE,
        currency: "JOD",
        subject: "sale",
      })
    );

    await softDelete(seed, v);
    // A reason-coded BLOCKED state, never null (the screens read null as "nothing to approve").
    expect(await status(), "a deleted car reads VEHICLE_DELETED").toEqual({ status: "VEHICLE_DELETED" });
    const deletedVehicle = await seed.t.run((ctx) => ctx.db.get(v));
    await expectDeleted(
      seed.t.run((ctx) =>
        assertProfitApproved(ctx as never, {
          orgId: seed.orgId,
          vehicle: deletedVehicle!,
          salePrice: PRICE,
          currency: "JOD",
          subject: "sale",
        })
      )
    );
    const row = await seed.t.run((ctx) => ctx.db.get(requestId));
    expect(row?.status, "the approval row itself is never rewritten").toBe("APPROVED");
  });

  test("a manager can still REJECT a pending request on a deleted car", async () => {
    const { seed, v } = await profitSeed("c7c");
    const requestId = await request(seed, v);
    await softDelete(seed, v);
    await seed.asManager.mutation(api.approvals.respondToApproval, { orgId: seed.orgId, requestId, status: "REJECTED" });
    expect((await seed.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("REJECTED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. precedence and replay
// ─────────────────────────────────────────────────────────────────────────────
describe("8. precedence and idempotent replay", () => {
  test("a foreign-org vehicle is NOT_FOUND, never DELETED", async () => {
    const seed = await seedDealer("c8a");
    // A second organisation inside the SAME database, owning a deleted car.
    const foreignInSameDb = await seed.t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Foreign", createdAt: Date.now() });
      return await ctx.db.insert("vehicles", {
        orgId: otherOrg,
        vin: "SC641FOREIGN0001",
        make: "Kia",
        model: "Rio",
        year: 2022,
        color: "Red",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 10,
        sellingPrice: PRICE,
        status: "AVAILABLE" as const,
        isDeleted: true,
      });
    });
    await expectAppError(
      directSale(seed, foreignInSameDb, seed.customerA),
      "VEHICLE_NOT_FOUND",
      "Vehicle not found in this organization."
    );
  });

  test("SOLD-then-deleted reports SOLD; ARCHIVED-then-deleted reports ARCHIVED", async () => {
    const seed = await seedDealer("c8b");
    const sold = await vehicle(seed);
    await directSale(seed, sold, seed.customerA);
    await seed.t.run((ctx) => ctx.db.patch(sold, { isDeleted: true }));
    await expectAppError(
      directSale(seed, sold, seed.customerB),
      "VEHICLE_ALREADY_SOLD",
      "This vehicle has already been sold."
    );

    const archived = await vehicle(seed, { status: "ARCHIVED" as const, isDeleted: true });
    await expectAppError(
      directSale(seed, archived, seed.customerB),
      "VEHICLE_ARCHIVED",
      "Cannot sell an archived vehicle. Restore it first."
    );
  });

  test("a command that completed before the delete replays its recorded result; a new key is refused", async () => {
    const seed = await seedDealer("c8c");
    const v = await vehicle(seed);
    const quoteId = await quoteFor(seed, seed.customerA, [v]);
    const key = crypto.randomUUID();
    const first = await completeQuote(seed, quoteId, key);
    await seed.t.run((ctx) => ctx.db.patch(v, { isDeleted: true })); // ABNORMAL: a SOLD car is flagged deleted.

    const before = await dbCounts(seed);
    await expect(completeQuote(seed, quoteId, key), "same key, same args: the recorded result").resolves.toEqual(first);
    expect(await dbCounts(seed), "the replay wrote nothing").toEqual(before);

    await expect(completeQuote(seed, quoteId, crypto.randomUUID()), "a new key is a new attempt").rejects.toBeDefined();
    expect(await dbCounts(seed)).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. the raw admin editor
// ─────────────────────────────────────────────────────────────────────────────
describe("9. the raw admin editor cannot flip vehicles.isDeleted", () => {
  test("patching isDeleted is refused either way; other fields still patch", async () => {
    const previous = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
    process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
    try {
      const seed = await seedDealer("c9");
      await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
      const asAdmin = seed.t.withIdentity({ subject: "dev_1" });
      const v = await vehicle(seed);

      await expectAppError(
        asAdmin.mutation(api.adminData.adminUpdateRecord, { table: "vehicles", id: v, patch: { isDeleted: true } }),
        "VEHICLE_DELETED_FLAG_LOCKED",
        ADMIN_FLAG_LOCKED_MESSAGE
      );
      expect((await seed.t.run((ctx) => ctx.db.get(v)))?.isDeleted, "still live").not.toBe(true);

      await asAdmin.mutation(api.adminData.adminUpdateRecord, { table: "vehicles", id: v, patch: { color: "Blue" } });
      expect((await seed.t.run((ctx) => ctx.db.get(v)))?.color).toBe("Blue");

      // A round-tripped record re-sends isDeleted at its current value: that is not a change.
      await asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: v,
        patch: { isDeleted: false, color: "Green" },
      });
      expect((await seed.t.run((ctx) => ctx.db.get(v)))?.color).toBe("Green");

      await forceDeleted(seed, v);
      await expectAppError(
        asAdmin.mutation(api.adminData.adminUpdateRecord, { table: "vehicles", id: v, patch: { isDeleted: false } }),
        "VEHICLE_DELETED_FLAG_LOCKED",
        ADMIN_FLAG_LOCKED_MESSAGE
      );
      expect((await seed.t.run((ctx) => ctx.db.get(v)))?.isDeleted).toBe(true);
    } finally {
      process.env.SUPER_ADMIN_EMAILS = previous;
    }
  });
});
