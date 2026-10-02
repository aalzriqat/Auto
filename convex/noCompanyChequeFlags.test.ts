import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-447 x SCRUM-446 composition.
 *
 * Invariant: every disbursement- or cheque-actionability flag `dealCockpit`
 * projects agrees with the server's RESOLVED financier leg (the same
 * `resolveFinancierLeg` `confirmDisbursement` uses). When the leg is NONE (a
 * closed, company-less internal instalment) nobody is owed a disbursement, so
 * no flag may offer registering, attesting, re-registering or confirming one;
 * the only allowed action is `expectedPaymentCorrectable` — clearing a legacy
 * registered method is the documented exit. A configured company is untouched.
 *
 * Every case drives the REAL `dealCockpit` query and the REAL mutations.
 */
describe("SCRUM-447/446: cheque and disbursement flags agree with the resolved financier leg", () => {
  interface Seed {
    t: TestConvex;
    orgId: Id<"organizations">;
    userId: Id<"users">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    quoteId: Id<"quotes">;
    asOwner: ReturnType<TestConvex["withIdentity"]>;
  }

  async function seed(tag: string): Promise<Seed> {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `NC ${tag}`, createdAt: Date.now() }));
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `nc_${tag}`, email: `nc.${tag}@example.com`, name: "NC Owner" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "NC", lastName: "Customer" })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `NCVIN${tag}`,
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 10_500,
        status: "SOLD",
        sourceType: "STOCK" as const,
        purchasePrice: 9_500,
        landedCostTotal: 100,
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
    return { t, orgId, userId, customerId, vehicleId, quoteId, asOwner: t.withIdentity({ subject: `nc_${tag}` }) };
  }

  interface DealOpts {
    /** A configured finance company on the application. */
    configured?: boolean;
    status?: "APPROVED" | "CLOSED";
    mode?: "INTERNAL_INSTALLMENT" | "CONFIGURED_FINANCE_COMPANY" | "MANUAL_FINANCE_COMPANY";
  }

  async function insertDeal(s: Seed, opts: DealOpts = {}) {
    const status = opts.status ?? "CLOSED";
    const mode = opts.mode ?? (opts.configured ? "CONFIGURED_FINANCE_COMPANY" : "INTERNAL_INSTALLMENT");
    const companyId = opts.configured
      ? await s.t.run((ctx) =>
          ctx.db.insert("financeCompanies", {
            orgId: s.orgId,
            name: "Configured Finance",
            profitRate: 5,
            maxTermMonths: 60,
            gracePeriodMonths: 0,
            isActive: true,
            adminFees: 0,
            defaultLtvPercent: 100,
          })
        )
      : undefined;
    const finalizedSaleId =
      status === "CLOSED"
        ? await s.t.run((ctx) =>
            ctx.db.insert("sales", {
              orgId: s.orgId,
              vehicleId: s.vehicleId,
              customerId: s.customerId,
              salespersonId: s.userId,
              salePrice: 10_500,
              saleDate: Date.now(),
              status: "COMPLETED",
              financingType: "FINANCED",
            })
          )
        : undefined;
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status,
        quoteModeAtSubmission: mode,
        ...(companyId ? { companyId } : {}),
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 12_000_000,
        approvedDealerPurchaseAmountMinor: 11_000_000,
        financeCompanyFundedPortionMinor: 9_350_000,
        dealerContributionMinor: 1_650_000,
        vehicleHandoverAt: Date.now(),
        ...(finalizedSaleId ? { finalizedSaleId } : {}),
        ...(status === "CLOSED"
          ? { handoverStatus: "HANDED_OVER" as const, settlementStatus: "EXPECTED" as const }
          : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    // SCRUM-567: the leg only trusts a sale that names this application back (as `completeSale` writes it).
    if (finalizedSaleId) await s.t.run((ctx) => ctx.db.patch(finalizedSaleId, { applicationId }));
    return { applicationId, companyId };
  }

  /** The pre-SCRUM-447 shape: method registered, a HELD cheque with NO recorded face. */
  async function seedLegacyHeldCheque(s: Seed, applicationId: Id<"financeApplications">) {
    const now = Date.now();
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        expectedPaymentMethod: "CHEQUE",
        expectedPaymentDate: now,
        expectedPaymentRegisteredAt: now,
      })
    );
    return s.t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId: s.orgId,
        customerId: s.customerId,
        applicationId,
        bank: "Arab Bank",
        chequeNumber: "LEGACY-1",
        chequeDate: now,
        amount: 10_500,
        status: "HELD",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      })
    );
  }

  async function cockpit(s: Seed, applicationId: Id<"financeApplications">) {
    const view = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    if (!view) throw new Error("no cockpit");
    return view;
  }

  async function chequeRows(s: Seed, applicationId: Id<"financeApplications">) {
    return s.t.run((ctx) =>
      ctx.db
        .query("postDatedCheques")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect()
    );
  }

  test("(a) a closed no-company deal with nothing registered is NOT re-registrable (the leg is NONE)", async () => {
    const s = await seed("a");
    const { applicationId } = await insertDeal(s);
    const view = await cockpit(s, applicationId);
    expect(view.stages.find((st) => st.key === "DISBURSEMENT")?.state).toBe("NOT_APPLICABLE");
    expect(view.expectedPaymentReRegistrable).toBe(false);
  });

  test("(b) the same deal after correctExpectedPayment is still not re-registrable", async () => {
    const s = await seed("b");
    const { applicationId } = await insertDeal(s);
    await seedLegacyHeldCheque(s, applicationId);
    await s.asOwner.mutation(api.applications.correctExpectedPayment, {
      orgId: s.orgId,
      applicationId,
      reason: "clear the legacy registration",
    });
    const view = await cockpit(s, applicationId);
    expect(view.expectedPaymentReRegistrable).toBe(false);
    expect(view.chequePaymentRegistered).toBe(false);
  });

  test("(c) a legacy no-company HELD cheque with no face offers no attest / correction-notice; clearing it stays possible", async () => {
    const s = await seed("c");
    const { applicationId } = await insertDeal(s);
    await seedLegacyHeldCheque(s, applicationId);
    const view = await cockpit(s, applicationId);
    expect(view.chequeFaceUnrecorded).toBe(false);
    expect(view.unattestedChequeId).toBeNull();
    expect(view.chequeNeedsCorrection).toBe(false);
    expect(view.expectedPaymentReRegistrable).toBe(false);
    // The documented exit: the registered method can still be cleared.
    expect(view.expectedPaymentCorrectable).toBe(true);
    expect(view.chequePaymentRegistered).toBe(true);
  });

  test("(c2) a legacy no-company row whose HELD cheque was RETURNED offers no correction notice either", async () => {
    const s = await seed("c2");
    const { applicationId } = await insertDeal(s);
    const chequeId = await seedLegacyHeldCheque(s, applicationId);
    await s.t.run((ctx) => ctx.db.patch(chequeId, { status: "RETURNED" }));
    const view = await cockpit(s, applicationId);
    expect(view.chequeNeedsCorrection).toBe(false);
    expect(view.expectedPaymentReRegistrable).toBe(false);
    expect(view.expectedPaymentCorrectable).toBe(true);
  });

  test("(d) CONTROL: a configured-company closed, undisbursed deal keeps every flag", async () => {
    const s = await seed("d");
    const { applicationId } = await insertDeal(s, { configured: true });
    const empty = await cockpit(s, applicationId);
    expect(empty.expectedPaymentReRegistrable).toBe(true);

    await seedLegacyHeldCheque(s, applicationId);
    const legacy = await cockpit(s, applicationId);
    expect(legacy.chequeFaceUnrecorded).toBe(true);
    expect(legacy.unattestedChequeId).not.toBeNull();
    expect(legacy.expectedPaymentReRegistrable).toBe(false);
    expect(legacy.expectedPaymentCorrectable).toBe(true);

    const [row] = await chequeRows(s, applicationId);
    await s.t.run((ctx) => ctx.db.patch(row._id, { status: "RETURNED" }));
    const returned = await cockpit(s, applicationId);
    expect(returned.chequeNeedsCorrection).toBe(true);
  });

  test("(g) BOUNDARY: a no-company deal whose leg is UNKNOWN (manual finance company) keeps today's flags", async () => {
    const s = await seed("g");
    const { applicationId } = await insertDeal(s, { mode: "MANUAL_FINANCE_COMPANY" });
    const view = await cockpit(s, applicationId);
    expect(view.stages.find((st) => st.key === "DISBURSEMENT")?.state).not.toBe("NOT_APPLICABLE");
    expect(view.expectedPaymentReRegistrable).toBe(true);
  });

  test("(h) a CLEARED cheque on a leg-NONE deal is still surfaced for accounting review (safety signal is not gated)", async () => {
    const s = await seed("h");
    const { applicationId } = await insertDeal(s);
    const chequeId = await seedLegacyHeldCheque(s, applicationId);
    await s.t.run((ctx) => ctx.db.patch(chequeId, { status: "CLEARED", clearedAt: Date.now() }));
    const view = await cockpit(s, applicationId);
    expect(view.chequeNeedsAccountingReview).toBe(true);
    expect(view.chequeNeedsCorrection).toBe(false);
  });
  for (const status of ["APPROVED", "CLOSED"] as const) {
    test(`(e) registerExpectedPayment CHEQUE on a no-company ${status} deal is refused and inserts no cheque`, async () => {
      const s = await seed(`e_${status}`);
      const { applicationId } = await insertDeal(s, { status });
      await expect(
        s.asOwner.mutation(api.applications.registerExpectedPayment, {
          orgId: s.orgId,
          applicationId,
          method: "CHEQUE",
          expectedDate: Date.now(),
          chequeDetails: { bank: "Arab Bank", chequeNumber: "CHQ-NC-1" },
          faceAmount: "10500",
        })
      ).rejects.toThrow(/needs a finance company on the deal/i);
      expect(await chequeRows(s, applicationId)).toHaveLength(0);
      const app = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(app?.expectedPaymentMethod).toBeUndefined();
    });
  }
});
