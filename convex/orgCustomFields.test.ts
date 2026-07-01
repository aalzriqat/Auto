import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedOwner(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "owner_cf_001", email: "owner@test.com", name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId })
  );
  return { orgId, asOwner: t.withIdentity({ subject: "owner_cf_001" }) };
}

describe("orgCustomFields", () => {
  test("list returns empty when no fields", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const fields = await asOwner.query(api.orgCustomFields.list, { orgId });
    expect(fields).toHaveLength(0);
  });

  test("list can filter by entityType", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.orgCustomFields.create, {
      orgId,
      entityType: "vehicle",
      fieldName: "Condition",
      fieldKey: "condition",
      fieldType: "select",
      options: ["New", "Used"],
    });
    await asOwner.mutation(api.orgCustomFields.create, {
      orgId,
      entityType: "customer",
      fieldName: "Nationality",
      fieldKey: "nationality",
      fieldType: "text",
    });
    const vehicleFields = await asOwner.query(api.orgCustomFields.list, {
      orgId,
      entityType: "vehicle",
    });
    expect(vehicleFields).toHaveLength(1);
    expect(vehicleFields[0].fieldKey).toBe("condition");
  });

  test("create inserts a field with correct defaults", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const fieldId = await asOwner.mutation(api.orgCustomFields.create, {
      orgId,
      entityType: "lead",
      fieldName: "Source Detail",
      fieldKey: "source_detail",
      fieldType: "text",
    });
    expect(fieldId).toBeDefined();
    const fields = await asOwner.query(api.orgCustomFields.list, { orgId });
    expect(fields[0].isRequired).toBe(false);
    expect(fields[0].isActive).toBe(true);
  });

  test("update changes fieldName and isRequired", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    const fieldId = await asOwner.mutation(api.orgCustomFields.create, {
      orgId,
      entityType: "vehicle",
      fieldName: "Old Name",
      fieldKey: "old_key",
      fieldType: "text",
    });
    await asOwner.mutation(api.orgCustomFields.update, {
      orgId,
      fieldId,
      fieldName: "New Name",
      isRequired: true,
    });
    const fields = await asOwner.query(api.orgCustomFields.list, { orgId });
    expect(fields[0].fieldName).toBe("New Name");
    expect(fields[0].isRequired).toBe(true);
  });

  test("remove deletes the field and cascades its values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    // Create a vehicle to attach a value to
    const vehicleId = await t.run(async (ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "TEST00001",
        make: "Test",
        model: "Model",
        year: 2020,
        color: "Black",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 0,
        sellingPrice: 10000,
        status: "AVAILABLE",
      })
    );

    const fieldId = await asOwner.mutation(api.orgCustomFields.create, {
      orgId,
      entityType: "vehicle",
      fieldName: "Notes",
      fieldKey: "notes",
      fieldType: "text",
    });

    // Save a value
    await asOwner.mutation(api.orgCustomFields.setValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
      values: [{ fieldId, value: "some note" }],
    });

    // Remove the field
    await asOwner.mutation(api.orgCustomFields.remove, { orgId, fieldId });

    // Field and its values should be gone
    const fields = await asOwner.query(api.orgCustomFields.list, { orgId });
    expect(fields).toHaveLength(0);

    const values = await asOwner.query(api.orgCustomFields.getValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
    });
    expect(values).toHaveLength(0);
  });

  test("setValues upserts and deletes blank values", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    const vehicleId = await t.run(async (ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "TEST00002",
        make: "Test",
        model: "M",
        year: 2021,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 0,
        sellingPrice: 8000,
        status: "AVAILABLE",
      })
    );

    const fieldId = await asOwner.mutation(api.orgCustomFields.create, {
      orgId,
      entityType: "vehicle",
      fieldName: "Color Grade",
      fieldKey: "color_grade",
      fieldType: "text",
    });

    // Set a value
    await asOwner.mutation(api.orgCustomFields.setValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
      values: [{ fieldId, value: "A" }],
    });
    let vals = await asOwner.query(api.orgCustomFields.getValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
    });
    expect(vals[0].value).toBe("A");

    // Update it
    await asOwner.mutation(api.orgCustomFields.setValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
      values: [{ fieldId, value: "B" }],
    });
    vals = await asOwner.query(api.orgCustomFields.getValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
    });
    expect(vals[0].value).toBe("B");

    // Clear it with empty string
    await asOwner.mutation(api.orgCustomFields.setValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
      values: [{ fieldId, value: "" }],
    });
    vals = await asOwner.query(api.orgCustomFields.getValues, {
      orgId,
      entityType: "vehicle",
      entityId: vehicleId,
    });
    expect(vals).toHaveLength(0);
  });
});
