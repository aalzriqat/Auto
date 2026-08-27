import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { anyApi, FunctionReference } from "convex/server";
import { getActiveDepositHolds } from "./utils/depositHelpers";
import {
  residualUnsettledRootMoneyMinor,
  unresolvedRootMoneyMinor,
} from "./commitments";

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
  // A second identity, because deciding what happens to somebody's money is
  // maker-checker: whoever took the deposit may not also rule on it.
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `ca_${suffix}`, email: `ca${suffix}@x.com`, name: "Approver" })
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
        "merge:customers",
        "delete:customers",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

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
    asApprover: t.withIdentity({ subject: `ca_${suffix}`, clerkId: `ca_${suffix}` }),
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

/**
 * A comparable picture of what is holding a car right now.
 *
 * Used to assert a refusal touched NOTHING. "The sale count is unchanged" is
 * not enough on its own — a guard that fired after consuming claims would still
 * leave the count alone while having quietly dismantled the commitment.
 */
async function activeClaimSnapshot(seed: Seed, vehicleId: Id<"vehicles">) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("vehicleCommitmentClaims").collect())
      .filter((c) => c.vehicleId === vehicleId)
      .map((c) => `${c.kind}:${c.status}`)
      .sort()
  );
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
    // And the car is genuinely acquirable by someone else — asserted by
    // CONSEQUENCE. "It resolved" would have been satisfied by a mutation that
    // returned an id while leaving the car held, which is the failure this
    // release exists to prevent.
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    const rivalDeposit = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_000,
    })) as Id<"deposits">;

    const rivalRow = await seed.t.run((ctx) => ctx.db.get(rivalDeposit));
    expect(rivalRow?.holdActive, "the rival really holds the freed car").toBe(true);
    const afterRival = await resolveRoot(seed, v);
    expect(afterRival.kind).toBe("OWNED");
    expect(afterRival.customerId, "and the car belongs to the rival's deal now").toBe(
      seed.customerB
    );
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
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    , REFUSED, "8.3");
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

  test("9.5 SOFT-DELETE consults the authority, not the projection", async () => {
    // ⚠️ This contract exists because 3.4 went green without soft-delete ever
    // being wired. It passed on `vehicle.status === "RESERVED"` — a guard that
    // only fired because the new finance claim happens to project RESERVED.
    // Correct answer, wrong authority, and a projection-based guard is exactly
    // what 9.4 proves can be bypassed. Forcing the status apart from the
    // commitment separates the two: the refusal must survive the lie.
    const seed = await seedDealer("del-not-projection");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);
    await seed.t.run((ctx) => ctx.db.patch(v, { status: "AVAILABLE" as const }));

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v })
    , /committed|another deal|already held|in use|cannot delete|application/i,
      "a live commitment must block deletion even when the status says AVAILABLE");

    const row = await vehicleRow(seed, v);
    expect(row.isDeleted ?? false).toBe(false);
  });

  test("9.6 ARCHIVE consults the authority, not the projection", async () => {
    const seed = await seedDealer("arch-not-projection");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerB);
    await seed.t.run((ctx) => ctx.db.patch(v, { status: "AVAILABLE" as const }));

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.update, {
        orgId: seed.orgId,
        vehicleId: v,
        status: "ARCHIVED" as const,
      })
    , /committed|another deal|already held|in use|cannot archive|application|release the (reservation|deposit)/i,
      "a live commitment must block archiving even when the status says AVAILABLE");

    expect((await vehicleRow(seed, v)).status).not.toBe("ARCHIVED");
  });

  test("9.7 an AMBIGUOUS car cannot be quietly removed from inventory", async () => {
    // The car with conflicting records is precisely the one that must not
    // vanish from the lot while the conflict is unresolved.
    const seed = await seedDealer("amb-no-removal");
    const v = await vehicle(seed);
    const rootOne = await seedRoot(seed, v, "OPEN", seed.customerA);
    await seedActiveClaim(seed, v, rootOne);
    const rootTwo = await seedRoot(seed, v, "OPEN", seed.customerB);
    await seedActiveClaim(seed, v, rootTwo);

    await expectRefusal(
      seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v })
    , /ambiguous|cannot be determined|conflicting|committed|another deal|cannot delete/i);

    expect((await vehicleRow(seed, v)).isDeleted ?? false).toBe(false);
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

// ═════════════════════════════════════════════════════════════════════════════
// 11. NO FIXED PAGE MAY DECIDE THAT A CAR IS FREE  ("row-51", c14867)
//
// ⚠️ These two contracts exist because the owner read the foundation I had just
// committed and found the defect in it: `findOwningRoot` took a fixed page of
// 50 claim rows and answered from that page. A car whose decisive owner sits at
// row 51 therefore reported FREE — and FREE is the answer that hands a car to a
// rival. A cap is not a performance detail when the thing being capped is the
// evidence that something is already sold.
//
// 11.1 and 11.2 are a matched pair on purpose: 11.1 alone could be satisfied by
// deleting the cap AND breaking the free case, so the control proves the fix
// did not simply make everything look owned.
// ═════════════════════════════════════════════════════════════════════════════

/** Direct DB seeding. Public writers must never be able to create these shapes. */
async function seedRoot(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  status: "OPEN" | "RELEASED" | "CONSUMED",
  customerId?: Id<"customers">
): Promise<Id<"commitmentRoots">> {
  return await seed.t.run((ctx) =>
    ctx.db.insert("commitmentRoots", {
      orgId: seed.orgId,
      vehicleId,
      customerId: customerId ?? seed.customerA,
      status,
      revision: 1,
      createdAt: Date.now(),
      createdBy: seed.userId,
    })
  );
}

/** N ACTIVE-index claim rows whose roots are NOT OPEN — stale bookkeeping, not ownership. */
async function seedStaleClaims(seed: Seed, vehicleId: Id<"vehicles">, count: number) {
  const rootId = await seedRoot(seed, vehicleId, "RELEASED");
  await seed.t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("vehicleCommitmentClaims", {
        orgId: seed.orgId,
        rootId,
        vehicleId,
        kind: "DEPOSIT" as const,
        status: "ACTIVE" as const,
        createdAt: Date.now(),
        createdBy: seed.userId,
      });
    }
  });
  return rootId;
}

async function seedActiveClaim(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  rootId: Id<"commitmentRoots">
) {
  return await seed.t.run((ctx) =>
    ctx.db.insert("vehicleCommitmentClaims", {
      orgId: seed.orgId,
      rootId,
      vehicleId,
      kind: "DEPOSIT" as const,
      status: "ACTIVE" as const,
      createdAt: Date.now(),
      createdBy: seed.userId,
    })
  );
}

describe("11. row-51 — a fixed page must not decide freeness", () => {
  test("11.1 the decisive owner at row 51 is found, and a rival is refused", async () => {
    const seed = await seedDealer("row51-owned");
    const v = await vehicle(seed);
    // Rows 1–50: ACTIVE in the index, but their root is not OPEN, so none of
    // them decides anything.
    await seedStaleClaims(seed, v, 50);
    // Row 51: the real owner.
    const owningRoot = await seedRoot(seed, v, "OPEN", seed.customerB);
    await seedActiveClaim(seed, v, owningRoot);

    const view = await resolveRoot(seed, v);

    expect(view.kind, "row 51 decides — a 50-row page must not answer this").toBe("OWNED");
    expect(view.rootId).toEqual(owningRoot);

    // And the authority is load-bearing, not merely reported: a rival writer
    // must be refused on the strength of that row-51 owner.
    const rivalQuote = await cashQuote(seed, seed.customerA, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    , REFUSED, "row-51 owner must block a rival");
  });

  test("11.2 CONTROL: the same 50 stale rows with NO decisive owner resolve FREE", async () => {
    // Without this, 11.1 could be satisfied by an implementation that treats
    // any stale row as ownership — which would lock cars nobody is buying.
    const seed = await seedDealer("row51-free");
    const v = await vehicle(seed);
    await seedStaleClaims(seed, v, 50);

    const view = await resolveRoot(seed, v);

    expect(view.kind, "stale bookkeeping is not ownership").toBe("FREE");
    expect(view.rootId ?? null).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. LEGACY MULTI-ROOT AMBIGUITY IS ITS OWN ANSWER  (c14867)
//
// Historical data can contain two OPEN roots on one physical car. No public
// writer may create that state, but the resolver will meet it during cutover
// and must say so.
//
// ⚠️ The forbidden answers are the tempting ones: FREE (hands the car away),
// and any "oldest / newest / first / the one whose customer matches" tie-break.
// Every one of those invents an owner out of corrupt data and then lets
// somebody sell a car on the strength of it. AMBIGUOUS is the honest answer,
// and it must REFUSE rather than pick — including for a caller who genuinely
// belongs to one of the contenders, because being one of two claimants does not
// establish which one owns the car.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 13. "EVERY" MUST MEAN EVERY  (c14908)
//
// ⚠️ The owner read `a3a145ffe` and found what I had missed: I fixed the fixed
// page in the ownership RESOLVER and left it in the lifecycle MUTATORS. Helpers
// documented as releasing *every* claim took a page of fifty and released those.
//
// It is the row-51 defect on the write side, and it fails worse. A false-free
// READ hands one car to a rival; a partial RELEASE leaves live claims scattered
// behind an operation that reported success, and a partial CONSUME leaves ACTIVE
// claims on a car that has already been SOLD — a root still holding inventory
// that no longer exists to hold.
//
// Fifty-one instalments on one deal is unusual. That is not the point: the
// helpers PROMISE "every", and a promise bounded by an arbitrary page is a
// promise that fails silently at the boundary rather than loudly at the cap.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 14. MONEY BELONGS TO THE ROOT, NOT TO A QUOTE
//
// A renegotiation replaces the deal's terms; it does not replace the money the
// customer has already handed over. So the ceiling on new money is the CURRENT
// HEAD's amount, and what it is measured against is every economically
// unresolved minor across the whole root — not the deposits filed under one
// quote id, and not `amountMinor - releasedAmountMinor`, which counts a
// partially refunded row as though the rest had never been paid.
//
// Unresolved means the non-terminal buckets: ALLOCATED, APPLIED while still
// economically live, REVERSING, RELEASED_AWAITING_DECISION, and money with no
// allocation rows at all — which is the ordinary single-vehicle deposit, and
// the easiest to miss because it has nothing in `depositVehicleHolds` to find.
// Terminal refunds and forfeits are excluded, as are VOIDED and deleted rows.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 15. A DEAL IS NOT FINISHED WHILE IT STILL OWES SOMEBODY AN ANSWER  (c14909)
//
// ⚠️ Completion consumes every claim and recomputes the root to CONSUMED. But
// CONSUMED means *finished*, and a deal carrying a RELEASED_AWAITING_DECISION
// share is not finished — that money is sitting on the books waiting for a
// human to decide whether it goes back to the customer or is kept. Marking the
// root terminal around it strands the decision: nothing is holding it open, and
// nothing will ask again.
//
// The two axes come apart here exactly as they are supposed to. The car really
// has left inventory and must not stay held. The DEAL has not ended, because
// somebody is still owed an answer about their money.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 16. AN OPERATION KEY IDENTIFIES A SUBMISSION, NOT A SET OF BUSINESS FIELDS
//     (c14977)
//
// ⚠️ My first implementation derived the key from a hash of the quote payload.
// The owner rejected it, and the rejection is right: that makes the CONTENT the
// identity, so two legitimate NEW intentions with identical terms — the same
// customer asking again next week for the same car at the same price — can
// never both exist. They collapse onto the first quote id forever.
//
// Idempotency answers "is this the same submission attempt as the one whose
// response I lost". It is not a uniqueness constraint on business content, and
// a quote is informational until evidence attaches to it.
//
// So the two concepts are separated: the client mints an OPERATION KEY per
// submission attempt and keeps it only while retrying that attempt, and the
// server independently fingerprints the FULL material payload to decide whether
// a reused key is a genuine retry or a contradiction.
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// 17. THE REMAINING AUTHORITY DOORS
//
// Every path that puts a car back under a deal is a FRESH ACQUISITION, however
// old the money behind it is. Reallocating a released share, returning it to
// the deal, reactivating a hold when a sale is cancelled — each one ends with a
// car being held again, and between the release and the reactivation the car
// was genuinely free for somebody else to take.
//
// ⚠️ The tempting reading is that these are restorations rather than
// acquisitions: the money was always the customer's, so putting it back looks
// like undoing rather than doing. But the CAR does not work that way. A rival
// who acquired it in the meantime holds it legitimately, and quietly
// re-attaching the first customer's money produces two live claims on one car
// with nothing having refused anything.
// ═════════════════════════════════════════════════════════════════════════════

describe("17. authority doors", () => {
  /** A multi-vehicle deal with `dropped`'s share released and awaiting a decision. */
  async function dealWithReleasedShare(seed: Seed) {
    const keep = await vehicle(seed);
    const dropped = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: keep,
      vehicleItems: [
        { vehicleId: keep, unitPrice: PRICE },
        { vehicleId: dropped, unitPrice: PRICE },
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
        { vehicleId: dropped, amount: 2_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: dropped,
      reason: "customer dropped it",
    });
    const holdId = await seed.t.run(async (ctx) => {
      const holds = (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.vehicleId === dropped && h.allocationStatus === "RELEASED_AWAITING_DECISION"
      );
      return holds[0]._id;
    });
    return { keep, dropped, quoteId, holdId };
  }

  test("17.1 RETURN_TO_UNALLOCATED is refused once a rival has taken the freed car", async () => {
    const seed = await seedDealer("door-return");
    const { dropped, holdId } = await dealWithReleasedShare(seed);
    // The release genuinely freed the car, and a rival legitimately took it.
    const rivalQuote = await cashQuote(seed, seed.customerB, dropped);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_000,
    });
    const holdsBefore = await depositsHolding(seed, dropped);

    await expectRefusal(
      seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId,
        treatment: "RETURN_TO_UNALLOCATED" as const,
        reason: "customer changed their mind again",
      })
    , /committed|another deal|another customer|already held|no longer available/i,
      "putting money back on a car somebody else now holds is a fresh acquisition");

    // Zero residue: the rival still holds it alone, and the released share is
    // untouched and still decidable.
    expect(await depositsHolding(seed, dropped)).toEqual(holdsBefore);
    const stillAwaiting = await seed.t.run(async (ctx) => {
      const row = await ctx.db.get(holdId);
      return row?.allocationStatus;
    });
    expect(stillAwaiting, "the share is left as it was, still awaiting a decision").toBe(
      "RELEASED_AWAITING_DECISION"
    );
  });

  /**
   * A three-car deal with TWO shares released.
   *
   * ⚠️ Shaped this way because a reallocation target must already be a line on
   * the deposit's quote — the product refuses anything else, and an earlier
   * version of these tests used an unrelated car and "passed" on that refusal
   * instead of on the commitment rule. So the rival has to take a car that IS
   * on our quote, which it can only do once our own claim on it is released.
   */
  async function dealWithTwoReleasedShares(seed: Seed) {
    const keep = await vehicle(seed);
    const dropA = await vehicle(seed);
    const dropB = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: keep,
      vehicleItems: [
        { vehicleId: keep, unitPrice: PRICE },
        { vehicleId: dropA, unitPrice: PRICE },
        { vehicleId: dropB, unitPrice: PRICE },
      ],
      mode: "CASH" as const,
      vehiclePrice: PRICE * 3,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 3_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: keep, amount: 1_000 },
        { vehicleId: dropA, amount: 1_000 },
        { vehicleId: dropB, amount: 1_000 },
      ],
    });
    for (const carId of [dropA, dropB]) {
      await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: seed.orgId,
        quoteId,
        vehicleId: carId,
        reason: "customer dropped it",
      });
    }
    const holdIdFor = async (carId: Id<"vehicles">) =>
      await seed.t.run(async (ctx) => {
        const holds = (await ctx.db.query("depositVehicleHolds").collect()).filter(
          (h) => h.vehicleId === carId && h.allocationStatus === "RELEASED_AWAITING_DECISION"
        );
        return holds[0]._id;
      });
    return { keep, dropA, dropB, quoteId, holdIdFor };
  }

  test("17.2 REALLOCATE_TO_VEHICLE is refused when a rival took the target car", async () => {
    const seed = await seedDealer("door-realloc");
    const { dropA, dropB, holdIdFor } = await dealWithTwoReleasedShares(seed);
    // dropB was genuinely freed by the release, and a rival took it.
    const rivalQuote = await cashQuote(seed, seed.customerB, dropB);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_000,
    });
    const holdsBefore = await depositsHolding(seed, dropB);
    const holdId = await holdIdFor(dropA);

    await expectRefusal(
      seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId,
        treatment: "REALLOCATE_TO_VEHICLE" as const,
        toVehicleId: dropB,
        reason: "move it onto the other car",
      })
    , /committed|another deal|another customer|already held|no longer available/i,
      "money may not be moved onto a car another deal now holds");

    expect(await depositsHolding(seed, dropB), "the rival's hold is untouched").toEqual(
      holdsBefore
    );
    const stillAwaiting = await seed.t.run(async (ctx) => (await ctx.db.get(holdId))?.allocationStatus);
    expect(stillAwaiting, "and dropA's share is left decidable").toBe(
      "RELEASED_AWAITING_DECISION"
    );
  });

  test("17.3 CONTROL: reallocating onto a car THIS deal still holds works", async () => {
    // Without this, 17.1 and 17.2 could be satisfied by refusing every
    // reallocation, which would strand released money permanently.
    const seed = await seedDealer("door-realloc-ok");
    const { keep, dropA, holdIdFor } = await dealWithTwoReleasedShares(seed);
    const holdId = await holdIdFor(dropA);

    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId,
      treatment: "REALLOCATE_TO_VEHICLE" as const,
      toVehicleId: keep,
      reason: "put it on the car they are keeping",
    });

    const moved = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.vehicleId === keep && h.active === true
      )
    );
    expect(moved.length, "the money really moved onto the kept car").toBeGreaterThan(0);
  });

  test("17.4 cancelling a sale RE-ESTABLISHES the commitment, not just the money", async () => {
    // ⚠️ Cancellation reactivates the deposit hold. If it restores the money
    // without restoring the authority, the car comes back to the lot with a
    // live deposit against it and NOTHING saying it is spoken for — so a rival
    // can take a car the original customer has already paid on.
    const seed = await seedDealer("door-cancel");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);
    const saleId = await seed.asUser.mutation(
      api.sales.create,
      completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
    );

    // Cancelled by a second person: reversing a completed sale is maker-checker,
    // and the salesperson may not approve their own.
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId: saleId as Id<"sales">,
      status: "CANCELLED" as const,
    });

    // The money is back...
    const holds = await depositsHolding(seed, v);
    expect(holds, "the customer's deposit is live again").toHaveLength(1);
    // ...and so is the authority.
    const root = await resolveRoot(seed, v);
    expect(root.kind, "the car is spoken for again").toBe("OWNED");
    expect(root.customerId).toBe(seed.customerA);

    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    , REFUSED, "a rival must not take a car whose deposit came back to life");
  });

  test("17.5 STOCK and SOURCED behave identically — one row is one physical unit", async () => {
    // `sourceType` decides ownership economics, not inventory capacity. A
    // sourced car is still one car, and must refuse a rival exactly as stock
    // does — asserted side by side so a divergence cannot hide.
    const seed = await seedDealer("door-parity");
    const stock = await vehicle(seed, "AVAILABLE");
    const sourced = await vehicle(seed, "SOURCING");
    await seed.t.run((ctx) => ctx.db.patch(sourced, { sourceType: "SOURCED" as const }));
    await heldByDeposit(seed, stock, seed.customerB);
    await heldByDeposit(seed, sourced, seed.customerB);

    for (const [label, carId] of [
      ["stock", stock],
      ["sourced", sourced],
    ] as const) {
      const ours = await cashQuote(seed, seed.customerA, carId);
      await expectRefusal(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: ours,
          amount: 1_000,
        })
      , REFUSED, `${label} must refuse a rival deposit`);
      const holds = await depositsHolding(seed, carId);
      expect(holds, `${label}: only the holder`).toHaveLength(1);
      expect(holds[0].customerId).toBe(seed.customerB);
    }
  });
});

