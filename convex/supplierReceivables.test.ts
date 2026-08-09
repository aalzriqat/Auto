/**
 * Collecting the dealership's agency margin from a supplier who took the
 * buyer's money directly.
 *
 * On the DIRECT_TO_SUPPLIER route the sale debits Receivable from Suppliers for
 * the margin. Before this existed, nothing could bring that balance back down:
 * the account accreted every margin ever earned that way, an aging report could
 * not be built from it, and paid could not be told from unpaid. These tests
 * hold the claim to being openable, collectable in instalments, impossible to
 * over-collect, reconciled with the ledger at every step, and cancellable with
 * its sale — but only while no money has arrived.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { supplierReceivableView } from "./supplierReceivables";

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
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "approve:requests",
];

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;
const SCALE = 1000;

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `SR ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "SR User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_m`, email: `${tag}m@e.com`, name: "SR Manager" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
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
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINSR${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );

  const saleId = await asUser.mutation(api.sales.create, {
    orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
    supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
  });

  const receivable = (await t.run((ctx) =>
    ctx.db.query("vehicleSupplierReceivables").collect()
  ))[0]!;

  return { t, orgId, userId, asUser, asManager, customerId, vehicleId, saleId, receivable };
}

/** Net movement per system key across the org's posted ledger. */
async function ledger(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: string
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect())
      .filter((a) => a.orgId === orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);

    const entries = (await ctx.db.query("journalEntries").collect())
      .filter((e) => e.orgId === orgId && e.status === "POSTED");
    const allLines = await ctx.db.query("journalLines").collect();

    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const l of allLines.filter((x) => x.journalEntryId === entry._id)) {
        const key = keyByAccount.get(l.accountId);
        if (!key) continue;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

describe("the claim a direct-settled sale opens", () => {
  test("records which deal the margin is owed on, not just that it is owed", async () => {
    const s = await seed("open");
    expect(s.receivable.saleId).toBe(s.saleId);
    expect(s.receivable.amountDue).toBe(MARGIN);
    expect(s.receivable.status).toBe("OPEN");
    expect(s.receivable.sourcedFromName).toBe("Amman Importer Co");
    expect(s.receivable.currency).toBe("JOD");

    // And it agrees with the ledger balance it accounts for.
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(MARGIN * SCALE);
    expect(supplierReceivableView(s.receivable).remainingAmount).toBe(MARGIN);
  });

  test("a through-dealership sale opens no claim, because the money ran the other way", async () => {
    const s = await seed("thru");
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINSRTHRU2", make: "Kia", model: "Rio", year: 2023, mileage: 5,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
        status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      })
    );
    const saleId = await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
      supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
    });

    const claims = await s.t.run((ctx) =>
      ctx.db.query("vehicleSupplierReceivables").collect()
    );
    expect(claims.filter((c) => c.saleId === saleId)).toHaveLength(0);
    // The dealership owes HIM instead.
    const payables = await s.t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").collect()
    );
    expect(payables.filter((p) => p.saleId === saleId)).toHaveLength(1);
  });
});

