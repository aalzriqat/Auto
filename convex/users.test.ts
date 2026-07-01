import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seedOwnerUser() {
  const t = convexTest(schema, modules);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Owner Org", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "clerk_deleted_owner",
      email: "owner@example.com",
      name: "Original Owner",
      imageUrl: "https://example.com/avatar.png",
      whatsappPhone: "+962790000000",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: [],
      isSystemOwnerRole: true,
    })
  );
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );

  return { t, orgId, userId, membershipId };
}

describe("users.deleteUser Clerk webhook handling", () => {
  test("soft-disables and anonymizes without deleting memberships", async () => {
    const { t, orgId, userId, membershipId } = await seedOwnerUser();

    await t.run((ctx) =>
      ctx.runMutation(internal.users.deleteUser, { clerkId: "clerk_deleted_owner" })
    );

    await t.run(async (ctx) => {
      const user = await ctx.db.get(userId);
      expect(user).toBeTruthy();
      expect(user?.disabled).toBe(true);
      expect(user?.disabledReason).toBe("clerk_user_deleted");
      expect(user?.clerkDeletedAt).toBeTypeOf("number");
      expect(user?.email).toBe(`deleted-user-${userId}@deleted.autoflow.local`);
      expect(user?.name).toBe("Deleted user");
      expect(user?.imageUrl).toBeUndefined();
      expect(user?.whatsappPhone).toBeUndefined();

      const membership = await ctx.db.get(membershipId);
      expect(membership).toMatchObject({ orgId, userId });

      const reviews = await ctx.db.query("userOffboardingReviews").collect();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        userId,
        clerkId: "clerk_deleted_owner",
        source: "clerk_user_deleted",
        status: "PENDING_REVIEW",
        membershipCount: 1,
        ownerOrgIds: [orgId],
      });
    });
  });

  test("repeated Clerk deletion events update the pending review instead of duplicating it", async () => {
    const { t, userId } = await seedOwnerUser();

    await t.run((ctx) =>
      ctx.runMutation(internal.users.deleteUser, { clerkId: "clerk_deleted_owner" })
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.users.deleteUser, { clerkId: "clerk_deleted_owner" })
    );

    await t.run(async (ctx) => {
      const reviews = await ctx.db
        .query("userOffboardingReviews")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "PENDING_REVIEW"))
        .collect();
      expect(reviews).toHaveLength(1);
    });
  });
});
