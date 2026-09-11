/**
 * SCRUM-318 — a receivable's command fingerprint covers every input the row
 * persists, so a retry that changed a link or the notes is refused rather
 * than acknowledged as the original intent.
 *
 * Owner-proxy disposition (SCRUM-318 c19305, SCRUM-313 c19303): fix NOW,
 * narrowly, for `collections.createReceivable` and
 * `collections.createInstallmentPlan`. The five persisted inputs the
 * fingerprints omitted — `vehicleId`, `quoteId`, `applicationId`,
 * `assignedTo`, `notes` — are proven one at a time: divergence under the same
 * key is refused with the original row(s) untouched, an unchanged retry
 * returns the original result, and the economic footprint (rows + accounting
 * occurrences) stays at one per debt. `notes` is fingerprinted exactly as it
 * is persisted (untrimmed), so a note that differs only by whitespace is a
 * different note.
 *
 * Evidence boundary: convex-test only.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S318 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Finance User" })
  );
  const colleagueId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_col`, email: `${tag}.col@example.com`, name: "Colleague" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true,
      permissions: ["manage:finance", "view:finance", "view:vehicles", "view:customers", "manage:settings", "view:reports"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: colleagueId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  // A chart and an OPEN period, so each debt posts its accounting occurrence
  // and the footprint below counts events, not only rows.
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicle = async (vin: string) =>
    await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin, make: "Kia", model: "Rio", year: 2024, mileage: 1, color: "White", fuelType: "Gasoline",
        transmission: "Automatic", sellingPrice: 9_000, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 7_000,
      })
    );
  const vehicleA = await vehicle(`VIN318A${tag}`);
  const vehicleB = await vehicle(`VIN318B${tag}`);
  const quote = async (vehicleId: Id<"vehicles">) =>
    await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 9_000, downPayment: 0, totalFinancedAmount: 9_000,
        termMonths: 12, status: "DRAFT", createdBy: userId, createdAt: Date.now(),
      })
    );
  const quoteA = await quote(vehicleA);
  const quoteB = await quote(vehicleB);
  const application = async (quoteId: Id<"quotes">, vehicleId: Id<"vehicles">) =>
    await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, quoteId, salespersonId: userId, status: "DRAFT",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
  const applicationA = await application(quoteA, vehicleA);
  const applicationB = await application(quoteB, vehicleB);
  return { t, orgId, userId, colleagueId, customerId, vehicleA, vehicleB, quoteA, quoteB, applicationA, applicationB, asUser };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/** Rows + accounting occurrences, the two surfaces a duplicate would show on. */
async function footprint(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const receivables = await ctx.db.query("receivables").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const canonical = await ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    return {
      rows: receivables.map((r) => ({
        _id: r._id,
        vehicleId: r.vehicleId ?? null,
        quoteId: r.quoteId ?? null,
        applicationId: r.applicationId ?? null,
        assignedTo: r.assignedTo ?? null,
        notes: r.notes ?? null,
        originalAmount: r.originalAmount,
      })),
      events: events.length,
      canonical: canonical.length,
    };
  });
}

const DUE = Date.UTC(2031, 0, 15);

function receivableArgs(s: Seeded, key: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key,
    orgId: s.orgId,
    customerId: s.customerId,
    sourceType: "OTHER" as const,
    creditSystemKey: "MISCELLANEOUS_INCOME" as const,
    title: "Damage claim",
    amount: 250,
    dueDate: DUE,
    ...overrides,
  };
}

function planArgs(s: Seeded, key: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key,
    orgId: s.orgId,
    customerId: s.customerId,
    sourceType: "INTERNAL_INSTALLMENT" as const,
    creditSystemKey: "MISCELLANEOUS_INCOME" as const,
    title: "Service plan",
    totalAmount: 900,
    installmentCount: 3,
    firstDueDate: DUE,
    intervalMonths: 1,
    ...overrides,
  };
}

/** The five persisted attribution inputs, each with a first value and a changed value. */
function divergences(s: Seeded): Array<[string, Record<string, unknown>, Record<string, unknown>]> {
  return [
    ["vehicleId", { vehicleId: s.vehicleA }, { vehicleId: s.vehicleB }],
    ["quoteId", { quoteId: s.quoteA }, { quoteId: s.quoteB }],
    ["applicationId", { applicationId: s.applicationA }, { applicationId: s.applicationB }],
    ["assignedTo", { assignedTo: s.userId }, { assignedTo: s.colleagueId }],
    ["notes", { notes: "Windscreen chip" }, { notes: "Rear bumper" }],
    // Absent → present is a change too: "no vehicle" and "this vehicle" are
    // different intents even though the amount is the same.
    ["vehicleId (absent → present)", {}, { vehicleId: s.vehicleA }],
    ["notes (absent → present)", {}, { notes: "Added on retry" }],
    // Persisted untrimmed, so fingerprinted untrimmed.
    ["notes (trailing whitespace)", { notes: "Chip" }, { notes: "Chip " }],
  ];
}

