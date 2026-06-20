import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

const PERMISSIONS = [
  "create:vehicles", "edit:vehicles", "view:vehicles", "view:vehicle_info", "view:users", "manage:users",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_s1", email: "s@test.com", name: "Social User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_s1" });

  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"])));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A000099",
      make: "Honda",
      model: "Accord",
      year: 2021,
      mileage: 10000,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 25000,
      status: "AVAILABLE",
      imageIds: [storageId],
    })
  );

  return { t, orgId, userId, vehicleId, storageId, asUser };
}

describe("socialPostingData.requestPost", () => {
  test("rejects when Instagram isn't connected", async () => {
    const { orgId, vehicleId, storageId, asUser } = await setup();

    await expect(
      asUser.mutation(api.socialPostingData.requestPost, {
        orgId,
        vehicleId,
        caption: "Check out this car!",
        imageStorageIds: [storageId],
      })
    ).rejects.toThrow(/not connected/i);
  });

  test("rejects with zero images selected", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
      })
    );

    await expect(
      asUser.mutation(api.socialPostingData.requestPost, {
        orgId,
        vehicleId,
        caption: "Check out this car!",
        imageStorageIds: [],
      })
    ).rejects.toThrow(/select at least one photo/i);
  });

  test("rejects a photo that doesn't belong to the vehicle", async () => {
    const { t, orgId, vehicleId, asUser } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
      })
    );
    const otherStorageId = await t.run((ctx) => ctx.storage.store(new Blob(["other-image"])));

    await expect(
      asUser.mutation(api.socialPostingData.requestPost, {
        orgId,
        vehicleId,
        caption: "Check out this car!",
        imageStorageIds: [otherStorageId],
      })
    ).rejects.toThrow(/doesn't belong to this vehicle/i);
  });

  test("queues a PENDING post and schedules the publish action on success", async () => {
    const { t, orgId, vehicleId, storageId, userId, asUser } = await setup();
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "د.أ",
        enabledPaymentTypes: ["CASH"],
        instagramBusinessAccountId: "ig_123",
        instagramAccessToken: "token_abc",
      })
    );

    const socialPostId = await asUser.mutation(api.socialPostingData.requestPost, {
      orgId,
      vehicleId,
      caption: "Check out this car!",
      imageStorageIds: [storageId],
    });

    expect(socialPostId).toBeDefined();

    await t.run(async (ctx) => {
      const post = await ctx.db.get(socialPostId);
      expect(post?.status).toBe("PENDING");
      expect(post?.triggeredBy).toBe("manual");
      expect(post?.requestedBy).toBe(userId);
      expect(post?.imageStorageIds).toEqual([storageId]);
    });

    // Not flushing the scheduled `publishToInstagram` action here — it makes
    // real `fetch` calls to Meta's Graph API, which is out of scope for a
    // unit test. Queuing behavior (PENDING row above) is what's under test.
  });
});

describe("socialPostingData.listForVehicle", () => {
  test("returns posts for the vehicle, newest first", async () => {
    const { t, orgId, vehicleId, storageId, userId, asUser } = await setup();

    const olderId = await t.run((ctx) =>
      ctx.db.insert("socialPosts", {
        orgId,
        vehicleId,
        platform: "instagram",
        status: "PUBLISHED",
        imageStorageIds: [storageId],
        triggeredBy: "manual",
        requestedBy: userId,
        requestedAt: 1000,
      })
    );
    const newerId = await t.run((ctx) =>
      ctx.db.insert("socialPosts", {
        orgId,
        vehicleId,
        platform: "instagram",
        status: "FAILED",
        imageStorageIds: [storageId],
        triggeredBy: "manual",
        requestedBy: userId,
        requestedAt: 2000,
        errorMessage: "boom",
      })
    );

    const posts = await asUser.query(api.socialPostingData.listForVehicle, { orgId, vehicleId });
    expect(posts.map((p) => p._id)).toEqual([newerId, olderId]);
  });
});

describe("socialPostingData.markPostResult", () => {
  test("patches status to PUBLISHED and notifies the requester", async () => {
    const { t, orgId, vehicleId, storageId, userId } = await setup();

    const socialPostId = await t.run((ctx) =>
      ctx.db.insert("socialPosts", {
        orgId,
        vehicleId,
        platform: "instagram",
        status: "PENDING",
        imageStorageIds: [storageId],
        triggeredBy: "manual",
        requestedBy: userId,
        requestedAt: Date.now(),
      })
    );

    await t.run((ctx) =>
      ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId,
        status: "PUBLISHED",
        externalPostId: "media_123",
        externalPermalink: "https://instagram.com/p/abc123",
      })
    );

    await t.run(async (ctx) => {
      const post = await ctx.db.get(socialPostId);
      expect(post?.status).toBe("PUBLISHED");
      expect(post?.externalPostId).toBe("media_123");
      expect(post?.publishedAt).toBeDefined();

      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .collect();
      expect(notifications.some((n) => n.title === "Posted to Instagram")).toBe(true);
    });
  });

  test("patches status to FAILED with the error message and notifies the requester", async () => {
    const { t, orgId, vehicleId, storageId, userId } = await setup();

    const socialPostId = await t.run((ctx) =>
      ctx.db.insert("socialPosts", {
        orgId,
        vehicleId,
        platform: "instagram",
        status: "PENDING",
        imageStorageIds: [storageId],
        triggeredBy: "manual",
        requestedBy: userId,
        requestedAt: Date.now(),
      })
    );

    await t.run((ctx) =>
      ctx.runMutation(internal.socialPostingData.markPostResult, {
        socialPostId,
        status: "FAILED",
        errorMessage: "Token expired",
      })
    );

    await t.run(async (ctx) => {
      const post = await ctx.db.get(socialPostId);
      expect(post?.status).toBe("FAILED");
      expect(post?.errorMessage).toBe("Token expired");

      const notifications = await ctx.db
        .query("notifications")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .collect();
      expect(notifications.some((n) => n.title === "Instagram post failed")).toBe(true);
    });
  });
});
