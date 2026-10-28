/**
 * SCRUM-766 PR-C: the supplier concession on a SOURCED (consigned) vehicle.
 *
 * Owner ruling (SCRUM-760 c23812, ruling 3, 2026-10-28): on a SOURCED vehicle the
 * supplier may absorb part (or all) of the server-computed TOTAL NET SHORTFALL by
 * conceding part of his own entitlement. Stock cars stay refused.
 *
 * The owner's worked example, JOD (the PR-B fixture): quoted 12,500, customer first
 * payment 500, company at 85% LTV, approved 11,500, contribution 1,225, NET SHORTFALL
 * 850, vehicle (supplier entitlement) E = 9,500, closing fees 625.
 *
 *   V0  showroom absorbs 850                          margin 11,500 - 9,500 - 1,225 =   775
 *   V1  customer 400 cash + showroom 450              margin 11,900 - 9,500 - 1,225 = 1,175
 *   V2  customer 400 to the company + showroom 450    margin 11,500 - 9,500 -   825 = 1,175
 *   V3  supplier 400 + showroom 450 (E_eff = 9,100)   margin 11,500 - 9,100 - 1,225 = 1,175
 *
 * At a 10% commission rate: V0 = 77.5, V1 = V2 = V3 = 117.5 (owner c22421: the
 * commission margin is the same whoever covers the gap). Every expected number below is
 * the literal above, never recomputed from the code under test.
 *
 * Open owner questions are marked "pending owner ruling Qn" in the source; the tests that
 * pin the fail-closed default for one say so in their name.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { registerHandover } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { finalizeAsOwner, newApplication, payForwardAsOwner, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { classifyGapResolution, validateGapShares } from "../lib/financingEconomics";
import { appraisalGapIsSettled } from "./utils/financingEconomics";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
type SupplierConcessionModule = {
  effectiveSupplierEntitlementMinor(args: { entitlementMinor: number; concessionMinor: number }): number;
  financedConsignedNetMinor(args: { considerationMinor: number; entitlementMinor: number; contraMinor: number }): number;
};
type SaleRowProjectionModule = { SALE_FIELD_VISIBILITY: Record<string, string> };
/** The new modules do not exist before the fix: a missing one fails its own test, not the whole suite. */
async function loadUtil<T>(name: string): Promise<T> {
  const load = MODULES[`./utils/${name}.ts`];
  if (!load) throw new Error(`convex/utils/${name}.ts does not exist`);
  return (await load()) as T;
}const jod = (major: number) => major * 1_000;
const SUPPLIER = "Amman Importer Co";

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

async function seed(tag: string, opts: { sourced?: boolean } = {}) {
  const sourced = opts.sourced ?? true;
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S766C", vinPrefix: "VIN766C", sourced,
    actors: {
      // Can read the deal and its sale, holds no finance-tier authority.
      Clerk: ["view:sales", "view:finance_applications"],
      SalesOnly: ["view:sales"],
      NoApprove: ["view:finance_applications", "view:finance"],
    },
  });
  await s.t.run(async (ctx) => {
    await ctx.db.patch(s.companyId, { defaultLtvPercent: 85 });
    // The owner's example: the supplier is owed 9,500 (major units on the vehicle row).
    if (sourced) await ctx.db.patch(s.vehicleId, { sourceCost: 9_500 });
  });
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Every row of every table: a refused command must leave all of it as it found it. */
const stateOf = (s: { t: unknown }) => dbSnapshot(s.t, Object.keys(schema.tables));

async function appOf(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run((ctx) => ctx.db.get(applicationId));
}

async function saleOf(s: Seeded, applicationId: Id<"financeApplications">) {
  const app = await appOf(s, applicationId);
  if (!app?.finalizedSaleId) throw new Error("the deal was not finalized");
  return (await s.t.run((ctx) => ctx.db.get(app.finalizedSaleId!)))!;
}

async function payableOf(s: Seeded) {
  return await s.t.run(async (ctx) =>
    (await ctx.db.query("vehicleSupplierPayables").collect()).find((row) => row.orgId === s.orgId && row.status !== "CANCELLED")
  );
}

async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const net: Record<string, number> = {};
    for (const event of events) {
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
          net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
        }
      }
    }
    return net;
  });
}

async function glNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
    }
    return net;
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<{ message: string } | null> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: unknown }).data;
    if (typeof data === "string") return { message: data };
    if (typeof data === "object" && data !== null) return data as { message: string };
    return { message: (error as Error).message };
  }
  return null;
}

async function setCommissionRate(s: Seeded, percent: number) {
  await s.t.run(async (ctx) => {
    const membership = (await ctx.db.query("memberships").collect()).find((m) => m.orgId === s.orgId && m.userId === s.owner.userId)!;
    await ctx.db.patch(membership._id, { commissionRate: percent });
  });
}

