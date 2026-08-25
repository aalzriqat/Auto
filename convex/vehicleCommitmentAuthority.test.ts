import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { anyApi, FunctionReference } from "convex/server";
import { getActiveDepositHolds } from "./utils/depositHelpers";

/**
 * SCRUM-195 — THE BLOCKING IMPLEMENTATION CORPUS (owner ruling c14865).
 *
 * The design-only phase is closed. `9ea30044441800931751933ce5579c52307b797a`
 * is frozen failure evidence, not this branch's base and not a complete spec.
 * Every Round-10 HIGH is carried forward here as a blocking failing-first test,
 * together with the older binding rulings the 21-test design artefact never
 * encoded.
 *
 * ## The model these contracts encode
 *
 * One physical vehicle is one physical unit, and at most one logical
 * **commitment ROOT** may hold it. Root identity is **server-owned**: it is
 * never `(customerId, vehicleId)`, never a row count, and never inferred from
 * two facts happening to share a customer. `quoteId` is lineage PROOF, not
 * identity.
 *
 * `vehicle.status` is an **advisory projection** of that authority — useful to
 * the UI and to legacy callers, never the lock. Section 9 pins that down
 * directly: forcing the status does not move the authority.
 *
 * ## What the Round-10 review proved, and why these tests exist
 *
 * Three HIGH findings survived adjudication, all of the same shape — *a wrong
 * implementation could pass*:
 *
 *   1. no contract separated a root-keyed authority from a customer-keyed one,
 *      because every refusal changed the customer AND the quote together while
 *      every acceptance changed neither. **Section 1.1 is that missing test.**
 *   2. the root-identity postcondition compared `String(rootId)`, and
 *      `String(undefined)` is `"undefined"` — truthy, and equal to itself — so
 *      a resolver that never minted a root passed. **Section 1.3 asserts a
 *      real, non-null id and compares raw values.**
 *   3. every refusal omitted `quoteId` while every positive control supplied
 *      it, so "refuse when no quoteId was passed" satisfied the whole
 *      SCRUM-196 set. **Section 5 tests omitted AND unrelated proof.**
 *
 * ## Two corrections c14865 made to my own adjudication, encoded here
 *
 * - **C.4 was not canonical.** I argued that because `vehicleReservations`
 *   carries no quote/root field, no implementation could require reservation
 *   lineage, so same-customer had to imply same-deal. That inverts the
 *   direction: the missing field is a **pending surface to build**, not
 *   permission to infer a root from a customer. Section 4 builds it —
 *   reserve → explicit adopt → same-root — and Section 4.4 proves that omitted
 *   proof stays independent lineage and cannot consume a live reservation.
 * - **An ACTIVE finance commitment DOES project `RESERVED`.** The design file
 *   asserted a finance-held car must read `AVAILABLE`; that assumption is
 *   removed. Section 3 asserts the car was **not consumed**, which is the
 *   behaviour that matters, rather than pinning a status the implementation is
 *   entitled to set.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

type UnbuiltMutation = FunctionReference<"mutation", "public", Record<string, unknown>, unknown>;
type UnbuiltQuery = FunctionReference<"query", "public", Record<string, unknown>, unknown>;
const notYetBuilt = anyApi as unknown as Record<string, Record<string, UnbuiltMutation>>;
const notYetBuiltQuery = anyApi as unknown as Record<string, Record<string, UnbuiltQuery>>;

const PRICE = 28_000;

/** Every refusal in this corpus must be a COMMITMENT refusal, not an incidental guard. */
const REFUSED = /committed|another deal|another customer|already held|no longer available|held by|reserv|application/i;
/** Lineage-proof refusals name the proof, not the holder. */
const BAD_PROOF = /proof|lineage|adopt|does not belong|expired|released|not the current|superseded|stale/i;

/**
 * Errors that are NEVER a commitment refusal, however well their text happens to
 * match a domain regex.
 *
 * ⚠️ This exists because it already bit this corpus on its very first run. Four
 * adoption tests PASSED against an unbuilt surface: `saveQuote` rejected with
 * *"Validator error: Unexpected field `adoptReservationId`"*, and `BAD_PROOF`
 * contains `adopt`, so a schema rejection was read as a lineage refusal. Green,
 * and proving nothing — the same wrong-reason class that produced a false
 * "zero wrong-reason failures" claim two rounds ago.
 */
const NOT_A_REFUSAL =
  /Validator error|Unexpected field|Could not find module|is not a function|Cannot read propert|ArgumentValidationError/i;

