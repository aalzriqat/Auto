/**
 * SCRUM-886 round 13 (owner ruling SCRUM-886 comment 24358, 2026-11-02; OWASP API3:2023 property-level authorization and
 * API5:2023 function-level authorization). Rounds 10-12 closed the cost oracle one channel at a time: the text of a refusal, the
 * order of refusals, the order across the lines of a quote. Each round the reviewers found the next channel, because the class was
 * "a mutation that decides on a cost value and answers a caller who may not read it". The owner closes the class by PERMISSION.
 *
 * Invariant: an actor who cannot read vehicle cost can never cause the backend to make a decision that depends on vehicle cost.
 *
 * The four rules, all server-side:
 *   1. The default ACCOUNTANT role template holds `view:cost_price`.
 *   2. Completing or finalizing a SOURCED (consigned) sale needs `view:cost_price` on every completion door
 *      (`sales.create`, `sales.completeDraft`, `sales.completeFromQuote` for every line, `applications.finalizeDeal`). The check is
 *      the first decision of the door, depends only on the vehicle's `sourceType` and the actor's permission (never on a cost
 *      value), reuses `actorMayReadVehicleCost`, and refuses with the existing coded `CONSIGNED_SALE_NEEDS_COST_ACCESS`.
 *   3. Saving a role that holds a sale-completing permission (`create:sales`, `confirm:finance_disbursement`) without
 *      `view:cost_price` is refused with a coded EN/AR error. Stored roles are not migrated.
 *   4. A bounded, idempotent internal backfill gives the grant to the stored ACCOUNTANT roles that hold a sale-completing
 *      permission without it. The Deploy production rollout runs it on every deploy (SCRUM-896, owner ruling c24372), so it never
 *      overrides a role the owner has already restricted.
 *
 * Every test goes through a public mutation unless it says otherwise. Expected values are literals from the seeded rows: a supplier
 * entitlement of 8,765.432 JOD (8765432 fils).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import {
  payForwardBeforeFinalize, readyDeal, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { supplierIdInCtx } from "../test-utils/supplierFixture";
import { dictionaries } from "../lib/i18n/dictionaries";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import { completeSale } from "./utils/saleCompletion";

const MODULES = import.meta.glob("./**/*.*s");

const NEEDS_COST_ACCESS_CODE = "CONSIGNED_SALE_NEEDS_COST_ACCESS";
const ROLE_RULE_CODE = "SALE_COMPLETING_ROLE_NEEDS_COST_ACCESS";
const UNPAID_CODE = "CASH_SALE_BALANCE_UNPAID_REFUSED";
const ENTITLEMENT = 8_765.432;
const ONE_FILS_SHORT = 8_765.431;
const ONE_FILS_MORE = 8_765.433;
/** The four prices the invariant names: far below, one fils short, exactly the entitlement, far above. */
const PRICES = [1, ONE_FILS_SHORT, ENTITLEMENT, 20_000] as const;
const ENTITLEMENT_LEAK = /8[,. ]?765|765[.,]?432|8765432/;

/** The role the owner ruling names: it can complete a sale and cannot read vehicle cost. */
const COMPLETER_NO_COST = [
  "view:sales", "create:sales", "view:vehicles", "view:customers", "edit:vehicles", "confirm:finance_disbursement",
];
const COMPLETER_WITH_COST = [...COMPLETER_NO_COST, "view:cost_price"];

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

type Who = "owner" | "nonReader" | "reader";

/** The whole `ConvexError.data` of a refused call as one string (the byte-identical oracle), or null when accepted. */
async function payloadOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError || (error as { data?: unknown })?.data !== undefined) {
      return JSON.stringify((error as { data?: unknown }).data);
    }
    return `PLAIN:${(error as Error)?.message ?? String(error)}`;
  }
  return null;
}
const parsed = (payload: string | null): { code?: string; message?: string } => {
  if (payload === null) return {};
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === "object" && value !== null ? (value as { code?: string; message?: string }) : { message: String(value) };
  } catch {
    return { message: payload };
  }
};

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Cost Access Rule", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"], commissionMode: "MANUAL" })
  );
  const specs: Record<Who, string[] | "owner"> = { owner: "owner", nonReader: COMPLETER_NO_COST, reader: COMPLETER_WITH_COST };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum886r13_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    const spec = specs[who];
    // A direct `roles` insert, exactly as a role stored before the rule existed would be.
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", spec === "owner"
        ? { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true }
        : { orgId, name: `Role ${who}`, permissions: spec })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
    userIds[who] = userId;
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Rule" }));
  return { t, orgId, actors, userIds, customerId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

afterEach(() => vi.useRealTimers());

let vinCounter = 0;
const nextVin = () => `VIN886R13${String((vinCounter += 1)).padStart(6, "0")}`;

/** A consigned car. `sourceCost` null models a car whose supplier amount was never recorded. */
async function consignedCar(
  s: Seeded,
  sourceCost: number | null = ENTITLEMENT,
  status: "AVAILABLE" | "ARCHIVED" | "IN_INSPECTION" = "AVAILABLE"
): Promise<Id<"vehicles">> {
  return await s.t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: nextVin(), make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status,
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourcedSupplierId: await supplierIdInCtx(ctx, s.orgId, "Amman Importer Co"),
      ...(sourceCost !== null ? { sourceCost } : {}),
    })
  );
}

/** A dealer-owned car. */
async function stockCar(s: Seeded, status: "AVAILABLE" | "ARCHIVED" = "AVAILABLE"): Promise<Id<"vehicles">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: nextVin(), make: "Honda", model: "Accord", year: 2023, mileage: 20, color: "Black",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status, sourceType: "STOCK", purchasePrice: 5_000,
    })
  );
}

/** A CASH completion on the DIRECT_TO_SUPPLIER route: the buyer pays the supplier, so pay-first has nothing to demand. */
const create = (s: Seeded, who: Who, vehicleId: Id<"vehicles">, salePrice: number) =>
  s.actors[who].mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId,
    salespersonId: s.userIds[who], salePrice, saleDate: Date.now(), status: "COMPLETED" as const,
    supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
  });

async function draftFor(s: Seeded, who: Who, vehicleId: Id<"vehicles">, salePrice: number): Promise<Id<"sales">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userIds[who], salePrice, saleDate: Date.now(),
      status: "PENDING", financingType: "CASH", supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
    })
  );
}
const completeDraft = (s: Seeded, who: Who, saleId: Id<"sales">) =>
  s.actors[who].mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() });

type Item = { vehicleId: Id<"vehicles">; unitPrice: number };
async function insertQuote(s: Seeded, who: Who, items: Item[]): Promise<Id<"quotes">> {
  return await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId, customerId: s.customerId, vehicleId: items[0].vehicleId, mode: "CASH",
      vehicleItems: items, vehiclePrice: items.reduce((sum, item) => sum + item.unitPrice, 0), downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: s.userIds[who], createdAt: Date.now(),
    })
  );
}
const completeQuote = (s: Seeded, who: Who, quoteId: Id<"quotes">) =>
  s.actors[who].mutation(api.sales.completeFromQuote, {
    orgId: s.orgId, quoteId, idempotencyKey: crypto.randomUUID(), supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
  });