/** Quoted 12,500, first payment 500, approved 11,500 -> net shortfall 850, contribution 1,225. Route chosen after APPROVED. */
async function approvedDeal(s: Seeded, route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER", approvedMajor = 11_500) {
  const { applicationId } = await newApplication(s);
  const { owner, approver, orgId } = s;
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  // Only a consigned car has a supplier settlement route; a stock car refuses to choose one.
  const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
  if (vehicle?.sourceType === "SOURCED") {
    await owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId, applicationId, route });
  }
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(12_500), source: "MANUAL_ENTRY", customerFirstPaymentMinor: jod(500),
  });
  await approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: jod(approvedMajor), basis: "MANUAL", notes: "Approved below the quotation.",
  });
  return applicationId;
}

type Split = {
  customer: number; dealer: number; supplier?: number; cash?: number; financeCompany?: number;
  /** What the dialog observed, so a stale view is refused. Defaults to the vehicle as seeded. */
  observed?: { entitlementMinor: number; supplierName: string } | null;
};

/** Records how the shortfall is shared, as the approver (who is not the deal's salesperson). */
function resolve(s: Seeded, applicationId: Id<"financeApplications">, split: Split, caller: Seeded["approver"] = s.approver) {
  return (async () => {
    const served = await caller.as.query(api.applications.get, { orgId: s.orgId, applicationId });
    const observed = split.observed === undefined ? { entitlementMinor: jod(9_500), supplierName: SUPPLIER } : split.observed;
    return await caller.as.mutation(api.financingEconomics.resolveAppraisalGap, {
      orgId: s.orgId, applicationId, economicsStamp: served!.economicsStamp as string,
      customerGapShareMinor: jod(split.customer),
      dealerGapShareMinor: jod(split.dealer),
      ...(split.supplier === undefined ? {} : { supplierGapShareMinor: jod(split.supplier) }),
      customerGapCashToDealerMinor: jod(split.cash ?? 0),
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: jod(split.financeCompany ?? 0),
      ...(observed === null || split.supplier === undefined
        ? {}
        : { observedSupplierEntitlementMinor: observed.entitlementMinor, observedSupplierName: observed.supplierName }),
    });
  })();
}

const V3 = { customer: 0, dealer: 450, supplier: 400 };

async function handOver(s: Seeded, applicationId: Id<"financeApplications">) {
  const { owner, orgId } = s;
  await registerHandover(owner.as, api, orgId, applicationId);
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const feeId = await owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
}

/** A resolved, handed-over consigned deal ready to finalize. */
async function readyConsignedDeal(
  s: Seeded,
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER",
  split: Split
) {
  const applicationId = await approvedDeal(s, route);
  await resolve(s, applicationId, split);
  await handOver(s, applicationId);
  return applicationId;
}

describe("PR-C pure rules: shares, classification and the settled predicate", () => {
  test("validateGapShares counts the supplier share toward the shortfall", () => {
    const base = {
      customerGapShareMinor: 0, dealerGapShareMinor: jod(450),
      customerGapCashToDealerMinor: 0, customerGapInstallmentToDealerMinor: 0, customerGapToFinanceCompanyMinor: 0,
    };
    expect(validateGapShares(jod(850), { ...base, supplierGapShareMinor: jod(400) })).toEqual([]);
    expect(validateGapShares(jod(850), { ...base, supplierGapShareMinor: jod(401) }).map((v) => v.code)).toEqual(["SHARES_DO_NOT_SUM_TO_GAP"]);
    expect(validateGapShares(jod(850), { ...base, supplierGapShareMinor: jod(399) }).map((v) => v.code)).toEqual(["SHARES_DO_NOT_SUM_TO_GAP"]);
    // Omitting the supplier share is exactly the old behaviour (default 0).
    expect(validateGapShares(jod(450), base)).toEqual([]);
    expect(validateGapShares(jod(850), base).map((v) => v.code)).toEqual(["SHARES_DO_NOT_SUM_TO_GAP"]);
    expect(validateGapShares(jod(850), { ...base, supplierGapShareMinor: -1 }).map((v) => v.code)).toEqual(["NEGATIVE_AMOUNT"]);
    expect(validateGapShares(jod(850), { ...base, supplierGapShareMinor: 400.5 }).map((v) => v.code)).toEqual(["NEGATIVE_AMOUNT"]);
  });

  test("the supplier alone covering the whole shortfall is SUPPLIER_ABSORBS; any mix is SPLIT", () => {
    expect(classifyGapResolution(jod(850), 0, 0, jod(850))).toBe("SUPPLIER_ABSORBS");
    expect(classifyGapResolution(jod(850), 0, jod(450), jod(400))).toBe("SPLIT");
    expect(classifyGapResolution(jod(850), jod(400), 0, jod(450))).toBe("SPLIT");
    expect(classifyGapResolution(jod(850), jod(400), jod(450), 0)).toBe("SPLIT");
    // Unchanged for the existing three outcomes.
    expect(classifyGapResolution(jod(850), jod(850), 0)).toBe("CUSTOMER_ABSORBS");
    expect(classifyGapResolution(jod(850), 0, jod(850))).toBe("DEALER_ABSORBS");
    expect(classifyGapResolution(0, 0, 0)).toBe("NOT_REQUIRED");
  });

  test("a SUPPLIER_ABSORBS resolution settles the gap for the deal's stages", () => {
    expect(appraisalGapIsSettled("SUPPLIER_ABSORBS")).toBe(true);
    expect(appraisalGapIsSettled("PENDING_NEGOTIATION")).toBe(false);
  });

  test("effectiveSupplierEntitlementMinor: S must be a safe integer with 0 <= S < E", async () => {
    const { effectiveSupplierEntitlementMinor } = await loadUtil<SupplierConcessionModule>("supplierConcession");
    const e = (concessionMinor: number, entitlementMinor = jod(9_500)) => effectiveSupplierEntitlementMinor({ entitlementMinor, concessionMinor });
    expect(e(0)).toBe(jod(9_500));
    expect(e(jod(400))).toBe(jod(9_100));
    expect(e(jod(9_500) - 1)).toBe(1);
    for (const bad of [jod(9_500), jod(9_501), -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 2 ** 53]) {
      expect(() => e(bad), `S=${bad}`).toThrow();
    }
    expect(() => e(0, 0)).toThrow();
    expect(() => e(0, Number.NaN)).toThrow();
    expect(() => e(0, 2 ** 53)).toThrow();
  });

  test("financedConsignedNetMinor is K - E_eff - contra, and the commission base clamps at zero", async () => {
    const { financedConsignedNetMinor } = await loadUtil<SupplierConcessionModule>("supplierConcession");
    expect(financedConsignedNetMinor({ considerationMinor: jod(11_500), entitlementMinor: jod(9_500), contraMinor: jod(1_225) })).toBe(jod(775));
    expect(financedConsignedNetMinor({ considerationMinor: jod(11_500), entitlementMinor: jod(9_100), contraMinor: jod(1_225) })).toBe(jod(1_175));
    expect(financedConsignedNetMinor({ considerationMinor: jod(11_900), entitlementMinor: jod(9_500), contraMinor: jod(1_225) })).toBe(jod(1_175));
    expect(financedConsignedNetMinor({ considerationMinor: jod(11_500), entitlementMinor: jod(9_500), contraMinor: jod(825) })).toBe(jod(1_175));
    // Signed: a loss is a negative margin; the commission clamps it elsewhere.
    expect(financedConsignedNetMinor({ considerationMinor: jod(9_000), entitlementMinor: jod(9_500), contraMinor: 0 })).toBe(-jod(500));
  });
});

