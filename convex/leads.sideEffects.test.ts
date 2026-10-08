import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { judgeEffects, type Effect, type Expectation, type Member } from "../scripts/intelligence/sideEffectOracle";
import { ACTION_EXPECTATIONS } from "../scripts/intelligence/sideEffectExpectations";

/**
 * SCRUM-620 (SCRUM-760 gate G6): the side-effect oracle applied at the lowest
 * level that can catch it. Each lead action runs against the real notification
 * fan-out; the fixed rules in scripts/intelligence/sideEffectOracle decide
 * whether the in-app rows it produced are exactly the ones the action promises
 * (missing, duplicated, or reaching someone they should not, including another
 * organization). The expectations come from ACTION_EXPECTATIONS, which names
 * the notifyX call each promise is read from.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MANAGER_PERMISSIONS = ["create:leads", "edit:leads", "delete:leads", "view:leads", "view:customers", "view:vehicles", "view:users", "manage:users"];
const SALES_PERMISSIONS = ["view:leads", "view:customers"];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() }));
  const managerRole = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: MANAGER_PERMISSIONS }));
  const salesRole = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: SALES_PERMISSIONS }));
  const otherRole = await t.run((ctx) => ctx.db.insert("roles", { orgId: otherOrgId, name: "MANAGER", permissions: MANAGER_PERMISSIONS }));

  const mkUser = (clerkId: string) => t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId }));
  const actor = await mkUser("user_actor");
  const otherManager = await mkUser("user_manager2");
  const sales1 = await mkUser("user_sales1");
  const sales2 = await mkUser("user_sales2");
  const foreignManager = await mkUser("user_foreign");
  const join = (userId: Id<"users">, roleId: Id<"roles">, org: Id<"organizations">) =>
    t.run((ctx) => ctx.db.insert("memberships", { orgId: org, userId, roleId }));
  await join(actor, managerRole, orgId);
  await join(otherManager, managerRole, orgId);
  await join(sales1, salesRole, orgId);
  await join(sales2, salesRole, orgId);
  await join(foreignManager, otherRole, otherOrgId);

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" }));
  const members: Member[] = [
    { userId: actor, isManager: true },
    { userId: otherManager, isManager: true },
    { userId: sales1, isManager: false },
    { userId: sales2, isManager: false },
  ];
  const asActor = t.withIdentity({ subject: "user_actor" });
  return { t, orgId, actor, sales1, sales2, customerId, members, asActor };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** Rows the action created, across the whole deployment, so another org's rows are visible too. */
async function observe(c: Ctx, action: () => Promise<unknown>): Promise<Effect[]> {
  const ids = async () => new Set((await c.t.run((ctx) => ctx.db.query("notifications").take(1000))).map((n) => n._id));
  const before = await ids();
  await action();
  const after = await c.t.run((ctx) => ctx.db.query("notifications").take(1000));
  return after.filter((n) => !before.has(n._id)).map((n) => ({ userId: n.userId, type: n.type ?? "" }));
}

/** The three mutations every test drives, so the arguments are written once. */
const createLead = (c: Ctx, extra: { assignedUserId?: Id<"users">; notes?: string } = {}) =>
  c.asActor.mutation(api.leads.create, { orgId: c.orgId, customerId: c.customerId, source: "Walk-in", ...extra });
const updateLead = (c: Ctx, leadId: Id<"leads">, extra: { assignedUserId?: Id<"users">; notes?: string }) =>
  c.asActor.mutation(api.leads.update, { orgId: c.orgId, leadId, ...extra });

/** The table's row for an action, with the assignee template resolved. */
function expectationsFor(action: string, assignee?: Id<"users">): Expectation[] {
  const row = ACTION_EXPECTATIONS.find((a) => a.action === action);
  if (!row) throw new Error(`no ACTION_EXPECTATIONS row for ${action}`);
  return row.effects.map((e) => {
    if (e.audience.kind !== "assignee") return { type: e.type, audience: e.audience };
    if (!assignee) throw new Error(`${action} needs an assignee`);
    return { type: e.type, audience: { kind: "user", userId: assignee } };
  });
}