/** Everything a refused completion must leave alone. */
async function worldOf(s: Seeded) {
  return s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").take(1000)).map((x) => [x._id, x.status]),
    commands: (await ctx.db.query("commandIdempotency").take(1000)).length,
    queued: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    payments: (await ctx.db.query("canonicalPayments").take(1000)).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
    applications: (await ctx.db.query("depositApplications").take(1000)).length,
    vehicles: (await ctx.db.query("vehicles").take(1000)).map((v) => [v._id, v.status]),
    deposits: (await ctx.db.query("deposits").take(1000)).map((d) => [d._id, d.status, d.holdActive === true]),
    holds: (await ctx.db.query("depositVehicleHolds").take(1000)).map((h) => [h._id, h.active]),
  }));
}

function expectOneCodedRefusal(payloads: Array<string | null>, label: string) {
  const [first] = payloads;
  expect(payloads, `${label}: byte-identical at every price`).toEqual(Array(payloads.length).fill(first));
  expect(first, `${label}: refused`).not.toBeNull();
  expect(parsed(first).code, `${label}: the coded cost-access refusal`).toBe(NEEDS_COST_ACCESS_CODE);
  expect(first, `${label}: names no amount`).not.toMatch(ENTITLEMENT_LEAK);
}

describe("SCRUM-886 round 13 rule 2: sales.create, the first decision for a SOURCED car is the permission", () => {
  test("sales.create refuses a sale-completing role without view:cost_price with one byte-identical coded response at 1, one fils short, the entitlement and 20,000", async () => {
    const s = await seed();
    const withAmount = await consignedCar(s);
    const withoutAmount = await consignedCar(s, null);
    const before = await worldOf(s);
    const payloads: Array<string | null> = [];
    for (const price of PRICES) payloads.push(await payloadOf(create(s, "nonReader", withAmount, price)));
    for (const price of PRICES) payloads.push(await payloadOf(create(s, "nonReader", withoutAmount, price)));
    expectOneCodedRefusal(payloads, "sales.create");
    expect(await worldOf(s), "sales.create wrote nothing").toEqual(before);
  });

  test("sales.create refuses a SOURCED car that is archived with the coded response too, so no caller-aimed refusal can answer first", async () => {
    const s = await seed();
    const archived = await consignedCar(s, ENTITLEMENT, "ARCHIVED");
    const payloads: Array<string | null> = [];
    for (const price of PRICES) payloads.push(await payloadOf(create(s, "nonReader", archived, price)));
    expectOneCodedRefusal(payloads, "sales.create on an archived consigned car");
  });
});

describe("SCRUM-886 round 13 rule 2: sales.completeDraft", () => {
  test("sales.completeDraft refuses a sale-completing role without view:cost_price with one byte-identical coded response at every price and the draft stays PENDING", async () => {
    const s = await seed();
    const withAmount = await consignedCar(s);
    const withoutAmount = await consignedCar(s, null);
    const drafts: Id<"sales">[] = [];
    for (const price of PRICES) drafts.push(await draftFor(s, "nonReader", withAmount, price));
    for (const price of PRICES) drafts.push(await draftFor(s, "nonReader", withoutAmount, price));
    const before = await worldOf(s);
    const payloads: Array<string | null> = [];
    for (const saleId of drafts) payloads.push(await payloadOf(completeDraft(s, "nonReader", saleId)));
    expectOneCodedRefusal(payloads, "sales.completeDraft");
    expect(await worldOf(s), "sales.completeDraft wrote nothing").toEqual(before);
    const statuses = await s.t.run(async (ctx) => Promise.all(drafts.map(async (id) => (await ctx.db.get(id))?.status)));
    expect(statuses).toEqual(Array(drafts.length).fill("PENDING"));
  });

  test("sales.completeDraft refuses a draft whose SOURCED car is archived with the coded response too, so the door check is the first decision and not the shared backstop", async () => {
    const s = await seed();
    const archived = await consignedCar(s, ENTITLEMENT, "ARCHIVED");
    const drafts: Id<"sales">[] = [];
    for (const price of PRICES) drafts.push(await draftFor(s, "nonReader", archived, price));
    const before = await worldOf(s);
    const payloads: Array<string | null> = [];
    for (const saleId of drafts) payloads.push(await payloadOf(completeDraft(s, "nonReader", saleId)));
    expectOneCodedRefusal(payloads, "sales.completeDraft on an archived consigned car");
    expect(await worldOf(s), "sales.completeDraft wrote nothing").toEqual(before);
  });
});

