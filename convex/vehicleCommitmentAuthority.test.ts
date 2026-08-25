import { TestConvex } from "convex-test";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { anyApi, FunctionReference } from "convex/server";

/**
 * A query this design REQUIRES that does not exist yet.
 *
 * This was a `test.skip` whose body never invoked anything — it would have
 * passed green if merely unskipped, which makes it a comment rather than a
 * specification. It is now an ordinary active test that genuinely calls the
 * surface and genuinely fails until that surface exists.
 */
const notYetBuiltQuery = anyApi as unknown as Record<
  string,
  Record<string, FunctionReference<"query", "public", Record<string, unknown>, unknown>>
>;

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-195 — the canonical vehicle-commitment authority.
 *
 * FAILING-FIRST DESIGN FIXTURES. No implementation exists yet; these encode the
 * behaviour the authority must produce, and the ones that fail today are the
 * specification. They are deliberately written against the REAL public
 * mutations rather than against the future claim table, so they keep their
 * meaning whatever shape the claim record ends up taking — a fixture that
 * asserts the existence of a row can only test the row, while a fixture that
 * asserts an operator cannot sell a committed car tests the thing we actually
 * care about.
 *
 * ## Why this issue exists
 *
 * PR #258 tried to answer "is this vehicle already committed?" inside the sale
 * boundary by reconstructing it from proxies — first the vehicle, then the
 * customer, then the customer's quotes. Two independent closing reviewers found
 * that each reconstruction traded one failure mode for its opposite, and the
 * convergence circuit breaker fired.
 *
 * The root cause is that the question has no single owner.
 * `vehicles.createReservation` enforces real exclusivity over
 * `vehicleReservations` + deposit holds;
 * `applications.createFromQuote` enforces a DIFFERENT rule over its own private
 * `IN_FLIGHT_STATUSES`; and sale completion enforced a third. All three answer
 * "is this car spoken for" and they disagree.
 *
 * ## The binding rulings these fixtures encode
 *
 * - **A `vehicles` row is ONE physical unit. Always.** `sourceType` answers
 *   ownership and accounting treatment, never whether inventory is repeatable:
 *   STOCK is one dealer-owned car, SOURCED is one supplier-owned consigned car
 *   (`vehicleOwnership.ts` reads SOURCED as `SUPPLIER` / `CONSIGNED_AGENT`).
 *   Another obtainable car from the same free-zone source becomes another row
 *   once it enters a deal. The existing comment in `holdVehicleForDeposit`
 *   permitting parallel holds because "the same car can be sourced again" is
 *   therefore a domain-model bug FOR COMMITMENT PURPOSES — informational quotes
 *   may coexist on one row, hard commitments may not.
 * - **Application-only claim.** A financed QUOTE does not hard-lock a vehicle —
 *   `saveQuote` is an informational financing draft, not a committed sale. The
 *   commitment begins when the Finance Application is created. But explicitly
 *   SUPPLYING a financed quote to generic completion is still refused: passing
 *   it is an affirmative statement about the deal in front of you.
 * - **Claim lifecycle.** ACTIVE → RELEASED on REJECTED/CANCELLED; RELEASED →
 *   ACTIVE only through explicit atomic reacquisition; ACTIVE → CONSUMED on a
 *   successful final sale. Sale cancellation must NOT resurrect a CONSUMED
 *   claim — a reopened finance workflow reacquires through the same authority.
 * - **No silent TTL.** A commitment blocks until explicitly and authentically
 *   released. The mitigant for abandonment is SURFACING aged commitments so an
 *   operator can cancel them deliberately, never a clock that frees a car
 *   because time passed.
 * - **The trade-in is a second vehicle role.** One physical unit cannot be both
 *   an outbound committed sale unit and an inbound trade-in on another deal.
 *   The same applies to archive and soft-delete: a committed unit must not be
 *   made to disappear underneath the deal that owns it.
 * - **`vehicles.status = RESERVED` is a projection, never the lock.**
 *   Exclusivity lives in the claim and hold ROWS.
 */