/**
 * Assert a COMMITMENT refusal — the only refusal shape this corpus accepts.
 *
 * Three things must hold, and the middle one is what a plain
 * `.rejects.toThrow(pattern)` cannot express: the call must reject, it must not
 * reject because a surface is missing or an argument was rejected by the
 * validator, and its message must name the rule being enforced.
 */
async function expectRefusal(call: Promise<unknown>, pattern: RegExp, note?: string) {
  let error: unknown;
  let resolved: unknown;
  let didResolve = false;
  try {
    resolved = await call;
    didResolve = true;
  } catch (e) {
    error = e;
  }
  const label = note ? `${note}: ` : "";
  expect(
    didResolve,
    `${label}the call RESOLVED with ${JSON.stringify(resolved)} — it must be refused`
  ).toBe(false);
  const message = String((error as Error)?.message ?? error);
  expect(
    message,
    `${label}refused for the WRONG REASON — a missing surface or a validator error is not a commitment refusal. Got: ${message}`
  ).not.toMatch(NOT_A_REFUSAL);
  expect(message, `${label}the refusal must name the rule it enforces. Got: ${message}`).toMatch(
    pattern
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup. Runs BEFORE the subject call and OUTSIDE every assertion, always, so a
// setup failure fails with its own error and can never be matched against an
// expected refusal.
// ─────────────────────────────────────────────────────────────────────────────

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Auth ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `c_${suffix}`, email: `c${suffix}@x.com`, name: "Closer" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Auth",
      permissions: [
        "view:sales",
        "create:sales",
        "edit:sales",
        "approve:requests",
        "view:customers",
        "edit:vehicles",
        "delete:vehicles",
        "create:finance_application",
        "review:finance_application",
        "approve:finance_application",
        "finalize:financed_deal",
        "view:finance_applications",
        "register:vehicle_handover",
        "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const customerA = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Aisha", lastName: "Buyer" })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Bilal", lastName: "Rival" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Auth Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  return {
    t,
    orgId,
    userId,
    customerA,
    customerB,
    companyId,
    asUser: t.withIdentity({ subject: `c_${suffix}`, clerkId: `c_${suffix}` }),
  };
}

let vinCounter = 0;
async function vehicle(seed: Seed, status: "AVAILABLE" | "SOURCING" = "AVAILABLE") {
  const vin = `AUTHORITY${String(vinCounter++).padStart(8, "0")}`;
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: seed.orgId,
      vin,
      make: "Toyota",
      model: "Land Cruiser",
      year: 2024,
      mileage: 20,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: PRICE,
      status,
    })
  );
}

async function cashQuote(seed: Seed, customerId: Id<"customers">, vehicleId: Id<"vehicles">) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId,
    mode: "CASH" as const,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 0,
    totalFinancedAmount: 0,
  });
}

async function financedQuote(seed: Seed, customerId: Id<"customers">, vehicleId: Id<"vehicles">) {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId,
    mode: "CONFIGURED_FINANCE_COMPANY" as const,
    companyId: seed.companyId,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 48,
    totalFinancedAmount: PRICE,
  });
}

/** The three ways a car becomes spoken for. Separate paths, separate code. */
async function heldByDeposit(seed: Seed, v: Id<"vehicles">, customerId: Id<"customers">) {
  const quoteId = await cashQuote(seed, customerId, v);
  const depositId = await seed.asUser.mutation(api.deposits.create, {
    orgId: seed.orgId,
    quoteId,
    amount: 1_500,
  });
  return { quoteId, depositId };
}

async function heldByFinance(seed: Seed, v: Id<"vehicles">, customerId: Id<"customers">) {
  const quoteId = await financedQuote(seed, customerId, v);
  const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
    orgId: seed.orgId,
    quoteId,
  });
  return { quoteId, applicationId };
}

async function heldByReservation(seed: Seed, v: Id<"vehicles">, customerId: Id<"customers">) {
  const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
    orgId: seed.orgId,
    vehicleId: v,
    customerId,
  });
  return { reservationId };
}

// ── Observation ──────────────────────────────────────────────────────────────

async function vehicleRow(seed: Seed, v: Id<"vehicles">): Promise<Doc<"vehicles">> {
  const row = await seed.t.run((ctx) => ctx.db.get(v));
  expect(row, "the vehicle must still exist").not.toBeNull();
  return row!;
}

