import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

const PERMISSIONS = ["create:vehicles", "edit:vehicles", "view:vehicles", "view:users", "manage:users"];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_r1", email: "r@test.com", name: "Manager User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_r1" });

  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"])));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A000077",
      make: "Toyota",
      model: "Camry",
      year: 2022,
      mileage: 5000,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 22000,
      status: "IN_INSPECTION",
      imageIds: [storageId],
    })
  );

  return { t, orgId, userId, vehicleId, asUser };
}

/** `vehicleRequests.create` doesn't return the inserted id, so look it up directly. */
async function getPendingRequestId(t: any, vehicleId: any) {
  return await t.run(async (ctx: any) => {
    const req = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_vehicle", (q: any) => q.eq("vehicleId", vehicleId))
      .filter((q: any) => q.eq(q.field("status"), "PENDING"))
      .first();
    return req!._id;
  });
}

describe("vehicleRequests.resolve — auto-post on approval to AVAILABLE", () => {
  test("queues an auto-post when approving a request to AVAILABLE, with auto-post enabled", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
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

    await asUser.mutation(api.vehicleRequests.create, {
      orgId,
      vehicleId,
      requestedStatus: "AVAILABLE",
    });
    const requestId = await getPendingRequestId(t, vehicleId);

    await asUser.mutation(api.vehicleRequests.resolve, { orgId, requestId, status: "APPROVED" });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("AVAILABLE");

      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(1);
      expect(posts[0].triggeredBy).toBe("auto");
    });
  });

  test("does not queue a post when rejected", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
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

    await asUser.mutation(api.vehicleRequests.create, {
      orgId,
      vehicleId,
      requestedStatus: "AVAILABLE",
    });
    const requestId = await getPendingRequestId(t, vehicleId);

    await asUser.mutation(api.vehicleRequests.resolve, { orgId, requestId, status: "REJECTED" });

    await t.run(async (ctx) => {
      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(0);
    });
  });

  test("does not queue a post when approving a request to a non-AVAILABLE status", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
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

    await asUser.mutation(api.vehicleRequests.create, {
      orgId,
      vehicleId,
      requestedStatus: "RESERVED",
    });
    const requestId = await getPendingRequestId(t, vehicleId);

    await asUser.mutation(api.vehicleRequests.resolve, { orgId, requestId, status: "APPROVED" });

    await t.run(async (ctx) => {
      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
        .collect();
      expect(posts.length).toBe(0);
    });
  });
});
