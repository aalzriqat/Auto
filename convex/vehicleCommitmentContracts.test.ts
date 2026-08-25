import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { anyApi, FunctionReference } from "convex/server";
import { getActiveDepositHolds } from "./utils/depositHelpers";

/**
 * SCRUM-195 — DIRECT BEHAVIOURAL CONTRACTS ONLY (owner ruling c14860).
 *
 * ## What c14860 removed, and why
 *
 * Rounds 6–9 produced the same shape of failure four times, and not once was it
 * in the accounting model — every domain ruling survived every attack. It was
 * in the PROOF MACHINERY built around the model. Three classes, all in that
 * meta-layer:
 *
 *   - **tests unsatisfiable by a correct implementation** (six instances). The
 *     last one is the clearest: an org-purge test whose `stepOf` predicate did
 *     `String(step).includes(table)` over entries that are object literals, so
 *     it compared against `"[object Object]"` and could never match anything.
 *     That same test had been "fixed" the round before to be honestly red, and
 *     was made red in a way no implementation could turn green.
 *   - **source-checkers being bypassed** — five bypasses of ONE checker across
 *     three rewrites: aliasing, `socialBulkMutation`, unrecognised syntax,
 *     `import { mutation as query }`, and a second wide-open export.
 *   - **migrations losing working coverage or context** (three instances).
 *
 * So the owner deleted the instruments rather than repairing them again: no
 * identity regex/parser test, no purge-order parser test, no `saveQuote` caller
 * regex gate, no traceability/source-title map, no contention harness.
 *
 * ## ⚠️ Deleting the proof does NOT delete the obligation
 *
 * Deployment identity, organization-purge safety, the web + mobile caller
 * cutover and real disposable-deployment contention all remain BINDING
 * requirements of SCRUM-195. What changed is how they are verified: against
 * real code and real runtime when those surfaces exist, by people, rather than
 * by regex tests that five independent attempts have now defeated. c14860 also
 * forbids replacing them with a new AST or generalised proof framework.
 *
 * ## The rules this file follows
 *
 *   1. **One business rule, one test.** No parameterisation across rules.
 *   2. **Setup runs before the subject call and outside every `expect`.** A
 *      setup failure fails the test with its own error; it can never be matched
 *      against the refusal the test expects.
 *   3. **Exactly ONE subject call** per test — the operation whose accept or
 *      refuse is the rule. Everything before it is setup and everything after
 *      it is observation, so what is being measured is never ambiguous. Where a
 *      rule is inherently two-sided (E.3 refuses the stale revision AND
 *      requires the head to accept), both halves are stated in the test's own
 *      comment rather than left for a reader to infer.
 *   4. **An unmistakable postcondition.** "The mutation returned something" is
 *      not a result.
 *   5. **Evidence kinds are never collapsed.** Deposit-held, application-held
 *      and reservation-held are separate contracts, because in this codebase
 *      they are enforced by separate code paths that do not consult each other.
 *   6. **Every refusal is paired with a positive control** wherever a blunt fix
 *      could satisfy the refusal by breaking a legitimate flow.
 *
 * ## 🛑 SUPERSESSION THE IMPLEMENTATION MUST CARRY OUT — `deposits.test.ts`
 *
 * `convex/deposits.test.ts` contains a GREEN, shipped test titled
 *
 *     "a second deposit from a different quote on the same vehicle does not
 *      error (soft warning, not a hard block)"
 *
 * which asserts `.resolves.toBeDefined()` for exactly the scenario contract A.1
 * below asserts must be REFUSED. Both run under the same required check, so
 * they are mechanically impossible to satisfy at the same time.
 *
 * Owner ruling c14860 SUPERSEDES that rule: one vehicle row is one physical
 * unit, so once a hard commitment exists a different deal/root cannot acquire
 * it. Same-root additional instalments remain legal — contract E.1 is what
 * stops the supersession being implemented as a blanket "one deposit per car".
 *
 * **This is a policy decision, already taken — not a defect to be discovered
 * later.** The SCRUM-195 implementation must update that test in the same
 * change that makes A.1 pass. It is recorded here, in the artefact, because a
 * previous migration dropped the supersession note and the contradiction had to
 * be re-found by a reviewer.
 *
 * ## ⚠️ THIS FILE CANNOT MERGE WHILE IT IS RED, AND THAT IS DELIBERATE
 *
 * `unit-and-integration` is a REQUIRED status check on `main` with
 * `enforce_admins: true` (verified against live GitHub branch protection, not
 * inferred from the workflow file). It runs an unscoped `vitest run`, and
 * `vitest.config.ts` does not exclude `convex/**`, so these tests execute there
 * and a red one blocks the merge for everyone, admins included.
 *
 * The red ones are LIVE DEFECTS in shipped code plus a small number of surfaces
 * the implementation must build. Skipping them would delete the only evidence
 * those defects exist. The gate is therefore working as intended: this content
 * becomes mergeable when the defects are fixed, not before.
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
 * An earlier suite built every world from cash quotes, including the finance
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

/** Somebody takes the car with a DEPOSIT. */
async function heldByDeposit(seed: Seed, vehicleId: Id<"vehicles">, customerId: Id<"customers">) {
  const quoteId = await cashQuote(seed, customerId, vehicleId);
  const depositId = await seed.asUser.mutation(api.deposits.create, {
    orgId: seed.orgId,
    quoteId,
    amount: 1_500,
  });
  return { quoteId, depositId };
}