type Seed = Awaited<ReturnType<typeof seedDealer>>;

const PRICE = 30_000;

async function createVehicle(
  t: TestConvex<typeof schema>,
  orgId: Id<"organizations">,
  vin: string
): Promise<Id<"vehicles">> {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Nissan",
      model: "Patrol",
      year: 2024,
      mileage: 50,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 25_000,
      sellingPrice: PRICE,
      status: "AVAILABLE",
    })
  );
}

/**
 * A trade-in candidate.
 *
 * Deliberately WITHOUT a purchase price: sale completion refuses a trade-in
 * that already carries one ("Clear it before completing this sale, or the
 * trade-in value won't be capitalized correctly"), and a fixture that trips
 * that guard would pass for entirely the wrong reason — the commitment check
 * it is named for would never run.
 */
async function createTradeInCandidate(
  seed: Seed,
  vin: string
): Promise<Id<"vehicles">> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  await seed.t.run((ctx) => ctx.db.patch(vehicleId, { purchasePrice: undefined }));
  return vehicleId;
}

async function seedDealer(suffix: string) {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Commitment Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `cmt_user_${suffix}`, email: `u${suffix}@x.com`, name: "Closer" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `cmt_appr_${suffix}`, email: `a${suffix}@x.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Commitment",
      permissions: [
        "view:sales",
        "create:sales",
        "approve:requests",
        "view:customers",
        "edit:sales",
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
    ctx.db.insert("customers", { orgId, firstName: "Aisha", lastName: "First" })
  );
  const customerB = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Bilal", lastName: "Second" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Commitment Finance",
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
    asUser: t.withIdentity({ subject: `cmt_user_${suffix}`, clerkId: `cmt_user_${suffix}` }),
    asApprover: t.withIdentity({ subject: `cmt_appr_${suffix}`, clerkId: `cmt_appr_${suffix}` }),
  };
}

async function financedQuote(
  seed: Seed,
  customerId: Id<"customers">,
  vehicleId: Id<"vehicles">
): Promise<Id<"quotes">> {
  return await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId,
    vehicleId,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: seed.companyId,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 48,
    totalFinancedAmount: PRICE,
  });
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
    mode: "CASH",
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 0,
    totalFinancedAmount: 0,
  });
}

/** Drive an application to the point where `finalizeDeal` will accept it. */
async function readyToFinalize(seed: Seed, applicationId: Id<"financeApplications">) {
  await seed.asUser.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "UNDER_REVIEW",
  });
  await seed.asApprover.mutation(api.applications.updateStatus, {
    orgId: seed.orgId,
    applicationId,
    status: "APPROVED",
  });
  await registerHandover(seed.asUser, api, seed.orgId, applicationId);
  await seed.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: seed.orgId,
    applicationId,
    method: "CASH",
    expectedDate: Date.now(),
  });
}

function cashSaleArgs(seed: Seed, customerId: Id<"customers">, vehicleId: Id<"vehicles">) {
  return {
    orgId: seed.orgId,
    vehicleId,
    customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
  };
}

/** Every application row in the org, for zero-partial-state assertions. */
async function allApplications(seed: Seed) {
  return await seed.t.run((ctx) =>
    ctx.db
      .query("financeApplications")
      .filter((q) => q.eq(q.field("orgId"), seed.orgId))
      .collect()
  );
}

async function vehicleStatus(seed: Seed, vehicleId: Id<"vehicles">) {
  return await seed.t.run(async (ctx) => (await ctx.db.get(vehicleId))!.status);
}

describe("SCRUM-195: one authority decides whether a vehicle is committed", () => {
  describe("1. multi-vehicle — the refusal must precede every claim", () => {
    test("a financed multi-vehicle quote is refused with NO partial state", async () => {
      // The ordering requirement, pinned before the code that could break it
      // exists. Finance applications are single-vehicle, so a multi-vehicle
      // financed quote must be refused OUTRIGHT — and critically, refused
      // BEFORE anything is claimed. A future acquisition loop that claimed
      // vehicle 1 and then discovered vehicle 2 makes the application
      // unsupported would leave car 1 committed to a deal that does not exist.
      //
      // Passes today because the length check already sits ahead of every
      // write. It exists to keep it there.
      const seed = await seedDealer("multi");
      const v1 = await createVehicle(seed.t, seed.orgId, "CMT0000000000001");
      const v2 = await createVehicle(seed.t, seed.orgId, "CMT0000000000002");

      const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerA,
        vehicleId: v1,
        vehicleItems: [
          { vehicleId: v1, unitPrice: PRICE },
          { vehicleId: v2, unitPrice: PRICE },
        ],
        mode: "CONFIGURED_FINANCE_COMPANY",
        companyId: seed.companyId,
        vehiclePrice: PRICE * 2,
        downPayment: 0,
        termMonths: 48,
        totalFinancedAmount: PRICE * 2,
      });

      await expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId })
      ).rejects.toThrow(/exactly one vehicle/i);

      expect(await allApplications(seed)).toHaveLength(0);
      expect(await vehicleStatus(seed, v1)).toBe("AVAILABLE");
      expect(await vehicleStatus(seed, v2)).toBe("AVAILABLE");
    });
  });

  describe("2. competing applications — two live claims on one car cannot coexist", () => {
    test("a second application on a vehicle already claimed by another customer is refused", async () => {
      const seed = await seedDealer("compete");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000003");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      const qB = await financedQuote(seed, seed.customerB, vehicleId);
      await expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qB })
      ).rejects.toThrow(/active finance application|already/i);

      expect(await allApplications(seed)).toHaveLength(1);
    });
  });

  describe("3. REJECTED and reopen — the two subsystems must not disagree", () => {
    test("reopening a rejected application is refused once another deal owns the car", async () => {
      // The contradiction that survived #258. `createFromQuote` excludes
      // REJECTED from its in-flight set deliberately, so that a rejection does
      // not strand a car; the sale boundary treated REJECTED as live because
      // `REJECTED -> PENDING_DOCS` is permitted. Both are locally right.
      //
      // Under one authority the conflict dissolves: rejection RELEASES the
      // claim, and reopening must RE-ACQUIRE it — failing when the car has
      // since been committed elsewhere. FAILS TODAY: the reopen succeeds and
      // strands the application on a sold car.
      const seed = await seedDealer("reopen");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000004");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      const appA = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qA,
      });
      // createFromQuote already lands the application in PENDING_DOCS, so the
      // lifecycle starts from there.
      await seed.asUser.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId: appA,
        status: "UNDER_REVIEW",
      });
      await seed.asApprover.mutation(api.applications.updateStatus, {
        orgId: seed.orgId,
        applicationId: appA,
        status: "REJECTED",
      });

      // The car is free again, so a second deal legitimately takes it.
      const qB = await financedQuote(seed, seed.customerB, vehicleId);
      const appB = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qB,
      });
      await readyToFinalize(seed, appB);
      await seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId: appB,
      });
      expect(await vehicleStatus(seed, vehicleId)).toBe("SOLD");

      // A's rejection is reopenable in the lifecycle — but the car is gone.
      await expect(
        seed.asUser.mutation(api.applications.updateStatus, {
          orgId: seed.orgId,
          applicationId: appA,
          status: "PENDING_DOCS",
        })
      ).rejects.toThrow(/no longer available|already been sold|another deal|committed/i);
    });
  });

  describe("4. cancellation releases the commitment", () => {
    test("after cancelling, the same car can be claimed by a different customer", async () => {
      // The positive control for release. Without it, every refusal above could
      // be satisfied by an authority that simply never lets go of a car.
      const seed = await seedDealer("cancel");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000005");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      const appA = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qA,
      });
      await seed.asUser.mutation(api.applications.cancelApplication, {
        orgId: seed.orgId,
        applicationId: appA,
      });

      const qB = await financedQuote(seed, seed.customerB, vehicleId);
      const appB = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qB,
      });
      expect(appB).toBeDefined();
    });
  });

  describe("5. cross-customer cash — a committed car is not sellable to someone else", () => {
    test("a cash sale to another customer is refused while a live application holds the car", async () => {
      // ⚠️ SUPERSEDES the different-customer carve-out in SCRUM-69 c14537,
      // which permitted this because the alternative was a permanent inventory
      // lock. Under an explicit claim the lock is no longer permanent — the
      // claim is releasable — so the reason for the carve-out is gone, while
      // the harm it allowed is real: both closing reviewers found that selling
      // the car to B strands A's application forever, which is the exact defect
      // this whole area exists to prevent.
      //
      // FAILS TODAY: the sale completes.
      const seed = await seedDealer("crosscash");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000006");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      await expect(
        seed.asUser.mutation(api.sales.create, cashSaleArgs(seed, seed.customerB, vehicleId))
      ).rejects.toThrow(/finance application|committed|another deal/i);

      expect(await vehicleStatus(seed, vehicleId)).not.toBe("SOLD");
    });

    test("the refusal names the actual holder rather than advising an impossible remedy", async () => {
      // #258 told an operator to "cancel the finance application first" in a
      // situation where no application existed. A message that names a remedy
      // the operator cannot perform is worse than a bare refusal, because it
      // sends them looking for something that is not there.
      const seed = await seedDealer("crossmsg");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000007");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      await expect(
        seed.asUser.mutation(api.sales.create, cashSaleArgs(seed, seed.customerB, vehicleId))
      ).rejects.toThrow(/another customer|different customer|Aisha/i);
    });
  });

  describe("6. same-customer switch to cash", () => {
    test("is refused until the finance application is released", async () => {
      // Owner ruling c14537 option (a), unchanged: cancellation is not a status
      // flip. It releases the hold and unwinds the deal, so a cash sale must
      // not step around it.
      const seed = await seedDealer("switch");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000008");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      await expect(
        seed.asUser.mutation(api.sales.create, cashSaleArgs(seed, seed.customerA, vehicleId))
      ).rejects.toThrow(/cancel|release/i);
    });

    test("and succeeds once it is cancelled", async () => {
      const seed = await seedDealer("switch-ok");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000009");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      const appA = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qA,
      });
      await seed.asUser.mutation(api.applications.cancelApplication, {
        orgId: seed.orgId,
        applicationId: appA,
      });

      const saleId = await seed.asUser.mutation(
        api.sales.create,
        cashSaleArgs(seed, seed.customerA, vehicleId)
      );
      expect(await seed.t.run((ctx) => ctx.db.get(saleId))).toBeTruthy();
      expect(await vehicleStatus(seed, vehicleId)).toBe("SOLD");
    });
  });

  describe("7. a financed QUOTE does not claim inventory — but supplying it still refuses", () => {
    test("a financed quote with no application does NOT block an unrelated cash sale", async () => {
      // Owner ruling: `saveQuote` is an informational financing draft, not a
      // committed sale. The commitment begins at the application. This
      // deliberately reclassifies the old pre-application finding: a financed
      // quote that never became an application holds nothing.
      const seed = await seedDealer("quotefree");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000010");
      await financedQuote(seed, seed.customerA, vehicleId);

      const saleId = await seed.asUser.mutation(
        api.sales.create,
        cashSaleArgs(seed, seed.customerB, vehicleId)
      );
      expect(await seed.t.run((ctx) => ctx.db.get(saleId))).toBeTruthy();
    });

    test("but explicitly supplying that financed quote is still refused", async () => {
      // Passing the quote is an affirmative statement about the deal in front
      // of you. The claim model does not license completing a deal you have
      // just declared to be financed.
      const seed = await seedDealer("quotesupplied");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000011");
      const quoteId = await financedQuote(seed, seed.customerA, vehicleId);

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...cashSaleArgs(seed, seed.customerA, vehicleId),
          quoteId,
        })
      ).rejects.toThrow(/finance application|financed/i);
    });

    test("an ordinary cash quote and a walk-in both still complete", async () => {
      // The anti-vacuity control for this whole file. Without it every refusal
      // above is satisfiable by an authority that refuses everything.
      const seed = await seedDealer("controls");
      const quoted = await createVehicle(seed.t, seed.orgId, "CMT0000000000012");
      const walkin = await createVehicle(seed.t, seed.orgId, "CMT0000000000013");

      const cq = await cashQuote(seed, seed.customerA, quoted);
      const s1 = await seed.asUser.mutation(api.sales.create, {
        ...cashSaleArgs(seed, seed.customerA, quoted),
        quoteId: cq,
      });
      const s2 = await seed.asUser.mutation(
        api.sales.create,
        cashSaleArgs(seed, seed.customerB, walkin)
      );

      expect(await seed.t.run((ctx) => ctx.db.get(s1))).toBeTruthy();
      expect(await seed.t.run((ctx) => ctx.db.get(s2))).toBeTruthy();
    });

    test("finalizeDeal still completes its own deal through the authority", async () => {
      const seed = await seedDealer("finalize");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000014");
      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      const appA = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qA,
      });
      await readyToFinalize(seed, appA);

      const saleId = await seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId: appA,
      });
      expect(await seed.t.run(async (ctx) => (await ctx.db.get(saleId))!.status)).toBe("COMPLETED");
    });
  });

  describe("8. a SOURCED row is ONE physical car, not repeatable supply", () => {
    // The domain ruling, pinned. `vehicleOwnership.ts` reads SOURCED as
    // SUPPLIER-owned / CONSIGNED_AGENT — a VIN-specific consigned car — while
    // `holdVehicleForDeposit` permits parallel holds on the reasoning that "the
    // same car can be sourced again from the free zone". Both hang off the same
    // flag, and the second reading is a domain-model bug for commitment
    // purposes: another obtainable car is another ROW.
    async function sourcedVehicle(seed: Seed, vin: string) {
      const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
      await seed.t.run((ctx) => ctx.db.patch(vehicleId, { sourceType: "SOURCED" as const }));
      return vehicleId;
    }

    test("two finance applications cannot both hold one SOURCED vehicle", async () => {
      const seed = await seedDealer("sourced-app");
      const vehicleId = await sourcedVehicle(seed, "CMT0000000000015");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      const qB = await financedQuote(seed, seed.customerB, vehicleId);
      await expect(
        seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qB })
      ).rejects.toThrow(/active finance application|already|committed/i);
    });

    test("a deposit by another customer cannot hold a car a finance application already holds", async () => {
      // FAILS TODAY. `holdVehicleForDeposit` no-ops when the vehicle is already
      // RESERVED and never consults `financeApplications` at all, so customer B
      // can put real money down on a car customer A's application owns. Two
      // live holders, one physical car.
      const seed = await seedDealer("sourced-dep");
      const vehicleId = await sourcedVehicle(seed, "CMT0000000000016");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      const qB = await cashQuote(seed, seed.customerB, vehicleId);
      await expect(
        seed.asUser.mutation(api.deposits.create, {
          orgId: seed.orgId,
          quoteId: qB,
          amount: 500,
        })
      ).rejects.toThrow(/finance application|committed|another customer/i);
    });
  });

  describe("9. createReservation is the THIRD reader and must consult the same authority", () => {
    test("a manual reservation is refused on a car a finance application holds", async () => {
      // FAILS TODAY. `createReservation` checks `vehicleReservations` and
      // `getActiveDepositHolds` but never `financeApplications`, so a walk-in
      // reservation succeeds over a live financed deal. Named here because the
      // design's "three readers" claim is only true once this one participates.
      const seed = await seedDealer("reserve");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000017");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      await expect(
        seed.asUser.mutation(api.vehicles.createReservation, {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerB,
        })
      ).rejects.toThrow(/finance application|committed|another/i);
    });
  });

  describe("10. the trade-in is a second vehicle role", () => {
    test("a committed vehicle cannot be accepted as another deal's trade-in", async () => {
      // FAILS TODAY. `saleCompletion.ts` refuses a trade-in that is SOLD,
      // ARCHIVED, deleted or foreign — but never asks whether another deal
      // already committed it. So the unit customer A's application owns can be
      // capitalised into customer B's deal as a trade-in, and now two deals
      // own one physical car in opposite directions.
      const seed = await seedDealer("tradein");
      const committed = await createTradeInCandidate(seed, "CMT0000000000018");
      const selling = await createVehicle(seed.t, seed.orgId, "CMT0000000000019");

      const qA = await financedQuote(seed, seed.customerA, committed);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...cashSaleArgs(seed, seed.customerB, selling),
          tradeInVehicleId: committed,
          tradeInValue: 5_000,
        })
      ).rejects.toThrow(/committed|finance application|another deal/i);
    });

    test("an uncommitted vehicle is still accepted as a trade-in", async () => {
      // The control. Without it the refusal above is satisfiable by a guard
      // that refuses every trade-in, which would break an ordinary deal shape.
      const seed = await seedDealer("tradein-ok");
      const freeUnit = await createTradeInCandidate(seed, "CMT0000000000020");
      const selling = await createVehicle(seed.t, seed.orgId, "CMT0000000000021");

      const saleId = await seed.asUser.mutation(api.sales.create, {
        ...cashSaleArgs(seed, seed.customerB, selling),
        tradeInVehicleId: freeUnit,
        tradeInValue: 5_000,
      });
      expect(await seed.t.run((ctx) => ctx.db.get(saleId))).toBeTruthy();
    });
  });

  describe("11. a committed unit cannot be made to disappear", () => {
    test("soft-deleting a vehicle a finance application holds is refused", async () => {
      // FAILS TODAY, and the reason is subtle: a finance application never
      // patches `vehicle.status`, so a claim with no accompanying deposit
      // leaves the car AVAILABLE. `softDelete`'s SOLD/RESERVED guard therefore
      // never fires, and the unit vanishes from under the deal that owns it.
      const seed = await seedDealer("delete");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000022");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      await seed.asUser.mutation(api.applications.createFromQuote, { orgId: seed.orgId, quoteId: qA });

      expect(await vehicleStatus(seed, vehicleId)).toBe("AVAILABLE");

      await expect(
        seed.asUser.mutation(api.vehicles.softDelete, { orgId: seed.orgId, vehicleId })
      ).rejects.toThrow(/committed|finance application|in use|another deal/i);
    });
  });

  describe("12. finalization CONSUMES the claim, and cancellation does not resurrect it", () => {
    test("a cancelled sale does not silently return the car to its closed application", async () => {
      // The lifecycle ruling. `finalizeDeal` closes the application and the
      // claim must become CONSUMED, not stay ACTIVE. Then `sales.update` to
      // CANCELLED reverses the sale and frees the car — but it must NOT hand it
      // back to the CLOSED application, which can no longer legitimately own
      // anything. A reopened finance workflow has to reacquire.
      //
      // Asserted through observable state rather than the claim row, so it
      // survives whatever shape the record takes: after cancellation the car is
      // claimable by a DIFFERENT customer, which is only true if the closed
      // application's claim did not come back.
      const seed = await seedDealer("consume");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000023");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      const appA = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qA,
      });
      await readyToFinalize(seed, appA);
      const saleId = await seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId: appA,
      });

      await seed.asApprover.mutation(api.sales.update, {
        orgId: seed.orgId,
        saleId,
        status: "CANCELLED",
      });

      const qB = await financedQuote(seed, seed.customerB, vehicleId);
      const appB = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qB,
      });
      expect(appB).toBeDefined();
    });
  });

  describe("13. abandonment is surfaced, never silently expired", () => {
    // SKIPPED DELIBERATELY, and the skip IS the specification.
    //
    // This is the one requirement that cannot be expressed as a running
    // failing-first test today: the surfacing query does not exist, so the
    // fixture does not compile rather than merely fail. Casting through `any`
    // to force it green would hide that, and asserting something weaker — that
    // `createdAt` exists, say — would pass trivially and prove nothing.
    //
    // REQUIRED CONTRACT, to be enabled in the same change that adds it:
    //   api.applications.listAgedCommitments({ orgId, olderThanMs })
    //     -> Array<{ applicationId, vehicleId, customerId, acquiredAt }>
    //
    // This is the mitigant that makes fixture 5a tolerable. The ruling forbids
    // any silent TTL, so a commitment blocks until someone releases it
    // authentically — which is only acceptable if abandoned commitments are
    // VISIBLE, letting an operator decide to cancel rather than discovering the
    // lock when a sale is refused.
    test("an aged live commitment is discoverable so an operator can cancel it deliberately", async () => {
      // FAILS TODAY — no such query exists. This is the mitigant that replaces
      // the inventory-lock objection to fixture 5a. The ruling is explicit that
      // there must be NO silent TTL: a commitment blocks until someone releases
      // it authentically. That is only tolerable if abandoned commitments are
      // VISIBLE, so the operator can make the cancellation decision rather than
      // discovering the lock when a sale is refused.
      const seed = await seedDealer("aged");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000024");

      const qA = await financedQuote(seed, seed.customerA, vehicleId);
      const appA = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId: qA,
      });

      // Age it well past any reasonable working window.
      const ninetyDaysAgo = Date.now() - 90 * 24 * 60 * 60 * 1000;
      await seed.t.run((ctx) =>
        ctx.db.patch(appA, { createdAt: ninetyDaysAgo, updatedAt: ninetyDaysAgo })
      );

      const aged = (await seed.asUser.query(notYetBuiltQuery.applications.listAgedCommitments, {
        orgId: seed.orgId,
        olderThanMs: 30 * 24 * 60 * 60 * 1000,
      })) as Array<{ applicationId: Id<"financeApplications"> }>;
      expect(aged.map((row) => row.applicationId)).toContain(appA);

      // And it is still holding the car — surfacing is not releasing.
      expect(await vehicleStatus(seed, vehicleId)).not.toBe("SOLD");
    });
  });

  describe("14. the resolver may never report FREE because it stopped reading", () => {
    test("the 51st hold on a vehicle is still a hold", async () => {
      // `getActiveDepositHolds` reads with `.take(50)` in three places. A car
      // carrying 51 active holds therefore reports only 50, and if the real
      // blocking holder is row 51 the resolver says FREE. That is not a
      // performance nit: a canonical authority that can answer "free" because
      // it stopped reading is not canonical.
      //
      // Seeded directly because the point is the READ path, not the write path.
      const seed = await seedDealer("cap");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "CMT0000000000025");

      await seed.t.run(async (ctx) => {
        for (let i = 0; i < 51; i += 1) {
          // The last one belongs to the other customer: it is the row that must
          // block, and the row `.take(50)` drops.
          const owner = i === 50 ? seed.customerA : seed.customerB;
          await ctx.db.insert("deposits", {
            orgId: seed.orgId,
            customerId: owner,
            vehicleId,
            amount: 100,
            amountMinor: 100_000,
            currency: "JOD",
            method: "CASH" as const,
            status: "HELD" as const,
            holdActive: true,
            createdAt: Date.now(),
            createdBy: seed.userId,
          });
        }
      });

      await expect(
        seed.asUser.mutation(api.vehicles.createReservation, {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerB,
        })
      ).rejects.toThrow(/deposit|holding|committed/i);
    });
  });
});
