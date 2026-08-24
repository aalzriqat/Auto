import { TestConvex } from "convex-test";
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  assertFinancedDealCommitsThroughApplication,
  dealerEconomicsGap,
  financeApplicationCompletionGap,
  quoteCommitsThroughApplication,
} from "./utils/financedCompletionBoundary";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-69 — the sale-completion boundary.
 *
 * A financed deal is supposed to commit through its finance application:
 * handover registered, dealer economics recorded, then `finalizeDeal`. But
 * `sales.create`, `sales.createDraft` -> `sales.completeDraft` and
 * `sales.completeFromQuote` all reach the shared completion path without ever
 * asking whether the quote is financed or whether a lifecycle is in progress.
 * A caller holding `create:sales` can therefore complete a configured quote
 * outright: the sale is COMPLETED, the vehicle is SOLD, the accounting side
 * effects run, and the application is left APPROVED and stranded because its
 * own `finalizeDeal` now fails on an already-sold vehicle.
 *
 * These tests are written to FAIL against the current tree. Every refusal
 * asserted below is a refusal that does not exist yet — that is the point, and
 * a run of this file before the boundary lands is the evidence that the four
 * doors are genuinely open rather than theoretically open.
 *
 * The mode-less cases are not a variant of the configured ones, they are the
 * sharper defect. `quotes.saveQuote` permits `companyId` with no `mode`, and
 * `completeFromQuote` refuses only a mode that is PRESENT and non-CASH — so a
 * quote naming a real finance company with no mode is completed and recorded as
 * `financingType: "CASH"`. That is not a bypassed lifecycle, it is a financed
 * deal written down as a cash one.
 */

type Seed = Awaited<ReturnType<typeof seedDealer>>;

async function createVehicle(
  t: TestConvex<typeof schema>,
  orgId: Id<"organizations">,
  vin: string
): Promise<Id<"vehicles">> {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 24_000,
      sellingPrice: 31_000,
      status: "AVAILABLE",
    })
  );
}

async function seedDealer(suffix = "1") {
  const t = convexTestWithComponents(schema, MODULES);

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Boundary Dealer ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `boundary_user_${suffix}`,
      email: `boundary${suffix}@example.com`,
      name: "Boundary User",
    })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `boundary_approver_${suffix}`,
      email: `boundary.approver${suffix}@example.com`,
      name: "Boundary Approver",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Boundary",
      permissions: [
        "view:sales",
        "create:sales",
        "approve:requests",
        "review:finance_application",
        "approve:finance_application",
        "finalize:financed_deal",
        "view:finance_applications",
        "view:customers",
        "register:vehicle_handover",
        "register:expected_payment",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Boundary", lastName: "Customer" })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Configured Finance Co",
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
    customerId,
    companyId,
    asUser: t.withIdentity({ subject: `boundary_user_${suffix}`, clerkId: `boundary_user_${suffix}` }),
    asApprover: t.withIdentity({
      subject: `boundary_approver_${suffix}`,
      clerkId: `boundary_approver_${suffix}`,
    }),
  };
}

const PRICE = 31_000;

/** A quote whose mode names a configured finance company. */
async function configuredQuote(seed: Seed, vin: string): Promise<{ quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: seed.companyId,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 48,
    totalFinancedAmount: PRICE,
  });
  return { quoteId, vehicleId };
}

/**
 * A quote carrying a real finance company with NO mode recorded.
 *
 * Creatable through the ordinary public mutation today, and the shape
 * `settlementPayer` already treats as configured. This is the one that gets
 * written down as CASH.
 */
async function modelessFinancedQuote(
  seed: Seed,
  vin: string
): Promise<{ quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId,
    companyId: seed.companyId,
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 48,
    totalFinancedAmount: PRICE,
  });
  return { quoteId, vehicleId };
}

/** An ordinary cash quote — no financier, no application, nothing to bypass. */
async function cashQuote(seed: Seed, vin: string): Promise<{ quoteId: Id<"quotes">; vehicleId: Id<"vehicles"> }> {
  const vehicleId = await createVehicle(seed.t, seed.orgId, vin);
  const quoteId = await seed.asUser.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId,
    customerId: seed.customerId,
    vehicleId,
    mode: "CASH",
    vehiclePrice: PRICE,
    downPayment: 0,
    termMonths: 0,
    totalFinancedAmount: 0,
  });
  return { quoteId, vehicleId };
}

function saleArgs(seed: Seed, quoteId: Id<"quotes">, vehicleId: Id<"vehicles">) {
  return {
    orgId: seed.orgId,
    vehicleId,
    customerId: seed.customerId,
    salespersonId: seed.userId,
    salePrice: PRICE,
    saleDate: Date.now(),
    quoteId,
  };
}

