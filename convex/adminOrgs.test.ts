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

async function seedOrgWithOwner(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() }));
  const ownerId = await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "owner_1", email: "owner@acme.com" }));
  const roleId = await t.run(async (ctx) => ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [] }));
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
  return { orgId, ownerId };
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

  test("hardDeleteOrg requires the typed org name and cascades deletes", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithOwner(t);
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_1" });

    await t.run(async (ctx) =>
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
      })
    );

    await expect(
      asAdmin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Wrong Name" })
    ).rejects.toThrow();

    await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Acme Motors" });

    const remainingVehicles = await t.run(async (ctx) =>
      ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(remainingVehicles).toHaveLength(0);
    const org = await t.run(async (ctx) => ctx.db.get(orgId));
    expect(org).toBeNull();
  });
});