/**
 * Which deposits actively hold this car, through the PRODUCT's own resolver.
 *
 * A hand-written `depositVehicleHolds` query is wrong in both directions:
 * `deposits.ts` only writes a join row for MULTI-vehicle deposits, so a
 * single-vehicle hold is invisible there while a stray direct row is invisible
 * to the residue checks that exist to catch it.
 */
async function depositsHolding(seed: Seed, v: Id<"vehicles">): Promise<Doc<"deposits">[]> {
  return await seed.t.run(async (ctx) => await getActiveDepositHolds(ctx, v));
}

async function countIn(seed: Seed, table: "sales" | "deposits" | "financeApplications") {
  return await seed.t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
}

async function activeReservations(seed: Seed, v: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleReservations").collect()).filter(
      (r) => r.vehicleId === v && r.status === "ACTIVE"
    )
  );
}

type RootView = { kind: string; rootId?: unknown; customerId?: unknown; headQuoteId?: unknown };

/** The canonical authority. Not `vehicle.status` — that is only its shadow. */
async function resolveRoot(seed: Seed, v: Id<"vehicles">): Promise<RootView> {
  return (await seed.asUser.query(notYetBuiltQuery.commitments.resolveVehicleRoot, {
    orgId: seed.orgId,
    vehicleId: v,
  })) as RootView;
}

function completedSale(
  seed: Seed,
  opts: {
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    quoteId?: Id<"quotes">;
    tradeInVehicleId?: Id<"vehicles">;
  }
) {
  return {
    orgId: seed.orgId,
    vehicleId: opts.vehicleId,
    customerId: opts.customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    ...(opts.quoteId ? { quoteId: opts.quoteId } : {}),
    ...(opts.tradeInVehicleId
      ? { tradeInVehicleId: opts.tradeInVehicleId, tradeInValue: 5_000 }
      : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ROOT IDENTITY IS SERVER-OWNED — NOT (customerId, vehicleId)
//
// ⚠️ This section is the Round-10 HIGH-1 gap. Every contract in the design file
// changed the customer and the quote together on refusal, and neither on
// acceptance, so an authority keyed by `(customerId, vehicleId)` — precisely
// what the ruling forbids — passed all 21. 1.1 and 1.2 are the pair that
// separates them: same customer, different root must REFUSE, while same root
// must ACCEPT.
// ═════════════════════════════════════════════════════════════════════════════

describe("1. root identity", () => {
  test("1.1 the SAME customer opening a SECOND INDEPENDENT deal on the same car is refused", async () => {
    const seed = await seedDealer("same-cust-2-roots");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerA);
    // A second quote for the SAME customer, citing no lineage to the first.
    // Under the ruling this is a different deal/root, and one car is one unit.
    const independent = await cashQuote(seed, seed.customerA, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: independent,
        amount: 1_000,
      })
    , REFUSED);

    const holds = await depositsHolding(seed, v);
    expect(holds, "only the first deal's deposit may hold the car").toHaveLength(1);
  });

  test("1.2 a further instalment on the SAME root is accepted", async () => {
    const seed = await seedDealer("same-root-instalment");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);

    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    // Both live, one car, one deal. This is what stops 1.1 being implemented as
    // a blunt "one deposit per vehicle".
    const deposits = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).filter((d) => d.quoteId === quoteId)
    );
    expect(deposits).toHaveLength(2);
    expect(deposits.every((d) => d.holdActive === true)).toBe(true);
  });

  test("1.3 the resolver returns a REAL root id, and the same one on re-read", async () => {
    // ⚠️ Round-10 HIGH-2. The previous version compared `String(rootId)`, and
    // `String(undefined)` is "undefined" — truthy, and equal to itself — so a
    // resolver that never minted a root satisfied the whole test. Raw values
    // only, and an explicit non-null assertion.
    const seed = await seedDealer("real-root-id");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerA);

    const owned = await resolveRoot(seed, v);

    expect(owned.kind).toBe("OWNED");
    expect(owned.rootId, "a root must actually exist").not.toBeUndefined();
    expect(owned.rootId).not.toBeNull();
    expect(typeof owned.rootId).toBe("string");
    expect(String(owned.rootId).length).toBeGreaterThan(0);
    const again = await resolveRoot(seed, v);
    expect(again.rootId, "the root is stable across reads").toEqual(owned.rootId);
  });

  test("1.4 an unheld car is FREE and has no root", async () => {
    const seed = await seedDealer("free-car");
    const v = await vehicle(seed);

    const free = await resolveRoot(seed, v);

    expect(free.kind).not.toBe("OWNED");
    expect(free.rootId ?? null, "a free car must not carry a root").toBeNull();
  });

  test("1.5 two cars held by one customer get DIFFERENT roots", async () => {
    const seed = await seedDealer("two-cars-two-roots");
    const first = await vehicle(seed);
    const second = await vehicle(seed);
    await heldByDeposit(seed, first, seed.customerA);
    await heldByDeposit(seed, second, seed.customerA);

    const a = await resolveRoot(seed, first);
    const b = await resolveRoot(seed, second);

    expect(a.rootId).not.toBeUndefined();
    expect(b.rootId).not.toBeUndefined();
    expect(a.rootId, "one root per physical unit, not per customer").not.toEqual(b.rootId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. A CAR HELD BY A DEPOSIT
// ═════════════════════════════════════════════════════════════════════════════

describe("2. deposit-held", () => {
  test("2.1 refuses a rival deposit", async () => {
    const seed = await seedDealer("dep-dep");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    , REFUSED);

    const holds = await depositsHolding(seed, v);
    expect(holds).toHaveLength(1);
    expect(holds[0].customerId).toBe(seed.customerB);
  });

  test("2.2 refuses a rival FINANCE APPLICATION", async () => {
    // Floor item: the design file covered application→deposit and
    // reservation→application but never deposit→application, so an
    // implementation guarding `createFromQuote` against reservations only
    // passed. `vehicles.ts` already refuses a rival RESERVATION over a
    // deposit; nothing refused a rival APPLICATION.
    const seed = await seedDealer("dep-app");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    const ours = await financedQuote(seed, seed.customerA, v);
    const appsBefore = await countIn(seed, "financeApplications");

    await expectRefusal(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: ours })
    , REFUSED);

    expect(await countIn(seed, "financeApplications")).toBe(appsBefore);
  });

  test("2.3 refuses a rival RESERVATION", async () => {
    const seed = await seedDealer("dep-res");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      })
    , REFUSED);

    expect(await activeReservations(seed, v)).toHaveLength(0);
  });

  test("2.4 the SAME root may hold a deposit AND a finance application together", async () => {
    // Floor item: same-root app+deposit coexistence. A deal that takes a
    // deposit and then applies for finance is one root with two claims, and an
    // authority that refuses its own second claim would dead-end the product's
    // most common financed flow.
    const seed = await seedDealer("same-root-coexist");
    const v = await vehicle(seed);
    const quoteId = await financedQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 1_500 });

    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    expect(applicationId, "the deal's own application must be accepted").toBeTruthy();
    const holds = await depositsHolding(seed, v);
    expect(holds, "and its deposit still holds the car").toHaveLength(1);
    const root = await resolveRoot(seed, v);
    expect(root.kind).toBe("OWNED");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. A CAR HELD BY A LIVE FINANCE APPLICATION
