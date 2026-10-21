/**
 * SCRUM-802 mutation attack on the extras switch (owner ruling 2026-10-19).
 *
 * `CASH_SALE_EXTRAS_PILOT_REFUSED` is flipped OFF here, end to end, through the public doors, and the refusal cells of
 * convex/scrum802CashSaleExtras.test.ts are re-asked. They must go RED: the taxed sale is no longer refused with
 * `CASH_SALE_TAX_FEES_WARRANTY_REFUSED`. (It is still stopped, by `CASH_SALE_BALANCE_UNPAID_REFUSED`, because the
 * invoice of price plus tax can never be fully deposited; that is the second wall, and it is why the pilot cannot
 * offer taxed cash sales at all.) If someone removes the switch's effect, or makes a door ignore it, the real cells
 * would still pass while this file shows which of them depend on it.
 *
 * Only the extras switch is flipped; the full-payment switch stays real. The census
 * (convex/scrum802OptOutCensus.test.ts) allows exactly this shape and nothing broader.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { seedCashDealer } from "../test-utils/cashDealerFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));
vi.mock("./utils/saleDebtContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/saleDebtContainment")>()),
  CASH_SALE_EXTRAS_PILOT_REFUSED: false,
}));

const MODULES = import.meta.glob("./**/*.*s");
const EXTRAS_CODE = "CASH_SALE_TAX_FEES_WARRANTY_REFUSED";

describe("with the extras switch flipped OFF the refusal cells go red, and the second wall still holds", () => {
  test("sales.create: a taxed CASH sale is NOT refused with the extras code (the real cell would fail), and is still stopped as unpaid", async () => {
    const s = await seedCashDealer("attackcreate", MODULES);
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
    });
    await s.asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId, amount: 20_000 });

    const refusal = await refusalDataOf(
      s.asUser.mutation(api.sales.create, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
        salePrice: 20_000, taxAmount: 3_200, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
      })
    );

    expect(refusal?.code).not.toBe(EXTRAS_CODE); // the real cell asserts toBe(EXTRAS_CODE): it goes red
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED"); // the deposit cap keeps the sale from completing anyway
  });

  test("sales.completeDraft: a taxed CASH draft is NOT refused with the extras code either", async () => {
    const s = await seedCashDealer("attackdraft", MODULES);
    const draftId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 20_000, saleDate: Date.now(), financingType: "CASH", taxAmount: 1_000, idempotencyKey: crypto.randomUUID(),
    } as never);

    const refusal = await refusalDataOf(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId: draftId, idempotencyKey: crypto.randomUUID() })
    );

    expect(refusal?.code).not.toBe(EXTRAS_CODE);
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
  });

  test("the mock took effect: the module under test sees the switch OFF", async () => {
    const mod = await import("./utils/saleDebtContainment");
    expect(mod.CASH_SALE_EXTRAS_PILOT_REFUSED).toBe(false);
    expect(mod.CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED).toBe(true);
  });
});
