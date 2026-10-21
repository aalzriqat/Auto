/**
 * SCRUM-802 follow-up (owner rulings, 2026-10-19): two things the pilot does NOT offer are refused on the SERVER,
 * not merely left out of the screen.
 *
 * 1. A CASH sale that carries tax, dealer fees, a warranty or GAP cannot be completed. A deposit is capped at the
 *    quote's vehiclePrice, so a cash invoice larger than the price can never be held in full as a deposit. The refusal
 *    is specific (`CASH_SALE_TAX_FEES_WARRANTY_REFUSED`, AR and EN), comes after tenant auth, and comes BEFORE any write
 *    and before `runWithIdempotency` on every completion door, so a refused call leaves no idempotency row either.
 * 2. Only deposits count toward "pay in full first". A cash sale settled by a trade-in allocation alone, or by a part
 *    deposit plus a trade-in, is refused (`CASH_SALE_BALANCE_UNPAID_REFUSED`). One named constant holds the rule.
 *
 * These run with the REAL switch (nothing here mocks the gate; convex/scrum802OptOutCensus.test.ts pins that).
 * Evidence boundary: convex-test, not production.
 */
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { seedCashDealer, type SeededCashDealer } from "../test-utils/cashDealerFixture";
import { completeSalesForLineItems } from "./utils/saleCompletion";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");
const ALL_TABLES = Object.keys(schema.tables);
const CODE = "CASH_SALE_TAX_FEES_WARRANTY_REFUSED";

const EXTRAS: ReadonlyArray<readonly [string, Record<string, number>]> = [
  ["a tax amount", { taxAmount: 1_000 }],
  ["a tax rate", { taxRate: 5 }],
  ["a dealer fee", { dealerFees: 250 }],
  ["a warranty", { warrantySold: 600, warrantyCost: 400, warrantyTermMonths: 12 }],
  ["GAP cover", { gapSold: 300, gapCost: 200, gapTermMonths: 12 }],
];

const createArgs = (s: SeededCashDealer, extra: Record<string, number> = {}) => ({
  idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
  salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED" as const, financingType: "CASH" as const, ...extra,
});

async function quoteFor(s: SeededCashDealer, price = 20_000) {
  return await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: price, downPayment: 0, termMonths: 0,
  });
}
const deposit = (s: SeededCashDealer, quoteId: Id<"quotes">, amount: number) =>
  s.asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId, amount });

describe("the refusal text exists in both languages", () => {
  test("EN equals the server text and AR is present", async () => {
    const { SALE_DEBT_CONTAINMENT_REFUSALS } = await import("./utils/saleDebtContainment");
    const refusals = SALE_DEBT_CONTAINMENT_REFUSALS as Record<string, string>;
    expect(refusals[CODE]).toBeTruthy();
    expect((commonEn as Record<string, string>)[`ServerError_${CODE}`]).toBe(refusals[CODE]);
    expect((commonAr as Record<string, string>)[`ServerError_${CODE}`]).toMatch(/[؀-ۿ]/);
  });
});

describe.each(EXTRAS)("sales.create refuses a CASH sale carrying %s", (_label, extra) => {
  test("coded refusal, AR/EN text, and the full-table snapshot is unchanged (nothing written, no idempotency row)", async () => {
    const s = await seedCashDealer("create", MODULES);
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(s.asUser.mutation(api.sales.create, createArgs(s, extra)));

    expect(refusal?.code).toBe(CODE);
    expect(refusal?.message).toBe((commonEn as Record<string, string>)[`ServerError_${CODE}`]);
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
  });
});

describe.each(EXTRAS)("sales.completeDraft refuses a CASH draft carrying %s", (_label, extra) => {
  test("coded refusal, the draft stays PENDING, and the full-table snapshot is unchanged", async () => {
    const s = await seedCashDealer("draft", MODULES);
    const draftId = await s.asUser.mutation(api.sales.createDraft, { ...createArgs(s, extra), status: undefined } as never);
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(
      s.asUser.mutation(api.sales.completeDraft, { orgId: s.orgId, saleId: draftId, idempotencyKey: crypto.randomUUID() })
    );

    expect(refusal?.code).toBe(CODE);
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
    expect(await s.t.run(async (ctx) => (await ctx.db.get(draftId))?.status)).toBe("PENDING");
  });
});