/** Somebody takes the car with a live FINANCE APPLICATION and no deposit at all. */
async function heldByApplication(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) {
  const quoteId = await financedQuote(seed, customerId, vehicleId);
  const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
    orgId: seed.orgId,
    quoteId,
  });
  return { quoteId, applicationId };
}

/** Somebody takes the car with a manual RESERVATION. */
async function heldByReservation(
  seed: Seed,
  vehicleId: Id<"vehicles">,
  customerId: Id<"customers">
) {
  const reservationId = await seed.asUser.mutation(api.vehicles.createReservation, {
    orgId: seed.orgId,
    vehicleId,
    customerId,
  });
  return { reservationId };
}

// ── Observation helpers, used for postconditions ─────────────────────────────

async function vehicleRow(seed: Seed, vehicleId: Id<"vehicles">): Promise<Doc<"vehicles">> {
  const row = await seed.t.run((ctx) => ctx.db.get(vehicleId));
  expect(row, "the vehicle must still exist").not.toBeNull();
  return row!;
}

/**
 * Which deposits actively hold this car — resolved through the PRODUCT's own
 * `getActiveDepositHolds`, not a hand-written query.
 *
 * ⚠️ The previous version of this helper read `depositVehicleHolds` alone, and
 * that was wrong in both directions at once. `deposits.ts:118` says so in the
 * source: *"Only multi-vehicle deposits need a join row per vehicle — a
 * single-vehicle deposit is already fully tracked by the deposit's own
 * vehicleId"*, guarded by `if (depositVehicleItems.length > 1)`. So:
 *
 *   - the deposit-held contract expected ONE join row where a single-vehicle
 *     deposit creates NONE — it would have stayed red against a perfectly
 *     correct implementation, forever;
 *   - the `toHaveLength(0)` residue checks in the application- and
 *     reservation-held contracts were VACUOUS, because a leftover direct
 *     deposit row — exactly the residue they exist to catch — never appears in
 *     that table at all.
 *
 * Calling the real resolver fixes both: it unions the direct
 * `deposits.by_vehicle_hold` index with the `depositVehicleHolds` join rows,
 * and it is the same function `createReservation` and `syncVehicleHoldStatus`
 * already use to decide whether a car is spoken for.
 */
