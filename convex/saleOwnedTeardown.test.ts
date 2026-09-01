import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { restoreVehicleFromSale } from "./utils/saleHelpers";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-212 — destructive sale teardown belongs to ONE exact sale transition.
 *
 * The invariant, from the owner ruling (c16229):
 *
 *   Destructive sale teardown belongs to one exact sale transition and may
 *   execute at most once. Teardown for sale A must never restore, void or
 *   mutate projections owned by sale B.
 *
 * Every test here drives real public mutations. That is the whole point of the
 * exercise: sale A's paperwork is being used as authority over a car that sale
 * B now owns, so a fixture reaching into the database to build the "later sale"
 * would prove nothing about whether the doors actually permit it.
 */

async function seedTeardownOrg(
  t: ReturnType<typeof convexTestWithComponents>,
  suffix: string
) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Teardown ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}`,
      email: `${suffix}@example.com`,
      name: "Salesperson",
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
        "edit:vehicles",
        "view:commissions",
        "manage:commissions",
        "manage:finance",
        "view:finance",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  // Cancellation requires approve:requests AND an actor other than the
  // salesperson, so the manager is not a convenience here — it is the only way
  // to reach the cancellation door at all.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `user_${suffix}_mgr`,
      email: `${suffix}.mgr@example.com`,
      name: "Manager",
    })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Manager",
      permissions: [
        "view:sales",
        "edit:sales",
        "delete:sales",
        "approve:requests",
        "view:vehicles",
        "view:reports",
      ],
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
  );

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN-${suffix}`,
      make: "Toyota",
      model: "Camry",
      year: 2021,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 30000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "First",
      lastName: "Buyer",
      email: `${suffix}.one@example.com`,
    })
  );
  const secondCustomerId = await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Second",
      lastName: "Buyer",
      email: `${suffix}.two@example.com`,
    })
  );

  return {
    t,
    orgId,
    userId,
    vehicleId,
    customerId,
    secondCustomerId,
    asAdmin: t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` }),
    asManager: t.withIdentity({
      subject: `user_${suffix}_mgr`,
      clerkId: `user_${suffix}_mgr`,
    }),
  };
}

type Seeded = Awaited<ReturnType<typeof seedTeardownOrg>>;

async function vehicleStatus(s: Seeded) {
  const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
  return vehicle?.status;
}

// Collected rather than indexed: `ReturnType<typeof convexTestWithComponents>`
// drops the schema type parameter, so `withIndex` has no table types to read.
// The seeded dataset is a handful of rows, and filtering here keeps the helper
// typed the same way the rest of the suite's helpers are.
async function liveSaleTransactions(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const rows = await ctx.db.query("transactions").collect();
    return rows.filter(
      (r) =>
        r.orgId === s.orgId &&
        r.vehicleId === s.vehicleId &&
        r.category === "VEHICLE_SALE" &&
        r.isDeleted !== true
    );
  });
}

async function completeSale(
  s: Seeded,
  customerId: Id<"customers">,
  salePrice: number
): Promise<Id<"sales">> {
  return await s.asAdmin.mutation(api.sales.create, {
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    customerId,
    salespersonId: s.userId,
    salePrice,
    saleDate: Date.now(),
    status: "COMPLETED",
    financingType: "CASH",
  });
}

describe("SCRUM-212 — sale teardown may not act on a projection another sale owns", () => {
  test("soft-deleting a CANCELLED sale cannot free a car a later sale owns", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "sd_cancelled"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);
    expect(await vehicleStatus(s)).toBe("SOLD");

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });
    expect(await vehicleStatus(s)).toBe("AVAILABLE");

    // The car is legitimately sold again — a different customer, a real
    // completion through the ordinary door.
    const saleB = await completeSale(s, s.secondCustomerId, 21_000);
    expect(await vehicleStatus(s)).toBe("SOLD");

    // Now the old, already-cancelled paperwork is tidied away. This is routine
    // housekeeping, not a reversal: A gave the car back long ago.
    await s.asManager.mutation(api.sales.softDelete, { orgId: s.orgId, saleId: saleA });

    // The defect: restoreVehicleFromSale takes only a vehicleId, so it cannot
    // tell that the SOLD status it is undoing belongs to B rather than to A.
    expect(await vehicleStatus(s)).toBe("SOLD");

    const bAfter = await s.t.run((ctx) => ctx.db.get(saleB));
    expect(bAfter?.status).toBe("COMPLETED");
    expect(bAfter?.isDeleted).not.toBe(true);

    // B's cashflow is untouched: exactly its own live row, still its own.
    const live = await liveSaleTransactions(s);
    expect(live).toHaveLength(1);
    expect(live[0].customerId).toBe(s.secondCustomerId);
  });

  test("soft-deleting a PENDING draft cannot free a car a completed sale owns", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "sd_pending"
    );

    // A draft performs no inventory side effects, so it never marked the car
    // SOLD and has no completed-sale projection to give back.
    const draft = await s.asAdmin.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 19_000,
      saleDate: Date.now(),
    });

    const saleB = await completeSale(s, s.secondCustomerId, 21_000);
    expect(await vehicleStatus(s)).toBe("SOLD");

    await s.asManager.mutation(api.sales.softDelete, { orgId: s.orgId, saleId: draft });

    // Deleting a draft must not invent a reversal that was never performed.
    expect(await vehicleStatus(s)).toBe("SOLD");
    const bAfter = await s.t.run((ctx) => ctx.db.get(saleB));
    expect(bAfter?.status).toBe("COMPLETED");
  });

  test("cancelling the sale that actually owns the car still restores it, exactly once", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "sd_control"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);
    expect(await vehicleStatus(s)).toBe("SOLD");
    expect(await liveSaleTransactions(s)).toHaveLength(1);

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    // The positive control. A "fix" that simply stopped restoring vehicles, or
    // stopped voiding sale cashflow, would satisfy every assertion above and
    // break the feature — this is the test that refuses that shape.
    expect(await vehicleStatus(s)).toBe("AVAILABLE");
    expect(await liveSaleTransactions(s)).toHaveLength(0);
  });
});

/**
 * The two guards below are DEFENCE IN DEPTH, and this block says so rather
 * than dressing them up as reachable flows.
 *
 * Once destructive teardown runs only inside the one COMPLETED -> CANCELLED
 * transition, no public door can reach either of them: while sale A is
 * COMPLETED the car is SOLD, and completion refuses a SOLD car, so a later
 * sale B cannot exist at the moment A tears down. A mutation battery proved
 * exactly that — mutants restoring ownership-blind restoration and
 * customer-based cashflow matching both SURVIVED the reachable suite.
 *
 * They are kept anyway: c16229 asks that a helper able to restore a SOLD car
 * either require ownership proof OR be reachable only inside that transition,
 * and holding both means a future caller cannot quietly reintroduce the
 * defect by adding a third door. Tests that reach them directly are what stop
 * the guards decaying into decoration.
 */
describe("SCRUM-212 — the guards under the doors", () => {
  test("restoring a car requires proof that this sale is the one that sold it", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "depth_owner"
    );

    // A real, unrelated sale row to stand in for the later sale. Created first,
    // because `createDraft` refuses a car that is already SOLD.
    const otherSale = await s.asAdmin.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.secondCustomerId,
      salespersonId: s.userId,
      salePrice: 21_000,
      saleDate: Date.now(),
    });

    const saleA = await completeSale(s, s.customerId, 20_000);
    const owned = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(owned?.status).toBe("SOLD");
    expect(owned?.soldBySaleId).toBe(saleA);

    // Someone else owns this projection.
    await expect(
      s.t.run((ctx) =>
        restoreVehicleFromSale(ctx as unknown as MutationCtx, s.vehicleId, otherSale)
      )
    ).rejects.toThrow(/not the sale being reversed/i);

    // Refused, and refused without writing.
    const untouched = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(untouched?.status).toBe("SOLD");
    expect(untouched?.soldBySaleId).toBe(saleA);

    // A SOLD car with NO owner recorded is refused too — missing authority is
    // not permission, and there is deliberately no legacy fallback — but it is
    // refused with its OWN message. Both used to share one, which told the
    // operator to go and cancel a later sale that, in this case, does not
    // exist. Sonnet MAX reproduced that; the two causes are different facts and
    // only one of them names something anybody can act on.
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { soldBySaleId: undefined }));
    await expect(
      s.t.run((ctx) =>
        restoreVehicleFromSale(ctx as unknown as MutationCtx, s.vehicleId, saleA)
      )
    ).rejects.toThrow(/does not record which sale/i);

    // And the owner it names really can restore it — the guard refuses the
    // wrong sale, not every sale.
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { soldBySaleId: saleA }));
    await s.t.run((ctx) =>
      restoreVehicleFromSale(ctx as unknown as MutationCtx, s.vehicleId, saleA)
    );
    const restored = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(restored?.status).toBe("AVAILABLE");
    expect(restored?.soldBySaleId).toBeUndefined();
  });

  test("a second sale cannot complete on a car an earlier sale already owns", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "depth_exclusive"
    );

    // The exclusivity the owner ruling (c16334 §3) relies on INSTEAD of a
    // `sales` vehicle index: completion reads the projection and refuses a
    // car that is already SOLD, so the SOLD row is itself the mutual
    // exclusion, and `soldBySaleId` names the one sale allowed to reverse it.
    const saleA = await completeSale(s, s.customerId, 20_000);
    const owned = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(owned?.status).toBe("SOLD");
    expect(owned?.soldBySaleId).toBe(saleA);

    await expect(completeSale(s, s.secondCustomerId, 21_000)).rejects.toThrow(
      /already been sold/i
    );

    // Still exactly one owner, and it is still the first sale.
    const after = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(after?.status).toBe("SOLD");
    expect(after?.soldBySaleId).toBe(saleA);

    // ⚠️ SEQUENTIAL ONLY, and stated as such. `convex-test` serializes every
    // mutation and models no OCC, so the CONCURRENT case the ruling argues
    // from — two completions contending on the same vehicle row, the loser
    // retrying and then observing SOLD — is NOT verifiable here and is not
    // claimed by this test. What is proven is that the read-then-refuse path
    // exists and fires; the retry-then-observe half rests on Convex OCC.
  });

  test("cancelling a sale voids that sale's cashflow row and no other", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "depth_cashflow"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);

    // A VEHICLE_SALE row for the SAME car and the SAME customer that sale A
    // does not own. Inserted directly: `transactions.add` is a real public
    // door for such a row but takes no customerId, and it is the customer
    // match specifically that this proves is no longer used as authority.
    const foreignRow = await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId,
        type: "IN" as const,
        amount: 500,
        date: Date.now(),
        category: "VEHICLE_SALE" as const,
        description: "Row this sale does not own",
        vehicleId: s.vehicleId,
        customerId: s.customerId,
      })
    );

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    // A's own row is gone...
    const rows = await s.t.run(async (ctx) => {
      const all = await ctx.db.query("transactions").collect();
      return all.filter((r) => r.orgId === s.orgId);
    });
    const aRow = rows.find((r) => r.saleId === saleA);
    expect(aRow?.isDeleted).toBe(true);

    // ...and the row it never owned is untouched.
    const foreign = rows.find((r) => r._id === foreignRow);
    expect(foreign?.isDeleted).not.toBe(true);
  });

  test("another org's sale cannot be soft-deleted, and nothing is written trying", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const owner = await seedTeardownOrg(t, "depth_tenantA");
    const intruder = await seedTeardownOrg(t, "depth_tenantB");

    const saleA = await completeSale(owner, owner.customerId, 20_000);
    await owner.asManager.mutation(api.sales.update, {
      orgId: owner.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    // The intruder is a legitimate member of their OWN org, and names it.
    // Only the sale belongs to somebody else.
    await expect(
      intruder.asManager.mutation(api.sales.softDelete, {
        orgId: intruder.orgId,
        saleId: saleA,
      })
    ).rejects.toThrow();

    const stillThere = await t.run((ctx) => ctx.db.get(saleA));
    expect(stillThere?.isDeleted).not.toBe(true);
  });
});

/**
 * SCRUM-212-R1 / R2 — found by the Codex xhigh seat against 0dd4b9c3a, and
 * validated at the real lines before anything here was written.
 *
 * Both are places where the FIRST correction stopped short of the ruling it
 * was implementing:
 *
 *   R1. The teardown gate asked `sale.status !== "CANCELLED"`. The ruling asks
 *       for the exact COMPLETED -> CANCELLED transition, and those differ on
 *       every other status — PENDING most of all, because a CANCELLED sale
 *       could be reopened to PENDING through the ordinary update door.
 *
 *   R2. The void still filtered on `category` and searched the vehicle index,
 *       both of which a finance user can edit on the row afterwards. The
 *       ruling says not to select by vehicle or category as a monetary
 *       authority; `saleId` has to be the whole locator, not part of it.
 */
describe("SCRUM-212 — the locator and the transition must be exact", () => {
  test("a cancelled sale cannot be reopened to PENDING", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "r1_seal"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);
    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    // Reopening is what made the teardown gate reachable a second time: a
    // CANCELLED sale has already given its car back, reversed its journal and
    // reinstated its deposits. Sending it back to PENDING invites all of that
    // to happen again against a car someone else may now own.
    await expect(
      s.asManager.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId: saleA,
        status: "PENDING",
      })
    ).rejects.toThrow();

    const after = await s.t.run((ctx) => ctx.db.get(saleA));
    expect(after?.status).toBe("CANCELLED");
  });

  test("a car with no recorded owner is refused honestly, not blamed on a later sale", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "f2_message"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);

    // A SOLD car whose owning sale was never recorded. Under the clean-slate
    // ruling this is deliberately not backfilled, so the REFUSAL is correct.
    // The MESSAGE was not: it told the operator the car had been sold again
    // and to cancel that later sale instead, when no later sale exists at
    // all. Sonnet MAX reproduced that through this exact public door.
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { soldBySaleId: undefined }));

    await expect(
      s.asManager.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId: saleA,
        status: "CANCELLED",
      })
    ).rejects.toThrow(/does not record which sale/i);

    // ...and specifically does NOT accuse a later sale that does not exist.
    let message = "";
    try {
      await s.asManager.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId: saleA,
        status: "CANCELLED",
      });
    } catch (error) {
      message = String((error as Error).message ?? error);
    }
    expect(message).not.toMatch(/sold again/i);
  });
  test("cancelling a sale voids its cashflow row even after the row is reclassified", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "r2_category"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);
    const rows = await liveSaleTransactions(s);
    expect(rows).toHaveLength(1);

    // An ordinary finance edit through the public door. `category` is on the
    // args validator, and the mobile accounting screen offers it — so the row
    // keeps its saleId and its recognized revenue while ceasing to look like a
    // vehicle sale.
    await s.asAdmin.mutation(api.transactions.update, {
      orgId: s.orgId,
      transactionId: rows[0]._id,
      category: "DEPOSIT",
    });

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    // The row belongs to a sale that no longer exists. getProfitAndLoss counts
    // DEPOSIT as revenue, so leaving it live reports income for a cancelled
    // deal — the exact failure the void exists to prevent.
    const stillLive = await s.t.run(async (ctx) => {
      const all = await ctx.db.query("transactions").collect();
      return all.filter((r) => r.saleId === saleA && r.isDeleted !== true);
    });
    expect(stillLive).toHaveLength(0);
  });

  test("cancelling a sale voids its cashflow row even after the row is moved to another car", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "r2_vehicle"
    );

    const otherVehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        vin: "VIN-r2-other",
        make: "Kia",
        model: "Rio",
        year: 2019,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 40000,
        sellingPrice: 12000,
        status: "AVAILABLE" as const,
      })
    );

    const saleA = await completeSale(s, s.customerId, 20_000);
    const rows = await liveSaleTransactions(s);
    expect(rows).toHaveLength(1);

    // The second escape: the row keeps category VEHICLE_SALE but leaves the
    // index range the void searched.
    await s.asAdmin.mutation(api.transactions.update, {
      orgId: s.orgId,
      transactionId: rows[0]._id,
      vehicleId: otherVehicleId,
    });

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    const stillLive = await s.t.run(async (ctx) => {
      const all = await ctx.db.query("transactions").collect();
      return all.filter((r) => r.saleId === saleA && r.isDeleted !== true);
    });
    expect(stillLive).toHaveLength(0);
  });

  test("a row that never belonged to a sale is still left alone", async () => {
    const s = await seedTeardownOrg(
      convexTestWithComponents(schema, import.meta.glob("./**/*.ts")),
      "r2_control"
    );

    const saleA = await completeSale(s, s.customerId, 20_000);

    // The control that stops R2's fix widening into 'void everything on this
    // car': a manually entered VEHICLE_SALE row carries no saleId and is no
    // sale's to void.
    const manual = await s.asAdmin.mutation(api.transactions.add, {
      orgId: s.orgId,
      type: "IN",
      amount: 750,
      date: Date.now(),
      category: "VEHICLE_SALE",
      description: "Manually entered, owned by nobody",
      vehicleId: s.vehicleId,
    });

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId: saleA,
      status: "CANCELLED",
    });

    const manualRow = await s.t.run((ctx) => ctx.db.get(manual));
    expect(manualRow?.isDeleted).not.toBe(true);
  });
});
