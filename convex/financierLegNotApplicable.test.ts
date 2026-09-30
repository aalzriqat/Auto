import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
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

  type FinancedMode = "CONFIGURED_FINANCE_COMPANY" | "MANUAL_FINANCE_COMPANY" | "LEASE" | "INTERNAL_INSTALLMENT";
  /** `NONE`: a mode-less application (no `quoteModeAtSubmission`, and the seed quote carries no mode). */
  type Mode = FinancedMode | "CASH" | "NONE";

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
    // INTERNAL_INSTALLMENT is the only mode with no financier leg (OR-1/OR-2), so it is the default for the NOT_APPLICABLE fixtures.
    const mode = opts.mode ?? "INTERNAL_INSTALLMENT";
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
          financingType: mode === "LEASE" ? "LEASE" : mode === "CASH" || mode === "NONE" ? "CASH" : "FINANCED",
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
        ...(mode === "NONE" ? {} : { quoteModeAtSubmission: mode }),
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
      await recordReconciledZeroCost(s.asOwner, api, s.orgId, applicationId);
      await s.t.run((ctx) => ctx.db.patch(applicationId, closedFields));
    }
    return { applicationId, finalizedSaleId };
  }

  async function confirm(s: Seed, applicationId: Id<"financeApplications">) {
    return s.asOwner.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId,
      applicationId,
      disbursedAmountMinor: 1_000,
      idempotencyKey: crypto.randomUUID(),
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
  // OR-1 / OR-2 (SCRUM-486 c21360): a MANUAL finance company and a LEASE company
  // owe the dealership the full amount, so those deals are NEVER NOT_APPLICABLE.
  describe.each<{ name: string; mode: Mode }>([
    { name: "a manual finance company", mode: "MANUAL_FINANCE_COMPANY" },
    { name: "a lease", mode: "LEASE" },
    { name: "a CASH-mode deal", mode: "CASH" },
    { name: "a mode-less application", mode: "NONE" },
  ])("$name, closed through the dealership with a completed sale, no company", ({ mode }) => {
    test("DISBURSEMENT is NOT NOT_APPLICABLE: it keeps waiting (UNKNOWN evidence is never NONE)", async () => {
      const s = await seed(`waits_${mode}`);
      const { applicationId } = await insertDeal(s, { mode });
      const { disbursement, settlement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("BLOCKED");
      expect(settlement.state).not.toBe("COMPLETE");
    });

    test("confirmDisbursement keeps the pre-existing no-finance-company refusal, not the NONE one", async () => {
      const s = await seed(`refwait_${mode}`);
      const { applicationId } = await insertDeal(s, { mode });
      const attempt = confirm(s, applicationId);
      await expect(attempt).rejects.toThrow(/no finance company — no disbursement expected/i);
      await expect(attempt).rejects.not.toThrow(/no finance company pays the dealership/i);
    });
  });

  describe("an internal instalment, closed through the dealership with a completed sale", () => {
    const mode: Mode = "INTERNAL_INSTALLMENT";
    test("DISBURSEMENT is NOT_APPLICABLE, never blocked and never complete", async () => {
      const s = await seed(`na_${mode}`);
      const { applicationId } = await insertDeal(s, { mode });
      const { disbursement, all } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("NOT_APPLICABLE");
      expect(disbursement.blocker).toBeUndefined();
      // Nothing on the rail is waiting on a finance company.
      expect(all.some((st) => st.state === "BLOCKED" && st.blocker === "AwaitingDisbursement")).toBe(false);
    });

    // These rows are SEEDED directly as CLOSED. The finalize gate (SCRUM-446,
    // see the "costs are evidenced before a no-company deal closes" block below)
    // stops `finalizeDeal` reaching a cost-less CLOSED deal; this documents how
    // an already-seeded / legacy row READS, which the gate does not restate.
    test("directly seeded CLOSED rows: SETTLEMENT completes on the supplier obligation, and profit is ACTUAL once expenses reconcile", async () => {
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

  test("the unnamed manual finance company case is still not NOT_APPLICABLE", async () => {
    const s = await seed("unnamed");
    const { applicationId } = await insertDeal(s, { mode: "MANUAL_FINANCE_COMPANY" });
    await s.t.run((ctx) => ctx.db.patch(applicationId, { manualFinanceSnapshot: undefined }));
    // OR-1: a manual finance company owes the dealership, named or not.
    expect((await stagesOf(s, applicationId)).disbursement.state).not.toBe("NOT_APPLICABLE");
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

  // ── 4b. dealModeOf: a legacy application reads the mode from its quote, same org only ──
  describe("a legacy application with no quoteModeAtSubmission reads the mode from its quote", () => {
    /** Closed internal-instalment deal whose frozen mode is cleared; the quote, in INTERNAL_INSTALLMENT, is the only mode evidence. */
    async function legacyDeal(s: Seed) {
      const { applicationId } = await insertDeal(s, { mode: "INTERNAL_INSTALLMENT" });
      await s.t.run(async (ctx) => {
        await ctx.db.patch(applicationId, { quoteModeAtSubmission: undefined });
        await ctx.db.patch(s.quoteId, { mode: "INTERNAL_INSTALLMENT" });
      });
      return applicationId;
    }

    test("a same-org quote in INTERNAL_INSTALLMENT resolves the leg exactly like the frozen mode", async () => {
      const s = await seed("dm_sameorg");
      const applicationId = await legacyDeal(s);
      const { disbursement, settlement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("NOT_APPLICABLE");
      expect(disbursement.blocker).toBeUndefined();
      expect(settlement.state).toBe("COMPLETE");
    });

    test("a quote belonging to another org is not evidence: the stage keeps waiting", async () => {
      const s = await seed("dm_crossorg");
      const applicationId = await legacyDeal(s);
      // Control: in its own org the quote proves the verdict.
      expect((await stagesOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE");
      await s.t.run(async (ctx) => {
        const foreignOrgId = await ctx.db.insert("organizations", { name: "FL dm foreign", createdAt: Date.now() });
        await ctx.db.patch(s.quoteId, { orgId: foreignOrgId });
      });
      const { disbursement, settlement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("BLOCKED");
      expect(settlement.state).not.toBe("COMPLETE");
    });

    test("a deleted quote is missing evidence: the stage keeps waiting", async () => {
      const s = await seed("dm_deleted");
      const applicationId = await legacyDeal(s);
      expect((await stagesOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE");
      await s.t.run((ctx) => ctx.db.delete(s.quoteId));
      const { disbursement, settlement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("BLOCKED");
      expect(settlement.state).not.toBe("COMPLETE");
    });
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
    await expect(confirm(s, applicationId)).rejects.toThrow(/no finance company pays the dealership/i);
    const after = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(after?.disbursedAt).toBeUndefined();
  });

  test("confirmDisbursement on an UNKNOWN deal keeps refusing", async () => {
    const s = await seed("refuseunknown");
    const { applicationId } = await insertDeal(s, { sale: "deleted" });
    await expect(confirm(s, applicationId)).rejects.toThrow(/no finance company — no disbursement expected/i);
  });

  // ── 9. L-1: STOPPED beats NOT_APPLICABLE; no orphaned PENDING; allComplete ─
  type Stage = { key: string; state: string };
  /** The cockpit's `allComplete`: every stage finished (COMPLETE or NOT_APPLICABLE). */
  const allComplete = (stages: Stage[]) =>
    stages.length > 0 && stages.every((st) => st.state === "COMPLETE" || st.state === "NOT_APPLICABLE");
  const isLive = (st: Stage) => st.state === "CURRENT" || st.state === "BLOCKED";
  /** A stage is never PENDING unless some stage is live to be waited on. */
  const expectNoOrphanedPending = (stages: Stage[]) => {
    if (stages.some((st) => st.state === "PENDING")) {
      expect(stages.some(isLive)).toBe(true);
    }
  };

  describe("stopped deals are STOPPED, never NOT_APPLICABLE", () => {
    const stoppedShapes: Array<{ name: string; make: (s: Seed) => Promise<Id<"financeApplications">> }> = [
      {
        name: "application CANCELLED after the deal closed",
        make: async (s) => {
          const { applicationId } = await insertDeal(s);
          await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));
          return applicationId;
        },
      },
      {
        name: "application REJECTED",
        make: async (s) => {
          const { applicationId } = await insertDeal(s);
          await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "REJECTED" }));
          return applicationId;
        },
      },
      {
        name: "linked sale cancelled, application still CLOSED",
        make: async (s) => (await insertDeal(s, { sale: "CANCELLED" })).applicationId,
      },
      {
        name: "application CANCELLED and linked sale cancelled",
        make: async (s) => {
          const { applicationId, finalizedSaleId } = await insertDeal(s);
          await s.t.run(async (ctx) => {
            await ctx.db.patch(applicationId, { status: "CANCELLED" });
            await ctx.db.patch(finalizedSaleId!, { status: "CANCELLED" });
          });
          return applicationId;
        },
      },
    ];

    test.each(stoppedShapes)("$name", async ({ name, make }) => {
      const s = await seed(`stop_${name.replace(/\W+/g, "").slice(0, 24)}`);
      const applicationId = await make(s);
      const { all, disbursement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("STOPPED");
      expect(all.some((st) => st.state === "NOT_APPLICABLE")).toBe(false);
      // Nothing is left waiting: every stage is either done or stopped.
      expect(all.every((st) => st.state === "COMPLETE" || st.state === "STOPPED")).toBe(true);
      expect(all.some((st) => st.state === "PENDING")).toBe(false);
      expect(allComplete(all)).toBe(false);
    });

    test("control: the identical live deal is NOT_APPLICABLE, so the shapes above differ by the stop alone", async () => {
      const s = await seed("stop_control");
      const { applicationId } = await insertDeal(s);
      expect((await stagesOf(s, applicationId)).disbursement.state).toBe("NOT_APPLICABLE");
    });
  });

  describe("no orphaned PENDING on any reachable no-company deal", () => {
    const shapes: Array<{ name: string; opts: DealOpts; patch?: Partial<Doc<"financeApplications">> }> = [
      { name: "pre-close", opts: { status: "APPROVED", sale: "none" } },
      { name: "live close", opts: {} },
      { name: "live close, legacy row", opts: { legacy: true } },
      { name: "application cancelled", opts: {}, patch: { status: "CANCELLED" } },
      { name: "sale cancelled", opts: { sale: "CANCELLED" } },
      { name: "sale missing", opts: { sale: "deleted" } },
      { name: "no sale named", opts: { sale: "none" } },
      { name: "closed, handover not registered", opts: {}, patch: { handoverStatus: "READY" } },
      { name: "direct route", opts: { route: "DIRECT_TO_SUPPLIER" } },
    ];

    test.each(shapes)("$name", async ({ name, opts, patch }) => {
      const s = await seed(`orph_${name.replace(/\W+/g, "").slice(0, 24)}`);
      const { applicationId } = await insertDeal(s, opts);
      if (patch) await s.t.run((ctx) => ctx.db.patch(applicationId, patch));
      const { all } = await stagesOf(s, applicationId);
      expectNoOrphanedPending(all);
      // The forbidden combination named in the acceptance criteria.
      if (all.some((st) => st.state === "NOT_APPLICABLE")) {
        expect(all.some(isLive) || allComplete(all)).toBe(true);
      }
    });
  });

  // ── 10. SCRUM-446: the rail reads a closed no-company deal as finished, so
  //        its costs must be evidenced BEFORE it can close ──────────────────
  describe("costs are evidenced before a no-company deal closes", () => {
    /** A pre-close application that has passed every finalizeDeal precondition except its costs. */
    async function readyToFinalize(s: Seed, opts: DealOpts = {}) {
      const { applicationId } = await insertDeal(s, { status: "APPROVED", sale: "none", ...opts });
      await s.t.run(async (ctx) => {
        await ctx.db.patch(applicationId, {
          vehicleHandoverAt: Date.now(),
          expectedPaymentMethod: "BANK_TRANSFER",
          expectedPaymentDate: Date.now(),
        });
        await ctx.db.patch(s.vehicleId, { status: "AVAILABLE" });
      });
      return applicationId;
    }

    async function costsCheck(s: Seed, applicationId: Id<"financeApplications">) {
      const r = await s.asOwner.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
      return r.checks.find((c) => c.key === "COSTS_CLOSABLE")!;
    }

    const finalize = (s: Seed, applicationId: Id<"financeApplications">) =>
      s.asOwner.mutation(api.applications.finalizeDeal, {
        orgId: s.orgId,
        applicationId,
        idempotencyKey: crypto.randomUUID(),
      });

    test.each<{ name: string; mode: FinancedMode }>([
      { name: "a manual finance company", mode: "MANUAL_FINANCE_COMPANY" },
      { name: "a lease", mode: "LEASE" },
      { name: "an internal instalment", mode: "INTERNAL_INSTALLMENT" },
    ])("$name through the dealership with NO cost line: COSTS_CLOSABLE is BLOCKED", async ({ mode }) => {
      const s = await seed(`cc_blocked_${mode}`);
      const applicationId = await readyToFinalize(s, { mode });
      expect((await costsCheck(s, applicationId)).status).toBe("BLOCKED");
    });

    test("finalizeDeal refuses a no-company through-dealership deal with no cost line, and closes nothing", async () => {
      const s = await seed("cc_refuse");
      // SCRUM-495: re-based from INTERNAL_INSTALLMENT (now refused before the costs gate) onto the operated
      // no-company shape, a manual finance company. The COSTS_NONE assertion is unchanged.
      const applicationId = await readyToFinalize(s, { mode: "MANUAL_FINANCE_COMPANY" });
      await expect(finalize(s, applicationId)).rejects.toThrow(/COSTS_NONE/);
      const after = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(after?.status).toBe("APPROVED");
      expect(after?.finalizedSaleId).toBeUndefined();
    });

    test("positive control: a reconciled zero line makes it READY, it finalizes, and the rail reads finished", async () => {
      const s = await seed("cc_ready");
      // SCRUM-495: re-based onto a manual finance company (see cc_refuse above).
      const applicationId = await readyToFinalize(s, { mode: "MANUAL_FINANCE_COMPANY" });
      await recordReconciledZeroCost(s.asOwner, api, s.orgId, applicationId);
      expect((await costsCheck(s, applicationId)).status).toBe("READY");
      await finalize(s, applicationId);
      const after = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(after?.status).toBe("CLOSED");
      // SCRUM-495: a manual finance company owes the dealership (OR-1), so its disbursement stage is
      // BLOCKED until the money is confirmed and the rail is NOT finished. The "no financier leg reads
      // NOT_APPLICABLE and the rail finishes" contract this test used to pin belonged to
      // INTERNAL_INSTALLMENT, which can no longer be finalized; that contract stays covered on stored
      // closed rows by the ac_true / stop_control / no-orphan tests in this file.
      const { all, disbursement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("BLOCKED");
      expect(allComplete(all)).toBe(false);
    });

    test("control: the direct route with no cost line keeps COSTS_CLOSABLE NOT_APPLICABLE", async () => {
      const s = await seed("cc_direct");
      const applicationId = await readyToFinalize(s, { route: "DIRECT_TO_SUPPLIER" });
      // The direct route only exists for a consigned (SOURCED) vehicle.
      await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceType: "SOURCED" as const }));
      expect((await costsCheck(s, applicationId)).status).toBe("NOT_APPLICABLE");
    });

    // SCRUM-455 owns these: CASH and mode-less applications are outside the SCRUM-446 gate.
    test.each<{ name: string; mode: "CASH" | "NONE" }>([
      { name: "a CASH-mode deal", mode: "CASH" },
      { name: "a mode-less application", mode: "NONE" },
    ])("exclusion control: $name with NO cost line keeps COSTS_CLOSABLE NOT_APPLICABLE and finalizes", async ({ mode }) => {
      const s = await seed(`cc_excl_${mode}`);
      const applicationId = await readyToFinalize(s, { mode });
      expect((await costsCheck(s, applicationId)).status).toBe("NOT_APPLICABLE");
      await finalize(s, applicationId);
      const after = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(after?.status).toBe("CLOSED");
    });

    test("control: a configured company through the dealership with no cost line is still BLOCKED", async () => {
      const s = await seed("cc_configured");
      const applicationId = await readyToFinalize(s, { mode: "CONFIGURED_FINANCE_COMPANY", configured: true });
      expect((await costsCheck(s, applicationId)).status).toBe("BLOCKED");
    });

    // SCRUM-495 (OR-6 / OR-7): a deal frozen in a retired mode cannot be finalized, even when every
    // other precondition (handover, payment method, a reconciled zero cost) is met, so the refusal
    // cannot be confused with any other. The control above (MANUAL_FINANCE_COMPANY) finalizes on
    // the identical fixture.
    const RETIRED_MESSAGE =
      "Lease and in-house instalment deals are no longer offered. Choose cash or a finance company.";

    test.each<{ mode: "LEASE" | "INTERNAL_INSTALLMENT" }>([{ mode: "LEASE" }, { mode: "INTERNAL_INSTALLMENT" }])(
      "finalizeDeal refuses a $mode deal with the retired-mode message, closes nothing and creates no sale",
      async ({ mode }) => {
        const s = await seed(`retired_finalize_${mode}`);
        const applicationId = await readyToFinalize(s, { mode });
        await recordReconciledZeroCost(s.asOwner, api, s.orgId, applicationId);
        await expect(finalize(s, applicationId)).rejects.toThrow(RETIRED_MESSAGE);
        const after = await s.t.run((ctx) => ctx.db.get(applicationId));
        expect(after?.status).toBe("APPROVED");
        expect(after?.finalizedSaleId).toBeUndefined();
        const sales = await s.t.run((ctx) => ctx.db.query("sales").collect());
        expect(sales).toHaveLength(0);
      }
    );

    test.each<{ mode: "LEASE" | "INTERNAL_INSTALLMENT" }>([{ mode: "LEASE" }, { mode: "INTERNAL_INSTALLMENT" }])(
      "getClosingReadiness states DEAL_MODE_RETIRED as a BLOCKED check for a $mode deal",
      async ({ mode }) => {
        const s = await seed(`retired_ready_${mode}`);
        const applicationId = await readyToFinalize(s, { mode });
        const r = await s.asOwner.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
        const check = r.checks.find((c) => c.key === "DEAL_MODE_RETIRED");
        expect(check?.status).toBe("BLOCKED");
        expect(check?.reasonCode).toBe("DEAL_MODE_RETIRED");
        expect(r.state).toBe("BLOCKED");
      }
    );

    test("control: an operated deal carries no DEAL_MODE_RETIRED check at all", async () => {
      const s = await seed("retired_ready_control");
      const applicationId = await readyToFinalize(s, { mode: "MANUAL_FINANCE_COMPANY" });
      const r = await s.asOwner.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
      expect(r.checks.some((c) => c.key === "DEAL_MODE_RETIRED")).toBe(false);
    });
  });

  describe("allComplete is true only on a live COMPLETED-sale deal that is genuinely finished", () => {
    test("live COMPLETED sale, reconciled: every stage is COMPLETE or NOT_APPLICABLE", async () => {
      const s = await seed("ac_true");
      const { applicationId } = await insertDeal(s, { reconciledFee: true });
      const { all, disbursement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("NOT_APPLICABLE");
      expect(all.filter((st) => st.state !== "NOT_APPLICABLE").every((st) => st.state === "COMPLETE")).toBe(true);
      expect(allComplete(all)).toBe(true);
    });

    test("live COMPLETED sale whose handover is not registered is NOT all complete", async () => {
      const s = await seed("ac_handover");
      const { applicationId } = await insertDeal(s);
      await s.t.run((ctx) => ctx.db.patch(applicationId, { handoverStatus: "READY" }));
      const { all, disbursement } = await stagesOf(s, applicationId);
      expect(disbursement.state).toBe("NOT_APPLICABLE");
      expect(allComplete(all)).toBe(false);
      expect(all.some(isLive)).toBe(true);
    });

    test.each([
      { name: "pre-close", opts: { status: "APPROVED", sale: "none" } as DealOpts },
      { name: "sale cancelled", opts: { sale: "CANCELLED" } as DealOpts },
      { name: "sale missing", opts: { sale: "deleted" } as DealOpts },
      { name: "direct route", opts: { route: "DIRECT_TO_SUPPLIER" } as DealOpts },
      { name: "configured finance company", opts: { mode: "CONFIGURED_FINANCE_COMPANY", configured: true } as DealOpts },
    ])("$name is never all complete", async ({ name, opts }) => {
      const s = await seed(`ac_false_${name.replace(/\W+/g, "").slice(0, 20)}`);
      const { applicationId } = await insertDeal(s, opts);
      expect(allComplete((await stagesOf(s, applicationId)).all)).toBe(false);
    });

    test("an application CANCELLED after a completed sale is never all complete", async () => {
      const s = await seed("ac_appcancel");
      const { applicationId } = await insertDeal(s, { reconciledFee: true });
      expect(allComplete((await stagesOf(s, applicationId)).all)).toBe(true);
      await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));
      expect(allComplete((await stagesOf(s, applicationId)).all)).toBe(false);
    });
  });
});
