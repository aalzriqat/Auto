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
import { supplierDueAlertJobName } from "./constants";

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
  /** The arguments this transaction ran with: the first is the sweep's, every later one is the previous transaction's own continuation. */
  args: { kind?: string; cursor?: string; recipientCursor?: string };
}

/** Runs one organisation's worker one transaction at a time, following its own scheduled continuations. */
async function driveOrganisation(t: T, orgId: Id<"organizations">): Promise<TransactionStep[]> {
  // Continuations scheduled by earlier transactions are not this chain's.
  const seen = new Set(await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => String(f._id))));
  const steps: TransactionStep[] = [];
  let args: Record<string, unknown> = { orgId, now: NOW };
  for (let i = 0; i < 60; i += 1) {
    const before = await counts(t);
    const result = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, args as never);
    const after = await counts(t);
    steps.push({
      sent: result.alerted,
      written: after.notifications - before.notifications + 2 * (after.idempotency - before.idempotency),
      args: args as TransactionStep["args"],
    });
    // The continuation is whichever function this chain schedules for the organisation (the worker
    // itself, or the action that runs it and reports its failure), so match on the shared name.
    const next = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => String(f.name).includes("OrgSupplierDueAlerts") && !seen.has(String(f._id))
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
  }, 120_000);
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
  }, 60_000);

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

async function addApplication(t: T, s: OrgSeed, fields: Record<string, unknown> = {}) {
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId: s.orgId, firstName: "Buyer", lastName: "A" }));
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", { orgId: s.orgId, name: "Bank", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 })
  );
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId, vehiclePrice: 12_000, downPayment: 2_000,
      totalFinancedAmount: 10_000, termMonths: 24, status: "DRAFT", companyId, createdBy: s.ownerId, createdAt: NOW,
    } as never)
  );
  return await t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId: s.orgId, customerId, vehicleId: s.vehicleId, companyId, quoteId, salespersonId: s.ownerId,
      status: "CLOSED", createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );
}

// PR #716 round 3 (R1). Round 2 skipped only ConvexError data faults. A stored date that is finite but
// outside the JavaScript Date range (+-8.64e15 ms, ECMAScript TimeClip,
// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-timeclip) made `Intl.DateTimeFormat`
// throw `RangeError: Invalid time value` from inside the worker, before it scheduled its continuation,
// so the organisation's later pages and kinds starved again, every day. Now every stored date the
// worker reads is checked for being renderable before it is formatted, and a bad one makes its row an
// unreadable row: skipped, logged, counted.
type DateFieldCase = {
  name: string;
  kind: "PAYABLE" | "RECEIVABLE" | "RECOVERY";
  seed: (t: T, s: OrgSeed, stored: number) => Promise<unknown>;
};

const DATE_FIELD_CASES: DateFieldCase[] = [
  { name: "a payable's paymentDueDate", kind: "PAYABLE", seed: (t, s, stored) => addPayable(t, s, { paymentDueDate: stored }) },
  {
    name: "a receivable's agreedDueDate",
    kind: "RECEIVABLE",
    seed: async (t, s, stored) => addReceivable(t, s, await addSale(t, s), { agreedDueDate: stored }),
  },
  { name: "a cost recovery's agreedDueDate", kind: "RECOVERY", seed: (t, s, stored) => addRecovery(t, s, { agreedDueDate: stored }) },
  {
    name: "the handover instant of a receivable's deal",
    kind: "RECEIVABLE",
    seed: async (t, s, stored) => {
      const applicationId = await addApplication(t, s, { handoverStatus: "HANDED_OVER", vehicleHandoverAt: stored });
      return addReceivable(t, s, await addSale(t, s, { applicationId }));
    },
  },
  {
    name: "the financier funding instant of a payable's deal",
    kind: "PAYABLE",
    seed: async (t, s, stored) => {
      const applicationId = await addApplication(t, s, {
        quoteModeAtSubmission: "CONFIGURED_FINANCE_COMPANY", disbursedAt: stored, disbursedAmountMinor: 9_000_000, settlementStatus: "FULLY_SETTLED",
      });
      const saleId = await addSale(t, s, { supplierSettlementRoute: "THROUGH_DEALERSHIP", financingType: "FINANCED", applicationId });
      return addPayable(t, s, { saleId });
    },
  },
];

