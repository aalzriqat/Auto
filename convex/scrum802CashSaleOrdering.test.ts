/**
 * SCRUM-802 ordering (Codex Seat 2 on #526): the pay-first refusal, including the trade-in case, must come BEFORE the
 * first sale write on every completion path, not merely be rolled back by the transaction (the standard of #525).
 * Precisely: at the three door mutations (`sales.create`, `sales.completeDraft`, `sales.completeFromQuote`) the
 * idempotency claim row is written first and rolled back by the transaction when the completion refuses; the extras
 * refusal sits before `runWithIdempotency`. The recorder here wraps the shared completion functions, so it proves
 * "no write before the refusal" from that point on.
 *
 * A write-recording db and scheduler wrap the context handed to the shared completion functions
 * (`completeSale`, `completeExistingSale`, `completeSalesForLineItems`); a refused completion must have recorded NO
 * write at all. The pre-check is the EXACT unpaid-balance check (it derives what the deposit resolution would apply to
 * the invoice), so the cells include a fully deposited sale whose deposit is stated as refunded, forfeited or OTHER, a
 * deposit already refunded or forfeited, and a part deposit. Mutation-checked: disabling the pre-check turns every
 * refusal cell red; the control cells, which complete a sale, stay green by design (they prove the recorder sees real
 * writes and that the pre-check does not over-refuse).
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

  // Codex batch 3: the pre-check must be the EXACT unpaid-balance check, not "could a deposit cover the invoice". A
  // deposit that is fully allocated but then forfeited, refunded or set aside (OTHER) never reaches the invoice.
  describe.each([
    ["REFUND_TO_CUSTOMER", { treatment: "REFUND_TO_CUSTOMER", refundMethod: "CASH" }],
    ["FORFEITED", { treatment: "FORFEITED" }],
    ["OTHER (with a reason)", { treatment: "OTHER", reason: "manager-approved arrangement" }],
  ] as const)("a fully deposited cash sale whose deposit is stated as %s", (_label, depositResolution) => {
    test("completeSale is refused on the unpaid balance with zero writes", async () => {
      const s = await seedCashDealer(`ordt${_label.length}${_label[0]}`, MODULES);
      const quoteId = await quoteFor(s);
      await deposit(s, quoteId, 20_000);
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) => completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId, depositResolution })))
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });

    test("completeExistingSale (a draft) is refused with zero writes", async () => {
      const s = await seedCashDealer(`ordd${_label.length}${_label[0]}`, MODULES);
      const quoteId = await quoteFor(s);
      await deposit(s, quoteId, 20_000);
      const draftId = await s.asUser.mutation(api.sales.createDraft, {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000, saleDate: Date.now(),
        financingType: "CASH", idempotencyKey: crypto.randomUUID(),
      } as never);
      // The draft door takes no quote; completing a draft that is bound to one is the shape under test.
      await s.t.run((ctx) => ctx.db.patch(draftId, { quoteId }));
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) =>
          completeExistingSale(recordingCtx(asMutationCtx(ctx), writes), { orgId: s.orgId, saleId: draftId, actorId: s.userId, depositResolution })
        )
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });

    test("completeSalesForLineItems refuses a single funded car with zero writes", async () => {
      const s = await seedCashDealer(`ordl${_label.length}${_label[0]}`, MODULES);
      const quoteId = await quoteFor(s);
      await deposit(s, quoteId, 20_000);
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) =>
          completeSalesForLineItems(recordingCtx(asMutationCtx(ctx), writes), {
            orgId: s.orgId, quoteId, vehicleItems: [{ vehicleId: s.vehicleId, unitPrice: 20_000 }],
            customerId: s.customerId, salespersonId: s.userId, saleDate: Date.now(), financingType: "CASH", actorId: s.userId,
            depositResolution,
          })
        )
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });
  });

  // Codex Seat 2 (dffcd464): on a SHARED (allocated multi-car) deposit these treatments pay nothing either, so the unpaid
  // balance is refused before the sale row is inserted rather than left to the completion's own later refusal.
  describe.each([
    ["REFUND_TO_CUSTOMER", { treatment: "REFUND_TO_CUSTOMER", refundMethod: "CASH" }],
    ["FORFEITED", { treatment: "FORFEITED" }],
    ["OTHER (with a reason)", { treatment: "OTHER", reason: "manager-approved arrangement" }],
    ["OTHER (no reason)", { treatment: "OTHER" }],
  ] as const)("a fully allocated two-car deposit whose treatment is stated as %s", (label, depositResolution) => {
    async function twoCarQuote(tag: string) {
      const s = await seedCashDealer(`ordsh${tag}`, MODULES);
      const second = await s.mkVehicle(`VINSH${tag}`, { purchasePrice: 17000 });
      const items = [{ vehicleId: s.vehicleId, unitPrice: 20_000 }, { vehicleId: second, unitPrice: 20_000 }];
      const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
        orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 40_000, downPayment: 0, termMonths: 0,
        vehicleItems: items,
      });
      await deposit(s, quoteId, 40_000);
      await s.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: s.orgId, quoteId, allocations: [{ vehicleId: s.vehicleId, amount: 20_000 }, { vehicleId: second, amount: 20_000 }],
      });
      return { s, quoteId, items };
    }
    const tag = label.replace(/[^A-Za-z]/g, "").slice(0, 12);

    test("completeSale is refused on the unpaid balance with zero writes", async () => {
      const { s, quoteId } = await twoCarQuote(`a${tag}`);
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) => completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId, depositResolution })))
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });

    test("completeExistingSale (a draft bound to the shared quote) is refused with zero writes", async () => {
      const { s, quoteId } = await twoCarQuote(`d${tag}`);
      const draftId = await s.asUser.mutation(api.sales.createDraft, {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId, salePrice: 20_000, saleDate: Date.now(),
        financingType: "CASH", idempotencyKey: crypto.randomUUID(),
      } as never);
      // The draft door takes no quote; completing a draft that is bound to one is the shape under test. `sales.createDraft`
      // takes no `quoteId` (SCRUM-425), so this is a legacy / defence-in-depth shape, not a path a user can reach.
      await s.t.run((ctx) => ctx.db.patch(draftId, { quoteId }));
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) =>
          completeExistingSale(recordingCtx(asMutationCtx(ctx), writes), { orgId: s.orgId, saleId: draftId, actorId: s.userId, depositResolution })
        )
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });

    test("completeSalesForLineItems is refused for BOTH cars with zero writes", async () => {
      const { s, quoteId, items } = await twoCarQuote(`b${tag}`);
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) =>
          completeSalesForLineItems(recordingCtx(asMutationCtx(ctx), writes), {
            orgId: s.orgId, quoteId, vehicleItems: items, customerId: s.customerId, salespersonId: s.userId,
            saleDate: Date.now(), financingType: "CASH", actorId: s.userId, depositResolution,
          })
        )
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });
  });

  // Shared allocation at minor-unit precision (JOD has 3 decimals): prices and shares that do not divide evenly. One
  // minor unit short on either car refuses the whole completion; exact shares complete both cars.
  describe("a shared two-car deposit allocated at minor-unit precision", () => {
    const PRICE_A = 20_000.001;
    const PRICE_B = 10_000.003;
    async function oddQuote(tag: string, shareA: number, shareB: number) {
      const s = await seedCashDealer(`ordodd${tag}`, MODULES);
      const second = await s.mkVehicle(`VINODD${tag}`, { purchasePrice: 17000 });
      const items = [{ vehicleId: s.vehicleId, unitPrice: PRICE_A }, { vehicleId: second, unitPrice: PRICE_B }];
      const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
        orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 30_000.004, downPayment: 0, termMonths: 0,
        vehicleItems: items,
      });
      await deposit(s, quoteId, Math.round((shareA + shareB) * 1000) / 1000);
      await s.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: s.orgId, quoteId, allocations: [{ vehicleId: s.vehicleId, amount: shareA }, { vehicleId: second, amount: shareB }],
      });
      const run = (writes: string[], treatment?: "APPLY_TO_DEALER_AMOUNT") =>
        s.t.run((ctx) =>
          completeSalesForLineItems(recordingCtx(asMutationCtx(ctx), writes), {
            orgId: s.orgId, quoteId, vehicleItems: items, customerId: s.customerId, salespersonId: s.userId,
            saleDate: Date.now(), financingType: "CASH", actorId: s.userId, ...(treatment ? { depositResolution: { treatment } } : {}),
          })
        );
      return { s, run };
    }

    test.each([
      ["the first car", 20_000.0, PRICE_B],
      ["the second car", PRICE_A, 10_000.002],
    ])("one minor unit short on %s refuses the whole completion with zero writes", async (label, shareA, shareB) => {
      const { run } = await oddQuote(`short${label.length}`, shareA, shareB);
      const writes: string[] = [];
      const refusal = await refusalDataOf(run(writes, "APPLY_TO_DEALER_AMOUNT"));
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    });

    test("control: exact shares complete both cars (the pre-check does not over-refuse at minor-unit precision)", async () => {
      const { run } = await oddQuote("exact", PRICE_A, PRICE_B);
      const writes: string[] = [];
      const saleIds = await run(writes, "APPLY_TO_DEALER_AMOUNT");
      expect(saleIds).toHaveLength(2);
      expect(writes.length).toBeGreaterThan(0);
    });
  });

  test.each([
    ["no stated treatment", undefined],
    ["APPLY_TO_DEALER_AMOUNT", { treatment: "APPLY_TO_DEALER_AMOUNT" as const }],
  ])("control: a fully paying shared two-car allocation (%s) still completes both cars", async (label, depositResolution) => {
    const s = await seedCashDealer(`ordshok${label.length}`, MODULES);
    const second = await s.mkVehicle(`VINSHOK${label.length}`, { purchasePrice: 17000 });
    const items = [{ vehicleId: s.vehicleId, unitPrice: 20_000 }, { vehicleId: second, unitPrice: 20_000 }];
    const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: 40_000, downPayment: 0, termMonths: 0,
      vehicleItems: items,
    });
    await deposit(s, quoteId, 40_000);
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId, quoteId, allocations: [{ vehicleId: s.vehicleId, amount: 20_000 }, { vehicleId: second, amount: 20_000 }],
    });
    const writes: string[] = [];
    const saleIds = await s.t.run((ctx) =>
      completeSalesForLineItems(recordingCtx(asMutationCtx(ctx), writes), {
        orgId: s.orgId, quoteId, vehicleItems: items, customerId: s.customerId, salespersonId: s.userId,
        saleDate: Date.now(), financingType: "CASH", actorId: s.userId, ...(depositResolution ? { depositResolution } : {}),
      })
    );
    expect(saleIds).toHaveLength(2);
    expect(writes.length).toBeGreaterThan(0);
  });

  test("completeSale: a part deposit (no trade-in) is refused with zero writes", async () => {
    const s = await seedCashDealer("ordpartonly", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 12_000);
    const writes: string[] = [];
    const refusal = await refusalDataOf(
      s.t.run((ctx) =>
        completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId, depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" } }))
      )
    );
    expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
    expect(writes).toEqual([]);
  });

  test.each(["REFUNDED", "FORFEITED"] as const)(
    "completeSale: a deposit already %s before the completion is no longer held and cannot pay the invoice (zero writes)",
    async (resolution) => {
      const s = await seedCashDealer(`ordgone${resolution[0]}`, MODULES);
      const quoteId = await quoteFor(s);
      await deposit(s, quoteId, 20_000);
      const depositId = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0]._id;
      // Not under test: the deposit screen's release; the row just has to leave the held state first.
      await s.t.run((ctx) => ctx.db.patch(depositId, { status: resolution, holdActive: false }));
      const writes: string[] = [];
      const refusal = await refusalDataOf(
        s.t.run((ctx) =>
          completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId, depositResolution: { treatment: "APPLY_TO_DEALER_AMOUNT" } }))
        )
      );
      expect(refusal?.code).toBe("CASH_SALE_BALANCE_UNPAID_REFUSED");
      expect(writes).toEqual([]);
    }
  );

  test("control: APPLY_TO_TRANSACTION_SETTLEMENT on owned stock with the full deposit still completes (the pre-check does not over-refuse)", async () => {
    const s = await seedCashDealer("ordsettle", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const writes: string[] = [];
    const saleId = await s.t.run((ctx) =>
      completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId, depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" } }))
    );
    expect(saleId).toBeTruthy();
    expect(writes.length).toBeGreaterThan(0);
  });

  test("control: no stated treatment and an exact deposit completes", async () => {
    const s = await seedCashDealer("ordnotreat", MODULES);
    const quoteId = await quoteFor(s);
    await deposit(s, quoteId, 20_000);
    const writes: string[] = [];
    const saleId = await s.t.run((ctx) => completeSale(recordingCtx(asMutationCtx(ctx), writes), completionArgs(s, { quoteId })));
    expect(saleId).toBeTruthy();
    expect(writes.length).toBeGreaterThan(0);
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