/** Judge against every type that appeared, so a stray notification of ANY type is `unexpected`. */
const judge = (c: Ctx, action: string, observed: Effect[], assignee?: Id<"users">) =>
  judgeEffects(expectationsFor(action, assignee), observed, c.members, c.actor, [
    ...new Set([...expectationsFor(action, assignee).map((e) => e.type), ...observed.map((o) => o.type)]),
  ]);

describe("lead actions produce exactly the notifications they promise (SCRUM-620)", () => {
  test("lead.create notifies every manager once, and nobody else", async () => {
    const c = await setup();
    const observed = await observe(c, () => createLead(c));
    expect(judge(c, "lead.create", observed)).toEqual([]);
  });

  test("lead.create with an assignee also notifies that assignee once", async () => {
    const c = await setup();
    const observed = await observe(c, () =>
      createLead(c, { assignedUserId: c.sales1 }),
    );
    expect(judge(c, "lead.create+assign", observed, c.sales1)).toEqual([]);
  });

  test("lead.update notifies managers, not the assignee, when nothing is reassigned", async () => {
    const c = await setup();
    const leadId = await createLead(c, { assignedUserId: c.sales1 });
    const observed = await observe(c, () => updateLead(c, leadId, { notes: "called back" }));
    expect(judge(c, "lead.update", observed)).toEqual([]);
  });

  test("re-saving with the SAME assignee does not notify the assignee again", async () => {
    const c = await setup();
    const leadId = await createLead(c, { assignedUserId: c.sales1 });
    // The edit dialog resubmits every field on every save, assignee included.
    const observed = await observe(c, () => updateLead(c, leadId, { assignedUserId: c.sales1, notes: "resaved" }));
    expect(judge(c, "lead.update", observed)).toEqual([]);
  });

  test("lead.reassign notifies managers and the NEW assignee only", async () => {
    const c = await setup();
    const leadId = await createLead(c, { assignedUserId: c.sales1 });
    const observed = await observe(c, () => updateLead(c, leadId, { assignedUserId: c.sales2 }));
    expect(judge(c, "lead.reassign", observed, c.sales2)).toEqual([]);
  });

  test("a no-op save notifies nobody", async () => {
    const c = await setup();
    const leadId = await createLead(c, { notes: "same" });
    const observed = await observe(c, () => updateLead(c, leadId, { notes: "same" }));
    expect(judgeEffects([{ type: "lead.updated", audience: { kind: "none" } }], observed, c.members, c.actor, ["lead.updated", "lead.assigned"])).toEqual([]);
    expect(observed).toEqual([]);
  });

  test("lead.delete notifies every manager once", async () => {
    const c = await setup();
    const leadId = await createLead(c);
    const observed = await observe(c, () => c.asActor.mutation(api.leads.softDelete, { orgId: c.orgId, leadId }));
    expect(judge(c, "lead.delete", observed)).toEqual([]);
  });

  test("the oracle flags a duplicate, a missing recipient, and a leak to another organization", async () => {
    const c = await setup();
    const real = await observe(c, () => createLead(c));
    const foreign = await c.t.run(async (ctx) => (await ctx.db.query("users").take(1000)).find((u) => u.clerkId === "user_foreign")!._id);
    const doubled = judge(c, "lead.create", [...real, real[0]]);
    expect(doubled.map((f) => f.kind)).toEqual(["duplicate"]);
    const dropped = judge(c, "lead.create", real.slice(1));
    expect(dropped.map((f) => f.kind)).toEqual(["missing"]);
    const leaked = judge(c, "lead.create", [...real, { userId: foreign, type: "lead.created" }]);
    expect(leaked.map((f) => f.kind)).toEqual(["unexpected"]);
  });
});