const UNRENDERABLE_DATES: Array<[string, number]> = [
  ["1e20", 1e20],
  ["-1e20", -1e20],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
];

describe("SCRUM-869 S8 - a stored date that cannot be rendered is an unreadable row", () => {
  for (const field of DATE_FIELD_CASES) {
    for (const [label, stored] of UNRENDERABLE_DATES) {
      test(`${field.name} = ${label} is skipped and counted, not thrown`, async () => {
        const t = newHarness();
        const s = await seedOrg(t, "d1");
        await field.seed(t, s, stored);
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          const result = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW, kind: field.kind });
          expect(result).toEqual({ alerted: 0, skipped: 1 });
          expect(spy.mock.calls.filter((call) => /unreadable/i.test(String(call[0])))).toHaveLength(1);
        } finally {
          spy.mockRestore();
        }
        expect(await alerts(t)).toHaveLength(0);
      });
    }
  }

  test("the last instant a Date can hold is still a date, and one millisecond past it is not", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "d2");
    const MAX_DATE_MS = 8.64e15;
    await addPayable(t, s, { paymentDueDate: MAX_DATE_MS, amountDue: 10 });
    await addPayable(t, s, { paymentDueDate: MAX_DATE_MS + 1, amountDue: 20 });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW, kind: "PAYABLE" });
      expect(result).toEqual({ alerted: 0, skipped: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  test("bad dates in every field starve nothing: later rows, pages, kinds and other organisations are still alerted", async () => {
    const t = newHarness();
    const bad = await seedOrg(t, "d3");
    const other = await seedOrg(t, "d4");
    // One unrenderable row of each date field first, then more than a page of good payables behind them.
    for (const field of DATE_FIELD_CASES) await field.seed(t, bad, 1e20);
    for (let i = 0; i < 52; i += 1) await addPayable(t, bad, { paymentDueDate: NOW, amountDue: 10 + i });
    await addReceivable(t, bad, await addSale(t, bad), { agreedDueDate: NOW });
    await addRecovery(t, bad, { agreedDueDate: NOW });
    await addPayable(t, other, { paymentDueDate: NOW });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await sweep(t);
      expect(spy.mock.calls.filter((call) => /unreadable/i.test(String(call[0])))).toHaveLength(DATE_FIELD_CASES.length);
    } finally {
      spy.mockRestore();
    }
    const rows = await alerts(t);
    expect(rows.filter((r) => r.orgId === bad.orgId)).toHaveLength((52 + 1 + 1) * 3);
    expect(rows.filter((r) => r.orgId === other.orgId)).toHaveLength(3);
  });

  test("an ordinary programming error is still not swallowed", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "d5");
    await addPayable(t, s, { paymentDueDate: NOW });
    await expect(
      withNotificationFault(1, () => t.mutation(internal.supplierDueAlerts.processOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW }))
    ).rejects.toThrow(/injected fault/);
  });
});

