/**
 * The tenancy guards on the sale-completion path.
 *
 * `prepareSaleCompletion` loads five caller-supplied documents — the vehicle,
 * the customer, an optional trade-in, an optional quote and an optional finance
 * application — and each is checked against the org named in the same call.
 * `applySaleCompletionSideEffects` re-checks the trade-in later, adding
 * `isDeleted`.
 *
 * SCRUM-22 rewrites those six conditions from `!row || row.orgId !== orgId` to
 * the equivalent optional-chain form, because SonarCloud raises S6582 on the
 * first shape and a B maintainability rating blocks a required gate. The edit
 * is mechanical and the two forms are equivalent by inspection — but "equivalent
 * by inspection" is how a tenancy regression arrives, and these six guards are
 * the only thing standing between a caller-supplied id and another dealership's
 * data. So the equivalence is asserted rather than argued.
 *
 * These tests are written to pass BEFORE the rewrite. That is the point: they
 * pin the behaviour that already exists, so a change in behaviour shows up as a
 * failure rather than as a diff nobody re-read.
 *
 * Each guard gets both directions, because only refusing proves nothing — a
 * guard that refuses everything would satisfy a refusal-only test while
 * breaking every real sale:
 *
 *   - a document belonging to ANOTHER org is refused;
 *   - a well-formed id whose row no longer exists is refused;
 *   - the same call with a valid same-org document is ACCEPTED.
 *
 * The accept direction for the finance-application guard is deliberately not
 * duplicated here: `financedConsignedSettlement.test.ts` completes financed
 * sales through this same path on every run, so a guard that started refusing
 * valid applications would take that suite down first.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

async function seedGuardDealer() {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Guard Dealer", createdAt: Date.now() })
  );
  // A second, entirely separate dealership. Every "wrong org" fixture below is a
  // real row that really belongs to this one — not a fabricated id — so the
  // tests exercise the comparison rather than a lookup miss.
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
  );

  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "guard_user", email: "guard@example.com", name: "Guard User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Guard Sales",
      permissions: [
        "view:sales", "create:sales", "edit:sales",
        "view:vehicles", "edit:vehicles",
        "view:customers",
        "view:finance", "manage:finance",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const vehicleIn = (owner: Id<"organizations">, vin: string) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: owner, vin, make: "Toyota", model: "Corolla", year: 2024, mileage: 10,
        color: "White", fuelType: "Gasoline", transmission: "Automatic",
        purchasePrice: 15000, sellingPrice: 20000, status: "AVAILABLE" as const,
      })
    );
  /**
   * A trade-in has to be new to inventory: `applySaleCompletionSideEffects`
   * refuses one that already carries a `purchasePrice`, because it would then
   * be capitalized twice. That refusal message also contains the words
   * "trade-in", so a trade-in fixture built with a purchase price makes a
   * loose assertion pass for the wrong guard entirely. Hence a separate
   * builder, and exact messages on every assertion below.
   */
  const tradeInIn = (owner: Id<"organizations">, vin: string) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: owner, vin, make: "Nissan", model: "Sunny", year: 2019, mileage: 90000,
        color: "Grey", fuelType: "Gasoline", transmission: "Automatic",
        sellingPrice: 6000, status: "AVAILABLE" as const,
      })
    );
  const customerIn = (owner: Id<"organizations">, last: string) =>
    t.run((ctx) => ctx.db.insert("customers", { orgId: owner, firstName: "Buyer", lastName: last }));

  const vehicleId = await vehicleIn(orgId, "GUARDVIN0001");
  const customerId = await customerIn(orgId, "Ours");

  const sale = (overrides: Record<string, unknown>) => ({
    orgId,
    vehicleId,
    customerId,
    salespersonId: userId,
    salePrice: 20000,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    financingType: "CASH" as const,
    ...overrides,
  });

  return {
    t, orgId, otherOrgId, userId, vehicleId, customerId,
    vehicleIn, tradeInIn, customerIn, sale,
    asUser: t.withIdentity({ subject: "guard_user", clerkId: "guard_user" }),
  };
}

type Seeded = Awaited<ReturnType<typeof seedGuardDealer>>;

/**
 * A well-formed id whose row is gone. Inserted and then deleted rather than
 * hand-written, so it is a genuine id of the right table that simply resolves
 * to nothing — which is the `!row` half of each guard.
 */
async function danglingVehicleId(s: Seeded) {
  const id = await s.vehicleIn(s.orgId, "GUARDVINGONE");
  await s.t.run((ctx) => ctx.db.delete(id));
  return id;
}

