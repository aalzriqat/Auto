/**
 * SCRUM-555 part 5 - `subledger.ts` and `utils/saleCancellation.ts` read through
 * indexes instead of query field predicates. Only the READ MECHANISM changed:
 * which rows are chosen, in what order, and every refusal must be exactly what
 * it was.
 *
 * These are characterization tests. They pass on the pre-image (query
 * `.filter(...)`) and on the post-image (index read + in-memory narrowing).
 * Non-matching rows are always inserted FIRST so a first-match / ordering
 * regression would be visible.
 *
 * Sites, by entrypoint:
 *   subledger.ts
 *     1. getReceivableOutstandingMinor  (via the public query getReceivableBalance
 *        and the allocate-over-outstanding refusal)  - ACTIVE allocations only.
 *     2. getPaymentUnappliedMinor        (via the public query getPaymentBalance)
 *        - ACTIVE allocations only.
 *     3. voidCanonicalPayment            - refused only while an ACTIVE allocation
 *        remains.
 *   utils/saleCancellation.ts, all via cancelCompletedSaleOperationalRecords
 *     4. getActiveReceivableAllocations  - only ACTIVE allocations are counted
 *        (blocked when foreign, reversed when safe).
 *     5. assertTradeInVehicleSafeToReverse - a live CAPITALIZED_INVENTORY expense
 *        refuses; deleted / other-treatment rows never do.
 *     6. reinstateAppliedDeposits legacy path - only APPLIED deposits reopen.
 *     7. voidSaleCashflowTransaction     - soft-deleted `transactions` rows are
 *        left alone, live ones with the sale's id are voided.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import {
  allocatePaymentToReceivable,
  createCanonicalPayment,
  createReceivableDocument,
  reverseAllocation,
  voidCanonicalPayment,
} from "./subledger";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";

const MODULES = import.meta.glob("./**/*.*s");

let vinCounter = 5000;
let keyCounter = 0;

async function seed() {
  const t = convexTestWithComponents(schema, MODULES);
  const now = Date.now();
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "IdxReads SubledgerCancel Dealer", createdAt: now })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: "idx_subledger_user",
      email: "idx.subledger@example.com",
      name: "Idx Subledger User",
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: now + 30 * 24 * 60 * 60 * 1000,
      createdAt: now,
      updatedAt: now,
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Idx", lastName: "Customer", phone: "+962790000555" })
  );
  return {
    t,
    orgId,
    userId,
    customerId,
    asUser: t.withIdentity({ subject: "idx_subledger_user", clerkId: "idx_subledger_user" }),
  };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function insertVehicle(
  s: Seed,
  status: "AVAILABLE" | "SOLD" = "AVAILABLE"
): Promise<Id<"vehicles">> {
  vinCounter += 1;
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId,
      vin: `5HGCM82633A${String(vinCounter).slice(0, 6)}`,
      make: "Mazda",
      model: "CX-5",
      year: 2023,
      color: "Red",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 100,
      sellingPrice: 30_000,
      status,
      createdAt: Date.now(),
    })
  );
}

async function insertReceivable(s: Seed, amountMinor: number) {
  keyCounter += 1;
  const now = Date.now();
  return await s.t.run((ctx) =>
    createReceivableDocument(ctx, {
      orgId: s.orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId: s.customerId,
      sourceType: "idx_reads_invoice",
      sourceId: `idx-reads-${keyCounter}`,
      originalAmountMinor: amountMinor,
      currency: "JOD",
      issueDate: now,
      dueDate: now + 7 * 24 * 60 * 60 * 1000,
      actorId: s.userId,
    })
  );
}

async function insertPayment(s: Seed, amountMinor: number, idempotencyKey?: string) {
  keyCounter += 1;
  return await s.t.run((ctx) =>
    createCanonicalPayment(ctx, {
      orgId: s.orgId,
      direction: "IN",
      customerId: s.customerId,
      method: "CASH",
      amountMinor,
      currency: "JOD",
      idempotencyKey: idempotencyKey ?? `idx-reads-payment-${keyCounter}`,
      actorId: s.userId,
    })
  );
}

