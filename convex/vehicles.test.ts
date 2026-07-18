import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "delete:vehicles",
  "view:vehicles", "view:users", "manage:users", "view:reports", "view:sales",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
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

  test.each(["SOLD", "RESERVED"] as const)(
    "rejects creating vehicles directly as %s",
    async (status) => {
      const { orgId, asUser } = await setup();

      await expect(
        asUser.mutation(api.vehicles.create, {
          orgId,
          ...baseVehicle,
          status,
        })
      ).rejects.toThrow(/sale|reservation|deposit/i);
    }
  );

  test("rejects non-image storage IDs in vehicle images", async () => {
    const { t, orgId, asUser } = await setup();
    const pdfStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["%PDF-1.4"], { type: "application/pdf" }))
    );

    await expect(
      asUser.mutation(api.vehicles.create, {
        orgId,
        ...baseVehicle,
        imageIds: [pdfStorageId],
      })
    ).rejects.toThrow(/allowed file type|JPEG|PNG|WebP/i);
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

describe("vehicles.createSourced", () => {
  const sourcedArgs = {
    make: "Toyota",
    model: "Camry",
    year: 2024,
    color: "White",
    mileage: 0,
    fuelType: "Gasoline",
    transmission: "Automatic",
    sourcedFromName: "Al-Safeer Motors",
    sourceCost: 18000,
    sellingPrice: 21000,
  };

  test("a sales role with only create:vehicles:request (no create:vehicles) can source a vehicle", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Sales Sourcing Dealer", createdAt: Date.now() })
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
      ctx.db.insert("users", { clerkId: "sales_sourcer", email: "sales@test.com", name: "Sales User" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "SALES",
        permissions: ["view:vehicles", "create:vehicles:request", "view:sales"],
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asSales = t.withIdentity({ subject: "sales_sourcer" });

    const vehicleId = await asSales.mutation(api.vehicles.createSourced, { orgId, ...sourcedArgs });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOURCING");
      expect(vehicle?.sourceType).toBe("SOURCED");
      expect(vehicle?.sourcedFromName).toBe("Al-Safeer Motors");

      const edit = await ctx.db
        .query("vehicleEdits")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(edit?.type).toBe("CREATE");
      expect(edit?.status).toBe("APPROVED");
    });
  });

  test("rejects a role with neither create:vehicles nor create:vehicles:request", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "No Sourcing Dealer", createdAt: Date.now() })
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
      ctx.db.insert("users", { clerkId: "reception_user", email: "reception@test.com", name: "Reception User" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "RECEPTION", permissions: ["view:vehicles"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const asReception = t.withIdentity({ subject: "reception_user" });

    await expect(
      asReception.mutation(api.vehicles.createSourced, { orgId, ...sourcedArgs })
    ).rejects.toThrow(/create:vehicles/);
  });
});

