import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("organizations.create", () => {
  test("bootstraps the Convex user row when the Clerk webhook has not synced yet", async () => {
    const t = convexTest(schema, modules);
    const asWebhookLaggedUser = t.withIdentity({
      subject: "user_webhook_lagged",
      name: "Webhook Lagged User",
    });

    const orgId = await asWebhookLaggedUser.mutation(api.organizations.create, {
      name: "Webhook Lag Motors",
    });

    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "user_webhook_lagged"))
        .unique();
      expect(user).toMatchObject({
        clerkId: "user_webhook_lagged",
        email: "no-email-user_webhook_lagged@autoflow.local",
        name: "Webhook Lagged User",
      });
      if (!user) throw new Error("Expected organizations.create to create a user row.");

      const org = await ctx.db.get(orgId);
      expect(org?.name).toBe("Webhook Lag Motors");

      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", user._id))
        .unique();
      expect(membership).toBeTruthy();
      if (!membership) throw new Error("Expected organizations.create to create an owner membership.");

      const role = await ctx.db.get(membership.roleId);
      expect(role?.isSystemOwnerRole).toBe(true);
    });
  });
});
