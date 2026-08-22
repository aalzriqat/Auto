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
   * The finance-application guard has NO test here, and that is a finding
   * rather than an omission.
   *
   * `api.sales.create` does not accept an `applicationId` at all — its
   * validator refuses the field outright ("Unexpected field applicationId in
   * object"), which is how the first attempt at this test failed. The only
   * caller that supplies one is `completeExistingSale`, reached from
   * `applications.finalizeDeal`, and finalizeDeal loads the application and
   * org-checks it BEFORE calling through. So a foreign application is refused
   * by the earlier door and never reaches the guard here.
   *
   * That makes the org conjunct of this guard defense in depth, exactly like
   * the org conjuncts of the second trade-in check below — unreachable from
   * any public entry point, so no fixture can hold it to account without
   * being refused by a different guard first and proving nothing. Writing one
   * anyway would produce a green test that asserts the wrong door.
   *
   * Its ACCEPT direction is covered: `financedConsignedSettlement.test.ts`
   * drives real financed sales through this path, so a guard that began
   * refusing valid same-org applications would fail that suite immediately.
   */
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
   * Its org and existence conjuncts are unreachable from this path — the guard
   * in `prepareSaleCompletion` refuses a foreign or missing trade-in long
   * before the side effects run, so a cross-org fixture would be refused by the
   * EARLIER guard and prove nothing about this one. `isDeleted` is the only
   * term this check uniquely owns, so it is the only fixture that can hold it
   * to account, and it is what the rewrite must not drop.
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
