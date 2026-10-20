/**
 * SCRUM-802 ordering (Codex Seat 2 on #526): the pay-first refusal, including the trade-in case, must come BEFORE the
 * first write on every completion path, not merely be rolled back by the transaction (the standard of #525).
 *
 * A write-recording db and scheduler wrap the context handed to the shared completion functions
 * (`completeSale`, `completeExistingSale`, `completeSalesForLineItems`); a refused completion must have recorded NO
 * write at all. The control proves the recorder sees real writes when a sale does complete.
 *
 * Real switch (nothing here mocks the gate; the census pins that). Evidence boundary: convex-test, not production.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { seedCashDealer, type SeededCashDealer } from "../test-utils/cashDealerFixture";
import { completeExistingSale, completeSale, completeSalesForLineItems } from "./utils/saleCompletion";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

function recordingCtx(ctx: MutationCtx, writes: string[]): MutationCtx {
  const WRITES = new Set(["insert", "patch", "replace", "delete"]);
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (WRITES.has(String(prop))) {
        return (...args: unknown[]) => {
          writes.push(`db.${String(prop)}(${String(args[0])})`);
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  const scheduler = new Proxy(ctx.scheduler, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        writes.push(`scheduler.${String(prop)}`);
        return value.apply(target, args);
      };
    },
  });
  return new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === "db") return db;
      if (prop === "scheduler") return scheduler;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const asMutationCtx = (ctx: unknown): MutationCtx => ctx as MutationCtx;

async function quoteFor(s: SeededCashDealer, price = 20_000) {
  return await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: price, downPayment: 0, termMonths: 0,
  });
}
const deposit = (s: SeededCashDealer, quoteId: Id<"quotes">, amount: number) =>
  s.asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, quoteId, amount });

const completionArgs = (s: SeededCashDealer, over: Record<string, unknown> = {}) => ({
  orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000,
  saleDate: Date.now(), status: "COMPLETED" as const, financingType: "CASH" as const, actorId: s.userId, ...over,
});

describe("the pay-first refusal is raised before the first write on every completion path", () => {
  test("completeSale: a part deposit plus a trade-in is refused with zero writes", async () => {
    const s = await seedCashDealer("ordpart", MODULES);
    const trade = await s.mkVehicle("VINORD_PART");
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 10_000);
    const writes: string[] = [];
    const refusal = await refusalDataOf(
      s.t.run((ctx) =>
        completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId, tradeInVehicleId: trade, tradeInValue: 10_000 }))
      )
    );
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(writes).toEqual([]);
  });

  test("completeSale: a trade-in alone, with no quote and no deposit, is refused with zero writes", async () => {
    const s = await seedCashDealer("ordtrade", MODULES);
    const trade = await s.mkVehicle("VINORD_TRADE");
    const writes: string[] = [];
    const refusal = await refusalDataOf(
      s.t.run((ctx) =>
        completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { tradeInVehicleId: trade, tradeInValue: 20_000 }))
      )
    );
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(writes).toEqual([]);
  });

  test("completeSale: an unpaid cash sale with no trade-in is refused with zero writes too", async () => {
    const s = await seedCashDealer("ordnone", MODULES);
    const writes: string[] = [];
    const refusal = await refusalDataOf(
      s.t.run((ctx) => completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s)))
    );
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(writes).toEqual([]);
  });

  test("completeExistingSale (a draft carrying a trade-in) is refused with zero writes", async () => {
    const s = await seedCashDealer("orddraft", MODULES);
    const trade = await s.mkVehicle("VINORD_DRAFT");
    const draftId = await s.asUser.mutation(api.sales.createDraft, {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000, saleDate: Date.now(),
      financingType: "CASH", tradeInVehicleId: trade, tradeInValue: 20_000, idempotencyKey: crypto.randomUUID(),
    } as never);
    const writes: string[] = [];
    const refusal = await refusalDataOf(
      s.t.run((ctx) => completeExistingSale(recordingCtx(asMutationCtx(ctx), writes), { orgId: s.orgId, saleId: draftId, actorId: s.userId }))
    );
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(writes).toEqual([]);
  });

  test("completeSalesForLineItems: a funded first car and a short second car record no write for EITHER car", async () => {
    const s = await seedCashDealer("ordmulti", MODULES);
    const second = await s.mkVehicle("VINORD_MULTI2", { purchasePrice: 17000 });
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 40_000, downPayment: 0, termMonths: 0,
      vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 20_000 }, { vehicleId: second, unitPrice: 20_000 }],
    });
    await deposit(s, quoteId, 25_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId, allocations: [{ vehicleId: s.vehicleId, amount: 20_000 }, { vehicleId: second, amount: 5_000 }],
    });
    const writes: string[] = [];
    const refusal = await refusalDataOf(
      s.t.run((ctx) =>
        completeSalesForLineItems(recordingCtx(asMutationCtx(ctx), writes), {
          orgId: s.orgId, quoteId, vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 20_000 }, { vehicleId: second, unitPrice: 20_000 }],
          customerId: s.customerId, salespersonId: s.userId, saleDate: Date.now(), financingType: "CASH", actorId: s.userId,
          depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" },
        })
      )
    );
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(writes).toEqual([]);
  });

  test("control: a fully deposited cash sale still completes through the same recording context (the recorder sees real writes)", async () => {
    const s = await seedCashDealer("ordok", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const writes: string[] = [];
    const saleId = await s.t.run((ctx) =>
      completeSale(
        recordingCtx(asMutationCtx(ctx), writes),
        completionArgs(s, { quoteId, depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" } })
      )
    );
    expect(saleId).toBeTruthy();
    expect(writes.length).toBeGreaterThan(0); // anti-vacuity: an empty list above would otherwise prove nothing
  });
});
