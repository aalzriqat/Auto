/**
 * What happens to the customer's reservation deposit (عربون) on a consigned
 * sale.
 *
 * The reservation deposit is money paid to the DEALERSHIP against its own
 * receipt voucher. It is a liability from the moment it is taken, and closing a
 * deal is not by itself a reason to recognize it as income. It is also NOT the
 * financing down payment — that is a separate amount the customer pays to the
 * finance company, which never passes through these books. Nothing here may
 * move one into the other.
 *
 * On a dealer-owned sale "applied" has only ever meant one thing: the customer
 * owes the dealership the whole price, so the deposit comes off it. On a
 * consigned sale it means nothing on its own, because what the customer owes
 * the dealership depends on which way the money went — and on DIRECT_TO_SUPPLIER
 * it can be nothing at all. So the treatment has to be stated.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { depositStatusForTreatment } from "./utils/depositHelpers";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:deposits", "create:deposits", "manage:deposits",
  "approve:requests",
];

const SALE_PRICE = 12_500;
const SUPPLIER_ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - SUPPLIER_ENTITLEMENT;
const DEPOSIT = 1_000;
const SCALE = 1000; // JOD minor units

type Treatment =
  | "APPLY_TO_DEALER_AMOUNT"
  | "APPLY_TO_TRANSACTION_SETTLEMENT"
  | "REFUND_TO_CUSTOMER"
  | "FORFEITED"
  | "OTHER";

const SALES_ONLY_PERMS = PERMS.filter((p) => p !== "approve:requests");

async function seed(
  tag: string,
  opts: {
    sourceType?: "SOURCED" | "STOCK";
    sourceCost?: number;
    /** Lets a test strip the approval permission from the second actor. */
    managerPermissions?: string[];
  } = {}
) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Dep ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Dep User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  // A second member: cancelling a sale is refused for the salesperson who made
  // it, so the approval has to come from somebody else.
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_m`, email: `${tag}m@e.com`, name: "Manager" })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Manager",
      permissions: opts.managerPermissions ?? PERMS,
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
  );
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
  const sourceType = opts.sourceType ?? "SOURCED";
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINDEP${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE",
      sourceType,
      ...(sourceType === "SOURCED"
        ? { sourcedFromName: "Amman Importer Co", sourceCost: opts.sourceCost ?? SUPPLIER_ENTITLEMENT }
        : { purchasePrice: SUPPLIER_ENTITLEMENT }),
    })
  );

  // A quote carrying an actively-held reservation deposit — the shape sale
  // completion actually reads.
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: SALE_PRICE,
      downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );
  const depositId = await t.run((ctx) =>
    ctx.db.insert("deposits", {
      orgId, vehicleId, customerId, quoteId,
      amount: DEPOSIT, amountMinor: DEPOSIT * SCALE, currency: "JOD", method: "CASH",
      status: "HELD", holdActive: true, createdBy: userId, createdAt: Date.now(),
    })
  );
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
  return { t, orgId, userId, asUser, asManager, customerId, vehicleId, quoteId, depositId };
}

/**
 * Net movement per system key. `includeReversed` counts entries a reversal has
 * marked REVERSED alongside the POSTED reversal that offsets them — the pair
 * nets to zero, so counting only POSTED would report the reversal alone and
 * make a correctly-undone entry look like a fresh one in the opposite
 * direction.
 */
async function postedBySystemKey(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: string,
  opts: { includeReversed?: boolean } = {}
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    // `.withIndex` is unavailable here: passing the convexTest handle as a
    // parameter widens ctx.db to a union over every table, which drops the
    // per-table index names. Filtering after collect is equivalent at test size.
    const accounts = (await ctx.db.query("chartOfAccounts").collect())
      .filter((a) => a.orgId === orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);

    const entries = (await ctx.db.query("journalEntries").collect())
      .filter((e) => e.orgId === orgId);

    const totals: Record<string, number> = {};
    for (const entry of entries) {
      const counted =
        entry.status === "POSTED" || (opts.includeReversed === true && entry.status === "REVERSED");
      if (!counted) continue;
      const lines = (await ctx.db.query("journalLines").collect())
        .filter((l) => l.journalEntryId === entry._id);
      for (const l of lines) {
        const key = keyByAccount.get(l.accountId);
        if (!key) continue;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

type RefundMethod = "CASH" | "BANK_TRANSFER" | "PAYMENT_LINK" | "CARD" | "CHEQUE" | "OTHER";

async function completeAs(
  actor: Awaited<ReturnType<typeof seed>>["asUser"],
  s: Awaited<ReturnType<typeof seed>>,
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER",
  resolution?: { treatment: Treatment; reason?: string; refundMethod?: RefundMethod },
  extra: Record<string, unknown> = {}
) {
  return await actor.mutation(api.sales.create, {
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    // The salesperson on the deal stays the same whoever completes it.
    salespersonId: s.userId,
    salePrice: SALE_PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    quoteId: s.quoteId,
    supplierSettlementRoute: route,
    ...(resolution ? { depositResolution: resolution } : {}),
    ...extra,
  });
}

async function completeWith(
  s: Awaited<ReturnType<typeof seed>>,
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER",
  resolution?: { treatment: Treatment; reason?: string; refundMethod?: RefundMethod },
  extra: Record<string, unknown> = {}
) {
  const { salePriceOverride, ...rest } = extra as { salePriceOverride?: number };
  return await s.asUser.mutation(api.sales.create, {
    orgId: s.orgId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    salespersonId: s.userId,
    salePrice: SALE_PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    quoteId: s.quoteId,
    supplierSettlementRoute: route,
    ...(resolution ? { depositResolution: resolution } : {}),
    ...rest,
    ...(salePriceOverride === undefined ? {} : { salePrice: salePriceOverride }),
  });
}

describe("the treatment taxonomy", () => {
  test("OTHER has no status, because it has no accounting outcome", () => {
    // Every other treatment says what happened to the money. OTHER says a human
    // approved something the system has no rule for — so claiming APPLIED or
    // REFUNDED would be inventing an outcome from a field whose whole purpose
    // is to record that none of them apply.
    expect(depositStatusForTreatment("APPLY_TO_DEALER_AMOUNT")).toBe("APPLIED");
    expect(depositStatusForTreatment("APPLY_TO_TRANSACTION_SETTLEMENT")).toBe("APPLIED");
    expect(depositStatusForTreatment("REFUND_TO_CUSTOMER")).toBe("REFUNDED");
    expect(depositStatusForTreatment("FORFEITED")).toBe("FORFEITED");
    expect(depositStatusForTreatment("OTHER")).toBeNull();
  });
});

describe("when a treatment has to be stated, and when it does not", () => {
  test("the direct route refuses to guess, because the customer may owe nothing", async () => {
    const s = await seed("noTreat");
    await expect(completeWith(s, "DIRECT_TO_SUPPLIER", undefined)).rejects.toThrow(
      /reservation deposit|treatment/i
    );

    // And it really did refuse: the deposit is untouched and still holding.
    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.status).toBe("HELD");
    expect(deposit?.holdActive).toBe(true);
  });

  test("the through-dealership route resolves implicitly, like owned stock", async () => {
    // Demanding a treatment here was a regression: no client passes one, so a
    // consigned deal with a عربون could not be completed at all — and there was
    // nothing to disambiguate, because the dealership collected the gross and
    // holds the customer's receivable for it.
    const s = await seed("thruImplicit");
    await completeWith(s, "THROUGH_DEALERSHIP", undefined);

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.status).toBe("APPLIED");
    expect(deposit?.resolutionTreatment).toBe("APPLY_TO_DEALER_AMOUNT");

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe((SALE_PRICE - DEPOSIT) * SCALE);
  });

  test("a dealer-owned sale still resolves implicitly, because it was never ambiguous", async () => {
    const s = await seed("owned", { sourceType: "STOCK" });
    await completeWith(s, "THROUGH_DEALERSHIP", undefined);

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.status).toBe("APPLIED");
    // No treatment recorded: on owned stock APPLIED has only ever meant
    // "against what the customer owes", so there is nothing to disambiguate.
    expect(deposit?.resolutionTreatment).toBeUndefined();
  });
});

describe("APPLY_TO_DEALER_AMOUNT", () => {
  test("comes off what the customer owes the dealership", async () => {
    const s = await seed("dealerAmt");
    await completeWith(s, "THROUGH_DEALERSHIP", { treatment: "APPLY_TO_DEALER_AMOUNT" });

    const posted = await postedBySystemKey(s.t, s.orgId);
    // Gross receivable 12,500 less the 1,000 deposit applied against it.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe((SALE_PRICE - DEPOSIT) * SCALE);
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(DEPOSIT * SCALE);
    // The margin is untouched by how the deposit was resolved.
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.resolutionTreatment).toBe("APPLY_TO_DEALER_AMOUNT");
  });

  test("cannot exceed what the dealership actually billed", async () => {
    // DIRECT_TO_SUPPLIER with no dealer fees: the dealership billed the customer
    // nothing at all, so there is nothing for a 1,000 deposit to come off.
    // Applying it anyway would push a receivable past zero and show the customer
    // in credit for money the supplier was paid.
    const s = await seed("overApply");
    await expect(
      completeWith(s, "DIRECT_TO_SUPPLIER", { treatment: "APPLY_TO_DEALER_AMOUNT" })
    ).rejects.toThrow(/exceeds what the dealership billed/i);
  });

  test("is allowed up to the dealership's own charges on the direct route", async () => {
    const s = await seed("feeApply");
    await completeWith(s, "DIRECT_TO_SUPPLIER", { treatment: "APPLY_TO_DEALER_AMOUNT" }, {
      dealerFees: DEPOSIT,
    });

    const posted = await postedBySystemKey(s.t, s.orgId);
    // Billed 1,000 in fees, deposit of 1,000 applied against it — nothing left owing.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(0);
    expect(posted[SYSTEM_KEYS.DEALER_FEE_INCOME]).toBe(-DEPOSIT * SCALE);
  });
});

describe("APPLY_TO_TRANSACTION_SETTLEMENT", () => {
  test("on the direct route it settles the margin the supplier owes, not revenue again", async () => {
    const s = await seed("settle");
    await completeWith(s, "DIRECT_TO_SUPPLIER", { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" });

    const posted = await postedBySystemKey(s.t, s.orgId);
    // Commission revenue was recognized in full when the sale posted. Crediting
    // it again here would count the same 3,000 twice — once earned, once
    // collected. What the deposit does is reduce the claim: the dealership is
    // already holding 1,000 of its 3,000 margin in cash.
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe((MARGIN - DEPOSIT) * SCALE);
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(DEPOSIT * SCALE);
    // Never routed to the customer's receivable.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS] ?? 0).toBe(0);
  });

  test("cannot exceed the margin, or it turns an asset into the supplier's money", async () => {
    // Deposits run 5-10% of the price and consignment margins are often
    // smaller, so this is the ordinary case, not an exotic one. Applying a
    // 1,000 deposit against a 350 margin would leave Receivable from Suppliers
    // at -650: an asset account holding what is really the supplier's money,
    // and nothing in the system can discharge it.
    const s = await seed("thinMargin", { sourceCost: SALE_PRICE - 350 });
    await expect(
      completeWith(s, "DIRECT_TO_SUPPLIER", { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" })
    ).rejects.toThrow(/exceeds the dealership's margin/i);

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBeGreaterThanOrEqual(0);
  });

  test("is refused on the through-dealership route, where the settlement is already recorded", async () => {
    // AP-Suppliers was credited the supplier's full entitlement when the sale
    // posted. Crediting it again would inflate the debt by the deposit, and the
    // excess would never clear.
    const s = await seed("settleThru");
    await expect(
      completeWith(s, "THROUGH_DEALERSHIP", { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" })
    ).rejects.toThrow(/already recorded in full/i);
  });
});

describe("REFUND_TO_CUSTOMER and FORFEITED keep every control they carry elsewhere", () => {
  // These are available at completion, but they move a customer's money and so
  // run through the same path the deposits screen uses. The controls belong to
  // the decision, not to the screen it is made on — reimplementing the posting
  // here once produced a route that refunded and forfeited with none of them.

  test("a refund by an authorized second actor pays out through the subledger, not just the GL", async () => {
    const s = await seed("refundOk");
    await completeAs(s.asManager, s, "THROUGH_DEALERSHIP", {
      treatment: "REFUND_TO_CUSTOMER",
      refundMethod: "CASH",
    });

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(DEPOSIT * SCALE);
    expect(posted[SYSTEM_KEYS.CASH_ON_HAND]).toBe(-DEPOSIT * SCALE);
    // The customer still owes the full gross: nothing came off it.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(SALE_PRICE * SCALE);

    // Cash leaving the business has to appear where people look for cash
    // leaving the business, or the journal reconciles against nothing.
    const [txns, canonical] = await s.t.run(async (ctx) => [
      (await ctx.db.query("transactions").collect()).filter(
        (t) => t.orgId === s.orgId && t.type === "OUT" && t.category === "DEPOSIT"
      ),
      (await ctx.db.query("canonicalPayments").collect()).filter(
        (c) => c.orgId === s.orgId && c.direction === "OUT"
      ),
    ]);
    expect(txns).toHaveLength(1);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.amountMinor).toBe(DEPOSIT * SCALE);

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.status).toBe("REFUNDED");
    expect(deposit?.resolutionTreatment).toBe("REFUND_TO_CUSTOMER");
  });

  test("a forfeiture by an authorized second actor recognizes forfeiture income, never commission", async () => {
    const s = await seed("forfeitOk");
    await completeAs(s.asManager, s, "THROUGH_DEALERSHIP", { treatment: "FORFEITED" });

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.DEPOSIT_FORFEITURE_INCOME]).toBe(-DEPOSIT * SCALE);
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(DEPOSIT * SCALE);
    // The deposit was not earned by selling the car.
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);
  });

  test.each(["REFUND_TO_CUSTOMER", "FORFEITED"] as const)(
    "%s is refused when the person completing the sale is the one who took the deposit",
    async (treatment) => {
      // Otherwise one salesperson can take a customer's deposit and keep it, on
      // their own authority, by closing the deal.
      const s = await seed(`sod${treatment.slice(0, 4)}`);
      await expect(
        completeWith(s, "THROUGH_DEALERSHIP", { treatment, refundMethod: "CASH" })
      ).rejects.toThrow(/creator cannot resolve their own/i);

      const posted = await postedBySystemKey(s.t, s.orgId);
      expect(posted[SYSTEM_KEYS.CASH_ON_HAND] ?? 0).toBe(0);
      expect(posted[SYSTEM_KEYS.DEPOSIT_FORFEITURE_INCOME] ?? 0).toBe(0);
      expect((await s.t.run((ctx) => ctx.db.get(s.depositId)))?.status).toBe("HELD");
    }
  );

  test("a refund with no payment method is refused, and so is one that cannot be paid out", async () => {
    const noMethod = await seed("refundNoM");
    await expect(
      completeAs(noMethod.asManager, noMethod, "THROUGH_DEALERSHIP", {
        treatment: "REFUND_TO_CUSTOMER",
      })
    ).rejects.toThrow(/payment method is required/i);

    const otherMethod = await seed("refundOther");
    await expect(
      completeAs(otherMethod.asManager, otherMethod, "THROUGH_DEALERSHIP", {
        treatment: "REFUND_TO_CUSTOMER",
        refundMethod: "OTHER",
      })
    ).rejects.toThrow(/OTHER is not accepted/i);
  });

  test("a completer without approval permission cannot release the deposit at all", async () => {
    // Completing a sale authorizes `create:sales`. Keeping or returning a
    // customer's deposit is a different authority, and checking it only at the
    // mutation boundary would never have noticed.
    const s = await seed("refundPerm", { managerPermissions: SALES_ONLY_PERMS });
    await expect(
      completeAs(s.asManager, s, "THROUGH_DEALERSHIP", {
        treatment: "FORFEITED",
      })
    ).rejects.toThrow(/approval permission/i);
  });
});

describe("OTHER", () => {
  test("requires a reason", async () => {
    const s = await seed("otherNoReason");
    await expect(
      completeWith(s, "THROUGH_DEALERSHIP", { treatment: "OTHER" })
    ).rejects.toThrow(/has to say what it is|reason/i);
  });

  test("posts nothing and leaves the liability standing for a manual journal", async () => {
    const s = await seed("other");
    await completeWith(s, "THROUGH_DEALERSHIP", {
      treatment: "OTHER",
      reason: "Transferred to a replacement deal per manager approval #114",
    });

    const posted = await postedBySystemKey(s.t, s.orgId);
    // The money is still the customer's until somebody decides otherwise.
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.DEPOSIT_FORFEITURE_INCOME] ?? 0).toBe(0);

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    // Status untouched: the money really is still held.
    expect(deposit?.status).toBe("HELD");
    expect(deposit?.resolutionTreatment).toBe("OTHER");
    expect(deposit?.resolutionReason).toMatch(/replacement deal/);
    // Only the vehicle hold is released, so the car is not stuck.
    expect(deposit?.holdActive).toBe(false);
  });
});

describe("what no treatment may ever do", () => {
  test("none of them move the reservation deposit to a finance company", async () => {
    for (const treatment of ["APPLY_TO_DEALER_AMOUNT"] as const) {
      const s = await seed(`fin${treatment.slice(0, 6)}`);
      await completeWith(s, "THROUGH_DEALERSHIP", { treatment });
      const posted = await postedBySystemKey(s.t, s.orgId);
      // The financing down payment is a separate amount the customer pays the
      // finance company directly. The reservation deposit is not it, and must
      // never be booked as if it were.
      expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES] ?? 0).toBe(0);
    }
  });
});

describe("cancelling a sale whose deposit went to the supplier settlement", () => {
  test("returns both the liability and the supplier claim to zero", async () => {
    // The settlement treatment posts DEPOSIT_APPLIED_TO_SETTLEMENT, but
    // cancellation reversed DEPOSIT_APPLIED — a different event, which does not
    // exist for this deposit. `reverseEventIfPosted` then silently no-ops, so
    // the deposit came back as HELD in the subledger while the GL still showed
    // its liability discharged against the supplier receivable. Re-selling from
    // the same quote then discharged the one deposit twice.
    const s = await seed("cancelSettle");
    const saleId = await completeWith(s, "DIRECT_TO_SUPPLIER", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });

    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED" as const,
    });

    const posted = await postedBySystemKey(s.t, s.orgId, { includeReversed: true });
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.status).toBe("HELD");
    // Cleared, not left pointing at a deal that no longer exists.
    expect(deposit?.resolutionTreatment).toBeUndefined();
    expect(deposit?.resolutionSaleId).toBeUndefined();
  });
});

describe("the trigger is the deposit balance, not the settlement route", () => {
  test("a direct-settled sale needs NO treatment when the dealership billed enough to absorb it", async () => {
    // Tying the requirement to DIRECT_TO_SUPPLIER made an unrelated field decide
    // whether a customer's money needed a decision. Here the buyer paid the
    // supplier, yet the dealership billed 1,000 of its own fees against a 1,000
    // deposit — nothing is left over, so nothing needs stating.
    const s = await seed("dirAbsorbed");
    await completeWith(s, "DIRECT_TO_SUPPLIER", undefined, { dealerFees: DEPOSIT });

    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit?.status).toBe("APPLIED");
    expect(deposit?.resolutionTreatment).toBe("APPLY_TO_DEALER_AMOUNT");

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(0);
  });

  test("a through-dealership sale DOES need one when the deposit exceeds the bill", async () => {
    // The mirror case: the supplier was settled through the dealership, which
    // used to mean "never ask" — but the customer was billed less than the
    // deposit, so a balance is left with nowhere determined to go.
    const s = await seed("thruExcess");
    await expect(
      completeWith(s, "THROUGH_DEALERSHIP", undefined, { salePriceOverride: 0 })
    ).rejects.toThrow(/larger than what the dealership billed the customer/i);
  });

  test("an owned sale is subject to exactly the same rule", async () => {
    // Consigned-ness is not the trigger either. A deposit larger than the
    // invoice is undetermined on the dealership's own stock too.
    const s = await seed("ownedExcess", { sourceType: "STOCK" });
    await expect(
      completeWith(s, "THROUGH_DEALERSHIP", undefined, { salePriceOverride: 0 })
    ).rejects.toThrow(/larger than what the dealership billed the customer/i);
  });

  test.each([
    ["THROUGH_DEALERSHIP", "APPLY_TO_DEALER_AMOUNT"],
    ["DIRECT_TO_SUPPLIER", "APPLY_TO_TRANSACTION_SETTLEMENT"],
  ] as const)(
    "an explicit %s treatment of %s is honoured",
    async (route, treatment) => {
      const s = await seed(`both${route.slice(0, 4)}`);
      await completeWith(s, route, { treatment });
      const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
      expect(deposit?.status).toBe("APPLIED");
      expect(deposit?.resolutionTreatment).toBe(treatment);
    }
  );
});

/**
 * One quote, several cars.
 *
 * `quotes.vehicleItems` lets a quote carry more than one vehicle, each sold on
 * its own sale. Every deposit row names the car it is holding, so the
 * allocation is a recorded fact — it never has to be apportioned or guessed.
 * Reading it at quote scope compared one car's invoice against every car's
 * deposits: a two-vehicle quote demanded a deposit treatment on the first
 * completion and then refused every treatment offered, with no UI able to
 * supply one. It also resolved the unsold car's deposit and released its hold.
 */
describe("deposits on a quote that covers several vehicles", () => {
  const PRICE_A = SALE_PRICE;
  const PRICE_B = 8_000;
  const DEPOSIT_A = 600;
  const DEPOSIT_B = 400;

  async function seedTwoVehicleQuote(
    tag: string,
    opts: { depositA?: number; depositB?: number } = {}
  ) {
    const s = await seed(tag, { sourceType: "STOCK" });
    const depositA = opts.depositA ?? DEPOSIT_A;
    const depositB = opts.depositB ?? DEPOSIT_B;

    // The seeded vehicle becomes line A; add a second car and a second deposit.
    const vehicleB = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: `VINDEPB${tag}`, make: "Kia", model: "Rio", year: 2023,
        mileage: 5, color: "Red", fuelType: "Gas", transmission: "Auto",
        sellingPrice: PRICE_B, status: "AVAILABLE", sourceType: "STOCK",
        purchasePrice: 6_000,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.patch(s.quoteId, {
        vehiclePrice: PRICE_A + PRICE_B,
        vehicleItems: [
          { vehicleId: s.vehicleId, unitPrice: PRICE_A },
          { vehicleId: vehicleB, unitPrice: PRICE_B },
        ],
      })
    );
    // Re-point the seeded deposit at line A's allocation.
    await s.t.run((ctx) =>
      ctx.db.patch(s.depositId, { amount: depositA, amountMinor: depositA * SCALE })
    );
    const depositIdB = await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: vehicleB, customerId: s.customerId, quoteId: s.quoteId,
        amount: depositB, amountMinor: depositB * SCALE, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdBy: s.userId, createdAt: Date.now(),
      })
    );
    return { ...s, vehicleB, depositIdB, depositA, depositB };
  }

  type TwoVehicleSeed = Awaited<ReturnType<typeof seedTwoVehicleQuote>>;

  async function sellAs(
    actor: TwoVehicleSeed["asUser"],
    s: TwoVehicleSeed,
    vehicleId: Id<"vehicles">,
    salePrice: number,
    resolution?: { treatment: Treatment; reason?: string; refundMethod?: RefundMethod }
  ) {
    return await actor.mutation(api.sales.create, {
      orgId: s.orgId,
      vehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
      quoteId: s.quoteId,
      ...(resolution ? { depositResolution: resolution } : {}),
    });
  }

  const sell = (
    s: TwoVehicleSeed,
    vehicleId: Id<"vehicles">,
    salePrice: number,
    resolution?: { treatment: Treatment; reason?: string; refundMethod?: RefundMethod }
  ) => sellAs(s.asUser, s, vehicleId, salePrice, resolution);

  const depositRow = async (s: TwoVehicleSeed, id: Id<"deposits">) =>
    await s.t.run((ctx) => ctx.db.get(id));

  test("completing the first vehicle needs no treatment and touches only its own deposit", async () => {
    // 600 against a 12,500 invoice is fully absorbed. Summed at quote scope the
    // comparison was 1,000 against the same invoice — still absorbed here, but
    // the money moved was the wrong money.
    const s = await seedTwoVehicleQuote("multi1");

    await sell(s, s.vehicleId, PRICE_A);

    expect((await depositRow(s, s.depositId))!.status).toBe("APPLIED");
    // Vehicle B has not sold. Its deposit is untouched and its hold stands.
    const b = await depositRow(s, s.depositIdB);
    expect(b!.status).toBe("HELD");
    expect(b!.holdActive).toBe(true);
  });

  test("only the first vehicle's deposit comes off its invoice", async () => {
    const s = await seedTwoVehicleQuote("multi2");

    await sell(s, s.vehicleId, PRICE_A);
    const saleTx = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).find(
        (tx) => tx.orgId === s.orgId && tx.category === "VEHICLE_SALE" && tx.vehicleId === s.vehicleId
      )
    );
    // 12,500 less its own 600 — not less 1,000, which would have paid down this
    // car's bill with the money holding a different one.
    expect(saleTx!.amount).toBe(PRICE_A - DEPOSIT_A);
  });

  test("completing the vehicles in either order gives the same result", async () => {
    const forward = await seedTwoVehicleQuote("multi3a");
    await sell(forward, forward.vehicleId, PRICE_A);
    await sell(forward, forward.vehicleB, PRICE_B);

    const reverse = await seedTwoVehicleQuote("multi3b");
    await sell(reverse, reverse.vehicleB, PRICE_B);
    await sell(reverse, reverse.vehicleId, PRICE_A);

    for (const s of [forward, reverse]) {
      expect((await depositRow(s, s.depositId))!.status).toBe("APPLIED");
      expect((await depositRow(s, s.depositIdB))!.status).toBe("APPLIED");
    }
  });

  test("a deposit smaller than the invoice is simply applied", async () => {
    const s = await seedTwoVehicleQuote("multiSmall", { depositA: 500 });
    await sell(s, s.vehicleId, PRICE_A);
    expect((await depositRow(s, s.depositId))!.status).toBe("APPLIED");
  });

  test("a deposit exactly equal to the invoice is still fully determined", async () => {
    // The boundary: holding exactly what was billed leaves nothing over, so no
    // treatment is required. An off-by-one here would block a real sale.
    const s = await seedTwoVehicleQuote("multiEqual", { depositA: PRICE_A });
    await sell(s, s.vehicleId, PRICE_A);
    expect((await depositRow(s, s.depositId))!.status).toBe("APPLIED");
  });

  test("a deposit larger than this car's invoice is what actually requires a decision", async () => {
    const s = await seedTwoVehicleQuote("multiOver", { depositA: PRICE_A + 250 });
    await expect(sell(s, s.vehicleId, PRICE_A)).rejects.toThrow(
      /larger than what the dealership billed the customer/i
    );
  });

  test("a refund releases this car's deposit and leaves the other one held", async () => {
    const s = await seedTwoVehicleQuote("multiRefund", { depositA: PRICE_A + 250 });

    // Completed by the manager: the person who took the deposit may not be the
    // one who returns it, and that control is unchanged by the vehicle scoping.
    await sellAs(s.asManager, s, s.vehicleId, PRICE_A, {
      treatment: "REFUND_TO_CUSTOMER",
      refundMethod: "CASH",
    });

    expect((await depositRow(s, s.depositId))!.status).toBe("REFUNDED");
    expect((await depositRow(s, s.depositIdB))!.status).toBe("HELD");
  });

  test("a forfeiture is scoped the same way", async () => {
    const s = await seedTwoVehicleQuote("multiForfeit", { depositA: PRICE_A + 250 });

    await sellAs(s.asManager, s, s.vehicleId, PRICE_A, { treatment: "FORFEITED" });

    expect((await depositRow(s, s.depositId))!.status).toBe("FORFEITED");
    const b = await depositRow(s, s.depositIdB);
    expect(b!.status).toBe("HELD");
    expect(b!.holdActive).toBe(true);
  });

  test("a car on the quote with no deposit of its own completes untouched", async () => {
    // Partially allocated: the customer put money on A only. Selling B must
    // neither demand a treatment nor reach across to A's money.
    const s = await seedTwoVehicleQuote("multiPartial");
    await s.t.run((ctx) =>
      ctx.db.patch(s.depositIdB, { holdActive: false, status: "VOIDED" as const })
    );

    await sell(s, s.vehicleB, PRICE_B);

    const a = await depositRow(s, s.depositId);
    expect(a!.status).toBe("HELD");
    expect(a!.holdActive).toBe(true);
  });

  test("a single-vehicle quote behaves exactly as it always did", async () => {
    // The regression guard on the fix itself: scoping by vehicle must not
    // change the overwhelmingly common case.
    const s = await seed("multiSingle", { sourceType: "STOCK" });
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
      salespersonId: s.userId, salePrice: SALE_PRICE, saleDate: Date.now(),
      status: "COMPLETED" as const, quoteId: s.quoteId,
    });
    const deposit = await s.t.run((ctx) => ctx.db.get(s.depositId));
    expect(deposit!.status).toBe("APPLIED");
  });
});
