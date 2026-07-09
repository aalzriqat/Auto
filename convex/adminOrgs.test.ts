import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedOrgWithOwner(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() }));
  const ownerId = await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "owner_1", email: "owner@acme.com" }));
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
  return { orgId, ownerId };
}

async function runDeletionToCompletion(
  t: ReturnType<typeof convexTest>,
  requestId: Id<"organizationDeletionRequests">
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = await t.run(async (ctx) => ctx.db.get(requestId));
    if (request?.status !== "RUNNING") {
      return request;
    }
    await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: request._id });
  }
  throw new Error("Deletion request did not complete within the expected number of batches.");
}

describe("adminOrgs", () => {
  test("rejects a non-allowlisted user even if they own the org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithOwner(t);
    const asOwner = t.withIdentity({ subject: "owner_1" });

    await expect(asOwner.mutation(api.adminOrgs.suspendOrg, { orgId, reason: "test" })).rejects.toThrow();
  });

  test("allowlisted admin can suspend and unsuspend an org they don't belong to", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithOwner(t);
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_1" });

    await asAdmin.mutation(api.adminOrgs.suspendOrg, { orgId, reason: "non-payment" });
    const detail = await asAdmin.query(api.adminOrgs.getOrgDetail, { orgId });
    expect(detail.org.suspended).toBe(true);
    expect(detail.org.suspendedReason).toBe("non-payment");

    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });
    const detail2 = await asAdmin.query(api.adminOrgs.getOrgDetail, { orgId });
    expect(detail2.org.suspended).toBe(false);
  });

  test("suspended org blocks normal tenant access via requireTenantAuth", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithOwner(t);
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_1" });
    const asOwner = t.withIdentity({ subject: "owner_1" });

    await asAdmin.mutation(api.adminOrgs.suspendOrg, { orgId, reason: "test" });
    await expect(asOwner.query(api.organizations.get, { orgId })).rejects.toThrow();
  });

  test("owner delete opens a review request and keeps data until an admin decision", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithOwner(t);
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
    const asOwner = t.withIdentity({ subject: "owner_1" });
    const asAdmin = t.withIdentity({ subject: "dev_1" });

    await t.run(async (ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN-PENDING",
        make: "Toyota",
        model: "Camry",
        year: 2020,
        mileage: 1000,
        color: "Black",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 20000,
        status: "AVAILABLE",
      })
    );

    const result = await asOwner.mutation(api.organizations.remove, { orgId, reason: "closing dealership" });
    expect(result.status).toBe("PENDING_REVIEW");

    const request = await t.run(async (ctx) => ctx.db.get(result.requestId));
    expect(request).toMatchObject({
      orgId,
      status: "PENDING_REVIEW",
      reason: "closing dealership",
    });

    const org = await t.run(async (ctx) => ctx.db.get(orgId));
    expect(org?.suspended).toBe(true);
    expect(org?.deletionRequestId).toBe(result.requestId);

    const vehiclesBeforeReview = await t.run(async (ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(vehiclesBeforeReview).toHaveLength(1);
    await expect(asOwner.query(api.organizations.get, { orgId })).rejects.toThrow();
    await expect(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId })).rejects.toThrow();

    await asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, {
      requestId: result.requestId,
      reviewNotes: "Customer confirmed they want to keep the account.",
    });

    const rejectedRequest = await t.run(async (ctx) => ctx.db.get(result.requestId));
    expect(rejectedRequest?.status).toBe("REJECTED");
    const restoredOrg = await asOwner.query(api.organizations.get, { orgId });
    expect(restoredOrg?.suspended).toBe(false);
  });

  test("hardDeleteOrg requires the typed org name and cascades deletes", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrgWithOwner(t);
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_1" });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["vehicle-image"])));

    const vehicleId = await t.run(async (ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN1",
        make: "Toyota",
        model: "Camry",
        year: 2020,
        mileage: 1000,
        color: "Black",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 20000,
        status: "AVAILABLE",
        imageIds: [storageId],
      })
    );
    const conversationId = await t.run(async (ctx) =>
      ctx.db.insert("dmConversations", {
        orgId,
        type: "GROUP",
        name: "Sales",
        memberIds: [ownerId],
        createdBy: ownerId,
        lastMessageAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("dmMessages", {
        conversationId,
        senderId: ownerId,
        body: "Need to close the account.",
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("dmParticipantState", {
        conversationId,
        userId: ownerId,
        lastReadAt: Date.now(),
      })
    );
    const liveChatThreadId = await t.run(async (ctx) =>
      ctx.db.insert("liveChatThreads", {
        kind: "DEALER",
        orgId,
        dealerUserId: ownerId,
        status: "WAITING",
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("liveChatMessages", {
        threadId: liveChatThreadId,
        senderType: "DEALER",
        senderUserId: ownerId,
        bodyText: "Please delete this org.",
        createdAt: Date.now(),
      })
    );
    await t.run(async (ctx) =>
      ctx.db.insert("liveChatPresence", {
        threadId: liveChatThreadId,
        side: "DEALER",
        presence: "active",
        presenceAt: Date.now(),
      })
    );

    await expect(
      asAdmin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Wrong Name" })
    ).rejects.toThrow();

    const result = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Acme Motors" });
    expect(result.status).toBe("RUNNING");

    const completedRequest = await runDeletionToCompletion(t, result.requestId);
    expect(completedRequest?.status).toBe("COMPLETED");

    const remainingVehicles = await t.run(async (ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(remainingVehicles).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.get(vehicleId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.storage.getUrl(storageId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(conversationId))).toBeNull();
    const remainingMessages = await t.run(async (ctx) =>
      ctx.db
        .query("dmMessages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect()
    );
    expect(remainingMessages).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.get(liveChatThreadId))).toBeNull();
    const remainingLiveMessages = await t.run(async (ctx) =>
      ctx.db.query("liveChatMessages").withIndex("by_thread", (q) => q.eq("threadId", liveChatThreadId)).collect()
    );
    expect(remainingLiveMessages).toHaveLength(0);
    const org = await t.run(async (ctx) => ctx.db.get(orgId));
    expect(org).toBeNull();
  });

  test("hardDeleteOrg cascades site-visitor analytics but leaves platform-scoped rows untouched", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithOwner(t);
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_2", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_2" });

    const visitorFields = {
      host: "bloomcars.autoflowdealer.com",
      visitorId: "visitor-org-1",
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      visitCount: 1,
      pageViewCount: 1,
      linkClickCount: 0,
      firstTrafficSource: "Direct",
      deviceType: "desktop",
      browserName: "Chrome",
      osName: "macOS",
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("siteVisitors", { orgId, ...visitorFields });
      await ctx.db.insert("siteVisitorEvents", {
        orgId,
        host: visitorFields.host,
        visitorId: visitorFields.visitorId,
        sessionId: "session-1",
        type: "page_view",
        path: "/",
        trafficSource: "Direct",
        createdAt: Date.now(),
      });
      // Platform-scoped (AutoFlow's own marketing site) — must survive this org's deletion.
      await ctx.db.insert("siteVisitors", {
        orgId: undefined,
        ...visitorFields,
        host: "autoflowdealer.com",
        visitorId: "visitor-platform-1",
      });
      await ctx.db.insert("siteVisitorEvents", {
        orgId: undefined,
        host: "autoflowdealer.com",
        visitorId: "visitor-platform-1",
        sessionId: "session-2",
        type: "page_view",
        path: "/",
        trafficSource: "Direct",
        createdAt: Date.now(),
      });
    });

    const result = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Acme Motors" });
    await runDeletionToCompletion(t, result.requestId);

    const remainingOrgVisitors = await t.run(async (ctx) =>
      ctx.db.query("siteVisitors").withIndex("by_org_firstSeenAt", (q) => q.eq("orgId", orgId)).collect()
    );
    const remainingOrgEvents = await t.run(async (ctx) =>
      ctx.db.query("siteVisitorEvents").withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(remainingOrgVisitors).toHaveLength(0);
    expect(remainingOrgEvents).toHaveLength(0);

    const platformVisitors = await t.run(async (ctx) =>
      ctx.db
        .query("siteVisitors")
        .withIndex("by_org_firstSeenAt", (q) => q.eq("orgId", undefined))
        .collect()
    );
    expect(platformVisitors).toHaveLength(1);
    expect(platformVisitors[0].visitorId).toBe("visitor-platform-1");
  });
});