describe("collecting it", () => {
  test("a part payment moves the subledger and the ledger by the same amount", async () => {
    const s = await seed("partial");
    const result = await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId,
      receivableId: s.receivable._id,
      amount: 1_000,
      receiptMethod: "BANK_TRANSFER",
      receiptReference: "TRF-99120",
    });

    expect(result.status).toBe("PARTIALLY_PAID");
    expect(result.amountReceived).toBe(1_000);
    expect(result.remainingAmount).toBe(MARGIN - 1_000);

    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe((MARGIN - 1_000) * SCALE);
    expect(gl[SYSTEM_KEYS.BANK_ACCOUNT]).toBe(1_000 * SCALE);
    // Collection is not a second earning of the margin.
    expect(gl[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * SCALE);

    const row = await s.t.run((ctx) => ctx.db.get(s.receivable._id));
    expect(row?.receiptReference).toBe("TRF-99120");
    expect(row?.receiptMethod).toBe("BANK_TRANSFER");
  });

  test("instalments accumulate and the last one settles the claim to zero", async () => {
    const s = await seed("instal");
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: 1_000, receiptMethod: "CASH",
    });
    // The same amount again: a distinct receipt, not a duplicate the outbox
    // should suppress. That is what the receipt sequence in the idempotency key
    // is for.
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: 1_000, receiptMethod: "CASH",
    });
    const final = await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: 1_000, receiptMethod: "CASH",
    });

    expect(final.status).toBe("PAID");
    expect(final.remainingAmount).toBe(0);

    const gl = await ledger(s.t, s.orgId);
    // The whole point: the balance the sale opened can be brought back to zero.
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(0);
    expect(gl[SYSTEM_KEYS.CASH_ON_HAND]).toBe(MARGIN * SCALE);

    const row = await s.t.run((ctx) => ctx.db.get(s.receivable._id));
    expect(row?.settledAt).toBeDefined();
    expect(row?.settledBy).toBe(s.userId);
  });

  test("collecting more than is owed is refused rather than absorbed", async () => {
    const s = await seed("over");
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: 2_500, receiptMethod: "CASH",
    });
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId, receivableId: s.receivable._id, amount: 1_000, receiptMethod: "CASH",
      })
    ).rejects.toThrow(/would record 3500 against 3000 owed/i);

    // Nothing moved on the failed attempt.
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(500 * SCALE);
  });

  test("a zero or negative receipt is refused", async () => {
    const s = await seed("zero");
    for (const amount of [0, -100]) {
      await expect(
        s.asUser.mutation(api.supplierReceivables.recordReceipt, {
          orgId: s.orgId, receivableId: s.receivable._id, amount, receiptMethod: "CASH",
        })
      ).rejects.toThrow(/greater than zero/i);
    }
  });

  test("a settled claim cannot be collected against again", async () => {
    const s = await seed("resettle");
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: MARGIN, receiptMethod: "CASH",
    });
    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId, receivableId: s.receivable._id, amount: 1, receiptMethod: "CASH",
      })
    ).rejects.toThrow(/already settled in full/i);
  });
});

describe("disputes", () => {
  test("a disputed claim refuses money until the dispute is lifted", async () => {
    const s = await seed("dispute");
    await s.asUser.mutation(api.supplierReceivables.setDisputed, {
      orgId: s.orgId, receivableId: s.receivable._id, disputed: true,
      reason: "Supplier says the agreed margin was 2,500",
    });

    await expect(
      s.asUser.mutation(api.supplierReceivables.recordReceipt, {
        orgId: s.orgId, receivableId: s.receivable._id, amount: 500, receiptMethod: "CASH",
      })
    ).rejects.toThrow(/under dispute/i);

    // Lifting it returns the claim to what the money says, not to a remembered
    // status that could have drifted.
    await s.asUser.mutation(api.supplierReceivables.setDisputed, {
      orgId: s.orgId, receivableId: s.receivable._id, disputed: false,
    });
    const row = await s.t.run((ctx) => ctx.db.get(s.receivable._id));
    expect(row?.status).toBe("OPEN");
    expect(row?.disputeReason).toBeUndefined();
  });

  test("a dispute must say what is disputed", async () => {
    const s = await seed("disputeNoReason");
    await expect(
      s.asUser.mutation(api.supplierReceivables.setDisputed, {
        orgId: s.orgId, receivableId: s.receivable._id, disputed: true,
      })
    ).rejects.toThrow(/say what is disputed/i);
  });
});

describe("cancellation", () => {
  test("cancelling the sale cancels an untouched claim", async () => {
    const s = await seed("cancelClean");
    await s.asManager.mutation(api.sales.update, {
      orgId: s.orgId, saleId: s.saleId, status: "CANCELLED" as const,
    });

    const row = await s.t.run((ctx) => ctx.db.get(s.receivable._id));
    expect(row?.status).toBe("CANCELLED");
    expect(row?.cancelledAt).toBeDefined();
  });

  test("cancelling is refused once the supplier has paid something", async () => {
    // Unwinding a receipt is a correction somebody makes deliberately, not
    // something a cancellation does on its way past.
    const s = await seed("cancelPaid");
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: 500, receiptMethod: "CASH",
    });

    await expect(
      s.asManager.mutation(api.sales.update, {
        orgId: s.orgId, saleId: s.saleId, status: "CANCELLED" as const,
      })
    ).rejects.toThrow(/after the supplier has paid/i);

    const row = await s.t.run((ctx) => ctx.db.get(s.receivable._id));
    expect(row?.status).toBe("PARTIALLY_PAID");
  });
});

