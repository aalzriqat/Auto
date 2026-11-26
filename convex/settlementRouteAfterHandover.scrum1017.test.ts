/**
 * SCRUM-1017 (production deal D-000009): the settlement route is fixed once the
 * vehicle is handed over. Uses the fixtures shared with
 * `financedConsignedSettlement.test.ts` (`test-utils/financedConsignedSettlementHarness.ts`).
 */
import { legacyFinancingMinor } from "../test-utils/convexTest";
import { runDeal, seedDealershipWith, SCALE, VEHICLE_PRICE, type Route, type Seeded } from "../test-utils/financedConsignedSettlementHarness";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const seedDealership = (tag: string) => seedDealershipWith(MODULES, tag);

/**
 * SCRUM-1017 (production deal D-000009): handover is the one door that checks
 * the customer's first payment, and it skips that check when the deal settles
 * DIRECT to the supplier. A user switched the route to direct, handed the car
 * over (check skipped), and 23 seconds later switched it back to through the
 * dealership: a through-dealership deal handed over with its first payment
 * unconfirmed, and late confirmation permanently blocked.
 *
 * Owner ruling 2026-11-26: late confirmation stays blocked, so the bypass is
 * closed instead — once the vehicle is handed over, the route cannot change.
 */
describe("SCRUM-1017: the settlement route is fixed once the vehicle is handed over", () => {
  const SCRUM_1017_ROUTE_AUDIT = "SET_SUPPLIER_SETTLEMENT_ROUTE";
  const HANDED_OVER_REFUSAL = /already been handed over/i;

  const recordEconomics = async (s: Seeded, applicationId: Id<"financeApplications">) => {
    await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: VEHICLE_PRICE * SCALE, source: "MANUAL_ENTRY",
    });
    await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: VEHICLE_PRICE * SCALE,
      approvedFinancingAmountMinor: legacyFinancingMinor(VEHICLE_PRICE * SCALE, 100, 3_000 * SCALE),
      basis: "MANUAL", notes: "Approved at the quotation.",
    });
  };
  const setRoute = (s: Seeded, applicationId: Id<"financeApplications">, route: Route) =>
    s.asUser.mutation(api.applications.setSupplierSettlementRoute, { orgId: s.orgId, applicationId, route });
  const routeAuditRows = (s: Seeded) =>
    s.t.run(async (ctx) =>
      (await ctx.db.query("financialAuditLog").collect()).filter((row) => row.actionType === SCRUM_1017_ROUTE_AUDIT)
    );
  const applicationOf = (s: Seeded, applicationId: Id<"financeApplications">) =>
    s.t.run((ctx) => ctx.db.get(applicationId));

  test("the D-000009 sequence: through -> direct -> handover -> back to through is refused and the route stays direct", async () => {
    const s = await seedDealership("scrum1017-d9");
    const { applicationId } = await runDeal(s, {
      route: "THROUGH_DEALERSHIP", downPayment: 3_000, finalize: false,
      beforeHandover: async (id) => {
        await recordEconomics(s, id);
        // The first payment is unconfirmed on the through route; direct skips that check.
        await setRoute(s, id, "DIRECT_TO_SUPPLIER");
      },
    });
    expect((await applicationOf(s, applicationId))?.vehicleHandoverAt).toBeDefined();
    const auditBefore = (await routeAuditRows(s)).length;

    await expect(setRoute(s, applicationId, "THROUGH_DEALERSHIP")).rejects.toThrow(HANDED_OVER_REFUSAL);

    expect((await applicationOf(s, applicationId))?.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
    // (e) a refused change leaves no audit row behind.
    expect((await routeAuditRows(s)).length).toBe(auditBefore);
  });

  test("direct -> through is refused after handover", async () => {
    const s = await seedDealership("scrum1017-dt");
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER", downPayment: 3_000, finalize: false,
      beforeHandover: (id) => recordEconomics(s, id),
    });
    await expect(setRoute(s, applicationId, "THROUGH_DEALERSHIP")).rejects.toThrow(HANDED_OVER_REFUSAL);
    expect((await applicationOf(s, applicationId))?.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
  });

  test("through -> direct is refused after handover", async () => {
    const s = await seedDealership("scrum1017-td");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: false });
    expect((await applicationOf(s, applicationId))?.vehicleHandoverAt).toBeDefined();
    const auditBefore = (await routeAuditRows(s)).length;

    await expect(setRoute(s, applicationId, "DIRECT_TO_SUPPLIER")).rejects.toThrow(HANDED_OVER_REFUSAL);

    expect((await applicationOf(s, applicationId))?.supplierSettlementRoute).toBe("THROUGH_DEALERSHIP");
    expect((await routeAuditRows(s)).length).toBe(auditBefore);
  });

  test("control: before handover the route can still be changed, and the last choice is the one handover checks", async () => {
    const s = await seedDealership("scrum1017-pre");
    const { applicationId } = await runDeal(s, {
      route: "THROUGH_DEALERSHIP", downPayment: 3_000, finalize: false,
      beforeHandover: async (id) => {
        await recordEconomics(s, id);
        await setRoute(s, id, "DIRECT_TO_SUPPLIER");
        await setRoute(s, id, "THROUGH_DEALERSHIP");
      },
    });
    const app = await applicationOf(s, applicationId);
    expect(app?.supplierSettlementRoute).toBe("THROUGH_DEALERSHIP");
    expect(app?.vehicleHandoverAt).toBeDefined();
    expect(app?.firstPaymentEvidenceChecked).toBe(true);
  });

  test("re-recording the route already in force after handover behaves as it does today", async () => {
    const s = await seedDealership("scrum1017-noop");
    const { applicationId } = await runDeal(s, {
      route: "DIRECT_TO_SUPPLIER", downPayment: 3_000, finalize: false,
      beforeHandover: (id) => recordEconomics(s, id),
    });
    await expect(setRoute(s, applicationId, "DIRECT_TO_SUPPLIER")).resolves.toEqual({ route: "DIRECT_TO_SUPPLIER" });
    expect((await applicationOf(s, applicationId))?.supplierSettlementRoute).toBe("DIRECT_TO_SUPPLIER");
  });

  test("a deal handed over with no route recorded may still record the route handover actually checked (through), and no other", async () => {
    const s = await seedDealership("scrum1017-absent");
    const { applicationId } = await runDeal(s, { finalize: false });
    const handed = await applicationOf(s, applicationId);
    expect(handed?.vehicleHandoverAt).toBeDefined();
    expect(handed?.supplierSettlementRoute).toBeUndefined();
    // Nothing is locked yet: the screen must still let the operator record the route.
    expect((await s.asUser.query(api.applications.get, { orgId: s.orgId, applicationId }))?.canChangeSettlementRoute).toBe(true);

    await expect(setRoute(s, applicationId, "DIRECT_TO_SUPPLIER")).rejects.toThrow(HANDED_OVER_REFUSAL);
    expect((await applicationOf(s, applicationId))?.supplierSettlementRoute).toBeUndefined();
    // Absent already reads as through, so recording it changes nothing the handover relied on,
    // and finalizeDeal would otherwise refuse this deal forever for want of a route.
    await expect(setRoute(s, applicationId, "THROUGH_DEALERSHIP")).resolves.toEqual({ route: "THROUGH_DEALERSHIP" });
  });

  test("once the handover is undone (vehicleHandoverAt cleared) the route is changeable again", async () => {
    const s = await seedDealership("scrum1017-undo");
    const { applicationId } = await runDeal(s, { route: "THROUGH_DEALERSHIP", finalize: false });
    await expect(setRoute(s, applicationId, "DIRECT_TO_SUPPLIER")).rejects.toThrow(HANDED_OVER_REFUSAL);
    // What `clearedIdentityEvidence` does to the handover fields on an identity correction.
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        vehicleHandoverAt: undefined, vehicleHandoverBy: undefined, firstPaymentEvidenceChecked: undefined,
        handoverStatus: "BLOCKED",
      })
    );
    await expect(setRoute(s, applicationId, "DIRECT_TO_SUPPLIER")).resolves.toEqual({ route: "DIRECT_TO_SUPPLIER" });
  });

  test("the screen is told truthfully: applications.get says the route can be changed before handover and not after", async () => {
    const s = await seedDealership("scrum1017-flag");
    const { applicationId } = await runDeal(s, {
      route: "THROUGH_DEALERSHIP", finalize: false,
      beforeHandover: async (id) => {
        const before = await s.asUser.query(api.applications.get, { orgId: s.orgId, applicationId: id });
        expect(before?.canChangeSettlementRoute).toBe(true);
      },
    });
    const after = await s.asUser.query(api.applications.get, { orgId: s.orgId, applicationId });
    expect(after?.canChangeSettlementRoute).toBe(false);
  });
});