describe("PR-C resolution: the supplier share of the net shortfall", () => {
  test("V3: supplier 400 + showroom 450 is a SPLIT that stores the share and the observed basis", async () => {
    const s = await seed("r1");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await resolve(s, applicationId, V3);

    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe("SPLIT");
    expect(app?.supplierGapShareMinor).toBe(jod(400));
    expect(app?.dealerGapShareMinor).toBe(jod(450));
    expect(app?.customerGapShareMinor).toBe(0);
    expect(app?.supplierGapBasis).toEqual({ contractEntitlementMinor: jod(9_500), currency: "JOD", supplierName: SUPPLIER });
  });

  test("the supplier alone covering the whole 850 is SUPPLIER_ABSORBS, and a second resolution is refused", async () => {
    const s = await seed("r2");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await resolve(s, applicationId, { customer: 0, dealer: 0, supplier: 850 });

    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe("SUPPLIER_ABSORBS");
    expect(app?.supplierGapShareMinor).toBe(jod(850));
    expect((await refusalOf(resolve(s, applicationId, { customer: 0, dealer: 850 })))?.message).toContain("already been agreed");
  });

  test("the three shares must add up to the net shortfall exactly (one minor unit over or under is refused)", async () => {
    const s = await seed("r3");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    const before = await stateOf(s);
    expect(await refusalOf(resolve(s, applicationId, { customer: 0, dealer: 450, supplier: 401 }))).not.toBeNull();
    expect(await refusalOf(resolve(s, applicationId, { customer: 0, dealer: 449, supplier: 400 }))).not.toBeNull();
    expect(await stateOf(s)).toEqual(before);
    // Positive control: the exact split is accepted, so the refusals above were the sum rule and not a dead feature.
    await resolve(s, applicationId, V3);
    expect((await appOf(s, applicationId))?.supplierGapShareMinor).toBe(jod(400));
  });

  test("a stock car cannot take a supplier concession, server-side, and nothing changes", async () => {
    const s = await seed("r4", { sourced: false });
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    const before = await stateOf(s);
    const refusal = await refusalOf(resolve(s, applicationId, { ...V3, observed: { entitlementMinor: jod(9_000), supplierName: SUPPLIER } }));
    expect(refusal?.message.toLowerCase()).toContain("supplier concession");
    expect(refusal?.message.toLowerCase()).toContain("sourced");
    expect(await stateOf(s)).toEqual(before);
  });

  test("an unavailable shortfall method refuses a supplier concession (pending owner ruling Q3 covers GROSS_MANUAL only)", async () => {
    const s = await seed("r5");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await s.t.run((ctx) => ctx.db.patch(applicationId, { netShortfallMethod: "UNAVAILABLE" as never }));
    const refusal = await refusalOf(resolve(s, applicationId, V3));
    expect(refusal).not.toBeNull();
    expect((await appOf(s, applicationId))?.supplierGapShareMinor).toBeUndefined();
    // Positive control: with the method restored the same concession is accepted.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { netShortfallMethod: "NET" }));
    await resolve(s, applicationId, V3);
    expect((await appOf(s, applicationId))?.supplierGapShareMinor).toBe(jod(400));
  });

  test("a concession needs the observed basis, and a stale entitlement or supplier name is refused", async () => {
    const s = await seed("r6");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");

    // (c) a concession with no observed basis at all
    expect((await refusalOf(resolve(s, applicationId, { ...V3, observed: null })))?.message.toLowerCase()).toContain("supplier concession");
    // (b) the supplier's name changed since the dialog rendered
    expect((await refusalOf(resolve(s, applicationId, { ...V3, observed: { entitlementMinor: jod(9_500), supplierName: "Someone Else" } })))?.message.toLowerCase()).toContain("supplier concession");
    // (a) the entitlement the dialog observed is not the vehicle's
    expect((await refusalOf(resolve(s, applicationId, { ...V3, observed: { entitlementMinor: jod(9_000), supplierName: SUPPLIER } })))?.message.toLowerCase()).toContain("supplier concession");
    // (d) the vehicle moved after the dialog was rendered (the bypass a direct edit could attempt)
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 9_600 }));
    expect((await refusalOf(resolve(s, applicationId, V3)))?.message.toLowerCase()).toContain("supplier concession");
    expect((await appOf(s, applicationId))?.supplierGapShareMinor).toBeUndefined();
  });

  test("the concession cannot reach the supplier's whole entitlement (S < E)", async () => {
    const s = await seed("r7");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    // A vehicle owed less than the shortfall: S == E would zero the supplier's payable.
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 850 }));
    const refusal = await refusalOf(resolve(s, applicationId, { customer: 0, dealer: 0, supplier: 850, observed: { entitlementMinor: jod(850), supplierName: SUPPLIER } }));
    expect(refusal?.message.toLowerCase()).toContain("supplier concession");
    expect((await appOf(s, applicationId))?.supplierGapShareMinor).toBeUndefined();
  });

  test("a multi-vehicle application cannot take a supplier concession", async () => {
    const s = await seed("r8");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await s.t.run(async (ctx) => {
      const second = await ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VIN766CR8B", make: "Kia", model: "Rio", year: 2024, mileage: 10, color: "Red",
        fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 10_000, status: "AVAILABLE",
        sourceType: "SOURCED", sourcedFromName: SUPPLIER, sourceCost: 8_000,
      });
      await ctx.db.patch(applicationId, {
        vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 12_500 }, { vehicleId: second, unitPrice: 10_000 }],
      });
    });
    const refusal = await refusalOf(resolve(s, applicationId, V3));
    expect(refusal?.message.toLowerCase()).toContain("supplier concession");
  });

  test("a shortfall that moves clears the concession and its observed basis", async () => {
    const s = await seed("r9");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await resolve(s, applicationId, V3);
    await s.approver.as.mutation(api.financingEconomics.reopenApproval, { orgId: s.orgId, applicationId, reason: "Re-negotiating the approval." });
    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).not.toBe("SPLIT");
    expect(app?.supplierGapShareMinor).toBeUndefined();
    expect(app?.supplierGapBasis).toBeUndefined();
  });

  test("authority: a caller without approve+finance, another organization, and the deal's own salesperson are refused", async () => {
    const s = await seed("r10");
    const other = await seed("r10x");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    const before = await stateOf(s);
    expect((await refusalOf(resolve(s, applicationId, V3, s.actors.NoApprove)))?.message).toContain("Missing required permissions");
    expect((await refusalOf(resolve(s, applicationId, V3, s.owner)))?.message).toContain("your own application");
    expect(await refusalOf(resolve(s, applicationId, V3, other.approver))).not.toBeNull();
    expect(await stateOf(s)).toEqual(before);
  });

  test("the concession is withheld from a caller without finance view; a finance caller sees it", async () => {
    const s = await seed("r11");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await resolve(s, applicationId, V3);
    const clerk = await s.actors.Clerk.as.query(api.applications.get, { orgId: s.orgId, applicationId });
    expect(clerk).not.toBeNull();
    expect("supplierGapShareMinor" in (clerk as object)).toBe(false);
    expect("supplierGapBasis" in (clerk as object)).toBe(false);
    const finance = await s.approver.as.query(api.applications.get, { orgId: s.orgId, applicationId });
    expect((finance as { supplierGapShareMinor?: number }).supplierGapShareMinor).toBe(jod(400));
  });

  test("the dialog's basis query is finance-only and reports eligibility and the entitlement", async () => {
    const s = await seed("r12");
    const stock = await seed("r12s", { sourced: false });
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    const basis = await s.approver.as.query(api.financingEconomics.supplierConcessionBasis, { orgId: s.orgId, applicationId });
    expect(basis).toMatchObject({ eligible: true, entitlementMinor: jod(9_500), currency: "JOD", supplierName: SUPPLIER });
    const stockApplication = await approvedDeal(stock, "THROUGH_DEALERSHIP");
    expect(await stock.approver.as.query(api.financingEconomics.supplierConcessionBasis, { orgId: stock.orgId, applicationId: stockApplication })).toMatchObject({ eligible: false });
    expect((await refusalOf(s.actors.Clerk.as.query(api.financingEconomics.supplierConcessionBasis, { orgId: s.orgId, applicationId })))?.message).toContain("Missing required permissions");
  });

  test("a vehicle edit that changes the supplier, cost or type is refused while a concession is held, and allowed after release", async () => {
    const s = await seed("r13");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    await resolve(s, applicationId, V3);
    const edit = (over: { sourceCost?: number; sourcedFromName?: string }) =>
      s.owner.as.mutation(api.vehicles.update, {
        orgId: s.orgId, vehicleId: s.vehicleId, sourceType: "SOURCED", sourcedFromName: SUPPLIER, sourceCost: 9_500, ...over,
      });
    const refused = await refusalOf(edit({ sourceCost: 9_600 }));
    expect(refused?.message.toLowerCase()).toContain("supplier concession");
    // The refusal states no figures: the caller may hold no finance view.
    expect(refused?.message).not.toMatch(/\d{3}/);
    expect((await refusalOf(edit({ sourcedFromName: "Another Supplier" })))?.message.toLowerCase()).toContain("supplier concession");
    expect((await s.t.run((ctx) => ctx.db.get(s.vehicleId)))?.sourceCost).toBe(9_500);

    await s.approver.as.mutation(api.financingEconomics.reopenApproval, { orgId: s.orgId, applicationId, reason: "Releasing the concession." });
    await edit({ sourceCost: 9_600 });
    expect((await s.t.run((ctx) => ctx.db.get(s.vehicleId)))?.sourceCost).toBe(9_600);
  });
});

