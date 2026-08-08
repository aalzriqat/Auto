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
import { SYSTEM_KEYS, DEFAULT_CHART } from "./utils/defaultChart";
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
    /**
     * Puts a second car on the quote, which is what makes the عربون's split a
     * decision rather than an implication. The quote then carries `vehicleItems`
     * — the shape a fleet quote really has — instead of the legacy single-line
     * fields.
     */
    extraLine?: { price: number; sourceCost?: number };
    /**
     * Records the deposit through `deposits.create`, once per amount, instead of
     * inserting a row directly. A customer paying the عربون in instalments is
     * several rows on one quote, each with its own holds; two synthetic rows
     * hand-inserted are a shape production never makes, and a test built on one
     * validates the patch rather than the behaviour.
     */
    instalments?: number[];
    /**
     * The state EVERY live org is actually in: a chart initialized before agent
     * accounting existed, so it has no Receivable from Suppliers. The self-heal
     * in `hookDepositAppliedToSettlement` is supposed to close that gap before
     * the first settlement-treated consigned sale posts.
     */
    withoutConsignmentAccounts?: boolean;
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

  if (opts.withoutConsignmentAccounts) {
    // Removed rather than never-seeded, because `initialize` seeds the whole
    // default chart and a live org's chart predates these two rows. Deleting
    // them reproduces that org exactly.
    await t.run(async (ctx) => {
      const rows = (await ctx.db.query("chartOfAccounts").collect()).filter(
        (a) =>
          a.orgId === orgId &&
          (a.systemKey === SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS ||
            a.systemKey === SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE)
      );
      for (const row of rows) await ctx.db.delete(row._id);
    });
  }

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

  // The second car, when the test needs the split to be a decision.
  const secondVehicleId = opts.extraLine
    ? await t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId, vin: `VINDEP2${tag}`, make: "Toyota", model: "Corolla", year: 2024, mileage: 12,
          color: "Grey", fuelType: "Gas", transmission: "Auto", sellingPrice: opts.extraLine!.price,
          status: "AVAILABLE",
          sourceType: "SOURCED",
          sourcedFromName: "Amman Importer Co",
          sourceCost: opts.extraLine!.sourceCost ?? opts.extraLine!.price - MARGIN,
        })
      )
    : undefined;

  // A quote carrying an actively-held reservation deposit — the shape sale
  // completion actually reads.
  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId,
      vehiclePrice: SALE_PRICE + (opts.extraLine?.price ?? 0),
      ...(opts.extraLine
        ? {
            vehicleItems: [
              { vehicleId, unitPrice: SALE_PRICE },
              { vehicleId: secondVehicleId!, unitPrice: opts.extraLine.price },
            ],
          }
        : {}),
      downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );

  let depositId: Id<"deposits">;
  const depositIds: Id<"deposits">[] = [];
  // A multi-car quote has to go through `deposits.create`: that is what writes
  // the `depositVehicleHolds` row per car, and without those rows the quote does
  // not read as multi-vehicle at all and its split cannot be recorded.
  const instalments = opts.instalments ?? (opts.extraLine ? [DEPOSIT] : undefined);
  if (instalments) {
    for (const amount of instalments) {
      depositIds.push(
        await asUser.mutation(api.deposits.create, { orgId, quoteId, amount, method: "CASH" })
      );
    }
    depositId = depositIds[0]!;
  } else {
    depositId = await t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId, vehicleId, customerId, quoteId,
        amount: DEPOSIT, amountMinor: DEPOSIT * SCALE, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdBy: userId, createdAt: Date.now(),
      })
    );
    depositIds.push(depositId);
  }
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
  return {
    t, orgId, userId, asUser, asManager, customerId, vehicleId, secondVehicleId,
    quoteId, depositId, depositIds,
  };
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

  test("on the through-dealership route it comes off the customer's bill, and never off the supplier's entitlement", async () => {
    // The operator states one thing — this عربون forms part of the settlement of
    // this deal — and the server derives where that lands from the route. Here
    // the dealership collected the gross, so the deposit is part of what the
    // CUSTOMER paid IT.
    //
    // What it must NOT do is touch the supplier's entitlement: AP-Suppliers was
    // credited his full 9,500 when the sale posted, and crediting it again would
    // inflate the debt by the deposit and leave an excess nothing can clear.
    // That double-credit is the thing this test exists to catch, so it is
    // asserted as an amount rather than as an absence.
    const s = await seed("settleThru");
    await completeWith(s, "THROUGH_DEALERSHIP", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe((SALE_PRICE - DEPOSIT) * SCALE);
    // Credited exactly once, in full. Not 9,500 + 1,000.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-SUPPLIER_ENTITLEMENT * SCALE);
    // The customer's deposit liability is discharged, not left standing.
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(DEPOSIT * SCALE);
    // No claim on the supplier is opened on this route — he was never holding
    // the dealership's money.
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);

    // The application row records where the money actually went, because that
    // is what a cancellation reverses. Recording SUPPLIER_SETTLEMENT here would
    // send the reversal after an entry that was never posted, and
    // `reverseEventIfPosted` reports "nothing posted" exactly as it reports
    // "already reversed" — silently.
    const applications = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).filter((a) => a.orgId === s.orgId)
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]!.treatment).toBe("CUSTOMER_RECEIVABLE");
    expect(applications[0]!.amountMinor).toBe(DEPOSIT * SCALE);
  });

  test("neither route lets the same deposit be credited twice", async () => {
    // The failure mode this guards is not "an assertion is missing" — it is a
    // deal that balances while the dealership has collected the deposit once and
    // given credit for it twice. Both routes are checked against the total the
    // deal was worth, because that total is what over-collection breaks.
    for (const route of ["THROUGH_DEALERSHIP", "DIRECT_TO_SUPPLIER"] as const) {
      const s = await seed(`noDouble_${route}`);
      await completeWith(s, route, { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" });
      const posted = await postedBySystemKey(s.t, s.orgId);

      // The dealership's own gross margin is recognized once and is the same on
      // both routes — the deposit changes who is holding the cash, never how
      // much was earned.
      expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);
      // And the deposit discharges exactly its own value of liability, once.
      expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(DEPOSIT * SCALE);

      // What the deal still owes the dealership, summed across both sides. The
      // deposit has been collected in cash, so it comes off once and only once.
      const stillOwed =
        (posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS] ?? 0) +
        (posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0);
      const expected =
        route === "THROUGH_DEALERSHIP"
          ? (SALE_PRICE - DEPOSIT) * SCALE // billed the gross, less the عربون
          : (MARGIN - DEPOSIT) * SCALE; // billed nothing; claims its margin, less the عربون
      expect(stillOwed).toBe(expected);

      // The GL is only one of the two sides, and it is not the side anybody
      // collects against. `supplierReceivables.recordReceipt` settles the
      // SUBLEDGER row, so a claim that says 3,000 outstanding while the GL says
      // 2,000 sends somebody to collect money the dealership is already holding
      // — and both books balance the whole time. That is the failure shape this
      // branch exists for, so the claim is read directly.
      if (route === "DIRECT_TO_SUPPLIER") {
        const claims = await s.t.run(async (ctx) =>
          (await ctx.db.query("vehicleSupplierReceivables").collect()).filter(
            (r) => r.orgId === s.orgId
          )
        );
        expect(claims).toHaveLength(1);
        expect(claims[0]!.amountDue).toBe(MARGIN);
        expect(claims[0]!.amountReceived).toBe(DEPOSIT);
        expect(claims[0]!.status).toBe("PARTIALLY_PAID");
      }
    }
  });
});

