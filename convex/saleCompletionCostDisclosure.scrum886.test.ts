/**
 * SCRUM-886 round 10 (OWASP API3:2023, property-level authorization: what the OUTCOME of a mutation
 * discloses). Both review seats found that a sale completion on a consigned (SOURCED) car, refused
 * because the supplier would be paid less than his entitlement, put the stored supplier entitlement
 * (the vehicle's frozen `sourceCost`, a COST-tier value) into a `ConvexError`. A `ConvexError` is
 * sent to the client unredacted in production. `create:sales` alone reaches it through
 * `sales.create`, `sales.completeDraft` and `sales.completeFromQuote` (and `confirm:finance_disbursement`
 * through `applications.finalizeDeal`, which calls the same `completeSale`); a CASH sale skips the
 * minimum-profit approval, so nothing stops the request first.
 *
 * Rule: a caller who may not read vehicle cost (no `view:cost_price`, not the system owner) is
 * refused with the coded, amount-free `CONSIGNED_SALE_NEEDS_COST_ACCESS`; the detailed sentence stays
 * for cost readers and the system owner. The refusal is kept (it protects the books) and writes
 * nothing. The role is derived on the server from the authenticated actor's membership, never from
 * a client argument.
 *
 * Every test goes through a public mutation. Expected values are literals taken from the seeded rows:
 * a supplier entitlement of 8,765.432 JOD (8765432 fils) and submitted prices of 8,000 and 8,001 JOD.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { supplierIdInCtx } from "../test-utils/supplierFixture";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import { actorMayReadVehicleCost } from "./utils/vehicleCostVisibility";

const NEEDS_COST_ACCESS_CODE = "CONSIGNED_SALE_NEEDS_COST_ACCESS";
const ENTITLEMENT = 8_765.432;
const PRICE_BELOW_A = 8_000;
const PRICE_BELOW_B = 8_001;
const PRICE_AT_ENTITLEMENT = 8_765.432;

const SALES_NO_COST = ["view:sales", "create:sales", "view:vehicles", "view:customers"];
const SALES_WITH_COST = [...SALES_NO_COST, "view:cost_price"];
const FINANCE_NO_COST = [...SALES_NO_COST, "manage:finance", "view:finance", "confirm:finance_disbursement"];

type Who = "owner" | "nonReader" | "reader" | "financeNonReader";

async function seed() {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Sale Cost Disclosure", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );
  const specs: Record<Who, string[] | "owner"> = {
    owner: "owner", nonReader: SALES_NO_COST, reader: SALES_WITH_COST, financeNonReader: FINANCE_NO_COST,
  };
  const actors = {} as Record<Who, ReturnType<typeof t.withIdentity>>;
  const userIds = {} as Record<Who, Id<"users">>;
  for (const who of Object.keys(specs) as Who[]) {
    const clerkId = `scrum886s_${who}`;
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: who }));
    const spec = specs[who];
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", spec === "owner"
        ? { orgId, name: SYSTEM_OWNER_ROLE_NAME, permissions: [], isSystemOwnerRole: true }
        : { orgId, name: `Role ${who}`, permissions: spec })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    actors[who] = t.withIdentity({ subject: clerkId, clerkId });
    userIds[who] = userId;
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Disclosure" }));
  return { t, orgId, actors, userIds, customerId };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

afterEach(() => vi.useRealTimers());

let vinCounter = 0;
/** A consigned car. `sourceCost` null models a car whose supplier amount was never recorded. */
async function consignedCar(s: Seeded, sourceCost: number | null = ENTITLEMENT): Promise<Id<"vehicles">> {
  vinCounter += 1;
  return await s.t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VIN886SALE${String(vinCounter).padStart(6, "0")}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE",
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourcedSupplierId: await supplierIdInCtx(ctx, s.orgId, "Amman Importer Co"),
      ...(sourceCost !== null ? { sourceCost } : {}),
    })
  );
}

/**
 * A CASH completion on the DIRECT_TO_SUPPLIER route: the buyer pays the supplier, the dealership bills the customer
 * nothing for the car, so the SCRUM-802 pay-first gate has nothing to demand and the request reaches the shortfall
 * check with no deposit. (On THROUGH_DEALERSHIP the pay-first gate refuses first unless a deposit covers the invoice.)
 */