describe("16. operation identity vs payload fingerprint", () => {
  function newQuoteArgs(seed: Seed, v: Id<"vehicles">, over: Record<string, unknown> = {}) {
    return {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      ...over,
    };
  }

  test("16.1 an exact retry of the same submission returns the SAME quote", async () => {
    const seed = await seedDealer("op-retry");
    const v = await vehicle(seed);
    const args = newQuoteArgs(seed, v, { idempotencyKey: "op-aaa" });

    const first = await seed.asUser.mutation(api.quotes.saveQuote, args);
    const second = await seed.asUser.mutation(api.quotes.saveQuote, args);

    expect(second).toBe(first);
    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
    );
    expect(quotes, "a retry must not mint a second quote").toHaveLength(1);
  });

  test("16.2 TWO DISTINCT submissions with IDENTICAL terms produce TWO quotes", async () => {
    // ⚠️ The contract that rules out the content-hash design. A customer may
    // legitimately be quoted the same car on the same terms twice, and a quote
    // is informational — nothing is held until evidence attaches. Collapsing
    // them is not deduplication, it is losing the second enquiry.
    const seed = await seedDealer("op-two-intentions");
    const v = await vehicle(seed);

    const first = await seed.asUser.mutation(
      api.quotes.saveQuote,
      newQuoteArgs(seed, v, { idempotencyKey: "op-first" })
    );
    const second = await seed.asUser.mutation(
      api.quotes.saveQuote,
      newQuoteArgs(seed, v, { idempotencyKey: "op-second" })
    );

    expect(second, "different submissions are different quotes").not.toBe(first);
    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
    );
    expect(quotes).toHaveLength(2);
  });

  test("16.3 the same key with a CHANGED PRICE is a hard conflict, and writes nothing", async () => {
    const seed = await seedDealer("op-conflict-price");
    const v = await vehicle(seed);
    await seed.asUser.mutation(
      api.quotes.saveQuote,
      newQuoteArgs(seed, v, { idempotencyKey: "op-bbb" })
    );

    await expectRefusal(
      seed.asUser.mutation(
        api.quotes.saveQuote,
        newQuoteArgs(seed, v, { idempotencyKey: "op-bbb", vehiclePrice: PRICE - 1_000 })
      )
    , /already used|different|conflict|does not match/i);

    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
    );
    expect(quotes, "a conflict writes nothing").toHaveLength(1);
    expect(quotes[0].vehiclePrice).toBe(PRICE);
  });

  /**
   * ⚠️ The fields the first implementation forgot.
   *
   * It compared customer, vehicle, price, down payment, term, mode and
   * supersedes — a hand-picked subset. Every field below is material to what
   * the dealership is promising, and every one could change under a reused key
   * while the server silently returned the earlier quote. The owner found this
   * by reading the comparison rather than by running anything, which is exactly
   * why the fingerprint has to be exhaustive by construction and not a list
   * somebody remembered to extend.
   */
  const MATERIAL_FIELDS: Array<[string, Record<string, unknown>]> = [
    ["desiredProfit", { desiredProfit: 5_000 }],
    ["totalFinancedAmount", { totalFinancedAmount: 12_345 }],
    ["monthlyInstallment", { monthlyInstallment: 999 }],
    ["profitRateApplied", { profitRateApplied: 7 }],
    ["totalProfit", { totalProfit: 4_321 }],
    ["recipientName", { recipientName: "Someone Else" }],
  ];

  test.each(MATERIAL_FIELDS)(
    "16.4 the same key with a changed %s is a conflict, not a silent old quote",
    async (_label, override) => {
      const seed = await seedDealer(`op-field-${_label}`);
      const v = await vehicle(seed);
      const key = `op-${_label}`;
      const original = await seed.asUser.mutation(
        api.quotes.saveQuote,
        newQuoteArgs(seed, v, { idempotencyKey: key })
      );

      await expectRefusal(
        seed.asUser.mutation(
          api.quotes.saveQuote,
          newQuoteArgs(seed, v, { idempotencyKey: key, ...override })
        )
      , /already used|different|conflict|does not match/i,
        `a changed ${_label} must not silently return the earlier quote`);

      const quotes = await seed.t.run(async (ctx) =>
        (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
      );
      expect(quotes).toHaveLength(1);
      expect(quotes[0]._id).toBe(original);
    }
  );

  test("16.5 the same key with changed VEHICLE ITEMS is a conflict", async () => {
    // Secondary line items decide which cars the deal covers, and they were not
    // in the compared subset at all.
    const seed = await seedDealer("op-items");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const base = {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      mode: "CASH" as const,
      vehiclePrice: PRICE * 2,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      idempotencyKey: "op-items",
    };
    await seed.asUser.mutation(api.quotes.saveQuote, {
      ...base,
      vehicleItems: [
        { vehicleId: a, unitPrice: PRICE },
        { vehicleId: b, unitPrice: PRICE },
      ],
    });

    await expectRefusal(
      seed.asUser.mutation(api.quotes.saveQuote, {
        ...base,
        vehicleItems: [
          { vehicleId: a, unitPrice: PRICE + 500 },
          { vehicleId: b, unitPrice: PRICE - 500 },
        ],
      })
    , /already used|different|conflict|does not match/i);

    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === a)
    );
    expect(quotes).toHaveLength(1);
  });

  test("16.7 an exact retry of a COMMITTED operation survives changed domain state", async () => {
    // ⚠️ Ordering, and my comment claimed the opposite of what the code did. It
    // said "idempotency first, so a retry never re-runs any of the work below"
    // — but the key lookup happened AFTER customer, vehicle, company, profit
    // and lead validation.
    //
    // So the case idempotency exists for was the case it failed: the server
    // commits, the response is lost, and by the time the client retries a
    // manager has raised the vehicle's minimum profit. The retry is not asking
    // for anything new — that quote already exists — but it was re-validated
    // against the changed rule and refused, leaving the salesperson unable to
    // recover a quote the server had already written.
    const seed = await seedDealer("op-committed-retry");
    const v = await vehicle(seed);
    const args = {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CONFIGURED_FINANCE_COMPANY" as const,
      companyId: seed.companyId,
      vehiclePrice: PRICE,
      desiredProfit: 0,
      downPayment: 0,
      termMonths: 48,
      totalFinancedAmount: PRICE,
      idempotencyKey: "op-committed",
    };
    const committed = await seed.asUser.mutation(api.quotes.saveQuote, args);

    // The world moves on between the commit and the retry.
    await seed.t.run((ctx) => ctx.db.patch(v, { minimumProfit: 10_000 }));

    const retried = await seed.asUser.mutation(api.quotes.saveQuote, args);

    expect(retried, "the already-committed quote is returned, not re-evaluated").toBe(committed);
    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
    );
    expect(quotes).toHaveLength(1);
  });

  test("16.6 an edited NEW submission is an INDEPENDENT quote, not a revision", async () => {
    // ⚠️ Correcting a factual error I published: I described an edited payload
    // as producing "a new revision". It does not. The server only links a
    // revision when `supersedesQuoteId` is given; without it this is an
    // independent lineage, and calling it a revision misdescribes what the
    // deal's history actually looks like.
    const seed = await seedDealer("op-edited-is-new");
    const v = await vehicle(seed);
    const first = await seed.asUser.mutation(
      api.quotes.saveQuote,
      newQuoteArgs(seed, v, { idempotencyKey: "op-e1" })
    );

    const edited = await seed.asUser.mutation(
      api.quotes.saveQuote,
      newQuoteArgs(seed, v, { idempotencyKey: "op-e2", vehiclePrice: PRICE - 500 })
    );

    expect(edited).not.toBe(first);
    const firstRow = await seed.t.run((ctx) => ctx.db.get(first as Id<"quotes">));
    const editedRow = await seed.t.run((ctx) => ctx.db.get(edited as Id<"quotes">));
    expect(
      firstRow?.supersededByQuoteId ?? null,
      "an independent NEW submission does not supersede anything"
    ).toBeNull();
    expect(editedRow?.supersedesQuoteId ?? null).toBeNull();
  });
});

