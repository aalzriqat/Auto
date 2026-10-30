/**
 * SCRUM-858 S1 (owner ruling SCRUM-858#c23884): a financed sale recognised from a settlement plan does not
 * consume a named opening deposit. The plan reads quote-keyed deposit rows only and has already counted
 * the customer's consideration, so an opening reservation must stay HELD for a later cash sale rather than
 * be spent behind the plan's back (resolveReservationDeposits in utils/saleCompletion.ts).
 *
 * Evidence boundary: convex-test, serial, not production.
 */
import { expect, test, vi } from "vitest";
import { H, finalizeAsOwner, readyDeal, refusalMessageOf, seedFinancedDealership } from "../test-utils/financedDealFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");
const PERMS = [
  "view:sales", "create:sales", "edit:sales", "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers", "manage:finance", "view:finance", "approve:requests", "confirm:finance_disbursement",
];

test("a financed-plan sale leaves a named opening reservation deposit HELD and writes no application for it", async () => {
  const f = await seedFinancedDealership("fin858", {
    modules: MODULES,
    ownerPerms: [...PERMS, "view:finance_applications", "create:finance_application", "review:finance_application", "approve:finance_application",
      "manage:supplier_settlement", "cancel:closed_deal", "verify:finance_documents", "register:vehicle_handover", "register:expected_payment",
      "view:commissions", "manage:commissions", "view:reports", "manage:settings"],
    actors: {}, label: "S858F", vinPrefix: "VIN858F",
  });
  // No quote-keyed deposit: the only deposit the customer has is the opening reservation, named to this car.
  const { applicationId } = await readyDeal(f, { deposit: false, gapMinor: 300_000 });
  const openingDepositId = await f.t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId: f.orgId,
      customerId: f.customerId,
      vehicleId: f.vehicleId,
      amount: H / 1000,
      amountMinor: H,
      currency: "JOD",
      status: "HELD",
      holdActive: false,
      usesVehicleHoldRows: false,
      createdBy: f.owner.userId,
      createdAt: Date.now(),
      origin: "OPENING",
      openingRowKey: "dep-financed-skip",
      openingDepositKind: "RESERVATION",
    }),
  );

  expect(await refusalMessageOf(finalizeAsOwner(f, applicationId))).toBeNull();

  const after = await f.t.run(async (ctx) => ({
    app: await ctx.db.get(applicationId),
    deposit: await ctx.db.get(openingDepositId),
    applications: await ctx.db.query("depositApplications").collect(),
  }));
  expect(after.app?.status).toBe("CLOSED");
  expect(after.deposit?.status).toBe("HELD");
  expect(after.deposit?.resolutionSaleId).toBeUndefined();
  expect(after.applications.filter((a) => a.depositId === openingDepositId)).toEqual([]);
});
