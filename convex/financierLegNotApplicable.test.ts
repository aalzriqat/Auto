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
 * SCRUM-446 — the financier leg of a closed deal that has NO finance company.
 *
 * Invariant: DISBURSEMENT is NOT_APPLICABLE only when the server proves that the
 * application is CLOSED, its linked sale exists and is COMPLETED, that sale
 * settled THROUGH the dealership, and the application carries no `companyId`
 * (so no finance-company receivable was ever opened). Anything unreadable is
 * UNKNOWN and keeps today's behaviour.
 *
 * Every case drives the REAL cockpit and overview queries: a test that handed
 * `financierLeg: NONE` straight to `deriveDealStages` would pass against a
 * server that never derives the fact.
 */
describe("SCRUM-446: the financier leg of a deal nobody finances through a company", () => {
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
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: `FL ${tag}`, createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `fl_${tag}`, email: `fl.${tag}@example.com`, name: "FL Owner" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "FL", lastName: "Customer" })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `FLVIN${tag}`,
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
    return { t, orgId, userId, customerId, vehicleId, quoteId, asOwner: t.withIdentity({ subject: `fl_${tag}` }) };
  }

  type Mode = "CONFIGURED_FINANCE_COMPANY" | "MANUAL_FINANCE_COMPANY" | "LEASE" | "INTERNAL_INSTALLMENT";

  interface DealOpts {
    mode?: Mode;
    /** A configured finance company on the application. */
    configured?: boolean;
    status?: "APPROVED" | "CLOSED";
    /** `none`: the application names no sale. `deleted`: it names one that cannot be loaded. */
    sale?: "COMPLETED" | "CANCELLED" | "none" | "deleted";
    route?: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
    /** Legacy row: no lifecycle dimension recorded. */
    legacy?: boolean;
    /** Record and reconcile a zero dealer cost line BEFORE the deal closes (closing refuses new costs). */
    reconciledFee?: boolean;
  }

  async function insertDeal(s: Seed, opts: DealOpts = {}) {
    const mode = opts.mode ?? "MANUAL_FINANCE_COMPANY";
    const status = opts.status ?? "CLOSED";
    const saleKind = opts.sale ?? "COMPLETED";
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

    let finalizedSaleId: Id<"sales"> | undefined;
    if (saleKind === "COMPLETED" || saleKind === "CANCELLED" || saleKind === "deleted") {
      finalizedSaleId = await s.t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: s.orgId,
          vehicleId: s.vehicleId,
          customerId: s.customerId,
          salespersonId: s.userId,
          salePrice: 10_500,
          saleDate: Date.now(),
          status: saleKind === "CANCELLED" ? "CANCELLED" : "COMPLETED",
          financingType: mode === "LEASE" ? "LEASE" : "FINANCED",
          ...(opts.route ? { supplierSettlementRoute: opts.route } : {}),
        })
      );
      if (saleKind === "deleted") {
        const id = finalizedSaleId;
        await s.t.run((ctx) => ctx.db.delete(id));
      }
    }

    const closedFields = {
      status,
      ...(finalizedSaleId ? { finalizedSaleId } : {}),
      ...(status === "CLOSED" && !opts.legacy
        ? { handoverStatus: "HANDED_OVER" as const, settlementStatus: "EXPECTED" as const }
        : {}),
    };
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status: opts.reconciledFee ? ("APPROVED" as const) : status,
        quoteModeAtSubmission: mode,
        ...(companyId ? { companyId } : {}),
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 12_000_000,
        approvedDealerPurchaseAmountMinor: 11_000_000,
        financeCompanyFundedPortionMinor: 9_350_000,
        dealerContributionMinor: 1_650_000,
        ...(opts.route ? { supplierSettlementRoute: opts.route } : {}),
        ...(opts.reconciledFee ? {} : closedFields),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    if (opts.reconciledFee) {
      await reconcileZeroFee(s, applicationId);
      await s.t.run((ctx) => ctx.db.patch(applicationId, closedFields));
    }
    return { applicationId, finalizedSaleId };
  }

  async function reconcileZeroFee(s: Seed, applicationId: Id<"financeApplications">) {
    const feeId = await s.asOwner.mutation(api.financeDealCosts.recordDealFee, {
      orgId: s.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      deductedFromSettlement: false,
      actualAmountMinor: 0,
      description: "No closing costs.",
      expectedCurrency: "JOD",
      idempotencyKey: crypto.randomUUID(),
    });
    await s.asOwner.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId,
      feeId,
      notes: "Nothing to match.",
    });
  }

  async function stagesOf(s: Seed, applicationId: Id<"financeApplications">) {
    const view = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    const stage = (key: string) => view!.stages.find((st) => st.key === key)!;
    return { view: view!, disbursement: stage("DISBURSEMENT"), settlement: stage("SETTLEMENT"), all: view!.stages };
  }

  async function profitOf(s: Seed, applicationId: Id<"financeApplications">) {
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    return view!.financialSummary!.profit;
  }

  // ── 1. the population the defect is about ────────────────────────────────
  describe.each<{ name: string; mode: Mode }>([
    { name: "a manual finance company", mode: "MANUAL_FINANCE_COMPANY" },
    { name: "a lease", mode: "LEASE" },
    { name: "an internal instalment", mode: "INTERNAL_INSTALLMENT" },
  ])("$name, closed through the dealership with a completed sale", ({ mode }) => {
    test("DISBURSEMENT is NOT_APPLICABLE, never blocked and never complete", async () => {
      const s = await seed(`na_${mode}`);
      const { applicationId } = await insertDeal(s, { mode });
      const { disbursement, all } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("NOT_APPLICABLE");
      expect(disbursement.blocker).toBeUndefined();
      // Nothing on the rail is waiting on a finance company.
      expect(all.some((st) => st.state === "BLOCKED" && st.blocker === "AwaitingDisbursement")).toBe(false);
    });

    test("SETTLEMENT completes on the supplier obligation, and profit is ACTUAL once expenses reconcile", async () => {
      const s = await seed(`settle_${mode}`);
      // Money settles on the supplier obligation alone; profit is ACTUAL only
      // once the dealer-borne cost lines are reconciled too.
      const unreconciled = await insertDeal(s, { mode });
      expect((await stagesOf(s, unreconciled.applicationId)).settlement.state).toBe("COMPLETE");
      const before = await profitOf(s, unreconciled.applicationId);
      if (!before.available || before.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected an estimate");
      expect(before.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");

      const { applicationId } = await insertDeal(s, { mode, reconciledFee: true });
      expect((await stagesOf(s, applicationId)).settlement.state).toBe("COMPLETE");
      const after = await profitOf(s, applicationId);
      if (!after.available || after.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected an estimate");
      expect(after.classification).toBe("ACTUAL_UNPOSTABLE");
      // The label keeps its meaning: management figure, not a posting.
      expect(after.postable).toBe(false);
    });
  });

  test("the unnamed manual finance company case reaches the same verdict as a named one", async () => {
    const s = await seed("unnamed");
    const { applicationId } = await insertDeal(s, { mode: "MANUAL_FINANCE_COMPANY" });
    await s.t.run((ctx) => ctx.db.patch(applicationId, { manualFinanceSnapshot: undefined }));
    expect((await stagesOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE");
  });

  test("a legacy row with no lifecycle dimensions recorded reads the same", async () => {
    const s = await seed("legacy");
    const { applicationId } = await insertDeal(s, { legacy: true });
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).toBe("NOT_APPLICABLE");
    expect(settlement.state).toBe("COMPLETE");
  });

  test("reading twice gives the same answer and writes nothing", async () => {
    const s = await seed("twice");
    const { applicationId } = await insertDeal(s);
    const before = await s.t.run((ctx) => ctx.db.get(applicationId));
    const a = await stagesOf(s, applicationId);
    const b = await stagesOf(s, applicationId);
    expect(b.all).toEqual(a.all);
    expect(await s.t.run((ctx) => ctx.db.get(applicationId))).toEqual(before);
  });

  // ── 2. before the deal closes, nothing is inapplicable ───────────────────
  test("the same deal before it closes has no NOT_APPLICABLE stage and no settled money", async () => {
    const s = await seed("preclose");
    const { applicationId } = await insertDeal(s, { status: "APPROVED", sale: "none" });
    const { all, settlement } = await stagesOf(s, applicationId);
    expect(all.some((st) => st.state === "NOT_APPLICABLE")).toBe(false);
    expect(settlement.state).not.toBe("COMPLETE");
    const profit = await profitOf(s, applicationId);
    if (profit.available && profit.basis === "MANAGEMENT_ESTIMATE") {
      expect(profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
    }
  });

  // ── 3. a sale cancelled after the application closed ─────────────────────
  test("a sale cancelled while the application stays CLOSED is not settled and has no profit", async () => {
    const s = await seed("cancelled");
    const { applicationId } = await insertDeal(s, { sale: "CANCELLED", reconciledFee: true });
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).not.toBe("NOT_APPLICABLE");
    expect(settlement.state).not.toBe("COMPLETE");
    // The stock headline must honour the linked sale's cancellation, not only
    // the application's own status.
    const profit = await profitOf(s, applicationId);
    expect(profit).toEqual({ available: false, reason: "DealCancelled" });
  });

  // ── 4. missing evidence is UNKNOWN, and UNKNOWN keeps today's behaviour ──
  test("a linked sale that cannot be loaded is UNKNOWN: the stage keeps waiting, settlement is not complete", async () => {
    const s = await seed("missingsale");
    const { applicationId } = await insertDeal(s, { sale: "deleted" });
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).not.toBe("NOT_APPLICABLE");
    expect(disbursement.state).toBe("BLOCKED");
    expect(settlement.state).not.toBe("COMPLETE");
  });

  test("a closed application that names no sale at all is UNKNOWN too", async () => {
    const s = await seed("nosale");
    const { applicationId } = await insertDeal(s, { sale: "none" });
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).not.toBe("NOT_APPLICABLE");
    expect(settlement.state).not.toBe("COMPLETE");
  });

  test("a sale belonging to another org is missing evidence, not proof", async () => {
    const s = await seed("wrongorg");
    const { applicationId, finalizedSaleId } = await insertDeal(s);
    // Control: the sale in its own org proves the verdict.
    expect((await stagesOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE");
    // Re-home the sale to another org: the application still NAMES it, but it is
    // no longer evidence about this deal.
    const foreignOrgId = await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "FL foreign", createdAt: Date.now() })
    );
    await s.t.run((ctx) => ctx.db.patch(finalizedSaleId!, { orgId: foreignOrgId }));
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).not.toBe("NOT_APPLICABLE");
    expect(settlement.state).not.toBe("COMPLETE");
  });
  // ── 5-7. controls: the paths this change must not touch ──────────────────
  test("control: a configured finance company still waits on confirmDisbursement", async () => {
    const s = await seed("configured");
    const { applicationId } = await insertDeal(s, { mode: "CONFIGURED_FINANCE_COMPANY", configured: true });
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).toBe("BLOCKED");
    expect(disbursement.blocker).toBe("AwaitingDisbursement");
    expect(settlement.state).not.toBe("COMPLETE");
  });

  test("control: the direct route still waits on the supplier confirmation", async () => {
    const s = await seed("direct");
    const { applicationId } = await insertDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    const { disbursement } = await stagesOf(s, applicationId);
    expect(disbursement.state).toBe("BLOCKED");
    expect(disbursement.blocker).toBe("AwaitingDisbursement");
    // ...and completes on the supplier confirmation, exactly as before.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { supplierDisbursementConfirmedAt: Date.now() }));
    expect((await stagesOf(s, applicationId)).disbursement.state).toBe("COMPLETE");
  });

  test("control: a configured zero-net deal (SCRUM-315) is unchanged", async () => {
    const s = await seed("zeronet");
    const { applicationId } = await insertDeal(s, { mode: "CONFIGURED_FINANCE_COMPANY", configured: true });
    await s.t.run((ctx) => ctx.db.patch(applicationId, { financedSaleNetReceivableMinor: 0 }));
    const { disbursement, settlement } = await stagesOf(s, applicationId);
    expect(disbursement.state).toBe("BLOCKED");
    expect(settlement.state).not.toBe("COMPLETE");
  });

  // ── 8. the action and the rail agree ─────────────────────────────────────
  test("confirmDisbursement on a deal the rail calls NOT_APPLICABLE still refuses, saying why", async () => {
    const s = await seed("refuse");
    const { applicationId } = await insertDeal(s);
    expect((await stagesOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE");
    await expect(
      s.asOwner.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: 1_000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/no finance company pays the dealership/i);
    const after = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.disbursedAt).toBeUndefined();
  });

  test("confirmDisbursement on an UNKNOWN deal keeps refusing", async () => {
    const s = await seed("refuseunknown");
    const { applicationId } = await insertDeal(s, { sale: "deleted" });
    await expect(
      s.asOwner.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId,
        applicationId,
        disbursedAmountMinor: 1_000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow();
  });
});