describe("vehicles.update — protected lifecycle transitions", () => {
  test.each(["SOLD", "RESERVED"] as const)(
    "rejects direct updates to %s",
    async (status) => {
      const { orgId, asUser } = await setup();
      const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

      await expect(
        asUser.mutation(api.vehicles.update, { orgId, vehicleId, status })
      ).rejects.toThrow(/sale|reservation|deposit/i);
    }
  );

  test("rejects making a sold vehicle available outside the sale workflow", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    await expect(
      asUser.mutation(api.vehicles.update, { orgId, vehicleId, status: "AVAILABLE" })
    ).rejects.toThrow(/sale workflow/i);
  });

  test("rejects changing a reserved vehicle outside the reservation workflow", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "RESERVED" }));

    await expect(
      asUser.mutation(api.vehicles.update, { orgId, vehicleId, status: "IN_REPAIR" })
    ).rejects.toThrow(/reservation|deposit/i);
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
    const { t, orgId, asUser } = await setup();

    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700001", status: "AVAILABLE" });
    const reservedVehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700002", status: "AVAILABLE" });
    await t.run((ctx) => ctx.db.patch(reservedVehicleId, { status: "RESERVED" }));

    const results = await asUser.query(api.vehicles.listAll, { orgId, status: "AVAILABLE" });
    expect(results.every((v) => v.status === "AVAILABLE")).toBe(true);
    expect(results.length).toBe(1);
  });

  test("status AVAILABLE with includeReserved also returns RESERVED vehicles", async () => {
    const { t, orgId, asUser } = await setup();

    await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700003", status: "AVAILABLE" });
    const reservedVehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, vin: "1HGCM82633A700004", status: "AVAILABLE" });
    await t.run((ctx) => ctx.db.patch(reservedVehicleId, { status: "RESERVED" }));

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
          { label: "Shipping", amount: 500, paymentMethod: "CASH" },
          { label: "Customs", amount: 750, paymentMethod: "CASH" },
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
        items: [{ label: "Shipping", amount: 100, paymentMethod: "CASH" }],
      })
    ).rejects.toThrow(/edit:vehicles/);
  });

  test("reports combine purchase price and landed costs (not one or the other)", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      purchasePrice: 8000,
      purchasePaymentMethod: "CASH",
      sellingPrice: 15000,
    });
    await asUser.mutation(api.vehicles.upsertLandedCosts, {
      orgId,
      vehicleId,
      items: [{ label: "Landed", amount: 2000, paymentMethod: "CASH" }],
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

    // 8000 purchase + 2000 landed = 10000 cost basis, not one replacing the other.
    expect(report.sales[0].vehicleCost).toBe(10000);
    expect(report.sales[0].netProfit).toBe(5000);
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

  test("vehicle edit requests reject direct sold and reserved status updates", async () => {
    const { orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicleEdits.requestUpdate, {
        orgId,
        vehicleId,
        payload: { status: "SOLD" },
      })
    ).rejects.toThrow(/sale/i);

    await expect(
      asUser.mutation(api.vehicleEdits.requestUpdate, {
        orgId,
        vehicleId,
        payload: { status: "RESERVED" },
      })
    ).rejects.toThrow(/reservation|deposit/i);
  });

  test("vehicle edit approvals recheck protected lifecycle transitions", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      status: "IN_INSPECTION",
    });
    const requestId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        vehicleId,
        requestedBy: userId,
        type: "UPDATE",
        payload: { status: "AVAILABLE" },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    await expect(
      asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })
    ).rejects.toThrow(/sale workflow/i);

    await t.run(async (ctx) => {
      const request = await ctx.db.get(requestId);
      const vehicle = await ctx.db.get(vehicleId);
      expect(request?.status).toBe("PENDING");
      expect(vehicle?.status).toBe("SOLD");
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

  test("createReservation with deposit records a real held deposit and accounting event", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Deposit", lastName: "Customer" })
    );

    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
      depositAmount: 750,
      depositMethod: "CARD",
    });

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      expect(reservation?.depositAmount).toBe(750);
      expect(reservation?.depositAmountMinor).toBe(750_000);
      expect(reservation?.depositCurrency).toBe("JOD");
      expect(reservation?.depositMethod).toBe("CARD");
      expect(reservation?.depositId).toBeTruthy();

      const deposit = reservation?.depositId ? await ctx.db.get(reservation.depositId) : null;
      expect(deposit).toMatchObject({
        orgId,
        vehicleId,
        customerId,
        reservationId,
        amount: 750,
        amountMinor: 750_000,
        currency: "JOD",
        method: "CARD",
        status: "HELD",
        holdActive: true,
      });
      expect(deposit?.canonicalPaymentId).toBeTruthy();

      const tx = await ctx.db
        .query("transactions")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("depositId"), reservation?.depositId))
        .first();
      expect(tx?.type).toBe("IN");
      expect(tx?.amount).toBe(750);

      const pendingEvents = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .collect();
      expect(pendingEvents.some((event) => event.eventType === "DEPOSIT_RECEIVED")).toBe(true);
    });
  });

  test("releaseReservation keeps vehicle reserved when another active deposit hold exists", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Hold", lastName: "Customer" })
    );
    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
    });
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 0,
        termMonths: 0,
        status: "DRAFT",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    await asUser.mutation(api.deposits.create, { orgId, quoteId, amount: 500 });

    await asUser.mutation(api.vehicles.releaseReservation, { orgId, reservationId });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      const reservation = await ctx.db.get(reservationId);
      expect(reservation?.status).toBe("RELEASED");
      expect(vehicle?.status).toBe("RESERVED");
    });
  });

  test("createReservation defaults expiresAt to 3 days when no org setting or explicit expiry is given", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Default", lastName: "Hold" })
    );

    const before = Date.now();
    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
    });

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      expect(reservation?.expiresAt).toBeDefined();
      const expectedExpiry = before + 3 * 24 * 60 * 60 * 1000;
      expect(reservation!.expiresAt!).toBeGreaterThanOrEqual(expectedExpiry - 5_000);
      expect(reservation!.expiresAt!).toBeLessThanOrEqual(expectedExpiry + 5_000);
    });
  });

  test("createReservation uses the org's configured reservationHoldDays", async () => {
    const { t, orgId, asUser } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        reservationHoldDays: 7,
      })
    );
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Configured", lastName: "Hold" })
    );

    const before = Date.now();
    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
    });

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      const expectedExpiry = before + 7 * 24 * 60 * 60 * 1000;
      expect(reservation!.expiresAt!).toBeGreaterThanOrEqual(expectedExpiry - 5_000);
      expect(reservation!.expiresAt!).toBeLessThanOrEqual(expectedExpiry + 5_000);
    });
  });

  test("expireReservations notifies managers to resolve the deposit instead of auto-forfeiting it", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Notify", lastName: "Customer" })
    );
    const reservationId = await t.run(async (ctx) => {
      const insertedReservationId = await ctx.db.insert("vehicleReservations", {
        orgId,
        vehicleId,
        customerId,
        depositAmount: 250,
        depositAmountMinor: 250_000,
        depositCurrency: "JOD",
        depositMethod: "CASH",
        expiresAt: Date.now() - 1_000,
        status: "ACTIVE",
        reservedBy: userId,
        reservedAt: Date.now() - 10_000,
      });
      const depositId = await ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        reservationId: insertedReservationId,
        amount: 250,
        amountMinor: 250_000,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now() - 10_000,
      });
      await ctx.db.patch(insertedReservationId, { depositId });
      await ctx.db.patch(vehicleId, { status: "RESERVED" });
      return insertedReservationId;
    });

    await t.mutation(internal.vehicles.expireReservations, {});

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      const deposit = reservation?.depositId ? await ctx.db.get(reservation.depositId) : null;
      // Expiry only lifts the vehicle hold — it must NOT auto-forfeit the
      // deposit to income; a manager still confirms REFUNDED vs FORFEITED.
      expect(deposit?.status).toBe("HELD");

      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .collect();
      const expiryNotification = notifications.find((n) => n.type === "deposit.expired");
      expect(expiryNotification).toBeTruthy();
      expect(expiryNotification?.data?.amount).toBe("250");
    });
  });

  test("expireReservations expires stale reservations and releases linked deposit holds", async () => {
    const { t, orgId, userId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Expired", lastName: "Customer" })
    );
    const reservationId = await t.run(async (ctx) => {
      const insertedReservationId = await ctx.db.insert("vehicleReservations", {
        orgId,
        vehicleId,
        customerId,
        depositAmount: 250,
        depositAmountMinor: 250_000,
        depositCurrency: "JOD",
        depositMethod: "CASH",
        expiresAt: Date.now() - 1_000,
        status: "ACTIVE",
        reservedBy: userId,
        reservedAt: Date.now() - 10_000,
      });
      const depositId = await ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        reservationId: insertedReservationId,
        amount: 250,
        amountMinor: 250_000,
        currency: "JOD",
        method: "CASH",
        status: "HELD",
        holdActive: true,
        createdBy: userId,
        createdAt: Date.now() - 10_000,
      });
      await ctx.db.patch(insertedReservationId, { depositId });
      await ctx.db.patch(vehicleId, { status: "RESERVED" });
      return insertedReservationId;
    });

    await t.mutation(internal.vehicles.expireReservations, {});

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      const deposit = reservation?.depositId ? await ctx.db.get(reservation.depositId) : null;
      const vehicle = await ctx.db.get(vehicleId);
      expect(reservation?.status).toBe("EXPIRED");
      expect(reservation?.expiredAt).toBeTruthy();
      expect(deposit?.status).toBe("HELD");
      expect(deposit?.holdActive).toBe(false);
      expect(vehicle?.status).toBe("AVAILABLE");
    });
  });
});