describe("PR-C completion: THROUGH_DEALERSHIP", () => {
  test("V3 posts the supplier payable at E_eff = 9,100, the sale freezes the concession, and the GL balances", async () => {
    const s = await seed("t1");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    await finalizeAsOwner(s, applicationId);

    const sale = await saleOf(s, applicationId);
    expect(sale.consignedSupplierEntitlementMinor).toBe(jod(9_100));
    expect(sale.consignedSupplierConcessionMinor).toBe(jod(400));
    expect(sale.consignedMarginMinor).toBe(jod(2_400));
    expect(sale.financedNetRevenue?.minor).toBe(jod(1_175));

    const payable = await payableOf(s);
    expect(payable?.amountDue).toBe(9_100);

    // The vehicle row keeps the supplier's contractual figure; the concession lives on the deal.
    expect((await s.t.run((ctx) => ctx.db.get(s.vehicleId)))?.sourceCost).toBe(9_500);

    const sold = await netByAccount(s, "SALE_COMPLETED");
    expect(sold.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(jod(11_500));
    expect(sold.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(1_225));
    expect(sold.ACCOUNTS_PAYABLE_SUPPLIERS).toBe(-jod(9_100));
    expect(sold.CONSIGNMENT_COMMISSION_REVENUE).toBe(-jod(2_400));
    expect(sold.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(1_225));
    expect(Object.values(sold).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("a deal with no concession is exactly as before: payable 9,500, margin 2,000", async () => {
    const s = await seed("t2");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", { customer: 0, dealer: 850 });
    await finalizeAsOwner(s, applicationId);

    const sale = await saleOf(s, applicationId);
    expect(sale.consignedSupplierEntitlementMinor).toBe(jod(9_500));
    expect(sale.consignedSupplierConcessionMinor ?? 0).toBe(0);
    expect(sale.consignedMarginMinor).toBe(jod(2_000));
    expect(sale.financedNetRevenue?.minor).toBe(jod(775));
    expect((await payableOf(s))?.amountDue).toBe(9_500);
  });

  test("a finalize replay leaves one payable and one sale", async () => {
    const s = await seed("t3");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    // The SAME key and the SAME arguments twice: the second call is a replay of the first
    // command, not a new one. (An earlier version minted a fresh key for the first call, so
    // its second call proved only that a finalized deal refuses to finalize again.)
    await payForwardAsOwner(s, applicationId);
    const command = { idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId };
    const first = await s.owner.as.mutation(api.applications.finalizeDeal, command);
    const second = await s.owner.as.mutation(api.applications.finalizeDeal, command);
    expect(second).toEqual(first);
    const payables = await s.t.run(async (ctx) => (await ctx.db.query("vehicleSupplierPayables").collect()).filter((p) => p.orgId === s.orgId));
    const sales = await s.t.run(async (ctx) => (await ctx.db.query("sales").collect()).filter((p) => p.orgId === s.orgId));
    const journals = await s.t.run(async (ctx) => (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter((e) => e.eventType === "SALE_COMPLETED"));
    expect(payables).toHaveLength(1);
    expect(payables[0].amountDue).toBe(9_100);
    expect(sales).toHaveLength(1);
    expect(journals).toHaveLength(1);
  });

  test("a vehicle changed behind the guard (cost) refuses finalize: the stored basis is revalidated", async () => {
    const s = await seed("t4");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    // A direct write bypasses the edit guards; completion must still notice.
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 9_600 }));
    const refusal = await refusalOf(finalizeAsOwner(s, applicationId));
    expect(refusal?.message.toLowerCase()).toContain("supplier concession");
    expect((await appOf(s, applicationId))?.finalizedSaleId).toBeUndefined();
  });

  test("a vehicle that stopped being SOURCED refuses finalize while a concession is held", async () => {
    const s = await seed("t5");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceType: "STOCK", purchasePrice: 9_000 }));
    const refusal = await refusalOf(finalizeAsOwner(s, applicationId));
    expect(refusal).not.toBeNull();
    expect((await appOf(s, applicationId))?.finalizedSaleId).toBeUndefined();
  });
});