describe("15. residual money keeps the deal open", () => {
  async function rootRow(seed: Seed, rootId: Id<"commitmentRoots">) {
    return await seed.t.run((ctx) => ctx.db.get(rootId));
  }

  test("15.1 completion REFUSES while a released share is still awaiting a decision", async () => {
    // ⚠️ REWRITTEN. My first version of this contract asserted that the car
    // could be SOLD as long as the root stayed OPEN. That is not what c14909
    // requires — it requires the completion to REFUSE until somebody has ruled
    // on the released money — and I built to a one-line summary of the rule
    // instead of the rule, so the test satisfied the sentence while
    // contradicting the requirement. That is a policy change dressed as a fix.
    //
    // The difference matters in the shop. "Sell now, keep the root open"
    // finalises the sale, posts the accounting and hands over the car while
    // 2,000 of the customer's money is still unattributed. Refusing keeps the
    // decision in front of the person who has to make it, before anything is
    // irreversible.
    const seed = await seedDealer("residual-refuses");
    const keep = await vehicle(seed);
    const dropped = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: keep,
      vehicleItems: [
        { vehicleId: keep, unitPrice: PRICE },
        { vehicleId: dropped, unitPrice: PRICE },
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
        { vehicleId: dropped, amount: 2_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: dropped,
      reason: "customer dropped the second car",
    });
    const keepRootId = (await resolveRoot(seed, keep)).rootId as Id<"commitmentRoots">;
    expect(keepRootId, "the kept car has a root before completion").toBeTruthy();
    const salesBefore = await countIn(seed, "sales");
    const claimsBefore = await activeClaimSnapshot(seed, keep);

    await expectRefusal(
      seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId })
    , /awaiting|undecided|unresolved|released|decide|refund|forfeit/i,
      "a released share must be ruled on before the deal can complete");

    // Refused BEFORE any side effect — sale, vehicle, claims and root all
    // exactly as they were.
    expect(await countIn(seed, "sales"), "no sale row").toBe(salesBefore);
    expect((await vehicleRow(seed, keep)).status, "the car is NOT sold").not.toBe("SOLD");
    expect(await activeClaimSnapshot(seed, keep), "claims untouched").toEqual(claimsBefore);
    const root = await rootRow(seed, keepRootId);
    expect(root?.status, "the root is untouched").toBe("OPEN");

    const awaiting = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    expect(awaiting, "and the released share is still there to be decided").toHaveLength(1);
    expect(awaiting[0].allocatedAmountMinor).toBeGreaterThan(0);
  });

  test("15.3 once the released share is RULED ON, the same completion succeeds and consumes", async () => {
    // The other half of 15.1, and the reason it is not simply a block: the
    // refusal has to be escapable by doing the right thing. Refund the stray
    // share and the identical completion goes through.
    const seed = await seedDealer("residual-then-resolved");
    const keep = await vehicle(seed);
    const dropped = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: keep,
      vehicleItems: [
        { vehicleId: keep, unitPrice: PRICE },
        { vehicleId: dropped, unitPrice: PRICE },
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
        { vehicleId: dropped, amount: 2_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: dropped,
      reason: "customer dropped the second car",
    });
    const releasedHold = await seed.t.run(async (ctx) => {
      const holds = (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.vehicleId === dropped && h.allocationStatus === "RELEASED_AWAITING_DECISION"
      );
      return holds[0]._id;
    });
    const keepRootId = (await resolveRoot(seed, keep)).rootId as Id<"commitmentRoots">;

    // The explicit human decision the refusal was waiting for.
    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: releasedHold,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
      reason: "returned to the customer",
    });

    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });

    expect((await vehicleRow(seed, keep)).status).toBe("SOLD");
    const root = await rootRow(seed, keepRootId);
    expect(root?.status, "nothing is left undecided, so the deal is finished").toBe("CONSUMED");
  });

  test("15.4 resolving the released share RECOMPUTES the root — it cannot stay open forever", async () => {
    // The mechanical half the owner flagged: `resolveReleasedAllocation` is the
    // moment the last undecided money goes away, so it is the moment the root's
    // answer changes. Without a recompute there, a root that legitimately
    // stayed open would never be revisited by anything.
    const seed = await seedDealer("residual-recompute");
    const keep = await vehicle(seed);
    const dropped = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: keep,
      vehicleItems: [
        { vehicleId: keep, unitPrice: PRICE },
        { vehicleId: dropped, unitPrice: PRICE },
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
        { vehicleId: dropped, amount: 2_000 },
      ],
    });
    // BOTH cars are dropped, so once both shares are ruled on the deal has
    // nothing undecided left anywhere. Scoped this way deliberately: with only
    // one car released, the other's still-allocated money is legitimately
    // undecided, and a root staying open would be the right answer rather than
    // the bug. See the note below.
    for (const carId of [dropped, keep]) {
      await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: seed.orgId,
        quoteId,
        vehicleId: carId,
        reason: "customer walked away from the whole deal",
      });
    }
    const droppedRoot = await seed.t.run(async (ctx) => {
      const claims = (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) => c.vehicleId === dropped
      );
      return claims[0]?.rootId;
    });
    expect(droppedRoot, "the dropped car had a root").toBeTruthy();
    const releasedHolds = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect())
        .filter((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION")
        .map((h) => h._id)
    );
    expect(releasedHolds, "both shares are awaiting a decision").toHaveLength(2);

    for (const holdId of releasedHolds) {
      await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId,
        treatment: "REFUND_TO_CUSTOMER" as const,
        refundMethod: "CASH" as const,
        reason: "returned",
      });
    }

    // Nothing active, nothing undecided. The root must have been ASKED AGAIN at
    // the moment of the decision — nothing else in the system will ever come
    // back to it, so without a recompute here it reads as an unfinished deal
    // forever.
    const row = await rootRow(seed, droppedRoot as Id<"commitmentRoots">);
    expect(row?.status, "the root was recomputed after the decision").not.toBe("OPEN");
  });

  test("15.2 CONTROL: an ordinary completion with nothing residual DOES consume the root", async () => {
    // Without this, 15.1 could be satisfied by never marking any root terminal,
    // which would leave every completed deal looking permanently open.
    const seed = await seedDealer("residual-none");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);
    const rootId = (await resolveRoot(seed, v)).rootId as Id<"commitmentRoots">;

    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });

    const root = await rootRow(seed, rootId);
    expect(root?.status, "a finished deal really is finished").toBe("CONSUMED");
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });
});

describe("14. root-wide money", () => {
  const Q1 = 30_000;
  const Q2 = 27_000;
  const ON_ROOT = 5_000;

  /** Q1 at 30,000 with 5,000 down, superseded by a linked Q2 at 27,000. */
  async function q1DepositThenQ2(seed: Seed, v: Id<"vehicles">) {
    const q1 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: Q1,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: q1,
      amount: ON_ROOT,
    });
    const q2 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: Q2,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      supersedesQuoteId: q1,
    });
    return { q1, q2 };
  }

  test("14.1 BOUNDARY: 5,000 on the root, head at 27,000 — a further 22,000 is permitted", async () => {
    const seed = await seedDealer("money-boundary-ok");
    const v = await vehicle(seed);
    const { q2 } = await q1DepositThenQ2(seed, v);

    const depositId = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: q2,
      amount: 22_000,
    })) as Id<"deposits">;

    // Exactly to the line, and it lands on the CURRENT head.
    const row = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(row?.quoteId).toBe(q2);
    expect(row?.holdActive).toBe(true);
  });

  test("14.2 BOUNDARY: the same root refuses 23,000, and leaves ZERO residue", async () => {
    // 5,000 + 23,000 = 28,000 against a 27,000 head. One minor unit over the
    // line has to fail exactly as hard as a thousand.
    const seed = await seedDealer("money-boundary-refused");
    const v = await vehicle(seed);
    const { q2 } = await q1DepositThenQ2(seed, v);
    const depositsBefore = await countIn(seed, "deposits");

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: q2,
        amount: 23_000,
      })
    , /exceed|more than|over the|remaining/i, "23,000 breaches the 27,000 head");

    // Whole-operation zero residue: no deposit row, no hold, no partial write.
    expect(await countIn(seed, "deposits"), "the refused deposit left nothing").toBe(
      depositsBefore
    );
    const holds = await depositsHolding(seed, v);
    expect(holds, "still exactly the original 5,000 deal").toHaveLength(1);
  });

  test("14.3 a linked requote BELOW unresolved root money refuses BEFORE advancing the head", async () => {
    // The customer has paid 5,000. Renegotiating the car down to 4,000 would
    // leave the deal owing them money it has no way to represent, so it is
    // refused — and refused BEFORE the head moves, or the deal would be left
    // pointing at a revision that was never allowed to exist.
    const seed = await seedDealer("requote-below-money");
    const v = await vehicle(seed);
    const q1 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: Q1,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: q1,
      amount: ON_ROOT,
    });

    await expectRefusal(
      seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH" as const,
        vehiclePrice: 4_000,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        supersedesQuoteId: q1,
      })
    , /already (been )?(paid|received)|less than|below|unresolved|refund/i);

    // The head did NOT move, and the predecessor was not marked superseded.
    const q1Row = await seed.t.run((ctx) => ctx.db.get(q1));
    expect(q1Row?.supersededByQuoteId ?? null, "the head must not have advanced").toBeNull();
    const root = await resolveRoot(seed, v);
    expect(root.headQuoteId, "the root still points at Q1").toEqual(q1);
  });

  test("14.4 money paid on Q1 is applied EXACTLY ONCE when the Q2 deal completes", async () => {
    const seed = await seedDealer("q1-money-completes");
    const v = await vehicle(seed);
    const { q2 } = await q1DepositThenQ2(seed, v);
    const depositId = await seed.t.run(async (ctx) => {
      const rows = (await ctx.db.query("deposits").collect()).filter((d) => d.holdActive === true);
      return rows[0]._id;
    });

    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId: q2 });

    // No orphan, no double-application, no silent reassignment.
    const applications = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).filter(
        (row) => row.depositId === depositId
      )
    );
    expect(applications, "the Q1 money is applied exactly once, on the Q2 deal").toHaveLength(1);
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });
});

describe("13. lifecycle helpers release and consume EVERY claim", () => {
  /** N ACTIVE claims for one root — an instalment-heavy deal, exaggerated. */
  async function seedManyClaims(
    seed: Seed,
    vehicleId: Id<"vehicles">,
    rootId: Id<"commitmentRoots">,
    count: number,
    extra: Partial<{
      depositId: Id<"deposits">;
      reservationId: Id<"vehicleReservations">;
      applicationId: Id<"financeApplications">;
      kind: "DEPOSIT" | "FINANCE" | "RESERVATION";
    }> = {}
  ) {
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: seed.orgId,
          rootId,
          vehicleId,
          kind: extra.kind ?? "DEPOSIT",
          status: "ACTIVE" as const,
          ...(extra.depositId ? { depositId: extra.depositId } : {}),
          ...(extra.reservationId ? { reservationId: extra.reservationId } : {}),
          ...(extra.applicationId ? { applicationId: extra.applicationId } : {}),
          createdAt: Date.now() + i,
          createdBy: seed.userId,
        });
      }
    });
  }

  async function activeClaimCount(seed: Seed, vehicleId: Id<"vehicles">) {
    return await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) => c.vehicleId === vehicleId && c.status === "ACTIVE"
      ).length
    );
  }

  test("13.1 completing a sale CONSUMES every claim, not the first page", async () => {
    const seed = await seedDealer("consume-all");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);
    const root = await resolveRoot(seed, v);
    await seedManyClaims(seed, v, root.rootId as Id<"commitmentRoots">, 55);
    expect(await activeClaimCount(seed, v)).toBe(56);

    await seed.asUser.mutation(
      api.sales.create,
      completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
    );

    // A SOLD car with live claims left on it is a root still holding inventory
    // that no longer exists to hold.
    expect(await activeClaimCount(seed, v), "no claim may survive the sale").toBe(0);
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
    expect((await resolveRoot(seed, v)).kind).not.toBe("OWNED");
  });

  test("13.2 releasing a RESERVATION releases every claim it carries", async () => {
    const seed = await seedDealer("release-res-all");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerB);
    const root = await resolveRoot(seed, v);
    await seedManyClaims(seed, v, root.rootId as Id<"commitmentRoots">, 55, {
      reservationId,
      kind: "RESERVATION",
    });
    expect(await activeClaimCount(seed, v)).toBe(56);

    await seed.asUser.mutation(api.vehicles.releaseReservation, {
      orgId: seed.orgId,
      reservationId,
    });

    expect(await activeClaimCount(seed, v), "a released reservation holds nothing").toBe(0);
    expect((await resolveRoot(seed, v)).kind).toBe("FREE");
  });

  test("13.3 rejecting an APPLICATION releases every claim it carries", async () => {
    const seed = await seedDealer("release-app-all");
    const v = await vehicle(seed);
    const { applicationId } = await heldByFinance(seed, v, seed.customerA);
    const root = await resolveRoot(seed, v);
    await seedManyClaims(seed, v, root.rootId as Id<"commitmentRoots">, 55, {
      applicationId,
      kind: "FINANCE",
    });
    expect(await activeClaimCount(seed, v)).toBe(56);

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });

    expect(await activeClaimCount(seed, v), "a rejected application holds nothing").toBe(0);
    expect((await resolveRoot(seed, v)).kind).toBe("FREE");
  });

  test("13.4 REOPEN finds its own root behind a long claim history", async () => {
    // `reacquireForApplication` reads the application's claim history to
    // recover the root it released. Behind a page of history the real
    // predecessor is invisible, and the deal would either be refused or —
    // worse — mint a fresh root and orphan its own money and revisions.
    const seed = await seedDealer("reopen-long-history");
    const v = await vehicle(seed);
    const { applicationId } = await heldByFinance(seed, v, seed.customerA);
    const live = await resolveRoot(seed, v);
    // Historic, already-resolved claims for this application: noise the lookup
    // must see past rather than stop at.
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("vehicleCommitmentClaims", {
          orgId: seed.orgId,
          rootId: live.rootId as Id<"commitmentRoots">,
          vehicleId: v,
          kind: "FINANCE" as const,
          status: "RELEASED" as const,
          applicationId,
          createdAt: Date.now() - 1_000_000 + i,
          createdBy: seed.userId,
          resolvedAt: Date.now(),
        });
      }
    });

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });
    expect((await resolveRoot(seed, v)).kind).not.toBe("OWNED");

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "PENDING_DOCS" as const,
    });

    const afterReopen = await resolveRoot(seed, v);
    expect(afterReopen.kind).toBe("OWNED");
    expect(
      afterReopen.rootId,
      "the reopened deal continues its own lineage rather than minting a new root"
    ).toEqual(live.rootId);
  });
});

