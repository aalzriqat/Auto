import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedAdminAndMember(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() }));
  const memberId = await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "member_1", email: "member@acme.com" }));
  const roleId = await t.run(async (ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] }));
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId: memberId, roleId }));
  await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
  return { orgId, memberId, roleId, asAdmin: t.withIdentity({ subject: "dev_1" }), asMember: t.withIdentity({ subject: "member_1" }) };
}

describe("adminUsers", () => {
  test("rejects a non-allowlisted caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { memberId, asMember } = await seedAdminAndMember(t);
    await expect(asMember.mutation(api.adminUsers.disableUser, { userId: memberId })).rejects.toThrow();
  });

  test("allowlisted admin can disable and re-enable a user in any org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { memberId, asAdmin } = await seedAdminAndMember(t);

    await asAdmin.mutation(api.adminUsers.disableUser, { userId: memberId });
    let detail = await asAdmin.query(api.adminUsers.getUserDetail, { userId: memberId });
    expect(detail.user.disabled).toBe(true);

    await asAdmin.mutation(api.adminUsers.enableUser, { userId: memberId });
    detail = await asAdmin.query(api.adminUsers.getUserDetail, { userId: memberId });
    expect(detail.user.disabled).toBe(false);
  });

  test("disabled user is rejected by requireAuth across the app", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, memberId, asAdmin, asMember } = await seedAdminAndMember(t);

    await asAdmin.mutation(api.adminUsers.disableUser, { userId: memberId });
    await expect(asMember.query(api.organizations.get, { orgId })).rejects.toThrow();
  });

  test("changeUserRole moves a member to a new role within their org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, memberId, asAdmin } = await seedAdminAndMember(t);
    const newRoleId = await t.run(async (ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: [] }));

    await asAdmin.mutation(api.adminUsers.changeUserRole, { userId: memberId, orgId, roleId: newRoleId });

    const detail = await asAdmin.query(api.adminUsers.getUserDetail, { userId: memberId });
    expect(detail.orgs[0].roleName).toBe("MANAGER");
  });
});