describe("SCRUM-886 round 13 rule 2: sales.completeFromQuote checks every line before touching any", () => {
  test("sales.completeFromQuote refuses a sale-completing role without view:cost_price with one byte-identical coded response at every price and writes nothing", async () => {
    const s = await seed();
    const quotes: Id<"quotes">[] = [];
    for (const price of PRICES) quotes.push(await insertQuote(s, "nonReader", [{ vehicleId: await consignedCar(s), unitPrice: price }]));
    for (const price of PRICES) quotes.push(await insertQuote(s, "nonReader", [{ vehicleId: await consignedCar(s, null), unitPrice: price }]));
    const before = await worldOf(s);
    const payloads: Array<string | null> = [];
    for (const quoteId of quotes) payloads.push(await payloadOf(completeQuote(s, "nonReader", quoteId)));
    expectOneCodedRefusal(payloads, "sales.completeFromQuote");
    expect(await worldOf(s), "sales.completeFromQuote wrote nothing").toEqual(before);
  });

  test("a two-line quote with a SOURCED car on line 2 only is refused before line 1 is touched", async () => {
    const s = await seed();
    const first = await stockCar(s);
    const second = await consignedCar(s);
    const quoteId = await insertQuote(s, "nonReader", [{ vehicleId: first, unitPrice: 5_000 }, { vehicleId: second, unitPrice: 9_000 }]);
    const before = await worldOf(s);
    const payload = await payloadOf(completeQuote(s, "nonReader", quoteId));
    expect(parsed(payload).code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(await worldOf(s), "line 1 was not touched").toEqual(before);
    const status = await s.t.run(async (ctx) => (await ctx.db.get(first))?.status);
    expect(status).toBe("AVAILABLE");
  });

  test("a quote whose SOURCED line 3 is archived still gets the coded response, not the archived-vehicle refusal", async () => {
    const s = await seed();
    const quoteId = await insertQuote(s, "nonReader", [
      { vehicleId: await stockCar(s), unitPrice: 5_000 },
      { vehicleId: await stockCar(s), unitPrice: 5_000 },
      { vehicleId: await consignedCar(s, ENTITLEMENT, "ARCHIVED"), unitPrice: 9_000 },
    ]);
    const payload = await payloadOf(completeQuote(s, "nonReader", quoteId));
    expect(parsed(payload).code).toBe(NEEDS_COST_ACCESS_CODE);
  });
});

describe("SCRUM-886 round 13 rule 2: applications.finalizeDeal", () => {
  async function financed() {
    const actors = {
      nonReader: COMPLETER_NO_COST,
      reader: COMPLETER_WITH_COST,
      accountant: [...(DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "ACCOUNTANT")?.permissions ?? [])] as string[],
    };
    const s = await seedFinancedDealership("r13fin", {
      modules: MODULES, ownerPerms: ALL_PERMISSIONS, actors, label: "R13", vinPrefix: "VIN886F", sourced: true,
    });
    return s;
  }
  const finalize = (as: { mutation: (...args: never[]) => Promise<unknown> } | unknown, orgId: Id<"organizations">, applicationId: Id<"financeApplications">) =>
    (as as { mutation: (fn: unknown, args: unknown) => Promise<unknown> }).mutation(api.applications.finalizeDeal, {
      idempotencyKey: crypto.randomUUID(), orgId, applicationId,
    });
  async function financedWorld(s: Awaited<ReturnType<typeof financed>>) {
    return s.t.run(async (ctx) => ({
      sales: (await ctx.db.query("sales").take(100)).length,
      commands: (await ctx.db.query("commandIdempotency").take(1000)).length,
      queued: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
      payments: (await ctx.db.query("canonicalPayments").take(1000)).length,
      payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
      vehicles: (await ctx.db.query("vehicles").take(100)).map((v) => [v._id, v.status]),
      applications: (await ctx.db.query("financeApplications").take(100)).map((a) => [a._id, a.status]),
    }));
  }

  test("applications.finalizeDeal refuses a confirm:finance_disbursement role without view:cost_price with one byte-identical coded response whatever the supplier amount, and writes nothing", async () => {
    const s = await financed();
    const { applicationId } = await readyDeal(s, { route: "THROUGH_DEALERSHIP" });
    await payForwardBeforeFinalize(s, s.owner.as, applicationId);
    const before = await financedWorld(s);
    const payloads: Array<string | null> = [];
    for (const sourceCost of [1, 12_499.999, 12_500, 20_000, null]) {
      await s.t.run(async (ctx) => {
        const car = await ctx.db.get(s.vehicleId);
        if (!car) throw new Error("vehicle missing");
        const { sourceCost: _removed, ...rest } = car;
        void _removed;
        await ctx.db.replace(s.vehicleId, sourceCost === null ? rest : { ...rest, sourceCost });
      });
      payloads.push(await payloadOf(finalize(s.actors.nonReader.as, s.orgId, applicationId)));
    }
    expectOneCodedRefusal(payloads, "applications.finalizeDeal");
    // The vehicle's sourceCost moved between calls; everything else must be unchanged.
    const after = await financedWorld(s);
    expect({ ...after }).toEqual({ ...before });
  });

  test("applications.finalizeDeal gives the coded response to a deal that is not ready (no handover) before any readiness refusal", async () => {
    const s = await financed();
    const quote = await s.owner.as.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 12_500, downPayment: 0, termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
      customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: 12_500,
    });
    const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId: quote });
    await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    // Approved, but no handover was registered, so a reader gets the handover refusal.
    const reader = parsed(await payloadOf(finalize(s.actors.reader.as, s.orgId, applicationId)));
    expect(reader.code).toBeUndefined();
    expect(reader.message).toMatch(/handover/i);
    const nonReader = parsed(await payloadOf(finalize(s.actors.nonReader.as, s.orgId, applicationId)));
    expect(nonReader.code).toBe(NEEDS_COST_ACCESS_CODE);
  });

  test("a default ACCOUNTANT finalizes a FINANCED SOURCED deal", async () => {
    const s = await financed();
    const { applicationId } = await readyDeal(s, { route: "THROUGH_DEALERSHIP" });
    await payForwardBeforeFinalize(s, s.owner.as, applicationId);
    const outcome = await payloadOf(finalize(s.actors.accountant.as, s.orgId, applicationId));
    expect(outcome).toBeNull();
    const state = await s.t.run(async (ctx) => ({
      app: (await ctx.db.get(applicationId))?.status,
      sales: (await ctx.db.query("sales").take(10)).length,
      car: (await ctx.db.get(s.vehicleId))?.status,
    }));
    expect(state).toEqual({ app: "CLOSED", sales: 1, car: "SOLD" });
  });

  test("a view:cost_price holder finalizes a FINANCED SOURCED deal exactly as before", async () => {
    const s = await financed();
    const { applicationId } = await readyDeal(s, { route: "THROUGH_DEALERSHIP" });
    await payForwardBeforeFinalize(s, s.owner.as, applicationId);
    expect(await payloadOf(finalize(s.actors.reader.as, s.orgId, applicationId))).toBeNull();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.status).toBe("CLOSED");
  });
});

/** The draft door: a PENDING save commits nothing, so it is not a completion and the rule does not apply to it. */
const saveDraft = (s: Seeded, who: Who, vehicleId: Id<"vehicles">, salePrice: number) =>
  s.actors[who].mutation(api.sales.createDraft, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId,
    salespersonId: s.userIds[who], salePrice, saleDate: Date.now(), financingType: "CASH" as const,
    supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
  });

/** How many rows each table that a completion would touch holds, plus the status of every car. */
async function writeCountsOf(s: Seeded) {
  return s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").take(1000)).length,
    commands: (await ctx.db.query("commandIdempotency").take(1000)).length,
    queued: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    payments: (await ctx.db.query("canonicalPayments").take(1000)).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
    applications: (await ctx.db.query("depositApplications").take(1000)).length,
    vehicles: (await ctx.db.query("vehicles").take(1000)).map((v) => [v._id, v.status]),
  }));
}

describe("SCRUM-886 round 13 rule 2: a draft is not a completion", () => {
  test("sales.createDraft saves a PENDING draft of a SOURCED car for a role without view:cost_price at one fils below the entitlement and at it with the same response shape and the same writes", async () => {
    const s = await seed();
    // Automatic commission is the one draft step that reads the car's cost (sourceCost). Its result is discarded, so the answer
    // must not change with the price.
    await s.t.run(async (ctx) => {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique();
      await ctx.db.patch(settings!._id, { commissionMode: "AUTO_MEMBER" });
      const membership = await ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", s.userIds.nonReader)).first();
      await ctx.db.patch(membership!._id, { commissionRate: 5 });
    });
    const outcomes: Array<{ ids: Id<"sales">; deltas: Record<string, unknown>; row: Record<string, unknown> }> = [];
    for (const price of [ONE_FILS_SHORT, ENTITLEMENT]) {
      const car = await consignedCar(s);
      const before = await writeCountsOf(s);
      const saleId = await saveDraft(s, "nonReader", car, price);
      const after = await writeCountsOf(s);
      const row = await s.t.run(async (ctx) => {
        const { _id, _creationTime, salePrice, vehicleId, idempotencyKey, ...rest } = (await ctx.db.get(saleId))!;
        void _id; void _creationTime; void salePrice; void vehicleId; void idempotencyKey;
        return rest as Record<string, unknown>;
      });
      expect(typeof saleId, `the response at ${price} is one sale id`).toBe("string");
      expect(after.vehicles, `the car at ${price} is untouched`).toEqual(before.vehicles);
      outcomes.push({
        ids: saleId,
        deltas: {
          sales: after.sales - before.sales, commands: after.commands - before.commands, queued: after.queued - before.queued,
          payments: after.payments - before.payments, payables: after.payables - before.payables,
          applications: after.applications - before.applications,
        },
        row,
      });
    }
    expect(outcomes[0].deltas, "one sale row and the idempotency claim, nothing else").toEqual({
      sales: 1, commands: 1, queued: 0, payments: 0, payables: 0, applications: 0,
    });
    expect(outcomes[1].deltas, "the same writes at the entitlement").toEqual(outcomes[0].deltas);
    expect(outcomes[1].row, "the same stored draft (apart from id, price and car)").toEqual(outcomes[0].row);
    expect(outcomes[0].row.status).toBe("PENDING");
    expect(outcomes[0].row.commissionAmount, "no cost-derived figure is stored on a draft").toBeUndefined();
  });

  test("a draft saved by a role without view:cost_price is still refused with the coded response when it is completed through sales.completeDraft", async () => {
    const s = await seed();
    const payloads: Array<string | null> = [];
    const drafts: Id<"sales">[] = [];
    for (const price of [ONE_FILS_SHORT, ENTITLEMENT]) {
      drafts.push(await saveDraft(s, "nonReader", await consignedCar(s), price));
    }
    const before = await worldOf(s);
    for (const saleId of drafts) payloads.push(await payloadOf(completeDraft(s, "nonReader", saleId)));
    expectOneCodedRefusal(payloads, "sales.completeDraft of a saved draft");
    expect(await worldOf(s), "completing the saved draft wrote nothing").toEqual(before);
    const statuses = await s.t.run(async (ctx) => Promise.all(drafts.map(async (id) => (await ctx.db.get(id))?.status)));
    expect(statuses).toEqual(["PENDING", "PENDING"]);
  });
});

