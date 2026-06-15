import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

const PERMISSIONS = [
  "create:customers", "edit:customers", "delete:customers",
  "view:customers", "view:users",
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
