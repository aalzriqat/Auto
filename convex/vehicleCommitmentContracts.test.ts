import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { anyApi, FunctionReference } from "convex/server";

/**
 * SCRUM-195 — DIRECT EXECUTABLE CONTRACTS (owner ruling c14852).
 *
 * ## Why this replaced the declarative model
 *
 * Rounds 6–8 kept producing the same shape of failure, and it was not in the
 * accounting model — the domain rulings held up under every attack. It was in
 * the PROOF MACHINERY. Each round I built a more sophisticated mechanism to
 * prove the design was consistent, verified it myself, and published a claim
 * about it. Each round an executing reviewer showed the mechanism itself was
 * manufacturing confidence it had not earned:
 *
 *   - the contradiction preflight covered scenarios but not query contracts,
 *     while I described the contradiction class as unrepresentable;
 *   - INV-4 was "proven three ways" and fell to `socialBulkMutation`, an idiom
 *     already used in this repository;
 *   - "zero wrong-reason failures" was true of the 44 failing tests and false
 *     of the 32 passing ones, because I only ever audited failures. One test
 *     was green because a SETUP error message happened to contain "idempoten",
 *     which matched the refusal regex, so the call under test never ran.
 *
 * The generic executor was the common cause. A single `buildWorld` meant one
 * mis-built world silently mis-stated many rules at once; a single `invoke`
 * meant setup failures were funnelled through the same promise the assertion
 * inspected; and an abstract world value like HELD_BY_OTHER_ROOT quietly
 * collapsed *deposit-held*, *application-held* and *reservation-held* into one
 * construction path that only ever built a deposit. That last one is the
 * originating PR #258 defect — three subsystems disagreeing about whether a car
 * is spoken for — reproduced by omission inside the design meant to retire it.
 *
 * ## The rules this file follows
 *
 *   1. **One business rule, one test.** No parameterisation across rules.
 *   2. **Setup runs before the subject call and outside every `expect`.** A
 *      setup failure fails the test with its own error; it can never be matched
 *      against the refusal the test expects.
 *   3. **Exactly ONE subject call** per test, so what is being measured is
 *      never ambiguous.
 *   4. **An unmistakable postcondition.** "The mutation returned something" is
 *      not a result. A retry must return the SAME quote; a reopen must show the
 *      application's status changed AND the vehicle reacquired; a completion
 *      must show the money applied exactly once with no duplicate receivable.
 *   5. **Evidence kinds are never collapsed.** Deposit-held, application-held
 *      and reservation-held are separate contracts, because in this codebase
 *      they are enforced by separate code paths that do not consult each other.
 *   6. **No mechanism claims to prove the whole design.** Traceability only
 *      answers "does every binding rule have at least one executable contract",
 *      and says nothing about consistency between them.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/** A surface this design requires that does not exist yet. */
type UnbuiltMutation = FunctionReference<"mutation", "public", Record<string, unknown>, unknown>;
type UnbuiltQuery = FunctionReference<"query", "public", Record<string, unknown>, unknown>;
const notYetBuilt = anyApi as unknown as Record<string, Record<string, UnbuiltMutation>>;
const notYetBuiltQuery = anyApi as unknown as Record<string, Record<string, UnbuiltQuery>>;

const PRICE = 28_000;

