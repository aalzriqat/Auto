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

async function seedOrgWithVehicle(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() }));
  await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
  await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "member_1", email: "member@acme.com" }));
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
    })
  );
  return { orgId, vehicleId, asAdmin: t.withIdentity({ subject: "dev_1" }), asMember: t.withIdentity({ subject: "member_1" }) };
}

describe("adminData", () => {
  test("rejects a non-allowlisted caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asMember } = await seedOrgWithVehicle(t);
    await expect(
      asMember.query(api.adminData.adminListByOrg, { orgId, table: "vehicles", paginationOpts: { numItems: 10, cursor: null } })
    ).rejects.toThrow();
  });

  test("rejects a table not on the allowlist", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asAdmin } = await seedOrgWithVehicle(t);
    await expect(
      asAdmin.query(api.adminData.adminListByOrg, { orgId, table: "users", paginationOpts: { numItems: 10, cursor: null } })
    ).rejects.toThrow();
  });

  test("allowlisted admin can list, edit, and hard-delete a record across orgs", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);

    const page = await asAdmin.query(api.adminData.adminListByOrg, {
      orgId,
      table: "vehicles",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toHaveLength(1);

    await asAdmin.mutation(api.adminData.adminUpdateRecord, {
      table: "vehicles",
      id: vehicleId,
      patch: { sellingPrice: 25000 },
    });
    const updated = await asAdmin.query(api.adminData.adminGetRecord, { table: "vehicles", id: vehicleId });
    expect((updated as any)?.sellingPrice).toBe(25000);

    await asAdmin.mutation(api.adminData.adminHardDelete, { table: "vehicles", id: vehicleId });
    const afterDelete = await asAdmin.query(api.adminData.adminGetRecord, { table: "vehicles", id: vehicleId });
    expect(afterDelete).toBeNull();
  });

  test("every admin mutation writes an adminAuditLog entry", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { vehicleId, asAdmin } = await seedOrgWithVehicle(t);

    await asAdmin.mutation(api.adminData.adminUpdateRecord, {
      table: "vehicles",
      id: vehicleId,
      patch: { sellingPrice: 30000 },
    });

    const log = await asAdmin.query(api.adminAudit.listAuditLog, { paginationOpts: { numItems: 10, cursor: null } });
    expect(log.page.some((e) => e.action === "adminUpdateRecord" && e.targetId === vehicleId)).toBe(true);
  });
});