const allocate = (
  s: Seed,
  paymentId: Id<"canonicalPayments">,
  receivableDocumentId: Id<"receivableDocuments">,
  amountMinor: number
) =>
  s.t.run((ctx) =>
    allocatePaymentToReceivable(ctx, {
      orgId: s.orgId,
      paymentId,
      receivableDocumentId,
      amountMinor,
      actorId: s.userId,
    })
  );

const reverse = (s: Seed, allocationId: Id<"paymentAllocations">) =>
  s.t.run((ctx) => reverseAllocation(ctx, { orgId: s.orgId, allocationId, actorId: s.userId }));

describe("subledger.ts balances and void guard", () => {
  test("receivable outstanding and payment unapplied balance ignore REVERSED allocations", async () => {
    const s = await seed();
    const receivableId = await insertReceivable(s, 100_000);
    const paymentId = await insertPayment(s, 60_000);

    // REVERSED rows first (original + its reversal row), ACTIVE row last.
    const first = await allocate(s, paymentId, receivableId, 30_000);
    await reverse(s, first);
    await allocate(s, paymentId, receivableId, 20_000);

    const receivable = await s.asUser.query(api.subledger.getReceivableBalance, {
      orgId: s.orgId,
      receivableDocumentId: receivableId,
    });
    expect(receivable?.outstandingMinor).toBe(80_000);

    const payment = await s.asUser.query(api.subledger.getPaymentBalance, {
      orgId: s.orgId,
      paymentId,
    });
    expect(payment?.unappliedMinor).toBe(40_000);

    // The balances are the real guards: 40_000 unapplied admits exactly 40_000.
    await expect(allocate(s, paymentId, receivableId, 40_001)).rejects.toThrow(
      /exceeds unapplied payment balance 40000/
    );
    await expect(allocate(s, paymentId, receivableId, 40_000)).resolves.toBeTruthy();
    const after = await s.asUser.query(api.subledger.getReceivableBalance, {
      orgId: s.orgId,
      receivableDocumentId: receivableId,
    });
    expect(after?.outstandingMinor).toBe(40_000);
  });

  test("allocation over the receivable's outstanding balance is refused using ACTIVE rows only", async () => {
    const s = await seed();
    const receivableId = await insertReceivable(s, 50_000);
    const paymentId = await insertPayment(s, 200_000);

    const first = await allocate(s, paymentId, receivableId, 50_000);
    await reverse(s, first);
    // Fully reversed -> the whole 50_000 is outstanding again.
    await expect(allocate(s, paymentId, receivableId, 50_001)).rejects.toThrow(
      /exceeds receivable outstanding balance 50000/
    );
    await allocate(s, paymentId, receivableId, 30_000);
    await expect(allocate(s, paymentId, receivableId, 20_001)).rejects.toThrow(
      /exceeds receivable outstanding balance 20000/
    );
  });

  test("void is refused while an ACTIVE allocation exists and allowed once all are REVERSED", async () => {
    const s = await seed();
    const receivableId = await insertReceivable(s, 100_000);
    const paymentId = await insertPayment(s, 60_000);

    const a1 = await allocate(s, paymentId, receivableId, 10_000);
    await reverse(s, a1);
    const a2 = await allocate(s, paymentId, receivableId, 20_000);

    const voidIt = () =>
      s.t.run((ctx) =>
        voidCanonicalPayment(ctx, { orgId: s.orgId, paymentId, actorId: s.userId })
      );
    await expect(voidIt()).rejects.toThrow(/Cannot void a payment with active allocations/);
    expect((await s.t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("SETTLED");

    await reverse(s, a2);
    await voidIt();
    expect((await s.t.run((ctx) => ctx.db.get(paymentId)))?.status).toBe("VOIDED");
  });
});

interface SaleOptions {
  tradeInVehicleId?: Id<"vehicles">;
  tradeInValue?: number;
  quoteId?: Id<"quotes">;
  receivableId?: Id<"receivableDocuments">;
}

async function insertSale(s: Seed, options: SaleOptions = {}) {
  const vehicleId = await insertVehicle(s);
  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId,
      vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 30_000,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
      tradeInVehicleId: options.tradeInVehicleId,
      tradeInValue: options.tradeInValue,
      quoteId: options.quoteId,
      canonicalReceivableDocumentId: options.receivableId,
    })
  );
  return { saleId, vehicleId };
}