describe("sales.completeFromQuote and the shared line-item helper", () => {
  test("completeFromQuote carries no tax, fee or warranty by construction: a fully deposited quote completes with none on the sale", async () => {
    const s = await seedCashDealer("quote", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const saleIds = await s.asUser.mutation(api.sales.completeFromQuote, {
      orgId: s.orgId, quoteId, idempotencyKey: crypto.randomUUID(), depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" },
    });
    const sale = await s.t.run((ctx) => ctx.db.get(saleIds[0] as Id<"sales">));
    expect(sale?.status).toBe("COMPLETED");
    for (const field of ["taxAmount", "taxRate", "dealerFees", "warrantySold", "gapSold"] as const) {
      expect(sale?.[field] ?? 0).toBe(0);
    }
  });

  test("the helper completeFromQuote calls refuses a CASH line-item completion that carries tax: nothing written", async () => {
    const s = await seedCashDealer("helper", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(
      s.t.run((ctx) =>
        completeSalesForLineItems(ctx, {
          orgId: s.orgId, quoteId, vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 20_000 }], customerId: s.customerId,
          salespersonId: s.userId, saleDate: Date.now(), taxRate: 5, financingType: "CASH", actorId: s.userId,
        })
      )
    );

    expect(refusal?.code).toBe(CODE);
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
  });
});

describe("ordering and scope of the refusal", () => {
  test("a caller without create:sales gets the permission refusal, not the product refusal (it runs after tenant auth)", async () => {
    const s = await seedCashDealer("auth", MODULES);
    const outsiderId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "outsider", email: "o@example.com", name: "o" }));
    expect(outsiderId).toBeTruthy();
    const asOutsider = s.t.withIdentity({ subject: "outsider", clerkId: "outsider" });
    const refusal = await refusalDataOf(asOutsider.mutation(api.sales.create, createArgs(s, { taxAmount: 1_000 })));
    expect(refusal).not.toBeNull();
    expect(refusal?.code).not.toBe(CODE);
  });

  test("a CASH sale with none of them is not touched by this refusal (control): fully deposited, it completes", async () => {
    const s = await seedCashDealer("control", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const saleId = await s.asUser.mutation(api.sales.create, { ...createArgs(s), quoteId });
    expect(saleId).toBeTruthy();
  });

  test("zero-valued extras are not extras", async () => {
    const s = await seedCashDealer("zero", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const saleId = await s.asUser.mutation(api.sales.create, { ...createArgs(s, { taxAmount: 0, dealerFees: 0, warrantySold: 0 }), quoteId });
    expect(saleId).toBeTruthy();
  });
});

describe("only deposits count toward pay-in-full-first (owner: deposit only; trade-in settlement is a post-pilot gate)", () => {
  test("a trade-in worth the full price, with no deposit, is refused and nothing is written", async () => {
    const s = await seedCashDealer("tradefull", MODULES);
    const trade = await s.mkVehicle("VINTRADE_FULL");
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(
      s.asUser.mutation(api.sales.create, { ...createArgs(s), tradeInVehicleId: trade, tradeInValue: 20_000 })
    );

    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
  });

  test("a part deposit plus a trade-in that together equal the price is refused; the deposit stays held", async () => {
    const s = await seedCashDealer("tradepart", MODULES);
    const trade = await s.mkVehicle("VINTRADE_PART");
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 10_000);
    const before = await dbSnapshot(s.t, ALL_TABLES);

    const refusal = await refusalDataOf(
      s.asUser.mutation(api.sales.create, { ...createArgs(s), quoteId, tradeInVehicleId: trade, tradeInValue: 10_000 })
    );

    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(await dbSnapshot(s.t, ALL_TABLES)).toEqual(before);
  });

  test("the rule is one named constant, pinned OFF, and the gate honours it when flipped (the one-line flip)", async () => {
    const gate = await import("./utils/cashSalePilotGate");
    expect(gate.TRADE_IN_COUNTS_TOWARD_CASH_PAY_FIRST).toBe(false);
    expect(gate.cashSaleOutstandingForPayFirst({ outstandingMinor: 0, tradeInAppliedMinor: 20_000_000 }, false)).toBe(20_000_000);
    expect(gate.cashSaleOutstandingForPayFirst({ outstandingMinor: 0, tradeInAppliedMinor: 20_000_000 }, true)).toBe(0);
  });
});

describe("the extras switch", () => {
  test("is a compile-time constant pinned ON, and the pure guard is a no-op when it is flipped (the mutation the attack file runs end to end)", async () => {
    const real = await vi.importActual<typeof import("./utils/saleDebtContainment")>("./utils/saleDebtContainment");
    expect((real as Record<string, unknown>).CASH_SALE_EXTRAS_PILOT_REFUSED).toBe(true);
    const gate = await import("./utils/cashSalePilotGate");
    expect(() => gate.assertCashSaleCarriesNoExtras({ financingType: "CASH", taxAmount: 1 }, true)).toThrow();
    expect(() => gate.assertCashSaleCarriesNoExtras({ financingType: "CASH", taxAmount: 1 }, false)).not.toThrow();
    expect(() => gate.assertCashSaleCarriesNoExtras({ financingType: "FINANCED", taxAmount: 1 }, true)).not.toThrow();
    expect(() => gate.assertCashSaleCarriesNoExtras({ financingType: "CASH", financedSalePlan: {}, dealerFees: 5 }, true)).not.toThrow();
  });
});