describe("12. legacy AMBIGUOUS / not cutover ready", () => {
  async function twoOpenRoots(seed: Seed, v: Id<"vehicles">) {
    const rootOne = await seedRoot(seed, v, "OPEN", seed.customerA);
    await seedActiveClaim(seed, v, rootOne);
    const rootTwo = await seedRoot(seed, v, "OPEN", seed.customerB);
    await seedActiveClaim(seed, v, rootTwo);
    return { rootOne, rootTwo };
  }

  test("12.1 two OPEN roots resolve to AMBIGUOUS, never FREE and never a winner", async () => {
    const seed = await seedDealer("amb-typed");
    const v = await vehicle(seed);
    const { rootOne, rootTwo } = await twoOpenRoots(seed, v);

    const view = await resolveRoot(seed, v);

    expect(view.kind, "corrupt state has its own answer").toBe("AMBIGUOUS");
    expect(view.kind).not.toBe("FREE");
    expect(view.rootId ?? null, "no contender may be reported as THE owner").toBeNull();
    // Enough conflict identity to diagnose it, per c14867.
    const conflicting = (view as { conflictingRootIds?: unknown }).conflictingRootIds as
      | Id<"commitmentRoots">[]
      | undefined;
    expect(conflicting, "the answer must name the contenders").toBeDefined();
    expect([...(conflicting ?? [])].sort()).toEqual([rootOne, rootTwo].sort());
  });

  test("12.2 acquisition is refused while the car is ambiguous", async () => {
    const seed = await seedDealer("amb-acquire");
    const v = await vehicle(seed);
    await twoOpenRoots(seed, v);
    const rivalQuote = await cashQuote(seed, seed.customerA, v);

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    , /ambiguous|cannot be determined|conflicting|not ready|committed|another deal/i);
  });

  test("12.3 acquisition is refused EVEN FOR a caller belonging to one contender", async () => {
    // ⚠️ The contract that stops "I am one of the two, therefore I am the
    // owner". Being one of two claimants says nothing about which one holds
    // the car, and letting that through is how corrupt data becomes a sale.
    const seed = await seedDealer("amb-insider");
    const v = await vehicle(seed);
    const { rootOne } = await twoOpenRoots(seed, v);
    const insiderQuote = await cashQuote(seed, seed.customerA, v);
    await seed.t.run((ctx) => ctx.db.patch(insiderQuote, { rootId: rootOne }));

    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: insiderQuote,
        amount: 1_000,
      })
    , /ambiguous|cannot be determined|conflicting|not ready|committed|another deal/i);
  });

  test("12.4 SALE / consumption is refused while the car is ambiguous", async () => {
    const seed = await seedDealer("amb-sale");
    const v = await vehicle(seed);
    const { rootOne } = await twoOpenRoots(seed, v);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.t.run((ctx) => ctx.db.patch(quoteId, { rootId: rootOne }));
    const salesBefore = await countIn(seed, "sales");

    await expectRefusal(
      seed.asUser.mutation(
        api.sales.create,
        completedSale(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
      )
    , /ambiguous|cannot be determined|conflicting|not ready|committed|another deal/i);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).not.toBe("SOLD");
  });

  test("12.5 releasing one contender resolves the ambiguity to OWNED", async () => {
    // Ambiguity must be ESCAPABLE. A state that refuses everything including
    // its own remedy is a dead end, and cutover would have no way forward.
    const seed = await seedDealer("amb-resolve");
    const v = await vehicle(seed);
    const { rootOne, rootTwo } = await twoOpenRoots(seed, v);
    expect((await resolveRoot(seed, v)).kind).toBe("AMBIGUOUS");

    await seed.t.run(async (ctx) => {
      const claims = (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) => c.vehicleId === v && c.rootId === rootTwo
      );
      for (const claim of claims) await ctx.db.patch(claim._id, { status: "RELEASED" as const });
      await ctx.db.patch(rootTwo, { status: "RELEASED" as const });
    });

    const view = await resolveRoot(seed, v);
    expect(view.kind, "one live root remains").toBe("OWNED");
    expect(view.rootId).toEqual(rootOne);
  });

  test("12.6 releasing BOTH contenders resolves to FREE", async () => {
    const seed = await seedDealer("amb-all-gone");
    const v = await vehicle(seed);
    const { rootOne, rootTwo } = await twoOpenRoots(seed, v);

    await seed.t.run(async (ctx) => {
      const claims = (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) => c.vehicleId === v
      );
      for (const claim of claims) await ctx.db.patch(claim._id, { status: "RELEASED" as const });
      await ctx.db.patch(rootOne, { status: "RELEASED" as const });
      await ctx.db.patch(rootTwo, { status: "RELEASED" as const });
    });

    const view = await resolveRoot(seed, v);
    expect(view.kind).toBe("FREE");
    expect(view.rootId ?? null).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18. CURRENT REVISION AT THE IRREVERSIBLE DOOR (owner ruling c15179)
//
// Section 6 already proves the linear head and the CAS: a quote that has been
// superseded cannot itself be superseded again, and `supersededByQuoteId` is
// the durable marker. Sections 2 and 3 prove the evidence doors refuse a stale
// revision — `deposits.create` and `applications.createFromQuote` both call
// `assertCurrentRevision`.
//
// None of that reaches the LAST door. `finalizeDeal` takes an applicationId and
// reads the quote off the application, so an application approved on Q1 still
// carries Q1 after a linked REVISE advanced the deal to Q2. `prepareSaleCompletion`
// then asks `actingRootForQuoteOnVehicle(Q1)`, which answers the OWNERSHIP
// question — is this the deal that holds the car — and answers it correctly:
// Q1's root is the same root, still OPEN. Ownership was never the missing
// dimension. **Current revision was.**
//
// Reloading Q1 does not make Q1 current, and the reload's org/customer/vehicle
// checks all pass on a stale quote by construction. So the sale, the SOLD
// transition, the claim consumption, the receivable, the allocation, the
// journal and the outbox all commit against a revision the deal has moved past
// — at the one step that cannot be taken back.
//
// This is the same shape as the failure this lane keeps producing: a rule
// applied to two writers of a record and not the third. The fix belongs in the
// shared pre-write boundary so every quote-backed completion door inherits it,
// not on `finalizeDeal` alone.
// ═════════════════════════════════════════════════════════════════════════════

describe("18. current revision at the irreversible door", () => {
  /** An APPROVED financed deal ready to finalize, built only through real doors. */
  async function readyToFinalize(
    seed: Seed,
    v: Id<"vehicles">,
    customerId: Id<"customers">
  ) {
    const quoteId = await financedQuote(seed, customerId, v);
    const applicationId = (await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    })) as Id<"financeApplications">;

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    // Maker-checker: approving is a second identity by design, so the deal
    // reaches APPROVED the way a real one does.
    await seed.asApprover.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });

    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now(),
    });

    return { quoteId, applicationId };
  }

  /**
   * Everything `completeSale` writes that cannot be taken back.
   *
   * Counted rather than inspected: the contract is that a refused finalize
   * leaves NOTHING behind, and a count catches a row this test did not think
   * to name. Compared against a snapshot taken after the revision, so it
   * isolates the finalize attempt itself.
   */
  async function irreversibleResidue(seed: Seed) {
    return await seed.t.run(async (ctx) => ({
      sales: (await ctx.db.query("sales").collect()).length,
      receivables: (await ctx.db.query("receivables").collect()).length,
      allocations: (await ctx.db.query("paymentAllocations").collect()).length,
      journals: (await ctx.db.query("journalEntries").collect()).length,
      accountingEvents: (await ctx.db.query("pendingAccountingEvents").collect()).length,
    }));
  }

  test("18.1 a SUPERSEDED quote cannot finalize the deal", async () => {
    const seed = await seedDealer("rev-stale");
    const v = await vehicle(seed);
    const { quoteId: q1, applicationId } = await readyToFinalize(seed, v, seed.customerA);

    // The linked REVISE. Same customer, same car, same root — this is the deal
    // renegotiating with itself, not a rival, so nothing about OWNERSHIP
    // changes and the ownership gate will keep saying yes.
    const q2 = (await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CONFIGURED_FINANCE_COMPANY" as const,
      companyId: seed.companyId,
      vehiclePrice: PRICE - 2_000,
      downPayment: 0,
      termMonths: 48,
      totalFinancedAmount: PRICE - 2_000,
      supersedesQuoteId: q1,
    })) as Id<"quotes">;

    // The premise, asserted rather than assumed: Q1 really is stale and the
    // application really does still point at it. Without both, 18.1 would pass
    // for a reason that has nothing to do with the rule.
    const q1Row = await seed.t.run((ctx) => ctx.db.get(q1));
    expect(q1Row?.supersededByQuoteId, "the REVISE must mark Q1 superseded").toEqual(q2);
    const appRow = await seed.t.run((ctx) => ctx.db.get(applicationId));
    expect(appRow?.quoteId, "and the application must still carry the stale Q1").toEqual(q1);
    const rootBefore = await resolveRoot(seed, v);
    expect(rootBefore.kind, "the deal still owns the car — this is not a rival").toBe("OWNED");

    const residueBefore = await irreversibleResidue(seed);

    await expectRefusal(
      seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId,
      }),
      /moved on since that quote|current revision/i,
      "18.1"
    );

    // Refused BEFORE the writes, not rolled back after — though in Convex a
    // throw rolls the transaction back either way, so the count proves the
    // outcome and the placement is what the fix has to get right.
    expect(await irreversibleResidue(seed), "a refused finalize writes nothing").toEqual(
      residueBefore
    );

    const vRow = await vehicleRow(seed, v);
    expect(vRow.status, "the car did not change hands on a stale revision").not.toBe("SOLD");

    const after = await seed.t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.status, "the application is not closed").toBe("APPROVED");
    expect(after?.finalizedSaleId ?? null, "and no sale was stamped on it").toBeNull();

    // The claim was not consumed: the deal still holds its car and can finalize
    // once it presents the current revision.
    const rootAfter = await resolveRoot(seed, v);
    expect(rootAfter.kind, "the deal keeps the car").toBe("OWNED");
    expect(rootAfter.rootId, "on the same root it always had").toEqual(rootBefore.rootId);
  });

  test("18.2 positive control — the CURRENT head still finalizes", async () => {
    const seed = await seedDealer("rev-current");
    const v = await vehicle(seed);
    const { applicationId } = await readyToFinalize(seed, v, seed.customerA);

    // Identical to 18.1 in every respect except the one under test: no REVISE,
    // so the application's quote is still the deal's head. If this went red the
    // refusal above would be proving nothing but a broken setup.
    const saleId = await seed.asUser.mutation(api.applications.finalizeDeal, {
      orgId: seed.orgId,
      applicationId,
    });

    expect(saleId, "the current head completes normally").toBeTruthy();
    expect(await countIn(seed, "sales"), "and it is a real sale row").toBe(1);
    const vRow = await vehicleRow(seed, v);
    expect(vRow.status, "the car is sold").toBe("SOLD");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19. THE ROOT SURVIVES A CUSTOMER MERGE
//
// `commitmentRoots.customerId` is descriptive, never identity — a customer can
// never key a root, which is the whole of section 1. It is still a real foreign
// key, and the resolver hands it back as the answer to "whose deal holds this
// car", so a merge that leaves it naming a customer that no longer exists
// produces a live root pointing at a soft-deleted row.
//
// `customerMergeRegistry.test.ts` catches the omission structurally: every
// table carrying a `customerId` must be registered as rewritten or declared
// derived. That is a COVERAGE assertion though — it proves the table is named
// in a list, not that a merge moves the field. This is the behavioural half.
// ═════════════════════════════════════════════════════════════════════════════

describe("19. the root survives a customer merge", () => {
  test("19.1 a merged-away customer's root follows the survivor", async () => {
    const seed = await seedDealer("merge-root");
    const v = await vehicle(seed);

    // The RIVAL customer holds the car, so the root genuinely names the one
    // about to be merged away rather than the one that survives.
    await heldByDeposit(seed, v, seed.customerB);
    const before = await resolveRoot(seed, v);
    expect(before.kind).toBe("OWNED");
    expect(before.customerId, "the root names the customer about to disappear").toEqual(
      seed.customerB
    );

    await seed.asUser.mutation(api.customers.mergeCustomers, {
      orgId: seed.orgId,
      survivorId: seed.customerA,
      loserId: seed.customerB,
    });

    const after = await resolveRoot(seed, v);
    expect(after.customerId, "the root now names the survivor").toEqual(seed.customerA);

    // And the merge did not quietly cost the deal its car. Reassigning a
    // foreign key must not touch the ownership axis: same root, still holding.
    expect(after.kind, "the car is still held").toBe("OWNED");
    expect(after.rootId, "by the same root it always was").toEqual(before.rootId);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 20. AN EXPIRED RESERVATION MUST LET THE CAR GO
//
// Every other way a reservation ends calls `releaseClaimsForReservation`.
// EXPIRY does not — and expiry is the one that happens by itself, on a cron, to
// every reservation nobody acts on. Two sites expire reservations:
// `expireReservations` (the cron) and the inline sweep inside
// `createReservation`, which clears stale reservations before taking a new one.
//
// The claim therefore stays ACTIVE and the root stays OPEN, so the commitment
// authority — the thing that now decides whether ANY deal may take the car —
// keeps holding it for a reservation that expired. Meanwhile
// `syncVehicleHoldStatus` moves the STATUS projection back to something free,
// so the car reads as available while every attempt to sell it is refused.
//
// And there is no way out: `releaseReservation` is the only public path that
// releases a reservation's claim, and it refuses anything whose status is not
// ACTIVE. Once expired, the car is held permanently.
//
// The sweep inside `createReservation` is self-defeating for the same reason:
// it expires the stale reservation, then `assertAcquirable` refuses because of
// the claim it just failed to release — so the customer whose reservation
// lapsed cannot re-reserve the very car the sweep exists to free.
//
// These are the SAME rule as sections 4 and 8, at the writers nobody wired.
// ═════════════════════════════════════════════════════════════════════════════

describe("20. an expired reservation must let the car go", () => {
  /**
   * Time passing, without touching the clock.
   *
   * `convex-test` and `Date.now()` are entangled enough that moving the clock
   * to age a row tends to move the scheduler with it. Moving the expiry into
   * the past states the same fact and nothing else.
   */
  async function ageOut(seed: Seed, reservationId: Id<"vehicleReservations">) {
    await seed.t.run((ctx) =>
      ctx.db.patch(reservationId, { expiresAt: Date.now() - 60_000 })
    );
  }

  test("20.1 the expiry CRON releases the claim, not merely the projection", async () => {
    const seed = await seedDealer("res-expire-cron");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerA);
    const held = await resolveRoot(seed, v);
    expect(held.kind, "the reservation holds the car to begin with").toBe("OWNED");

    await ageOut(seed, reservationId);
    await seed.t.mutation(internal.vehicles.expireReservations, {});

    const row = await seed.t.run((ctx) => ctx.db.get(reservationId));
    expect(row?.status, "the reservation really did expire").toBe("EXPIRED");

    const root = await resolveRoot(seed, v);
    expect(root.kind, "an expired reservation must not still hold the car").not.toBe("OWNED");

    // Asserted by CONSEQUENCE. "The root says FREE" would be satisfied by a
    // resolver that reports freedom while `assertAcquirable` still refuses —
    // which is exactly the failure mode here, since the projection already
    // reads free while the claim holds.
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    const rivalDeposit = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_000,
    })) as Id<"deposits">;
    const rivalRow = await seed.t.run((ctx) => ctx.db.get(rivalDeposit));
    expect(rivalRow?.holdActive, "and somebody else can genuinely take it").toBe(true);
  });

  test("20.2 the customer whose reservation lapsed can reserve the car again", async () => {
    const seed = await seedDealer("res-expire-sweep");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerA);
    await ageOut(seed, reservationId);

    // `createReservation`'s own inline sweep expires the stale reservation
    // before taking the new one. If that sweep does not release the claim, the
    // acquisition immediately after it is refused by the row it just expired.
    const second = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
    });
    expect(second, "the lapsed reservation must not block its own replacement").toBeTruthy();

    const root = await resolveRoot(seed, v);
    expect(root.kind, "and the new reservation holds the car").toBe("OWNED");
    expect(root.customerId, "for the customer who reserved it").toEqual(seed.customerA);

    const live = await activeReservations(seed, v);
    expect(live, "with exactly one live reservation").toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 21. RESOLVING THE MONEY MUST LET THE CAR GO
//
// Section 20 was reservation expiry. This is the same rule at the deposit's own
// endings, and they matter more because they are how an ordinary deal stops:
// the manager refunds or forfeits the عربون, or voids a receipt entered in
// error. Both end the hold on the car.
//
// The corpus reached `deposits.releaseVehicleAllocation` — the multi-vehicle
// path — six times and `deposits.release` not once, so the single-vehicle
// ending that every dealership actually uses had no contract at all.
// ═════════════════════════════════════════════════════════════════════════════

describe("21. resolving the money lets the car go", () => {
  /**
   * Can somebody else genuinely take this car now?
   *
   * Asserted by consequence rather than by reading the resolver, because the
   * status projection and the authority disagree in exactly the failure this
   * section exists to catch: `holdActive` goes false, the car reads free, and
   * an ACTIVE claim still refuses every acquisition.
   */
  async function rivalCanTake(seed: Seed, v: Id<"vehicles">) {
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    const depositId = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_000,
    })) as Id<"deposits">;
    const row = await seed.t.run((ctx) => ctx.db.get(depositId));
    return row?.holdActive === true;
  }

  test("21.1 REFUNDING the deposit releases the car", async () => {
    const seed = await seedDealer("dep-refund");
    const v = await vehicle(seed);
    const { depositId } = await heldByDeposit(seed, v, seed.customerA);
    expect((await resolveRoot(seed, v)).kind, "the money holds the car").toBe("OWNED");

    // Maker-checker: whoever took the deposit may not also rule on it.
    await seed.asApprover.mutation(api.deposits.release, {
      orgId: seed.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });

    expect(
      (await resolveRoot(seed, v)).kind,
      "a refunded deposit no longer holds the car"
    ).not.toBe("OWNED");
    expect(await rivalCanTake(seed, v), "and somebody else can genuinely take it").toBe(true);
  });

  test("21.2 FORFEITING the deposit releases the car too", async () => {
    const seed = await seedDealer("dep-forfeit");
    const v = await vehicle(seed);
    const { depositId } = await heldByDeposit(seed, v, seed.customerA);

    // The money stays with the dealership; the CAR does not. Keeping the
    // forfeited customer's hold would take the deposit AND the vehicle.
    await seed.asApprover.mutation(api.deposits.release, {
      orgId: seed.orgId,
      depositId,
      resolution: "FORFEITED" as const,
    });

    expect(
      (await resolveRoot(seed, v)).kind,
      "a forfeited deposit keeps the money, not the car"
    ).not.toBe("OWNED");
    expect(await rivalCanTake(seed, v), "the car is genuinely back on the lot").toBe(true);
  });

  test("21.3 VOIDING a mistaken receipt releases the car", async () => {
    const seed = await seedDealer("dep-void");
    const v = await vehicle(seed);
    const { depositId } = await heldByDeposit(seed, v, seed.customerA);

    // A void says the payment never happened. A hold created by money that was
    // never taken has nothing left to stand on.
    await seed.asApprover.mutation(api.deposits.voidDeposit, {
      orgId: seed.orgId,
      depositId,
      reason: "entered in error",
    });

    expect(
      (await resolveRoot(seed, v)).kind,
      "a voided receipt cannot still hold a car"
    ).not.toBe("OWNED");
    expect(await rivalCanTake(seed, v), "and the car is acquirable again").toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 22. A CUSTOMER WITH AN OPEN COMMITMENT CANNOT BE DELETED (ruling on c15221)
//
// `customers.softDelete` refused on live leads and live sales and nothing else.
// Neither sees an unfinished commitment: a deposit needs no lead, and a deal
// that has not completed has no sale. So a customer with a live deal could be
// soft-deleted out from under an OPEN root — and since that root is now the
// authority deciding who may take the car, the result is a live holder that no
// customer record backs.
//
// Section 19 makes a root FOLLOW its customer through a merge. Deletion is the
// other way a customer stops existing, and nothing followed it there.
//
// ⚠️ OPEN is not the same as "holding a car". Section 7 split the two axes:
// `RELEASED_AWAITING_DECISION` frees the vehicle while the root stays open
// because the customer's money has not been ruled on. Both are reasons to
// refuse, which is why the refusal names an unresolved COMMITMENT rather than a
// held vehicle.
//
// Scoped to OPEN roots deliberately. A RELEASED or CONSUMED root is history,
// and refusing on it would make a customer undeletable forever because of a
// deal that ended months ago.
// ═════════════════════════════════════════════════════════════════════════════

describe("22. a customer holding a car cannot be deleted", () => {
  async function customerIsLive(seed: Seed, customerId: Id<"customers">) {
    const row = await seed.t.run((ctx) => ctx.db.get(customerId));
    return row !== null && row.isDeleted !== true;
  }

  test("22.1 a DEPOSIT-held customer is refused, and nothing moves", async () => {
    const seed = await seedDealer("cust-del-dep");
    const v = await vehicle(seed);
    const { depositId } = await heldByDeposit(seed, v, seed.customerA);
    const before = await resolveRoot(seed, v);
    expect(before.kind).toBe("OWNED");
    const claimsBefore = await activeClaimSnapshot(seed, v);

    await expectRefusal(
      seed.asUser.mutation(api.customers.softDelete, {
        orgId: seed.orgId,
        customerId: seed.customerA,
      }),
      /active or financially unresolved commitment/i,
      "22.1"
    );

    // Refused BEFORE the patch: the customer, the authority and the money are
    // all exactly as they were.
    expect(await customerIsLive(seed, seed.customerA), "the customer is untouched").toBe(true);
    const after = await resolveRoot(seed, v);
    expect(after.kind, "the car is still held").toBe("OWNED");
    expect(after.rootId, "by the same root").toEqual(before.rootId);
    expect(await activeClaimSnapshot(seed, v), "and the claims are unchanged").toEqual(
      claimsBefore
    );
    const deposit = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(deposit?.holdActive, "the money still holds it").toBe(true);
  });

  test("22.2 positive control — releasing the last commitment makes deletion legal", async () => {
    const seed = await seedDealer("cust-del-ok");
    const v = await vehicle(seed);
    const { depositId } = await heldByDeposit(seed, v, seed.customerA);

    // Maker-checker on the money, then the customer really can go.
    await seed.asApprover.mutation(api.deposits.release, {
      orgId: seed.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });

    await seed.asUser.mutation(api.customers.softDelete, {
      orgId: seed.orgId,
      customerId: seed.customerA,
    });

    expect(
      await customerIsLive(seed, seed.customerA),
      "with nothing held, the deletion goes through"
    ).toBe(false);
  });

  test("22.3 a RESERVATION-held customer is refused too", async () => {
    const seed = await seedDealer("cust-del-res");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerA);

    // The rule is asked of the canonical root, not of the deposits table, so
    // every kind of evidence blocks without customers.ts knowing they exist.
    await expectRefusal(
      seed.asUser.mutation(api.customers.softDelete, {
        orgId: seed.orgId,
        customerId: seed.customerA,
      }),
      /active or financially unresolved commitment/i,
      "22.3"
    );
    expect(await customerIsLive(seed, seed.customerA)).toBe(true);
  });

  test("22.4 a FINANCE-held customer is refused too", async () => {
    const seed = await seedDealer("cust-del-fin");
    const v = await vehicle(seed);
    await heldByFinance(seed, v, seed.customerA);

    await expectRefusal(
      seed.asUser.mutation(api.customers.softDelete, {
        orgId: seed.orgId,
        customerId: seed.customerA,
      }),
      /active or financially unresolved commitment/i,
      "22.4"
    );
    expect(await customerIsLive(seed, seed.customerA)).toBe(true);
  });

  test("22.5 a customer whose deal ENDED is still deletable", async () => {
    const seed = await seedDealer("cust-del-hist");
    const v = await vehicle(seed);
    const { applicationId } = await heldByFinance(seed, v, seed.customerA);

    // Rejected: the root RELEASED, the car went back on the lot. Refusing on
    // history would make a customer undeletable forever over a dead deal.
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });

    await seed.asUser.mutation(api.customers.softDelete, {
      orgId: seed.orgId,
      customerId: seed.customerA,
    });
    expect(
      await customerIsLive(seed, seed.customerA),
      "a closed root is history, not a live hold"
    ).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 23. A CANCELLED DEAL STOPS HOLDING THE CAR — AND A LIVE DEPOSIT STILL DOES
//
// Sonnet MAX reviewed frozen head 684ee9ef and reported as CRITICAL that
// reversing a completed pure-finance sale never restores the FINANCE claim, so
// the car becomes acquirable by a rival while the original customer still
// physically has it (handover is a precondition of finalization).
//
// The FACT is true and I reproduced it. The CONCLUSION is wrong, and this
// section exists so nobody "fixes" it again.
//
// `applications.cancelApplication` states the rule in its own non-finalized
// branch: "a cancelled application stops holding the car. Released rather than
// consumed — the deal did not complete." A cancelled deal is DEAD. Making it
// re-hold a vehicle is not a repair; it strands the car on a deal nobody can
// ever complete, and `financedConsignedSettlement.test.ts` already pins the
// consequence — "a vehicle re-sold after a cancellation is judged on the live
// sale only" — a flow whose own comment calls it the case the obligations
// redesign existed to rescue.
//
// I implemented the reviewer's remedy before checking that. It went green on
// their scenario and turned that contract RED. The finding was real; the
// remedy would have shipped a worse defect than the one it addressed.
//
// What actually governs is EVIDENCE, not the application's ghost: the car is
// held exactly while something live holds it. 23.3 is the half that proves the
// rule is not simply "cancellation frees everything".
// ═════════════════════════════════════════════════════════════════════════════

describe("23. a cancelled deal stops holding the car", () => {
  /** A finalized financed deal. `withDeposit` decides whether money is involved. */
  async function finalizedFinancedDeal(
    seed: Seed,
    v: Id<"vehicles">,
    opts: { withDeposit: boolean }
  ) {
    // A deposit has to sit against a NON-FINANCED customer portion, so the
    // deposit case needs a down payment. Without one  refuses
    // with "allocations exceed the non-financed customer balance" -- a SETUP
    // failure that would otherwise be mistaken for the behaviour under test.
    const quoteId = opts.withDeposit
      ? ((await seed.asUser.mutation(api.quotes.saveQuote, {
          orgId: seed.orgId,
          customerId: seed.customerA,
          vehicleId: v,
          mode: "CONFIGURED_FINANCE_COMPANY" as const,
          companyId: seed.companyId,
          vehiclePrice: PRICE,
          downPayment: 3_000,
          termMonths: 48,
          totalFinancedAmount: PRICE - 3_000,
        })) as Id<"quotes">)
      : await financedQuote(seed, seed.customerA, v);
    if (opts.withDeposit) {
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId,
        amount: 1_500,
      });
    }
    const applicationId = (await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    })) as Id<"financeApplications">;

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await seed.asApprover.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now(),
    });
    await seed.asUser.mutation(api.applications.finalizeDeal, {
      orgId: seed.orgId,
      applicationId,
    });
    return { quoteId, applicationId };
  }

  test("23.1 a cancelled PURE-FINANCE deal releases the car for resale", async () => {
    const seed = await seedDealer("cancel-pure-finance");
    const v = await vehicle(seed);
    const { applicationId } = await finalizedFinancedDeal(seed, v, { withDeposit: false });
    expect((await vehicleRow(seed, v)).status, "the sale completed").toBe("SOLD");

    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId,
      reason: "financing fell through",
    });

    // Asserted by CONSEQUENCE. A dead deal must not keep a car nobody can ever
    // sell through it — the dealership has to be able to put it back on the lot.
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    const rivalDeposit = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
      amount: 1_000,
    })) as Id<"deposits">;
    const rivalRow = await seed.t.run((ctx) => ctx.db.get(rivalDeposit));
    expect(
      rivalRow?.holdActive,
      "the car genuinely goes back on the lot and can be sold again"
    ).toBe(true);
  });

  test("23.2 the cancelled application itself holds nothing", async () => {
    const seed = await seedDealer("cancel-holds-nothing");
    const v = await vehicle(seed);
    const { applicationId } = await finalizedFinancedDeal(seed, v, { withDeposit: false });

    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId,
      reason: "financing fell through",
    });

    const root = await resolveRoot(seed, v);
    expect(
      root.kind,
      "a cancelled application stops holding the car — it is not a live deal"
    ).not.toBe("OWNED");
  });

  test("23.3 but a reinstated DEPOSIT keeps holding it", async () => {
    const seed = await seedDealer("cancel-with-deposit");
    const v = await vehicle(seed);
    const { applicationId } = await finalizedFinancedDeal(seed, v, { withDeposit: true });

    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId,
      reason: "financing fell through",
    });

    // The money came back to HELD, so something LIVE holds the car and the
    // customer's payment is not stranded against a vehicle anyone may take.
    // This is why 23.1 is not "cancellation frees everything": what governs is
    // live evidence, not the dead application.
    const root = await resolveRoot(seed, v);
    expect(root.kind, "live money still holds the car").toBe("OWNED");
    expect(root.customerId, "for the customer whose money it is").toEqual(seed.customerA);

    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      })
    , REFUSED, "23.3");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 24. THE ADVERSARIAL ROUND ON 684ee9ef — every finding I could REPRODUCE
