/**
 * SCRUM-724 owner ruling: a customer cheque the bank clears AFTER its sale was
 * cancelled becomes UNAPPLIED CUSTOMER CREDIT (2110) with full lineage. Exits:
 * an authorized refund or an explicit reservation to another sale of the same
 * customer. The cancelled sale never reopens.
 *
 * Every state transition below goes through a real public mutation; the only
 * direct DB reads are assertions.
 */
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

async function seed(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  registerRateLimiter(t);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `CCSC ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `own_${suffix}`, email: `own_${suffix}@x.com`, name: "Owner" })
  )) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true, permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH", "CHEQUE", "BANK_TRANSFER"],
    })
  );
  const asOwner = t.withIdentity({ subject: `own_${suffix}`, clerkId: `own_${suffix}` });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;

  const mkActor = async (name: string, permissions: string[]) => {
    const actorId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        clerkId: `${name}_${suffix}`, email: `${name}_${suffix}@x.com`, name,
      });
      const r = await ctx.db.insert("roles", { orgId, name: `${name}-role`, permissions });
      await ctx.db.insert("memberships", { orgId, userId: id, roleId: r });
      return id;
    });
    return { actorId, as: t.withIdentity({ subject: `${name}_${suffix}`, clerkId: `${name}_${suffix}` }) };
  };
  const approver = await mkActor("approver", ["view:sales", "edit:sales", "approve:requests", "manage:finance", "view:finance"]);
  const financeOnly = await mkActor("finance", ["manage:finance", "view:finance"]);
  const viewOnly = await mkActor("viewer", ["view:finance"]);
  return { t, asOwner, orgId, userId, customerId, approver, financeOnly, viewOnly };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

let vinCounter = 0;
async function newSale(s: Seeded, customerId: Id<"customers"> = s.customerId) {
  const vehicleId = await s.t.run((ctx) => ctx.db.insert("vehicles", {
    orgId: s.orgId, vin: `VIN-CCSC-${++vinCounter}-${Date.now()}`, make: "Kia", model: "Rio", year: 2021,
    mileage: 0, color: "White", fuelType: "Gasoline", transmission: "Automatic",
    sellingPrice: 100, purchasePrice: 60, status: "AVAILABLE", sourceType: "STOCK",
  }));
  const saleId = await s.asOwner.mutation(api.sales.create, {
    orgId: s.orgId, vehicleId, customerId, salespersonId: s.userId,
    salePrice: 100, saleDate: Date.now(), status: "COMPLETED",
    financingType: "CASH", idempotencyKey: crypto.randomUUID(),
  });
  return saleId as Id<"sales">;
}

const cancelSale = (s: Seeded, saleId: Id<"sales">) =>
  s.approver.as.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" });

async function registerCheque(s: Seeded, saleId: Id<"sales">, no: string, amountMinor = 3000) {
  return (await s.asOwner.mutation(api.collections.registerSaleInvoiceCheque, {
    orgId: s.orgId, saleId, bank: "Test Bank", chequeNumber: no, chequeDate: Date.now(), amountMinor,
  })) as Id<"postDatedCheques">;
}
const deposit = (s: Seeded, chequeId: Id<"postDatedCheques">) =>
  s.asOwner.mutation(api.collections.depositCheque, { orgId: s.orgId, chequeId });
const clear = (s: Seeded, chequeId: Id<"postDatedCheques">, key = crypto.randomUUID()) =>
  s.asOwner.mutation(api.collections.clearCheque, { orgId: s.orgId, chequeId, idempotencyKey: key });

async function movementOf(t: TestHarness, orgId: Id<"organizations">, paymentId: Id<"collectionPayments">) {
  return (await t.run((ctx) => ctx.db.query("receiptMovements")
    .withIndex("by_org_payment", (q) => q.eq("orgId", orgId).eq("collectionPaymentId", paymentId)).unique()))!;
}
async function positionOf(t: TestHarness, orgId: Id<"organizations">, movementId: Id<"receiptMovements">) {
  return (await t.run((ctx) => ctx.db.query("receiptRetainedPositions")
    .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movementId)).unique()))!;
}
async function glLines(t: TestHarness, orgId: Id<"organizations">, sourceType: string, sourceId: string) {
  return await t.run(async (ctx) => {
    const entries = await ctx.db.query("journalEntries")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId))
      .collect();
    const out: Array<{ key: string | undefined; debit: number; credit: number; status: string }> = [];
    for (const e of entries) {
      const lines = await ctx.db.query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", e._id)).collect();
      for (const l of lines) {
        const acct = await ctx.db.get(l.accountId);
        out.push({ key: acct?.systemKey, debit: l.debitMinor, credit: l.creditMinor, status: e.status });
      }
    }
    return out;
  });
}
const sum = (rows: Array<{ debit: number; credit: number }>, f: "debit" | "credit") =>
  rows.reduce((a, r) => a + r[f], 0);

async function applicationsFor(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run((ctx) => ctx.db.query("invoiceReceiptApplications")
    .withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
}

/** register -> deposit -> cancel (real mutation) -> clear. */
async function clearAfterCancel(s: Seeded, no: string) {
  const saleId = await newSale(s);
  const chequeId = await registerCheque(s, saleId, no);
  await deposit(s, chequeId);
  await cancelSale(s, saleId);
  const key = crypto.randomUUID();
  const paymentId = await clear(s, chequeId, key);
  const movement = await movementOf(s.t, s.orgId, paymentId);
  return { saleId, chequeId, key, paymentId, movement };
}

describe("SCRUM-724 cancelled-sale cheque credit: clearing", () => {
  test("a. cheque cleared after the sale was cancelled becomes unapplied 2110 credit with lineage", async () => {
    const s = await seed("a");
    const { saleId, chequeId, key, paymentId, movement } = await clearAfterCancel(s, "A-1");
    const lines = await glLines(s.t, s.orgId, "collectionPayments", String(paymentId));
    expect(sum(lines, "debit")).toBe(3000);
    expect(sum(lines, "credit")).toBe(3000);
    expect(lines.find((l) => l.key === SYSTEM_KEYS.BANK_ACCOUNT)?.debit).toBe(3000);
    expect(lines.find((l) => l.key === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.credit).toBe(3000);
    const position = await positionOf(s.t, s.orgId, movement._id);
    expect(position.remainingUnappliedMinor).toBe(3000);
    expect(position.sourceChequeId).toBe(chequeId);
    expect(position.originatingSaleId).toBe(saleId);
    expect(await applicationsFor(s.t, s.orgId)).toHaveLength(0);
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("CANCELLED");
    // exact replay: same payment, no second journal
    expect(await clear(s, chequeId, key)).toBe(paymentId);
    expect(await glLines(s.t, s.orgId, "collectionPayments", String(paymentId))).toHaveLength(lines.length);
    const payments = await s.t.run((ctx) => ctx.db.query("collectionPayments")
      .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId)).collect());
    expect(payments).toHaveLength(1);
  }, 30_000);

  test("b. cheque cleared BEFORE the cancel keeps identical lineage once the sale is cancelled", async () => {
    const s = await seed("b");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "B-1");
    await deposit(s, chequeId);
    const paymentId = await clear(s, chequeId);
    const movement = await movementOf(s.t, s.orgId, paymentId);
    expect(await applicationsFor(s.t, s.orgId)).toMatchObject([{ status: "PENDING", amountMinor: 3000 }]);
    await cancelSale(s, saleId);
    expect((await applicationsFor(s.t, s.orgId))[0].status).toBe("CANCELLED");
    const position = await positionOf(s.t, s.orgId, movement._id);
    expect(position.sourceChequeId).toBe(chequeId);
    expect(position.originatingSaleId).toBe(saleId);
    expect(position.remainingUnappliedMinor).toBe(3000);
    const credits = await s.asOwner.query(api.collections.listRetainedCredits, {
      orgId: s.orgId, customerId: s.customerId, paginationOpts: { cursor: null, numItems: 20 },
    });
    expect(credits.page.find((r) => r.receiptMovementId === movement._id))
      .toMatchObject({ availableUnappliedMinor: 3000, sourceChequeId: chequeId, originatingSaleId: saleId,
        originatingSaleStatus: "CANCELLED" });
  }, 30_000);

  test("c. a HELD cheque of a cancelled sale can be neither deposited nor cleared; nothing changes", async () => {
    const s = await seed("c");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "C-1");
    await cancelSale(s, saleId);
    for (const act of [
      () => deposit(s, chequeId),
      () => clear(s, chequeId),
    ]) {
      const err = await act().then(() => null, (e: unknown) => e as { data?: { code?: string } });
      expect(err?.data?.code).toBe("CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER");
    }
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("HELD");
    expect(await s.t.run((ctx) => ctx.db.query("collectionPayments").collect())).toHaveLength(0);
  }, 30_000);

  test("c2. a HELD cheque of a cancelled sale can still be RETURNED to the customer, with no journal", async () => {
    const s = await seed("c2");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "C2-1");
    await cancelSale(s, saleId);
    const eventsBefore = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    await s.asOwner.mutation(api.collections.returnCheque, { orgId: s.orgId, chequeId, returnReason: "sale cancelled" });
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("RETURNED");
    expect(await s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).toHaveLength(eventsBefore.length);
    expect(await s.t.run((ctx) => ctx.db.query("collectionPayments").collect())).toHaveLength(0);
  }, 30_000);

  test("d. replacement keeps invoiceSaleId; replace -> deposit -> cancel -> clear yields lineage", async () => {
    const s = await seed("d");
    const saleId = await newSale(s);
    const oldId = await registerCheque(s, saleId, "D-1");
    const newId = (await s.asOwner.mutation(api.collections.replaceCheque, {
      orgId: s.orgId, chequeId: oldId, bank: "Test Bank", chequeNumber: "D-2",
      chequeDate: Date.now(), amount: 30,
    })) as Id<"postDatedCheques">;
    const fresh = await s.t.run((ctx) => ctx.db.get(newId));
    expect(fresh?.invoiceSaleId).toBe(saleId);
    await deposit(s, newId);
    await cancelSale(s, saleId);
    const paymentId = await clear(s, newId);
    const position = await positionOf(s.t, s.orgId, (await movementOf(s.t, s.orgId, paymentId))._id);
    expect(position.sourceChequeId).toBe(newId);
    expect(position.originatingSaleId).toBe(saleId);
    expect(position.remainingUnappliedMinor).toBe(3000);
  }, 30_000);

  test("a2. identity mismatch (cheque of another customer than the sale) is still refused after cancel", async () => {
    const s = await seed("a2");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "A2-1");
    await deposit(s, chequeId);
    const other = await s.t.run((ctx) => ctx.db.insert("customers", {
      orgId: s.orgId, firstName: "Other", lastName: "Cust", createdAt: Date.now(),
    }));
    await s.t.run((ctx) => ctx.db.patch(chequeId, { customerId: other }));
    await cancelSale(s, saleId);
    await expect(clear(s, chequeId)).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("DEPOSITED");
  }, 30_000);
});

describe("SCRUM-724 cancelled-sale credit: reallocation", () => {
  test("f. credit moves to another COMPLETED sale of the same customer only", async () => {
    const s = await seed("f");
    const { saleId, movement } = await clearAfterCancel(s, "F-1");
    const otherSale = await newSale(s);
    const otherCustomer = await s.t.run((ctx) => ctx.db.insert("customers", {
      orgId: s.orgId, firstName: "Else", lastName: "One", createdAt: Date.now(),
    }));
    const foreignSale = await newSale(s, otherCustomer);
    const args = (target: Id<"sales">) => ({
      orgId: s.orgId, saleId: target, receiptMovementId: movement._id,
      amountMinor: 3000, idempotencyKey: crypto.randomUUID(),
    });
    await expect(s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, args(saleId))).rejects.toThrow();
    await expect(s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, args(foreignSale))).rejects.toThrow();
    const appId = await s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, args(otherSale));
    expect((await s.t.run((ctx) => ctx.db.get(appId)))?.saleId).toBe(otherSale);
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("CANCELLED");
  }, 30_000);
});

describe("SCRUM-724 cancelled-sale credit: authorized refund", () => {
  async function refundFixture(suffix: string) {
    const s = await seed(suffix);
    const base = await clearAfterCancel(s, `${suffix}-1`);
    const paidAt = Date.now() - 1000;
    const mutation = (name: "requestRetainedCreditRefund" | "respondToRetainedCreditRefund" | "executeRetainedCreditRefund") =>
      (api as any).retainedCreditRefunds[name];
    const request = (amountMinor = 3000, as = s.asOwner) => as.mutation(mutation("requestRetainedCreditRefund"), {
      orgId: s.orgId, receiptMovementId: base.movement._id, amountMinor, method: "BANK_TRANSFER", reason: "Customer asked for money back",
    }) as Promise<Id<"retainedCreditRefundRequests">>;
    const respond = (requestId: Id<"retainedCreditRefundRequests">, as = s.approver.as, status: "APPROVED" | "REJECTED" = "APPROVED") =>
      as.mutation(mutation("respondToRetainedCreditRefund"), {
        orgId: s.orgId, requestId, status, idempotencyKey: crypto.randomUUID(),
      });
    const execute = (requestId: Id<"retainedCreditRefundRequests">, key = crypto.randomUUID(), as = s.asOwner) =>
      as.mutation(mutation("executeRetainedCreditRefund"), {
        orgId: s.orgId, requestId, reference: "PV-1", paidAt, idempotencyKey: key,
      }) as Promise<{ paymentId: Id<"canonicalPayments">; eventId: Id<"accountingEvents"> }>;
    return { s, ...base, request, respond, execute };
  }

  test("e1. request -> different approver -> execute posts DR 2110 / CR Bank once", async () => {
    const { s, movement, request, respond, execute } = await refundFixture("e1");
    const requestId = await request(1200);
    await respond(requestId);
    const key = crypto.randomUUID();
    const done = await execute(requestId, key);
    expect(await execute(requestId, key)).toEqual(done); // same key replay
    const payment = await s.t.run((ctx) => ctx.db.get(done.paymentId));
    expect(payment).toMatchObject({ status: "SETTLED", direction: "OUT", amountMinor: 1200, accountingEventId: done.eventId });
    const lines = await glLines(s.t, s.orgId, "receiptRetainedPositions",
      `${(await positionOf(s.t, s.orgId, movement._id))._id}:refund:${requestId}`);
    expect(lines.find((l) => l.key === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.debit).toBe(1200);
    expect(lines.find((l) => l.key === SYSTEM_KEYS.BANK_ACCOUNT)?.credit).toBe(1200);
    expect((await positionOf(s.t, s.orgId, movement._id)).remainingUnappliedMinor).toBe(1800);
    // executing the same request again under a new key pays nothing more
    await expect(execute(requestId)).rejects.toThrow();
    const outs = await s.t.run((ctx) => ctx.db.query("canonicalPayments")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect());
    expect(outs.filter((p) => p.direction === "OUT")).toHaveLength(1);
    // over-refund of the remainder refused
    await expect(request(1801)).rejects.toThrow();
  }, 30_000);

  test("e2. self-approval, missing APPROVE_REQUESTS, view-only and unapproved execution are refused", async () => {
    const { s, movement, request, respond, execute } = await refundFixture("e2");
    const requestId = await request(1000);
    await expect(respond(requestId, s.asOwner)).rejects.toThrow(); // requester == decider
    await expect(respond(requestId, s.financeOnly.as)).rejects.toThrow(); // no approve:requests
    await expect(respond(requestId, s.viewOnly.as)).rejects.toThrow();
    await expect(request(1000, s.viewOnly.as)).rejects.toThrow();
    await expect(execute(requestId)).rejects.toThrow(); // still PENDING
    await respond(requestId);
    await expect(execute(requestId, crypto.randomUUID(), s.viewOnly.as)).rejects.toThrow();
    expect((await positionOf(s.t, s.orgId, movement._id)).remainingUnappliedMinor).toBe(3000);
    expect((await s.t.run((ctx) => ctx.db.query("canonicalPayments")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())).filter((p) => p.direction === "OUT")).toHaveLength(0);
  }, 30_000);

  test("e3. another organization cannot request, decide or execute", async () => {
    const { s, movement, request, respond, execute } = await refundFixture("e3");
    const foreign = await seed("e3x");
    const requestId = await request(500);
    await expect((foreign.asOwner as any).mutation((api as any).retainedCreditRefunds.requestRetainedCreditRefund, {
      orgId: foreign.orgId, receiptMovementId: movement._id, amountMinor: 500, method: "CASH", reason: "x",
    })).rejects.toThrow();
    await expect((foreign.approver.as as any).mutation((api as any).retainedCreditRefunds.respondToRetainedCreditRefund, {
      orgId: foreign.orgId, requestId, status: "APPROVED", idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow();
    await respond(requestId);
    await expect((foreign.asOwner as any).mutation((api as any).retainedCreditRefunds.executeRetainedCreditRefund, {
      orgId: foreign.orgId, requestId, reference: "PV", paidAt: Date.now() - 10, idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow();
    await expect(execute(requestId)).resolves.toBeDefined();
    expect(s).toBeDefined();
  }, 30_000);

  test("e4. a receipt that has not reached the ledger cannot be refunded; no rows written", async () => {
    const s = await seed("e4");
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) =>
        q.eq("orgId", s.orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)).unique();
      await ctx.db.delete(row!._id);
    });
    const { movement } = await clearAfterCancel(s, "E4-1");
    await expect((s.asOwner as any).mutation((api as any).retainedCreditRefunds.requestRetainedCreditRefund, {
      orgId: s.orgId, receiptMovementId: movement._id, amountMinor: 1000, method: "CASH", reason: "x",
    })).rejects.toThrow();
    expect(await s.t.run((ctx) => ctx.db.query("retainedCreditRefundRequests" as never).collect())).toHaveLength(0);
  }, 30_000);

  test("g. returning the cleared cheque after a standalone refund is refused with no writes", async () => {
    const { s, chequeId, paymentId, movement, request, respond, execute } = await refundFixture("g");
    const requestId = await request(1000);
    await respond(requestId);
    await execute(requestId);
    const before = await s.t.run(async (ctx) => ({
      pos: await ctx.db.query("receiptRetainedPositions").collect(),
      pay: await ctx.db.query("collectionPayments").collect(),
      ev: await ctx.db.query("accountingEvents").collect(),
      cheque: await ctx.db.get(chequeId),
    }));
    const err = await s.asOwner.mutation(api.collections.returnClearedCheque, {
      orgId: s.orgId, chequeId, idempotencyKey: crypto.randomUUID(),
    }).then(() => null, (e: unknown) => e as { data?: { code?: string } });
    expect(err?.data?.code).toBe("CHEQUE_RETURN_AFTER_CREDIT_REFUND");
    const after = await s.t.run(async (ctx) => ({
      pos: await ctx.db.query("receiptRetainedPositions").collect(),
      pay: await ctx.db.query("collectionPayments").collect(),
      ev: await ctx.db.query("accountingEvents").collect(),
      cheque: await ctx.db.get(chequeId),
    }));
    expect(after).toEqual(before);
    expect(paymentId).toBeDefined();
    expect(movement).toBeDefined();
  }, 30_000);

  test("h. a cleared cancelled-sale cheque with NO refund can still be returned (credit retired, no revenue)", async () => {
    const s = await seed("h");
    const { chequeId, movement } = await clearAfterCancel(s, "H-1");
    await s.asOwner.mutation(api.collections.returnClearedCheque, {
      orgId: s.orgId, chequeId, idempotencyKey: crypto.randomUUID(),
    });
    expect((await positionOf(s.t, s.orgId, movement._id)).remainingUnappliedMinor).toBe(0);
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("RETURNED");
  }, 30_000);
});
