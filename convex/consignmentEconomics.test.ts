/**
 * SCRUM-49 Lane 4 — one consignment classification, one set of economics.
 *
 * Four defects that all live in `saleEconomics` and its consumers, and which are
 * one problem seen from four sides: a figure is published as known when the
 * evidence for it is missing, corrupt, or belongs to a different basis.
 *
 *   SCRUM-41  a frozen margin is trusted even on the one route where the frozen
 *             margin is exactly what cannot be trusted.
 *   SCRUM-33  a sale whose vehicle row is gone and which froze nothing of its
 *             own is read as dealer-owned stock with a zero cost basis, so the
 *             whole ticket is published as profit — with no unknown flag.
 *   O-1       the frozen entitlement is validated against the sale price, which
 *             is the wrong yardstick on a financed DIRECT deal.
 *   O-2       an entitlement that fails validation falls back to a live cost
 *             that is itself not a basis.
 *
 * Every test here failed against `origin/main` at 214c843a before the fix.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { saleEconomics } from "./utils/vehicleOwnership";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance", "view:reports",
  "view:commissions", "manage:commissions",
];

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;
/** What the financier actually approved, and therefore actually paid him. */
const APPROVED = 11_000;
/** The earning the ledger recognizes on the direct route: approved − entitlement. */
const REAL_EARNING = APPROVED - ENTITLEMENT;

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `L4 ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Lane4 User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );

  return { t, orgId, userId, asUser, customerId };
}

type Seeded = Awaited<ReturnType<typeof seedDealer>>;

/** A completed consigned sale through the real writer, so every frozen field is real. */
async function sellConsigned(s: Seeded, vin: string) {
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );
  const saleId = await s.asUser.mutation(api.sales.create, {
    orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
  });
  return { saleId: saleId as Id<"sales">, vehicleId };
}

function range() {
  const now = Date.now();
  return { startDate: now - 86_400_000, endDate: now + 86_400_000 };
}

/* ------------------------------------------------------------------ SCRUM-41 */

/**
 * The frozen margin is the answer on every route EXCEPT one.
 *
 * On a financed DIRECT deal the finance company pays the supplier what it
 * APPROVED, and the dealership earns `approved − entitlement`. `salePrice −
 * entitlement` reaches no party. `sales.create` accepts `financingType` and
 * `supplierSettlementRoute` together with no application behind them, and the
 * write-path guard that refuses that shape (`FINANCED_DIRECT_NEEDS_APPROVED_AMOUNT`)
 * only landed with the SCRUM-30 release — so a row completed before it froze
 * `consignedMarginMinor` at the sale-price spread.
 *
 * What tells the two populations apart is not a date: it is
 * `consignedSupplierGrossReceiptMinor`. The one writer of the frozen fields
 * (`utils/saleCompletion.ts`) writes it in the SAME patch as the margin on every
 * direct-route sale, and derives the margin FROM it. A direct row carrying a
 * margin and no receipt therefore cannot have been written by the writer that
 * computes the margin correctly.
 *
 * The commission engine already fails closed on exactly this evidence
 * (`commissionableEarnings` refuses a financed direct sale with no recorded
 * receipt rather than substituting the sale price). Payroll money was protected
 * and owner-facing report money was not.
 */
describe("SCRUM-41 — a frozen margin nothing can substantiate", () => {
  test("a financed DIRECT row with no frozen receipt does not publish its frozen margin", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      externallyFinanced: true,
      // Frozen at the sale-price spread by a writer that predates the guard.
      recordedMargin: MARGIN,
      recordedSupplierEntitlement: ENTITLEMENT,
      // The proof of what actually reached the supplier. Absent.
      recordedSupplierGrossReceipt: undefined,
    });

    expect(e.dealershipMargin).toBeNull();
    // And specifically not the overstated figure.
    expect(e.dealershipMargin).not.toBe(MARGIN);
    expect(e.recognizedRevenue).toBeNull();
    // The supplier's own share is a separate frozen fact and survives: what he
    // is owed does not depend on proving what the financier paid.
    expect(e.supplierSettlement).toBe(ENTITLEMENT);
  });

  test("the same row WITH its frozen receipt keeps the margin the ledger posted", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      externallyFinanced: true,
      // What the current writer freezes: approved − entitlement.
      recordedMargin: REAL_EARNING,
      recordedSupplierEntitlement: ENTITLEMENT,
      recordedSupplierGrossReceipt: APPROVED,
      // A financed DIRECT sale is only constructible through `finalizeDeal`,
      // which records the application on the sale — so a realistic fixture for
      // this route carries one. See the no-application case below.
      hasFinancingApplication: true,
    });

    // Withholding a figure that IS substantiated is a different wrong answer,
    // not a safer one. This is the guard's other side.
    expect(e.dealershipMargin).toBe(REAL_EARNING);
    expect(e.recognizedRevenue).toBe(REAL_EARNING);
    expect(e.supplierSettlement).toBe(ENTITLEMENT);
  });

  /**
   * Raised by the Codex reviewer as CRITICAL, and its stated reachability was
   * DISPROVED before this test was written — see the SCRUM-41 Jira comment.
   * `consignedSupplierGrossReceiptMinor` and the write-path guard that forces a
   * real approved amount (`FINANCED_DIRECT_NEEDS_APPROVED_AMOUNT`) reached main
   * in the SAME merge, 51c62fc2 / PR #218, so the "field exists but guard does
   * not" window never existed in any deployed state: a pre-#218 row carries no
   * receipt at all and is already withheld by the rule above.
   *
   * The hardening is taken anyway, because the reviewer's underlying point is
   * right for a different reason. `/admin`'s raw-JSON editor can fabricate a row
   * whose receipt equals its sale price, and — more importantly — the CASH deal
   * cockpit already refuses EVERY no-application financed-direct row
   * (`financedDirectWithoutApproval` in convex/sales.ts). `saleEconomics` being
   * more permissive than a screen that already ships is two authorities
   * disagreeing about one sale, which is the exact defect this lane exists to
   * remove.
   *
   * It costs nothing legitimate: a financed DIRECT sale is only constructible
   * through `finalizeDeal`, which records `applicationId` on the sale.
   */
  test("a receipt equal to the sale price does not verify a margin with no application behind it", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      externallyFinanced: true,
      recordedMargin: MARGIN,
      recordedSupplierEntitlement: ENTITLEMENT,
      // Present, and indistinguishable from the historical sale-price fallback.
      recordedSupplierGrossReceipt: SALE_PRICE,
      // Nothing approved this. There is no application to prove what a
      // financier paid, so the receipt proves only its own presence.
      hasFinancingApplication: false,
    });

    expect(e.dealershipMargin).toBeNull();
    expect(e.dealershipMargin).not.toBe(MARGIN);
  });

  test("...and the same row WITH its application keeps the margin", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      externallyFinanced: true,
      recordedMargin: REAL_EARNING,
      recordedSupplierEntitlement: ENTITLEMENT,
      recordedSupplierGrossReceipt: APPROVED,
      hasFinancingApplication: true,
    });

    expect(e.dealershipMargin).toBe(REAL_EARNING);
  });

  test("a CASH direct row is untouched — the buyer really does hand over the sale price", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      // No external financier: nobody approves an amount, so there is nothing
      // the sale price could disagree with.
      externallyFinanced: false,
      recordedMargin: MARGIN,
      recordedSupplierEntitlement: ENTITLEMENT,
      recordedSupplierGrossReceipt: undefined,
    });

    expect(e.dealershipMargin).toBe(MARGIN);
  });

  test("the sales report excludes it from profit and says the total is a floor", async () => {
    const s = await seedDealer("s41report");
    const { saleId } = await sellConsigned(s, "VIN41R1");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, {
        financingType: "FINANCED",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        // The pre-guard shape: a margin frozen at the sale-price spread with
        // nothing on the row to substantiate it.
        consignedSupplierGrossReceiptMinor: undefined,
      });
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });

    expect(report.totalProfit).toBe(0);
    expect(report.totalProfit).not.toBe(MARGIN);
    expect(report.totalRevenue).toBe(0);
    // Not merely short — reported as short, which is the whole difference
    // between an incomplete total and a wrong one.
    expect(report.unknownMarginSaleCount).toBe(1);
  });

  /**
   * Found by the Codex reviewer AFTER the application requirement was added to
   * `saleEconomics` but not to the dashboard's own copy of the rule — the THIRD
   * consecutive drift between the two surfaces, and the one that triggered the
   * convergence circuit breaker and the redesign that deleted the copy.
   *
   * Kept as a permanent CROSS-SURFACE assertion rather than a unit test: a unit
   * test of `saleEconomics` alone would have stayed green through all three.
   */
  test("a receipt with no application behind it is withheld by BOTH surfaces", async () => {
    const s = await seedDealer("s41dashApp");
    const { saleId } = await sellConsigned(s, "VIN41DA1");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, {
        financingType: "FINANCED",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        // Receipt PRESENT (indistinguishable from the sale-price fallback), but
        // no application behind it. `applicationId` is left unset.
        consignedSupplierGrossReceiptMinor: SALE_PRICE * 1_000,
      });
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as { salesVolumeThisMonth: number; truncated: { turnover: boolean } };

    expect(report.unknownMarginSaleCount).toBe(1);
    expect(report.totalProfit).toBe(0);
    expect(dash.salesVolumeThisMonth).toBe(0);
    expect(dash.truncated.turnover).toBe(true);
  });

  test("the dashboard reaches the same verdict as the report on the same sale", async () => {
    const s = await seedDealer("s41dash");
    const { saleId } = await sellConsigned(s, "VIN41D1");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(saleId, {
        financingType: "FINANCED",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        consignedSupplierGrossReceiptMinor: undefined,
      });
    });

    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as { salesVolumeThisMonth: number; truncated: { turnover: boolean } };
    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });

    // Two screens, one deal, one answer. They disagreed before: the report
    // published the overstated margin while the dashboard had its own rule.
    expect(dash.salesVolumeThisMonth).toBe(0);
    expect(dash.truncated.turnover).toBe(true);
    expect(report.totalRevenue).toBe(0);
    expect(report.unknownMarginSaleCount).toBe(1);
  });
});

/* ------------------------------------------------------------------ SCRUM-33 */

/**
 * A sale that froze nothing, whose vehicle row is gone.
 *
 * `consignedMarginMinor` post-dates the legacy consigned population and the
 * route is absent, which reads as THROUGH_DEALERSHIP — so none of the three
 * consignment signals fires and the sale classifies as dealer-owned stock.
 * `capitalizedCost` also arrives as 0, because the cost basis went with the
 * vehicle. The result was the entire ticket published as revenue AND as profit,
 * with `unknownMarginSaleCount: 0` — presented as complete.
 *
 * The fix is not to guess the classification. It is that a sale with no
 * readable basis of its own and no readable vehicle has an UNKNOWN earning,
 * whichever side of the classification it would have fallen on: the same
 * `salePrice − 0` arithmetic misstates a dealer-owned row just as badly.
 */
describe("SCRUM-33 — a sale with no basis on the row and no vehicle to ask", () => {
  test("the whole ticket is not published as profit", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      // Hard-deleted through the /admin raw-JSON editor, or left behind by a
      // partially-failed `hardDeleteOrg`.
      vehicle: null,
      capitalizedCost: 0,
      // A legacy consigned THROUGH sale: the route field did not exist yet.
      supplierSettlementRoute: undefined,
      recordedMargin: undefined,
      recordedSupplierEntitlement: undefined,
    });

    expect(e.dealershipMargin).toBeNull();
    expect(e.dealershipMargin).not.toBe(SALE_PRICE);
    // Revenue is null exactly when the margin is — the documented contract of
    // this object, and what keeps `unknownMarginSaleCount` honest about which
    // totals a row was excluded from.
    expect(e.recognizedRevenue).toBeNull();
    // Nor is the supplier's share asserted to be zero on a sale nobody can
    // classify.
    expect(e.supplierSettlement).toBeNull();
  });

  test("a surviving frozen basis still answers, so the rule costs nothing it should not", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: null,
      capitalizedCost: 0,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      recordedMargin: undefined,
      recordedSupplierEntitlement: ENTITLEMENT,
    });

    expect(e.isAgentSale).toBe(true);
    expect(e.dealershipMargin).toBe(MARGIN);
    expect(e.supplierSettlement).toBe(ENTITLEMENT);
  });

  /**
   * Found INDEPENDENTLY by both adversarial reviewers, and reproduced before
   * fixing. It is the case the first cut of this lane missed, and the miss was
   * caused by the fix itself: moving `saleEconomics` to withhold while leaving
   * the dashboard's own parallel rule alone made the two surfaces disagree MORE
   * than before, under a comment asserting they now agreed.
   *
   * The vehicle is PRESENT here — that is what makes it different from the test
   * below, and it is why the dashboard's rule sailed past it: the only question
   * that rule asked was whether the sale was financed-DIRECT. It then reached
   * `Math.max(0, salePrice − 0)` and published the whole ticket as this window's
   * turnover AND its profit trend, feeding the top-performer tile with it.
   */
  /**
   * The OTHER direction, and the one a consolidation is most likely to get
   * wrong: a figure the authority CAN establish must not be dropped.
   *
   * Found by the Codex reviewer against the first cut of the dashboard
   * consolidation and reproduced before fixing. The profit trend was gated on
   * this window's live cost map, so a sale whose vehicle row is gone — but whose
   * margin the SALE itself froze — reported turnover 3,000 and profit 0 in one
   * response, with every truncation flag false. The chart contradicted the
   * headline directly above it and said nothing was missing.
   *
   * The three assertions are deliberately taken together. Turnover alone passed
   * throughout; only comparing it against the trend and the flags catches this.
   */
  test("a frozen margin survives a deleted vehicle in the PROFIT trend, not just in turnover", async () => {
    const s = await seedDealer("s33frozenprofit");
    const { vehicleId } = await sellConsigned(s, "VIN33FP1");
    await s.t.run(async (ctx) => {
      // Only the vehicle goes. Every frozen field on the sale survives.
      await ctx.db.delete(vehicleId);
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      salesVolumeThisMonth: number;
      truncated: { turnover: boolean; profit: boolean };
      salesTrend: Array<{ Revenue: number; Profit: number }>;
    };

    // The report recognizes what the sale froze.
    expect(report.totalProfit).toBe(MARGIN);
    // So does the dashboard's headline...
    expect(dash.salesVolumeThisMonth).toBe(MARGIN);
    // ...and so must the chart beneath it. This was 0.
    expect(dash.salesTrend.reduce((total, p) => total + p.Profit, 0)).toBe(MARGIN);
    // And nothing is short, so no flag may claim otherwise.
    expect(dash.truncated.turnover).toBe(false);
    expect(dash.truncated.profit).toBe(false);
  });

  test("a present vehicle with no cost basis is withheld by BOTH surfaces, not just the report", async () => {
    const s = await seedDealer("s33zerocost");
    const { saleId, vehicleId } = await sellConsigned(s, "VIN33Z1");
    await s.t.run(async (ctx) => {
      // The legacy row: completed before the frozen fields existed.
      await ctx.db.patch(saleId, {
        consignedMarginMinor: undefined,
        consignedMarginCurrency: undefined,
        consignedSupplierEntitlementMinor: undefined,
        consignedSupplierGrossReceiptMinor: undefined,
        supplierSettlementRoute: undefined,
      });
      // ...whose supplier cost was later cleared. The row itself SURVIVES.
      await ctx.db.patch(vehicleId, { sourceCost: 0 });
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as {
      salesVolumeThisMonth: number;
      truncated: { turnover: boolean };
      salesTrend: Array<{ Revenue: number; Profit: number }>;
    };

    expect(report.totalProfit).toBe(0);
    expect(report.unknownMarginSaleCount).toBe(1);

    // Before the fix: 12,500 as turnover, 12,500 as profit, `truncated.turnover`
    // false — an owner's home screen contradicting their own sales report.
    expect(dash.salesVolumeThisMonth).toBe(0);
    expect(dash.truncated.turnover).toBe(true);
    for (const point of dash.salesTrend) {
      expect(point.Revenue).toBe(0);
      expect(point.Profit).toBe(0);
    }
  });

  test("the report withholds it, and the dashboard agrees on the same sale", async () => {
    const s = await seedDealer("s33report");
    const { saleId, vehicleId } = await sellConsigned(s, "VIN33R1");
    await s.t.run(async (ctx) => {
      // The legacy shape: completed before any of the frozen fields existed.
      await ctx.db.patch(saleId, {
        consignedMarginMinor: undefined,
        consignedMarginCurrency: undefined,
        consignedSupplierEntitlementMinor: undefined,
        consignedSupplierGrossReceiptMinor: undefined,
        supplierSettlementRoute: undefined,
      });
      await ctx.db.delete(vehicleId);
    });

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const dash = (await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId,
      timeRange: "ALL_TIME",
    })) as { salesVolumeThisMonth: number; truncated: { turnover: boolean } };

    // Never the sale price as profit — the defect this ticket names.
    expect(report.totalProfit).toBe(0);
    expect(report.totalProfit).not.toBe(SALE_PRICE);
    expect(report.totalRevenue).not.toBe(SALE_PRICE);
    // And flagged, so the owner is told the range is incomplete rather than
    // handed a confident wrong total.
    expect(report.unknownMarginSaleCount).toBe(1);

    // The two surfaces disagreed on this exact row: the dashboard excluded it
    // and the report published it in full.
    expect(dash.salesVolumeThisMonth).toBe(0);
    expect(dash.truncated.turnover).toBe(true);
  });
});

/* -------------------------------------------------------------- SCRUM-40 O-1 */

/**
 * `<= salePrice` is the wrong yardstick on a financed DIRECT deal.
 *
 * `approveDealerPurchaseAmount` bounds the approval only by `> 0` and
 * `>= entitlement`, and MANUAL basis accepts any figure — so an approval, and
 * therefore an entitlement, above the sale price is writer-producible.
 * `completeSale` compares the entitlement against the supplier's GROSS RECEIPT,
 * not against the sale price, so the reader was applying a stricter bound than
 * the writer and rejecting values the writer had legitimately stored.
 *
 * The error direction was withholding rather than overstating, which is why this
 * is a hardening rather than a defect — but a figure withheld for no reason is
 * still a figure the owner cannot see.
 */
describe("SCRUM-40 O-1 — the entitlement is bounded by what the supplier received", () => {
  test("an entitlement above the sale price is legitimate when the approval covered it", () => {
    const LOW_PRICE = 12_500;
    const HIGH_ENTITLEMENT = 13_500;
    const HIGH_APPROVAL = 14_000;

    const e = saleEconomics({
      salePrice: LOW_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: HIGH_ENTITLEMENT,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      externallyFinanced: true,
      recordedMargin: HIGH_APPROVAL - HIGH_ENTITLEMENT,
      recordedSupplierEntitlement: HIGH_ENTITLEMENT,
      recordedSupplierGrossReceipt: HIGH_APPROVAL,
      // The approval this test is about came FROM an application.
      hasFinancingApplication: true,
    });

    expect(e.supplierSettlement).toBe(HIGH_ENTITLEMENT);
    expect(e.supplierSettlement).not.toBeNull();
    expect(e.dealershipMargin).toBe(HIGH_APPROVAL - HIGH_ENTITLEMENT);
  });

  test("the sale price still bounds it when no receipt was recorded", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      recordedMargin: undefined,
      // Above the gross, and with no receipt there is nothing that makes it so.
      recordedSupplierEntitlement: SALE_PRICE + 1_000,
    });

    // Falls back to the live basis, which is what it did before and remains
    // right while that basis is a real one.
    expect(e.supplierSettlement).toBe(ENTITLEMENT);
    expect(e.dealershipMargin).toBe(MARGIN);
  });
});

/* -------------------------------------------------------------- SCRUM-40 O-2 */

/**
 * When the frozen entitlement is rejected, the settlement dropped to the LIVE
 * capitalized cost rather than withholding — and on an agent sale a live cost of
 * zero is not the fact that the supplier is owed nothing for his own car. It is
 * missing evidence: `saleCompletion` refuses to complete a sourced sale without
 * a positive cost, so zero cannot have been what the sale posted on.
 *
 * Reproduced by Opus: `SOURCED, cost=0, entitlement=13500, margin=undefined` →
 * `margin=12500, settle=0`. The whole ticket as profit, from two corruptions
 * that individually are survivable.
 *
 * The narrow rule is deliberate. Where the live cost IS a real basis — every
 * pinned test in `consignedReporting.test.ts` — falling back to it stays right,
 * and withholding a derivable number would be a different wrong answer.
 */
describe("SCRUM-40 O-2 — a live basis that is not a basis", () => {
  test("an agent sale with no cost basis and an ineligible entitlement withholds both figures", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      // Cleared through the admin raw editor.
      capitalizedCost: 0,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      recordedMargin: undefined,
      // Above the ceiling, so ineligible.
      recordedSupplierEntitlement: SALE_PRICE + 1_000,
    });

    expect(e.dealershipMargin).toBeNull();
    expect(e.dealershipMargin).not.toBe(SALE_PRICE);
    expect(e.supplierSettlement).toBeNull();
    expect(e.supplierSettlement).not.toBe(0);
  });

  test("a positive live cost is still a basis and is still used", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      recordedMargin: undefined,
      recordedSupplierEntitlement: undefined,
    });

    expect(e.dealershipMargin).toBe(MARGIN);
    expect(e.supplierSettlement).toBe(ENTITLEMENT);
  });

  /**
   * Raised by the Codex reviewer, VALIDATED by reproduction, and a genuine gap
   * in my first cut: I coupled the supplier's uncertainty to the margin's.
   *
   * `basisUnknown` requires the margin to be absent, so a row that HAS a frozen
   * margin skipped it entirely — and the settlement beside it then fell through
   * to a live cost of zero and published "the supplier is owed nothing", with no
   * unknown-settlement count to say otherwise. The two figures answer different
   * questions from different evidence and their uncertainty is not shared: a
   * surviving margin says nothing about whether the supplier's basis survived.
   *
   * Note this is the OPPOSITE direction from the "ONE predicate governs BOTH
   * halves" rule established in an earlier round. That rule is about which
   * ENTITLEMENT is eligible, and it still holds — an entitlement unfit to derive
   * the margin is still unfit to be published. This is about which figure may be
   * withheld, and there the two are independent.
   */
  test("a surviving frozen margin does not certify the supplier's basis beside it", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      // Cleared after the sale — a consigned car is never capitalized, so the
      // acquisition lock never engages and `sourceCost` stays editable.
      capitalizedCost: 0,
      supplierSettlementRoute: "THROUGH_DEALERSHIP",
      // The sale froze what IT earned...
      recordedMargin: MARGIN,
      // ...but what the supplier was owed predates the field, or was erased.
      recordedSupplierEntitlement: undefined,
    });

    // The margin is still known: it has its own frozen evidence.
    expect(e.dealershipMargin).toBe(MARGIN);
    // The supplier's share is NOT. Zero is the claim that he is owed nothing
    // for his own car, and nothing on this row supports it.
    expect(e.supplierSettlement).toBeNull();
    expect(e.supplierSettlement).not.toBe(0);
  });

  test("a dealer-owned sale is not caught by the agent-only zero-cost rule", () => {
    // A dealer-owned car genuinely can carry a zero cost basis on a legacy row,
    // and `salePrice − 0` is what its own sale posted on. Widening the rule to
    // cover it would blank a figure that was never in doubt.
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "STOCK" },
      capitalizedCost: 0,
    });

    expect(e.isAgentSale).toBe(false);
    expect(e.dealershipMargin).toBe(SALE_PRICE);
    expect(e.recognizedRevenue).toBe(SALE_PRICE);
  });
});

/* -------------------------------------------------------------- SCRUM-40 O-3 */

/**
 * The classification premise, enforced rather than merely true.
 *
 * `saleIsAgentSale` treats a surviving `consignedSupplierEntitlementMinor` — and
 * a surviving `consignedMarginMinor` — as positive consignment signals when the
 * vehicle row is gone. That rests on "these fields exist only on a consigned
 * sale", which today holds because there is exactly one writer and it sits
 * inside `if (isSourced && marginMinor !== null)`.
 *
 * Nothing enforced it. A future writer or backfill that recorded either field on
 * a dealer-owned sale would silently reclassify it once its vehicle was deleted:
 * revenue `salePrice` → `salePrice − entitlement`, cost → 0.
 */
describe("SCRUM-40 O-3 — the frozen consigned fields belong to consigned sales only", () => {
  test("completing a dealer-owned sale writes neither frozen consigned field", async () => {
    const s = await seedDealer("s40o3");
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VIN40O3", make: "Kia", model: "Rio", year: 2023, mileage: 5,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 8_000,
        status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 6_000,
      })
    );
    const saleId = await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 8_000, saleDate: Date.now(), status: "COMPLETED" as const,
    });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));

    expect(sale?.consignedMarginMinor).toBeUndefined();
    expect(sale?.consignedSupplierEntitlementMinor).toBeUndefined();
    expect(sale?.consignedSupplierGrossReceiptMinor).toBeUndefined();
  });

  test("completing a consigned sale writes all three, so the guard above is not vacuous", async () => {
    const s = await seedDealer("s40o3b");
    const { saleId } = await sellConsigned(s, "VIN40O3B");
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));

    // THROUGH_DEALERSHIP is the default route, and the receipt is written only
    // on the direct one — so two of the three, which is what makes the
    // dealer-owned assertion above discriminating rather than trivially true.
    expect(sale?.consignedMarginMinor).toBe(MARGIN * 1_000);
    expect(sale?.consignedSupplierEntitlementMinor).toBe(ENTITLEMENT * 1_000);
  });
});
