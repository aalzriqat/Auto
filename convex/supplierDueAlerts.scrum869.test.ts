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
  const financeId = await addMember(t, orgId, tag, "finance", ["manage:finance", "view:finance"]);
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
  await t.mutation(internal.supplierDueAlerts.processSupplierDueAlerts as never, { now } as never);
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

  test("only the exact schedule days alert: 4, 3, 2, 1 days before, the due day, 6/7/8 and 14/15 days after", async () => {
    const t = newHarness();
    const s = await seedOrg(t, "a2");
    const due = Date.parse("2026-06-01T09:00:00Z");
    await addPayable(t, s, { paymentDueDate: due });
    const fired: Record<number, number> = {};
    let before = 0;
    for (const offset of [-4, -3, -2, -1, 0, 1, 6, 7, 8, 14, 15, 21]) {
      await sweep(t, due + offset * DAY);
      const total = (await alerts(t)).length;
      fired[offset] = total - before;
      before = total;
    }
    const per = 3;
    expect(fired).toEqual({ [-4]: 0, [-3]: per, [-2]: 0, [-1]: 0, 0: per, 1: 0, 6: 0, 7: per, 8: 0, 14: per, 15: 0, 21: per });
    const types = (await alerts(t)).map((r) => r.type);
    expect(new Set(types)).toEqual(new Set(["accounting.supplierObligationDue", "accounting.supplierObligationOverdue"]));
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
    await t.mutation(internal.supplierDueAlerts.processSupplierDueAlerts as never, { now: NOW } as never);
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

  test("one organisation failing does not stop the others", async () => {
    const t = newHarness();
    const bad = await seedOrg(t, "g1");
    const good = await seedOrg(t, "g2");
    await addPayable(t, bad, { paymentDueDate: NOW, currency: "XXX" });
    await addPayable(t, good, { paymentDueDate: NOW });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await sweep(t);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    const rows = await alerts(t);
    expect(rows.filter((r) => r.orgId === good.orgId)).toHaveLength(3);
    expect(rows.filter((r) => r.orgId === bad.orgId)).toHaveLength(0);
  });
});