/** The refusal must NAME the reason, not merely reject. */
const COMMITS_THROUGH_APPLICATION = /finance application|through its application|commits through/i;

describe("SCRUM-69: a financed deal commits through its finance application", () => {
  describe("sales.create", () => {
    test("refuses a configured quote", async () => {
      const seed = await seedDealer("create-cfg");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000001");

      // Asserted against the ACTIONABLE message, not merely the general regex.
      //
      // Mutation testing showed why: neutering the no-application refusal left
      // every door test green, because the next guard down ("this application is
      // no longer open") also throws and its wording also matches the general
      // pattern. The refusal survived, but the operator would have been told the
      // wrong thing — that a live application was closed. Pinning the guidance
      // here keeps the two branches distinguishable.
      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, quoteId, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(/finalize it from the application/i);
    });

    test("refuses a mode-less quote that names a finance company", async () => {
      const seed = await seedDealer("create-modeless");
      const { quoteId, vehicleId } = await modelessFinancedQuote(seed, "BND0000000000002");

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, quoteId, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("sales.createDraft -> sales.completeDraft", () => {
    test("refuses a configured quote", async () => {
      const seed = await seedDealer("draft-cfg");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000003");

      // The refusal may land at either step. What must NOT happen is a
      // COMPLETED sale: a draft that can never be completed is acceptable, a
      // completed one is the defect.
      await expect(
        (async () => {
          const saleId = await seed.asUser.mutation(api.sales.createDraft, {
            ...saleArgs(seed, quoteId, vehicleId),
          });
          await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
        })()
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });

    test("refuses a mode-less quote that names a finance company", async () => {
      const seed = await seedDealer("draft-modeless");
      const { quoteId, vehicleId } = await modelessFinancedQuote(seed, "BND0000000000004");

      await expect(
        (async () => {
          const saleId = await seed.asUser.mutation(api.sales.createDraft, {
            ...saleArgs(seed, quoteId, vehicleId),
          });
          await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
        })()
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("sales.completeFromQuote", () => {
    test("refuses a configured quote", async () => {
      const seed = await seedDealer("cfq-cfg");
      const { quoteId } = await configuredQuote(seed, "BND0000000000005");

      await expect(
        seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });

    test("refuses a mode-less financed quote instead of recording it as CASH", async () => {
      // The worst of the four. `completeFromQuote` checks only for a mode that
      // is PRESENT and non-CASH, so this quote passes and the sale is written
      // down as `financingType: "CASH"` — a financed deal misstated as a cash
      // one, not merely a skipped lifecycle.
      const seed = await seedDealer("cfq-modeless");
      const { quoteId } = await modelessFinancedQuote(seed, "BND0000000000006");

      await expect(
        seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("the boundary derives authority from lifecycle state, not from its caller", () => {
    test("a matching application is NOT enough — missing prerequisites are still refused", async () => {
      // The case that separates a real derivation from a row lookup.
      //
      // This quote HAS its finance application, and it is APPROVED. What it
      // does not have is a registered handover or recorded dealer economics.
      // A boundary that admits the sale because an application exists is not
      // checking lifecycle state, it is checking for a row — and a design that
      // exempted a "trusted caller" flag could never fail this test, which is
      // why it exists.
      const seed = await seedDealer("prereq");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000007");

      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
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

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, quoteId, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);

      // And the application is left intact rather than stranded.
      const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
      expect(app?.status).toBe("APPROVED");
      expect(app?.finalizedSaleId).toBeUndefined();
    });
  });

  describe("the refusal is not widened into a different defect", () => {
    test("an ordinary CASH quote still completes through sales.create", async () => {
      const seed = await seedDealer("cash-create");
      const { quoteId, vehicleId } = await cashQuote(seed, "BND0000000000008");

      const saleId = await seed.asUser.mutation(api.sales.create, {
        ...saleArgs(seed, quoteId, vehicleId),
        status: "COMPLETED" as const,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });

    test("an ordinary CASH quote still completes through the draft path", async () => {
      const seed = await seedDealer("cash-draft");
      const { quoteId, vehicleId } = await cashQuote(seed, "BND0000000000009");

      const saleId = await seed.asUser.mutation(api.sales.createDraft, {
        ...saleArgs(seed, quoteId, vehicleId),
      });
      await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });

    test("an ordinary CASH quote still completes through completeFromQuote", async () => {
      const seed = await seedDealer("cash-cfq");
      const { quoteId } = await cashQuote(seed, "BND0000000000010");

      await seed.asUser.mutation(api.sales.completeFromQuote, { orgId: seed.orgId, quoteId });
      const sales = await seed.t.run((ctx) =>
        ctx.db
          .query("sales")
          .filter((q) => q.eq(q.field("orgId"), seed.orgId))
          .collect()
      );
      expect(sales.some((s) => s.status === "COMPLETED")).toBe(true);
    });

    test("finalizeDeal still completes its own deal through the same boundary", async () => {
      // The authorized path, and the one the boundary must not close. It is
      // authorized because its deal SATISFIES the requirement, not because the
      // caller asserted anything about itself.
      const seed = await seedDealer("finalize");
      const { quoteId } = await configuredQuote(seed, "BND0000000000011");

      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
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

      const saleId = await seed.asUser.mutation(api.applications.finalizeDeal, {
        orgId: seed.orgId,
        applicationId,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });
  });

  describe("a door that omits the quote is still a door", () => {
    // Not in the issue's four. Found by applying comment 12136's own lesson to
    // the next optional field along.
    //
    // That comment established that the boundary cannot key off `applicationId`,
    // because it is optional and the dangerous shape simply omits it. `quoteId`
    // is optional on `sales.create` and `sales.createDraft` for exactly the same
    // reason, so a boundary that resolved the deal THROUGH THE QUOTE would
    // inherit the identical hole: drop the quote and the guard never runs, while
    // the vehicle is still sold and the application still stranded.
    //
    // The harm is a property of the VEHICLE — it is the thing sold out from
    // under a live application — not of whichever argument the caller chose to
    // pass. So the boundary resolves the application from the vehicle.
    test("sales.create refuses a vehicle with a live application even when no quoteId is passed", async () => {
      const seed = await seedDealer("noquote");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000012");

      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });

      const { quoteId: _omitted, ...withoutQuote } = saleArgs(seed, quoteId, vehicleId);
      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...withoutQuote,
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);

      const app = await seed.t.run((ctx) => ctx.db.get(applicationId));
      expect(app?.finalizedSaleId).toBeUndefined();
    });

    test("the draft path refuses it too", async () => {
      const seed = await seedDealer("noquote-draft");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000013");
      await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });

      const { quoteId: _omitted, ...withoutQuote } = saleArgs(seed, quoteId, vehicleId);
      await expect(
        (async () => {
          const saleId = await seed.asUser.mutation(api.sales.createDraft, { ...withoutQuote });
          await seed.asUser.mutation(api.sales.completeDraft, { orgId: seed.orgId, saleId });
        })()
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });

    test("an ordinary walk-in sale with no quote and no application still completes", async () => {
      // The control that stops the vehicle-resolved boundary from becoming "no
      // sale may be completed without a quote", which would be a worse defect
      // than the one being closed.
      const seed = await seedDealer("noquote-cash");
      const vehicleId = await createVehicle(seed.t, seed.orgId, "BND0000000000014");

      const saleId = await seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId,
        customerId: seed.customerId,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });
  });

  describe("each lifecycle prerequisite is load-bearing on its own", () => {
    // Added because mutation testing showed the ones above were not enough.
    //
    // Deleting the APPROVED check, the handover check or the expected-payment
    // check INDIVIDUALLY left all fourteen door tests green. Two reasons, and
    // both matter: the three conjuncts mask each other (the fixture that proved
    // "a matching application is not enough" was missing two prerequisites, so
    // removing either one left the other to refuse it), and more fundamentally
    // no public door can supply an `applicationId` at all — so through the doors
    // the generic no-application refusal fires first and this predicate is never
    // consulted.
    //
    // That is not a reason to drop the predicate. It is the derivation that
    // makes a matching application id identity rather than authority, and it is
    // what a future caller holding an application id will meet. But it has to be
    // pinned where it actually runs, and each conjunct has to be pinned in the
    // direction only that conjunct refuses.
    const ready = {
      status: "APPROVED",
      vehicleHandoverAt: 1,
      expectedPaymentMethod: "CASH",
      expectedPaymentDate: 1,
    } as unknown as Doc<"financeApplications">;

    const except = (override: Record<string, unknown>) =>
      ({ ...ready, ...override }) as unknown as Doc<"financeApplications">;

    test("a deal that satisfies every prerequisite has no gap", () => {
      // Anti-vacuity: without this the three refusals below would be satisfied
      // by a predicate that refused everything, which would block every real
      // financed sale while the suite stayed green.
      expect(financeApplicationCompletionGap(ready)).toBeNull();
    });

    test("an unapproved application is refused even with handover and payment recorded", () => {
      expect(financeApplicationCompletionGap(except({ status: "UNDER_REVIEW" }))).toMatch(
        /has not been approved/i
      );
    });

    test("a missing handover is refused on its own, with the payment already recorded", () => {
      expect(financeApplicationCompletionGap(except({ vehicleHandoverAt: undefined }))).toMatch(
        /handover/i
      );
    });

    test("a missing expected payment is refused on its own, with the handover already registered", () => {
      expect(
        financeApplicationCompletionGap(except({ expectedPaymentMethod: undefined }))
      ).toMatch(/how and when the payment is expected/i);
    });

    test("the boundary actually consults the gap rather than merely finding the row", async () => {
      // The wiring. An application that is this vehicle's, live, and identity-
      // matched — everything a row lookup would accept — but not handed over.
      // Reached by calling the boundary directly, because no public door can
      // supply an applicationId; that is precisely why this branch needs its own
      // test rather than inheriting one from a door.
      const seed = await seedDealer("gap-wiring");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000015");
      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
      await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "APPROVED" }));

      await expect(
        seed.t.run((ctx) =>
          assertFinancedDealCommitsThroughApplication(ctx, {
            orgId: seed.orgId,
            vehicleId,
            customerId: seed.customerId,
            quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: seed.companyId },
            applicationId,
          })
        )
      ).rejects.toThrow(/handover/i);
    });

    test("a finished application cannot authorize a second sale of the same car", async () => {
      // The remaining guard branch, and it was the last uncovered line in the
      // module. A CANCELLED application is not in the live set, so supplying its
      // id resolves to nothing — and "nothing" must refuse rather than fall
      // through. An uncovered branch inside a guard is where the next bypass
      // hides, which is the whole lesson of this issue.
      const seed = await seedDealer("finished-app");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000016");
      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
      await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));

      await expect(
        seed.t.run((ctx) =>
          assertFinancedDealCommitsThroughApplication(ctx, {
            orgId: seed.orgId,
            vehicleId,
            customerId: seed.customerId,
            quote: { mode: "CONFIGURED_FINANCE_COMPANY", companyId: seed.companyId },
            applicationId,
          })
        )
      ).rejects.toThrow(/no longer open/i);
    });

    test("a deal missing its approved purchase amount is refused", async () => {
      // `dealerEconomicsGap` moved here from applications.ts so the finance
      // lifecycle and this boundary cannot grow two definitions of "ready to
      // finalize". Its first branch had no coverage on either side of the move —
      // the move did not lose it, nothing ever exercised it — so it is pinned
      // now rather than left as an untested refusal on a money path.
      const app = {
        submittedQuotationMinor: 100,
        approvedDealerPurchaseAmountMinor: undefined,
        financeCompanyFundedPortionMinor: undefined,
      } as unknown as Doc<"financeApplications">;

      expect(dealerEconomicsGap(app, "finalizing")).toMatch(/approved purchase amount/i);

      // A deal with no submitted quotation is a legacy shape with no economics
      // to check, and must still pass — the anti-vacuity half.
      const legacy = { submittedQuotationMinor: undefined } as unknown as Doc<"financeApplications">;
      expect(dealerEconomicsGap(legacy, "finalizing")).toBeNull();
    });
  });

  describe("the classifier covers every financing mode, not only the two with fixtures", () => {
    // Mutation testing found this hole and the door tests could never have.
    // Flipping `quote.mode !== undefined` to `=== undefined` survived all 21
    // tests, because every fixture coincidentally agrees under that mutant:
    // CONFIGURED falls through to the companyId check and still says true, the
    // mode-less quote returns `undefined !== "CASH"` and still says true, and
    // the cash quote still says false. Under the mutant these three modes flip
    // to NOT financed and the bypass reopens for them silently.
    //
    // MANUAL_FINANCE_COMPANY, INTERNAL_INSTALLMENT and LEASE structurally
    // CANNOT carry a companyId — `quotes.saveQuote` refuses one on any mode but
    // CONFIGURED — so the mode is the only evidence there is for all three.
    test("MANUAL_FINANCE_COMPANY commits through its application", () => {
      expect(quoteCommitsThroughApplication({ mode: "MANUAL_FINANCE_COMPANY" })).toBe(true);
    });

    test("INTERNAL_INSTALLMENT commits through its application even though the dealership is the financier", () => {
      // The discriminator that proves this is NOT `settlementPayer`'s question.
      // There, INTERNAL_INSTALLMENT is correctly `external: false` — nobody
      // outside the dealership pays the supplier. Here it is financed, because
      // the deal still owes the finance-application lifecycle.
      expect(quoteCommitsThroughApplication({ mode: "INTERNAL_INSTALLMENT" })).toBe(true);
    });

    test("LEASE commits through its application", () => {
      expect(quoteCommitsThroughApplication({ mode: "LEASE" })).toBe(true);
    });

    test("CASH does not, and neither does a bare quote", () => {
      expect(quoteCommitsThroughApplication({ mode: "CASH" })).toBe(false);
      expect(quoteCommitsThroughApplication({})).toBe(false);
    });
  });

  describe("financing evidence survives an omitted quote", () => {
    test("a financed quote with NO application yet is not completable by leaving quoteId off", async () => {
      // The widest form of the bypass, and the one every earlier test missed.
      //
      // All the omitted-quote tests above seed an application first, so both
      // signals were present. In the window BEFORE the application is created
      // there is no application to find and no quote passed — so a boundary that
      // reads only those two arguments sees nothing and lets the sale through.
      // The customer's own persisted quotes are the evidence that remains.
      const seed = await seedDealer("prequote");
      const { vehicleId } = await configuredQuote(seed, "BND0000000000017");

      const noApplication = await seed.t.run((ctx) =>
        ctx.db
          .query("financeApplications")
          .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId))
          .first()
      );
      expect(noApplication).toBeNull();

      await expect(
        seed.asUser.mutation(api.sales.create, {
          orgId: seed.orgId,
          vehicleId,
          customerId: seed.customerId,
          salespersonId: seed.userId,
          salePrice: PRICE,
          saleDate: Date.now(),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(COMMITS_THROUGH_APPLICATION);
    });
  });

  describe("a rejected application still holds the car, because rejection is reopenable", () => {
    test("a REJECTED application refuses the cash sale rather than letting it through", async () => {
      // `applications.ts` permits REJECTED -> PENDING_DOCS. Treating rejection
      // as terminal let the car sell and the application then reopen onto a SOLD
      // vehicle, where it can never finalize. Only CLOSED and CANCELLED end an
      // application's claim.
      const seed = await seedDealer("rejected");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000018");
      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
      await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "REJECTED" }));

      const cash = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, cash, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(/cancel that application first/i);
    });

    test("a CANCELLED application genuinely releases the car", async () => {
      // The other side, so the previous test cannot be satisfied by a guard that
      // simply refuses on any application at all.
      const seed = await seedDealer("cancelled-releases");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000019");
      const applicationId = await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });
      await seed.t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));

      const cash = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });

      const saleId = await seed.asUser.mutation(api.sales.create, {
        ...saleArgs(seed, cash, vehicleId),
        status: "COMPLETED" as const,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });
  });

  describe("one customer's application does not lock the car against everyone else", () => {
    test("another customer's live application does not block an ordinary cash sale", async () => {
      // Keying the lookup on the vehicle ALONE made one abandoned application
      // lock that car permanently — nothing expires a finance application — and
      // refused an unrelated walk-in buyer while telling the operator the deal
      // was "financed" when it was not.
      const seed = await seedDealer("other-customer");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000020");
      await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });

      const otherCustomerId = await seed.t.run((ctx) =>
        ctx.db.insert("customers", { orgId: seed.orgId, firstName: "Walk", lastName: "In" })
      );

      const saleId = await seed.asUser.mutation(api.sales.create, {
        orgId: seed.orgId,
        vehicleId,
        customerId: otherCustomerId,
        salespersonId: seed.userId,
        salePrice: PRICE,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
      });
      const sale = await seed.t.run((ctx) => ctx.db.get(saleId));
      expect(sale?.status).toBe("COMPLETED");
    });

    test("the SAME customer's live application does block, and names the remedy", async () => {
      // The other half. Cancelling is not a status flip — it releases the
      // vehicle hold and unwinds the deal — so a cash sale must not simply step
      // around it. The message has to name that, because "quote the deal as
      // cash" is already true here and fixes nothing.
      const seed = await seedDealer("same-customer");
      const { quoteId, vehicleId } = await configuredQuote(seed, "BND0000000000021");
      await seed.asUser.mutation(api.applications.createFromQuote, {
        orgId: seed.orgId,
        quoteId,
      });

      const cash = await seed.asUser.mutation(api.quotes.saveQuote, {
        orgId: seed.orgId,
        customerId: seed.customerId,
        vehicleId,
        mode: "CASH",
        vehiclePrice: PRICE,
        downPayment: 0,
        termMonths: 0,
        totalFinancedAmount: 0,
      });

      await expect(
        seed.asUser.mutation(api.sales.create, {
          ...saleArgs(seed, cash, vehicleId),
          status: "COMPLETED" as const,
        })
      ).rejects.toThrow(/cancel that application first/i);
    });
  });
});
