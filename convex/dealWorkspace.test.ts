import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;

const MODULES = import.meta.glob("./**/*.*s");

/**
 * The financed cockpit read model.
 *
 * Every assertion here is about the WRAPPER's relationship to
 * `applications.dealCockpit`, not about the cockpit's own contents — that query
 * remains authoritative for its whole payload and has its own suites. What is
 * new, and therefore what is tested, is: the two added fields, and the promise
 * that nothing else moved.
 *
 * Change control over the protected sources is a separate concern and lives in
 * `scripts/protectedSourcePins.test.ts`, which pins their exact reviewed
 * content. That test proves only that those files have not changed — it makes
 * no claim about behaviour, which is what the assertions here are for.
 */
describe("dealWorkspace.financedDealCockpit", () => {
  interface Seed {
    t: TestConvex;
    orgId: Id<"organizations">;
    otherOrgId: Id<"organizations">;
    userId: Id<"users">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    quoteId: Id<"quotes">;
    asOwner: AuthenticatedTestConvex;
  }

  async function seed(suffix = "1"): Promise<Seed> {
    const t = convexTestWithComponents(schema, MODULES);

    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `DW Dealer ${suffix}`, createdAt: Date.now() })
    );
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `DW Other ${suffix}`, createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: `dw_owner_${suffix}`,
        email: `dw.owner${suffix}@example.com`,
        name: "DW Owner",
      })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "OWNER",
        permissions: ALL_PERMISSIONS,
        isSystemOwnerRole: true,
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "DW", lastName: "Customer" })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `DWVIN${suffix}`,
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        purchasePrice: 9_500,
        sellingPrice: 10_500,
        status: "AVAILABLE",
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 10_500,
        downPayment: 500,
        termMonths: 60,
        status: "ACCEPTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );

    return {
      t,
      orgId,
      otherOrgId,
      userId,
      customerId,
      vehicleId,
      quoteId,
      asOwner: t.withIdentity({ subject: `dw_owner_${suffix}` }),
    };
  }

  async function insertApplication(
    s: Seed,
    status: "APPROVED" | "REJECTED" | "CANCELLED",
    orgId: Id<"organizations"> = s.orgId
  ): Promise<Id<"financeApplications">> {
    return await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  /** A deposit still HELD against the quote: real cash with no disposition. */
  async function insertHeldDeposit(s: Seed): Promise<Id<"deposits">> {
    return await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        amount: 500,
        status: "HELD",
        holdActive: true,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );
  }

  /** A permissioned caller, so the authorization assertions use real roles. */
  async function callerWith(
    s: Seed,
    tag: string,
    permissions: string[]
  ): Promise<AuthenticatedTestConvex> {
    const userId = await s.t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: `dw_${tag}`,
        email: `dw.${tag}@example.com`,
        name: tag,
      })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: s.orgId, name: tag, permissions })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    return s.t.withIdentity({ subject: `dw_${tag}` });
  }

  // --- the one field the wrapper adds --------------------------------------

  test("a rejected deal still holding a HELD deposit reports pendingDepositResolution", async () => {
    const s = await seed();
    const applicationId = await insertApplication(s, "REJECTED");
    await insertHeldDeposit(s);

    const view = await s.asOwner.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    expect(view?.pendingDepositResolution).toBe(true);
  });

  test("a cancelled deal holding a HELD deposit reports it too", async () => {
    const s = await seed();
    const applicationId = await insertApplication(s, "CANCELLED");
    await insertHeldDeposit(s);

    const view = await s.asOwner.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    expect(view?.pendingDepositResolution).toBe(true);
  });

  test("a live deal is not pending deposit resolution, even holding a deposit", async () => {
    const s = await seed();
    const applicationId = await insertApplication(s, "APPROVED");
    await insertHeldDeposit(s);

    const view = await s.asOwner.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    // The rule is REJECTED/CANCELLED *and* held money. An approved deal holding
    // a deposit is a deal in progress, not money nobody has decided about.
    expect(view?.pendingDepositResolution).toBe(false);
  });

  test("a rejected deal with no held deposit is not pending resolution", async () => {
    const s = await seed();
    const applicationId = await insertApplication(s, "REJECTED");

    const view = await s.asOwner.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    expect(view?.pendingDepositResolution).toBe(false);
  });

  // --- not-found / wrong-org is the cockpit's own behaviour ----------------

  test("an application belonging to another org returns null, as the cockpit does", async () => {
    const s = await seed();
    const foreignApplicationId = await insertApplication(s, "APPROVED", s.otherOrgId);

    const wrapped = await s.asOwner.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId: foreignApplicationId,
    });
    const direct = await s.asOwner.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId: foreignApplicationId,
    });

    // Null for the SAME reason, so the wrapper cannot become a second,
    // differently-behaved door onto another tenant's deal.
    expect(direct).toBeNull();
    expect(wrapped).toBeNull();
  });

  // --- the wrapper widens nothing ------------------------------------------

  test("a sales-only caller still gets money: null, unchanged by the wrapper", async () => {
    const s = await seed();
    const applicationId = await insertApplication(s, "APPROVED");
    const asSales = await callerWith(s, "salesonly", ["view:sales"]);

    const wrapped = await asSales.query(api.dealWorkspace.financedDealCockpit, {
      orgId: s.orgId,
      applicationId,
    });
    const direct = await asSales.query(api.applications.dealCockpit, {
      orgId: s.orgId,
      applicationId,
    });

    expect(direct?.money).toBeNull();
    expect(wrapped?.money).toBeNull();
  });

  test("an unauthorized caller is refused by the wrapper as by the cockpit", async () => {
    const s = await seed();
    const applicationId = await insertApplication(s, "APPROVED");
    const asNobody = await callerWith(s, "nobody", []);

    await expect(
      asNobody.query(api.dealWorkspace.financedDealCockpit, {
        orgId: s.orgId,
        applicationId,
      })
    ).rejects.toThrow();
  });

  test.each([
    ["owner", ALL_PERMISSIONS],
    ["salesonly", ["view:sales"]],
  ])(
    "for a %s caller the wrapper returns the cockpit payload plus exactly one new key",
    async (tag, permissions) => {
      const s = await seed();
      const applicationId = await insertApplication(s, "REJECTED");
      await insertHeldDeposit(s);
      const caller = await callerWith(s, `equiv${tag}`, [...permissions]);

      const direct = await caller.query(api.applications.dealCockpit, {
        orgId: s.orgId,
        applicationId,
      });
      const wrapped = await caller.query(api.dealWorkspace.financedDealCockpit, {
        orgId: s.orgId,
        applicationId,
      });

      expect(direct).not.toBeNull();
      expect(wrapped).not.toBeNull();

      // The added keys, and ONLY those.
      const added = Object.keys(wrapped!).filter((k) => !(k in direct!));
      expect(added.sort()).toEqual(["activeAppraisalProvider", "pendingDepositResolution"]);

      // And every pre-existing field is identical — this is what makes "the
      // cockpit stays authoritative" a checked claim rather than a comment.
      // Compared after removing the new keys so a future added field fails HERE
      // rather than silently passing.
      const {
        pendingDepositResolution: _flag,
        activeAppraisalProvider: _provider,
        ...rest
      } = wrapped!;
      expect(rest).toEqual(direct);
    }
  );

  /**
   * Whose move the APPRAISAL stage is.
   *
   * The rail treats APPRAISAL as an EXTERNAL stage and the screen rendered every
   * external stage as the finance company's work — while the stage's own
   * definition says it may be valued by the finance company OR an independent
   * appraiser. A deal appraised independently therefore told the operator it was
   * waiting on the finance company. These pin the server side of that fix: the
   * answer comes from recorded provenance, and where provenance does not exist
   * the answer is "unknown", never a guess.
   */
  describe("who actually valued the car", () => {
    async function insertAppraisal(
      s: Seed,
      applicationId: Id<"financeApplications">,
      providerType: "FINANCE_COMPANY" | "INDEPENDENT" | "DEALER_ESTIMATE",
      status: "RECORDED" | "APPROVED" | "SUPERSEDED" | "REJECTED" = "RECORDED",
      appraisedAt: number = Date.now()
    ): Promise<void> {
      await s.t.run((ctx) =>
        ctx.db.insert("financeAppraisals", {
          orgId: s.orgId,
          applicationId,
          vehicleId: s.vehicleId,
          appraisalAmountMinor: 10_000_00,
          currency: "JOD",
          providerType,
          appraisedAt,
          isReappraisal: false,
          status,
          recordedBy: s.userId,
          recordedAt: appraisedAt,
        })
      );
    }

    const providerFor = async (s: Seed, applicationId: Id<"financeApplications">) =>
      (
        await s.asOwner.query(api.dealWorkspace.financedDealCockpit, {
          orgId: s.orgId,
          applicationId,
        })
      )?.activeAppraisalProvider;

    test("a finance-company appraisal is still reported as the finance company", async () => {
      const s = await seed("fc");
      const applicationId = await insertApplication(s, "APPROVED");
      await insertAppraisal(s, applicationId, "FINANCE_COMPANY");
      expect(await providerFor(s, applicationId)).toBe("FINANCE_COMPANY");
    });

    test("an independent appraisal is NOT reported as the finance company", async () => {
      const s = await seed("ind");
      const applicationId = await insertApplication(s, "APPROVED");
      await insertAppraisal(s, applicationId, "INDEPENDENT");
      expect(await providerFor(s, applicationId)).toBe("INDEPENDENT");
    });

    test("a deal with no appraisal at all invents no owner", async () => {
      const s = await seed("none");
      const applicationId = await insertApplication(s, "APPROVED");
      expect(await providerFor(s, applicationId)).toBeNull();
    });

    test("a dealer estimate is not an appraisal, and names no appraiser", async () => {
      // An estimate is explicitly not an appraisal — an approval refuses it —
      // so it must not be presented as either party's valuation.
      const s = await seed("est");
      const applicationId = await insertApplication(s, "APPROVED");
      await insertAppraisal(s, applicationId, "DEALER_ESTIMATE");
      expect(await providerFor(s, applicationId)).toBeNull();
    });

    test("a superseded appraisal does not answer for the one that replaced it", async () => {
      // History is append-only here: a reappraisal supersedes its predecessor.
      // The newest SURVIVING row is the live one, so an older finance-company
      // appraisal must not speak for a newer independent one.
      const s = await seed("sup");
      const applicationId = await insertApplication(s, "APPROVED");
      await insertAppraisal(s, applicationId, "FINANCE_COMPANY", "SUPERSEDED", 1_000);
      await insertAppraisal(s, applicationId, "INDEPENDENT", "RECORDED", 2_000);
      expect(await providerFor(s, applicationId)).toBe("INDEPENDENT");
    });

    test("provenance from another org's rows never reaches this deal", async () => {
      const s = await seed("xorg");
      const applicationId = await insertApplication(s, "APPROVED");
      await s.t.run((ctx) =>
        ctx.db.insert("financeAppraisals", {
          orgId: s.otherOrgId,
          applicationId,
          vehicleId: s.vehicleId,
          appraisalAmountMinor: 10_000_00,
          currency: "JOD",
          providerType: "INDEPENDENT",
          appraisedAt: Date.now(),
          isReappraisal: false,
          status: "RECORDED",
          recordedBy: s.userId,
          recordedAt: Date.now(),
        })
      );
      expect(await providerFor(s, applicationId)).toBeNull();
    });
  });
});
