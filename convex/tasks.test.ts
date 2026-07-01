import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const MODULES = import.meta.glob("./**/*.*s");
const TASK_PERMISSIONS = ["view:tasks", "create:tasks", "edit:tasks"];

async function seedTaskTenants() {
  const t = convexTest(schema, MODULES);
  const orgA = await t.run((ctx) => ctx.db.insert("organizations", { name: "Org A", createdAt: Date.now() }));
  const orgB = await t.run((ctx) => ctx.db.insert("organizations", { name: "Org B", createdAt: Date.now() }));
  const userA = await t.run((ctx) => ctx.db.insert("users", { clerkId: "task_user_a", email: "a@example.com", name: "A" }));
  const userB = await t.run((ctx) => ctx.db.insert("users", { clerkId: "task_user_b", email: "b@example.com", name: "B" }));
  const roleA = await t.run((ctx) => ctx.db.insert("roles", { orgId: orgA, name: "Task Admin", permissions: TASK_PERMISSIONS }));
  const roleB = await t.run((ctx) => ctx.db.insert("roles", { orgId: orgB, name: "Task Admin", permissions: TASK_PERMISSIONS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId: orgA, userId: userA, roleId: roleA }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId: orgB, userId: userB, roleId: roleB }));

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId: orgA, firstName: "Alice", lastName: "A", email: "alice@example.com" })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId: orgB, firstName: "Bob", lastName: "B", email: "bob@example.com" })
  );
  const vehicleA = await seedVehicle(t, orgA, "A");
  const vehicleB = await seedVehicle(t, orgB, "B");
  const leadA = await t.run((ctx) =>
    ctx.db.insert("leads", { orgId: orgA, customerId: customerA, vehicleId: vehicleA, source: "test", stage: "NEW" })
  );
  const leadB = await t.run((ctx) =>
    ctx.db.insert("leads", { orgId: orgB, customerId: customerB, vehicleId: vehicleB, source: "test", stage: "NEW" })
  );

  return {
    t,
    orgA,
    orgB,
    userA,
    userB,
    customerA,
    customerB,
    vehicleA,
    vehicleB,
    leadA,
    leadB,
    asOrgA: t.withIdentity({ subject: "task_user_a" }),
    asOrgB: t.withIdentity({ subject: "task_user_b" }),
  };
}

async function seedVehicle(t: ReturnType<typeof convexTest>, orgId: Id<"organizations">, suffix: string) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: `Camry ${suffix}`,
      year: 2024,
      mileage: 10,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 25000,
      status: "AVAILABLE",
    })
  );
}

function createTaskArgs(seed: Awaited<ReturnType<typeof seedTaskTenants>>) {
  return {
    orgId: seed.orgA,
    assignedTo: seed.userA,
    title: "Follow up",
    dueDate: Date.now() + 60_000,
    status: "PENDING" as const,
  };
}

describe("tasks tenant isolation", () => {
  test("create rejects cross-tenant customer, lead, and vehicle references", async () => {
    const seed = await seedTaskTenants();

    await expect(
      seed.asOrgA.mutation(api.tasks.create, { ...createTaskArgs(seed), customerId: seed.customerB })
    ).rejects.toThrow(/Customer not found/);
    await expect(
      seed.asOrgA.mutation(api.tasks.create, { ...createTaskArgs(seed), leadId: seed.leadB })
    ).rejects.toThrow(/Lead not found/);
    await expect(
      seed.asOrgA.mutation(api.tasks.create, { ...createTaskArgs(seed), vehicleId: seed.vehicleB })
    ).rejects.toThrow(/Vehicle not found/);

    const orgATasks = await seed.t.run((ctx) =>
      ctx.db.query("tasks").withIndex("by_org", (q) => q.eq("orgId", seed.orgA)).collect()
    );
    expect(orgATasks).toHaveLength(0);
  });

  test("update rejects cross-tenant reassignment, customer, and vehicle references", async () => {
    const seed = await seedTaskTenants();
    const taskId = await seed.asOrgA.mutation(api.tasks.create, {
      ...createTaskArgs(seed),
      customerId: seed.customerA,
      leadId: seed.leadA,
      vehicleId: seed.vehicleA,
    });

    await expect(
      seed.asOrgA.mutation(api.tasks.update, { orgId: seed.orgA, taskId, assignedTo: seed.userB })
    ).rejects.toThrow(/Assigned user/);
    await expect(
      seed.asOrgA.mutation(api.tasks.update, { orgId: seed.orgA, taskId, customerId: seed.customerB })
    ).rejects.toThrow(/Customer not found/);
    await expect(
      seed.asOrgA.mutation(api.tasks.update, { orgId: seed.orgA, taskId, vehicleId: seed.vehicleB })
    ).rejects.toThrow(/Vehicle not found/);
  });

  test("history lookup verifies the task belongs to the requested organization", async () => {
    const seed = await seedTaskTenants();
    const taskB = await seed.asOrgB.mutation(api.tasks.create, {
      orgId: seed.orgB,
      assignedTo: seed.userB,
      title: "Other org task",
      dueDate: Date.now() + 60_000,
      status: "PENDING",
    });

    await expect(
      seed.asOrgA.query(api.tasks.getHistory, { orgId: seed.orgA, taskId: taskB })
    ).rejects.toThrow(/Task not found/);

    const history = await seed.asOrgB.query(api.tasks.getHistory, { orgId: seed.orgB, taskId: taskB });
    expect(history).toHaveLength(1);
  });
});
