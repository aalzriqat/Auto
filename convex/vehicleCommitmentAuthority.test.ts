import { TestConvex } from "convex-test";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

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
 * The root cause is that the question has no single owner. `vehicles.reserve`
 * enforces real exclusivity over `vehicleReservations` + deposit holds;
 * `applications.createFromQuote` enforces a DIFFERENT rule over its own private
 * `IN_FLIGHT_STATUSES`; and sale completion enforced a third. All three answer
 * "is this car spoken for" and they disagree.
 *
 * ## The binding rulings these fixtures encode
 *
 * - **Application-only claim.** A financed QUOTE does not hard-lock a vehicle —
 *   `saveQuote` is an informational financing draft, not a committed sale. The
 *   commitment begins when the Finance Application is created.
 * - **A supplied financed quote is still refused** by generic completion, even
 *   though the quote holds no claim: passing it is an affirmative statement
 *   about the deal in front of you.
 * - **`vehicles.status = RESERVED` is a projection, never the lock.** A vehicle
 *   row is not always one physical car, so `holdVehicleForDeposit` deliberately
 *   treats RESERVED as "a warning, not a lock". Exclusivity lives in the claim
 *   and hold ROWS.
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
});