describe("the sale-completion path refuses documents from another organization", () => {
  test("a vehicle owned by another dealership is refused", async () => {
    const s = await seedGuardDealer();
    const theirVehicle = await s.vehicleIn(s.otherOrgId, "THEIRVIN0001");

    await expect(
      s.asUser.mutation(api.sales.create, s.sale({ vehicleId: theirVehicle, idempotencyKey: "g1" }))
    ).rejects.toThrow(/Vehicle not found in this organization/i);
  });

  test("a vehicle id whose row no longer exists is refused", async () => {
    const s = await seedGuardDealer();
    const gone = await danglingVehicleId(s);

    await expect(
      s.asUser.mutation(api.sales.create, s.sale({ vehicleId: gone, idempotencyKey: "g2" }))
    ).rejects.toThrow(/Vehicle not found in this organization/i);
  });

  test("a customer owned by another dealership is refused", async () => {
    const s = await seedGuardDealer();
    const theirCustomer = await s.customerIn(s.otherOrgId, "Theirs");

    await expect(
      s.asUser.mutation(api.sales.create, s.sale({ customerId: theirCustomer, idempotencyKey: "g3" }))
    ).rejects.toThrow(/Customer not found in this organization/i);
  });

  test("a trade-in owned by another dealership is refused", async () => {
    const s = await seedGuardDealer();
    const theirTradeIn = await s.tradeInIn(s.otherOrgId, "THEIRTRADE01");

    await expect(
      s.asUser.mutation(
        api.sales.create,
        s.sale({ tradeInVehicleId: theirTradeIn, tradeInValue: 5000, idempotencyKey: "g4" })
      )
    ).rejects.toThrow(/Trade-in vehicle not found in this organization/i);
  });

  /**
   * ⚠️ Through `sales.createDraft`, not `sales.create`, and that is the whole
   * point of this test.
   *
   * The trade-in is checked TWICE — once in `prepareSaleCompletion` and again
   * in `applySaleCompletionSideEffects` — and both throw the *identical*
   * message. So the `sales.create` test above cannot say which one refused,
   * and mutation testing proved it: deleting the org comparison from the first
   * guard left that test green, because the second guard caught the same
   * fixture. A guard with no independent coverage was reading as covered.
   *
   * `createDraft` runs `prepareSaleCompletion` and stops before the side
   * effects, so it is the only door that reaches the first guard alone.
   */
  test("a foreign trade-in is refused before any sale is drafted, by the first guard alone", async () => {
    const s = await seedGuardDealer();
    const theirTradeIn = await s.tradeInIn(s.otherOrgId, "THEIRTRADE02");

    await expect(
      s.asUser.mutation(api.sales.createDraft, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 20000,
        saleDate: Date.now(),
        tradeInVehicleId: theirTradeIn,
        tradeInValue: 5000,
      })
    ).rejects.toThrow(/Trade-in vehicle not found in this organization/i);
  });

  /**
   * MISSING-ROW controls for the guards that had none.
   *
   * The `!row || row.orgId !== orgId` -> `row?.orgId !== orgId` rewrite has two
   * halves, and the NULL half is the subtle one. Only the vehicle had a dangling
   * fixture; an adversarial reviewer flipped the quote guard to its fail-open
   * form (`quote != null && quote.orgId !== orgId`) and this file stayed 13/13
   * green, with 199/199 across six related files. A surviving mutant is itself a
   * finding, and the stated purpose of this file is "prove they still refuse".
   *
   * Each of these deletes a row this dealership genuinely owns, so nothing but
   * the existence half of the guard under test can refuse it, and each asserts
   * that guard's own exact message.
   */
  test("a customer id whose row no longer exists is refused", async () => {
    const s = await seedGuardDealer();
    const gone = await s.customerIn(s.orgId, "Vanished");
    await s.t.run((ctx) => ctx.db.delete(gone));

    await expect(
      s.asUser.mutation(api.sales.create, s.sale({ customerId: gone, idempotencyKey: "gm1" }))
    ).rejects.toThrow(/Customer not found in this organization/i);
  });

  test("a quote id whose row no longer exists is refused", async () => {
    const s = await seedGuardDealer();
    const gone = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        vehiclePrice: 20000, downPayment: 0, termMonths: 12,
        status: "ACCEPTED" as const,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );
    await s.t.run((ctx) => ctx.db.delete(gone));

    await expect(
      s.asUser.mutation(api.sales.create, s.sale({ quoteId: gone, idempotencyKey: "gm2" }))
    ).rejects.toThrow(/Quote not found in this organization/i);
  });

  test("a trade-in id whose row no longer exists is refused by prepareSaleCompletion", async () => {
    // Driven through `createDraft`, NOT `create`, and that is the whole point.
    //
    // TWO guards carry this identical message: the one in `prepareSaleCompletion`
    // and a second in `applySaleCompletionSideEffects` that owns `isDeleted`. A
    // dangling row satisfies BOTH, so completing the sale asserts nothing about
    // which one fired — I wrote it that way first and the mutation proved it:
    // flipping the FIRST guard to its fail-open form left the suite 16/16 green,
    // because the second guard caught the fixture and produced the same message.
    //
    // `createDraft` runs `prepareSaleCompletion` and then inserts; it never
    // reaches the side effects. So only the first guard can refuse this, and the
    // fail-open mutant now dies.
    const s = await seedGuardDealer();
    const gone = await s.tradeInIn(s.orgId, "GUARDTRADEGONE");
    await s.t.run((ctx) => ctx.db.delete(gone));

    await expect(
      s.asUser.mutation(api.sales.createDraft, {
        ...s.sale({ tradeInVehicleId: gone, tradeInValue: 5000, idempotencyKey: "gm3" }),
        status: "PENDING" as const,
      })
    ).rejects.toThrow(/Trade-in vehicle not found in this organization/i);
  });

  test("a quote owned by another dealership is refused", async () => {
    const s = await seedGuardDealer();
    const theirQuote = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.otherOrgId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        vehiclePrice: 20000, downPayment: 0, termMonths: 12,
        status: "ACCEPTED" as const,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );

    await expect(
      s.asUser.mutation(api.sales.create, s.sale({ quoteId: theirQuote, idempotencyKey: "g5" }))
    ).rejects.toThrow(/Quote not found in this organization/i);
  });

  /**
   * The finance-application guard is NOT tested from this door, and that is a
   * property of the door rather than of the guard.
   *
   * `api.sales.create` does not accept an `applicationId` at all — its
   * validator refuses the field outright ("Unexpected field applicationId in
   * object"). So no fixture built here can reach it.
   *
   * ⚠️ An earlier version of this comment went on to claim the guard was
   * unreachable from ANY public entry point, and was wrong. It named
   * `applications.finalizeDeal` as the only caller and concluded that
   * finalizeDeal's own org check refused a foreign application first. In fact
   * finalizeDeal calls `completeSale`, not `completeExistingSale`, and the
   * caller that reaches this guard is `sales.completeDraft` — which takes the
   * `applicationId` from the STORED DRAFT and org-checks only the SALE. The
   * guard is reachable, and the tests in the next block reach it.
   */
});