//
// ⚠️ c14865 REMOVED the design file's assumption that a finance-held car reads
// AVAILABLE. An ACTIVE finance commitment now DOES project RESERVED. So these
// contracts assert what actually matters — the car was NOT CONSUMED by the
// rival — rather than pinning a status the implementation is entitled to set.
// ═════════════════════════════════════════════════════════════════════════════

describe("3. finance-held", () => {
  test("3.1 refuses a rival DEPOSIT", async () => {
    const seed = await seedDealer("fin-dep");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    , REFUSED);

    expect(await depositsHolding(seed, v)).toHaveLength(0);
  });

  test("3.2 refuses a rival RESERVATION", async () => {
    const seed = await seedDealer("fin-res");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      })
    , REFUSED);

    expect(await activeReservations(seed, v)).toHaveLength(0);
  });

  test("3.3 refuses a rival CASH SALE", async () => {
    const seed = await seedDealer("fin-sale");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status, "the car must not be consumed").not.toBe("SOLD");
  });

  test("3.4 refuses SOFT-DELETE", async () => {
    const seed = await seedDealer("fin-del");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v })
    , /committed|another deal|already held|in use|cannot delete|application/i);

    const row = await vehicleRow(seed, v);
    expect((row as { deletedAt?: number }).deletedAt).toBeUndefined();
    expect(row.isDeleted ?? false).toBe(false);
  });

  test("3.5 refuses ARCHIVE, the second door out of inventory", async () => {
    const seed = await seedDealer("fin-arch");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.update, {
        orgId: seed.orgId,
        vehicleId: v,
        status: "ARCHIVED" as const,
      })
    , /committed|another deal|already held|in use|cannot archive|application|release the (reservation|deposit)/i);

    expect((await vehicleRow(seed, v)).status).not.toBe("ARCHIVED");
  });

  test("3.6 refuses being taken as another deal's TRADE-IN", async () => {
    const seed = await seedDealer("fin-trade");
    const tradeIn = await vehicle(seed);
    const bought = await vehicle(seed);
    await heldByFinance(seed, tradeIn, seed.customerB);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, {
          vehicleId: bought,
          customerId: seed.customerA,
          tradeInVehicleId: tradeIn,
        })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, tradeIn)).status).not.toBe("SOLD");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. RESERVATION-HELD, AND EXPLICIT ADOPTION