describe("SCRUM-886 round 13 rule 2: what the rule does not touch", () => {
  test("the same role is not refused by this rule on a non-SOURCED car (the sale commits)", async () => {
    const s = await seed();
    const car = await stockCar(s);
    const quoteId = await insertQuote(s, "nonReader", [{ vehicleId: car, unitPrice: 9_000 }]);
    await s.t.run(async (ctx) => {
      const depositId = await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: car, customerId: s.customerId, quoteId, amount: 9_000, amountMinor: 9_000_000, currency: "JOD",
        method: "CASH", status: "HELD", holdActive: true, createdBy: s.userIds.nonReader, createdAt: Date.now(),
      });
      await ctx.db.insert("depositVehicleHolds", {
        orgId: s.orgId, depositId, vehicleId: car, active: true, createdAt: Date.now(),
        allocatedAmountMinor: 9_000_000, allocationStatus: "ALLOCATED" as const,
      });
    });
    const saleIds = await completeQuote(s, "nonReader", quoteId).catch(() => null);
    const outcome = saleIds === null
      ? parsed(await payloadOf(s.actors.nonReader.mutation(api.sales.create, {
          idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: car, customerId: s.customerId,
          salespersonId: s.userIds.nonReader, salePrice: 9_000, saleDate: Date.now(), status: "COMPLETED" as const, quoteId,
        })))
      : {};
    expect(outcome.code).not.toBe(NEEDS_COST_ACCESS_CODE);
    const state = await s.t.run(async (ctx) => (await ctx.db.get(car))?.status);
    expect(state).toBe("SOLD");
  });

  test("a view:cost_price holder is unaffected on every door: a sale at the entitlement commits and one below it gets the detailed shortfall sentence", async () => {
    const s = await seed();
    const below = parsed(await payloadOf(create(s, "reader", await consignedCar(s), 8_000)));
    expect(below.code).toBeUndefined();
    expect(below.message).toContain("against an entitlement of 8765.432");
    const car = await consignedCar(s);
    expect(await payloadOf(create(s, "reader", car, ENTITLEMENT))).toBeNull();

    const draft = await draftFor(s, "reader", await consignedCar(s), 8_000);
    expect(parsed(await payloadOf(completeDraft(s, "reader", draft))).message).toContain("against an entitlement of 8765.432");
    const draftOk = await draftFor(s, "reader", await consignedCar(s), ENTITLEMENT);
    expect(await payloadOf(completeDraft(s, "reader", draftOk))).toBeNull();

    const quoteBelow = await insertQuote(s, "reader", [{ vehicleId: await consignedCar(s), unitPrice: 8_000 }]);
    expect(parsed(await payloadOf(completeQuote(s, "reader", quoteBelow))).message).toContain("against an entitlement of 8765.432");
    const quoteOk = await insertQuote(s, "reader", [{ vehicleId: await consignedCar(s), unitPrice: ENTITLEMENT }]);
    expect(await payloadOf(completeQuote(s, "reader", quoteOk))).toBeNull();
  });

  test("the system owner is unaffected: a sale at the entitlement commits", async () => {
    const s = await seed();
    expect(await payloadOf(create(s, "owner", await consignedCar(s), ENTITLEMENT))).toBeNull();
  });
});

describe("SCRUM-886 round 13 reader path: every quote line's cost gate runs", () => {
  async function singleSaleRefusal(price: number) {
    const s = await seed();
    return parsed(await payloadOf(create(s, "reader", await consignedCar(s), price)));
  }

  test("a two-line CASH quote whose line 2 is a SOURCED car priced below its supplier entitlement is refused by the cost gate as a single-line sale is, and nothing is written for any line", async () => {
    const single = await singleSaleRefusal(8_000);
    expect(single.message).toContain("against an entitlement of 8765.432");
    const s = await seed();
    const first = await consignedCar(s);
    const second = await consignedCar(s);
    const quoteId = await insertQuote(s, "reader", [{ vehicleId: first, unitPrice: ENTITLEMENT }, { vehicleId: second, unitPrice: 8_000 }]);
    const before = await worldOf(s);
    const refusal = parsed(await payloadOf(completeQuote(s, "reader", quoteId)));
    expect(refusal).toEqual(single);
    expect(await worldOf(s), "no line wrote anything").toEqual(before);
  });

  test("a three-line CASH quote whose line 3 is a SOURCED car priced below its supplier entitlement is refused by the cost gate as a single-line sale is, and nothing is written for any line", async () => {
    const single = await singleSaleRefusal(8_000);
    const s = await seed();
    const quoteId = await insertQuote(s, "reader", [
      { vehicleId: await consignedCar(s), unitPrice: ENTITLEMENT },
      { vehicleId: await consignedCar(s), unitPrice: ONE_FILS_MORE },
      { vehicleId: await consignedCar(s), unitPrice: 8_000 },
    ]);
    const before = await worldOf(s);
    const refusal = parsed(await payloadOf(completeQuote(s, "reader", quoteId)));
    expect(refusal).toEqual(single);
    expect(await worldOf(s), "no line wrote anything").toEqual(before);
  });
});

describe("SCRUM-886 round 13 rule 2: the Seat 2 two-world probe (legacy hold-less deposit on a multi-car quote)", () => {
  const SEAT_TWO_PRICE = 8_765.432;

  /**
   * A multi-car quote whose reservation deposit is a legacy row: held, naming ANOTHER car, with no `depositVehicleHolds`
   * rows. The two worlds differ only in the hidden supplier entitlement of the car being sold.
   */
  async function seatTwoWorld(entitlement: number) {
    const s = await seed();
    const other = await stockCar(s);
    const target = await consignedCar(s, entitlement);
    const quoteId = await insertQuote(s, "nonReader", [{ vehicleId: other, unitPrice: 5_000 }, { vehicleId: target, unitPrice: SEAT_TWO_PRICE }]);
    await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: other, customerId: s.customerId, quoteId, amount: SEAT_TWO_PRICE,
        amountMinor: 8_765_432, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
        createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    const sell = (who: Who) =>
      s.actors[who].mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: target, customerId: s.customerId,
        salespersonId: s.userIds[who], salePrice: SEAT_TWO_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
        quoteId, financingType: "CASH" as const, supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
      });
    return { s, target, sell };
  }

  test("a non-reader gets one byte-identical coded response in both worlds (the supplier entitlement E and E plus one fils) and nothing is written", async () => {
    const one = await seatTwoWorld(ENTITLEMENT);
    const two = await seatTwoWorld(ENTITLEMENT + 0.001);
    const beforeOne = await worldOf(one.s);
    const beforeTwo = await worldOf(two.s);
    const first = await payloadOf(one.sell("nonReader"));
    const second = await payloadOf(two.sell("nonReader"));
    expect(parsed(first).code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(second).toBe(first);
    expect(first).not.toMatch(ENTITLEMENT_LEAK);
    expect(await worldOf(one.s)).toEqual(beforeOne);
    expect(await worldOf(two.s)).toEqual(beforeTwo);
  });

  test("a view:cost_price holder with the same legacy hold-less deposit gets the unpaid-invoice refusal from the pay-first backstop, so the backstop is still the last line of defence", async () => {
    const world = await seatTwoWorld(ENTITLEMENT);
    const before = await worldOf(world.s);
    const refusal = parsed(await payloadOf(world.sell("reader")));
    expect(refusal.code).toBe(UNPAID_CODE);
    expect(await worldOf(world.s)).toEqual(before);
  });
});

