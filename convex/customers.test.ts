import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:customers", "edit:customers", "delete:customers",
  "view:customers", "view:users", "merge:customers",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_c1", email: "c@test.com", name: "Customer User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_c1" });
  return { t, orgId, userId, asUser };
}

describe("customers.create", () => {
  test("creates a customer record", async () => {
    const { t, orgId, asUser } = await setup();

    const customerId = await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Jane",
      lastName: "Smith",
      email: "jane@example.com",
      phone: "+1234567890",
    });

    expect(customerId).toBeDefined();

    await t.run(async (ctx) => {
      const customer = await ctx.db.get(customerId);
      expect(customer?.firstName).toBe("Jane");
      expect(customer?.lastName).toBe("Smith");
      expect(customer?.email).toBe("jane@example.com");
      expect(customer?.orgId).toBe(orgId);
    });
  });

  test("rejects unauthenticated requests", async () => {
    const { t, orgId } = await setup();

    await expect(
      t.mutation(api.customers.create, {
        orgId,
        firstName: "John",
        lastName: "Doe",
      })
    ).rejects.toThrow();
  });

  test("rejects duplicate email within the same org", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Alice",
      lastName: "Dupont",
      email: "duplicate@example.com",
    });

    await expect(
      asUser.mutation(api.customers.create, {
        orgId,
        firstName: "Bob",
        lastName: "Dupont",
        email: "duplicate@example.com",
      })
    ).rejects.toThrow(/already exists/i);
  });

  test("rejects duplicate phone within the same org, regardless of formatting", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Alice",
      lastName: "Dupont",
      phone: "+1 (234) 567-8900",
    });

    await expect(
      asUser.mutation(api.customers.create, {
        orgId,
        firstName: "Bob",
        lastName: "Dupont",
        phone: "+1-234-567-8900",
      })
    ).rejects.toThrow(/already exists/i);
  });

  test("allows same email in a different org", async () => {
    const { t, orgId, asUser } = await setup();

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const userId2 = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_c2", email: "c2@test.com", name: "User 2" })
    );
    const roleId2 = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: orgId2, name: "ADMIN", permissions: PERMISSIONS })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: orgId2, userId: userId2, roleId: roleId2 }));
    const asUser2 = t.withIdentity({ subject: "user_c2" });

    await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Alice",
      lastName: "One",
      email: "shared@example.com",
    });

    const id2 = await asUser2.mutation(api.customers.create, {
      orgId: orgId2,
      firstName: "Alice",
      lastName: "Two",
      email: "shared@example.com",
    });

    expect(id2).toBeDefined();
  });
});

describe("customers.softDelete", () => {
  test("marks customer as deleted", async () => {
    const { t, orgId, asUser } = await setup();

    const customerId = await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Delete",
      lastName: "Me",
    });

    await asUser.mutation(api.customers.softDelete, { orgId, customerId });

    await t.run(async (ctx) => {
      const customer = await ctx.db.get(customerId);
      expect(customer?.isDeleted).toBe(true);
    });
  });
});

describe("customers.update", () => {
  test("updates customer fields", async () => {
    const { t, orgId, asUser } = await setup();

    const customerId = await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Old",
      lastName: "Name",
    });

    await asUser.mutation(api.customers.update, {
      orgId,
      customerId,
      firstName: "New",
      phone: "+9876543210",
    });

    await t.run(async (ctx) => {
      const customer = await ctx.db.get(customerId);
      expect(customer?.firstName).toBe("New");
      expect(customer?.phone).toBe("+9876543210");
    });
  });
});

describe("customers.checkDuplicates", () => {
  test("returns exact phone/email matches and possible name matches, non-blocking", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Sara",
      lastName: "Khalil",
      phone: "+962791234567",
      email: "sara@example.com",
    });

    const result = await asUser.query(api.customers.checkDuplicates, {
      orgId,
      phone: "+962-79-1234567",
      email: "sara@example.com",
      firstName: "Sara",
      lastName: "Khalil",
    });

    expect(result.exactPhoneMatch?.firstName).toBe("Sara");
    expect(result.exactEmailMatch?.firstName).toBe("Sara");
    expect(result.possibleNameMatches.length).toBe(1);
  });

  test("excludes the record being edited from its own duplicate check", async () => {
    const { orgId, asUser } = await setup();

    const customerId = await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Omar",
      lastName: "Nasser",
      phone: "+962790000000",
    });

    const result = await asUser.query(api.customers.checkDuplicates, {
      orgId,
      phone: "+962790000000",
      excludeCustomerId: customerId,
    });

    expect(result.exactPhoneMatch).toBeNull();
  });
});