const CASES = [
  "vehicleId", "quoteId", "applicationId", "assignedTo", "notes",
  "vehicleId (absent → present)", "notes (absent → present)", "notes (trailing whitespace)",
];

describe("SCRUM-318 — createReceivable fingerprints every persisted input", () => {
  test.each(CASES)(
    "same key + changed %s is refused; the original row is untouched; one debt, one occurrence",
    async (name) => {
      const s = await seed(`r_${String(name).replace(/\W+/g, "_")}`);
      const [, first, changed] = divergences(s).find(([n]) => n === name)!;
      const key = `s318-${name}`;
      const id = await s.asUser.mutation(api.collections.createReceivable, receivableArgs(s, key, first));
      const once = await footprint(s);
      expect(once.rows).toHaveLength(1);

      await expect(
        s.asUser.mutation(api.collections.createReceivable, receivableArgs(s, key, changed))
      ).rejects.toThrow(/different request content/i);
      expect(await footprint(s)).toEqual(once);

      // An unchanged retry still replays to the original id with no second footprint.
      const again = await s.asUser.mutation(api.collections.createReceivable, receivableArgs(s, key, first));
      expect(again).toBe(id);
      expect(await footprint(s)).toEqual(once);
    }
  );

  test("CONTROL — the fully attributed receivable is created once and replays to the same id", async () => {
    const s = await seed("r_ctrl");
    const args = receivableArgs(s, "s318-r-ctrl", {
      vehicleId: s.vehicleA, quoteId: s.quoteA, applicationId: s.applicationA, assignedTo: s.colleagueId, notes: "All five ",
    });
    const id = await s.asUser.mutation(api.collections.createReceivable, args);
    const once = await footprint(s);
    expect(once.rows).toEqual([
      { _id: id, vehicleId: s.vehicleA, quoteId: s.quoteA, applicationId: s.applicationA, assignedTo: s.colleagueId, notes: "All five ", originalAmount: 250 },
    ]);
    expect(once.events).toBe(1);
    expect(once.canonical).toBe(1);
    expect(await s.asUser.mutation(api.collections.createReceivable, args)).toBe(id);
    expect(await footprint(s)).toEqual(once);
  });
});

describe("SCRUM-318 — createInstallmentPlan fingerprints every persisted input", () => {
  test.each(CASES)(
    "same key + changed %s is refused; the whole plan stays one plan",
    async (name) => {
      const s = await seed(`p_${String(name).replace(/\W+/g, "_")}`);
      const [, first, changed] = divergences(s).find(([n]) => n === name)!;
      const key = `s318-plan-${name}`;
      const ids = await s.asUser.mutation(api.collections.createInstallmentPlan, planArgs(s, key, first));
      expect(ids).toHaveLength(3);
      const once = await footprint(s);
      expect(once.rows).toHaveLength(3);

      await expect(
        s.asUser.mutation(api.collections.createInstallmentPlan, planArgs(s, key, changed))
      ).rejects.toThrow(/different request content/i);
      expect(await footprint(s)).toEqual(once);

      const again = await s.asUser.mutation(api.collections.createInstallmentPlan, planArgs(s, key, first));
      expect(again).toEqual(ids);
      expect(await footprint(s)).toEqual(once);
    }
  );

  test("CONTROL — the fully attributed plan is three debts, three occurrences, and replays whole", async () => {
    const s = await seed("p_ctrl");
    const args = planArgs(s, "s318-p-ctrl", {
      vehicleId: s.vehicleA, quoteId: s.quoteA, applicationId: s.applicationA, assignedTo: s.colleagueId, notes: "Plan notes",
    });
    const ids = await s.asUser.mutation(api.collections.createInstallmentPlan, args);
    const once = await footprint(s);
    expect(once.rows).toHaveLength(3);
    expect(once.rows.map((r) => r.originalAmount).reduce((a, b) => a + b, 0)).toBe(900);
    for (const row of once.rows) {
      expect(row).toMatchObject({ vehicleId: s.vehicleA, quoteId: s.quoteA, applicationId: s.applicationA, assignedTo: s.colleagueId, notes: "Plan notes" });
    }
    expect(once.events).toBe(3);
    expect(once.canonical).toBe(3);
    expect(await s.asUser.mutation(api.collections.createInstallmentPlan, args)).toEqual(ids);
    expect(await footprint(s)).toEqual(once);
  });
});
