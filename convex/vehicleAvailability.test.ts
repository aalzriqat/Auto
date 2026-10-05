/**
 * SCRUM-636 — the picker's advisory hold badge (ruling c22077).
 *
 * Invariant under test: FREE only when no OPEN root, no RESERVED projection and
 * no live or unreadable finance claim exists; HELD when exactly one OPEN root
 * holds the car; UNCERTAIN otherwise. Never names the holder; never leaks
 * another tenant's car.
 *
 * The root-vs-status cases are deliberate (design attack DA-8): a badge driven
 * by `vehicle.status`, which is what the picker did before, passes a FREE/
 * RESERVED-only suite and fails every one of them.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { PICKER_AVAILABILITY_MAX_IDS } from "./vehicleAvailability";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

type T = ReturnType<typeof convexTestWithComponents>;

async function seedTenant(t: T, suffix: string, permissions = ["view:vehicles"]) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `user_${suffix}`, email: `${suffix}@test.com`, name: `User ${suffix}` })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Sales", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Customer", lastName: suffix, phone: `+9627900${suffix.length}11`, createdAt: Date.now() })
  );
  const asUser = t.withIdentity({ subject: `user_${suffix}`, clerkId: `user_${suffix}` });
  return { orgId, userId, customerId, asUser };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

let vinCounter = 0;
async function car(t: T, tenant: Tenant, extra: Record<string, unknown> = {}) {
  vinCounter += 1;
  return t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: tenant.orgId,
      vin: `VIN636${String(vinCounter).padStart(11, "0")}`,
      make: "Toyota",
      model: "Camry",
      year: 2022,
      mileage: 0,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      purchasePrice: 10_000,
      sellingPrice: 15_000,
      status: "AVAILABLE",
      ...extra,
    } as never)
  ) as Promise<Id<"vehicles">>;
}

async function root(t: T, tenant: Tenant, vehicleId: Id<"vehicles">, status: "OPEN" | "RELEASED" = "OPEN") {
  return t.run((ctx) =>
    ctx.db.insert("commitmentRoots", {
      orgId: tenant.orgId,
      vehicleId,
      customerId: tenant.customerId,
      status,
      openedAt: Date.now(),
      openedBy: tenant.userId,
    })
  );
}

async function financeApplication(t: T, tenant: Tenant, vehicleId: Id<"vehicles">, status: string) {
  return t.run(async (ctx) => {
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId: tenant.orgId, name: "Bank", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 0,
    });
    const quoteId = await ctx.db.insert("quotes", {
      orgId: tenant.orgId, vehicleId, customerId: tenant.customerId, vehiclePrice: 15_000, downPayment: 3_000,
      totalFinancedAmount: 12_000, termMonths: 48, status: "DRAFT", companyId, createdBy: tenant.userId, createdAt: Date.now(),
    });
    return ctx.db.insert("financeApplications", {
      orgId: tenant.orgId, customerId: tenant.customerId, vehicleId, companyId, quoteId, salespersonId: tenant.userId,
      status, createdAt: Date.now(), updatedAt: Date.now(),
    } as never) as Promise<Id<"financeApplications">>;
  });
}

/** An ACTIVE FINANCE claim on a car whose root is no longer OPEN — the pre-root / drifted shape. */
async function financeClaim(t: T, tenant: Tenant, vehicleId: Id<"vehicles">, applicationId?: Id<"financeApplications">) {
  const rootId = await root(t, tenant, vehicleId, "RELEASED");
  await t.run((ctx) =>
    ctx.db.insert("vehicleCommitmentClaims", {
      orgId: tenant.orgId,
      rootId,
      vehicleId,
      status: "ACTIVE",
      evidenceKind: "FINANCE",
      ...(applicationId ? { applicationId } : {}),
      createdAt: Date.now(),
      createdBy: tenant.userId,
    } as never)
  );
}

async function badge(tenant: Tenant, vehicleId: Id<"vehicles">) {
  const [row] = await tenant.asUser.query(api.vehicleAvailability.pickerAvailability, {
    orgId: tenant.orgId,
    vehicleIds: [vehicleId],
  });
  return row.availability;
}

function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  return t;
}

