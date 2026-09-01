import { convexTestWithComponents } from "../test-utils/convexTest";
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

async function seedOrgWithVehicle(t: ReturnType<typeof convexTestWithComponents>) {
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

describe("the raw editor may not forge vehicle sale-ownership authority", () => {
  test("changing a vehicle status or its owning sale is refused; other fields still edit", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);

    // SCRUM-212-R3 / F3, found independently by both reviewer seats.
    //
    // `vehicles` is not in FINANCIAL_TABLES and this patch validator is
    // `v.any`, so a super-admin could write SOLD with no owner, or name a
    // sale that does not own the car. `restoreVehicleFromSale` then trusts
    // that field and fails closed — turning a forged value into a car that
    // can never be released, and a legitimate cancellation into a refusal
    // blaming the wrong sale.
    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: vehicleId,
        patch: { status: "SOLD" },
      })
    ).rejects.toThrow(/sale workflow/i);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Forge", lastName: "Target" })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "forge_user", email: "forge@acme.com" })
    );
    const foreignSaleId = await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 1,
        saleDate: Date.now(),
        status: "PENDING" as const,
      })
    );
    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: vehicleId,
        patch: { soldBySaleId: foreignSaleId },
      })
    ).rejects.toThrow(/sale workflow/i);

    // The control that keeps the guard narrow: ordinary admin repair of a
    // non-lifecycle field must still work, and a full-record patch that
    // merely REPEATS the current status unchanged is not a forge — the
    // admin UI sends the whole record back, so refusing any patch that
    // mentions the field would break every legitimate edit.
    await asAdmin.mutation(api.adminData.adminUpdateRecord, {
      table: "vehicles",
      id: vehicleId,
      patch: { color: "Repainted", status: "AVAILABLE" },
    });
    const after = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(after?.color).toBe("Repainted");
    expect(after?.status).toBe("AVAILABLE");
  });
});

/**
 * SCRUM-212-NEW-1 — the forgery guard must not also seal the only exit.
 *
 * ⚠️ DEFENCE IN DEPTH, and stated as such: on fresh data a SOLD car ALWAYS
 * has an owner, because `markVehicleAsSold` is the only writer of that status
 * and it stamps `soldBySaleId` in the same patch. These fixtures build the
 * unowned state directly, because no door produces it any more — which is
 * exactly why the state needs a way OUT rather than a way in.
 */
describe("a SOLD car nobody owns can still be released", () => {
  async function soldVehicle(
    t: ReturnType<typeof convexTestWithComponents>,
    orgId: string,
    vehicleId: string,
    owner: string | undefined
  ) {
    await t.run((ctx) =>
      ctx.db.patch(vehicleId as never, {
        status: "SOLD" as const,
        soldBySaleId: owner as never,
      })
    );
  }

  async function realSale(t: ReturnType<typeof convexTestWithComponents>, orgId: string, vehicleId: string) {
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: orgId as never, firstName: "Real", lastName: "Buyer" })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "new1_user", email: "new1@acme.com" })
    );
    return await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: orgId as never,
        vehicleId: vehicleId as never,
        customerId,
        salespersonId: userId,
        salePrice: 1,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      })
    );
  }

  test("with no owner recorded, an admin can move it off SOLD", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);
    await soldVehicle(t, orgId, vehicleId, undefined);

    // Every other door refuses this car: restoreVehicleFromSale has no
    // ownership to prove, and vehicles.update / vehicleRequests both refuse
    // any change away from a workflow-controlled status. If this one refuses
    // too the car is stranded permanently.
    await asAdmin.mutation(api.adminData.adminUpdateRecord, {
      table: "vehicles",
      id: vehicleId,
      patch: { status: "AVAILABLE" },
    });

    const after = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(after?.status).toBe("AVAILABLE");
  });

  test("with a real owner recorded, it is still refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);
    const saleId = await realSale(t, orgId, vehicleId);
    await soldVehicle(t, orgId, vehicleId, saleId as unknown as string);

    // The F3 regression guard. This car has a real answer — cancel the sale
    // that owns it — so the escape hatch must NOT apply here.
    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: vehicleId,
        patch: { status: "AVAILABLE" },
      })
    ).rejects.toThrow(/sale workflow/i);

    const after = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(after?.status).toBe("SOLD");
  });

  test("the escape hatch cannot mark a car SOLD, nor launder an owner in", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, vehicleId, asAdmin } = await seedOrgWithVehicle(t);

    // Moving INTO SOLD stays refused — only a completed sale says that.
    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: vehicleId,
        patch: { status: "SOLD" },
      })
    ).rejects.toThrow(/sale workflow/i);

    // And an unowned SOLD car cannot be released WHILE naming an owner in the
    // same patch — otherwise the hatch becomes the forgery it exists beside.
    await soldVehicle(t, orgId, vehicleId, undefined);
    const saleId = await realSale(t, orgId, vehicleId);
    await expect(
      asAdmin.mutation(api.adminData.adminUpdateRecord, {
        table: "vehicles",
        id: vehicleId,
        patch: { status: "AVAILABLE", soldBySaleId: saleId },
      })
    ).rejects.toThrow(/sale workflow/i);

    const after = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(after?.status).toBe("SOLD");
    expect(after?.soldBySaleId).toBeUndefined();
  });
});

describe("adminData", () => {
  test("rejects a non-allowlisted caller", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asMember } = await seedOrgWithVehicle(t);
    await expect(
      asMember.query(api.adminData.adminListByOrg, { orgId, table: "vehicles", paginationOpts: { numItems: 10, cursor: null } })
    ).rejects.toThrow();
  });

  test("rejects a table not on the allowlist", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asAdmin } = await seedOrgWithVehicle(t);
    await expect(
      asAdmin.query(api.adminData.adminListByOrg, { orgId, table: "users", paginationOpts: { numItems: 10, cursor: null } })
    ).rejects.toThrow();
  });

  test("allowlisted admin can list, edit, and hard-delete a record across orgs", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
