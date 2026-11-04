import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { supplierIdFor } from "../test-utils/supplierFixture";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { sourcedCostMirrorPatch } from "./utils/vehicleSourceShape";

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const { orgId, userId } = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Synthetic dealer", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "scrum907", email: "907@example.test", name: "Test" });
    const roleId = await ctx.db.insert("roles", {
      orgId, name: "ADMIN", permissions: ["create:vehicles", "edit:vehicles", "view:cost_price", "view:vehicles"],
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { orgId, userId };
  });
  const asUser = t.withIdentity({ subject: "scrum907" });
  const sourcedSupplierId = await supplierIdFor(t, orgId, "Synthetic supplier");
  const vehicleId = await asUser.mutation(api.vehicles.create, {
    orgId, idempotencyKey: crypto.randomUUID(), vin: "1HGCM82633A009070", make: "Honda", model: "Accord",
    year: 2020, mileage: 10000, color: "White", fuelType: "Gasoline", transmission: "Automatic",
    status: "AVAILABLE", sellingPrice: 12000, sourceType: "SOURCED", sourceCost: 10250, sourcedSupplierId,
  });
  return { t, orgId, userId, vehicleId, asUser };
}

describe("SCRUM-907 sourced cost mirror", () => {
  test("updating supplier cost mirrors purchasePrice and the approved edit audit", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 9900 });
    await t.run(async (ctx) => {
      expect(await ctx.db.get(vehicleId)).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
      const edits = await ctx.db.query("vehicleEdits").withIndex("by_org", q => q.eq("orgId", orgId)).collect();
      expect(edits.find(edit => edit.type === "UPDATE")?.payload).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
    });
  });

  test("conflicting submitted costs are refused without changing the vehicle or its audit", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    const before = await t.run(ctx => ctx.db.get(vehicleId));
    await expect(asUser.mutation(api.vehicles.update, {
      orgId, vehicleId, sourceCost: 9900, purchasePrice: 10250,
    })).rejects.toThrow(/VEHICLE_SOURCED_COST_CONFLICT/);
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toEqual(before);
    const edits = await t.run(ctx => ctx.db.query("vehicleEdits").collect());
    expect(edits.filter(edit => edit.type === "UPDATE")).toEqual([]);
  });

  test("a purchasePrice-only edit cannot contradict the supplier cost", async () => {
    const { orgId, vehicleId, asUser } = await setup();
    await expect(asUser.mutation(api.vehicles.update, {
      orgId, vehicleId, purchasePrice: 9900,
    })).rejects.toThrow(/VEHICLE_SOURCED_COST_CONFLICT/);
  });

  test("matching submitted costs on a real live cost change still mirror", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, purchasePrice: 9900, sourceCost: 9900 });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
  });

  test("M1 older mobile can edit a stale SOLD row with its unchanged purchasePrice", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await t.run(ctx => ctx.db.patch(vehicleId, { status: "SOLD", sourceCost: 9900 }));
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, color: "Blue", purchasePrice: 10250 });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({ color: "Blue", sourceCost: 9900, purchasePrice: 10250 });
    const edits = await t.run(ctx => ctx.db.query("vehicleEdits").collect());
    expect(edits.find(edit => edit.type === "UPDATE")?.payload).toEqual({ color: "Blue" });
    for (const purchasePrice of [9800, 9900]) {
      await expect(asUser.mutation(api.vehicles.update, { orgId, vehicleId, purchasePrice })).rejects.toThrow(/VEHICLE_SOURCED_COST_CONFLICT/);
    }
  });

  async function assertEchoPreservesHistory(lock: "SOLD" | "opening" | "posted") {
    const fixture = await setup();
    const { t, orgId, vehicleId, userId, asUser } = fixture;
    await t.run(async ctx => {
      await ctx.db.patch(vehicleId, { sourceCost: 9900, ...(lock === "SOLD" ? { status: "SOLD" as const } : {}) });
      if (lock === "opening") await ctx.db.patch(vehicleId, { openingBalanceDraftId: await ctx.db.insert("openingBalanceDrafts", {
        orgId, status: "PENDING_APPROVAL", lines: [], asOfDate: Date.now(), createdBy: userId, createdAt: Date.now(),
      }) });
    });
    if (lock === "posted") await seedAcquisition(fixture);
    const before = await t.run(ctx => ctx.db.get(vehicleId));
    const editsBefore = await t.run(ctx => ctx.db.query("vehicleEdits").collect());
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 9900 });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toEqual(before);
    expect(await t.run(ctx => ctx.db.query("vehicleEdits").collect())).toEqual(editsBefore);
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sourceCost: 9900, notes: "direct note" });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({ sourceCost: 9900, purchasePrice: 10250, notes: "direct note" });
    await expect(asUser.mutation(api.vehicleEdits.requestUpdate, { orgId, vehicleId, payload: { sourceType: "SOURCED", sourceCost: 9900 } })).rejects.toThrow(/No changes detected/);
    const requestId = await asUser.mutation(api.vehicleEdits.requestUpdate, { orgId, vehicleId, payload: { sourceType: "SOURCED", sourceCost: 9900, notes: "requested note" } });
    expect((await t.run(ctx => ctx.db.get(requestId)))?.payload).toEqual({ notes: "requested note" });
    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });
    const oldRequestId = await t.run(ctx => ctx.db.insert("vehicleEdits", {
      orgId, vehicleId, requestedBy: userId, type: "UPDATE", payload: { sourceType: "SOURCED", sourceCost: 9900, purchasePrice: 10250, notes: "legacy note" }, status: "PENDING", createdAt: Date.now(),
    }));
    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId: oldRequestId, status: "APPROVED" });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({ sourceCost: 9900, purchasePrice: 10250, notes: "legacy note" });
    const edits = await t.run(ctx => ctx.db.query("vehicleEdits").collect());
    expect(edits.filter(edit => edit.type === "UPDATE").every(edit => !("purchasePrice" in edit.payload))).toBe(true);
    const echoRequestId = await t.run(ctx => ctx.db.insert("vehicleEdits", {
      orgId, vehicleId, requestedBy: userId, type: "UPDATE", payload: { sourceCost: 9900 }, status: "PENDING", createdAt: Date.now(),
    }));
    const beforeEchoApproval = await t.run(ctx => ctx.db.get(vehicleId));
    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId: echoRequestId, status: "APPROVED" });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toEqual(beforeEchoApproval);
  }

  test("M2 unchanged sourceCost echo preserves SOLD history through every update door", () => assertEchoPreservesHistory("SOLD"));
  test("M2 unchanged sourceCost echo preserves opening history through every update door", () => assertEchoPreservesHistory("opening"));
  test("M2 unchanged sourceCost echo preserves posted history through every update door", () => assertEchoPreservesHistory("posted"));

  test("STOCK-to-SOURCED normalization derives the mirror without opening the pilot gate", () => {
    expect(sourcedCostMirrorPatch({ sourceType: "STOCK", purchasePrice: 8000 }, {
      sourceType: "SOURCED", sourceCost: 9900,
    })).toEqual({ purchasePrice: 9900 });
    expect(sourcedCostMirrorPatch({ sourceType: "STOCK", purchasePrice: 8000 }, {
      purchasePrice: 9000,
    })).toEqual({});
  });

  test("requested supplier cost is mirrored and conflicting approval requests are refused", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await expect(asUser.mutation(api.vehicleEdits.requestUpdate, {
      orgId, vehicleId, payload: { sourceCost: 9900, purchasePrice: 10250 },
    })).rejects.toThrow(/VEHICLE_SOURCED_COST_CONFLICT/);
    const requestId = await asUser.mutation(api.vehicleEdits.requestUpdate, { orgId, vehicleId, payload: { sourceCost: 9900 } });
    expect((await t.run(ctx => ctx.db.get(requestId)))?.payload).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });
    expect(await t.run(ctx => ctx.db.get(vehicleId))).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
  });

  test("an older conflicting approval request is refused and stays pending", async () => {
    const { t, orgId, vehicleId, userId, asUser } = await setup();
    const requestId = await t.run(ctx => ctx.db.insert("vehicleEdits", {
      orgId, vehicleId, requestedBy: userId, type: "UPDATE", payload: { sourceCost: 9900, purchasePrice: 10250 }, status: "PENDING", createdAt: Date.now(),
    }));
    await expect(asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })).rejects.toThrow(/VEHICLE_SOURCED_COST_CONFLICT/);
    expect((await t.run(ctx => ctx.db.get(requestId)))?.status).toBe("PENDING");
    expect((await t.run(ctx => ctx.db.get(vehicleId)))?.sourceCost).toBe(10250);
  });

  test("posted acquisition still locks supplier cost and the mirror", async () => {
    const fixture = await setup();
    await seedAcquisition(fixture);
    await expect(fixture.asUser.mutation(api.vehicles.update, {
      orgId: fixture.orgId, vehicleId: fixture.vehicleId, sourceCost: 9900,
    })).rejects.toThrow(/VEHICLE_COST_POSTED/);
    expect(await fixture.t.run(ctx => ctx.db.get(fixture.vehicleId))).toMatchObject({ sourceCost: 10250, purchasePrice: 10250 });
  });

  test("an old pending supplier-cost request applies and audits the mirror at approval", async () => {
    const { t, orgId, vehicleId, userId, asUser } = await setup();
    const requestId = await t.run(ctx => ctx.db.insert("vehicleEdits", {
      orgId, vehicleId, requestedBy: userId, type: "UPDATE", payload: { sourceCost: 9900 }, status: "PENDING", createdAt: Date.now(),
    }));
    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });
    await t.run(async ctx => {
      expect(await ctx.db.get(vehicleId)).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
      expect((await ctx.db.get(requestId))?.payload).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
    });
  });

  test("repair pages mismatches idempotently and leaves STOCK and deleted vehicles untouched", async () => {
    const { t, orgId, userId, vehicleId } = await setup();
    const { stockId, deletedId } = await t.run(async ctx => {
      await ctx.db.patch(vehicleId, { sourceCost: 9900 });
      const fields = { orgId, make: "Honda", model: "Accord", year: 2020, mileage: 0, color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12000, status: "AVAILABLE" as const, addedBy: userId };
      const stockId = await ctx.db.insert("vehicles", { ...fields, sourceType: "STOCK", sourceCost: 9900, purchasePrice: 8000 });
      const deletedId = await ctx.db.insert("vehicles", { ...fields, sourceType: "SOURCED", sourceCost: 9900, purchasePrice: 8000, isDeleted: true });
      return { stockId, deletedId };
    });
    const first = await t.mutation(internal.vehicles.backfillSourcedCostMirror, { numItems: 1 });
    expect(first).toMatchObject({ scanned: 1, updated: 1, skippedLocked: 0, skippedInvalid: 0, isDone: false });
    const rest = await t.mutation(internal.vehicles.backfillSourcedCostMirror, { numItems: 25, cursor: first.continueCursor });
    expect(rest).toMatchObject({ scanned: 2, updated: 0, isDone: true });
    const second = await t.mutation(internal.vehicles.backfillSourcedCostMirror, {});
    expect(second).toMatchObject({ scanned: 3, updated: 0, skippedLocked: 0, skippedInvalid: 0, isDone: true });
    await t.run(async ctx => {
      expect(await ctx.db.get(vehicleId)).toMatchObject({ sourceCost: 9900, purchasePrice: 9900 });
      expect((await ctx.db.get(stockId))?.purchasePrice).toBe(8000);
      expect((await ctx.db.get(deletedId))?.purchasePrice).toBe(8000);
    });
  });

  test("repair reports posted-cost locks and does not change them", async () => {
    const fixture = await setup();
    await seedAcquisition(fixture);
    await fixture.t.run(ctx => ctx.db.patch(fixture.vehicleId, { sourceCost: 9900 }));
    expect(await fixture.t.mutation(internal.vehicles.backfillSourcedCostMirror, {})).toMatchObject({ updated: 0, skippedLocked: 1 });
    expect((await fixture.t.run(ctx => ctx.db.get(fixture.vehicleId)))?.purchasePrice).toBe(10250);
  });

  test("repair reports sold, opening-locked and unreadable supplier costs without changing them", async () => {
    const { t, orgId, userId, vehicleId } = await setup();
    const ids = await t.run(async ctx => {
      const vehicle = await ctx.db.get(vehicleId);
      if (!vehicle) throw new Error("missing fixture");
      const { _id, _creationTime, ...fields } = vehicle;
      await ctx.db.patch(vehicleId, { sourceCost: 9900, status: "SOLD" });
      const openingId = await ctx.db.insert("vehicles", { ...fields, sourceCost: 9900, openingBalanceDraftId: await ctx.db.insert("openingBalanceDrafts", {
        orgId, status: "PENDING_APPROVAL", lines: [], asOfDate: Date.now(), createdBy: userId, createdAt: Date.now(),
      }) });
      const invalidId = await ctx.db.insert("vehicles", { ...fields, sourceCost: undefined });
      return [vehicleId, openingId, invalidId];
    });
    expect(await t.mutation(internal.vehicles.backfillSourcedCostMirror, {})).toMatchObject({ scanned: 3, updated: 0, skippedLocked: 2, skippedInvalid: 1 });
    for (const id of ids) expect((await t.run(ctx => ctx.db.get(id)))?.purchasePrice).toBe(10250);
  });

  test.each([0, 26, 1.5, NaN, Infinity])("repair refuses an invalid page size (%s) with a generic error", async numItems => {
    const { t, vehicleId } = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(t.mutation(internal.vehicles.backfillSourcedCostMirror, { numItems })).rejects.toThrow("Unable to repair vehicle costs. Please try again later.");
      expect((await t.run(ctx => ctx.db.get(vehicleId)))?.purchasePrice).toBe(10250);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});

async function seedAcquisition({ t, orgId, userId, vehicleId }: Awaited<ReturnType<typeof setup>>) {
  await t.run(ctx => ctx.db.insert("accountingEvents", {
    orgId, eventType: "VEHICLE_ACQUIRED", sourceType: "vehicles", sourceId: vehicleId,
    eventVersion: 1, idempotencyKey: `vehicle_acquired_${vehicleId}`, occurredAt: Date.now(), accountingDate: Date.now(),
    currency: "JOD", payload: {}, status: "POSTED", createdBy: userId, createdAt: Date.now(),
  }));
}