/**
 * F3 (Seat 1, PR #697): a MANUAL finance company's shortfall is the GROSS quotation-minus-letter gap
 * (`netShortfallMethod: "GROSS_MANUAL"`), and the owner accepted Q3 "as implemented" (SCRUM-766
 * c23841), so a supplier concession is allowed against it. Literals, derived by hand:
 *
 *   sale price 12,500, letter G 11,650           -> gross shortfall 850
 *   dealership sends the company S 1,225, no deposit held -> contribution C = 1,225
 *   supplier owed E = 9,500, concedes 400        -> E_eff = 9,100; dealership covers 450
 *   K = G = 11,650 (the customer owes no gap cash)
 *   agency margin (GL) = K - E_eff = 2,550; commission margin M = K - E_eff - C = 1,325 -> 10% = 132.5
 *   journal: AR-FC +11,650, contra +1,225, AP suppliers -9,100, commission -2,550, AP-FC -1,225 = 0
 */
describe("PR-C on a GROSS_MANUAL shortfall (a manual-letter finance company)", () => {
  async function manualApprovedDeal(s: Seeded, route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER") {
    const { owner, approver, orgId } = s;
    const quoteId = await owner.as.mutation(api.quotes.saveQuote, {
      orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 12_500, downPayment: 0, termMonths: 48,
      mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other finance option", manualAdminFees: 0, manualProfitRate: 5,
    });
    const applicationId = await owner.as.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId, applicationId, route });
    await approver.as.mutation(api.financingEconomics.recordManualFinanceApproval, {
      orgId, applicationId, approvedAmountMinor: jod(11_650), financierName: "Al-Ameen Islamic Finance", dealerSendsMinor: jod(1_225),
    });
    return applicationId;
  }

  test("the concession is accepted: the method is GROSS_MANUAL, the shortfall 850, and the supplier share is stored", async () => {
    const s = await seed("g1");
    const applicationId = await manualApprovedDeal(s, "THROUGH_DEALERSHIP");
    const before = await appOf(s, applicationId);
    expect(before?.netShortfallMethod).toBe("GROSS_MANUAL");
    expect(before?.netShortfallMinor).toBe(jod(850));

    await resolve(s, applicationId, V3);
    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe("SPLIT");
    expect(app?.supplierGapShareMinor).toBe(jod(400));
    expect(app?.dealerGapShareMinor).toBe(jod(450));
    // The shares still have to add up to the (gross) shortfall exactly.
    const bad = await refusalOf(resolve(s, applicationId, { customer: 0, dealer: 450, supplier: 401 }));
    expect(bad).not.toBeNull();
  });

  test("THROUGH_DEALERSHIP completion: ledger balances, payable is E_eff 9,100, commission is 132.5", async () => {
    const s = await seed("g2");
    await setCommissionRate(s, 10);
    const applicationId = await manualApprovedDeal(s, "THROUGH_DEALERSHIP");
    await resolve(s, applicationId, V3);
    await handOver(s, applicationId);
    await finalizeAsOwner(s, applicationId);

    const sale = await saleOf(s, applicationId);
    expect(sale.consignedSupplierEntitlementMinor).toBe(jod(9_100));
    expect(sale.consignedSupplierConcessionMinor).toBe(jod(400));
    expect(sale.consignedMarginMinor).toBe(jod(2_550));
    expect(sale.financedNetRevenue?.minor).toBe(jod(1_325));
    expect(sale.commissionAmount).toBe(132.5);

    expect((await payableOf(s))?.amountDue).toBe(9_100);

    const sold = await netByAccount(s, "SALE_COMPLETED");
    expect(sold.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(jod(11_650));
    expect(sold.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(1_225));
    expect(sold.ACCOUNTS_PAYABLE_SUPPLIERS).toBe(-jod(9_100));
    expect(sold.CONSIGNMENT_COMMISSION_REVENUE).toBe(-jod(2_550));
    expect(sold.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(1_225));
    expect(Object.values(sold).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

/**
 * LEGACY_GROSS documents CURRENT behaviour; it is not a ruling. A row with only the pre-SCRUM-766
 * gross gap (no method, no net total) is read as `LEGACY_GROSS` by `shortfallState`, and
 * `resolveAppraisalGap` has no refusal keyed on it, so a supplier concession against it is accepted
 * exactly as against NET. Adding a refusal would be a scope change for the owner.
 */
describe("PR-C on a LEGACY_GROSS shortfall (current behaviour, owner decision pending)", () => {
  test("a row with only the gross gap reads as LEGACY_GROSS and still takes a supplier concession", async () => {
    const s = await seed("lg1");
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP");
    // Rewrite the application as a pre-SCRUM-766 row: the gross gap only, no net derivation.
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        netShortfallMethod: undefined, netShortfallMinor: undefined,
        valuationShortfallMinor: undefined, financingTermsShortfallMinor: undefined,
        rawAppraisalGapMinor: jod(850),
      })
    );
    const { shortfallState } = await loadUtil<{
      shortfallState(app: unknown): { method: string; totalMinor: number | undefined };
    }>("financingEconomics");
    expect(shortfallState((await appOf(s, applicationId))!)).toMatchObject({ method: "LEGACY_GROSS", totalMinor: jod(850) });

    await resolve(s, applicationId, V3);
    const app = await appOf(s, applicationId);
    expect(app?.gapResolution).toBe("SPLIT");
    expect(app?.supplierGapShareMinor).toBe(jod(400));
  });
});

describe("PR-C completion: DIRECT_TO_SUPPLIER", () => {
  test("V3 claims A - E_eff = 2,400 on the supplier and posts the same on the ledger", async () => {
    const s = await seed("d1");
    const applicationId = await readyConsignedDeal(s, "DIRECT_TO_SUPPLIER", V3);
    await finalizeAsOwner(s, applicationId);

    const sale = await saleOf(s, applicationId);
    expect(sale.consignedSupplierEntitlementMinor).toBe(jod(9_100));
    expect(sale.consignedSupplierConcessionMinor).toBe(jod(400));
    expect(sale.consignedMarginMinor).toBe(jod(2_400));

    const sold = await netByAccount(s, "SALE_COMPLETED");
    expect(sold.RECEIVABLE_FROM_SUPPLIERS).toBe(jod(2_400));
    expect(sold.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(1_225));
    expect(sold.CONSIGNMENT_COMMISSION_REVENUE).toBe(-jod(2_400));
    expect(sold.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(1_225));
    expect(Object.values(sold).reduce((a, b) => a + b, 0)).toBe(0);
  });

  test("ordering: approved 9,200 is below the contract 9,500, so DIRECT is refused until the concession is recorded", async () => {
    const s = await seed("d2");
    // Approve while THROUGH (the dealership collects), resolve the concession, then switch route.
    const applicationId = await approvedDeal(s, "THROUGH_DEALERSHIP", 9_200);
    const app = await appOf(s, applicationId);
    const shortfall = app?.netShortfallMinor ?? 0;
    expect(shortfall).toBeGreaterThan(jod(400));

    const setRoute = () => s.owner.as.mutation(api.applications.setSupplierSettlementRoute, { orgId: s.orgId, applicationId, route: "DIRECT_TO_SUPPLIER" });
    expect(await refusalOf(setRoute())).not.toBeNull();

    const served = await s.approver.as.query(api.applications.get, { orgId: s.orgId, applicationId });
    await s.approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
      orgId: s.orgId, applicationId, economicsStamp: served!.economicsStamp as string,
      customerGapShareMinor: 0, dealerGapShareMinor: shortfall - jod(400), supplierGapShareMinor: jod(400),
      customerGapCashToDealerMinor: 0, customerGapInstallmentToDealerMinor: 0, customerGapToFinanceCompanyMinor: 0,
      observedSupplierEntitlementMinor: jod(9_500), observedSupplierName: SUPPLIER,
    });
    // E_eff = 9,100 <= approved 9,200: the mirror check now accepts the route.
    expect(await refusalOf(setRoute())).toBeNull();
    await handOver(s, applicationId);
    await finalizeAsOwner(s, applicationId);
    const claim = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find((r) => r.status !== "CANCELLED")
    );
    expect(claim?.amountDue).toBe(100);
  });
});

