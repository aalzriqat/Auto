import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// SCRUM-790, ruled by SCRUM-760 c22465 (R-PERMISSION) and SCRUM-790 c22466:
// writing a custom-field value changes the entity's data, so it needs the
// matching edit permission, a field declared for that entity type, and an entity
// that exists in the caller's own org. Membership alone never authorizes a write.

type T = ReturnType<typeof convexTestWithComponents>;

async function seed(t: T) {
  const orgId = await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Org", createdAt: Date.now() }));
  const otherOrgId = await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));

  const member = async (clerkId: string, permissions: string[]) => {
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId }));
    const roleId = await t.run(async (ctx) => ctx.db.insert("roles", { orgId, name: `role_${clerkId}`, permissions: permissions as never }));
    await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: clerkId });
  };

  const ownerUser = await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "owner_790", email: "o@test.com", name: "Owner" }));
  const ownerRole = await t.run(async (ctx) => ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true }));
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId: ownerUser, roleId: ownerRole }));
  const asOwner = t.withIdentity({ subject: "owner_790" });

  const vehicle = (id: typeof orgId, vin: string) =>
    t.run(async (ctx) =>
      ctx.db.insert("vehicles", {
        orgId: id, vin, make: "T", model: "M", year: 2021, color: "White", fuelType: "Gasoline",
        transmission: "Automatic", mileage: 0, sellingPrice: 1, status: "AVAILABLE",
      }),
    );
  const vehicleId = await vehicle(orgId, "V790A");
  const foreignVehicleId = await vehicle(otherOrgId, "V790B");
  const customerId = await t.run(async (ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", email: "c@test.com", phone: "1" } as never),
  );

  const vehicleFieldId = await asOwner.mutation(api.orgCustomFields.create, {
    orgId, entityType: "vehicle", fieldName: "Note", fieldKey: "note", fieldType: "text",
  });
  const customerFieldId = await asOwner.mutation(api.orgCustomFields.create, {
    orgId, entityType: "customer", fieldName: "Nat", fieldKey: "nat", fieldType: "text",
  });

  return { orgId, asOwner, member, vehicleId, foreignVehicleId, customerId, vehicleFieldId, customerFieldId };
}

const values = (t: T, orgId: string) =>
  t.run(async (ctx) => (await ctx.db.query("orgCustomFieldValues").collect()).filter((r) => r.orgId === orgId));

describe("orgCustomFields.setValues authorization (SCRUM-790)", () => {
  test("a view-only member cannot write a vehicle custom-field value", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    const viewer = await s.member("viewer_790", [PERMISSIONS.VIEW_VEHICLES]);
    await expect(
      viewer.mutation(api.orgCustomFields.setValues, {
        orgId: s.orgId, entityType: "vehicle", entityId: s.vehicleId,
        values: [{ fieldId: s.vehicleFieldId, value: "tampered" }],
      }),
    ).rejects.toThrow();
    expect(await values(t, s.orgId)).toHaveLength(0);
  });

  test("a view-only member cannot clear an existing value either", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    await s.asOwner.mutation(api.orgCustomFields.setValues, {
      orgId: s.orgId, entityType: "vehicle", entityId: s.vehicleId,
      values: [{ fieldId: s.vehicleFieldId, value: "keep" }],
    });
    const viewer = await s.member("viewer2_790", [PERMISSIONS.VIEW_VEHICLES]);
    await expect(
      viewer.mutation(api.orgCustomFields.setValues, {
        orgId: s.orgId, entityType: "vehicle", entityId: s.vehicleId,
        values: [{ fieldId: s.vehicleFieldId, value: "" }],
      }),
    ).rejects.toThrow();
    expect((await values(t, s.orgId)).map((r) => r.value)).toEqual(["keep"]);
  });

  test("EDIT_VEHICLES does not authorize writing a customer value (permission follows the entity type)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    const vehicleEditor = await s.member("veh_editor_790", [PERMISSIONS.EDIT_VEHICLES]);
    await expect(
      vehicleEditor.mutation(api.orgCustomFields.setValues, {
        orgId: s.orgId, entityType: "customer", entityId: s.customerId,
        values: [{ fieldId: s.customerFieldId, value: "x" }],
      }),
    ).rejects.toThrow();
    expect(await values(t, s.orgId)).toHaveLength(0);
  });

  test("the matching edit permission still writes (positive control)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    const editor = await s.member("editor_790", [PERMISSIONS.EDIT_VEHICLES]);
    await editor.mutation(api.orgCustomFields.setValues, {
      orgId: s.orgId, entityType: "vehicle", entityId: s.vehicleId,
      values: [{ fieldId: s.vehicleFieldId, value: "ok" }],
    });
    expect((await values(t, s.orgId)).map((r) => r.value)).toEqual(["ok"]);
  });

  test("a field declared for another entity type cannot be written onto this entity", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    await expect(
      s.asOwner.mutation(api.orgCustomFields.setValues, {
        orgId: s.orgId, entityType: "vehicle", entityId: s.vehicleId,
        values: [{ fieldId: s.customerFieldId, value: "wrong type" }],
      }),
    ).rejects.toThrow();
    expect(await values(t, s.orgId)).toHaveLength(0);
  });

  test("an entity id from another org, a missing one, or a free string is refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    for (const entityId of [s.foreignVehicleId as string, "veh_does_not_exist", s.customerId as string]) {
      await expect(
        s.asOwner.mutation(api.orgCustomFields.setValues, {
          orgId: s.orgId, entityType: "vehicle", entityId,
          values: [{ fieldId: s.vehicleFieldId, value: "x" }],
        }),
      ).rejects.toThrow(/not found/i);
    }
    expect(await values(t, s.orgId)).toHaveLength(0);
  });

  test("an unknown entity type is refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const s = await seed(t);
    await expect(
      s.asOwner.mutation(api.orgCustomFields.setValues, {
        orgId: s.orgId, entityType: "organization", entityId: s.orgId,
        values: [{ fieldId: s.vehicleFieldId, value: "x" }],
      }),
    ).rejects.toThrow();
  });
});