//
// ⚠️ This section exists because I got it wrong. I argued that since
// `vehicleReservations` has no quote/root field, no implementation could
// require reservation lineage, so the same customer had to imply the same deal.
// c14865 corrected that: the missing field is a PENDING SURFACE TO BUILD.
// A reservation-origin quote must ADOPT the reservation through explicit,
// server-validated proof; omitting the proof leaves it independent lineage.
// ═════════════════════════════════════════════════════════════════════════════

describe("4. reservation-held and adoption", () => {
  test("4.1 refuses a rival DEPOSIT", async () => {
    const seed = await seedDealer("res-dep");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    , REFUSED);

    expect(await depositsHolding(seed, v)).toHaveLength(0);
  });

  test("4.2 refuses a rival FINANCE APPLICATION", async () => {
    const seed = await seedDealer("res-app");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const ours = await financedQuote(seed, seed.customerA, v);
    const appsBefore = await countIn(seed, "financeApplications");

    await expectRefusal(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: ours })
    , REFUSED);

    expect(await countIn(seed, "financeApplications")).toBe(appsBefore);
  });

  test("4.3 ADOPTION: reserve -> adopt -> the adopting deal owns the SAME root", async () => {
    const seed = await seedDealer("res-adopt");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerB);
    const rootAtReservation = await resolveRoot(seed, v);

    const adopted = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerB,
      vehicleId: v,
      mode: "CASH",
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      adoptReservationId: reservationId,
    })) as Id<"quotes">;

    // The adopting quote CONTINUES the reservation's root rather than minting a
    // new one — that is what "adoption" means and what makes 4.4 refusable.
    const afterAdopt = await resolveRoot(seed, v);
    expect(afterAdopt.kind).toBe("OWNED");
    expect(afterAdopt.rootId).toEqual(rootAtReservation.rootId);
    const quoteRow = await seed.t.run((ctx) => ctx.db.get(adopted));
    expect(quoteRow, "the adopting quote exists").not.toBeNull();
  });

  test("4.4 OMITTED proof stays independent lineage and cannot consume the reservation", async () => {
    // The same customer, a quote with no adoption proof. Under c14865 this is
    // a different deal, and it may not take the car the reservation is holding.
    const seed = await seedDealer("res-noproof");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const unadopted = await cashQuote(seed, seed.customerB, v);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerB, quoteId: unadopted })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect(await activeReservations(seed, v), "the reservation survives").toHaveLength(1);
  });

  test("4.5 adoption proof for the WRONG CUSTOMER is refused", async () => {
    const seed = await seedDealer("res-wrongcust");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerB);

    await expectRefusal(
      seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        adoptReservationId: reservationId,
      })
    , BAD_PROOF);
  });

  test("4.6 adoption proof for the WRONG VEHICLE is refused", async () => {
    const seed = await seedDealer("res-wrongveh");
    const reserved = await vehicle(seed);
    const other = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, reserved, seed.customerB);

    await expectRefusal(
      seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerB,
        vehicleId: other,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        adoptReservationId: reservationId,
      })
    , BAD_PROOF);
  });

  test("4.7 adoption proof for a RELEASED reservation is refused", async () => {
    const seed = await seedDealer("res-released");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerB);
    await seed.t.run((ctx) =>
      ctx.db.patch(reservationId, { status: "RELEASED" as const, releasedAt: Date.now() })
    );

    await expectRefusal(
      seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerB,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        adoptReservationId: reservationId,
      })
    , BAD_PROOF);
  });

  test("4.8 adoption proof for an EXPIRED reservation is refused", async () => {
    const seed = await seedDealer("res-expired");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerB);
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 }));

    await expectRefusal(
      seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerB,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        adoptReservationId: reservationId,
      })
    , BAD_PROOF);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. SCRUM-196 — A RIVAL CASH SALE MAY NOT CONSUME A HELD CAR
