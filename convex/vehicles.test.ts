import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "delete:vehicles",
  "view:vehicles", "view:users", "manage:users", "view:reports",
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

describe("vehicles.listAll includeReserved", () => {
  test("status AVAILABLE without includeReserved excludes RESERVED vehicles", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700001", status: "AVAILABLE" });
    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700002", status: "RESERVED" });

    const results = await asUser.query(api.vehicles.listAll, { orgId, status: "AVAILABLE" });
    expect(results.every((v) => v.status === "AVAILABLE")).toBe(true);
    expect(results.length).toBe(1);
  });

  test("status AVAILABLE with includeReserved also returns RESERVED vehicles", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700003", status: "AVAILABLE" });
    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700004", status: "RESERVED" });

    const results = await asUser.query(api.vehicles.listAll, { orgId, status: "AVAILABLE", includeReserved: true });
    const statuses = results.map((v) => v.status).sort();
    expect(statuses).toEqual(["AVAILABLE", "RESERVED"]);
  });
});

describe("inventory intelligence", () => {
  test("getAgingBuckets counts available vehicles by age", async () => {
    vi.useFakeTimers();
    try {
      const { orgId, asUser } = await setup();
      const now = new Date("2026-06-25T00:00:00.000Z");

      for (const [daysOld, vin] of [
        [10, "1HGCM82633A800001"],
        [45, "1HGCM82633A800002"],
        [75, "1HGCM82633A800003"],
        [120, "1HGCM82633A800004"],
      ] as const) {
        vi.setSystemTime(now.getTime() - daysOld * 24 * 60 * 60 * 1000);
        await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin });
      }

      vi.setSystemTime(now);
      const buckets = await asUser.query(api.vehicles.getAgingBuckets, { orgId });

      expect(buckets).toMatchObject([
        { bucket: "0-30", count: 1, avgDays: 10 },
        { bucket: "31-60", count: 1, avgDays: 45 },
        { bucket: "61-90", count: 1, avgDays: 75 },
        { bucket: "90+", count: 1, avgDays: 120 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("upsertLandedCosts recomputes total and requires edit permission", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicles.upsertLandedCosts, {
        orgId,
        vehicleId,
        items: [
          { label: "Shipping", amount: 500 },
          { label: "Customs", amount: 750 },
        ],
      })
    ).resolves.toEqual({ total: 1250 });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.landedCostTotal).toBe(1250);
    });

    const viewerId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "viewer_v1", email: "viewer@test.com", name: "Viewer" })
    );
    const viewerRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "VIEWER", permissions: ["view:vehicles"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));
    const asViewer = t.withIdentity({ subject: "viewer_v1" });

    await expect(
      asViewer.mutation(api.vehicles.upsertLandedCosts, {
        orgId,
        vehicleId,
        items: [{ label: "Shipping", amount: 100 }],
      })
    ).rejects.toThrow(/edit:vehicles/);
  });

  test("reports use landed cost total before purchase price", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      purchasePrice: 8000,
      sellingPrice: 15000,
    });
    await asUser.mutation(api.vehicles.upsertLandedCosts, {
      orgId,
      vehicleId,
      items: [{ label: "Landed", amount: 12000 }],
    });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer" })
    );
    const saleDate = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 15000,
        saleDate,
        status: "COMPLETED",
      })
    );

    const report = await asUser.query(api.reports.getSalesAndProfitReport, {
      orgId,
      startDate: saleDate - 1000,
      endDate: saleDate + 1000,
    });

    expect(report.sales[0].vehicleCost).toBe(12000);
    expect(report.sales[0].netProfit).toBe(3000);
  });

  test("price history is inserted only when selling price changes", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      sellingPrice: 20000,
    });

    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sellingPrice: 21000 });
    await asUser.mutation(api.vehicles.update, { orgId, vehicleId, sellingPrice: 21000, mileage: 11000 });

    await t.run(async (ctx) => {
      const history = await ctx.db
        .query("vehiclePriceHistory")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ oldPrice: 20000, newPrice: 21000 });
    });
  });

  test("approved vehicle edit price changes insert price history", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      sellingPrice: 20000,
    });
    const requestId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        vehicleId,
        requestedBy: userId,
        type: "UPDATE",
        payload: { sellingPrice: 23000 },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });

    await t.run(async (ctx) => {
      const history = await ctx.db
        .query("vehiclePriceHistory")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ oldPrice: 20000, newPrice: 23000 });
    });
  });

  test("createReservation reserves vehicle and releaseReservation makes it available", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Reserve", lastName: "Customer" })
    );

    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
      depositAmount: 1000,
    });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("RESERVED");
    });

    await asUser.mutation(api.vehicles.releaseReservation, { orgId, reservationId });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      const reservation = await ctx.db.get(reservationId);
      expect(vehicle?.status).toBe("AVAILABLE");
      expect(reservation?.status).toBe("RELEASED");
    });
  });
});