//
// Codex xhigh returned six findings and could not execute a single test (its
// vitest died with EPERM, which it disclosed rather than papering over). Owner
// ruling c15247: execute all six before patching anything.
//
// I ran them. Five reproduced outright, one reproduced in code but is currently
// unreachable, and a seventh — nobody's finding — fell out of a probe fixture.
// Nothing was rejected; I went looking for the rejection each time.
//
// Each contract below FAILED FIRST against 684ee9ef/c7c9ddb0f and names the
// consequence in the shop, not the shape of the patch.
//
// ⚠️ FOUR of these are ONE defect class, the same one that has recurred through
// this entire lane: A RULE APPLIED TO SOME WRITERS OF A RECORD AND NOT ALL.
// 24.1 multi-vehicle vs single · 24.2 reservation vs quote deposits · 24.4
// primary vs secondary root · 24.5 quote-keyed vs lineage-keyed. Read them
// together; fixing them one at a time is how this class keeps surviving.
// ═════════════════════════════════════════════════════════════════════════════

describe("24. the adversarial round on 684ee9ef", () => {
  async function rootIdOf(seed: Seed, v: Id<"vehicles">) {
    return ((await resolveRoot(seed, v)).rootId ?? null) as Id<"commitmentRoots"> | null;
  }
  async function allRoots(seed: Seed) {
    return await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
  }
  /** `completeFromQuote` returns one id PER LINE ITEM, so read the row instead. */
  async function theSale(seed: Seed) {
    const rows = await seed.t.run((ctx) => ctx.db.query("sales").collect());
    return rows[0]._id;
  }
  /** Four-eyes: the salesperson may not cancel their own sale. */
  async function cancelSale(seed: Seed, saleId: Id<"sales">) {
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId,
      status: "CANCELLED" as const,
    });
  }
  async function twoCarQuote(seed: Seed, a: Id<"vehicles">, b: Id<"vehicles">, price: number) {
    return await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: price / 2 },
        { vehicleId: b, unitPrice: price / 2 },
      ],
      mode: "CASH" as const,
      vehiclePrice: price,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
  }

  // ── 24.1 — Codex CRITICAL #1 ───────────────────────────────────────────────
  //
  // A REGRESSION, not a gap. The per-quote ceiling this lane replaced counted
  // deposit rows at face value and would have caught this; the root-wide one
  // that replaced it reads a multi-vehicle hold — `active: true` with no
  // `allocatedAmountMinor` and no `allocationStatus` — as ZERO. So the whole
  // deposit vanishes from the check that exists to bound it.
  //
  // 24.1b is the control that makes 24.1 mean something: identical numbers on a
  // single-vehicle quote were ALREADY refused. The difference is the hold shape.

  test("24.1 a second deposit cannot take a MULTI-VEHICLE deal past the quote", async () => {
    const seed = await seedDealer("ceiling-multi");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await twoCarQuote(seed, a, b, 30_000);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 20_000 });

    // 20,000 + 20,000 against a 30,000 deal. The customer is not owed a receipt
    // for 40,000 on a car that costs 30,000.
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 20_000 }),
      /exceed/i,
      "24.1"
    );
  });

  test("24.1b CONTROL the same breach on a single-vehicle deal was already refused", async () => {
    const seed = await seedDealer("ceiling-single");
    const a = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 20_000 });
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 20_000 }),
      /exceed/i,
      "24.1b"
    );
  });

  // ── 24.2 — Codex CRITICAL #2 ───────────────────────────────────────────────
  //
  // `createReservation` acquires the car WITHOUT passing `depositId`, so the
  // RESERVATION claim carries none — and a non-quote deposit reaches the root
  // only through `claim.depositId`. Real money the dealership holds is
  // invisible to the authority that governs the deal it belongs to.
  //
  // Asserted by CONSEQUENCE: once the reservation is released the root is no
  // longer OPEN, so the open-root guard cannot see the customer either, and
  // somebody with 5,000 of their money still HELD can be deleted.

  test("24.2 a customer with a live RESERVATION deposit cannot be deleted", async () => {
    const seed = await seedDealer("resv-money");
    const v = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: 5_000,
    });
    await seed.asUser.mutation(api.vehicles.releaseReservation, {
      orgId: seed.orgId,
      reservationId,
    });

    const deposit = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.reservationId === reservationId)
    );
    expect(deposit?.status, "the money is still HELD — nobody has ruled on it").toBe("HELD");

    await expectRefusal(
      seed.asUser.mutation(api.customers.softDelete, {
        orgId: seed.orgId,
        customerId: seed.customerA,
      }),
      /active or financially unresolved commitment/i,
      "24.2"
    );
  });

  // ── 24.3 — Codex HIGH #3 ───────────────────────────────────────────────────
  //
  // The founding invariant of this lane: one physical vehicle, at most one
  // logical root. Cancelling a sale minted a SECOND one and left the quote
  // pointing at the dead first — so the money view and the acquisition view
  // read different roots for the same car.

  test("24.3 cancelling a sale does not mint a second root for the same car", async () => {
    const seed = await seedDealer("cancel-root");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);
    const before = await rootIdOf(seed, v);

    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });
    await cancelSale(seed, await theSale(seed));

    const after = await rootIdOf(seed, v);
    expect(String(after), "the deal keeps the identity it had").toBe(String(before));

    const quoteRow = await seed.t.run((ctx) => ctx.db.get(quoteId as Id<"quotes">));
    expect(String(quoteRow?.rootId), "and the quote still points at it").toBe(String(after));

    const live = (await allRoots(seed)).filter((r) => r.status === "OPEN");
    expect(live.length, "exactly one live root for one physical car").toBe(1);
  });

  // ── 24.4 — Codex HIGH #5 ───────────────────────────────────────────────────
  //
  // A revision advances `lineageRootId` — the PRIMARY vehicle's root — and
  // nothing else. Every other car on the deal keeps a root whose head is the
  // superseded quote, and the deal is then refused its own second car: the
  // successor proves lineage to root A and vehicle B's claims name the
  // predecessor.

  test("24.4 revising a MULTI-VEHICLE deal keeps every car on the deal", async () => {
    const seed = await seedDealer("revise-multi");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const q1 = await twoCarQuote(seed, a, b, 30_000);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: q1, amount: 3_000 });

    const q2 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: 14_000 },
        { vehicleId: b, unitPrice: 14_000 },
      ],
      mode: "CASH" as const,
      vehiclePrice: 28_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      intent: "REVISE" as const,
      supersedesQuoteId: q1 as Id<"quotes">,
    });

    // No root on this deal may still be headed by the revision it moved past.
    for (const root of (await allRoots(seed)).filter((r) => r.status === "OPEN")) {
      const head = root.headQuoteId ? await seed.t.run((ctx) => ctx.db.get(root.headQuoteId!)) : null;
      expect(
        head?.supersededByQuoteId,
        `root ${root._id} is still headed by a superseded revision`
      ).toBeUndefined();
    }

    // The consequence, and the reason this matters in the shop: the deal must
    // still be able to take money on BOTH the cars it is a deal for.
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: q2, amount: 2_000 });
  });

  // ── 24.5 — MINE. Nobody reported this one ──────────────────────────────────
  //
  // Found by a probe fixture while reproducing Codex #4, not by looking for it.
  //
  // `getSafelyReversiblePaymentKeys` builds its safe set from deposits filed
  // `by_quote` on `sale.quoteId`. On a revised deal the deposit stays on the
  // PREDECESSOR while the sale completes from the SUCCESSOR, so the deposit's
  // own payment is not recognised as safely reversible and the cancellation is
  // refused — with a message about payments the dealership never took.
  //
  // Caused by this lane: revisions and lineage-wide deposit application are
  // both new here. Before, a deposit and its sale always shared one quote id.
  //
  // ⚠️ This is also what makes Codex #4 unreachable today — the reversal path
  // that skips `assertCurrentRevision` cannot be entered while this refuses
  // first. Repairing this ALONE converts an unreachable defect into a live one,
  // which is why 24.6 ships in the same commit.

  test("24.5 a REVISED deal that completed can still be cancelled", async () => {
    const seed = await seedDealer("revised-cancel");
    const v = await vehicle(seed);
    const q1 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: q1, amount: 3_000 });
    const q2 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: 28_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      intent: "REVISE" as const,
      supersedesQuoteId: q1 as Id<"quotes">,
    });
    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId: q2 });

    // The deposit is filed under q1; the sale completed from q2. Same deal.
    await cancelSale(seed, await theSale(seed));
    expect((await vehicleRow(seed, v)).status, "the car came back out of the sale").not.toBe("SOLD");
  });

  // ── 24.6 — Codex HIGH #4 ───────────────────────────────────────────────────
  //
  // Reproduced in code, not reachable until 24.5 is fixed. `restoreCommitment`
  // re-acquires under whatever quote the deposit row happens to carry, with no
  // `assertCurrentRevision` — and 24.3 proves that call turns the quote it is
  // handed into a root HEAD. On a revised deal that quote is superseded, so the
  // reversal would leave the deal headed by a revision it had already moved on
  // from, and every later evidence check would be measured against the wrong
  // price.

  test("24.6 reversing a REVISED deal leaves the head on the current revision", async () => {
    const seed = await seedDealer("revised-head");
    const v = await vehicle(seed);
    const q1 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: q1, amount: 3_000 });
    const q2 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: 28_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      intent: "REVISE" as const,
      supersedesQuoteId: q1 as Id<"quotes">,
    });
    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId: q2 });
    await cancelSale(seed, await theSale(seed));

    for (const root of (await allRoots(seed)).filter((r) => r.status === "OPEN")) {
      const head = root.headQuoteId ? await seed.t.run((ctx) => ctx.db.get(root.headQuoteId!)) : null;
      expect(
        head?.supersededByQuoteId,
        "a reversal must not leave the deal headed by a revision it moved past"
      ).toBeUndefined();
      expect(String(root.headQuoteId), "the head is the CURRENT revision").toBe(String(q2));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 25. A CAR THAT WENT HOME WITH SOMEBODY IS NOT BACK UNTIL SOMEBODY SAYS SO
//
// Owner ruling c15247, reclassifying the Sonnet MAX CRITICAL as
// VALIDATED UNDERLYING BLOCKER — WRONG PROPOSED REMEDY.
//
// Sonnet's remedy — resurrect the FINANCE claim on cancellation — is wrong and
// section 23 pins why: a cancelled deal is dead and must not hold inventory
// forever. But the worry underneath it survived that rejection intact:
//
//   handover is PROVEN — `vehicleHandoverAt` is recorded, and finalization
//   cannot happen without it — while RETURN is merely ASSUMED.
//
// `restoreVehicleFromSale` never reads handover at all. It patches the car
// straight back to `preHoldStatus ?? AVAILABLE`, so a vehicle that is
// physically sitting in a customer's driveway reappears on the lot as stock,
// and the dealership can sell it to somebody else sight unseen.
//
// ⚠️ I first tried the option c15247 offered second — park the car in an
// existing non-sellable state. It does not work, and the codebase says so out
// loud: `utils/depositHelpers` states that "IN_INSPECTION / IN_REPAIR stay out
// on purpose: those describe where the car IS, not whether it is spoken for",
// and `prepareSaleCompletion` refuses only ARCHIVED. A status that gates
// nothing is not a control. Same lesson as `vehicle.status` itself — the
// projection is never the lock.
//
// So custody is EVIDENCE, recorded on the deal, and the lock is at the
// irreversible door. The car still goes to IN_INSPECTION, because that is
// where it honestly is; it just is not what enforces anything.
//
// The gate is deliberately narrow: it refuses a sale to SOMEBODY ELSE. Selling
// the car back to the person who already has it needs no return trip, and
// refusing that would strand the one deal that is certainly safe.
// ═════════════════════════════════════════════════════════════════════════════

describe("25. a handed-over car is not sellable until it is back", () => {
  /** A finalized financed deal, then cancelled — the car left and came back. */
  async function handedOverThenCancelled(seed: Seed, v: Id<"vehicles">) {
    const quoteId = await financedQuote(seed, seed.customerA, v);
    const applicationId = (await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    })) as Id<"financeApplications">;
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await seed.asApprover.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    // The car physically goes to the customer. finalizeDeal cannot run without
    // this, which is exactly why a reversal always happens AFTER the car left.
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now(),
    });
    await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId });
    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId,
      reason: "financing fell through after handover",
    });
    return { applicationId };
  }

  test("25.1 it cannot be sold to somebody else while its return is unproven", async () => {
    const seed = await seedDealer("custody-rival");
    const v = await vehicle(seed);
    await handedOverThenCancelled(seed, v);

    // The commitment is genuinely released — section 23 requires that, and a
    // rival may absolutely start a deal on the car. What they may not do is
    // COMPLETE one, because nobody has said the car is back.
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId: rivalQuote }),
      /handed over|came back|returned|custody|still with/i,
      "25.1"
    );
  });

  test("25.2 the car reads as being where it actually is", async () => {
    const seed = await seedDealer("custody-status");
    const v = await vehicle(seed);
    await handedOverThenCancelled(seed, v);
    expect(
      (await vehicleRow(seed, v)).status,
      "a car in somebody's driveway is not lot stock"
    ).not.toBe("AVAILABLE");
  });

  test("25.3 POSITIVE CONTROL registering the return unblocks the sale", async () => {
    const seed = await seedDealer("custody-returned");
    const v = await vehicle(seed);
    const { applicationId } = await handedOverThenCancelled(seed, v);

    await seed.asUser.mutation(api.applications.registerVehicleReturn, {
      orgId: seed.orgId,
      applicationId,
      notes: "inspected, back on the lot",
    });

    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await seed.asUser.mutation(api.sales.completeFromQuote, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
    });
    expect((await vehicleRow(seed, v)).status, "the sale went through").toBe("SOLD");
  });

  test("25.4 selling it back to the person who HAS it is never blocked", async () => {
    const seed = await seedDealer("custody-same");
    const v = await vehicle(seed);
    await handedOverThenCancelled(seed, v);

    // No return trip is involved: the car is already with this customer.
    const againQuote = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.sales.completeFromQuote, {
      orgId: seed.orgId,
      quoteId: againQuote,
    });
    expect((await vehicleRow(seed, v)).status, "their own deal completes").toBe("SOLD");
  });

  test("25.5 a deal that never handed the car over is untouched", async () => {
    const seed = await seedDealer("custody-nohandover");
    const v = await vehicle(seed);
    // No handover anywhere in this car's history — an ordinary cash sale to a
    // new customer must not inherit a custody question it never had.
    const quoteId = await cashQuote(seed, seed.customerB, v);
    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });
    expect((await vehicleRow(seed, v)).status, "nothing changed for ordinary sales").toBe("SOLD");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 26. THE SCREEN IS TOLD THE SAME THING THE RULE ENFORCES