describe("vehicles trust passport (Phase 61 self-service form)", () => {
  test("create persists self-reported trust passport fields", async () => {
    const { t, orgId, asUser } = await setup();

    const vehicleId = await asUser.mutation(api.vehicles.create, {
      orgId,
      ...baseVehicle,
      inspectionStatus: "SELF_REPORTED",
      accidentDisclosed: false,
      ownerCount: 2,
      dealerGuarantee: true,
    });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.inspectionStatus).toBe("SELF_REPORTED");
      expect(vehicle?.accidentDisclosed).toBe(false);
      expect(vehicle?.ownerCount).toBe(2);
      expect(vehicle?.dealerGuarantee).toBe(true);
    });
  });

  test("create rejects PARTNER_VERIFIED — reserved for a future partner-API integration", async () => {
    const { orgId, asUser } = await setup();

    await expect(
      asUser.mutation(api.vehicles.create, {
        orgId,
        ...baseVehicle,
        inspectionStatus: "PARTNER_VERIFIED" as any,
      })
    ).rejects.toThrow();
  });

  test("update can set and later clear trust passport fields", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await asUser.mutation(api.vehicles.update, {
      orgId,
      vehicleId,
      inspectionStatus: "SELF_REPORTED",
      accidentDisclosed: true,
      ownerCount: 1,
      dealerGuarantee: true,
    });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.inspectionStatus).toBe("SELF_REPORTED");
      expect(vehicle?.accidentDisclosed).toBe(true);
      expect(vehicle?.ownerCount).toBe(1);
      expect(vehicle?.dealerGuarantee).toBe(true);
    });

    await asUser.mutation(api.vehicles.update, {
      orgId,
      vehicleId,
      inspectionStatus: "NONE",
      accidentDisclosed: false,
      ownerCount: 0,
      dealerGuarantee: false,
    });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.inspectionStatus).toBe("NONE");
      expect(vehicle?.accidentDisclosed).toBe(false);
      expect(vehicle?.ownerCount).toBe(0);
      expect(vehicle?.dealerGuarantee).toBe(false);
    });
  });

  test("update rejects PARTNER_VERIFIED so the form can never self-assign it", async () => {
    const { orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicles.update, {
        orgId,
        vehicleId,
        inspectionStatus: "PARTNER_VERIFIED" as any,
      })
    ).rejects.toThrow();
  });

  test("requestCreate/requestUpdate reject a negative or non-integer ownerCount", async () => {
    const { orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicleEdits.requestCreate, {
        orgId,
        payload: { ...baseVehicle, ownerCount: -1 },
      })
    ).rejects.toThrow(/owner count/i);

    await expect(
      asUser.mutation(api.vehicleEdits.requestCreate, {
        orgId,
        payload: { ...baseVehicle, ownerCount: 1.5 },
      })
    ).rejects.toThrow(/owner count/i);

    await expect(
      asUser.mutation(api.vehicleEdits.requestUpdate, {
        orgId,
        vehicleId,
        payload: { ownerCount: -1 },
      })
    ).rejects.toThrow(/owner count/i);
  });

  test("create/update reject a negative or non-integer ownerCount", async () => {
    const { orgId, asUser } = await setup();

    await expect(
      asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, ownerCount: -1 })
    ).rejects.toThrow();

    await expect(
      asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle, ownerCount: 1.5 })
    ).rejects.toThrow();

    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await expect(
      asUser.mutation(api.vehicles.update, { orgId, vehicleId, ownerCount: -1 })
    ).rejects.toThrow();

    await expect(
      asUser.mutation(api.vehicles.update, { orgId, vehicleId, ownerCount: 1.5 })
    ).rejects.toThrow();
  });

  test("a vehicle create request carries trust passport fields through approval", async () => {
    const { t, orgId, asUser } = await setup();

    const requestId = await asUser.mutation(api.vehicleEdits.requestCreate, {
      orgId,
      payload: {
        ...baseVehicle,
        inspectionStatus: "SELF_REPORTED",
        accidentDisclosed: false,
        ownerCount: 3,
        dealerGuarantee: true,
      },
    });

    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(vehicle?.inspectionStatus).toBe("SELF_REPORTED");
      expect(vehicle?.accidentDisclosed).toBe(false);
      expect(vehicle?.ownerCount).toBe(3);
      expect(vehicle?.dealerGuarantee).toBe(true);
    });
  });

  test("a vehicle update request carries trust passport field changes through approval", async () => {
    const { t, orgId, asUser } = await setup();
    const vehicleId = await asUser.mutation(api.vehicles.create, { orgId, ...baseVehicle });

    await asUser.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { inspectionStatus: "SELF_REPORTED", ownerCount: 4, dealerGuarantee: true },
    });

    const requestId = await t.run(async (ctx) => {
      const req = await ctx.db
        .query("vehicleEdits")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
        .first();
      return req!._id;
    });

    await asUser.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.inspectionStatus).toBe("SELF_REPORTED");
      expect(vehicle?.ownerCount).toBe(4);
      expect(vehicle?.dealerGuarantee).toBe(true);
    });
  });
});