describe("pickerAvailability (SCRUM-636)", () => {
  test("a plain available car with no commitment is FREE", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    expect(await badge(a, await car(t, a))).toBe("FREE");
  });

  test("a finance-only hold on an AVAILABLE car is HELD — the status badge missed it", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a, { status: "AVAILABLE" });
    await root(t, a, v);
    expect(await badge(a, v)).toBe("HELD");
  });

  test("a RESERVED car with its OPEN root is HELD", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a, { status: "RESERVED" });
    await root(t, a, v);
    expect(await badge(a, v)).toBe("HELD");
  });

  test("RESERVED with no OPEN root is UNCERTAIN, not HELD (legacy / drift)", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    expect(await badge(a, await car(t, a, { status: "RESERVED" }))).toBe("UNCERTAIN");
  });

  test("two OPEN roots on one car (corruption) is UNCERTAIN", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    await root(t, a, v);
    await root(t, a, v);
    expect(await badge(a, v)).toBe("UNCERTAIN");
  });

  test("a released root alone does not hold the car", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    await root(t, a, v, "RELEASED");
    expect(await badge(a, v)).toBe("FREE");
  });

  test("an ACTIVE finance claim whose application is in flight, with no OPEN root, is UNCERTAIN", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    const app = await financeApplication(t, a, v, "UNDER_REVIEW");
    await financeClaim(t, a, v, app);
    expect(await badge(a, v)).toBe("UNCERTAIN");
  });

  test("a stale finance claim whose application is terminal does not hold the car", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    const app = await financeApplication(t, a, v, "REJECTED");
    await financeClaim(t, a, v, app);
    expect(await badge(a, v)).toBe("FREE");
  });

  test("a finance claim with no application cannot be shown dead: UNCERTAIN", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    await financeClaim(t, a, v);
    expect(await badge(a, v)).toBe("UNCERTAIN");
  });

  test("a finance claim naming a deleted application is UNCERTAIN", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    const app = await financeApplication(t, a, v, "APPROVED");
    await financeClaim(t, a, v, app);
    await t.run((ctx) => ctx.db.delete(app));
    expect(await badge(a, v)).toBe("UNCERTAIN");
  });

  test("an in-flight application with no claim (pre-claim legacy) is UNCERTAIN", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    await financeApplication(t, a, v, "PENDING_DOCS");
    expect(await badge(a, v)).toBe("UNCERTAIN");
  });

  test.each([
    ["SOLD", { status: "SOLD" }],
    ["ARCHIVED", { status: "ARCHIVED" }],
    ["soft-deleted", { isDeleted: true }],
  ])("a %s car is never FREE", async (_label, extra) => {
    const t = setup();
    const a = await seedTenant(t, "a");
    expect(await badge(a, await car(t, a, extra))).toBe("UNCERTAIN");
  });

  test("another tenant's car reads exactly like a missing one — no existence or hold oracle", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const b = await seedTenant(t, "b");
    const freeInB = await car(t, b);
    const heldInB = await car(t, b);
    await root(t, b, heldInB);
    const gone = await car(t, a);
    await t.run((ctx) => ctx.db.delete(gone));

    const rows = await a.asUser.query(api.vehicleAvailability.pickerAvailability, {
      orgId: a.orgId,
      vehicleIds: [freeInB, heldInB, gone],
    });
    expect(rows.map((r) => r.availability)).toEqual(["UNCERTAIN", "UNCERTAIN", "UNCERTAIN"]);
  });

  test("a caller cannot ask about another org at all", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const b = await seedTenant(t, "b");
    const v = await car(t, b);
    await expect(
      a.asUser.query(api.vehicleAvailability.pickerAvailability, { orgId: b.orgId, vehicleIds: [v] })
    ).rejects.toThrow();
  });

  test("a member without view:vehicles is refused", async () => {
    const t = setup();
    const a = await seedTenant(t, "a", ["view:sales"]);
    const v = await car(t, a);
    await expect(
      a.asUser.query(api.vehicleAvailability.pickerAvailability, { orgId: a.orgId, vehicleIds: [v] })
    ).rejects.toThrow();
  });

  test("the response names no holder: only vehicleId and availability", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const v = await car(t, a);
    await root(t, a, v);
    const rows = await a.asUser.query(api.vehicleAvailability.pickerAvailability, { orgId: a.orgId, vehicleIds: [v] });
    expect(rows).toEqual([{ vehicleId: v, availability: "HELD" }]);
  });

  test("ids are deduplicated, and ids beyond the cap come back UNCERTAIN rather than missing", async () => {
    const t = setup();
    const a = await seedTenant(t, "a");
    const first = await car(t, a);
    const ids: Id<"vehicles">[] = [first, first];
    for (let i = 0; i < PICKER_AVAILABILITY_MAX_IDS; i += 1) ids.push(await car(t, a));
    const rows = await a.asUser.query(api.vehicleAvailability.pickerAvailability, { orgId: a.orgId, vehicleIds: ids });

    expect(rows).toHaveLength(PICKER_AVAILABILITY_MAX_IDS + 1);
    expect(new Set(rows.map((r) => r.vehicleId)).size).toBe(rows.length);
    expect(rows.slice(0, PICKER_AVAILABILITY_MAX_IDS).every((r) => r.availability === "FREE")).toBe(true);
    expect(rows.at(-1)).toEqual({ vehicleId: ids.at(-1), availability: "UNCERTAIN" });
  });
});