//
// `commitments.dealContinuation` is what makes linked revision and reservation
// adoption reachable at all: the salesperson never types a `supersedesQuoteId`,
// the screen asks what saving would DO and says so. That makes this query
// load-bearing — a wrong answer here sends the wrong lineage to a mutation that
// will take it.
//
// ⚠️ The one that matters most is 26.5. A display figure that DISAGREES with
// the rule it describes is worse than no figure: it tells the salesperson their
// requote is fine and then the server refuses it, or the reverse. So the money
// this query reports is asserted to be the money the ceiling actually uses,
// rather than merely "a number that looks right".
//
// This is advisory only and says so in its own doc comment — `saveQuote`
// re-derives every one of these decisions inside its transaction. These
// contracts pin the ADVICE, and section 24 pins the enforcement.
// ═════════════════════════════════════════════════════════════════════════════

describe("26. what the screen is told about a deal", () => {
  async function continuationFor(seed: Seed, v: Id<"vehicles">, customerId: Id<"customers">) {
    return (await seed.asUser.query(api.commitments.dealContinuation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId,
    })) as { kind: string; [k: string]: unknown };
  }

  test("26.1 a free car is an ordinary new deal", async () => {
    const seed = await seedDealer("cont-free");
    const v = await vehicle(seed);
    expect((await continuationFor(seed, v, seed.customerA)).kind).toBe("NEW");
  });

  test("26.2 their own reservation is offered for adoption, by id", async () => {
    const seed = await seedDealer("cont-resv");
    const v = await vehicle(seed);
    const { reservationId } = await heldByReservation(seed, v, seed.customerA);

    const answer = await continuationFor(seed, v, seed.customerA);
    expect(answer.kind, "the reservation is the deal's first evidence").toBe("ADOPT_RESERVATION");
    // The id matters: the client sends this straight back as
    // `adoptReservationId`, and the server validates it against the vehicle,
    // the customer and the reservation's own status.
    expect(answer.reservationId).toEqual(reservationId);
  });

  test("26.3 somebody else's live deal is named as such, not as a new deal", async () => {
    const seed = await seedDealer("cont-rival");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);

    // ⚠️ Asked for customerA — the OTHER customer. Answering "NEW" here would
    // let the screen invite a save the server is certain to refuse.
    expect((await continuationFor(seed, v, seed.customerA)).kind).toBe("HELD_BY_ANOTHER_DEAL");
  });

  test("26.4 a reservation belonging to someone else is not offered for adoption", async () => {
    const seed = await seedDealer("cont-resv-rival");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);

    const answer = await continuationFor(seed, v, seed.customerA);
    expect(answer.kind, "adoption is proof, and this customer has none").not.toBe(
      "ADOPT_RESERVATION"
    );
    expect(answer.kind).toBe("HELD_BY_ANOTHER_DEAL");
  });

  test("26.5 the money it reports IS the money the ceiling enforces", async () => {
    const seed = await seedDealer("cont-money");
    const v = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 12_000 });

    const answer = await continuationFor(seed, v, seed.customerA);
    expect(answer.kind).toBe("REVISE_QUOTE");
    expect(answer.quoteId, "the successor supersedes the current head").toEqual(quoteId);
    expect(answer.unresolvedMoney, "12,000 is on this deal").toBe(12_000);

    // The tie. The screen shows 12,000 and warns below it; the ceiling refuses
    // a further deposit that would push past 30,000. Both must be reading the
    // same figure, or one of them is lying to the salesperson.
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 18_001 }),
      /exceed/i,
      "26.5"
    );
    // And the amount that exactly reaches the ceiling is accepted, so the
    // agreement is on the NUMBER and not merely on refusing generously.
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 18_000 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 28. THE SECOND ADVERSARIAL ROUND — AND TWO DEFECTS MY OWN FIXES CAUSED
//
// Codex xhigh returned BLOCK on 015a64a57 with eight findings and could not
// execute a single test (vitest died on EPERM before collection), so it marked
// every behavioural finding UNRESOLVED rather than implying coverage. I ran the
// six that were reproducible. All six confirmed.
//
// ⚠️ TWO OF THEM WERE INTRODUCED BY LAST ROUND'S FIXES. That is the point of
// this section. A fix does not merely add behaviour — it MOVES which lines are
// load-bearing, and the lines it newly loads were never reviewed as such:
//
//   28.1 — I attached `depositId` to the RESERVATION claim so a reservation's
//          money could reach its root. That made the claim findable by
//          `releaseClaimsForDeposit`, which releases by deposit and never
//          checked `kind`. Refunding the money then released the claim a LIVE
//          reservation was holding the car with, and a rival took the car.
//   28.4 — I added `reopenRootForReversal` so a cancellation would stop minting
//          a second root. It reopens the root of `deposit.vehicleId` — the
//          quote's PRIMARY car — whichever car's sale was actually cancelled.
//
// ⚠️ 28.2 is the one the two seats DISAGREED about, and the sale-side door is
// named in `sales.update`'s own comment: "this is the other door into the same
// reversal, and a lock bolted on only one of them is not a lock." The custody
// gate was bolted onto one door.
//
// Every contract here failed first, by execution, before any fix existed.
// ═════════════════════════════════════════════════════════════════════════════

