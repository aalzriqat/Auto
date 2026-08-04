import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Facebook contact-name resync", () => {
  test("repairs a real DM name without assigning or suggesting a vehicle", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Facebook Name Test", createdAt: Date.now() })
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("subscriptions", {
        orgId,
        plan: "enterprise",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const userId = await ctx.db.insert("users", {
        clerkId: "facebook_resync_manager",
        email: "manager@example.com",
        name: "Manager",
      });
      const roleId = await ctx.db.insert("roles", {
        orgId,
        name: "MANAGER",
        permissions: ["approve:requests"],
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JOD",
        enabledPaymentTypes: ["CASH"],
        facebookPageId: "facebook_page_resync",
        facebookPageAccessToken: "facebook_page_token",
      });
      await ctx.db.insert("vehicles", {
        orgId,
        make: "BYD",
        model: "Seal",
        year: 2025,
        mileage: 0,
        color: "White",
        fuelType: "Electric",
        transmission: "Automatic",
        sellingPrice: 28_000,
        status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId,
        firstName: "Facebook",
        lastName: "Contact",
        facebookUserId: "facebook_psid_resync",
        source: "Facebook",
      });
      await ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "facebook_legacy_dm",
        kind: "dm",
        senderFacebookId: "facebook_psid_resync",
        customerId,
        text: "I want the 2025 BYD Seal",
      });
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: "facebook_conversation_resync",
        participants: {
          data: [
            { id: "facebook_page_resync", name: "Bloom Cars" },
            { id: "facebook_psid_resync", name: "Maya Saleh" },
          ],
        },
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    const asManager = t.withIdentity({ subject: "facebook_resync_manager" });
    const result = await asManager.action(api.socialInboxBackfill.resyncContactNames, { orgId });
    expect(result).toMatchObject({
      facebookAttempted: 1,
      resolved: 1,
      attemptedButUnresolved: 0,
      remaining: 0,
    });

    const { customer, event } = await t.run(async (ctx) => {
      const customers = await ctx.db
        .query("customers")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .take(10);
      const event = await ctx.db
        .query("facebookEvents")
        .withIndex("by_org_external", (q) =>
          q.eq("orgId", orgId).eq("externalId", "facebook_legacy_dm")
        )
        .unique();
      return {
        customer: customers.find((candidate) =>
          candidate.facebookUserId === "facebook_psid_resync"
        ) ?? null,
        event,
      };
    });

    expect(customer).toMatchObject({ firstName: "Maya", lastName: "Saleh" });
    expect(event?.vehicleId).toBeUndefined();
    expect(event?.vehicleMatchHintText).toBeUndefined();
    expect(event?.vehicleMatchHintSource).toBeUndefined();
  });
});