describe("APPLY_TO_TRANSACTION_SETTLEMENT across the shapes a real deal takes", () => {
  test("applies only THIS car's share, and leaves the rest of the عربون held", async () => {
    // One payment, one receipt voucher, two cars. The split is a decision
    // somebody recorded — never FIFO, never proportional, never the whole row —
    // so completing the first car may consume 600 and not a dinar more. Taking
    // the row consumed one car's invoice with money the customer had put against
    // another, and took that other car off reservation for nothing.
    const s = await seed("partial", { extraLine: { price: 8_000 } });
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      allocations: [
        { vehicleId: s.vehicleId, amount: 600 },
        { vehicleId: s.secondVehicleId!, amount: 400 },
      ],
    });

    await completeWith(s, "DIRECT_TO_SUPPLIER", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });

    const posted = await postedBySystemKey(s.t, s.orgId);
    // 600 of the 3,000 margin is already in the dealership's hands.
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe((MARGIN - 600) * SCALE);
    // The whole 1,000 was taken in against a receipt voucher (a credit) and 600
    // of it discharged (a debit). The other 400 is still the customer's money,
    // still owed, still held against the car they have not taken.
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(-400 * SCALE);

    const allocation = await s.asUser.query(api.deposits.quoteAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
    });
    expect(allocation).not.toBeNull();
    expect(allocation!.appliedMinor).toBe(600 * SCALE);
    expect(allocation!.allocatedMinor).toBe(400 * SCALE);

    const applications = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).filter((a) => a.orgId === s.orgId)
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]!.amountMinor).toBe(600 * SCALE);
    expect(applications[0]!.vehicleId).toBe(s.vehicleId);

    // And the collectable claim agrees with the GL. The cap that authorises the
    // treatment and the slices that are actually spent are different figures
    // from different places; crediting the claim with the cap would tell the
    // dealership it is holding 1,000 of the supplier's margin when it is
    // holding 600 — the other 400 still belongs to the customer.
    const claims = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierReceivables").collect()).filter(
        (r) => r.orgId === s.orgId
      )
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.amountReceived).toBe(600);
  });

  test("consumes every instalment of the عربون, not just the first", async () => {
    // A customer paying 600 now and 400 next week is two `deposits` rows on one
    // quote, each with its own holds — the shape `deposits.create` really
    // writes. Reading "the deposit" as one row applied 600 and left 400 of the
    // customer's money sitting unapplied against a car that had been sold.
    const s = await seed("instalments", { instalments: [600, 400] });
    expect(s.depositIds).toHaveLength(2);

    await completeWith(s, "DIRECT_TO_SUPPLIER", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe((MARGIN - 1_000) * SCALE);
    // Both instalments taken in, both discharged: the customer is owed nothing.
    // A single-instalment reading would leave 400 of their money still a
    // liability against a car that has been sold.
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(0);

    // One application per instalment, each carrying its own identity — that is
    // what lets a cancellation reverse exactly what this sale posted.
    const applications = await s.t.run(async (ctx) =>
      (await ctx.db.query("depositApplications").collect()).filter((a) => a.orgId === s.orgId)
    );
    expect(applications).toHaveLength(2);
    expect(applications.map((a) => a.amountMinor).sort((x, y) => x - y)).toEqual([
      400 * SCALE,
      600 * SCALE,
    ]);
    for (const application of applications) {
      expect(application.treatment).toBe("SUPPLIER_SETTLEMENT");
    }

    // The claim on the supplier has to agree with what was actually consumed.
    // These are computed from two different places — the allocated total that
    // caps the treatment, and the slices the resolution really spent — and when
    // they disagree the GL says 2,000 outstanding while the subledger somebody
    // collects against says 2,400. Both balance; the dealership bills the
    // supplier for 400 dinars of its own money.
    const claims = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierReceivables").collect()).filter(
        (r) => r.orgId === s.orgId
      )
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]!.amountReceived).toBe(1_000);
  });

  test("every dinar of the عربون is still in exactly one bucket afterwards", async () => {
    // Conservation is recomputed inside the completion and rolls the whole
    // transaction back if it fails, so this asserts the state it left behind
    // rather than that it did not throw. The failure it guards is the one that
    // balances: money counted as both applied and still held.
    const s = await seed("conserve", { instalments: [600, 400] });
    await completeWith(s, "DIRECT_TO_SUPPLIER", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });

    const allocation = await s.asUser.query(api.deposits.quoteAllocation, {
      orgId: s.orgId,
      quoteId: s.quoteId,
    });
    expect(allocation).not.toBeNull();
    const a = allocation!;
    const buckets =
      a.allocatedMinor +
      a.appliedMinor +
      a.unallocatedMinor +
      a.releasedAwaitingDecisionMinor +
      a.reversingMinor +
      a.refundedMinor +
      a.forfeitedMinor;
    expect(a.totalReceivedMinor).toBe(1_000 * SCALE);
    expect(buckets).toBe(a.totalReceivedMinor);
    // And it is in the bucket the treatment says it is in.
    expect(a.appliedMinor).toBe(1_000 * SCALE);
  });

  test("an applied deposit cannot then be refunded, nor its share re-allocated", async () => {
    // The money has gone somewhere: it is off the supplier's claim and the
    // liability is discharged. Paying it back or moving it to another car after
    // that pays the customer twice — once in credit, once in cash — and the
    // deal still balances while it happens.
    const s = await seed("spent", { extraLine: { price: 8_000 } });
    await s.asUser.mutation(api.deposits.allocateToVehicles, {
      orgId: s.orgId,
      quoteId: s.quoteId,
      allocations: [
        { vehicleId: s.vehicleId, amount: 600 },
        { vehicleId: s.secondVehicleId!, amount: 400 },
      ],
    });
    await completeWith(s, "DIRECT_TO_SUPPLIER", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });

    // Refunding the whole row would take the second car's 400 with it as well
    // as paying back the 600 already spent.
    await expect(
      s.asManager.mutation(api.deposits.release, {
        orgId: s.orgId,
        depositId: s.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
      })
    ).rejects.toThrow();

    // And the sold car's share cannot be moved onto the car still in the deal.
    await expect(
      s.asUser.mutation(api.deposits.allocateToVehicles, {
        orgId: s.orgId,
        quoteId: s.quoteId,
        allocations: [
          { vehicleId: s.vehicleId, amount: 0 },
          { vehicleId: s.secondVehicleId!, amount: 1_000 },
        ],
      })
    ).rejects.toThrow();

    // Nothing moved: the ledger is exactly where the completion left it. 400 is
    // still owed to the customer, and no cash went back out of the drawer — the
    // refund this test attempted would have paid out the 600 already spent.
    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.CUSTOMER_DEPOSITS_LIABILITY]).toBe(-400 * SCALE);
    expect(posted[SYSTEM_KEYS.CASH_ON_HAND]).toBe(1_000 * SCALE);
  });
});