//
// ⚠️ Round-10 HIGH-3. In the design file every refusal omitted `quoteId` and
// every positive control supplied one, so "refuse when no quoteId was passed"
// satisfied the entire SCRUM-196 set while being trivially wrong. Each axis
// below is therefore tested THREE ways: omitted proof, UNRELATED proof, and the
// owning deal's own proof, which must still succeed.
// ═════════════════════════════════════════════════════════════════════════════

describe("5. rival cash sale (SCRUM-196)", () => {
  test("5.1 deposit-held: refuses a rival sale with OMITTED quote proof", async () => {
    const seed = await seedDealer("196-dep-omit");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).not.toBe("SOLD");
    expect(await depositsHolding(seed, v)).toHaveLength(1);
  });

  test("5.2 deposit-held: refuses a rival sale carrying an UNRELATED quote", async () => {
    const seed = await seedDealer("196-dep-unrelated");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    const rivalQuote = await cashQuote(seed, seed.customerA, v);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId: rivalQuote })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).not.toBe("SOLD");
  });

  test("5.3 deposit-held: the OWNING deal's sale still completes", async () => {
    const seed = await seedDealer("196-dep-own");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);
    const salesBefore = await countIn(seed, "sales");

    const saleId = await seed.asUser.mutation(
      api.sales.create,
      completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
    );

    expect(await countIn(seed, "sales")).toBe(salesBefore + 1);
    const sale = await seed.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));
    expect(sale?.customerId).toBe(seed.customerA);
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });

  test("5.4 reservation-held: refuses a rival sale with OMITTED quote proof", async () => {
    const seed = await seedDealer("196-res-omit");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect(await activeReservations(seed, v)).toHaveLength(1);
  });

  test("5.5 reservation-held: refuses a rival sale carrying an UNRELATED quote", async () => {
    const seed = await seedDealer("196-res-unrelated");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const rivalQuote = await cashQuote(seed, seed.customerA, v);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId: rivalQuote })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
  });

  test("5.6 reservation-held: the ADOPTING deal's sale completes", async () => {
    const seed = await seedDealer("196-res-adopted");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerB);
    const adopted = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerB,
      vehicleId: v,
      mode: "CASH",
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      adoptReservationId: reservationId,
    })) as Id<"quotes">;
    const salesBefore = await countIn(seed, "sales");

    const saleId = await seed.asUser.mutation(
      api.sales.create,
      completedSale(seed, { vehicleId: v, customerId: seed.customerB, quoteId: adopted })
    );

    expect(await countIn(seed, "sales")).toBe(salesBefore + 1);
    const sale = await seed.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));
    expect(sale?.customerId).toBe(seed.customerB);
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. LINEAR HEAD, CAS AND IDEMPOTENCY
//
// Only the CURRENT head may be superseded, and superseding is compare-and-swap
// on a monotonic revision. The stale-head rule is symmetric across every
// evidence path — a rule enforced in `deposits.create` alone would let the same
// fragmentation in through applications or reservations.
// ═════════════════════════════════════════════════════════════════════════════

describe("6. linear head, CAS and idempotency", () => {
  async function twoRevisions(seed: Seed, v: Id<"vehicles">) {
    const r1 = await cashQuote(seed, seed.customerA, v);
    const r2 = (await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH",
      vehiclePrice: PRICE - 500,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      supersedesQuoteId: r1,
    })) as Id<"quotes">;
    return { r1, r2 };
  }

  test("6.1 a DEPOSIT citing a superseded revision is refused; the head accepts it", async () => {
    const seed = await seedDealer("cas-dep");
    const v = await vehicle(seed);
    const { r1, r2 } = await twoRevisions(seed, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 500 })
    , /current revision|superseded|stale|current head/i);

    // A REDIRECT, not a block — asserted by consequence. A mutation returning
    // an id while recording the money against the stale revision is the exact
    // fragmentation the rule exists to prevent.
    const depositId = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: r2,
      amount: 500,
    })) as Id<"deposits">;
    const row = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(row?.quoteId, "money lands on the CURRENT head").toBe(r2);
    expect(row?.holdActive).toBe(true);
  });

  test("6.2 an APPLICATION citing a superseded revision is refused", async () => {
    const seed = await seedDealer("cas-app");
    const v = await vehicle(seed);
    const r1 = await financedQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId: seed.companyId,
      vehiclePrice: PRICE - 500,
      downPayment: 0,
      termMonths: 48,
      totalFinancedAmount: PRICE - 500,
      supersedesQuoteId: r1,
    });
    const appsBefore = await countIn(seed, "financeApplications");

    await expectRefusal(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: r1 })
    , /current revision|superseded|stale|current head/i);

    expect(await countIn(seed, "financeApplications")).toBe(appsBefore);
  });

  test("6.3 CAS: superseding a NON-head revision is refused", async () => {
    const seed = await seedDealer("cas-nonhead");
    const v = await vehicle(seed);
    const { r1 } = await twoRevisions(seed, v);

    // r1 is no longer the head; r2 is. Superseding r1 again is a lost update.
    await expectRefusal(
      seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH",
        vehiclePrice: PRICE - 900,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: r1,
      })
    , /current revision|superseded|stale|current head|only the (current )?head/i);
  });

  test("6.4 an exact retry returns the SAME quote, not a second one", async () => {
    const seed = await seedDealer("idem-retry");
    const v = await vehicle(seed);
    const args = {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      idempotencyKey: "authority-retry-1",
    };
    const first = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);

    const second = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);

    expect(second).toBe(first);
    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
    );
    expect(quotes).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. MONEY IS ROOT-WIDE, NOT QUOTE-WIDE
