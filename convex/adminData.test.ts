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

  test("allowlisted admin cannot directly edit or hard-delete financial records", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asAdmin } = await seedOrgWithVehicle(t);
    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 1000,
        date: Date.now(),
        category: "OTHER",
        description: "Financial record",
      })
    );

    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "transactions",
        id: transactionId,
        patch: { amount: 1 },
      })
    ).rejects.toThrow(/financial table/i);

    await expect(
      asAdmin.mutation(api.adminData.adminHardDelete, {
        table: "transactions",
        id: transactionId,
      })
    ).rejects.toThrow(/financial table/i);

    const afterAttempts = await asAdmin.query(api.adminData.adminGetRecord, {
      table: "transactions",
      id: transactionId,
    });
    expect(afterAttempts).toMatchObject({ amount: 1000 });
  });

  test("admin can restore a soft-deleted record back to its dealer, one by one and in bulk", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);

    // Soft-delete two vehicles (the seeded one + a second).
    const vehicleId2 = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN2",
        make: "Honda",
        model: "Civic",
        year: 2021,
        mileage: 500,
        color: "White",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 22000,
        status: "AVAILABLE",
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: "member_1",
      })
    );
    await t.run((ctx) => ctx.db.patch(vehicleId, { isDeleted: true, deletedAt: Date.now(), deletedBy: "member_1" }));

    // "Deleted only" view surfaces both.
    const deletedPage = await asAdmin.query(api.adminData.adminListByOrg, {
      orgId,
      table: "vehicles",
      deletedOnly: true,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(deletedPage.page).toHaveLength(2);

    // Restore one.
    const single = await asAdmin.mutation(api.adminData.adminRestoreRecords, { table: "vehicles", ids: [vehicleId] });
    expect(single).toMatchObject({ restored: 1 });
    const restored = await asAdmin.query(api.adminData.adminGetRecord, { table: "vehicles", id: vehicleId });
    expect(restored).toMatchObject({ orgId, isDeleted: false });
    expect((restored as any).deletedAt).toBeUndefined();
    expect((restored as any).deletedBy).toBeUndefined();

    // Restore the rest in bulk (multiple ids in one mutation).
    const vehicleId3 = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN3",
        make: "Kia",
        model: "Rio",
        year: 2019,
        mileage: 800,
        color: "Blue",
        fuelType: "Gas",
        transmission: "Auto",
        sellingPrice: 15000,
        status: "AVAILABLE",
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: "member_1",
      })
    );
    const bulk = await asAdmin.mutation(api.adminData.adminRestoreRecords, {
      table: "vehicles",
      ids: [vehicleId2, vehicleId3],
    });
    expect(bulk).toMatchObject({ restored: 2 });

    const stillDeleted = await asAdmin.query(api.adminData.adminListByOrg, {
      orgId,
      table: "vehicles",
      deletedOnly: true,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(stillDeleted.page).toHaveLength(0);
  });

  test("restore rejects records that are not soft-deleted and financial tables", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);

    // The seeded vehicle is live — nothing to restore.
    await expect(
      asAdmin.mutation(api.adminData.adminRestoreRecords, { table: "vehicles", ids: [vehicleId] })
    ).rejects.toThrow(/not soft-deleted/i);

    // Financial tables stay off-limits even for restore.
    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 1000,
        date: Date.now(),
        category: "OTHER",
        description: "Financial record",
      })
    );
    await expect(
      asAdmin.mutation(api.adminData.adminRestoreRecords, { table: "transactions", ids: [transactionId] })
    ).rejects.toThrow(/financial table/i);

    // Passing a financial-table id under a non-financial table must not bypass
    // the guard — normalizeId rejects the mismatch before any patch happens.
    await expect(
      asAdmin.mutation(api.adminData.adminRestoreRecords, { table: "vehicles", ids: [transactionId] })
    ).rejects.toThrow(/does not belong to table/i);
    const untouched = await t.run((ctx) => ctx.db.get(transactionId));
    expect(untouched).toMatchObject({ amount: 1000 });
    expect((untouched as any).isDeleted).toBeUndefined();
  });

  test("update and hard-delete reject a financial-table id passed under a non-financial table", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asAdmin } = await seedOrgWithVehicle(t);

    const transactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 1000,
        date: Date.now(),
        category: "OTHER",
        description: "Financial record",
      })
    );

    // Declaring table:"vehicles" clears both assertAdminTable and
    // assertAdminMayMutateTable, but the id belongs to `transactions` — a
    // financial table. ctx.db.patch/delete resolve by the id's REAL table, so
    // without normalizeId the financial guard is fully bypassable.
    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: transactionId,
        patch: { amount: 1 },
      })
    ).rejects.toThrow(/does not belong to table/i);

    await expect(
      asAdmin.mutation(api.adminData.adminHardDelete, {
        table: "vehicles",
        id: transactionId,
      })
    ).rejects.toThrow(/does not belong to table/i);

    // The financial row must be untouched and still present.
    const untouched = await t.run((ctx) => ctx.db.get(transactionId));
    expect(untouched).toMatchObject({ amount: 1000 });
  });

  test("update rejects a patch that would move a record to another org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { vehicleId, asAdmin } = await seedOrgWithVehicle(t);
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );

    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: vehicleId,
        patch: { orgId: otherOrgId },
      })
    ).rejects.toThrow(/orgId/i);
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