describe("SCRUM-886 round 13 rule 2: the shared gate is a backstop for any future caller", () => {
  test("completeSale called directly for an actor who cannot read cost (a non-reader, and a user with no membership) on a SOURCED car is refused with the coded response at every price", async () => {
    const s = await seed();
    const stranger = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "scrum886r13_stranger", email: "stranger@test.com", name: "stranger" }));
    const payloads: Array<string | null> = [];
    for (const actorId of [s.userIds.nonReader, stranger]) {
      for (const price of PRICES) {
        const car = await consignedCar(s);
        payloads.push(
          await payloadOf(
            s.t.run((ctx) =>
              completeSale(ctx, {
                orgId: s.orgId, vehicleId: car, customerId: s.customerId, salespersonId: s.userIds.nonReader, salePrice: price,
                saleDate: Date.now(), status: "COMPLETED", supplierSettlementRoute: "DIRECT_TO_SUPPLIER", actorId,
              })
            )
          )
        );
      }
    }
    expectOneCodedRefusal(payloads, "completeSale");
  });
});

describe("SCRUM-886 round 13 rule 1: the default role templates", () => {
  test("the default ACCOUNTANT template holds view:cost_price, and so do the other templates that complete a sale", () => {
    const named = (name: string) => DEFAULT_ROLE_TEMPLATES.find((r) => r.name === name)?.permissions ?? [];
    expect(named("ACCOUNTANT")).toContain("view:cost_price");
    expect(named("SENIOR_ACCOUNTANT")).toContain("view:cost_price");
    expect(named("MANAGER")).toContain("view:cost_price");
  });

  test("no default template holds a sale-completing permission without view:cost_price", () => {
    for (const template of DEFAULT_ROLE_TEMPLATES) {
      const completes = template.permissions.includes("create:sales" as never) || template.permissions.includes("confirm:finance_disbursement" as never);
      if (completes) expect(template.permissions, template.name).toContain("view:cost_price");
    }
  });
});

describe("SCRUM-886 round 13 rule 3: saving a role", () => {
  const roleArgs = (s: Seeded, name: string, permissions: string[]) => ({ orgId: s.orgId, name, permissions });

  test("roles.create refuses create:sales without view:cost_price with a coded refusal, and stores nothing", async () => {
    const s = await seed();
    const before = await s.t.run(async (ctx) => (await ctx.db.query("roles").take(100)).length);
    const refusal = parsed(await payloadOf(s.actors.owner.mutation(api.roles.create, roleArgs(s, "Cashier", ["view:sales", "create:sales"]))));
    expect(refusal.code).toBe(ROLE_RULE_CODE);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("roles").take(100)).length)).toBe(before);
  });

  test("roles.create refuses confirm:finance_disbursement without view:cost_price with the same coded refusal", async () => {
    const s = await seed();
    const refusal = parsed(await payloadOf(s.actors.owner.mutation(api.roles.create, roleArgs(s, "Disburser", ["view:finance", "confirm:finance_disbursement"]))));
    expect(refusal.code).toBe(ROLE_RULE_CODE);
  });

  test("roles.update refuses adding create:sales without view:cost_price and leaves the stored permissions alone", async () => {
    const s = await seed();
    const roleId = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "Viewer", ["view:sales"]));
    const refusal = parsed(await payloadOf(s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, permissions: ["view:sales", "create:sales"] })));
    expect(refusal.code).toBe(ROLE_RULE_CODE);
    const stored = await s.t.run((ctx) => ctx.db.get(roleId));
    expect(stored?.permissions).toEqual(["view:sales"]);
  });

  test("roles.update refuses adding confirm:finance_disbursement without view:cost_price", async () => {
    const s = await seed();
    const roleId = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "Viewer2", ["view:finance"]));
    const refusal = parsed(await payloadOf(s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, permissions: ["view:finance", "confirm:finance_disbursement"] })));
    expect(refusal.code).toBe(ROLE_RULE_CODE);
  });

  /** Round 14: the saved role already completes sales and holds view:cost_price; the save resubmits the whole set minus it. */
  async function expectStrippingCostAccessRefused(completing: string, name: string, extra: string[]) {
    const s = await seed();
    const stored = [...extra, completing, "view:cost_price"];
    const roleId = await s.actors.owner.mutation(api.roles.create, roleArgs(s, name, stored));
    const rowBefore = await s.t.run((ctx) => ctx.db.get(roleId));
    const notificationsBefore = await s.t.run(async (ctx) => (await ctx.db.query("notifications").take(100)).length);
    expect(rowBefore?.permissions).toContain("view:cost_price");

    const submitted = stored.filter((permission) => permission !== "view:cost_price");
    const refusal = parsed(await payloadOf(s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, permissions: submitted })));

    expect(refusal).toEqual({ code: ROLE_RULE_CODE, message: (dictionaries.en as Record<string, string>)[`ServerError_${ROLE_RULE_CODE}`] });
    expect(await s.t.run((ctx) => ctx.db.get(roleId))).toEqual(rowBefore);
    expect(await s.t.run(async (ctx) => (await ctx.db.query("notifications").take(100)).length)).toBe(notificationsBefore);
  }

  test("roles.update refuses removing view:cost_price from a stored role that holds create:sales, with the coded refusal, and leaves the stored permissions alone", async () => {
    await expectStrippingCostAccessRefused("create:sales", "Cashier keeps cost", ["view:sales"]);
  });

  test("roles.update refuses removing view:cost_price from a stored role that holds confirm:finance_disbursement, with the coded refusal, and leaves the stored permissions alone", async () => {
    await expectStrippingCostAccessRefused("confirm:finance_disbursement", "Disburser keeps cost", ["view:finance"]);
  });

  test("the refusal is accepted once view:cost_price is granted with the sale-completing permission, on create and on update", async () => {
    const s = await seed();
    const createdId = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "Cashier2", ["view:sales", "create:sales", "view:cost_price"]));
    expect((await s.t.run((ctx) => ctx.db.get(createdId)))?.permissions).toContain("create:sales");
    const roleId = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "Viewer3", ["view:sales"]));
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, permissions: ["view:sales", "create:sales", "confirm:finance_disbursement", "view:cost_price"] });
    expect((await s.t.run((ctx) => ctx.db.get(roleId)))?.permissions).toContain("confirm:finance_disbursement");
  });

  test("a role without any sale-completing permission is unaffected on create and on update, and a rename alone is not refused", async () => {
    const s = await seed();
    const roleId = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "Reader only", ["view:sales", "view:vehicles"]));
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, permissions: ["view:sales", "view:vehicles", "view:customers"] });
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, name: "Reader only renamed" });
    expect((await s.t.run((ctx) => ctx.db.get(roleId)))?.name).toBe("Reader only renamed");
  });

  test("a stored role that already holds create:sales without view:cost_price can be renamed (existing roles are not migrated)", async () => {
    const s = await seed();
    const legacy = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "Legacy cashier", permissions: ["view:sales", "create:sales"] }));
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId: legacy, name: "Legacy cashier 2" });
    expect((await s.t.run((ctx) => ctx.db.get(legacy)))?.permissions).toEqual(["view:sales", "create:sales"]);
  });

  test("the role-save refusal has English and Arabic text in the dictionary, and the English text equals the server message", async () => {
    const s = await seed();
    const refusal = parsed(await payloadOf(s.actors.owner.mutation(api.roles.create, roleArgs(s, "Cashier3", ["create:sales"]))));
    const entry = (dictionaries.en as Record<string, string>)[`ServerError_${ROLE_RULE_CODE}`];
    const ar = (dictionaries.ar as Record<string, string>)[`ServerError_${ROLE_RULE_CODE}`];
    expect(entry).toBeTruthy();
    expect(refusal.message).toBe(entry);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(entry);
  });
});

