import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";

async function setupOwnerOrg(t: any) {
  const orgId = await t.run((ctx: any) =>
    ctx.db.insert("organizations", { name: "Roles Test Dealer", createdAt: Date.now() })
  ) as Id<"organizations">;
  await t.run((ctx: any) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx: any) =>
    ctx.db.insert("users", { clerkId: "roles_owner", email: "roles-owner@test.com" })
  ) as Id<"users">;
  const ownerRoleId = await t.run((ctx: any) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  ) as Id<"roles">;
  await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));
  return { orgId };
}

describe("roles", () => {
  test("rejects arbitrary permission strings", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOwnerOrg(t);
    const asOwner = t.withIdentity({ subject: "roles_owner" });

    await expect(
      asOwner.mutation(api.roles.create, {
        orgId,
        name: "Unsafe",
        permissions: ["not:a-real-permission"],
      })
    ).rejects.toThrow(/invalid permissions/i);
  });

  test("rejects custom roles named OWNER", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOwnerOrg(t);
    const asOwner = t.withIdentity({ subject: "roles_owner" });

    await expect(
      asOwner.mutation(api.roles.create, {
        orgId,
        name: " owner ",
        permissions: [PERMISSIONS.VIEW_USERS],
      })
    ).rejects.toThrow(/reserved system role/i);
  });

  test("rejects renaming a custom role to OWNER", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await setupOwnerOrg(t);
    const customRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Finance Admin",
        permissions: [PERMISSIONS.VIEW_USERS],
      })
    ) as Id<"roles">;
    const asOwner = t.withIdentity({ subject: "roles_owner" });

    await expect(
      asOwner.mutation(api.roles.update, {
        orgId,
        roleId: customRoleId,
        name: "OWNER",
      })
    ).rejects.toThrow(/reserved system role/i);
  });
});