describe("PR-C commission: one frozen basis, the same whoever covers the gap (owner c22421)", () => {
  async function commissionOf(variant: "V0" | "V1" | "V2" | "V3"): Promise<number | undefined> {
    const s = await seed(`c${variant}`);
    await setCommissionRate(s, 10);
    const split: Split =
      variant === "V0" ? { customer: 0, dealer: 850 }
      : variant === "V1" ? { customer: 400, dealer: 450, cash: 400 }
      : variant === "V2" ? { customer: 400, dealer: 450, financeCompany: 400 }
      : V3;
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", split);
    if (variant === "V2") {
      await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
        orgId: s.orgId, applicationId, amountMinor: jod(400), paidAt: Date.now() - 1_000, reference: "TRF-766C",
        idempotencyKey: crypto.randomUUID(),
      });
    }
    await finalizeAsOwner(s, applicationId);
    return (await saleOf(s, applicationId)).commissionAmount;
  }

  test("10% of 775 = 77.5 for V0, and 10% of 1,175 = 117.5 for V1, V2 and V3", async () => {
    expect(await commissionOf("V0")).toBe(77.5);
    expect(await commissionOf("V1")).toBe(117.5);
    expect(await commissionOf("V2")).toBe(117.5);
    expect(await commissionOf("V3")).toBe(117.5);
  });

  test("recalculation reads the same frozen basis and does not drift", async () => {
    const s = await seed("rc");
    await setCommissionRate(s, 0);
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    await finalizeAsOwner(s, applicationId);
    const sale = await saleOf(s, applicationId);
    await s.t.run(async (ctx) => {
      await ctx.db.patch(sale._id, { commissionAmount: undefined });
      const membership = (await ctx.db.query("memberships").collect()).find((m) => m.orgId === s.orgId && m.userId === s.owner.userId)!;
      await ctx.db.patch(membership._id, { commissionRate: 10 });
    });
    const result = await s.owner.as.mutation(api.sales.recalculateCommission, { orgId: s.orgId, saleId: sale._id });
    expect(result.commissionAmount).toBe(117.5);
  });
});