/**
 * THE THIRD DOOR — `sales.completeDraft` -> `completeExistingSale` -> `prepareSaleCompletion`.
 *
 * The guards above are all driven through `api.sales.create`. That reaches
 * `prepareSaleCompletion` via `completeSale`, which is one of THREE callers.
 * The other two are `createDraftSale` and `completeExistingSale`, and the last
 * of those is the only path on which a finance application reaches the guard at
 * all: `sales.completeDraft` accepts no `applicationId`, it reads one off the
 * STORED DRAFT, and it org-checks only the sale.
 *
 * So the draft is the carrier. A sale legitimately created in this dealership
 * can hold an application that belongs to another one — the application was
 * moved, the row predates the guard, or the two drifted apart — and nothing
 * between the API surface and this guard looks at whose application it is.
 *
 * The application fixtures below deliberately carry OUR customer and OUR
 * vehicle. The guard has a second check immediately after the org comparison
 * ("does not match the sale source records") which a mismatched fixture would
 * trip first, refusing the sale for a different reason and leaving the org
 * comparison untested while the suite went green. Matching those fields is what
 * makes the org comparison the only term that can refuse these fixtures.
 */
describe("a finance application from another dealership is refused when the draft is completed", () => {
  async function draftCarrying(
    s: Seeded,
    appOrg: Id<"organizations">,
    options: { dangling?: boolean } = {}
  ) {
    // A real draft through the real door, so the sale itself is above suspicion.
    const saleId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 20000,
      saleDate: Date.now(),
    });

    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: appOrg,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        vehiclePrice: 20000, downPayment: 0, termMonths: 12,
        status: "ACCEPTED" as const,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: appOrg,
        quoteId,
        // OUR customer and OUR vehicle — see the block comment. The second
        // check must not be able to refuse these fixtures.
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status: "APPROVED" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    if (options.dangling) {
      await s.t.run((ctx) => ctx.db.delete(applicationId));
    }
    // The drift itself. `createDraft` cannot express this and neither can any
    // other public mutation, which is precisely why the guard exists.
    await s.t.run((ctx) => ctx.db.patch(saleId, { applicationId }));
    return saleId;
  }

  test("the draft completes when its application is the dealership's own", async () => {
    const s = await seedGuardDealer();
    const saleId = await draftCarrying(s, s.orgId);

    // ANTI-VACUITY, and it carries two claims at once. It proves the fixture
    // reaches `prepareSaleCompletion` through this door at all — a refusal
    // anywhere earlier would fail here — and it proves the guard does not
    // simply refuse every application, which is the state that would make the
    // two refusals below pass while breaking every real financed sale.
    await expect(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId })
    ).resolves.toBeDefined();
  });

  test("a draft carrying another dealership's application is refused", async () => {
    const s = await seedGuardDealer();
    const saleId = await draftCarrying(s, s.otherOrgId);

    await expect(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId })
    ).rejects.toThrow(/Finance application not found in this organization/i);
  });

  test("a draft whose application row no longer exists is refused", async () => {
    const s = await seedGuardDealer();
    const saleId = await draftCarrying(s, s.orgId, { dangling: true });

    // The `!app` half of the same guard, reached through the same door: the
    // application was deleted after the draft referenced it, so the id is
    // well-formed and resolves to nothing. `app?.orgId` is undefined, which is
    // not this org, and the sale must not complete against a document that is
    // no longer there.
    await expect(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId })
    ).rejects.toThrow(/Finance application not found in this organization/i);
  });
});