describe("28. the second adversarial round", () => {
  async function reservedWithDeposit(seed: Seed, v: Id<"vehicles">, amount = 5_000) {
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
      depositAmount: amount,
    });
    const deposit = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).find((d) => d.reservationId === reservationId)
    );
    expect(deposit, "the reservation took real money").toBeTruthy();
    return { reservationId, depositId: deposit!._id };
  }
  async function twoCarQuote(seed: Seed, a: Id<"vehicles">, b: Id<"vehicles">, price: number) {
    return await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: price / 2 },
        { vehicleId: b, unitPrice: price / 2 },
      ],
      mode: "CASH" as const,
      vehiclePrice: price,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
  }
  async function financedHandedOverSale(seed: Seed, v: Id<"vehicles">) {
    const quoteId = await financedQuote(seed, seed.customerA, v);
    const applicationId = (await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    })) as Id<"financeApplications">;
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await seed.asApprover.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now(),
    });
    await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId });
    const sale = (await seed.t.run((ctx) => ctx.db.query("sales").collect()))[0];
    return { applicationId, saleId: sale._id };
  }

  // ── 28.1 — CODEX #2, CRITICAL, FIX-INDUCED ────────────────────────────────

  test("28.1 refunding a reservation's deposit does not give its car away", async () => {
    const seed = await seedDealer("resv-keeps-car");
    const v = await vehicle(seed);
    const { reservationId, depositId } = await reservedWithDeposit(seed, v);

    // Only the MONEY is being resolved. The reservation itself is untouched.
    await seed.asApprover.mutation(api.deposits.release, {
      orgId: seed.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });

    const reservation = await seed.t.run((ctx) => ctx.db.get(reservationId));
    expect(reservation?.status, "the reservation is still live").toBe("ACTIVE");

    // Asserted by CONSEQUENCE: a live reservation means the car is spoken for.
    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      }),
      REFUSED,
      "28.1"
    );
  });

  test("28.1b and releasing the reservation afterwards CLOSES the deal", async () => {
    // The other half: once BOTH the money and the hold are resolved, nothing is
    // outstanding and the customer must not be undeletable. This is also the
    // Sonnet MAX finding — the two seats converged here.
    const seed = await seedDealer("resv-then-closes");
    const v = await vehicle(seed);
    const { reservationId, depositId } = await reservedWithDeposit(seed, v);

    await seed.asApprover.mutation(api.deposits.release, {
      orgId: seed.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });
    await seed.asUser.mutation(api.vehicles.releaseReservation, {
      orgId: seed.orgId,
      reservationId,
    });

    const root = await seed.t.run(async (ctx) =>
      (await ctx.db.query("commitmentRoots").collect()).find((r) => r.vehicleId === v)
    );
    expect(root?.status, "nothing holds the car and nobody is owed money").not.toBe("OPEN");
    await seed.asUser.mutation(api.customers.softDelete, {
      orgId: seed.orgId,
      customerId: seed.customerA,
    });
  });

  test("28.1c the REVERSE order closes it too — money last", async () => {
    // Sonnet MAX's ordering. `releaseClaimsForDeposit` finds the claim already
    // RELEASED and must still ask the root again; nothing else ever will.
    const seed = await seedDealer("money-last");
    const v = await vehicle(seed);
    const { reservationId, depositId } = await reservedWithDeposit(seed, v);

    await seed.asUser.mutation(api.vehicles.releaseReservation, {
      orgId: seed.orgId,
      reservationId,
    });
    const midway = await seed.t.run(async (ctx) =>
      (await ctx.db.query("commitmentRoots").collect()).find((r) => r.vehicleId === v)
    );
    expect(midway?.status, "money still undecided keeps it open — c14909").toBe("OPEN");

    await seed.asApprover.mutation(api.deposits.release, {
      orgId: seed.orgId,
      depositId,
      resolution: "REFUNDED" as const,
      refundMethod: "CASH" as const,
    });

    const after = await seed.t.run(async (ctx) =>
      (await ctx.db.query("commitmentRoots").collect()).find((r) => r.vehicleId === v)
    );
    expect(after?.status, "the money was the last thing outstanding").not.toBe("OPEN");
    await seed.asUser.mutation(api.customers.softDelete, {
      orgId: seed.orgId,
      customerId: seed.customerA,
    });
  });

  // ── 28.2 — CODEX #3, CRITICAL — the other cancellation door ───────────────

  test("28.2 the SALE-side cancellation guards custody too", async () => {
    const seed = await seedDealer("custody-sale-door");
    const v = await vehicle(seed);
    const { saleId } = await financedHandedOverSale(seed, v);

    // ⚠️ NOT applications.cancelApplication. The other door.
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId,
      status: "CANCELLED" as const,
    });

    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await expectRefusal(
      seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId: rivalQuote }),
      /handed over|came back|returned|custody|still with/i,
      "28.2"
    );
  });

  test("28.2b and that refusal has a way out on this door as well", async () => {
    // A rule whose remedy is unreachable is the defect this lane already found
    // once. `registerVehicleReturn` must accept the sale-cancelled shape too.
    const seed = await seedDealer("custody-sale-remedy");
    const v = await vehicle(seed);
    const { applicationId, saleId } = await financedHandedOverSale(seed, v);
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId,
      status: "CANCELLED" as const,
    });

    await seed.asUser.mutation(api.applications.registerVehicleReturn, {
      orgId: seed.orgId,
      applicationId,
      notes: "came back, inspected",
    });

    const rivalQuote = await cashQuote(seed, seed.customerB, v);
    await seed.asUser.mutation(api.sales.completeFromQuote, {
      orgId: seed.orgId,
      quoteId: rivalQuote,
    });
    expect((await vehicleRow(seed, v)).status, "the car is genuinely sellable again").toBe("SOLD");
  });

  // ── 28.3 — CODEX #6, HIGH — money that never moved has not left ───────────

  test("28.3 an OTHER ruling moves no money, so none of it leaves the deal", async () => {
    const seed = await seedDealer("other-stays");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await twoCarQuote(seed, a, b, 30_000);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 6_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: a, amount: 3_000 },
        { vehicleId: b, amount: 3_000 },
      ],
    });
    await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
      orgId: seed.orgId,
      quoteId,
      vehicleId: b,
      reason: "customer dropped the second car",
    });
    const hold = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).find(
        (h) => h.vehicleId === b && h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: hold!._id,
      treatment: "OTHER" as const,
      reason: "settled outside the system, manual journal to follow",
    });

    const deposit = await seed.t.run(async (ctx) => (await ctx.db.query("deposits").collect())[0]);
    expect(deposit?.status, "the row still holds the money").toBe("HELD");
    expect(deposit?.releasedAmountMinor ?? 0, "nothing was paid out").toBe(0);

    const rootId = ((await resolveRoot(seed, a)).rootId ?? null) as Id<"commitmentRoots"> | null;
    const minor = await seed.t.run((ctx) => unresolvedRootMoneyMinor(ctx, rootId!));
    // ⚠️ FAIL CLOSED. OTHER means a human did something this system does not
    // model. We cannot know the money left, so we must not assume it did — the
    // only safe direction is to keep counting it against the deal.
    expect(minor, "all 6,000 is still the customer's money on this deal").toBe(6_000_000);
  });

  // ── 28.4 — CODEX #5, HIGH, FIX-INDUCED ───────────────────────────────────

  test("28.4 cancelling one car's sale leaves the other car sold", async () => {
    const seed = await seedDealer("multi-cancel");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await twoCarQuote(seed, a, b, 30_000);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 6_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: a, amount: 3_000 },
        { vehicleId: b, amount: 3_000 },
      ],
    });
    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });

    const sales = await seed.t.run((ctx) => ctx.db.query("sales").collect());
    const saleB = sales.find((x) => x.vehicleId === b);
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId: saleB!._id,
      status: "CANCELLED" as const,
    });

    // Car A's sale still stands. Nothing may be holding it again.
    expect((await resolveRoot(seed, a)).kind, "A is sold — nothing holds it").not.toBe("OWNED");
    const activeOnA = await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleCommitmentClaims").collect()).filter(
        (c) => c.vehicleId === a && c.status === "ACTIVE"
      )
    );
    expect(activeOnA.length, "and no live claim sits on a SOLD car").toBe(0);
  });

  // ── 28.5 — CODEX #4, HIGH — adoption must establish a head ───────────────

  test("28.5 one reservation cannot become two live quotes", async () => {
    const seed = await seedDealer("adopt-once");
    const v = await vehicle(seed);
    const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
      orgId: seed.orgId,
      vehicleId: v,
      customerId: seed.customerA,
    });
    const q1 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      intent: "NEW" as const,
      adoptReservationId: reservationId,
    });

    const root = await seed.t.run(async (ctx) =>
      (await ctx.db.query("commitmentRoots").collect()).find((r) => r.vehicleId === v)
    );
    expect(
      String(root?.headQuoteId),
      "adopting establishes the deal's current head"
    ).toBe(String(q1));

    // A second adoption of the same reservation would fork the deal into two
    // live heads at two different prices. It must not be possible.
    await expectRefusal(
      seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v,
        mode: "CASH" as const,
        vehiclePrice: 25_000,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
        intent: "NEW" as const,
        adoptReservationId: reservationId,
      }),
      BAD_PROOF,
      "28.5"
    );
  });

  // ── 28.6 — CODEX #8, LOW — tenancy on the advisory query ─────────────────

  test("28.6 dealContinuation refuses a customer from another organization", async () => {
    const seed = await seedDealer("cont-tenancy");
    const v = await vehicle(seed);

    // ⚠️ A SECOND ORG INSIDE THE SAME DATABASE. My first version of this
    // contract built the other org with a second `seedDealer`, which spins up
    // its own convex-test instance — and convex-test generates DETERMINISTIC
    // ids, so the "foreign" customer id collided with a real customer in THIS
    // org and the query answered about the wrong person entirely. The test
    // failed for a fixture reason while the guard under test was already
    // correct. A cross-tenant test has to put both tenants in one database.
    const foreignOrgId = await seed.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Rival Motors", createdAt: Date.now() })
    );
    const foreignCustomerId = await seed.t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId: foreignOrgId,
        firstName: "Someone",
        lastName: "Elsewhere",
      })
    );

    await expectRefusal(
      seed.asUser.query(api.commitments.dealContinuation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: foreignCustomerId,
      }),
      /not found|another organization|organization/i,
      "28.6"
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 29. THE BREAKER-CLEAR SPEC — CLAIM-DRIVEN REVERSAL AND TWO MONEY QUESTIONS
//
// ⚠️ THIS SECTION IS EXPECTED TO FAIL. It is the failing-first specification
// authorised by owner ruling c15266 after the convergence circuit breaker fired
// on `afb4394af`. No production code accompanies it, deliberately: two
// consecutive rounds of fix-induced HIGH/CRITICAL defects in this subsystem
// means the next thing written must be the SPEC, not another patch.
//
// ## Why every previous fix relocated the defect instead of removing it
//
// Round 1 attached `depositId` to a RESERVATION claim → refunding the deposit
// took the car from a live reservation. Round 2 threaded the reversed vehicle
// through → the ghost claim moved from car A to car B, and B gained a second
// root. Each repair corrected an ARGUMENT. None corrected the PREMISE.
//
// The premise is visible in the schema, not the code:
//
//   `vehicleCommitmentClaims` records `status: "CONSUMED"` — and NOTHING that
//   says WHICH SALE consumed it.
//
// So reversal has always had to INFER which claim to restore, from whatever was
// to hand: `deposit.vehicleId` (the quote's primary car) and `quote.rootId`
// (the primary car's root). On a one-car deal those inferences are accidentally
// right, which is why this survived so long. On a multi-car deal they are
// wrong, and every attempt to pass a better-chosen id is another guess.
//
// ⚠️ THE FIX IS A RECORD, NOT AN ARGUMENT. Sale completion must durably record
// the exact per-vehicle/root claims it consumed, and reversal must restore only
// those, on that exact root. There is then nothing left to infer.
//
// **29.1 will fail because the field does not exist yet.** That is the point:
// the spec names the missing durable fact rather than describing a smarter way
// to guess it.
//
// ## What c14865 / c15266 keep fixed while this changes
//
//   · dead FINANCE stays dead — a cancelled application never re-holds a car
//   · DEPOSIT and RESERVATION revive only when THEIR OWN lifecycle is restored
//   · the current linked quote head is never rewound by a reversal
//   · `vehicle.status` remains an advisory projection and never the authority
// ═════════════════════════════════════════════════════════════════════════════