// ─────────────────────────────────────────────────────────────────────────────
// Setup helpers. These run OUTSIDE assertions, always.
// ─────────────────────────────────────────────────────────────────────────────

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Contract ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `c_${suffix}`, email: `c${suffix}@x.com`, name: "Closer" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `ca_${suffix}`, email: `ca${suffix}@x.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Contract",
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
      name: "Contract Finance",
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
    approverId,
    customerA,
    customerB,
    companyId,
    asUser: t.withIdentity({ subject: `c_${suffix}`, clerkId: `c_${suffix}` }),
    asApprover: t.withIdentity({ subject: `ca_${suffix}`, clerkId: `ca_${suffix}` }),
  };
}

let vinCounter = 0;
async function vehicle(seed: Seed): Promise<Id<"vehicles">> {
  const vin = `CONTRACT${String(vinCounter++).padStart(9, "0")}`;
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
      status: "AVAILABLE",
    })
  );
}

async function cashQuote(
  seed: Seed,
  customerId: Id<"customers">,
  vehicleId: Id<"vehicles">
): Promise<Id<"quotes">> {
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

/**
 * A FINANCED quote — required for anything that becomes a finance application.
 *
 * The previous suite built every world from cash quotes, including the finance
 * ones, so an application fixture would have failed on a mode guard rather than
 * on the rule it named.
 */
async function financedQuote(
  seed: Seed,
  customerId: Id<"customers">,
  vehicleId: Id<"vehicles">
): Promise<Id<"quotes">> {
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

// ── The three ways a vehicle becomes spoken for ──────────────────────────────
//
// Kept as three separate functions rather than one parameterised helper,
// because the whole point is that these are DIFFERENT paths through DIFFERENT
// code that historically did not consult one another.

/** Rival takes the car with a DEPOSIT. */
async function rivalHoldsByDeposit(seed: Seed, vehicleId: Id<"vehicles">) {
  const quoteId = await cashQuote(seed, seed.customerB, vehicleId);
  const depositId = await seed.asUser.mutation(api.deposits.create, {
    orgId: seed.orgId,
    quoteId,
    amount: 1_500,
  });
  return { quoteId, depositId };
}

/** Rival takes the car with a live FINANCE APPLICATION and no deposit at all. */
async function rivalHoldsByApplication(seed: Seed, vehicleId: Id<"vehicles">) {
  const quoteId = await financedQuote(seed, seed.customerB, vehicleId);
  const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
    orgId: seed.orgId,
    quoteId,
  });
  return { quoteId, applicationId };
}

/** Rival takes the car with a manual RESERVATION. */
async function rivalHoldsByReservation(seed: Seed, vehicleId: Id<"vehicles">) {
  const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
    orgId: seed.orgId,
    vehicleId,
    customerId: seed.customerB,
  });
  return { reservationId };
}

// ── Observation helpers, used for postconditions ─────────────────────────────

async function vehicleRow(seed: Seed, vehicleId: Id<"vehicles">): Promise<Doc<"vehicles">> {
  const row = await seed.t.run((ctx) => ctx.db.get(vehicleId));
  expect(row, "the vehicle must still exist").not.toBeNull();
  return row!;
}

async function liveDepositHolds(seed: Seed, vehicleId: Id<"vehicles">) {
  return await seed.t.run(async (ctx) => {
    const holds = await ctx.db
      .query("depositVehicleHolds")
      .filter((q) => q.eq(q.field("vehicleId"), vehicleId))
      .collect();
    return holds.filter((h) => h.active === true);
  });
}

async function applicationRow(
  seed: Seed,
  applicationId: Id<"financeApplications">
): Promise<Doc<"financeApplications">> {
  const row = await seed.t.run((ctx) => ctx.db.get(applicationId));
  expect(row, "the application must still exist").not.toBeNull();
  return row!;
}

async function countIn(seed: Seed, table: "sales" | "deposits" | "receivableDocuments") {
  return await seed.t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. THE THREE EVIDENCE KINDS ARE ENFORCED SEPARATELY
//
// ⚠️ This section exists because round 8 proved the previous design never
// tested it. `grep -c financeApplications` over `deposits.ts`, `vehicles.ts`
// and `utils/depositHelpers.ts` returns 0, 0, 0 on this revision — none of the
// three readers consults finance applications at all. A finance application
// never patches `vehicle.status`, so an application-held car with no deposit
// still reads AVAILABLE, and every downstream guard that keys off status sails
// straight past it.
//
// Collapsing these into one "held by another root" fixture built from a deposit
// hid that completely: the deposit path sets status = RESERVED, so those tests
// pass on a pre-existing guard that has nothing to do with this design.
// ─────────────────────────────────────────────────────────────────────────────

describe("A. a vehicle held by a DEPOSIT", () => {
  test("refuses a rival deposit, and the rival's hold is not created", async () => {
    const seed = await seedDealer("dep-dep");
    const v = await vehicle(seed);
    await rivalHoldsByDeposit(seed, v);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    ).rejects.toThrow(/committed|another deal|already held|no longer available/i);

    // Postcondition: exactly the rival's hold, nothing of ours.
    expect(await liveDepositHolds(seed, v)).toHaveLength(1);
  });
});

describe("B. a vehicle held by a live FINANCE APPLICATION", () => {
  /**
   * The application path holds NO deposit and never touches `vehicle.status`.
   * Every test below therefore also asserts the car is still `AVAILABLE` at the
   * moment of refusal — proving the refusal came from commitment authority and
   * not from the incidental SOLD/RESERVED guards that already exist.
   */

  test("refuses a rival DEPOSIT", async () => {
    const seed = await seedDealer("app-dep");
    const v = await vehicle(seed);
    await rivalHoldsByApplication(seed, v);
    const ours = await cashQuote(seed, seed.customerA, v);

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    ).rejects.toThrow(/committed|another deal|already held|no longer available|application/i);

    expect(await liveDepositHolds(seed, v)).toHaveLength(0);
  });

  test("refuses a manual RESERVATION", async () => {
    const seed = await seedDealer("app-res");
    const v = await vehicle(seed);
    await rivalHoldsByApplication(seed, v);

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");

    await expect(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      })
    ).rejects.toThrow(/committed|another deal|already held|no longer available|application/i);

    const reservations = await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleReservations").collect()).filter((r) => r.vehicleId === v)
    );
    expect(reservations).toHaveLength(0);
  });

  test("refuses a CASH SALE to a different customer", async () => {
    const seed = await seedDealer("app-sale");
    const v = await vehicle(seed);
    await rivalHoldsByApplication(seed, v);

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");
    const salesBefore = await countIn(seed, "sales");

    await expect(
      seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      })
    ).rejects.toThrow(/committed|another deal|already held|no longer available|application/i);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");
  });

  test("refuses SOFT-DELETE", async () => {
    const seed = await seedDealer("app-del");
    const v = await vehicle(seed);
    await rivalHoldsByApplication(seed, v);

    await expect(
      seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId: v })
    ).rejects.toThrow(/committed|another deal|already held|in use|cannot delete|application/i);

    // Postcondition: the row is not soft-deleted.
    const row = await vehicleRow(seed, v);
    expect((row as { deletedAt?: number }).deletedAt).toBeUndefined();
  });

  test("refuses ARCHIVE, which is a second door out of inventory", async () => {
    const seed = await seedDealer("app-arch");
    const v = await vehicle(seed);
    await rivalHoldsByApplication(seed, v);

    await expect(
      seed.asUser.mutation(api.vehicles.update, {
        orgId: seed.orgId,
        vehicleId: v,
        status: "ARCHIVED" as const,
      })
    ).rejects.toThrow(
      /committed|another deal|already held|in use|cannot archive|application|release the (reservation|deposit)/i
    );

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");
  });

  test("refuses being taken as another deal's TRADE-IN", async () => {
    const seed = await seedDealer("app-trade");
    const tradeIn = await vehicle(seed);
    const bought = await vehicle(seed);
    await rivalHoldsByApplication(seed, tradeIn);

    const salesBefore = await countIn(seed, "sales");

    await expect(
      seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId: bought,
        customerId: seed.customerA,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        tradeInVehicleId: tradeIn,
        tradeInValue: 5_000,
      })
    ).rejects.toThrow(/committed|another deal|already held|no longer available|application/i);

    expect(await countIn(seed, "sales")).toBe(salesBefore);
  });
});

describe("C. a vehicle held by a manual RESERVATION", () => {
  test("refuses a rival DEPOSIT", async () => {
    const seed = await seedDealer("res-dep");
    const v = await vehicle(seed);
    await rivalHoldsByReservation(seed, v);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    ).rejects.toThrow(/committed|another deal|already held|no longer available|reserv/i);

    expect(await liveDepositHolds(seed, v)).toHaveLength(0);
  });

  test("refuses a rival FINANCE APPLICATION", async () => {
    const seed = await seedDealer("res-app");
    const v = await vehicle(seed);
    await rivalHoldsByReservation(seed, v);
    const ours = await financedQuote(seed, seed.customerA, v);

    await expect(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: ours })
    ).rejects.toThrow(/committed|another deal|already held|no longer available|reserv/i);

    const apps = await seed.t.run(async (ctx) =>
      (await ctx.db.query("financeApplications").collect()).filter((a) => a.vehicleId === v)
    );
    expect(apps).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. ACCEPTANCE MEANS A PROVEN OUTCOME, NOT A DEFINED RETURN VALUE
//
// ⚠️ Every acceptance test in the previous suite asserted only
// `.resolves.toBeDefined()`. An implementation could satisfy all of them while
// `closeRoot` closed nothing, a reopen changed no status, a reallocation moved
// no money, and a retry minted a second root — because every one of those
// returns *something*.
//
// Each test below names the exact state that must be true afterwards.
// ─────────────────────────────────────────────────────────────────────────────

describe("D. accepted operations must prove what they did", () => {
  test("an exact retry returns the SAME quote — not merely a quote", async () => {
    const seed = await seedDealer("retry-same");
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
      idempotencyKey: "contract-retry-1",
    };
    // Setup: the first call. Outside every assertion, so if the pending
    // `idempotencyKey` field is refused, THIS line fails with that error rather
    // than the refusal being matched against the subject's expectation.
    const first = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);

    const second = await seed.asUser.mutation(notYetBuilt.quotes.saveQuote, args);

    // The postcondition, and the only one that means anything: the SAME quote,
    // and no second row.
    expect(second).toBe(first);
    const quotes = await seed.t.run(async (ctx) =>
      (await ctx.db.query("quotes").collect()).filter((q) => q.vehicleId === v)
    );
    expect(quotes).toHaveLength(1);
  });

  test("reopening a rejected application changes its status AND reacquires the car", async () => {
    const seed = await seedDealer("reopen-proves");
    const v = await vehicle(seed);
    const quoteId = await financedQuote(seed, seed.customerA, v);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });
    expect((await applicationRow(seed, applicationId)).status).toBe("REJECTED");

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "PENDING_DOCS" as const,
    });

    // Two postconditions, because either alone can be satisfied by a no-op:
    // the status really moved, and the reopened application really holds the
    // car again rather than merely existing.
    expect((await applicationRow(seed, applicationId)).status).toBe("PENDING_DOCS");
    const owner = await seed.asUser.query(notYetBuiltQuery.commitments.resolveVehicleRoot, {
      orgId: seed.orgId,
      vehicleId: v,
    });
    expect((owner as { kind: string }).kind).toBe("OWNED");
    expect(String((owner as { rootId: unknown }).rootId)).toBeTruthy();
  });

  test("completion applies the deposit EXACTLY ONCE and creates no duplicate sale", async () => {
    const seed = await seedDealer("complete-once");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    const depositId = await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 5_000,
    });
    const salesBefore = await countIn(seed, "sales");
    const receivablesBefore = await countIn(seed, "receivableDocuments");

    await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });

    // Exactly one sale, exactly one receivable, and the deposit applied once —
    // "the call returned an id" would have been satisfied by a double-apply.
    expect(await countIn(seed, "sales")).toBe(salesBefore + 1);
    expect(await countIn(seed, "receivableDocuments")).toBe(receivablesBefore + 1);

    const applications = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).filter(
        (row) => row.depositId === depositId
      )
    );
    expect(applications, "the deposit must be applied exactly once").toHaveLength(1);
  });

  test("re-allocating a released share MOVES that money to the named car", async () => {
    const seed = await seedDealer("realloc-moves");
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
    const releasedHold = await seed.t.run(async (ctx) => {
      const holds = await ctx.db
        .query("depositVehicleHolds")
        .filter((q) => q.eq(q.field("vehicleId"), dropped))
        .collect();
      return holds.find((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION");
    });
    expect(releasedHold, "setup must produce a released share").toBeDefined();

    await seed.asUser.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: seed.orgId,
      holdId: releasedHold!._id,
      treatment: "RETURN_TO_UNALLOCATED" as const,
      reason: "put it back on the deal",
    });

    // The money must actually be somewhere: a live hold on `dropped` again,
    // and the released row no longer awaiting a decision. Returning an id
    // while leaving the share stranded would have passed a `toBeDefined` test.
    const after = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter((h) => h.vehicleId === dropped)
    );
    expect(after.some((h) => h.active === true)).toBe(true);
    expect(
      after.filter((h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"),
      "the share must no longer be awaiting a decision"
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. LINEAGE — the rulings that make a deal continue rather than fragment
// ─────────────────────────────────────────────────────────────────────────────

describe("E. deal lineage", () => {
  test("a further instalment on the SAME quote is accepted and joins the same deal", async () => {
    const seed = await seedDealer("same-root");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 1_000 });

    await seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 2_000 });

    // Both deposits live, on one car, under one quote — instalments are the
    // behaviour that made naive "one hold per vehicle" wrong in the first place.
    const deposits = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).filter((d) => d.quoteId === quoteId)
    );
    expect(deposits).toHaveLength(2);
    expect(deposits.every((d) => d.holdActive === true)).toBe(true);
  });

  test("new evidence citing a SUPERSEDED revision is refused; the current head accepts it", async () => {
    const seed = await seedDealer("stale-head");
    const v = await vehicle(seed);
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

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r1, amount: 500 })
    ).rejects.toThrow(/current revision|superseded|stale|current head/i);

    // The rule is a REDIRECT, not a block: the head must still take the money,
    // or a renegotiation would strand the customer entirely.
    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: r2, amount: 500 })
    ).resolves.toBeDefined();
  });

  test("RELEASED money frees the CAR but leaves the deal financially open", async () => {
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
    // behaviour cancellation already produces, and an authority that re-locked
    // it would break the existing flow.
    const rival = await cashQuote(seed, seed.customerB, freed);
    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: rival, amount: 1_500 })
    ).resolves.toBeDefined();

    // Money axis: the customer's 2,000 has NOT gone anywhere. Both axes are
    // asserted here together because conflating them fails in both directions.
    const awaiting = await seed.t.run(async (ctx) =>
      (await ctx.db.query("depositVehicleHolds").collect()).filter(
        (h) => h.allocationStatus === "RELEASED_AWAITING_DECISION"
      )
    );
    expect(awaiting, "the released share must still be awaiting a decision").toHaveLength(1);
    expect(awaiting[0].allocatedAmountMinor).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. STRUCTURAL CHECKS
//
// Properties of the source. c14852 demotes traceability: the map below answers
// ONLY "does every binding rule have at least one executable contract". It does
// NOT claim the contracts agree with one another — that claim is exactly the
// false assurance the previous architecture kept producing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `testSupport:deploymentIdentity` contract (c14843), rebuilt.
 *
 * The previous checker DENYLISTED the literal token `mutation`. Two reviewers
 * broke it independently: `const writer = mutation; export const seed = writer(...)`
 * and `export const seed = socialBulkMutation(...)` — and `socialBulkMutation`
 * is not hypothetical, it is defined at `convex/functions.ts:77` and used in
 * `customers.ts` and `socialInbox.ts`. An author following this repository's own
 * convention would have defeated the gate silently.
 *
 * So it now ALLOWLISTS: the only builder an export in this module may be
 * constructed from is `query`. Anything else is suspect by default. Comments
 * are stripped first, because the old checker also accepted `// args: {}`.
 */