describe("the same guards accept the dealership's own documents", () => {
  // Without this the refusals above would be satisfied by a guard that refused
  // everything, which would break every real sale while the suite stayed green.

  test("a sale of the dealership's own vehicle to its own customer completes", async () => {
    const s = await seedGuardDealer();

    const saleId = await s.asUser.mutation(api.sales.create, s.sale({ idempotencyKey: "ok1" }));
    expect(saleId).toBeTruthy();
  });

  test("the dealership's own trade-in is accepted on the same sale", async () => {
    const s = await seedGuardDealer();
    const ourTradeIn = await s.tradeInIn(s.orgId, "OURTRADE0001");

    const saleId = await s.asUser.mutation(
      api.sales.create,
      s.sale({ tradeInVehicleId: ourTradeIn, tradeInValue: 5000, idempotencyKey: "ok2" })
    );
    expect(saleId).toBeTruthy();
  });

  test("the dealership's own quote is accepted on the same sale", async () => {
    const s = await seedGuardDealer();
    const ourQuote = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
        vehiclePrice: 20000, downPayment: 0, termMonths: 12,
        status: "ACCEPTED" as const, createdBy: s.userId, createdAt: Date.now(),
      })
    );

    const saleId = await s.asUser.mutation(
      api.sales.create,
      s.sale({ quoteId: ourQuote, idempotencyKey: "ok3" })
    );
    expect(saleId).toBeTruthy();
  });
});

describe("the second trade-in check owns one term the first does not", () => {
  /**
   * `applySaleCompletionSideEffects` re-reads the trade-in and adds
   * `|| tradeInVehicle.isDeleted`.
   *
   * Its org and existence conjuncts are unreachable from EVERY path, not just
   * this one — `applySaleCompletionSideEffects` has exactly two callers,
   * `completeSale` and `completeExistingSale`, and both run
   * `prepareSaleCompletion` first, which already refuses a foreign or missing
   * trade-in. `createDraftSale`, the third caller of that function, stops
   * before the side effects. Both guards throw the IDENTICAL message, so a
   * cross-org fixture here would be refused by the earlier guard, go green, and
   * assert nothing about this check at all.
   *
   * ⚠️ A mutation audit of all six guards confirms it rather than assuming it.
   * Deleting the org comparison from each in turn — keeping the existence
   * check, so only the org term is removed — and running this file:
   *
   *   vehicle           KILLED     (1 failed / 12 passed)
   *   customer          KILLED     (1 failed / 12 passed)
   *   trade-in, first   KILLED     (1 failed / 12 passed)
   *   quote             KILLED     (1 failed / 12 passed)
   *   application       KILLED     (1 failed / 12 passed)  <- by the third-door block above
   *   trade-in, second  SURVIVED   (13 passed)
   *
   * The survivor is this one, and it survives because it is masked rather than
   * because it is untested. No fixture can kill it while the earlier guard
   * stands, so none is written here — writing one would produce exactly the
   * green-test-asserting-the-wrong-door this suite exists to avoid.
   *
   * `isDeleted` is the only term this check uniquely owns, so it is the only
   * fixture that can hold it to account, and it is what the rewrite must not
   * drop.
   */
  test("a soft-deleted trade-in is refused even though it belongs to this dealership", async () => {
    const s = await seedGuardDealer();
    const deletedTradeIn = await s.tradeInIn(s.orgId, "OURDELETED01");
    await s.t.run((ctx) => ctx.db.patch(deletedTradeIn, { isDeleted: true }));

    await expect(
      s.asUser.mutation(
        api.sales.create,
        s.sale({ tradeInVehicleId: deletedTradeIn, tradeInValue: 5000, idempotencyKey: "g7" })
      )
    ).rejects.toThrow(/Trade-in vehicle not found in this organization/i);
  });
});
