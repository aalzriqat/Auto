import { convexTestWithComponents } from "../test-utils/convexTest";
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

  test("renaming the OWNER role keeps it recognisable as the system owner role", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx: any) =>
      ctx.db.insert("organizations", { name: "Legacy Dealer", createdAt: Date.now() })
    ) as Id<"organizations">;
    await t.run((ctx: any) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx: any) =>
      ctx.db.insert("users", { clerkId: "legacy_owner", email: "legacy-owner@test.com" })
    ) as Id<"users">;
    // A legacy org seeded before the isSystemOwnerRole flag existed. Owner
    // status falls back to an EXACT match on the name "OWNER".
    const ownerRoleId = await t.run((ctx: any) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS })
    ) as Id<"roles">;
    await t.run((ctx: any) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRoleId }));
    const asOwner = t.withIdentity({ subject: "legacy_owner" });

    // "owner" normalizes to OWNER so the rename guard permits it.
    await asOwner.mutation(api.roles.update, { orgId, roleId: ownerRoleId, name: "owner" });

    // The owner must still be able to perform owner-only actions afterwards.
    // Storing the name unnormalized broke the exact-match fallback and locked
    // the org out of every requireOwner path — including roles.update itself,
    // so it could never be undone from the app.
    await expect(
      asOwner.mutation(api.roles.create, { orgId, name: "Auditor", permissions: [] })
    ).resolves.toBeDefined();
  });
});