const cancelSale = (s: Seed, saleId: Id<"sales">) =>
  s.t.run(async (ctx) => {
    const sale = (await ctx.db.get(saleId))!;
    await cancelCompletedSaleOperationalRecords(ctx, {
      orgId: s.orgId,
      sale,
      actorId: s.userId,
      reason: "cancelled in test",
      reversalDate: Date.now(),
    });
  });

describe("saleCancellation.ts: receivable allocations", () => {
  /**
   * A tradeInVehicleId with no tradeInValue makes `trade_in_payment_<saleId>` a
   * safely reversible key without running the trade-in restore branch.
   */
  async function saleWithReceivable(s: Seed) {
    const receivableId = await insertReceivable(s, 100_000);
    const tradeInVehicleId = await insertVehicle(s);
    // Sale id is needed for the key, so insert the sale first without the
    // receivable link and patch it on afterwards.
    const { saleId } = await insertSale(s, { tradeInVehicleId });
    await s.t.run((ctx) => ctx.db.patch(saleId, { canonicalReceivableDocumentId: receivableId }));
    return { saleId, receivableId };
  }

  test("only ACTIVE allocations are reversed; earlier REVERSED rows are neither counted nor re-reversed", async () => {
    const s = await seed();
    const { saleId, receivableId } = await saleWithReceivable(s);
    const paymentId = await insertPayment(s, 60_000, `trade_in_payment_${saleId}`);

    const first = await allocate(s, paymentId, receivableId, 30_000);
    await reverse(s, first); // REVERSED rows sit first in index order
    await allocate(s, paymentId, receivableId, 20_000);

    await cancelSale(s, saleId);

    const receivable = await s.t.run((ctx) => ctx.db.get(receivableId));
    expect(receivable?.status).toBe("CANCELLED");
    const rows = await s.t.run((ctx) =>
      ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableId))
        .collect()
    );
    // original + its reversal, second allocation + its reversal.
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(0);
  });

  test("a foreign payment's REVERSED allocation does not block the cancellation", async () => {
    const s = await seed();
    const { saleId, receivableId } = await saleWithReceivable(s);
    const foreignPaymentId = await insertPayment(s, 60_000, "customer_cash_receipt_1");
    const foreign = await allocate(s, foreignPaymentId, receivableId, 10_000);
    await reverse(s, foreign);

    await cancelSale(s, saleId);
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("CANCELLED");
  });

  test("a foreign payment's ACTIVE allocation refuses the cancellation and changes nothing", async () => {
    const s = await seed();
    const { saleId, receivableId } = await saleWithReceivable(s);
    const safePaymentId = await insertPayment(s, 60_000, `trade_in_payment_${saleId}`);
    const foreignPaymentId = await insertPayment(s, 60_000, "customer_cash_receipt_2");
    const safe = await allocate(s, safePaymentId, receivableId, 10_000);
    await reverse(s, safe);
    await allocate(s, foreignPaymentId, receivableId, 10_000);

    await expect(cancelSale(s, saleId)).rejects.toThrow(
      /Cannot automatically cancel a sale with customer payments already applied/
    );
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).not.toBe("CANCELLED");
  });
});

describe("saleCancellation.ts: trade-in capitalized expense guard", () => {
  async function tradeInSale(s: Seed) {
    const tradeInVehicleId = await insertVehicle(s);
    const { saleId } = await insertSale(s, { tradeInVehicleId, tradeInValue: 5_000 });
    return { saleId, tradeInVehicleId };
  }

  const expense = (
    s: Seed,
    vehicleId: Id<"vehicles">,
    extra: {
      accountingTreatment?: "CAPITALIZED_INVENTORY" | "PERIOD_EXPENSE";
      isDeleted?: boolean;
    }
  ) =>
    s.t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId: s.orgId,
        vehicleId,
        title: "Prep",
        amount: 100,
        date: Date.now(),
        category: "REPAIR",
        ...extra,
      })
    );

  test("deleted and other-treatment rows (first in index order) do not refuse the reversal", async () => {
    const s = await seed();
    const { saleId, tradeInVehicleId } = await tradeInSale(s);
    await expense(s, tradeInVehicleId, { accountingTreatment: "CAPITALIZED_INVENTORY", isDeleted: true });
    await expense(s, tradeInVehicleId, { accountingTreatment: "PERIOD_EXPENSE" });
    await expense(s, tradeInVehicleId, {});

    await cancelSale(s, saleId);
    const vehicle = await s.t.run((ctx) => ctx.db.get(tradeInVehicleId));
    expect(vehicle?.status).toBe("IN_INSPECTION");
  });

  test("a live CAPITALIZED_INVENTORY row after non-matching ones refuses the reversal", async () => {
    const s = await seed();
    const { saleId, tradeInVehicleId } = await tradeInSale(s);
    await expense(s, tradeInVehicleId, { accountingTreatment: "CAPITALIZED_INVENTORY", isDeleted: true });
    await expense(s, tradeInVehicleId, { accountingTreatment: "PERIOD_EXPENSE" });
    await expense(s, tradeInVehicleId, { accountingTreatment: "CAPITALIZED_INVENTORY" });

    await expect(cancelSale(s, saleId)).rejects.toThrow(/received capitalized repair\/prep costs/);
    const vehicle = await s.t.run((ctx) => ctx.db.get(tradeInVehicleId));
    expect(vehicle?.status).toBe("AVAILABLE");
  });
});

