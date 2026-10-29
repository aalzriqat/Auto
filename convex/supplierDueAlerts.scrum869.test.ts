/**
 * SCRUM-869 S8 - in-app alerts for supplier obligations coming due or overdue.
 *
 * Owner ruling SCRUM-869#c23883 (OQ-1; the coordinator's Jira record of a chat ruling, not the
 * owner's own text): alert 3 days before the due date, on it, at 7 days overdue, then weekly;
 * in-app through the existing notification table; idempotent per obligation, step and occurrence;
 * tenant-scoped; recipients resolved on the server (Owner, Finance Manager, authorised accounting
 * staff); disputed and no-due-date obligations are suppressed.
 *
 * Evidence boundary: convex-test only (no runtime read limits, no OCC, no real scheduler clock).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOTIFICATION_TYPES } from "../lib/notifications/types";

const MODULES = import.meta.glob("./**/*.*s");
const DAY = 86_400_000;
// 2026-06-15 09:00 UTC = 12:00 in Amman (UTC+3).
const NOW = Date.parse("2026-06-15T09:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTestWithComponents>;

async function drain(t: T) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      return;
    } catch (error) {
      const exhausted = String((error as Error)?.message ?? error).includes("timer pumps");
      if (!exhausted || attempt >= 4) throw error;
    }
  }
}

function newHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  return convexTestWithComponents(schema, MODULES);
}

interface OrgSeed {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles">;
  ownerId: Id<"users">;
  financeId: Id<"users">;
  accountantId: Id<"users">;
  salesId: Id<"users">;
}

