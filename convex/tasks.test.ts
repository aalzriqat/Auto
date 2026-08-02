import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const MODULES = import.meta.glob("./**/*.*s");
// `delete:tasks` is granted in BOTH orgs on purpose. The cross-tenant test
// below has to fail on row ownership, not on a missing permission — otherwise
// it would pass for the wrong reason and keep passing if the guard were removed.
const TASK_PERMISSIONS = ["view:tasks", "create:tasks", "edit:tasks", "delete:tasks"];

async function seedTaskTenants() {
  const t = convexTestWithComponents(schema, MODULES);
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

async function seedVehicle(t: ReturnType<typeof convexTestWithComponents>, orgId: Id<"organizations">, suffix: string) {
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

describe("tasks soft delete", () => {
  const PAGE = { cursor: null, numItems: 50 };

  test("marks the row deleted instead of removing it, and records who did it", async () => {
    const seed = await seedTaskTenants();
    const taskId = await seed.asOrgA.mutation(api.tasks.create, createTaskArgs(seed));

    await seed.asOrgA.mutation(api.tasks.softDelete, { orgId: seed.orgA, taskId });

    const row = await seed.t.run((ctx) => ctx.db.get(taskId));
    expect(row).not.toBeNull();
    expect(row?.isDeleted).toBe(true);
    expect(typeof row?.deletedAt).toBe("number");
    // Matches the string column the schema declares, and the identity every
    // other soft-delete writer in this codebase stores.
    expect(row?.deletedBy).toBe("task_user_a");
  });

  test("a deleted task disappears from list", async () => {
    const seed = await seedTaskTenants();
    const taskId = await seed.asOrgA.mutation(api.tasks.create, createTaskArgs(seed));

    const before = await seed.asOrgA.query(api.tasks.list, { orgId: seed.orgA, paginationOpts: PAGE });
    expect(before.page.map((task) => task._id)).toContain(taskId);

    await seed.asOrgA.mutation(api.tasks.softDelete, { orgId: seed.orgA, taskId });

    const after = await seed.asOrgA.query(api.tasks.list, { orgId: seed.orgA, paginationOpts: PAGE });
    expect(after.page.map((task) => task._id)).not.toContain(taskId);
  });

  test("a deleted task can no longer be updated, deleted again, or read back", async () => {
    const seed = await seedTaskTenants();
    const taskId = await seed.asOrgA.mutation(api.tasks.create, createTaskArgs(seed));
    await seed.asOrgA.mutation(api.tasks.softDelete, { orgId: seed.orgA, taskId });

    await expect(
      seed.asOrgA.mutation(api.tasks.update, { orgId: seed.orgA, taskId, title: "Resurrected" })
    ).rejects.toThrow(/Task not found/);
    await expect(
      seed.asOrgA.mutation(api.tasks.softDelete, { orgId: seed.orgA, taskId })
    ).rejects.toThrow(/Task not found/);
    await expect(
      seed.asOrgA.query(api.tasks.getHistory, { orgId: seed.orgA, taskId })
    ).rejects.toThrow(/Task not found/);
  });

  test("appends a DELETE history entry rather than clearing the trail", async () => {
    const seed = await seedTaskTenants();
    const taskId = await seed.asOrgA.mutation(api.tasks.create, createTaskArgs(seed));
    await seed.asOrgA.mutation(api.tasks.softDelete, { orgId: seed.orgA, taskId });

    // getHistory deliberately refuses a deleted task, so read the table directly.
    const history = await seed.t.run((ctx) =>
      ctx.db.query("taskHistory").collect()
    );
    const forTask = history.filter((entry) => entry.taskId === taskId);
    expect(forTask.map((entry) => entry.action).sort()).toEqual(["CREATE", "DELETE"]);
    expect(forTask.find((entry) => entry.action === "DELETE")?.userId).toBe(seed.userA);
  });

  test("a caller from another org cannot delete a task, even naming their own org honestly", async () => {
    const seed = await seedTaskTenants();
    const taskA = await seed.asOrgA.mutation(api.tasks.create, createTaskArgs(seed));

    // Org B's member names org B — which they really are a member of, with
    // delete:tasks — and passes org A's task id. requireTenantAuth alone waves
    // this through; only the row-ownership check stops it.
    await expect(
      seed.asOrgB.mutation(api.tasks.softDelete, { orgId: seed.orgB, taskId: taskA })
    ).rejects.toThrow(/not found/i);

    const row = await seed.t.run((ctx) => ctx.db.get(taskA));
    expect(row?.isDeleted).toBeUndefined();

    // And it is still visible to the org that actually owns it.
    const list = await seed.asOrgA.query(api.tasks.list, { orgId: seed.orgA, paginationOpts: PAGE });
    expect(list.page.map((task) => task._id)).toContain(taskA);
  });

  test("a member without delete:tasks cannot delete", async () => {
    const seed = await seedTaskTenants();
    const taskId = await seed.asOrgA.mutation(api.tasks.create, createTaskArgs(seed));

    const viewerRole = await seed.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: seed.orgA, name: "Task Viewer", permissions: ["view:tasks"] })
    );
    const viewer = await seed.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "task_viewer_a", email: "v@example.com", name: "V" })
    );
    await seed.t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: seed.orgA, userId: viewer, roleId: viewerRole })
    );

    await expect(
      seed.t
        .withIdentity({ subject: "task_viewer_a" })
        .mutation(api.tasks.softDelete, { orgId: seed.orgA, taskId })
    ).rejects.toThrow();

    const row = await seed.t.run((ctx) => ctx.db.get(taskId));
    expect(row?.isDeleted).toBeUndefined();
  });
});