const create = (s: Seeded, who: Who, vehicleId: Id<"vehicles">, salePrice: number) =>
  s.actors[who].mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId,
    salespersonId: s.userIds[who], salePrice, saleDate: Date.now(), status: "COMPLETED" as const,
    supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
  });

async function worldOf(s: Seeded, vehicleId: Id<"vehicles">) {
  return s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").take(1000)).length,
    commands: (await ctx.db.query("commandIdempotency").take(1000)).length,
    queued: (await ctx.db.query("pendingAccountingEvents").take(1000)).length,
    payables: (await ctx.db.query("vehicleSupplierPayables").take(1000)).length,
    vehicle: await ctx.db.get(vehicleId),
  }));
}

/** Any rendering of the entitlement, as major units, minor units, or grouped thousands. */
const ENTITLEMENT_LEAK = /8[,. ]?765|765[.,]?432|8765432/;

describe("SCRUM-886 round 10: a sale refused below the supplier's entitlement discloses no cost to a non-reader", () => {
  test("a create:sales caller without view:cost_price gets one coded refusal that names no amount, at any submitted price", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const a = await refusalDataOf(create(s, "nonReader", car, PRICE_BELOW_A));
    const b = await refusalDataOf(create(s, "nonReader", car, PRICE_BELOW_B));
    expect(a?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(b).toEqual(a);
    expect(a?.message).not.toMatch(ENTITLEMENT_LEAK);
    expect(a?.message).not.toMatch(/entitle|8000|8001|8,000|8,001/i);
  });

  test("the refusal does not vary with how far below the entitlement the price is (1 JOD, and one fils short)", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const far = await refusalDataOf(create(s, "nonReader", car, 1));
    const oneFilsShort = await refusalDataOf(create(s, "nonReader", car, 8_765.431));
    expect(far?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(oneFilsShort).toEqual(far);
    expect(far?.message).not.toMatch(ENTITLEMENT_LEAK);
  });

  test("a finance-authority role without view:cost_price is still a non-reader: the rule is the cost permission", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const refusal = await refusalDataOf(create(s, "financeNonReader", car, PRICE_BELOW_A));
    expect(refusal?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(refusal?.message).not.toMatch(ENTITLEMENT_LEAK);
  });

  test("the refusal writes nothing: no sale, no command row, no queued event, no payable, vehicle unchanged", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const before = await worldOf(s, car);
    await refusalDataOf(create(s, "nonReader", car, PRICE_BELOW_A));
    await refusalDataOf(create(s, "nonReader", car, PRICE_BELOW_B));
    expect(await worldOf(s, car)).toEqual(before);
    expect(before.sales).toBe(0);
    expect(before.vehicle?.status).toBe("AVAILABLE");
  });

  test("a car whose supplier amount was never recorded gets the same coded refusal, so presence is not a signal either", async () => {
    const s = await seed();
    const noCost = await consignedCar(s, null);
    const withCost = await consignedCar(s);
    const missing = await refusalDataOf(create(s, "nonReader", noCost, PRICE_BELOW_A));
    const short = await refusalDataOf(create(s, "nonReader", withCost, PRICE_BELOW_A));
    expect(missing?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(short).toEqual(missing);
  });

  test("sales.completeDraft (a seeded draft) is refused the same way and the draft stays PENDING", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: car, customerId: s.customerId, salespersonId: s.userIds.nonReader,
        salePrice: PRICE_BELOW_A, saleDate: Date.now(), status: "PENDING", financingType: "CASH",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      })
    );
    const refusal = await refusalDataOf(
      s.actors.nonReader.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId, idempotencyKey: crypto.randomUUID() })
    );
    expect(refusal?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(refusal?.message).not.toMatch(ENTITLEMENT_LEAK);
    const draft = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(draft?.status).toBe("PENDING");
  });

  test("sales.completeFromQuote (a cash quote below the entitlement) is refused the same way", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId: car, mode: "CASH", vehiclePrice: PRICE_BELOW_A,
        downPayment: 0, termMonths: 0, status: "ACCEPTED", createdBy: s.userIds.nonReader, createdAt: Date.now(),
      })
    );
    const refusal = await refusalDataOf(
      s.actors.nonReader.mutation(api.sales.completeFromQuote, {
        orgId: s.orgId, quoteId, supplierSettlementRoute: "DIRECT_TO_SUPPLIER", idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal?.code).toBe(NEEDS_COST_ACCESS_CODE);
    expect(refusal?.message).not.toMatch(ENTITLEMENT_LEAK);
    expect((await worldOf(s, car)).sales).toBe(0);
  });

  test("control: the system owner still gets the detailed sentence, with the entitlement", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const refusal = await refusalDataOf(create(s, "owner", car, PRICE_BELOW_A));
    expect(refusal?.code).toBeUndefined();
    expect(refusal?.message).toContain("against an entitlement of 8765.432");
    expect(refusal?.message).toContain("only being paid 8000");
  });

  test("control: a view:cost_price holder still gets the detailed sentence, with the entitlement", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const refusal = await refusalDataOf(create(s, "reader", car, PRICE_BELOW_A));
    expect(refusal?.code).toBeUndefined();
    expect(refusal?.message).toContain("against an entitlement of 8765.432");
  });

  test("control: a reader on a car with no recorded supplier amount still gets the specific sentence", async () => {
    const s = await seed();
    const noCost = await consignedCar(s, null);
    const refusal = await refusalDataOf(create(s, "reader", noCost, PRICE_BELOW_A));
    expect(refusal?.message).toContain("no supplier cost is recorded");
  });

  test("control: the shortfall refusal still fires for every role, so no one can sell below the entitlement", async () => {
    const s = await seed();
    for (const who of ["owner", "reader", "nonReader", "financeNonReader"] as const) {
      const car = await consignedCar(s);
      const refusal = await refusalDataOf(create(s, who, car, PRICE_BELOW_A));
      expect(refusal, who).not.toBeNull();
      expect((await worldOf(s, car)).sales, who).toBe(0);
    }
  });

  test("control: a sale at the entitlement completes for a non-reader (the refusal is not widened)", async () => {
    const s = await seed();
    const car = await consignedCar(s);
    const saleId = await create(s, "nonReader", car, PRICE_AT_ENTITLEMENT);
    const world = await worldOf(s, car);
    expect(saleId).toBeTruthy();
    expect(world.sales).toBe(1);
    expect(world.vehicle?.status).toBe("SOLD");
  });
});