describe("SCRUM-886 round 13 rule 4: the ACCOUNTANT backfill (an internal mutation, run by the Deploy production rollout on every deploy, SCRUM-896)", () => {
  async function seededRoles() {
    const s = await seed();
    const accountantTemplate = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "ACCOUNTANT")?.permissions ?? [];
    const withoutCost = accountantTemplate.filter((p) => p !== "view:cost_price");
    const lacking = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "ACCOUNTANT", permissions: [...withoutCost] }));
    const holding = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: " Accountant ", permissions: [...withoutCost, "view:cost_price"] }));
    const deleted = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "ACCOUNTANT", permissions: [...withoutCost], isDeleted: true }));
    const custom = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "Cashier", permissions: ["view:sales", "create:sales"] }));
    return { s, lacking, holding, deleted, custom, withoutCost };
  }
  const permissionsOf = (s: Seeded, id: Id<"roles">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.permissions ?? []);

  test("the backfill adds view:cost_price to an ACCOUNTANT role lacking it", async () => {
    const { s, lacking } = await seededRoles();
    const result = await s.t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
    expect(result.updatedCount).toBe(1);
    expect(await permissionsOf(s, lacking)).toContain("view:cost_price");
  });

  test("the backfill skips an ACCOUNTANT role that already holds view:cost_price, a deleted ACCOUNTANT role and a custom role", async () => {
    const { s, holding, deleted, custom, withoutCost } = await seededRoles();
    const holdingBefore = await permissionsOf(s, holding);
    await s.t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
    expect(await permissionsOf(s, holding)).toEqual(holdingBefore);
    expect(await permissionsOf(s, deleted)).toEqual([...withoutCost]);
    expect(await permissionsOf(s, custom)).toEqual(["view:sales", "create:sales"]);
  });

  test("the backfill is idempotent: a second run changes nothing", async () => {
    const { s, lacking } = await seededRoles();
    await s.t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
    const once = await permissionsOf(s, lacking);
    const second = await s.t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
    expect(second.updatedCount).toBe(0);
    expect(await permissionsOf(s, lacking)).toEqual(once);
  });

  test("the backfill is bounded: a page of one row touches at most one role and the cursor walks the rest", async () => {
    const { s, lacking } = await seededRoles();
    const second = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "ACCOUNTANT", permissions: ["view:finance", "confirm:finance_disbursement"] }));
    let cursor: string | null = null;
    let updated = 0;
    let pages = 0;
    for (;;) {
      const page: { updatedCount: number; isDone: boolean; continueCursor: string } = await s.t.mutation(
        internal.migrateRoles.backfillAccountantCostPriceAccess, { numItems: 1, cursor }
      );
      expect(page.updatedCount).toBeLessThanOrEqual(1);
      updated += page.updatedCount;
      pages += 1;
      if (page.isDone) break;
      cursor = page.continueCursor;
      expect(pages).toBeLessThan(50);
    }
    expect(updated).toBe(2);
    expect(await permissionsOf(s, lacking)).toContain("view:cost_price");
    expect(await permissionsOf(s, second)).toContain("view:cost_price");
  });

  test("the backfill leaves an ACCOUNTANT-named role that cannot complete a sale alone: no sale-completing permission, no grant", async () => {
    const { s } = await seededRoles();
    const readOnly = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "ACCOUNTANT", permissions: ["view:finance"] }));
    const result = await s.t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
    expect(result.updatedCount).toBe(1);
    expect(await permissionsOf(s, readOnly)).toEqual(["view:finance"]);
  });

});

/**
 * SCRUM-896 Seat 1 round 1 finding R1-F1 and Seat 2 finding R3-F1, both at ccd2f7647. The backfill runs on EVERY Deploy production
 * rollout (owner ruling c24372), so it must not override a role the org owner saved or created. Invariant: once an owner has saved a
 * role's permissions, they change only through an owner action or a one-time repair the owner approved, never through a recurring
 * system job. The pair `manage:finance` + `view:cost_price` unlocks `vehicles.correctAcquisitionCost`, a GL-posting door, and
 * `view:cost_price` alone unlocks the cost read, so each "not granted" row proves both public cost doors stay closed.
 *
 * The owner acts only through the public `roles.create`, `roles.update` and `roles.remove` doors. The one direct insert is the
 * legacy default ACCOUNTANT (the default template minus `view:cost_price`, as seeded before round 13): no door can create it.
 */