//
// The ownership axis and the money axis move independently. Superseding Q1 with
// Q2 renegotiates the deal; it does not strand what the customer already paid.
// ═════════════════════════════════════════════════════════════════════════════

describe("7. money across a supersession", () => {
  test("7.1 money paid on Q1 still belongs to the root after Q2 supersedes it", async () => {
    const seed = await seedDealer("q1q2-money");
    const v = await vehicle(seed);
    const q1 = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: q1, amount: 3_000 });
    const rootBefore = await resolveRoot(seed, v);

    await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH",
      vehiclePrice: PRICE - 1_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      supersedesQuoteId: q1,
    });

    // Same root, and the money is still holding the car. A renegotiation that
    // orphaned the deposit would show either a new root or a freed vehicle.
    const rootAfter = await resolveRoot(seed, v);
    expect(rootAfter.kind).toBe("OWNED");
    expect(rootAfter.rootId).toEqual(rootBefore.rootId);
    const holds = await depositsHolding(seed, v);
    expect(holds, "the customer's money did not evaporate").toHaveLength(1);
  });

  test("7.2 RELEASED money frees the CAR but leaves the deal financially open", async () => {
    const seed = await seedDealer("axes-split");
    const keep = await vehicle(seed);
    const freed = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: keep,
      vehicleItems: [
        { vehicleId: keep, unitPrice: PRICE },
        { vehicleId: freed, unitPrice: PRICE },
      ],
      mode: "CASH" as const,
      vehiclePrice: PRICE * 2,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 4_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: keep, amount: 2_000 },
        { vehicleId: freed, amount: 2_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: freed,
      reason: "customer dropped the second car",
    });

    // Ownership axis: a rival may genuinely take the released car. This is the
    // boundary that keeps 1.1 honest — it refuses a rival on a LIVE hold, not
    // on a released one.
    const rivalQuote = await cashQuote(seed, seed.customerB, freed);
    const rivalDeposit = await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_500,
    });
    const rivalRow = await seed.t.run((ctx) => ctx.db.get(rivalDeposit));
    expect(rivalRow?.quoteId, "the rival really holds the released car").toBe(rivalQuote);
    expect(rivalRow?.holdActive).toBe(true);

    // Money axis: the customer's 2,000 has not gone anywhere.
    const awaiting = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    expect(awaiting, "the released share is still awaiting a decision").toHaveLength(1);
    expect(awaiting[0].allocatedAmountMinor).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. THE FINANCE CLAIM LIFECYCLE — ACTIVE / RELEASED / CONSUMED
// ═════════════════════════════════════════════════════════════════════════════