async function addMember(
  t: T,
  orgId: Id<"organizations">,
  tag: string,
  roleName: string,
  permissions: string[],
  role: Record<string, unknown> = {},
  membership: Record<string, unknown> = {}
) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_${roleName}`, email: `${tag}.${roleName}@e.com`, name: roleName }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: `${roleName} ${tag}`, permissions, ...role } as never));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId, ...membership } as never));
  return userId;
}

async function seedOrg(t: T, tag: string, plan: string = "professional"): Promise<OrgSeed> {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S8 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.insert("subscriptions", { orgId, plan, status: "active", createdAt: Date.now(), updatedAt: Date.now() } as never));
  const ownerId = await addMember(t, orgId, tag, "owner", [], { isSystemOwnerRole: true });
  const financeId = await addMember(t, orgId, tag, "finance", ["manage:finance"]);
  const accountantId = await addMember(t, orgId, tag, "accountant", ["view:finance"]);
  const salesId = await addMember(t, orgId, tag, "sales", ["view:sales"]);
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
    })
  );
  return { orgId, vehicleId, ownerId, financeId, accountantId, salesId };
}

const addPayable = (t: T, s: OrgSeed, fields: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, sourcedFromName: "Amman Importer Co", amountDue: 9_500, currency: "JOD",
      status: "DUE_ON_SALE", createdBy: s.ownerId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );

async function addSale(t: T, s: OrgSeed, fields: Record<string, unknown> = {}) {
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId: s.orgId, firstName: "Buyer", lastName: "B" }));
  return await t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId, salespersonId: s.ownerId,
      salePrice: 12_500, saleDate: NOW - 40 * DAY, status: "COMPLETED", ...fields,
    } as never)
  );
}

const addReceivable = (t: T, s: OrgSeed, saleId: Id<"sales">, fields: Record<string, unknown> = {}) =>
  t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, sourcedFromName: "Amman Importer Co", amountDue: 3_000,
      currency: "JOD", status: "OPEN", createdBy: s.ownerId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );

const addRecovery = (t: T, s: OrgSeed, fields: Record<string, unknown> = {}) =>
  t.run(async (ctx) => {
    const expenseId = await ctx.db.insert("expenses", {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport", amount: 200, date: NOW - DAY, category: "TRANSPORT", status: "PAID",
    } as never);
    return await ctx.db.insert("supplierCostRecoveries", {
      orgId: s.orgId, vehicleId: s.vehicleId, expenseId, sourceEventKey: `ev_${Math.random()}`,
      sourcedFromName: "Amman Importer Co", amountDueMinor: 200_000, amountRecoveredMinor: 0, currency: "JOD",
      receiptSeq: 0, status: "OPEN", createdBy: s.ownerId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never);
  });

async function sweep(t: T, now: number = NOW) {
  vi.setSystemTime(now);
  await t.mutation(internal.supplierDueAlerts.processSupplierDueAlerts, { now });
  await drain(t);
}

interface Alert {
  userId: Id<"users">;
  orgId: Id<"organizations">;
  type: string;
  category: string;
  isRead: boolean;
  data?: Record<string, string | number>;
  link?: string;
}

const alerts = (t: T): Promise<Alert[]> =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query("notifications").collect();
    return rows.filter((r) => String(r.type).startsWith("accounting.supplierObligation")) as unknown as Alert[];
  });

const recipients = (rows: Alert[]) => rows.map((r) => String(r.userId)).sort();

describe("SCRUM-869 S8 - schedule and content", () => {
  test("an obligation due in 3 days alerts each authorised recipient once, in-app", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "a1");
    await addPayable(t, s, { paymentDueDate: NOW + 3 * DAY });
    await sweep(t);
    const rows = await alerts(t);
    expect(recipients(rows)).toEqual([s.ownerId, s.financeId, s.accountantId].map(String).sort());
    expect(rows[0]).toMatchObject({ orgId: s.orgId, type: "accounting.supplierObligationDue", category: "finance", isRead: false });
    expect(rows[0].data).toMatchObject({ currency: "JOD", dueDate: "2026-06-18", amount: "9500.000" });
    expect(rows[0].link).toContain(String(s.orgId));
  });

  test("a run sends only the latest step reached, once, as the days pass", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "a2");
    const due = Date.parse("2026-06-01T09:00:00Z");
    await addPayable(t, s, { paymentDueDate: due });
    const fired: Record<number, number> = {};
    let before = 0;
    for (const offset of [-4, -3, -2, 0, 1, 6, 7, 8, 14, 15, 21]) {
      await sweep(t, due + offset * DAY);
      const total = (await alerts(t)).length;
      fired[offset] = total - before;
      before = total;
    }
    const per = 3;
    expect(fired).toEqual({ [-4]: 0, [-3]: per, [-2]: 0, 0: per, 1: 0, 6: 0, 7: per, 8: 0, 14: per, 15: 0, 21: per });
    const types = (await alerts(t)).map((r) => r.type);
    expect(new Set(types)).toEqual(new Set(["accounting.supplierObligationDue", "accounting.supplierObligationOverdue"]));
  });

  test("a cron that skipped the due date sends the due alert on the next run", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h1");
    const due = Date.parse("2026-06-01T09:00:00Z");
    await addPayable(t, s, { paymentDueDate: due });
    await sweep(t, due - 3 * DAY);
    expect(await alerts(t)).toHaveLength(3);
    await sweep(t, due + DAY);
    const rows = await alerts(t);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.data?.dueDate === "2026-06-01" && r.type === "accounting.supplierObligationDue")).toHaveLength(6);
    await sweep(t, due + DAY);
    await sweep(t, due + 2 * DAY);
    expect(await alerts(t)).toHaveLength(6);
  });

  test("a gap past day 7 sends the day-7 alert once and none of the earlier skipped steps", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h2");
    const due = Date.parse("2026-06-01T09:00:00Z");
    await addPayable(t, s, { paymentDueDate: due });
    await sweep(t, due - 3 * DAY);
    await sweep(t, due + 6 * DAY);
    expect(await alerts(t)).toHaveLength(6);
    await sweep(t, due + 10 * DAY);
    const rows = await alerts(t);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.type === "accounting.supplierObligationOverdue")).toHaveLength(3);
    await sweep(t, due + 10 * DAY);
    expect(await alerts(t)).toHaveLength(9);
  });

  test("an obligation first seen late gets the single latest step, not the skipped ones", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h3");
    const due = Date.parse("2026-06-01T09:00:00Z");
    await addPayable(t, s, { paymentDueDate: due });
    await sweep(t, due + 10 * DAY);
    const rows = await alerts(t);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.type === "accounting.supplierObligationOverdue")).toBe(true);
  });

  test("a weekly occurrence missed by two days is sent once, and the next one on time", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h4");
    const due = Date.parse("2026-06-01T09:00:00Z");
    await addPayable(t, s, { paymentDueDate: due });
    await sweep(t, due + 7 * DAY);
    expect(await alerts(t)).toHaveLength(3);
    await sweep(t, due + 16 * DAY);
    expect(await alerts(t)).toHaveLength(6);
    await sweep(t, due + 16 * DAY);
    await sweep(t, due + 17 * DAY);
    expect(await alerts(t)).toHaveLength(6);
    await sweep(t, due + 21 * DAY);
    expect(await alerts(t)).toHaveLength(9);
  });
  test("a receivable with recorded delivery and a cost recovery with an agreed date alert on their schedule", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "a3");
    const saleId = await addSale(t, s);
    await addReceivable(t, s, saleId, { agreedDueDate: NOW });
    await addRecovery(t, s, { agreedDueDate: NOW });
    await sweep(t);
    const rows = await alerts(t);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.data?.amount))).toEqual(new Set(["3000.000", "200.000"]));
  });
});

describe("SCRUM-869 S8 - idempotency", () => {
  test("running the sweep twice on the same day does not duplicate any alert", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "b1");
    await addPayable(t, s, { paymentDueDate: NOW });
    await sweep(t);
    await sweep(t);
    await sweep(t, NOW + 60_000);
    expect(await alerts(t)).toHaveLength(3);
  });

  test("two obligations alert separately, and a later step of the same obligation alerts again", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "b2");
    await addPayable(t, s, { paymentDueDate: NOW + 3 * DAY });
    await addPayable(t, s, { paymentDueDate: NOW + 3 * DAY, amountDue: 100 });
    await sweep(t);
    expect(await alerts(t)).toHaveLength(6);
    await sweep(t, NOW + 3 * DAY);
    expect(await alerts(t)).toHaveLength(12);
  });
});

  test("the sweep uses the day it is given, not the clock of whichever continuation runs it", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "b3");
    await addPayable(t, s, { paymentDueDate: NOW });
    vi.setSystemTime(NOW + 10 * DAY);
    await t.mutation(internal.supplierDueAlerts.processSupplierDueAlerts, { now: NOW });
    await drain(t);
    const rows = await alerts(t);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.type === "accounting.supplierObligationDue")).toBe(true);
  });
describe("SCRUM-869 S8 - tenant isolation and recipients", () => {
  test("an organisation's alerts reach only its own members", async () => {
    const t = newHarness();
    const a = await seedOrg(t, "c1");
    const b = await seedOrg(t, "c2");
    await addPayable(t, a, { paymentDueDate: NOW });
    await sweep(t);
    const rows = await alerts(t);
    expect(rows.every((r) => r.orgId === a.orgId)).toBe(true);
    const bUsers = new Set([b.ownerId, b.financeId, b.accountantId, b.salesId].map(String));
    expect(rows.some((r) => bUsers.has(String(r.userId)))).toBe(false);
  });

  test("two organisations each alert their own members for their own obligations", async () => {
    const t = newHarness();
    const a = await seedOrg(t, "c3");
    const b = await seedOrg(t, "c4");
    await addPayable(t, a, { paymentDueDate: NOW });
    await addPayable(t, b, { paymentDueDate: NOW, amountDue: 700 });
    await sweep(t);
    const rows = await alerts(t);
    expect(rows.filter((r) => r.orgId === a.orgId)).toHaveLength(3);
    expect(rows.filter((r) => r.orgId === b.orgId)).toHaveLength(3);
    expect(rows.filter((r) => r.orgId === b.orgId).every((r) => r.data?.amount === "700.000")).toBe(true);
  });

  test("a member without finance access, and an offboarding member, get nothing", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "c5");
    const leaving = await addMember(t, s.orgId, "c5", "leaving", ["manage:finance"], {}, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
    await addPayable(t, s, { paymentDueDate: NOW });
    await sweep(t);
    const got = recipients(await alerts(t));
    expect(got).not.toContain(String(s.salesId));
    expect(got).not.toContain(String(leaving));
    expect(got).toHaveLength(3);
  });

  test("a role that belongs to another organisation grants nothing", async () => {
    const t = newHarness();
    const a = await seedOrg(t, "c7");
    const b = await seedOrg(t, "c8");
    const stranger = await t.run((ctx) => ctx.db.insert("users", { clerkId: "c7_stranger", email: "c7.stranger@e.com", name: "Stranger" }));
    const financeRoleOfB = await t.run(async (ctx) => (await ctx.db.get((await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", b.orgId)).first())!.roleId))!._id);
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: a.orgId, userId: stranger, roleId: financeRoleOfB } as never));
    await addPayable(t, a, { paymentDueDate: NOW });
    await sweep(t);
    expect(recipients(await alerts(t))).not.toContain(String(stranger));
  });
  test("an organisation whose plan has no accounting is not alerted", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "c6", "free");
    await addPayable(t, s, { paymentDueDate: NOW });
    await sweep(t);
    expect(await alerts(t)).toHaveLength(0);
  });
});

describe("SCRUM-869 S8 - suppression", () => {
  test("no due date is never alerted, however old the sale", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "d1");
    const saleId = await addSale(t, s, { supplierSettlementRoute: "THROUGH_DEALERSHIP", saleDate: NOW - 400 * DAY });
    await addPayable(t, s, { saleId });
    await addPayable(t, s, {});
    const sale2 = await addSale(t, s);
    await addReceivable(t, s, sale2);
    await addRecovery(t, s);
    await sweep(t);
    await sweep(t, NOW + 7 * DAY);
    await sweep(t, NOW + 14 * DAY);
    expect(await alerts(t)).toHaveLength(0);
  });

  test("a disputed obligation is not alerted", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "d2");
    await addPayable(t, s, { status: "DISPUTED", paymentDueDate: NOW });
    const saleId = await addSale(t, s);
    await addReceivable(t, s, saleId, { status: "DISPUTED", agreedDueDate: NOW });
    await sweep(t);
    expect(await alerts(t)).toHaveLength(0);
  });

  test("settled and cancelled obligations are not alerted", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "d3");
    await addPayable(t, s, { paymentDueDate: NOW, status: "PAID", amountPaid: 9_500 });
    await addPayable(t, s, { paymentDueDate: NOW, status: "CANCELLED" });
    await sweep(t);
    expect(await alerts(t)).toHaveLength(0);
  });
});

describe("SCRUM-869 S8 - channels, bounds and failure isolation", () => {
  test("the sweep schedules no email, WhatsApp or push delivery", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "e1");
    await addPayable(t, s, { paymentDueDate: NOW });
    await t.mutation(internal.supplierDueAlerts.processSupplierDueAlerts, { now: NOW });
    const names = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => String(f.name))
    );
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !n.startsWith("supplierDueAlerts"))).toEqual([]);
    await drain(t);
    const afterDrain = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => String(f.name))
    );
    expect(afterDrain.filter((n) => /email|whatsapp|push/i.test(n))).toEqual([]);
  });

  test("more obligations than one page are all alerted", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "e2");
    for (let i = 0; i < 53; i += 1) await addPayable(t, s, { paymentDueDate: NOW, amountDue: 10 + i });
    await sweep(t);
    expect(await alerts(t)).toHaveLength(53 * 3);
  });

  test("more organisations than one batch are all swept", async () => {
    const t = newHarness();
    const seeds: OrgSeed[] = [];
    for (let i = 0; i < 22; i += 1) {
      const s = await seedOrg(t, `f${i}`);
      seeds.push(s);
      await addPayable(t, s, { paymentDueDate: NOW });
    }
    await sweep(t);
    const rows = await alerts(t);
    expect(new Set(rows.map((r) => String(r.orgId))).size).toBe(22);
  });

  // PR #716 round 2 (P1-A). The worker used to catch its own failure and return normally, which makes
  // Convex COMMIT everything written before the throw and also drops the continuation, so one bad row
  // starved every later page of its organisation, every day. Now an unreadable row is skipped with a log
  // line BEFORE any write, and any other failure throws so the whole mutation rolls back.
  test("an unreadable row is skipped and reported, not thrown", async () => {
    const t = newHarness();
    const bad = await seedOrg(t, "g3");
    await addPayable(t, bad, { paymentDueDate: NOW, currency: "XXX" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: bad.orgId, now: NOW });
    spy.mockRestore();
    expect(result).toEqual({ alerted: 0, skipped: 1 });
    expect(await alerts(t)).toHaveLength(0);
  });

  test("one unreadable row does not starve the rest of its page, its later pages or its later kinds", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "g4");
    await addPayable(t, s, { paymentDueDate: NOW, currency: "XXX", amountDue: 1 });
    for (let i = 0; i < 52; i += 1) await addPayable(t, s, { paymentDueDate: NOW, amountDue: 10 + i });
    const saleId = await addSale(t, s);
    await addReceivable(t, s, saleId, { agreedDueDate: NOW });
    // A cost recovery's amounts are already minor units, so only the alert's own formatting can see this one.
    await addRecovery(t, s, { agreedDueDate: NOW, currency: "XXX", amountDueMinor: 100 });
    await addRecovery(t, s, { agreedDueDate: NOW });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sweep(t);
    const unreadable = spy.mock.calls.filter((call) => /unreadable/i.test(String(call[0])));
    spy.mockRestore();
    expect(unreadable).toHaveLength(2);
    const rows = await alerts(t);
    expect(rows).toHaveLength((52 + 1 + 1) * 3);
    expect(rows.some((r) => r.data?.currency === "XXX")).toBe(false);
  });

  test("one organisation with an unreadable row does not stop the others", async () => {
    const t = newHarness();
    const bad = await seedOrg(t, "g1");
    const good = await seedOrg(t, "g2");
    await addPayable(t, bad, { paymentDueDate: NOW, currency: "XXX" });
    await addPayable(t, good, { paymentDueDate: NOW });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sweep(t);
    spy.mockRestore();
    const rows = await alerts(t);
    expect(rows.filter((r) => r.orgId === good.orgId)).toHaveLength(3);
    expect(rows.filter((r) => r.orgId === bad.orgId)).toHaveLength(0);
  });

  test("a fault after earlier writes rolls the whole worker back, and the retry sends everything once", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "p1");
    await addPayable(t, s, { paymentDueDate: NOW, amountDue: 10 });
    await addPayable(t, s, { paymentDueDate: NOW, amountDue: 20 });
    // Fault on the second notification insert (the shape Seat 2 injected in round 1): the insert reads
    // the notification type's category, so the second read throws.
    const def = NOTIFICATION_TYPES["accounting.supplierObligationDue"] as unknown as { category: string };
    let reads = 0;
    Object.defineProperty(def, "category", {
      configurable: true,
      get() {
        reads += 1;
        if (reads === 2) throw new Error("injected fault");
        return "finance";
      },
    });
    try {
      await expect(
        t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW })
      ).rejects.toThrow(/injected fault/);
    } finally {
      Object.defineProperty(def, "category", { configurable: true, writable: true, value: "finance" });
    }
    expect(await counts(t)).toEqual({ notifications: 0, idempotency: 0 });
    const retry = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW });
    expect(retry.alerted).toBe(6);
    expect(await alerts(t)).toHaveLength(6);
  });
});

describe("SCRUM-869 S8 - what the worker reports", () => {
  test("alerted counts only new sends: a replay reports zero", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "r1");
    await addPayable(t, s, { paymentDueDate: NOW });
    const first = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW });
    expect(first.alerted).toBe(3);
    const replay = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW });
    expect(replay.alerted).toBe(0);
    expect(await alerts(t)).toHaveLength(3);
  });
});

const counts = (t: T) =>
  t.run(async (ctx) => ({
    notifications: (await ctx.db.query("notifications").collect()).length,
    idempotency: (await ctx.db.query("commandIdempotency").collect()).length,
  }));

interface TransactionStep {
  sent: number;
  /** Documents written by this one worker transaction: notification inserts, plus the STARTED insert and the COMPLETED patch of each idempotency record. */
  written: number;
}

/** Runs one organisation's worker one transaction at a time, following its own scheduled continuations. */
async function driveOrganisation(t: T, orgId: Id<"organizations">): Promise<TransactionStep[]> {
  const seen = new Set<string>();
  const steps: TransactionStep[] = [];
  let args: Record<string, unknown> = { orgId, now: NOW };
  for (let i = 0; i < 400; i += 1) {
    const before = await counts(t);
    const result = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, args as never);
    const after = await counts(t);
    steps.push({
      sent: result.alerted,
      written: after.notifications - before.notifications + 2 * (after.idempotency - before.idempotency),
    });
    const next = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => String(f.name).includes("processOrgSupplierDueAlerts") && !seen.has(String(f._id))
      )
    );
    for (const f of next) seen.add(String(f._id));
    if (next.length === 0) return steps;
    expect(next).toHaveLength(1);
    args = next[0].args[0] as Record<string, unknown>;
  }
  throw new Error("the worker never stopped scheduling continuations");
}

async function addRole(t: T, orgId: Id<"organizations">, name: string, permissions: string[]) {
  return await t.run((ctx) => ctx.db.insert("roles", { orgId, name, permissions } as never));
}

async function addManyMembers(t: T, orgId: Id<"organizations">, roleId: Id<"roles">, tag: string, count: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      const userId = await ctx.db.insert("users", { clerkId: `${tag}_${i}`, email: `${tag}.${i}@e.com`, name: `${tag} ${i}` });
      await ctx.db.insert("memberships", { orgId, userId, roleId } as never);
    }
  });
}

// PR #716 round 2 (P1-B). Every obligation fanned out to every recipient inside one transaction, so
// 50 obligations x 320 recipients is 16,000 notification inserts plus the idempotency records, past
// Convex's 16,000 documents-written limit (https://docs.convex.dev/production/state/limits). The test
// threshold below is deliberately independent of the implementation's own budget constant.
describe("SCRUM-869 S8 - writes per transaction stay bounded however many recipients there are", () => {
  const WRITES_CEILING = 1_500;

  test("600 extra recipients and 3 obligations: no transaction writes past the ceiling, and each recipient is told once per obligation", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "w1");
    const financeRole = await addRole(t, s.orgId, "Finance team w1", ["view:finance"]);
    await addManyMembers(t, s.orgId, financeRole, "w1m", 600);
    for (const amountDue of [10, 20, 30]) await addPayable(t, s, { paymentDueDate: NOW, amountDue });

    const steps = await driveOrganisation(t, s.orgId);
    expect(steps.length).toBeGreaterThan(1);
    for (const step of steps) expect(step.written).toBeLessThanOrEqual(WRITES_CEILING);

    const rows = await alerts(t);
    const recipientCount = 603;
    expect(rows).toHaveLength(recipientCount * 3);
    const amountsByUser = new Map<string, string[]>();
    for (const r of rows) amountsByUser.set(String(r.userId), [...(amountsByUser.get(String(r.userId)) ?? []), String(r.data?.amount)]);
    expect(amountsByUser.size).toBe(recipientCount);
    for (const amounts of amountsByUser.values()) expect(amounts.sort()).toEqual(["10.000", "20.000", "30.000"]);
    expect(steps.reduce((sum, step) => sum + step.sent, 0)).toBe(recipientCount * 3);

    // Replaying the whole chain (the next sweep the same day) adds nothing and reports nothing new.
    const replay = await driveOrganisation(t, s.orgId);
    expect(replay.reduce((sum, step) => sum + step.sent, 0)).toBe(0);
    expect(await alerts(t)).toHaveLength(recipientCount * 3);
  });
});

// PR #716 round 2 (P2). Recipients were read with `.take(1000)` and no continuation: the 1,001st
// membership, if it was the only finance one, was never told, and the idempotency record still said
// COMPLETED.
describe("SCRUM-869 S8 - recipients beyond the first thousand memberships", () => {
  test("a finance member who is the 1,005th membership is still alerted", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "m1");
    const salesRole = await addRole(t, s.orgId, "Sales team m1", ["view:sales"]);
    await addManyMembers(t, s.orgId, salesRole, "m1s", 1_000);
    const lateFinance = await addMember(t, s.orgId, "m1", "latefinance", ["view:finance"]);
    await addPayable(t, s, { paymentDueDate: NOW });
    await sweep(t);
    expect(recipients(await alerts(t))).toEqual([s.ownerId, s.financeId, s.accountantId, lateFinance].map(String).sort());
  });

  test("a disabled user and a super-admin impersonation membership are not alerted", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "m2");
    const disabled = await addMember(t, s.orgId, "m2", "disabled", ["manage:finance"]);
    await t.run((ctx) => ctx.db.patch(disabled, { disabled: true, disabledAt: NOW }));
    const impersonator = await t.run(async (ctx) => {
      const actor = await ctx.db.insert("users", { clerkId: "m2_actor", email: "m2.actor@e.com", name: "Super admin" });
      const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "Copied finance role", permissions: ["manage:finance"] } as never);
      const membershipId = await ctx.db.insert("memberships", { orgId: s.orgId, userId: actor, roleId } as never);
      const grantId = await ctx.db.insert("impersonationGrants", {
        actorUserId: actor, targetUserId: s.financeId, orgId: s.orgId, membershipId, reason: "support", grantedAt: NOW, expiresAt: NOW + DAY,
      });
      await ctx.db.patch(membershipId, { impersonationGrantId: grantId });
      return actor;
    });
    await addPayable(t, s, { paymentDueDate: NOW });
    await sweep(t);
    const got = recipients(await alerts(t));
    expect(got).not.toContain(String(disabled));
    expect(got).not.toContain(String(impersonator));
    expect(got).toEqual([s.ownerId, s.financeId, s.accountantId].map(String).sort());
  });
});