export function checkDeploymentIdentityContract(rawSource: string): string[] {
  const violations: string[] = [];
  // Comments are not code. The previous checker matched inside them.
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const exports = [...source.matchAll(/export\s+const\s+(\w+)\s*=\s*([A-Za-z_$][\w$]*)\s*\(/g)];
  const reExports = [...source.matchAll(/export\s*\{([^}]*)\}/g)];

  if (reExports.length) {
    violations.push(
      `RE_EXPORT_FORM: ${reExports.length} \`export { ... }\` statement(s) — the contract is checked on direct \`export const NAME = query(...)\` declarations only, so re-export hides the builder`
    );
  }

  const identity = exports.find(([, name]) => name === "deploymentIdentity");
  if (!identity) {
    violations.push("NOT_A_QUERY: deploymentIdentity is not exported as a direct declaration");
    return violations;
  }
  if (identity[2] !== "query") {
    violations.push(`NOT_A_QUERY: built from ${identity[2]}(), and only query() is permitted`);
  }

  // ALLOWLIST, not denylist: any other export must also be a query.
  for (const [, name, builder] of exports) {
    if (name !== "deploymentIdentity" && builder !== "query") {
      violations.push(
        `NON_QUERY_EXPORT: ${name} is built from ${builder}() — only query() is allowed in this module, whatever it is named`
      );
    }
  }

  const blockStart = source.indexOf("(", identity.index! + identity[0].length - 1);
  const block = balancedFrom(source, blockStart, "(", ")");

  const args = block.match(/args\s*:\s*\{([^}]*)\}/);
  if (!args || args[1].trim() !== "") {
    violations.push(
      args ? `ARGS_NOT_EMPTY: accepts ${args[1].trim()}` : "ARGS_NOT_EMPTY: no args validator"
    );
  }
  if (/\.\.\./.test(block)) {
    violations.push(
      "SPREAD_IN_DEFINITION: a spread hides the real args/returns from this check"
    );
  }

  const returnsIdx = block.search(/returns\s*:\s*v\.object\s*\(/);
  if (returnsIdx === -1) {
    violations.push("NO_RETURN_VALIDATOR: the returned surface is unbounded");
  } else {
    const objOpen = block.indexOf("{", block.indexOf("v.object", returnsIdx));
    const fields = [
      ...new Set(
        [...balancedFrom(block, objOpen, "{", "}").matchAll(/(\w+)\s*:/g)].map((m) => m[1])
      ),
    ].sort();
    if (JSON.stringify(fields) !== JSON.stringify(["cloudUrl", "disposable"])) {
      violations.push(
        `RETURN_SURFACE_NOT_EXACT: returns { ${fields.join(", ")} }; only { cloudUrl, disposable } is permitted`
      );
    }
  }

  return violations;
}