const baseImportRow = {
  make: "Toyota",
  model: "Camry",
  year: 2022,
  color: "White",
  fuelType: "Petrol",
  transmission: "Automatic",
  sellingPrice: 18000,
  purchasePrice: 14000,
};

describe("vehicles.importBulk — owned stock vs sourced", () => {
  test("lands owned stock as AVAILABLE (STOCK) by default", async () => {
    const { orgId, asUser, t } = await setup();

    const result = await asUser.mutation(api.vehicles.importBulk, {
      orgId,
      vehicles: [{ ...baseImportRow, vin: "STOCK-IMPORT-1" }],
    });

    expect(result.inserted).toBe(1);
    await t.run(async (ctx) => {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(vehicle?.status).toBe("AVAILABLE");
      expect(vehicle?.sourceType ?? "STOCK").toBe("STOCK");
    });
  });

  test("creates a sourced vehicle as SOURCING with supplier name and cost", async () => {
    const { orgId, asUser, t } = await setup();

    const result = await asUser.mutation(api.vehicles.importBulk, {
      orgId,
      vehicles: [
        {
          ...baseImportRow,
          make: "BYD",
          model: "Dolphin",
          year: 2024,
          vin: "SOURCED-IMPORT-1",
          purchasePrice: 22000,
          sourceType: "SOURCED",
          sourcedFromName: "Gulf Motors",
          sourceCost: 22000,
        },
      ],
    });

    expect(result.inserted).toBe(1);
    await t.run(async (ctx) => {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .first();
      expect(vehicle?.status).toBe("SOURCING");
      expect(vehicle?.sourceType).toBe("SOURCED");
      expect(vehicle?.sourcedFromName).toBe("Gulf Motors");
      expect(vehicle?.sourceCost).toBe(22000);
      // purchasePrice mirrors supplier cost, matching createSourced.
      expect(vehicle?.purchasePrice).toBe(22000);
    });
  });

  test("skips a sourced row missing its supplier without aborting the batch", async () => {
    const { orgId, asUser, t } = await setup();

    const result = await asUser.mutation(api.vehicles.importBulk, {
      orgId,
      vehicles: [
        // Invalid: sourced but no supplier name/cost.
        { ...baseImportRow, vin: "SOURCED-BAD-1", sourceType: "SOURCED" },
        // Valid owned stock in the same batch must still import.
        { ...baseImportRow, vin: "STOCK-GOOD-1" },
      ],
    });

    expect(result.inserted).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    await t.run(async (ctx) => {
      const vehicles = await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      const vins = vehicles.map((v) => v.vin);
      expect(vins).toContain("STOCK-GOOD-1");
      expect(vins).not.toContain("SOURCED-BAD-1");
    });
  });
});