describe("customers.findMergeCandidates", () => {
  test("groups customers with a matching normalized name", async () => {
    const { orgId, asUser } = await setup();

    await asUser.mutation(api.customers.create, { orgId, firstName: "Sara", lastName: "Khalil", phone: "+962790000001" });
    await asUser.mutation(api.customers.create, { orgId, firstName: "sara", lastName: "khalil", phone: "+962790000002" });
    await asUser.mutation(api.customers.create, { orgId, firstName: "Unique", lastName: "Person", phone: "+962790000003" });

    const candidates = await asUser.query(api.customers.findMergeCandidates, { orgId });

    expect(candidates.length).toBe(1);
    expect(candidates[0].customers.length).toBe(2);
  });
});

describe("customers.mergeCustomers", () => {
  test("reassigns leads, sales, and guarantors, soft-deletes the loser, and writes an audit row", async () => {
    const { t, orgId, userId, asUser } = await setup();

    const survivorId = await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Survivor",
      lastName: "Customer",
      phone: "+962790000010",
    });
    const loserId = await asUser.mutation(api.customers.create, {
      orgId,
      firstName: "Loser",
      lastName: "Customer",
      email: "loser@test.com",
    });

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A004352",
        make: "Honda",
        model: "Accord",
        year: 2020,
        mileage: 10000,
        color: "Black",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 15000,
        status: "AVAILABLE",
      })
    );

    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId: loserId, source: "Walk-in", stage: "NEW" })
    );
    const saleId = await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId: loserId,
        salespersonId: userId,
        salePrice: 15000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );
    const guarantorId = await t.run((ctx) =>
      ctx.db.insert("guarantors", {
        orgId,
        customerId: loserId,
        firstName: "G",
        lastName: "Tor",
        nationalId: "123",
        phone: "+962790000099",
      })
    );

    const preview = await asUser.query(api.customers.previewMerge, { orgId, survivorId, loserId });
    expect(preview.reassignedCounts.leads).toBe(1);
    expect(preview.reassignedCounts.sales).toBe(1);
    expect(preview.reassignedCounts.guarantors).toBe(1);

    const result = await asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId });
    expect(result.reassignedCounts.leads).toBe(1);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(leadId))?.customerId).toBe(survivorId);
      expect((await ctx.db.get(saleId))?.customerId).toBe(survivorId);
      expect((await ctx.db.get(guarantorId))?.customerId).toBe(survivorId);

      const loser = await ctx.db.get(loserId);
      expect(loser?.isDeleted).toBe(true);

      const survivor = await ctx.db.get(survivorId);
      expect(survivor?.email).toBe("loser@test.com");

      const merges = await ctx.db.query("customerMerges").collect();
      expect(merges.length).toBe(1);
      expect(merges[0].survivorId).toBe(survivorId);
      expect(merges[0].loserId).toBe(loserId);
    });
  });

  test("rejects merging a customer with itself", async () => {
    const { orgId, asUser } = await setup();
    const customerId = await asUser.mutation(api.customers.create, { orgId, firstName: "A", lastName: "B" });

    await expect(
      asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId: customerId, loserId: customerId })
    ).rejects.toThrow();
  });

  test("rejects merging a customer from a different organization", async () => {
    const { t, orgId, asUser } = await setup();

    const survivorId = await asUser.mutation(api.customers.create, { orgId, firstName: "A", lastName: "B" });

    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Org", createdAt: Date.now() })
    );
    const otherCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "C", lastName: "D" })
    );

    await expect(
      asUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId: otherCustomerId })
    ).rejects.toThrow();
  });

  test("rejects merge without merge:customers permission", async () => {
    const { t, orgId, asUser } = await setup();

    const survivorId = await asUser.mutation(api.customers.create, { orgId, firstName: "A", lastName: "B" });
    const loserId = await asUser.mutation(api.customers.create, { orgId, firstName: "C", lastName: "D" });

    const userId2 = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_no_merge", email: "nm@test.com", name: "No Merge" })
    );
    const roleId2 = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:customers"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: userId2, roleId: roleId2 }));
    const asLimitedUser = t.withIdentity({ subject: "user_no_merge" });

    await expect(
      asLimitedUser.mutation(api.customers.mergeCustomers, { orgId, survivorId, loserId })
    ).rejects.toThrow();
  });
});