describe("SCRUM-886 round 10: actorMayReadVehicleCost derives the answer from the membership and fails closed", () => {
  test("the system owner and a view:cost_price holder may read; sales and finance roles without it may not", async () => {
    const s = await seed();
    const answer = (who: Who) => s.t.run((ctx) => actorMayReadVehicleCost(ctx, s.orgId, s.userIds[who]));
    expect(await answer("owner")).toBe(true);
    expect(await answer("reader")).toBe(true);
    expect(await answer("nonReader")).toBe(false);
    expect(await answer("financeNonReader")).toBe(false);
  });

  test("no actor, no membership, an offboarding membership, and a cost role from another organization all answer false", async () => {
    const s = await seed();
    const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other Org", createdAt: Date.now() }));
    const costRoleOther = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "Cost elsewhere", permissions: SALES_WITH_COST })
    );
    const strangerId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "scrum886s_stranger", email: "stranger@test.com", name: "stranger" }));
    const elsewhereId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "scrum886s_elsewhere", email: "elsewhere@test.com", name: "elsewhere" }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: elsewhereId, roleId: costRoleOther }));
    const leavingId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "scrum886s_leaving", email: "leaving@test.com", name: "leaving" }));
    const costRole = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "Cost leaving", permissions: SALES_WITH_COST }));
    await s.t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: s.orgId, userId: leavingId, roleId: costRole, offboardingStatus: "PENDING_EXTERNAL_REMOVAL" })
    );
    // A membership of this organization whose role row belongs to another organization is not a cost role here.
    const misfiledId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "scrum886s_misfiled", email: "misfiled@test.com", name: "misfiled" }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: misfiledId, roleId: costRoleOther }));
    const answer = (userId: Id<"users"> | undefined) => s.t.run((ctx) => actorMayReadVehicleCost(ctx, s.orgId, userId));
    expect(await answer(misfiledId)).toBe(false);
    expect(await answer(undefined)).toBe(false);
    expect(await answer(strangerId)).toBe(false);
    expect(await answer(elsewhereId)).toBe(false);
    expect(await answer(leavingId)).toBe(false);
  });
});