describe("vehicles.exportData", () => {
  test("returns vehicles with their source type and finance-company valuations", async () => {
    const { orgId, asUser, t, roleId } = await setup();
    // Cost is only exported for roles that can see dealer cost.
    await t.run((ctx) => ctx.db.patch(roleId, { permissions: [...PERMISSIONS, "view:cost_price"] }));

    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "بندار",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      })
    );

    await asUser.mutation(api.vehicles.importBulk, {
      orgId,
      vehicles: [
        {
          ...baseImportRow,
          vin: "EXPORT-1",
          valuations: [{ companyId, valuationAmount: 19000 }],
        },
      ],
    });

    const data = await asUser.query(api.vehicles.exportData, { orgId });

    expect(data.vehicles).toHaveLength(1);
    const vehicle = data.vehicles[0];
    expect(vehicle.make).toBe("Toyota");
    expect(vehicle.sourceType).toBe("STOCK");
    expect(vehicle.cost).toBe(14000);
    expect(vehicle.valuations).toEqual([{ companyName: "بندار", amount: 19000 }]);
    expect(data.valuationCompanyNames).toContain("بندار");
  });

  test("strips cost for roles that cannot see dealer cost", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.vehicles.importBulk, {
      orgId,
      vehicles: [{ ...baseImportRow, vin: "EXPORT-NOCOST-1" }],
    });

    const data = await asUser.query(api.vehicles.exportData, { orgId });
    expect(data.vehicles[0].cost).toBeNull();
  });

  test("round-trips a sourced vehicle + valuation into a brand-new dealer account", async () => {
    const { orgId: orgA, asUser: asUserA, t, roleId: roleA } = await setup();
    await t.run((ctx) => ctx.db.patch(roleA, { permissions: [...PERMISSIONS, "view:cost_price"] }));

    const companyAId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: orgA,
        name: "بندار",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      })
    );

    await asUserA.mutation(api.vehicles.importBulk, {
      orgId: orgA,
      vehicles: [
        {
          ...baseImportRow,
          make: "BYD",
          model: "Dolphin",
          year: 2024,
          vin: "ROUNDTRIP-1",
          purchasePrice: 22000,
          sourceType: "SOURCED",
          sourcedFromName: "Gulf Motors",
          sourceCost: 22000,
          valuations: [{ companyId: companyAId, valuationAmount: 27000 }],
        },
      ],
    });

    const exported = await asUserA.query(api.vehicles.exportData, { orgId: orgA });

    // Fresh dealer account with no finance companies yet.
    const orgB = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Brand New Dealer", createdAt: Date.now() })
    );
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: orgB,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const userBId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_b_rt", email: "b@test.com", name: "Dealer B" })
    );
    const roleBId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: orgB, name: "OWNER", permissions: PERMISSIONS })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: orgB, userId: userBId, roleId: roleBId }));
    const asUserB = t.withIdentity({ subject: "user_b_rt" });

    // Transform the export payload the way the spreadsheet + import parser do.
    const reimport = exported.vehicles.map((v) => ({
      make: v.make,
      model: v.model,
      year: v.year,
      vin: v.vin,
      color: v.color,
      mileage: v.mileage ?? undefined,
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: v.sellingPrice,
      purchasePrice: v.cost ?? undefined,
      sourceType: v.sourceType,
      sourcedFromName: v.sourcedFrom || undefined,
      sourceCost: v.sourceType === "SOURCED" ? v.cost ?? undefined : undefined,
      valuations: v.valuations.map((x) => ({ companyName: x.companyName, valuationAmount: x.amount })),
    }));

    const result = await asUserB.mutation(api.vehicles.importBulk, { orgId: orgB, vehicles: reimport });

    expect(result.inserted).toBe(1);
    expect(result.companiesCreated).toBe(1); // "بندار" auto-created in the new account

    await t.run(async (ctx) => {
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_org", (q) => q.eq("orgId", orgB))
        .first();
      expect(vehicle?.make).toBe("BYD");
      expect(vehicle?.status).toBe("SOURCING");
      expect(vehicle?.sourceType).toBe("SOURCED");
      expect(vehicle?.sourcedFromName).toBe("Gulf Motors");
      expect(vehicle?.sourceCost).toBe(22000);

      const company = await ctx.db
        .query("financeCompanies")
        .withIndex("by_org", (q) => q.eq("orgId", orgB))
        .first();
      expect(company?.name).toBe("بندار");

      const valuation = await ctx.db
        .query("vehicleValuations")
        .withIndex("by_org", (q) => q.eq("orgId", orgB))
        .first();
      expect(valuation?.valuationAmount).toBe(27000);
    });
  });
});