describe("8. finance claim lifecycle", () => {
  test("8.1 REJECTING the application RELEASES the car", async () => {
    const seed = await seedDealer("fin-reject");
    const v = await vehicle(seed);
    const { applicationId } = await heldByFinance(seed, v, seed.customerA);

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });

    const root = await resolveRoot(seed, v);
    expect(root.kind, "a rejected application no longer holds the car").not.toBe("OWNED");
    // And the car is genuinely acquirable by someone else.
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    ).resolves.toBeTruthy();
  });

  test("8.2 REOPENING reacquires THE SAME root it released", async () => {
    const seed = await seedDealer("fin-reopen");
    const v = await vehicle(seed);
    const { applicationId } = await heldByFinance(seed, v, seed.customerA);
    const whileLive = await resolveRoot(seed, v);
    expect(whileLive.kind).toBe("OWNED");
    expect(whileLive.rootId).not.toBeUndefined();

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });
    const whileRejected = await resolveRoot(seed, v);
    expect(
      whileRejected.kind,
      "released in between — this is what a constant-returning stub cannot fake"
    ).not.toBe("OWNED");

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "PENDING_DOCS" as const,
    });

    const afterReopen = await resolveRoot(seed, v);
    expect(afterReopen.kind).toBe("OWNED");
    expect(
      afterReopen.rootId,
      "the reopened deal continues its own lineage instead of minting a new root"
    ).toEqual(whileLive.rootId);
  });

  test("8.3 a finance release cannot free the car while the SAME ROOT still holds a deposit", async () => {
    const seed = await seedDealer("fin-release-blocked");
    const v = await vehicle(seed);
    const quoteId = await financedQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 1_500 });
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });

    // The finance claim is gone but the deposit claim is not, so the ROOT still
    // owns the car. Releasing on the strength of one claim would hand a car to
    // a rival while the first customer's money still sits against it.
    const root = await resolveRoot(seed, v);
    expect(root.kind, "the deposit claim still holds the car").toBe("OWNED");
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expect(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    , REFUSED);
  });

  test("8.4 completing the deal CONSUMES the root rather than leaving it open", async () => {
    const seed = await seedDealer("fin-consumed");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);

    await seed.asUser.mutation(
      api.sales.create,
      completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
    );

    const root = await resolveRoot(seed, v);
    expect(root.kind, "a sold car is not still OWNED by an open commitment").not.toBe("OWNED");
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. STATUS IS AN ADVISORY PROJECTION, NEVER THE AUTHORITY (c14865)
//
// An ACTIVE finance commitment now participates in `vehicle.status = RESERVED`,
// alongside deposits and reservations. But 9.4 is the contract that matters
// most: forcing the status does NOT move the authority. If any guard reads
// status instead of the resolver, 9.4 fails.
// ═════════════════════════════════════════════════════════════════════════════

describe("9. status projection", () => {
  test("9.1 an ACTIVE finance commitment projects RESERVED", async () => {
    const seed = await seedDealer("proj-fin");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerA);

    expect((await vehicleRow(seed, v)).status).toBe("RESERVED");
  });

  test("9.2 releasing the finance claim recomputes the projection", async () => {
    const seed = await seedDealer("proj-recompute");
    const v = await vehicle(seed);
    const { applicationId } = await heldByFinance(seed, v, seed.customerA);
    expect((await vehicleRow(seed, v)).status).toBe("RESERVED");

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });

    expect((await vehicleRow(seed, v)).status, "nothing holds it now").toBe("AVAILABLE");
  });

  test("9.3 a CONSUMED claim must not keep the car RESERVED", async () => {
    const seed = await seedDealer("proj-consumed");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);

    await seed.asUser.mutation(
      api.sales.create,
      completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
    );

    // SOLD wins. A projection that recomputed RESERVED from the consumed claim
    // would take a sold car back out of the sold state.
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });

  test("9.4 forcing the STATUS does not move the AUTHORITY", async () => {
    // ⚠️ The single most important contract in this section. Status is a
    // projection; the resolver is the lock. If any guard keys off
    // `vehicle.status` rather than the commitment authority, this test fails —
    // which is exactly the class of bug SCRUM-196 turned out to be.
    const seed = await seedDealer("proj-not-authority");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    // Force the projection to lie, without touching the commitment.
    await seed.t.run((ctx) => ctx.db.patch(v, { status: "AVAILABLE" as const }));
    const rivalQuote = await cashQuote(seed, seed.customerA, v);
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId: rivalQuote })
      )
    , REFUSED);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    const root = await resolveRoot(seed, v);
    expect(root.kind, "the authority never moved").toBe("OWNED");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. A SOURCED CAR IS STILL ONE PHYSICAL UNIT
// ═════════════════════════════════════════════════════════════════════════════

describe("10. sourced inventory", () => {
  test("10.1 a SOURCED car may be reserved, and then not taken by a rival", async () => {
    const seed = await seedDealer("sourced-one-unit");
    const v = await vehicle(seed, "SOURCING");
    await heldByReservation(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    , REFUSED);

    expect(await depositsHolding(seed, v)).toHaveLength(0);
  });
});