describe("SCRUM-896 R1-F1 / R3-F1: the per-deploy ACCOUNTANT backfill repairs only the legacy sale-completing ACCOUNTANT", () => {
  const FINANCE_CUSTOM = ["view:vehicles", "view:finance", "manage:finance"];
  const roleArgs = (s: Seeded, name: string, permissions: string[]) => ({ orgId: s.orgId, name, permissions });
  const runBackfill = (s: Seeded) => s.t.mutation(internal.migrateRoles.backfillAccountantCostPriceAccess, {});
  const permissionsOf = (s: Seeded, id: Id<"roles">) => s.t.run(async (ctx) => (await ctx.db.get(id))?.permissions ?? []);
  const costDoors = (s: Seeded, actor: Seeded["actors"]["owner"], vehicleId: Id<"vehicles">) => ({
    read: () => actor.query(api.vehicles.get, { orgId: s.orgId, vehicleId }),
    correctionContext: () => actor.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: s.orgId, vehicleId }),
  });

  /** The default ACCOUNTANT template, which holds `confirm:finance_disbursement`, less `view:cost_price`. */
  function legacyDefaultPermissions(): string[] {
    const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "ACCOUNTANT")?.permissions ?? [];
    expect(template).toContain("confirm:finance_disbursement");
    expect(template).toContain("view:vehicles");
    return template.filter((p) => p !== "view:cost_price");
  }
  async function insertLegacyAccountant(s: Seeded, orgId = s.orgId): Promise<Id<"roles">> {
    return await s.t.run((ctx) => ctx.db.insert("roles", { orgId, name: "ACCOUNTANT", permissions: legacyDefaultPermissions() }));
  }
  async function memberIn(s: Seeded, roleId: Id<"roles">, clerkId: string, orgId = s.orgId) {
    const userId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return s.t.withIdentity({ subject: clerkId, clerkId });
  }
  async function expectCostWithheld(s: Seeded, actor: Seeded["actors"]["owner"], vehicleId: Id<"vehicles">) {
    const doors = costDoors(s, actor, vehicleId);
    const vehicle = await doors.read();
    expect(vehicle.purchasePrice).toBeUndefined();
    expect(parsed(await payloadOf(doors.correctionContext()))).toEqual(FORBIDDEN_MISSING_COST_ACCESS);
  }

  // Row (6): the positive control. Without it, "never grants" would pass for a backfill that does nothing.
  test("positive control: the legacy default ACCOUNTANT is repaired and a member in it can then read vehicle cost", async () => {
    const s = await seed();
    const roleId = await insertLegacyAccountant(s);
    const vehicleId = await stockCar(s);
    const actor = await memberIn(s, roleId, "scrum896_legacy_member");
    await expectCostWithheld(s, actor, vehicleId);

    const result = await runBackfill(s);

    expect(result.updatedCount).toBe(1);
    expect(await permissionsOf(s, roleId)).toContain("view:cost_price");
    const doors = costDoors(s, actor, vehicleId);
    expect((await doors.read()).purchasePrice).toBe(5_000);
    expect(await payloadOf(doors.correctionContext())).toBeNull();
  });

  // Row (1): Seat 2's reproduction.
  test("an owner renames the seeded ACCOUNTANT, then creates a custom role named ACCOUNTANT without completing permissions: the backfill does not grant it and cost stays withheld", async () => {
    const s = await seed();
    const original = await insertLegacyAccountant(s);
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId: original, name: "Senior bookkeeper" });
    const custom = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "ACCOUNTANT", FINANCE_CUSTOM));
    const vehicleId = await stockCar(s);
    const actor = await memberIn(s, custom, "scrum896_custom_accountant");
    const originalBefore = await permissionsOf(s, original);

    const result = await runBackfill(s);

    expect(result.updatedCount).toBe(0);
    expect(await permissionsOf(s, custom)).toEqual(FINANCE_CUSTOM);
    expect(await permissionsOf(s, original)).toEqual(originalBefore);
    await expectCostWithheld(s, actor, vehicleId);
  });

  // Row (2)
  test("an owner renames an existing custom role to ACCOUNTANT: the backfill does not grant it and cost stays withheld", async () => {
    const s = await seed();
    const custom = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "Bookkeeper", FINANCE_CUSTOM));
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId: custom, name: "ACCOUNTANT" });
    const vehicleId = await stockCar(s);
    const actor = await memberIn(s, custom, "scrum896_renamed_custom");

    const result = await runBackfill(s);

    expect(result.updatedCount).toBe(0);
    expect(await permissionsOf(s, custom)).toEqual(FINANCE_CUSTOM);
    await expectCostWithheld(s, actor, vehicleId);
  });

  // Row (3) is Seat 1's R1-F1 causal chain.
  test("an owner strips view:cost_price and both sale-completing permissions from a repaired ACCOUNTANT: the next deploy run does not restore it and cost stays withheld", async () => {
    const s = await seed();
    const roleId = await insertLegacyAccountant(s);
    const vehicleId = await stockCar(s);
    const actor = await memberIn(s, roleId, "scrum896_stripped_member");

    const firstDeploy = await runBackfill(s);
    expect(firstDeploy.updatedCount).toBe(1);
    expect(await permissionsOf(s, roleId)).toContain("view:cost_price");

    const restricted = legacyDefaultPermissions().filter((p) => p !== "create:sales" && p !== "confirm:finance_disbursement");
    await s.actors.owner.mutation(api.roles.update, { orgId: s.orgId, roleId, permissions: restricted });
    const savedByOwner = await permissionsOf(s, roleId);
    expect(savedByOwner).not.toContain("view:cost_price");
    expect(savedByOwner).not.toContain("create:sales");
    expect(savedByOwner).not.toContain("confirm:finance_disbursement");

    const nextDeploy = await runBackfill(s);

    expect(nextDeploy.updatedCount).toBe(0);
    expect(await permissionsOf(s, roleId)).toEqual(savedByOwner);
    await expectCostWithheld(s, actor, vehicleId);
  });

  // Row (3b): the template-sync writer (memberships.syncRolePermissionsToTemplate). It writes the template verbatim, and no
  // template is in the repaired state, so the sync and the per-deploy run never fight over a role.
  test("an owner syncs a legacy ACCOUNTANT to the template: the template grants view:cost_price and the next deploy run changes nothing", async () => {
    const s = await seed();
    const roleId = await insertLegacyAccountant(s);
    const vehicleId = await stockCar(s);
    const actor = await memberIn(s, roleId, "scrum896_template_sync_member");
    const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "ACCOUNTANT")?.permissions ?? [];
    expect(template).toContain("view:cost_price");

    await s.actors.owner.mutation(api.memberships.syncRolePermissionsToTemplate, { orgId: s.orgId });
    expect(await permissionsOf(s, roleId)).toEqual([...template]);

    const nextDeploy = await runBackfill(s);

    expect(nextDeploy.updatedCount).toBe(0);
    expect(await permissionsOf(s, roleId)).toEqual([...template]);
    expect((await costDoors(s, actor, vehicleId).read()).purchasePrice).toBe(5_000);
  });

  // Row (4)
  test("an owner deletes the unassigned ACCOUNTANT and recreates a role with that name without completing permissions: the backfill does not grant it and cost stays withheld", async () => {
    const s = await seed();
    const original = await insertLegacyAccountant(s);
    await s.actors.owner.mutation(api.roles.remove, { orgId: s.orgId, roleId: original });
    const recreated = await s.actors.owner.mutation(api.roles.create, roleArgs(s, "ACCOUNTANT", FINANCE_CUSTOM));
    const vehicleId = await stockCar(s);
    const actor = await memberIn(s, recreated, "scrum896_recreated_member");
    const deletedBefore = await s.t.run((ctx) => ctx.db.get(original));
    expect(deletedBefore?.isDeleted).toBe(true);

    const result = await runBackfill(s);

    expect(result.updatedCount).toBe(0);
    expect(await permissionsOf(s, recreated)).toEqual(FINANCE_CUSTOM);
    expect(await s.t.run((ctx) => ctx.db.get(original))).toEqual(deletedBefore);
    await expectCostWithheld(s, actor, vehicleId);
  });

  // Row (5)
  test("two organizations in one run: the legacy default ACCOUNTANT in each is repaired and a custom ACCOUNTANT-named role in a third is not", async () => {
    const s = await seed();
    async function addOrg(label: string) {
      const orgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: `Org ${label}`, createdAt: Date.now() }));
      await s.t.run((ctx) =>
        ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
      );
      const clerkId = `scrum896_owner_${label}`;
      const userId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId }));
      const roleId = await s.t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true })
      );
      await s.t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      return { orgId, owner: s.t.withIdentity({ subject: clerkId, clerkId }) };
    }
    const orgB = await addOrg("b");
    const orgC = await addOrg("c");
    const legacyA = await insertLegacyAccountant(s);
    const legacyB = await insertLegacyAccountant(s, orgB.orgId);
    const customC = await orgC.owner.mutation(api.roles.create, { orgId: orgC.orgId, name: "ACCOUNTANT", permissions: FINANCE_CUSTOM });

    const result = await runBackfill(s);

    expect(result.updatedCount).toBe(2);
    expect(await permissionsOf(s, legacyA)).toContain("view:cost_price");
    expect(await permissionsOf(s, legacyB)).toContain("view:cost_price");
    expect(await permissionsOf(s, customC)).toEqual(FINANCE_CUSTOM);
  });
});


/**
 * SCRUM-886 round 14b rule 4 (owner ruling SCRUM-886 comment 24368, option A, 2026-11-02). The default ACCOUNTANT template holds
 * `manage:finance` and, since round 13, `view:cost_price`, so it passes the `vehicles.correctAcquisitionCost` gate, which needs both
 * together (COST_CORRECTION_PERMISSIONS). That mutation posts GL corrections. Before this PR only SENIOR_ACCOUNTANT and the system
 * owner could run it: the default MANAGER template holds `view:cost_price` but not `manage:finance`, so MANAGER stays refused. The
 * owner allowed the ACCOUNTANT widening and recorded it in the ADR role policy; these tests prove it end to end through the public
 * mutation, including that the `manage:finance` half of the gate still refuses MANAGER. The templates are read from the exported
 * DEFAULT_ROLE_TEMPLATES, never copied.
 */