function balancedFrom(source: string, openIdx: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return "";
}

describe("F. structural checks", () => {
  test("the identity-contract checker rejects every bypass two reviewers found", () => {
    const compliant = `
      export const deploymentIdentity = query({
        args: {},
        returns: v.object({ cloudUrl: v.string(), disposable: v.boolean() }),
        handler: async () => ({ cloudUrl: "", disposable: false }),
      });
    `;
    expect(checkDeploymentIdentityContract(compliant)).toEqual([]);

    // The two bypasses that defeated the previous checker.
    const viaRepoIdiom = `${compliant}
      export const seedAnything = socialBulkMutation({ args: {}, handler: async () => null });`;
    expect(checkDeploymentIdentityContract(viaRepoIdiom).join(" ")).toMatch(/NON_QUERY_EXPORT/);

    const viaReExport = `${compliant}
      const seedAnything = mutation({ args: {}, handler: async () => null });
      export { seedAnything };`;
    expect(checkDeploymentIdentityContract(viaReExport).join(" ")).toMatch(/RE_EXPORT_FORM/);

    const viaComment = `
      export const deploymentIdentity = query({
        // args: {}
        // returns: v.object({ cloudUrl: v.string(), disposable: v.boolean() })
        ...leaking,
      });`;
    const commentViolations = checkDeploymentIdentityContract(viaComment).join(" ");
    expect(commentViolations).toMatch(/ARGS_NOT_EMPTY/);
    expect(commentViolations).toMatch(/SPREAD_IN_DEFINITION/);

    // And the clauses the contract exists for.
    expect(
      checkDeploymentIdentityContract(compliant.replace("args: {},", "args: { orgId: v.string() },")).join(" ")
    ).toMatch(/ARGS_NOT_EMPTY/);
    expect(
      checkDeploymentIdentityContract(
        compliant.replace("disposable: v.boolean() }", "disposable: v.boolean(), deployKey: v.string() }")
      ).join(" ")
    ).toMatch(/RETURN_SURFACE_NOT_EXACT/);
  });

  test("testSupport, once it exists, satisfies that contract", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const path = "convex/testSupport.ts";
    // Loudly red until the module is written — treating absence as
    // not-applicable is how a gate quietly stops being a gate.
    expect(existsSync(path), "convex/testSupport.ts does not exist yet").toBe(true);
    expect(checkDeploymentIdentityContract(readFileSync(path, "utf8"))).toEqual([]);
  });

  test("the contention harness declares no public testSupport seed mutation", async () => {
    const { readFileSync } = await import("node:fs");
    const harness = readFileSync("scripts/vehicleCommitmentContention.mjs", "utf8");
    const seedMutations = [
      ...harness.matchAll(/client\.mutation\(\s*["'`](testSupport:[A-Za-z0-9_]+)["'`]/g),
    ].map((m) => m[1]);
    expect(seedMutations).toEqual([]);
  });

  test("every saveQuote caller is inventoried, web and mobile alike", async () => {
    // c14843 makes this the cutover gate: no fallback removal until every
    // caller carries explicit NEW-vs-REVISE intent and a stable operation id.
    const CALLERS = [
      "apps/mobile/src/features/workspace/modules/quotes.tsx",
      "apps/mobile/src/features/workspace/salesWizard/SalesWizardScreen.tsx",
      "components/sales/QuoteDialog.tsx",
      "components/sales/wizard/steps/Step3Review.tsx",
    ];
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join, relative, sep } = await import("node:path");

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "_generated") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry) || /\.test\./.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        if (
          /api\s*\.\s*quotes\s*\.\s*saveQuote/.test(text) ||
          /api\s*(?:\.\s*quotes|\[\s*["'`]quotes["'`]\s*\])\s*\[\s*["'`]saveQuote["'`]\s*\]/.test(text)
        ) {
          found.push(relative(process.cwd(), full).split(sep).join("/"));
        }
      }
    };
    for (const root of ["components", "app", "lib", "apps", "convex"]) {
      try {
        walk(root);
      } catch {
        // absent in this checkout
      }
    }
    expect([...new Set(found)].sort()).toEqual([...CALLERS].sort());
  });

  test("org-purge deletes the commitment claim AFTER everything it protects", async () => {
    const { ORGANIZATION_DELETION_STEPS } = await import("./adminOrgs");
    const stepOf = (table: string) =>
      ORGANIZATION_DELETION_STEPS.findIndex((s) => String(s).includes(table));
    const claim = stepOf("vehicleCommitmentClaims");

    if (!Object.keys(schema.tables).includes("vehicleCommitmentClaims")) {
      expect(claim, "no claim table in the schema yet, so nothing to sequence").toBe(-1);
      return;
    }
    expect(
      claim,
      "the claim exists but is absent from ORGANIZATION_DELETION_STEPS — a purge would orphan it"
    ).toBeGreaterThan(-1);
    for (const protectedTable of ["vehiclesWithStorage", "deposits", "financeApplications"]) {
      expect(claim).toBeGreaterThan(stepOf(protectedTable));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. TRACEABILITY — DEMOTED ON PURPOSE (c14852)
//
// ⚠️ READ WHAT THIS DOES AND DOES NOT CLAIM.
//
// It answers exactly one question: does every binding rule have at least one
// executable contract in this file? That is a COVERAGE question.
//
// It does NOT claim the contracts are consistent with one another, that they
// are sufficient, or that a passing suite means the design is correct. The
// previous architecture made precisely that claim — a "semantic preflight" that
// was supposed to make contradictions unrepresentable — and it was the single
// largest source of false assurance across three review rounds. It covered only
// half the specification while I described the whole class as closed.
//
// A coverage map that knows it is only a coverage map is worth more than a
// consistency proof that is not one.
// ─────────────────────────────────────────────────────────────────────────────

const BINDING_RULES: { ruling: string; rule: string; evidence: string }[] = [
  {
    ruling: "c14554",
    rule: "A vehicle held by a deposit refuses a rival deposit.",
    evidence: "refuses a rival deposit, and the rival's hold is not created",
  },
  {
    ruling: "c14554/c14852",
    rule: "A vehicle held by a live finance application refuses a rival deposit.",
    evidence: "refuses a rival DEPOSIT",
  },
  {
    ruling: "c14659",
    rule: "A vehicle held by a finance application refuses a manual reservation.",
    evidence: "refuses a manual RESERVATION",
  },
  {
    ruling: "c14554",
    rule: "A vehicle held by a finance application refuses a cash sale.",
    evidence: "refuses a CASH SALE to a different customer",
  },
  {
    ruling: "c14551",
    rule: "A committed vehicle cannot be soft-deleted out of inventory.",
    evidence: "refuses SOFT-DELETE",
  },
  {
    ruling: "c14551",
    rule: "Archive is a second door out of inventory and is equally refused.",
    evidence: "refuses ARCHIVE, which is a second door out of inventory",
  },
  {
    ruling: "c14551",
    rule: "A committed vehicle cannot be taken as another deal's trade-in.",
    evidence: "refuses being taken as another deal's TRADE-IN",
  },
  {
    ruling: "c14659",
    rule: "A reserved vehicle refuses a rival finance application.",
    evidence: "refuses a rival FINANCE APPLICATION",
  },
  {
    ruling: "c14840",
    rule: "An exact retry returns the same quote rather than minting a second root.",
    evidence: "an exact retry returns the SAME quote",
  },
  {
    ruling: "c14554",
    rule: "Reopening a rejected application re-acquires the vehicle.",
    evidence: "reopening a rejected application changes its status AND reacquires the car",
  },
  {
    ruling: "c14833",
    rule: "Completion applies the deposit exactly once, with no duplicate sale.",
    evidence: "completion applies the deposit EXACTLY ONCE",
  },
  {
    ruling: "c14833",
    rule: "Resolving a released share actually moves that money.",
    evidence: "re-allocating a released share MOVES that money to the named car",
  },
  {
    ruling: "c14554",
    rule: "Instalments on one quote are more evidence for one deal, not a conflict.",
    evidence: "a further instalment on the SAME quote is accepted",
  },
  {
    ruling: "c14796",
    rule: "A superseded revision cannot carry new evidence; the head can.",
    evidence: "new evidence citing a SUPERSEDED revision is refused",
  },
  {
    ruling: "c14833",
    rule: "Released money frees the car but leaves the deal financially open.",
    evidence: "RELEASED money frees the CAR but leaves the deal financially open",
  },
  {
    ruling: "c14843",
    rule: "The testSupport identity surface stays a narrow read-only query.",
    evidence: "testSupport, once it exists, satisfies that contract",
  },
  {
    ruling: "c14840",
    rule: "No public write-capable testSupport seed mutation exists.",
    evidence: "the contention harness declares no public testSupport seed mutation",
  },
  {
    ruling: "c14843",
    rule: "Every saveQuote caller is inventoried before cutover, mobile included.",
    evidence: "every saveQuote caller is inventoried, web and mobile alike",
  },
  {
    ruling: "c14659",
    rule: "The commitment claim outlives everything an aborted purge could strand.",
    evidence: "org-purge deletes the commitment claim AFTER everything it protects",
  },
];

describe("G. traceability — coverage only, no consistency claim", () => {
  test("every binding rule names a contract that exists in this file", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("convex/vehicleCommitmentContracts.test.ts", "utf8");
    // The closing quote must be the SAME character as the opening one. A
    // simple `["'`](.+?)["'`]` truncates at the first apostrophe inside a
    // title — "the rival's hold" — and then reports a false coverage gap for a
    // test that plainly exists. Caught by this check firing on itself.
    const titles = [...source.matchAll(/^\s*test\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm)].map(
      (m) => m[2]
    );

    const missing = BINDING_RULES.filter(
      (entry) => !titles.some((title) => title.includes(entry.evidence))
    ).map((entry) => `${entry.ruling}: ${entry.rule} → no test titled "${entry.evidence}"`);

    expect(missing).toEqual([]);
  });

  test("every rule cites the ruling it comes from, so the map stays auditable", () => {
    const unattributed = BINDING_RULES.filter((entry) => !/^c\d{5}/.test(entry.ruling));
    expect(unattributed.map((entry) => entry.rule)).toEqual([]);
  });
});