describe("what a supplier still owes", () => {
  test("the outstanding summary totals the claims the GL balance cannot break down", async () => {
    const s = await seed("summary");
    await s.asUser.mutation(api.supplierReceivables.recordReceipt, {
      orgId: s.orgId, receivableId: s.receivable._id, amount: 1_000, receiptMethod: "CASH",
    });

    const summary = await s.asUser.query(api.supplierReceivables.outstandingSummary, {
      orgId: s.orgId,
    });
    expect(summary.totalDue).toBe(MARGIN);
    expect(summary.totalReceived).toBe(1_000);
    expect(summary.totalOutstanding).toBe(MARGIN - 1_000);
    expect(summary.bySupplier).toEqual([
      { sourcedFromName: "Amman Importer Co", outstanding: MARGIN - 1_000, claims: 1 },
    ]);

    // And it reconciles with the ledger account it summarizes.
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(summary.totalOutstanding * SCALE);
  });
});

describe("tenancy", () => {
  test("another organization's claim is not readable or collectable", async () => {
    // Both orgs live in ONE database. Seeding two convexTest instances would
    // have proved nothing: they are separate databases whose ids collide, so
    // the "foreign" id resolves to the caller's own row and every assertion
    // passes against a guard that does not exist.
    const a = await seed("tenantA");
    const otherOrgId = await a.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other dealership", createdAt: Date.now() })
    );
    const otherUserId = await a.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "other_u", email: "other@e.com", name: "Other" })
    );
    const otherRoleId = await a.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "Owner", permissions: PERMS })
    );
    await a.t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUserId, roleId: otherRoleId })
    );
    const asOther = a.t.withIdentity({ subject: "other_u", clerkId: "other_u" });

    // Naming your own org while pointing at somebody else's row is exactly the
    // shape `requireOwnedRow` exists for: the caller may act in the org they
    // named, which says nothing about the row they are about to touch.
    await expect(
      asOther.mutation(api.supplierReceivables.recordReceipt, {
        orgId: otherOrgId, receivableId: a.receivable._id, amount: 100, receiptMethod: "CASH",
      })
    ).rejects.toThrow(/not found/i);
    await expect(
      asOther.mutation(api.supplierReceivables.setDisputed, {
        orgId: otherOrgId, receivableId: a.receivable._id, disputed: true, reason: "not mine",
      })
    ).rejects.toThrow(/not found/i);

    // The claim is untouched, and the other org sees none of it.
    const row = await a.t.run((ctx) => ctx.db.get(a.receivable._id));
    expect(row?.status).toBe("OPEN");
    expect(row?.amountReceived).toBeUndefined();
    const list = await asOther.query(api.supplierReceivables.list, { orgId: otherOrgId });
    expect(list).toHaveLength(0);
  });
});

describe("a deposit applied to the settlement", () => {
  test("opens the claim net of it, so subledger and ledger agree from the first moment", async () => {
    // The deposit application credits Receivable from Suppliers in the GL. A
    // claim opened at the full margin would have disagreed with the ledger by
    // the deposit from the instant it was created.
    const base = await seed("depSeed");
    const vehicleId = await base.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: base.orgId, vin: "VINSRDEP2", make: "Toyota", model: "Yaris", year: 2024, mileage: 8,
        color: "Grey", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
        status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      })
    );
    const quote2 = await base.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: base.orgId, customerId: base.customerId, vehicleId,
        vehiclePrice: SALE_PRICE, downPayment: 0, termMonths: 0,
        status: "ACCEPTED", createdBy: base.userId, createdAt: Date.now(),
      })
    );
    await base.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: base.orgId, vehicleId, customerId: base.customerId, quoteId: quote2,
        amount: 1_000, amountMinor: 1_000 * SCALE, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdBy: base.userId, createdAt: Date.now(),
      })
    );

    const saleId = await base.asUser.mutation(api.sales.create, {
      orgId: base.orgId, vehicleId, customerId: base.customerId, salespersonId: base.userId,
      salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
      quoteId: quote2,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
      depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" as const },
    });

    const claim = (await base.t.run((ctx) =>
      ctx.db.query("vehicleSupplierReceivables").collect()
    )).find((c) => c.saleId === saleId)!;

    expect(claim.amountDue).toBe(MARGIN);
    expect(claim.amountReceived).toBe(1_000);
    expect(claim.status).toBe("PARTIALLY_PAID");
    // No receipt was recorded — the dealership is holding its own margin in the
    // customer's cash, which is not the supplier having paid.
    expect(claim.receiptSeq).toBeUndefined();
    expect(supplierReceivableView(claim).remainingAmount).toBe(MARGIN - 1_000);
  });
});