const ORIGINAL_COST = 12_500;
const CORRECTED_COST = 9_800;
const FORBIDDEN_MISSING_COST_ACCESS = {
  code: "FORBIDDEN",
  message: "Forbidden: Missing required permissions: view:cost_price",
};
const FORBIDDEN_MISSING_FINANCE_MANAGEMENT = {
  code: "FORBIDDEN",
  message: "Forbidden: Missing required permissions: manage:finance",
};

async function seedCostCorrectionDealer() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Cost Correction Role Dealer", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const ownerUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "scrum886r14b_owner", email: "owner14b@test.com", name: "Owner" }));
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerUserId, roleId: ownerRoleId }));
  const asOwner = t.withIdentity({ subject: "scrum886r14b_owner", clerkId: "scrum886r14b_owner" });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2035, 11, 31, 23, 59, 59, 999), fiscalYear: 2025, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  // A dealer-owned, cash-acquired car whose acquisition posted into a period that is now closed: the only situation in which a
  // PRIOR_PERIOD_RESTATEMENT is accepted (SCRUM-725).
  const vehicleId = await asOwner.mutation(api.vehicles.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vin: "1HGCM82633A886014", make: "Honda", model: "Accord", year: 2020, mileage: 10_000,
    color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20_000, status: "AVAILABLE" as const,
    sourceType: "STOCK" as const, purchasePrice: ORIGINAL_COST, purchasePaymentMethod: "CASH" as const,
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("accountingPeriods", {
      orgId, startDate: Date.UTC(2019, 0, 1), endDate: Date.UTC(2019, 11, 31, 23, 59, 59, 999),
      fiscalYear: 2019, periodNumber: 1, status: "CLOSED", createdAt: Date.now(),
    });
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString()))
      .take(50);
    for (const event of events) {
      if (event.eventType === "VEHICLE_ACQUIRED") await ctx.db.patch(event._id, { accountingDate: Date.UTC(2019, 5, 15) });
    }
  });
  return { t, orgId, vehicleId };
}
type CostCorrectionDealer = Awaited<ReturnType<typeof seedCostCorrectionDealer>>;

/** A member whose stored role holds a default role template's permissions, less any named, as a role saved before round 13 would. */
async function memberFromTemplate(d: CostCorrectionDealer, templateName: string, clerkId: string, without: readonly string[]) {
  const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === templateName);
  if (!template) throw new Error(`no ${templateName} role template`);
  const userId = await d.t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: templateName }));
  const roleId = await d.t.run((ctx) =>
    ctx.db.insert("roles", { orgId: d.orgId, name: `${templateName} ${clerkId}`, permissions: template.permissions.filter((p) => !without.includes(p)) })
  );
  await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId, roleId }));
  return { userId, actor: d.t.withIdentity({ subject: clerkId, clerkId }) };
}

function accountantFromTemplate(d: CostCorrectionDealer, clerkId: string, without: readonly string[]) {
  return memberFromTemplate(d, "ACCOUNTANT", clerkId, without);
}

async function costCorrectionWorld(d: CostCorrectionDealer) {
  return d.t.run(async (ctx) => ({
    purchasePrice: (await ctx.db.get(d.vehicleId))?.purchasePrice,
    corrections: (await ctx.db.query("vehicleCostCorrections").take(1000)).length,
    events: (await ctx.db.query("accountingEvents").take(1000)).length,
    pending: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    journalEntries: (await ctx.db.query("journalEntries").take(1000)).length,
    journalLines: (await ctx.db.query("journalLines").take(1000)).length,
    financialAudit: (await ctx.db.query("financialAuditLog").take(1000)).length,
  }));
}

describe("SCRUM-886 round 14b rule 4: acquisition-cost correction by the default ACCOUNTANT (owner ruling c24368)", () => {
  test("the default ACCOUNTANT template runs vehicles.correctAcquisitionCost as PRIOR_PERIOD_RESTATEMENT and the vehicle cost changes", async () => {
    const d = await seedCostCorrectionDealer();
    const { userId, actor } = await accountantFromTemplate(d, "scrum886r14b_accountant", []);
    const before = await costCorrectionWorld(d);
    expect(before.purchasePrice).toBe(ORIGINAL_COST);

    await actor.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId: d.vehicleId, newCost: CORRECTED_COST, reason: "Purchase price was recorded wrong",
      correctionType: "PRIOR_PERIOD_RESTATEMENT" as const,
    });

    const after = await costCorrectionWorld(d);
    expect(after.purchasePrice).toBe(CORRECTED_COST);
    expect(after.corrections).toBe(before.corrections + 1);
    expect(after.journalEntries).toBe(before.journalEntries + 1);
    const rows = await d.t.run((ctx) =>
      ctx.db.query("vehicleCostCorrections").withIndex("by_org_vehicle", (q) => q.eq("orgId", d.orgId).eq("vehicleId", d.vehicleId)).take(10)
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      previousCost: ORIGINAL_COST, newCost: CORRECTED_COST, correctionType: "PRIOR_PERIOD_RESTATEMENT", correctedBy: userId,
    });
    const entries = await d.t.run((ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).take(1000)
    );
    expect(entries.filter((e) => e.sourceType === "vehicleCostCorrections")).toHaveLength(1);
  });

  test("a legacy stored ACCOUNTANT without view:cost_price is refused FORBIDDEN at vehicles.correctAcquisitionCost and nothing is written", async () => {
    const d = await seedCostCorrectionDealer();
    const { actor } = await accountantFromTemplate(d, "scrum886r14b_legacy", ["view:cost_price"]);
    const before = await costCorrectionWorld(d);

    const refusal = parsed(await payloadOf(actor.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId: d.vehicleId, newCost: CORRECTED_COST, reason: "Purchase price was recorded wrong",
      correctionType: "PRIOR_PERIOD_RESTATEMENT" as const,
    })));

    expect(refusal).toEqual(FORBIDDEN_MISSING_COST_ACCESS);
    expect(await costCorrectionWorld(d)).toEqual(before);
    expect(before.purchasePrice).toBe(ORIGINAL_COST);
  });

  test("the default MANAGER template holds view:cost_price but not manage:finance, is refused FORBIDDEN at vehicles.correctAcquisitionCost and nothing is written", async () => {
    const d = await seedCostCorrectionDealer();
    const manager = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === "MANAGER");
    expect(manager?.permissions).toContain("view:cost_price");
    expect(manager?.permissions).not.toContain("manage:finance");
    const { actor } = await memberFromTemplate(d, "MANAGER", "scrum886r15_manager", []);
    const before = await costCorrectionWorld(d);

    const refusal = parsed(await payloadOf(actor.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: d.orgId, vehicleId: d.vehicleId, newCost: CORRECTED_COST, reason: "Purchase price was recorded wrong",
      correctionType: "PRIOR_PERIOD_RESTATEMENT" as const,
    })));

    expect(refusal).toEqual(FORBIDDEN_MISSING_FINANCE_MANAGEMENT);
    expect(await costCorrectionWorld(d)).toEqual(before);
    expect(before.purchasePrice).toBe(ORIGINAL_COST);
  });
});