// PR #716 round 3 (R2, Seat 1 mutant M3). Nothing pinned the obligation-page x recipient-cursor
// boundary: a continuation that kept the recipient cursor across an obligation page, or reused its own
// recipient cursor, scheduled continuations for ever (every day) and the suite still passed.
describe("SCRUM-869 S8 - the obligation page and recipient cursor boundary", () => {
  test("100 payables x 23 recipients: every (obligation, recipient) once, the cursor resets per page, the chain ends, a replay sends nothing", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "b1");
    const financeRole = await addRole(t, s.orgId, "Finance team b1", ["view:finance"]);
    await addManyMembers(t, s.orgId, financeRole, "b1m", 20);
    for (let i = 0; i < 100; i += 1) await addPayable(t, s, { paymentDueDate: NOW, amountDue: 10 + i });
    const recipientCount = 23;

    const steps = await driveOrganisation(t, s.orgId);

    // The chain ends: a bounded number of transactions (the driver itself refuses after 60).
    expect(steps.length).toBeGreaterThan(2);
    expect(steps.length).toBeLessThanOrEqual(12);

    // Each (obligation, step, occurrence, recipient) is sent exactly once.
    const rows = await alerts(t);
    expect(rows).toHaveLength(100 * recipientCount);
    const pairs = rows.map((r) => `${String(r.userId)}|${String(r.data?.amount)}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(new Set(rows.map((r) => String(r.userId))).size).toBe(recipientCount);
    expect(steps.reduce((sum, step) => sum + step.sent, 0)).toBe(100 * recipientCount);
    const idempotencyKeys = await t.run(async (ctx) =>
      (await ctx.db.query("commandIdempotency").collect()).map((r) => String((r as { idempotencyKey?: string }).idempotencyKey))
    );
    expect(new Set(idempotencyKeys).size).toBe(idempotencyKeys.length);

    // The recipient cursor advances inside an obligation page and resets when the obligation page (or kind) changes.
    expect(steps[0].args.recipientCursor).toBeUndefined();
    let recipientHops = 0;
    for (let i = 1; i < steps.length; i += 1) {
      const before = steps[i - 1].args;
      const now = steps[i].args;
      // The sweep's own first call names no kind: it starts with the first one.
      const samePage = (now.kind ?? "PAYABLE") === (before.kind ?? "PAYABLE") && now.cursor === before.cursor;
      if (samePage) {
        expect(now.recipientCursor).toBeDefined();
        expect(now.recipientCursor).not.toBe(before.recipientCursor);
        recipientHops += 1;
      } else {
        expect(now.recipientCursor).toBeUndefined();
      }
    }
    expect(recipientHops).toBeGreaterThan(0);
    // The second obligation page was reached with a fresh recipient cursor.
    expect(steps.some((step) => step.args.cursor !== undefined && step.args.recipientCursor === undefined)).toBe(true);

    // A replay (the next sweep the same day) walks the same chain, sends nothing, and also ends.
    const replay = await driveOrganisation(t, s.orgId);
    expect(replay.reduce((sum, step) => sum + step.sent, 0)).toBe(0);
    expect(replay.length).toBe(steps.length);
    expect(await alerts(t)).toHaveLength(100 * recipientCount);
  }, 120_000);
});

async function withNotificationFault<R>(failOnRead: number, run: () => Promise<R>): Promise<R> {
  const def = NOTIFICATION_TYPES["accounting.supplierObligationDue"] as unknown as { category: string };
  let reads = 0;
  Object.defineProperty(def, "category", {
    configurable: true,
    get() {
      reads += 1;
      if (reads === failOnRead) throw new Error("injected fault");
      return "finance";
    },
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(def, "category", { configurable: true, writable: true, value: "finance" });
  }
}

const heartbeatsFor = (t: T, orgId: Id<"organizations">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("cronHeartbeats").collect()).filter((row) => row.jobName === supplierDueAlertJobName(orgId))
  );

// PR #716 round 3 (R3). A worker that throws rolls back and drops its own continuation, and it cannot
// record its own failure (that write rolls back with it). The action that runs it can: it reports the
// failure from a separate transaction, into the existing `cronHeartbeats` table (no new table), under
// a per-organisation job name so another organisation's success never hides this one's failure.
describe("SCRUM-869 S8 - a worker failure leaves a durable, actionable signal", () => {
  test("a failed worker records one failure heartbeat naming the organisation, kind and cursor, and rolls its writes back", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h1");
    for (let i = 0; i < 51; i += 1) await addPayable(t, s, { paymentDueDate: NOW, amountDue: 10 + i });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // The first page (50 payables x 3 recipients = 150 sends) commits; the second page's first send faults.
      await withNotificationFault(151, async () => {
        await t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW });
        await drain(t);
      });
    } finally {
      spy.mockRestore();
    }
    expect(await alerts(t)).toHaveLength(150);
    const rows = await heartbeatsFor(t, s.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(false);
    const detail = rows[0].detail ?? "";
    expect(detail).toContain(String(s.orgId));
    expect(detail).toContain("PAYABLE");
    expect(detail).toMatch(/cursor=\S{5,}/);
    expect(detail).toContain("injected fault");
    expect(detail.length).toBeLessThanOrEqual(1_000);
  });

  test("a later successful run supersedes the failure, and a clean run writes no heartbeat at all", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h2");
    await addPayable(t, s, { paymentDueDate: NOW });
    await sweep(t);
    expect(await heartbeatsFor(t, s.orgId)).toHaveLength(0);

    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withNotificationFault(1, async () => {
        await expect(t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW + DAY })).rejects.toThrow(/injected fault/);
      });
    } finally {
      spy.mockRestore();
    }
    // The action wrote the failure from its own transaction; it is the newest row.
    const failed = await heartbeatsFor(t, s.orgId);
    expect(failed.map((r) => r.success)).toEqual([false]);

    vi.setSystemTime(NOW + 2 * DAY);
    await t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW + 2 * DAY });
    await drain(t);
    const after = (await heartbeatsFor(t, s.orgId)).sort((a, b) => a.ranAt - b.ranAt);
    expect(after.map((r) => r.success)).toEqual([false, true]);
  });

  test("a repeated failure updates the one failure row instead of adding a row a day", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h3");
    await addPayable(t, s, { paymentDueDate: NOW });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const day of [0, 1, 2]) {
        vi.setSystemTime(NOW + day * DAY);
        await withNotificationFault(1, async () => {
          await expect(t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW + day * DAY })).rejects.toThrow(/injected fault/);
        });
      }
    } finally {
      spy.mockRestore();
    }
    const rows = await heartbeatsFor(t, s.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(false);
    expect(rows[0].ranAt).toBe(NOW + 2 * DAY);
  });

  test("one organisation's failure is recorded against it alone, and another organisation's success does not clear it", async () => {
    const t = newHarness();
    const bad = await seedOrg(t, "h4");
    const good = await seedOrg(t, "h5");
    await addPayable(t, bad, { paymentDueDate: NOW });
    await addPayable(t, good, { paymentDueDate: NOW });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withNotificationFault(1, async () => {
        await expect(t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: bad.orgId, now: NOW })).rejects.toThrow(/injected fault/);
      });
    } finally {
      spy.mockRestore();
    }
    await t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: good.orgId, now: NOW });
    await drain(t);
    expect((await heartbeatsFor(t, bad.orgId)).map((r) => r.success)).toEqual([false]);
    expect(await heartbeatsFor(t, good.orgId)).toHaveLength(0);
    expect((await alerts(t)).filter((r) => r.orgId === good.orgId)).toHaveLength(3);
  });

  test("the failure detail is bounded however long the error message is", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "h6");
    await addPayable(t, s, { paymentDueDate: NOW });
    const def = NOTIFICATION_TYPES["accounting.supplierObligationDue"] as unknown as { category: string };
    Object.defineProperty(def, "category", {
      configurable: true,
      get() {
        throw new Error("x".repeat(50_000));
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(t.action(internal.supplierDueAlerts.runOrgSupplierDueAlerts, { orgId: s.orgId, now: NOW })).rejects.toThrow();
    } finally {
      Object.defineProperty(def, "category", { configurable: true, writable: true, value: "finance" });
      spy.mockRestore();
    }
    const rows = await heartbeatsFor(t, s.orgId);
    expect(rows).toHaveLength(1);
    expect((rows[0].detail ?? "").length).toBeLessThanOrEqual(1_000);
  });
});