describe("saleCancellation.ts: legacy applied deposits", () => {
  async function quoteFor(s: Seed, vehicleId: Id<"vehicles">) {
    return await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId,
        customerId: s.customerId,
        vehicleId,
        vehiclePrice: 30_000,
        downPayment: 0,
        termMonths: 12,
        status: "ACCEPTED" as const,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );
  }

  const deposit = (
    s: Seed,
    vehicleId: Id<"vehicles">,
    quoteId: Id<"quotes">,
    status: "HELD" | "APPLIED" | "REFUNDED" | "FORFEITED"
  ) =>
    s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId,
        vehicleId,
        customerId: s.customerId,
        quoteId,
        amount: 1_000,
        status,
        holdActive: false,
        usesVehicleHoldRows: false,
        createdBy: s.userId,
        createdAt: Date.now(),
      })
    );

  test("only APPLIED deposits of the quote are reinstated", async () => {
    const s = await seed();
    const saleVehicleId = await insertVehicle(s);
    const quoteId = await quoteFor(s, saleVehicleId);
    // Non-APPLIED rows first.
    const refunded = await deposit(s, saleVehicleId, quoteId, "REFUNDED");
    const forfeited = await deposit(s, saleVehicleId, quoteId, "FORFEITED");
    const applied = await deposit(s, saleVehicleId, quoteId, "APPLIED");

    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: saleVehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 30_000,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        quoteId,
      })
    );

    await cancelSale(s, saleId);

    const get = (id: Id<"deposits">) => s.t.run((ctx) => ctx.db.get(id));
    expect((await get(applied))?.status).toBe("HELD");
    expect((await get(refunded))?.status).toBe("REFUNDED");
    expect((await get(forfeited))?.status).toBe("FORFEITED");
  });
});

describe("saleCancellation.ts: cashflow transaction void", () => {
  const txn = (
    s: Seed,
    saleId: Id<"sales">,
    extra: { isDeleted?: boolean; withSale?: boolean } = {}
  ) =>
    s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId,
        type: "IN",
        amount: 30_000,
        date: Date.now(),
        category: "VEHICLE_SALE",
        description: "sale",
        ...(extra.withSale === false ? {} : { saleId }),
        ...(extra.isDeleted !== undefined ? { isDeleted: extra.isDeleted } : {}),
      })
    );

  test("soft-deleted rows keep their original deletion; live rows of the sale are voided; unstamped rows are untouched", async () => {
    const s = await seed();
    const { saleId } = await insertSale(s);
    const alreadyDeleted = await txn(s, saleId, { isDeleted: true });
    const unstamped = await txn(s, saleId, { withSale: false });
    const live = await txn(s, saleId);
    const explicitFalse = await txn(s, saleId, { isDeleted: false });

    const deletedBefore = await s.t.run((ctx) => ctx.db.get(alreadyDeleted));
    await cancelSale(s, saleId);

    const get = (id: Id<"transactions">) => s.t.run((ctx) => ctx.db.get(id));
    expect(await get(alreadyDeleted)).toEqual(deletedBefore); // not re-stamped
    expect((await get(unstamped))?.isDeleted).toBeUndefined();
    expect((await get(live))?.isDeleted).toBe(true);
    expect((await get(explicitFalse))?.isDeleted).toBe(true);
  });
});