describe("the consignment accounts are ensured before the settlement posts", () => {
  test("a live org whose chart predates agent accounting can complete its first settlement-treated sale", async () => {
    // The ordering this covers: deposits are resolved BEFORE `hookSaleCompleted`
    // runs, so that hook's self-heal comes too late — the settlement posting
    // needs RECEIVABLE_FROM_SUPPLIERS first, and `resolveSystemAccount` throws
    // on an unmapped key. A mutation is one transaction, so that throw rolls the
    // WHOLE completion back: the sale, the inventory move, the deposit, all of
    // it, for a reason that has nothing to do with the sale.
    //
    // Every existing org is in this state, so this is the first such sale in
    // production, not an edge case.
    const s = await seed("noChartAccts", { withoutConsignmentAccounts: true });

    const saleId = await completeWith(s, "DIRECT_TO_SUPPLIER", {
      treatment: "APPLY_TO_TRANSACTION_SETTLEMENT",
    });
    expect(saleId).toBeTruthy();

    // The accounts were created on the way through.
    const accounts = await s.t.run(async (ctx) =>
      (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === s.orgId)
    );
    expect(
      accounts.find((a) => a.systemKey === SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS)
    ).toBeTruthy();

    // Nothing rolled back: the sale is really there, and the deposit really moved.
    const sale = await s.t.run((ctx) => ctx.db.get(saleId as Id<"sales">));
    expect(sale?.status).toBe("COMPLETED");

    const posted = await postedBySystemKey(s.t, s.orgId);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe((MARGIN - DEPOSIT) * SCALE);

    // And every entry balances. A self-heal that invented an account of the
    // wrong type would post a lopsided journal rather than refuse.
    const unbalanced = await s.t.run(async (ctx) => {
      const entries = (await ctx.db.query("journalEntries").collect()).filter(
        (e) => e.orgId === s.orgId && e.status === "POSTED"
      );
      const bad: string[] = [];
      for (const entry of entries) {
        const lines = (await ctx.db.query("journalLines").collect()).filter(
          (l) => l.journalEntryId === entry._id
        );
        const debit = lines.reduce((sum, l) => sum + l.debitMinor, 0);
        const credit = lines.reduce((sum, l) => sum + l.creditMinor, 0);
        if (debit !== credit) bad.push(`${entry._id}: ${debit} vs ${credit}`);
      }
      return bad;
    });
    expect(unbalanced).toEqual([]);
  });

  test("every default account code is unique, or the self-heal steals another account's code", async () => {
    // `ensureSystemAccount` resolves a missing system account by its DEFAULT
    // CHART CODE. Two defaults sharing a code means the self-heal for one of
    // them finds the other already sitting on it, refuses to steal it, and
    // throws — so the account is never created and the ordering fix above
    // cannot work at all. Asserted on the data rather than on a posting,
    // because this is a property of the table and it should fail loudly at the
    // source rather than as a mystery rollback three layers down.
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const account of DEFAULT_CHART) {
      const existing = seen.get(account.code);
      if (existing) duplicates.push(`${account.code}: ${existing} and ${account.systemKey}`);
      seen.set(account.code, account.systemKey ?? account.name);
    }
    expect(duplicates).toEqual([]);
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