describe("29. breaker-clear spec: claim-driven reversal", () => {
  async function twoCarQuote(seed: Seed, a: Id<"vehicles">, b: Id<"vehicles">) {
    return await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: 15_000 },
        { vehicleId: b, unitPrice: 15_000 },
      ],
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
  }

  /** Two cars, one deposit split across both, both sold. Then B is cancelled. */
  async function twoCarSaleWithBCancelled(seed: Seed) {
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await twoCarQuote(seed, a, b);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 6_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: a, amount: 3_000 },
        { vehicleId: b, amount: 3_000 },
      ],
    });
    const rootsBefore = await seed.t.run((ctx) => ctx.db.query("commitmentRoots").collect());
    const rootABefore = rootsBefore.find((r) => r.vehicleId === a)?._id;
    const rootBBefore = rootsBefore.find((r) => r.vehicleId === b)?._id;

    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });
    const sales = await seed.t.run((ctx) => ctx.db.query("sales").collect());
    const saleB = sales.find((x) => x.vehicleId === b)!;
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId: saleB._id,
      status: "CANCELLED" as const,
    });
    return { a, b, quoteId, rootABefore, rootBBefore, saleB };
  }

  async function claimsOn(seed: Seed, v: Id<"vehicles">) {
    return await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleCommitmentClaims").collect()).filter((c) => c.vehicleId === v)
    );
  }
  async function rootsOn(seed: Seed, v: Id<"vehicles">) {
    return await seed.t.run(async (ctx) =>
      (await ctx.db.query("commitmentRoots").collect()).filter((r) => r.vehicleId === v)
    );
  }

  // ── The missing durable fact ──────────────────────────────────────────────

  test("29.1 a completed sale records WHICH claim it consumed", async () => {
    const seed = await seedDealer("spec-consumed-by");
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await twoCarQuote(seed, a, b);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 6_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: a, amount: 3_000 },
        { vehicleId: b, amount: 3_000 },
      ],
    });
    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });

    const sales = await seed.t.run((ctx) => ctx.db.query("sales").collect());
    for (const v of [a, b]) {
      const sale = sales.find((x) => x.vehicleId === v)!;
      const consumed = (await claimsOn(seed, v)).filter((c) => c.status === "CONSUMED");
      expect(consumed.length, "each car's sale consumed a claim").toBeGreaterThan(0);
      for (const claim of consumed) {
        // ⚠️ THE WHOLE REDESIGN RESTS ON THIS FIELD. Without it, reversal must
        // guess which claim belongs to the sale being undone, and every guess so
        // far has been wrong on multi-car deals.
        expect(
          (claim as unknown as { consumedBySaleId?: unknown }).consumedBySaleId,
          "the claim names the sale that consumed it"
        ).toBeTruthy();
        expect(
          String((claim as unknown as { consumedBySaleId?: unknown }).consumedBySaleId),
          "and it is THIS car's sale, not the quote's primary one"
        ).toBe(String(sale._id));
      }
    }
  });

  // ── Reversal restores exactly what that sale consumed ─────────────────────

  test("29.2 cancelling car B's sale leaves car A's sale untouched", async () => {
    const seed = await seedDealer("spec-a-untouched");
    const { a, rootABefore } = await twoCarSaleWithBCancelled(seed);

    expect((await vehicleRow(seed, a)).status, "A is still sold").toBe("SOLD");
    const activeOnA = (await claimsOn(seed, a)).filter((c) => c.status === "ACTIVE");
    expect(activeOnA.length, "nothing holds a car that is still sold").toBe(0);
    const rootsA = await rootsOn(seed, a);
    expect(rootsA.length, "A keeps exactly one root").toBe(1);
    expect(String(rootsA[0]._id), "and it is the root it always had").toBe(String(rootABefore));
    expect(rootsA[0].status, "A's deal completed — it stays consumed").toBe("CONSUMED");
  });

  test("29.3 car B keeps the root it had — a reversal never mints a second", async () => {
    const seed = await seedDealer("spec-b-one-root");
    const { b, rootBBefore } = await twoCarSaleWithBCancelled(seed);

    const rootsB = await rootsOn(seed, b);
    expect(rootsB.length, "one physical car, one root").toBe(1);
    expect(String(rootsB[0]._id), "restored onto the root that consumed it").toBe(
      String(rootBBefore)
    );
  });

  test("29.4 car B ends in a state somebody can actually act on", async () => {
    // ⚠️ Asserted as CONSISTENCY, not as a specific answer. B may legitimately
    // be held (its money is still on the deal) or free (the deal let it go) —
    // what it may NOT be is held by a claim nothing backs, which is what the
    // round-2 repair produced: vehicle AVAILABLE, authority OWNED, and every
    // acquisition refused forever.
    const seed = await seedDealer("spec-b-actionable");
    const { b } = await twoCarSaleWithBCancelled(seed);

    const root = await resolveRoot(seed, b);
    const rivalQuote = await cashQuote(seed, seed.customerB, b);
    let rivalRefused = false;
    try {
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: rivalQuote,
        amount: 1_000,
      });
    } catch {
      rivalRefused = true;
    }

    if (root.kind === "OWNED") {
      // Held: then the ORIGINAL customer must be able to carry on with it.
      expect(root.customerId, "held for the customer whose deal it is").toEqual(seed.customerA);
      const ownQuote = await cashQuote(seed, seed.customerA, b);
      await seed.asUser.mutation(api.deposits.create, {
        orgId: seed.orgId,
        quoteId: ownQuote,
        amount: 1_000,
      });
    } else {
      // Free: then anybody may take it.
      expect(rivalRefused, "a free car is acquirable").toBe(false);
    }
  });

  // ── What must NOT change ──────────────────────────────────────────────────

  test("29.5 a reversal does not rewind the deal's current quote head", async () => {
    const seed = await seedDealer("spec-head-not-rewound");
    const v = await vehicle(seed);
    const q1 = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: q1, amount: 1_000 });
    const q2 = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: v,
      mode: "CASH" as const,
      vehiclePrice: PRICE,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
      intent: "REVISE" as const,
      supersedesQuoteId: q1 as Id<"quotes">,
    });
    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId: q2 });
    const sale = (await seed.t.run((ctx) => ctx.db.query("sales").collect()))[0];
    await seed.asApprover.mutation(api.sales.update, {
      orgId: seed.orgId,
      saleId: sale._id,
      status: "CANCELLED" as const,
    });

    for (const root of await rootsOn(seed, v)) {
      expect(
        String(root.headQuoteId),
        "the deal's head stays on the revision it reached"
      ).toBe(String(q2));
    }
  });

  test("29.6 a cancelled FINANCE deal stays dead through the reversal", async () => {
    // Carried forward from section 23 as a GUARD ON THE REDESIGN: making
    // reversal claim-driven must not resurrect the one claim kind that is
    // supposed to stay dead. `cancelApplication` states the rule in its own
    // branch — "a cancelled application stops holding the car."
    const seed = await seedDealer("spec-finance-stays-dead");
    const v = await vehicle(seed);
    const quoteId = await financedQuote(seed, seed.customerA, v);
    const applicationId = (await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    })) as Id<"financeApplications">;
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "UNDER_REVIEW" as const,
    });
    await seed.asApprover.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "APPROVED" as const,
    });
    await registerHandover(seed.asUser, api, seed.orgId, applicationId);
    await seed.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: seed.orgId,
      applicationId,
      method: "CASH" as const,
      expectedDate: Date.now(),
    });
    await seed.asUser.mutation(api.applications.finalizeDeal, { orgId: seed.orgId, applicationId });
    await seed.asUser.mutation(api.applications.cancelApplication, {
      orgId: seed.orgId,
      applicationId,
      reason: "financing fell through",
    });

    const financeClaims = (await claimsOn(seed, v)).filter((c) => c.kind === "FINANCE");
    expect(
      financeClaims.some((c) => c.status === "ACTIVE"),
      "a dead application never holds the car again"
    ).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 29b. THE TWO MONEY QUESTIONS (c15266)
//
// One filter was answering both, with OPPOSITE safe directions, and that is
// what stranded a deal permanently:
//
//   CEILING  — "how much of this customer's money is on the deal", used to
//              bound a further deposit. Conservative: money that has not
//              PROVABLY left keeps counting. `OTHER` never moved, so it counts.
//   CLOSURE  — "does anybody still owe this customer a decision", used to end
//              the deal and to allow deleting the customer. A recorded terminal
//              `OTHER` IS a decision; it is simply one this system does not
//              model. RELEASED_AWAITING_DECISION and REVERSING are genuinely
//              undecided and still block.
//
// ⚠️ 29b.3 is the guard on the remedy, not on the defect: relaxing closure must
// not start closing deals whose money nobody has ruled on.
// ═════════════════════════════════════════════════════════════════════════════

describe("29b. ceiling money and closure money are different questions", () => {
  async function twoCarWithOneSliceOther(seed: Seed) {
    const a = await vehicle(seed);
    const b = await vehicle(seed);
    const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
      orgId: seed.orgId,
      customerId: seed.customerA,
      vehicleId: a,
      vehicleItems: [
        { vehicleId: a, unitPrice: 15_000 },
        { vehicleId: b, unitPrice: 15_000 },
      ],
      mode: "CASH" as const,
      vehiclePrice: 30_000,
      downPayment: 0,
      termMonths: 0,
      totalFinancedAmount: 0,
    });
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 6_000 });
    await seed.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: seed.orgId,
      quoteId,
      allocations: [
        { vehicleId: a, amount: 3_000 },
        { vehicleId: b, amount: 3_000 },
      ],
    });
    const rootB = ((await resolveRoot(seed, b)).rootId ?? null) as Id<"commitmentRoots">;
    for (const v of [a, b]) {
      await seed.asUser.mutation(api.deposits.releaseVehicleAllocation, {
        orgId: seed.orgId,
        quoteId,
        vehicleId: v,
        reason: "customer changed their mind",
      });
    }
    const holds = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    return { a, b, quoteId, rootB, holds };
  }

  test("29b.1 the CEILING keeps counting money that never moved", async () => {
    const seed = await seedDealer("spec-ceiling-other");
    const { a, b, rootB, holds } = await twoCarWithOneSliceOther(seed);
    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: holds.find((h) => h.vehicleId === a)!._id,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
      reason: "refunded",
    });
    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: holds.find((h) => h.vehicleId === b)!._id,
      treatment: "OTHER" as const,
      reason: "settled outside the system, manual journal to follow",
    });

    const ceiling = await seed.t.run((ctx) => unresolvedRootMoneyMinor(ctx, rootB));
    expect(ceiling, "OTHER money never left, so it still bounds a further deposit").toBe(3_000_000);
  });

  test("29b.2 but CLOSURE treats a recorded OTHER as the decision it is", async () => {
    const seed = await seedDealer("spec-closure-other");
    const { a, b, rootB, holds } = await twoCarWithOneSliceOther(seed);
    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: holds.find((h) => h.vehicleId === a)!._id,
      treatment: "REFUND_TO_CUSTOMER" as const,
      refundMethod: "CASH" as const,
      reason: "refunded",
    });
    await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: holds.find((h) => h.vehicleId === b)!._id,
      treatment: "OTHER" as const,
      reason: "settled outside the system, manual journal to follow",
    });

    const closure = await seed.t.run((ctx) => residualUnsettledRootMoneyMinor(ctx, rootB));
    expect(closure, "somebody ruled on it — nothing is pending").toBe(0);

    const root = await seed.t.run((ctx) => ctx.db.get(rootB));
    expect(root?.status, "so the deal is allowed to end").not.toBe("OPEN");
  });

  test("29b.3 GUARD — undecided money still blocks closure", async () => {
    // The remedy must not start closing deals nobody has ruled on. A slice left
    // at RELEASED_AWAITING_DECISION is exactly that: taken off a car, waiting
    // for a person. c14909 exists for this case.
    const seed = await seedDealer("spec-closure-guard");
    const { b, rootB } = await twoCarWithOneSliceOther(seed);
    void b;

    const closure = await seed.t.run((ctx) => residualUnsettledRootMoneyMinor(ctx, rootB));
    expect(closure, "nobody has decided yet — this still blocks").toBeGreaterThan(0);
    const root = await seed.t.run((ctx) => ctx.db.get(rootB));
    expect(root?.status, "and the deal stays open").toBe("OPEN");
  });

  test("29b.4 deleting a customer asks the CLOSURE question, not the ceiling", async () => {
    const seed = await seedDealer("spec-delete-closure");
    const { a, b, holds } = await twoCarWithOneSliceOther(seed);
    void b;
    for (const h of holds) {
      await seed.asApprover.mutation(api.deposits.resolveReleasedAllocation, {
        orgId: seed.orgId,
        holdId: h._id,
        treatment: h.vehicleId === a ? ("REFUND_TO_CUSTOMER" as const) : ("OTHER" as const),
        ...(h.vehicleId === a ? { refundMethod: "CASH" as const } : {}),
        reason: "resolved",
      });
    }

    // Every slice has a recorded disposition. Nobody is owed an answer, so the
    // customer must not be undeletable — even though the ceiling still counts
    // the OTHER money, which is a different question entirely.
    await seed.asUser.mutation(api.customers.softDelete, {
      orgId: seed.orgId,
      customerId: seed.customerA,
    });
  });
});