describe("PR-C cancellation after a concession", () => {
  async function takeForwardBack(s: Seeded, applicationId: Id<"financeApplications">) {
    const live = (await s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect())).filter(
      (f) => f.orgId === s.orgId && f.applicationId === applicationId && f.reversedAt === undefined && f.reversalRequestedAt === undefined
    );
    for (const forward of live) {
      await s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
        orgId: s.orgId, applicationId, forwardId: forward._id, reason: "Deal is being cancelled.", idempotencyKey: crypto.randomUUID(),
      });
    }
  }

  test("THROUGH: cancelling after the company payment is taken back cancels the 9,100 payable and nets the ledger to nothing", async () => {
    const s = await seed("x1");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    await finalizeAsOwner(s, applicationId);
    await takeForwardBack(s, applicationId);
    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
    });

    const payables = await s.t.run(async (ctx) => (await ctx.db.query("vehicleSupplierPayables").collect()).filter((p) => p.orgId === s.orgId));
    expect(payables.map((p) => p.status)).toEqual(["CANCELLED"]);
    const gl = await glNet(s);
    expect(gl.ACCOUNTS_PAYABLE_SUPPLIERS ?? 0).toBe(0);
    expect(gl.CONSIGNMENT_COMMISSION_REVENUE ?? 0).toBe(0);
    expect(gl.SALES_CONSIDERATION_REDUCTIONS ?? 0).toBe(0);
    expect((await s.t.run((ctx) => ctx.db.get(s.vehicleId)))?.sourceCost).toBe(9_500);
  });

  test("THROUGH: a part-paid supplier payable blocks the cancellation (9,100 is owed, not 9,500)", async () => {
    const s = await seed("x2");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    await finalizeAsOwner(s, applicationId);
    const payable = await payableOf(s);
    await s.t.run((ctx) => ctx.db.patch(payable!._id, { amountPaid: 4_000 }));
    await takeForwardBack(s, applicationId);
    const refusal = await refusalOf(
      s.owner.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal).not.toBeNull();
    expect((await payableOf(s))?.status).not.toBe("CANCELLED");
  });
});

