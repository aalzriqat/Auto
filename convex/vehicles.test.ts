import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

const PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "delete:vehicles",
  "view:vehicles", "view:users", "manage:users",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_v1", email: "v@test.com", name: "Vehicle User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_v1" });
  return { t, orgId, userId, roleId, asUser };
}

const baseVehicle = {
  vin: "1HGCM82633A000001",
  make: "Honda",
  model: "Accord",
  year: 2020,
  mileage: 10000,
  color: "White",
  fuelType: "Gasoline",
  transmission: "Automatic",
  sellingPrice: 20000,
  status: "AVAILABLE" as const,
};

describe("vehicles.create", () => {
  test("creates a vehicle and records an audit edit", async () => {
    const { t, orgId, asUser } = await setup();

    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
    });

    expect(vehicleId).toBeDefined();

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.make).toBe("Honda");
      expect(vehicle?.status).toBe("AVAILABLE");
      expect(vehicle?.vin).toBe("1HGCM82633A000001");

      const edit = await ctx.db
        .query("vehicleEdits")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(edit?.type).toBe("CREATE");
      expect(edit?.status).toBe("APPROVED");
    });
  });

  test("rejects unauthenticated requests", async () => {
    const { t, orgId } = await setup();

    await expect(
      t.mutation(api.vehicles.create, { orgId, ...baseVehicle })
    ).rejects.toThrow();
  });

  test("rejects duplicate VIN within the same org", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle })
    ).rejects.toThrow(/already exists/i);
  });

  test("allows same VIN in a different org", async () => {
    const { t, asUser, orgId } = await setup();

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const userId2 = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_v2", email: "v2@test.com", name: "User 2" })
    );
    const roleId2 = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: orgId2, name: "ADMIN", permissions: PERMISSIONS })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: orgId2, userId: userId2, roleId: roleId2 }));
    const asUser2 = t.withIdentity({ subject: "user_v2" });

    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const id2 = await asUser2.mutation(api.vehicles.create, { orgId: orgId2, ...baseVehicle });

    expect(id2).toBeDefined();
  });
});

describe("vehicles.softDelete", () => {
  test("marks vehicle as deleted", async () => {
    const { t, orgId, asUser } = await setup();

    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
    });

    await asUser.mutation(api.vehicles.softDelete, { orgId, vehicleId });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.isDeleted).toBe(true);
    });
  });

  test("rejects deleting a vehicle from another org", async () => {
    const { t, orgId, userId, asUser } = await setup();

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );

    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicles.softDelete, { orgId: orgId2, vehicleId })
    ).rejects.toThrow();
  });
});

describe("vehicles.update — auto-post on status → AVAILABLE", () => {
  test("queues an auto-post when enabled, connected, and the vehicle has photos", async () => {
    const { t, orgId, asUser } = await setup();

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"])));
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      status: "IN_INSPECTION",
    });
    await t.run((ctx) => ctx.db.patch(vehicleId, { imageIds: [storageId] }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
        socialAutoPostEnabled: true,
      })
    );

    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, status: "AVAILABLE" });

    await t.run(async (ctx) => {
      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(1);
      expect(posts[0].status).toBe("PENDING");
      expect(posts[0].triggeredBy).toBe("auto");
    });
  });

  test("does not queue a post when auto-post is disabled", async () => {
    const { t, orgId, asUser } = await setup();

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"])));
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      status: "IN_INSPECTION",
    });
    await t.run((ctx) => ctx.db.patch(vehicleId, { imageIds: [storageId] }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
        socialAutoPostEnabled: false,
      })
    );

    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, status: "AVAILABLE" });

    await t.run(async (ctx) => {
      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(0);
    });
  });

  test("does not queue a post when the vehicle has no photos", async () => {
    const { t, orgId, asUser } = await setup();

    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      status: "IN_INSPECTION",
    });
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
        socialAutoPostEnabled: true,
      })
    );

    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, status: "AVAILABLE" });

    await t.run(async (ctx) => {
      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(0);
    });
  });

  test("does not re-trigger when the vehicle was already AVAILABLE", async () => {
    const { t, orgId, asUser } = await setup();

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"])));
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      status: "AVAILABLE",
    });
    await t.run((ctx) => ctx.db.patch(vehicleId, { imageIds: [storageId] }));
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
        socialAutoPostEnabled: true,
      })
    );

    // Already AVAILABLE — an unrelated field update shouldn't re-trigger a post.
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, status: "AVAILABLE", mileage: 11000 });

    await t.run(async (ctx) => {
      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(0);
    });
  });
});
