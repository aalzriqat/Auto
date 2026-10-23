import { describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import { ALL_PERMISSIONS, PRE_413_OWNER_FALLBACK_PERMISSIONS } from "./utils/permissions";

describe("SCRUM-729 public membership projection qualified-owner authority", () => {
  test.each([
    ["OWNER", false, ["view:finance"], false],
    ["OWNER", false, [...PRE_413_OWNER_FALLBACK_PERMISSIONS], false],
    ["Dealer principal", true, ["view:finance"], true],
    ["OWNER", undefined, [...PRE_413_OWNER_FALLBACK_PERMISSIONS], true],
    ["OWNER", undefined, ["view:finance"], false],
  ] as const)("projects %s/%s from the authoritative owner predicate", async (name, flag, permissions, qualified) => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const fixture = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "QA TEST owner projection", createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: "owner-projection", email: "projection@example.test" });
      const roleId = await ctx.db.insert("roles", { orgId, name, permissions: [...permissions], ...(flag === undefined ? {} : { isSystemOwnerRole: flag }) });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      const viewerId = await ctx.db.insert("users", { clerkId: "owner-projection-viewer", email: "viewer@example.test" });
      const viewerRole = await ctx.db.insert("roles", { orgId, name: "Qualified viewer", permissions: [], isSystemOwnerRole: true });
      await ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRole });
      return { orgId, roleId };
    });
    const membership = await t.withIdentity({ subject: "owner-projection" }).query(api.memberships.getMyMembership, { orgId: fixture.orgId });
    expect(membership).toMatchObject({ roleId: fixture.roleId, roleName: name, isSystemOwnerRole: qualified });
    expect(membership.permissions).toEqual(qualified ? ALL_PERMISSIONS : [...permissions]);
    const listing = await t.withIdentity({ subject: "owner-projection-viewer" }).query(api.memberships.list,
      { orgId: fixture.orgId, paginationOpts: { numItems: 10, cursor: null } });
    expect(listing.page.find((row) => row.roleId === fixture.roleId))
      .toMatchObject({ roleName: name, isSystemOwnerRole: qualified });
  });
});