describe("PR-C disclosure: the sale rows do not leak the finance-tier concession", () => {
  test("sales.list and sales.get omit the concession for a view:sales-only caller and show it to finance", async () => {
    const s = await seed("p1");
    const applicationId = await readyConsignedDeal(s, "THROUGH_DEALERSHIP", V3);
    await finalizeAsOwner(s, applicationId);
    const sale = await saleOf(s, applicationId);

    const page = { numItems: 10, cursor: null };
    const salesOnlyList = await s.actors.SalesOnly.as.query(api.sales.list, { orgId: s.orgId, paginationOpts: page });
    expect(salesOnlyList.page).toHaveLength(1);
    expect("consignedSupplierConcessionMinor" in salesOnlyList.page[0]).toBe(false);
    const salesOnlyGet = await s.actors.SalesOnly.as.query(api.sales.get, { orgId: s.orgId, saleId: sale._id });
    expect("consignedSupplierConcessionMinor" in (salesOnlyGet as object)).toBe(false);

    const financeList = await s.owner.as.query(api.sales.list, { orgId: s.orgId, paginationOpts: page });
    expect(financeList.page[0].consignedSupplierConcessionMinor).toBe(jod(400));
    const financeGet = await s.owner.as.query(api.sales.get, { orgId: s.orgId, saleId: sale._id });
    expect((financeGet as { consignedSupplierConcessionMinor?: number }).consignedSupplierConcessionMinor).toBe(jod(400));
  });

  test("every sales field is classified, so a new money field cannot be exposed by the row spread", async () => {
    const { SALE_FIELD_VISIBILITY } = await loadUtil<SaleRowProjectionModule>("saleRowProjection");
    const fields = Object.keys((schema.tables.sales.validator as unknown as { fields: Record<string, unknown> }).fields);
    const unclassified = fields.filter((f) => !(f in SALE_FIELD_VISIBILITY));
    expect(unclassified).toEqual([]);
    expect(SALE_FIELD_VISIBILITY.consignedSupplierConcessionMinor).toBe("FINANCE");
  });
});

// RT11-DOORS: historical lifecycle mechanics with the pilot doors explicitly open.
// Shipped-state refusals and controls live in rt11DoorContainment.test.ts.
vi.mock("./utils/rt11DoorContainment", async (importOriginal) =>
  (await import("../test-utils/rt11DoorSwitches")).openRt11Doors(
    await importOriginal<typeof import("./utils/rt11DoorContainment")>()
  ));