async function depositsHolding(seed: Seed, vehicleId: Id<"vehicles">): Promise<Doc<"deposits">[]> {
  return await seed.t.run(async (ctx) => await getActiveDepositHolds(ctx, vehicleId));
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

/** A completed cash sale, in the shape `sales.create` actually takes. */
function completedSaleArgs(
  seed: Seed,
  opts: {
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    quoteId?: Id<"quotes">;
    tradeInVehicleId?: Id<"vehicles">;
    tradeInValue?: number;
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
      ? { tradeInVehicleId: opts.tradeInVehicleId, tradeInValue: opts.tradeInValue }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. A VEHICLE HELD BY A DEPOSIT
//
// A deposit promotes the car to RESERVED (`holdVehicleForDeposit`), so the
// naive reading is that everything downstream is already protected. It is not:
// `prepareSaleCompletion` refuses only SOLD and ARCHIVED.
//
// The refusal here is therefore paired with a POSITIVE CONTROL proving the deal
// that owns the hold can still complete. That pairing is deliberate: SCRUM-196
// explicitly forbids fixing the rival-sale hole with a blanket RESERVED
// rejection, because that would refuse the legitimate customer too.
// ─────────────────────────────────────────────────────────────────────────────

describe("A. a vehicle held by a DEPOSIT", () => {
  test("refuses a rival deposit from a different deal", async () => {
    // ⚠️ SUPERSEDES the green `deposits.test.ts` soft-warning test. See the
    // supersession note in this file's header — that test must be updated in
    // the same change that makes this one pass.
    const seed = await seedDealer("dep-dep");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    ).rejects.toThrow(/committed|another deal|another customer|already held|no longer available/i);

    // Exactly the holder's deposit, nothing of ours. Resolved through the
    // product's own hold resolver, so a leftover direct deposit row is visible.
    const holds = await depositsHolding(seed, v);
    expect(holds, "only the original holder's deposit may hold this car").toHaveLength(1);
    expect(holds[0].customerId).toBe(seed.customerB);
  });

  test("refuses a rival CASH SALE — the originating incident (SCRUM-196)", async () => {
    // ⚠️ LIVE PRODUCTION DEFECT, reproduced by execution in round 9 and tracked
    // as SCRUM-196. `prepareSaleCompletion` (utils/saleCompletion.ts:176) tests
    // only `status === "SOLD"` and `status === "ARCHIVED"`. A deposit-held car
    // is RESERVED, which it never inspects, so a rival's completed cash sale
    // consumes the car and flips it to SOLD out from under the depositor.
    const seed = await seedDealer("dep-sale");
    const v = await vehicle(seed);
    await heldByDeposit(seed, v, seed.customerB);
    const salesBefore = await countIn(seed, "sales");

    await expect(
      seed.asUser.mutation(
        api.sales.create,
        completedSaleArgs(seed, { vehicleId: v, customerId: seed.customerA })
      )
    ).rejects.toThrow(/committed|another deal|another customer|already held|no longer available/i);

    // No sale, and the car is still held rather than sold.
    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).toBe("RESERVED");
    expect(await depositsHolding(seed, v)).toHaveLength(1);
  });

  test("POSITIVE CONTROL: the depositor's OWN sale still completes", async () => {
    // The guard that makes the test above pass must not make this one fail.
    // A blanket `status === "RESERVED"` rejection in `prepareSaleCompletion`
    // would satisfy that refusal while breaking every legitimate deposit-then-
    // complete flow in the product — which is precisely why SCRUM-196 rules
    // that fix out. GREEN today, and it must stay green.
    const seed = await seedDealer("dep-own");
    const v = await vehicle(seed);
    const { quoteId } = await heldByDeposit(seed, v, seed.customerA);
    const salesBefore = await countIn(seed, "sales");

    const saleId = await seed.asUser.mutation(
      api.sales.create,
      completedSaleArgs(seed, { vehicleId: v, customerId: seed.customerA, quoteId })
    );

    // Proven by outcome, not by "it returned an id": one new sale, belonging to
    // the holder, and the car actually left inventory.
    expect(await countIn(seed, "sales")).toBe(salesBefore + 1);
    const sale = await seed.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));
    expect(sale?.customerId, "the sale belongs to the deal that held the car").toBe(seed.customerA);
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. A VEHICLE HELD BY A LIVE FINANCE APPLICATION
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
// passed on a pre-existing guard that has nothing to do with this design.
// ─────────────────────────────────────────────────────────────────────────────

describe("B. a vehicle held by a live FINANCE APPLICATION", () => {
  /**
   * Every test below also asserts the car is still `AVAILABLE` at the moment of
   * refusal — proving the refusal came from commitment authority and not from
   * the incidental SOLD/RESERVED guards that already exist.
   */

  test("refuses a rival DEPOSIT", async () => {
    const seed = await seedDealer("app-dep");
    const v = await vehicle(seed);
    await heldByApplication(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|application/i
    );

    expect(await depositsHolding(seed, v)).toHaveLength(0);
  });

  test("refuses a manual RESERVATION", async () => {
    const seed = await seedDealer("app-res");
    const v = await vehicle(seed);
    await heldByApplication(seed, v, seed.customerB);

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");

    await expect(
      seed.asUser.mutation(api.vehicles.createReservation, {
        orgId: seed.orgId,
        vehicleId: v,
        customerId: seed.customerA,
      })
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|application/i
    );

    const reservations = await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleReservations").collect()).filter((r) => r.vehicleId === v)
    );
    expect(reservations).toHaveLength(0);
  });

  test("refuses a CASH SALE to a different customer", async () => {
    const seed = await seedDealer("app-sale");
    const v = await vehicle(seed);
    await heldByApplication(seed, v, seed.customerB);

    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");
    const salesBefore = await countIn(seed, "sales");

    await expect(
      seed.asUser.mutation(
        api.sales.create,
        completedSaleArgs(seed, { vehicleId: v, customerId: seed.customerA })
      )
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|application/i
    );

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).toBe("AVAILABLE");
  });

  test("refuses SOFT-DELETE", async () => {
    const seed = await seedDealer("app-del");
    const v = await vehicle(seed);
    await heldByApplication(seed, v, seed.customerB);

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
    await heldByApplication(seed, v, seed.customerB);

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
    await heldByApplication(seed, tradeIn, seed.customerB);

    const salesBefore = await countIn(seed, "sales");

    await expect(
      seed.asUser.mutation(
        api.sales.create,
        completedSaleArgs(seed, {
          vehicleId: bought,
          customerId: seed.customerA,
          tradeInVehicleId: tradeIn,
          tradeInValue: 5_000,
        })
      )
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|application/i
    );

    expect(await countIn(seed, "sales")).toBe(salesBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. A VEHICLE HELD BY A MANUAL RESERVATION
//
// A reservation also promotes the car to RESERVED, via `syncVehicleHoldStatus`
// → `hasActiveReservationHold`. As with deposits, that status is invisible to
// `prepareSaleCompletion`, so the same rival-sale hole exists on this axis too.
// ─────────────────────────────────────────────────────────────────────────────

describe("C. a vehicle held by a manual RESERVATION", () => {
  test("refuses a rival DEPOSIT", async () => {
    const seed = await seedDealer("res-dep");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const ours = await cashQuote(seed, seed.customerA, v);

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId: ours, amount: 1_000 })
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|reserv/i
    );

    expect(await depositsHolding(seed, v)).toHaveLength(0);
  });

  test("refuses a rival FINANCE APPLICATION", async () => {
    const seed = await seedDealer("res-app");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const ours = await financedQuote(seed, seed.customerA, v);

    await expect(
      seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: ours })
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|reserv/i
    );

    const apps = await seed.t.run(async (ctx) =>
      (await ctx.db.query("financeApplications").collect()).filter((a) => a.vehicleId === v)
    );
    expect(apps).toHaveLength(0);
  });

  test("refuses a rival CASH SALE — the originating incident (SCRUM-196)", async () => {
    // ⚠️ LIVE PRODUCTION DEFECT, reproduced by execution in round 9. The same
    // hole as A.2 reached down a different axis: the reservation makes the car
    // RESERVED, and `prepareSaleCompletion` never reads RESERVED.
    const seed = await seedDealer("res-sale");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const salesBefore = await countIn(seed, "sales");

    await expect(
      seed.asUser.mutation(
        api.sales.create,
        completedSaleArgs(seed, { vehicleId: v, customerId: seed.customerA })
      )
    ).rejects.toThrow(
      /committed|another deal|another customer|already held|no longer available|reserv/i
    );

    expect(await countIn(seed, "sales")).toBe(salesBefore);
    expect((await vehicleRow(seed, v)).status).toBe("RESERVED");
    const reservations = await seed.t.run(async (ctx) =>
      (await ctx.db.query("vehicleReservations").collect()).filter(
        (r) => r.vehicleId === v && r.status === "ACTIVE"
      )
    );
    expect(reservations, "the holder's reservation must survive the refusal").toHaveLength(1);
  });

  test("POSITIVE CONTROL: the reservation holder's OWN sale still completes", async () => {
    // The paired control for C.3, for the same reason as A.3: the fix must
    // refuse the rival without refusing the customer the car is being held for.
    // GREEN today, and it must stay green.
    const seed = await seedDealer("res-own");
    const v = await vehicle(seed);
    await heldByReservation(seed, v, seed.customerB);
    const quoteId = await cashQuote(seed, seed.customerB, v);
    const salesBefore = await countIn(seed, "sales");

    const saleId = await seed.asUser.mutation(
      api.sales.create,
      completedSaleArgs(seed, { vehicleId: v, customerId: seed.customerB, quoteId })
    );

    expect(await countIn(seed, "sales")).toBe(salesBefore + 1);
    const sale = await seed.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));
    expect(sale?.customerId, "the sale belongs to the customer holding the reservation").toBe(
      seed.customerB
    );
    expect((await vehicleRow(seed, v)).status).toBe("SOLD");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. ACCEPTANCE MEANS A PROVEN OUTCOME, NOT A DEFINED RETURN VALUE
//
// ⚠️ Every acceptance test in an earlier suite asserted only
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

  test("reopening a rejected application reacquires THE SAME root it released", async () => {
    // ⚠️ STRENGTHENED. The previous version asserted only that the status moved
    // and that `resolveVehicleRoot` afterwards reported kind OWNED with a
    // truthy id. A status-blind stub returning a constant `{kind:"OWNED"}`
    // satisfied all of that without the reopen doing anything at all.
    //
    // Three observations now, and a constant-returning stub fails the middle
    // one: the car is owned by root R while the application is live; it is NOT
    // owned by R once the application is rejected; and the reopen reacquires it
    // under THAT SAME root R rather than minting a new one.
    const seed = await seedDealer("reopen-proves");
    const v = await vehicle(seed);
    const quoteId = await financedQuote(seed, seed.customerA, v);
    const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
      orgId: seed.orgId,
      quoteId,
    });
    const whileLive = (await seed.asUser.query(notYetBuiltQuery.commitments.resolveVehicleRoot, {
      orgId: seed.orgId,
      vehicleId: v,
    })) as { kind: string; rootId?: unknown };
    expect(whileLive.kind, "a live application must own the car").toBe("OWNED");
    const rootWhileLive = String(whileLive.rootId);
    expect(rootWhileLive).toBeTruthy();

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "REJECTED" as const,
    });
    const whileRejected = (await seed.asUser.query(
      notYetBuiltQuery.commitments.resolveVehicleRoot,
      { orgId: seed.orgId, vehicleId: v }
    )) as { kind: string };
    expect(
      whileRejected.kind,
      "a rejected application must RELEASE the car — this is what a constant stub cannot fake"
    ).not.toBe("OWNED");

    await seed.asUser.mutation(api.applications.updateStatus, {
      orgId: seed.orgId,
      applicationId,
      status: "PENDING_DOCS" as const,
    });

    expect((await applicationRow(seed, applicationId)).status).toBe("PENDING_DOCS");
    const afterReopen = (await seed.asUser.query(notYetBuiltQuery.commitments.resolveVehicleRoot, {
      orgId: seed.orgId,
      vehicleId: v,
    })) as { kind: string; rootId?: unknown };
    expect(afterReopen.kind).toBe("OWNED");
    expect(
      String(afterReopen.rootId),
      "the reopened deal continues its own lineage rather than starting a new one"
    ).toBe(rootWhileLive);
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
    // behaviour that made a naive "one hold per vehicle" wrong in the first
    // place, and they are what contract A.1's supersession must NOT break.
    const deposits = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).filter((d) => d.quoteId === quoteId)
    );
    expect(deposits).toHaveLength(2);
    expect(deposits.every((d) => d.holdActive === true)).toBe(true);
  });

  test("total deposits on a quote may not exceed the quote's price", async () => {
    // ⚠️ RESTORED. This guard is LIVE at `deposits.ts:94` — "Total deposits
    // cannot exceed the quote amount." An earlier suite covered it and the
    // scenario genuinely PASSED; a pre-freeze audit proved that by restoring
    // the old file and running it in isolation rather than taking the old rule
    // list at face value.
    //
    // A migration dropped it from the tests AND from the rule map, so the
    // file's own coverage check could not notice: a rule absent from the map is
    // invisible to a map-completeness test. That is one of the reasons c14860
    // retired the map — a mechanism blind to its own gap is worse than no
    // mechanism, because it reports coverage it does not have.
    const seed = await seedDealer("ceiling");
    const v = await vehicle(seed);
    const quoteId = await cashQuote(seed, seed.customerA, v);
    await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId,
      amount: 20_000,
    });

    await expect(
      seed.asUser.mutation(api.deposits.create, { orgId: seed.orgId, quoteId, amount: 10_000 })
    ).rejects.toThrow(/exceed/i);

    // Postcondition: the over-cap deposit left nothing behind.
    const deposits = await seed.t.run(async (ctx) =>
      (await ctx.db.query("deposits").collect()).filter((d) => d.quoteId === quoteId)
    );
    expect(deposits).toHaveLength(1);
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
    //
    // ⚠️ Asserted by CONSEQUENCE. `.resolves.toBeDefined()` was the pattern
    // this file's own preamble rejects, and it would have been satisfied by a
    // mutation that returned an id while recording the money against the stale
    // revision — the exact fragmentation the rule exists to prevent.
    const depositId = (await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: r2,
      amount: 500,
    })) as Id<"deposits">;
    const row = await seed.t.run((ctx) => ctx.db.get(depositId));
    expect(row?.quoteId, "the money must land on the CURRENT head, not the superseded one").toBe(r2);
    expect(row?.holdActive).toBe(true);
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
    // it would break the existing flow. It is also the boundary that keeps
    // contract A.1 honest: A.1 refuses a rival on a LIVE hold, not a released
    // one.
    const rival = await cashQuote(seed, seed.customerB, freed);
    const rivalDeposit = await seed.asUser.mutation(api.deposits.create, {
      orgId: seed.orgId,
      quoteId: rival,
      amount: 1_500,
    });
    const rivalRow = await seed.t.run((ctx) => ctx.db.get(rivalDeposit));
    expect(rivalRow?.quoteId, "the rival really holds the released car").toBe(rival);
    expect(rivalRow?.holdActive).toBe(true);

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
