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
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

// SCRUM-802 legacy-cash-lifecycle opt-out: this suite uses a cash completion only as a FIXTURE (it completes a cash sale, then collects or
// cancels it, to test something else), so it runs with the SCRUM-802 pilot containment off. The containment
// itself is pinned with the real switch by convex/scrum802CashSaleContainment.test.ts, and the certification
// files run with it on. The census in convex/scrum802OptOutCensus.test.ts allows only the files listed there.
vi.mock("./utils/saleDebtContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/saleDebtContainment")>()),
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false,
}));

/**
 * Both pilot switches ship ON. This suite exercises the doors' BEHAVIOR, so it
 * opens them by default; the "pilot containment" blocks below close them again
 * to prove the backend refuses before any write.
 */
const pilot = vi.hoisted(() => ({ payoutDisabled: false, invoiceDoorsDisabled: false }));
vi.mock("./utils/customerCreditPayoutContainment", async (importOriginal) =>
  (await import("../test-utils/pilotSwitchMock")).pilotSwitchModule(await importOriginal(), pilot));

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
  const bankAccountId = await t.run((ctx) => ctx.db.insert("bankAccounts", {
    orgId, name: "Cheque receipt bank", currency: "USD", openingBalanceMinor: 0,
    openingBalanceDate: Date.now(), isActive: true, isReconciliationTarget: false,
    createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
  }));

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
  return { t, asOwner, orgId, userId, customerId, bankAccountId, approver, financeOnly, viewOnly };
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
  s.asOwner.mutation(api.collections.clearCheque, { orgId: s.orgId, chequeId, bankAccountId: s.bankAccountId, idempotencyKey: key });

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
    const out: Array<{ key: string | undefined; debit: number; credit: number; status: string; bankAccountId?: Id<"bankAccounts"> }> = [];
    for (const e of entries) {
      const lines = await ctx.db.query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", e._id)).collect();
      for (const l of lines) {
        const acct = await ctx.db.get(l.accountId);
        out.push({ key: acct?.systemKey, debit: l.debitMinor, credit: l.creditMinor,
          status: e.status, bankAccountId: l.bankAccountId });
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

  test("c. a HELD cheque of a cancelled sale can be neither deposited, cleared nor replaced; nothing changes", async () => {
    const s = await seed("c");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "C-1");
    await cancelSale(s, saleId);
    const chequesBefore = await s.t.run((ctx) => ctx.db.query("postDatedCheques").collect());
    for (const act of [
      () => deposit(s, chequeId),
      () => clear(s, chequeId),
      () => s.asOwner.mutation(api.collections.replaceCheque, {
        orgId: s.orgId, chequeId, bank: "Test Bank", chequeNumber: "C-2",
        chequeDate: Date.now(), amount: 30,
      }),
    ]) {
      const err = await act().then(() => null, (e: unknown) => e as { data?: { code?: string } });
      expect(err?.data?.code).toBe("CHEQUE_SALE_CANCELLED_RETURN_TO_CUSTOMER");
    }
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("HELD");
    expect(await s.t.run((ctx) => ctx.db.query("postDatedCheques").collect())).toHaveLength(chequesBefore.length);
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
        orgId: s.orgId, requestId, bankAccountId: s.bankAccountId,
        reference: "PV-1", paidAt, idempotencyKey: key,
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
    expect(lines.find((l) => l.key === SYSTEM_KEYS.BANK_ACCOUNT)?.bankAccountId).toBe(s.bankAccountId);
    expect((await positionOf(s.t, s.orgId, movement._id)).remainingUnappliedMinor).toBe(1800);
    // executing the same request again under a new key pays nothing more
    await expect(execute(requestId)).rejects.toThrow();
    const outs = await s.t.run((ctx) => ctx.db.query("canonicalPayments")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect());
    expect(outs.filter((p) => p.direction === "OUT")).toHaveLength(1);
    // over-refund of the remainder refused
    await expect(request(1801)).rejects.toThrow();
  }, 30_000);

  test("a bank credit refund without a selected physical bank leaves approval and credit intact", async () => {
    const { s, movement, request, respond } = await refundFixture("e1bankmissing");
    const requestId = await request(1200);
    await respond(requestId);
    await expect(s.asOwner.mutation(api.retainedCreditRefunds.executeRetainedCreditRefund, {
      orgId: s.orgId, requestId, reference: "PV-MISSING", paidAt: Date.now() - 1000,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow(/Select the bank account/i);
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("APPROVED");
    expect((await positionOf(s.t, s.orgId, movement._id)).remainingUnappliedMinor).toBe(3000);
  });

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

  test("e5. listRetainedCreditRefundRequests.requestedByMe is true for the requester and false for a different finance user", async () => {
    const { s, request } = await refundFixture("e5");
    const requestId = await request(1000);
    const list = (as: { query: (...a: never[]) => Promise<unknown> } & Record<string, unknown>) =>
      (as as any).query((api as any).retainedCreditRefunds.listRetainedCreditRefundRequests,
        { orgId: s.orgId, status: "PENDING" }) as Promise<Array<{ _id: string; requestedByMe: boolean }>>;
    const mine = (await list(s.asOwner as never)).find((row) => row._id === requestId);
    const theirs = (await list(s.financeOnly.as as never)).find((row) => row._id === requestId);
    expect(mine?.requestedByMe).toBe(true);
    expect(theirs?.requestedByMe).toBe(false);
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

  const codeOf = (promise: Promise<unknown>) =>
    promise.then(() => null, (e: unknown) => (e as { data?: { code?: string } }).data?.code ?? "UNCODED");

  test("F2a. a reservation cannot claim credit that an open refund request already counts (coded refusal, nothing written)", async () => {
    const { s, movement, request, respond } = await refundFixture("f2a");
    const target = await newSale(s);
    const reserve = (amountMinor: number) => s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: target, receiptMovementId: movement._id, amountMinor, idempotencyKey: crypto.randomUUID(),
    });
    const pendingId = await request(2000); // PENDING counts
    expect(await codeOf(reserve(1500))).toBe("RETAINED_CREDIT_UNAVAILABLE");
    await respond(pendingId); // APPROVED still counts
    expect(await codeOf(reserve(1500))).toBe("RETAINED_CREDIT_UNAVAILABLE");
    expect((await s.t.run((ctx) => ctx.db.query("invoiceReceiptApplications").collect()))).toHaveLength(0);
    await expect(reserve(1000)).resolves.toBeDefined(); // 3000 - 2000 open is still free
  }, 60_000);

  test("F2b. the other order: credit already reserved is not requestable, and a REJECTED request frees it for a reservation", async () => {
    const { s, movement, request, respond } = await refundFixture("f2b");
    const target = await newSale(s);
    await s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: target, receiptMovementId: movement._id, amountMinor: 2500, idempotencyKey: crypto.randomUUID(),
    });
    expect(await codeOf(request(1000))).toBe("RETAINED_CREDIT_REFUND_INSUFFICIENT");
    const requestId = await request(500);
    await respond(requestId, s.approver.as, "REJECTED");
    await expect(s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: target, receiptMovementId: movement._id, amountMinor: 500, idempotencyKey: crypto.randomUUID(),
    })).resolves.toBeDefined();
  }, 60_000);

  test("RT1. deciding the same request twice: the second decision is refused NOT_PENDING and nothing changes", async () => {
    const { s, request, respond } = await refundFixture("rt1");
    const requestId = await request(1000);
    await respond(requestId);
    expect(await codeOf(respond(requestId))).toBe("RETAINED_CREDIT_REFUND_NOT_PENDING");
    expect(await codeOf(respond(requestId, s.approver.as, "REJECTED"))).toBe("RETAINED_CREDIT_REFUND_NOT_PENDING");
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("APPROVED");
  }, 60_000);

  test.each([0, -1, 1.5, Number.NaN])("RT2. a refund request of %s is refused INVALID_AMOUNT with no row", async (amount) => {
    const { s, request } = await refundFixture(`rt2${String(amount).replace(/W/g, "x")}`);
    expect(await codeOf(request(amount))).toBe("RETAINED_CREDIT_REFUND_INVALID_AMOUNT");
    expect(await s.t.run((ctx) => ctx.db.query("retainedCreditRefundRequests").collect())).toHaveLength(0);
  }, 60_000);

  test("RT3. a legacy position WITHOUT lineage fields can still be refunded and reallocated", async () => {
    const { s, movement, request, respond, execute } = await refundFixture("rt3");
    const position = (await s.t.run((ctx) => ctx.db.query("receiptRetainedPositions")
      .withIndex("by_org_movement", (q) => q.eq("orgId", s.orgId).eq("receiptMovementId", movement._id)).unique()))!;
    await s.t.run((ctx) => ctx.db.replace(position._id, (({ _id, _creationTime, sourceChequeId, originatingSaleId, ...rest }) => rest)(position)));
    const legacy = await s.t.run((ctx) => ctx.db.get(position._id));
    expect(legacy?.sourceChequeId).toBeUndefined();
    expect(legacy?.originatingSaleId).toBeUndefined();
    const requestId = await request(1000);
    await respond(requestId);
    await execute(requestId);
    const target = await newSale(s);
    await expect(s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
      orgId: s.orgId, saleId: target, receiptMovementId: movement._id, amountMinor: 2000, idempotencyKey: crypto.randomUUID(),
    })).resolves.toBeDefined();
    const listed = await s.asOwner.query(api.collections.listRetainedCredits, {
      orgId: s.orgId, customerId: s.customerId, onlyRemaining: false, paginationOpts: { cursor: null, numItems: 20 },
    });
    expect(listed.page[0]?.sourceChequeId).toBeUndefined();
    expect(listed.page[0]?.originatingSaleId).toBeUndefined();
  }, 60_000);

  test("RT4. clearing a DEPOSITED cancelled-sale cheque with the 2110 account unmapped DEFERS the posting (SCRUM-218-C), loses nothing, and posts exactly once when restored", async () => {
    const s = await seed("rt4");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "RT4-1");
    await deposit(s, chequeId);
    await cancelSale(s, saleId);
    const key = SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY;
    const removed = await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) =>
        q.eq("orgId", s.orgId).eq("systemKey", key)).unique())!;
      await ctx.db.delete(row._id);
      return row;
    });
    await clear(s, chequeId);
    const cheque = await s.t.run((ctx) => ctx.db.get(chequeId));
    expect(cheque?.status).toBe("CLEARED");
    const payments = await s.t.run((ctx) => ctx.db.query("collectionPayments").collect());
    expect(payments).toHaveLength(1);
    const movement = await movementOf(s.t, s.orgId, payments[0]!._id);
    const position = await positionOf(s.t, s.orgId, movement._id);
    expect(position.remainingUnappliedMinor).toBe(3000);
    // Nothing reached the ledger without 2110, and the posting is durably queued, not lost.
    const unbalanced = await s.t.run(async (ctx) => {
      const lines = await ctx.db.query("journalLines").collect();
      return lines.filter((l) => l.accountId === removed._id);
    });
    expect(unbalanced).toHaveLength(0);
    const queued = await s.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect());
    expect(queued.filter((q) => q.status === "PENDING").length).toBeGreaterThan(0);
    // Credit is not spendable-to-refund while its receipt is unposted? Record the observed behaviour only: restoring the
    // account and draining posts the receipt once and a second drain adds nothing.
    await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = removed;
      await ctx.db.insert("chartOfAccounts", rest);
    });
    const drain = async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
        for (let pass = 0; pass < 10; pass += 1) {
          await s.t.finishAllScheduledFunctions(vi.runAllTimers);
          const open = (await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()))
            .filter((x) => x.state.kind === "pending" || x.state.kind === "inProgress").length;
          if (open === 0) break;
        }
      } finally {
        vi.useRealTimers();
      }
    };
    await drain();
    const after = await glLines(s.t, s.orgId, "collectionPayments", String(payments[0]!._id));
    const credit2110 = after.filter((l) => l.key === key && l.status === "POSTED");
    expect(credit2110.reduce((a, l) => a + l.credit - l.debit, 0)).toBe(3000);
    await drain();
    const again = await glLines(s.t, s.orgId, "collectionPayments", String(payments[0]!._id));
    expect(again).toHaveLength(after.length);
  }, 60_000);

  test("RT6. executing a refund while the 2110 account is unmapped is refused: no payout, no journal, the request stays APPROVED", async () => {
    const { s, request, respond, execute } = await refundFixture("rt6");
    const requestId = await request(1000);
    await respond(requestId);
    await s.t.run(async (ctx) => {
      const row = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) =>
        q.eq("orgId", s.orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)).unique();
      await ctx.db.delete(row!._id);
    });
    await expect(execute(requestId)).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("APPROVED");
    const outs = await s.t.run((ctx) => ctx.db.query("canonicalPayments")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect());
    expect(outs.filter((p) => p.direction === "OUT")).toHaveLength(0);
  }, 60_000);

  test("RT5. a deleted (isDeleted) cheque cannot be deposited or cleared", async () => {
    const s = await seed("rt5");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "RT5-1");
    await s.t.run((ctx) => ctx.db.patch(chequeId, { isDeleted: true }));
    await expect(deposit(s, chequeId)).rejects.toThrow();
    await expect(clear(s, chequeId)).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("HELD");
    expect(await s.t.run((ctx) => ctx.db.query("collectionPayments").collect())).toHaveLength(0);
  }, 60_000);

  test("RT7. a DEPOSITED cheque whose cancelled source sale is soft-deleted still clears into credit with lineage (the bank already moved the money)", async () => {
    const s = await seed("rt7");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "RT7-1");
    await deposit(s, chequeId);
    await cancelSale(s, saleId);
    await s.t.run((ctx) => ctx.db.patch(saleId, { isDeleted: true }));
    await clear(s, chequeId);
    const payments = await s.t.run((ctx) => ctx.db.query("collectionPayments").collect());
    expect(payments).toHaveLength(1);
    const position = await positionOf(s.t, s.orgId, (await movementOf(s.t, s.orgId, payments[0]!._id))._id);
    expect(position).toMatchObject({ remainingUnappliedMinor: 3000, sourceChequeId: chequeId, originatingSaleId: saleId });
    const lines = await glLines(s.t, s.orgId, "collectionPayments", String(payments[0]!._id));
    expect(lines.find((l) => l.key === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.credit).toBe(3000);
  }, 60_000);

  test("G1. an open refund request holds its credit against applyRetainedCredit and the listing; REJECTED and EXECUTED release or consume it", async () => {
    const { s, movement, request, respond, execute } = await refundFixture("g1");
    const receivableId = (await s.asOwner.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, customerId: s.customerId,
      sourceType: "OTHER", creditSystemKey: "MISCELLANEOUS_INCOME", title: "Balance due",
      amount: 100, dueDate: Date.now() + 86_400_000,
    })) as Id<"receivables">;
    const apply = (requestedAmount: number) => s.asOwner.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, receiptMovementId: movement._id,
      receivableId, requestedAmount,
    });
    const listed = async () => (await s.asOwner.query(api.collections.listRetainedCredits, {
      orgId: s.orgId, customerId: s.customerId, onlyRemaining: false, paginationOpts: { cursor: null, numItems: 20 },
    })).page[0]!;

    expect(await listed()).toMatchObject({ remainingUnappliedMinor: 3000, availableUnappliedMinor: 3000 });
    const requestId = await request(2500);
    // PENDING already holds the credit: listing is net, apply cannot consume it.
    expect(await listed()).toMatchObject({ remainingUnappliedMinor: 3000, availableUnappliedMinor: 500 });
    await respond(requestId);
    expect(await listed()).toMatchObject({ availableUnappliedMinor: 500 });
    // asking for 3000 applies only the free 500, never the held 2500
    expect((await apply(30)).appliedMinor).toBe(500);
    expect(await listed()).toMatchObject({ remainingUnappliedMinor: 2500, availableUnappliedMinor: 0 });
    // nothing free is left: refused with the coded reason, nothing written
    expect(await codeOf(apply(1))).toBe("RETAINED_CREDIT_UNAVAILABLE");
    expect((await listed()).remainingUnappliedMinor).toBe(2500);
    // executing consumes the held credit; nothing is double counted
    await execute(requestId);
    expect(await listed()).toMatchObject({ remainingUnappliedMinor: 0, availableUnappliedMinor: 0 });

    // REJECTED releases the hold (second movement)
    const g = await refundFixture("g1b");
    const receivable2 = (await g.s.asOwner.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(), orgId: g.s.orgId, customerId: g.s.customerId,
      sourceType: "OTHER", creditSystemKey: "MISCELLANEOUS_INCOME", title: "Balance due",
      amount: 100, dueDate: Date.now() + 86_400_000,
    })) as Id<"receivables">;
    const rejected = await g.request(2500);
    await g.respond(rejected, g.s.approver.as, "REJECTED");
    const afterReject = await g.s.asOwner.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(), orgId: g.s.orgId, receiptMovementId: g.movement._id,
      receivableId: receivable2, requestedAmount: 30,
    });
    expect(afterReject.appliedMinor).toBe(3000);
  }, 90_000);

  test("F1. the return guard fails closed at the request cap: 201 requests, the EXECUTED one LAST, still refuses with no writes", async () => {
    const { s, chequeId, movement } = await refundFixture("f1");
    const position = (await s.t.run((ctx) => ctx.db.query("receiptRetainedPositions")
      .withIndex("by_org_movement", (q) => q.eq("orgId", s.orgId).eq("receiptMovementId", movement._id)).unique()))!;
    await s.t.run(async (ctx) => {
      const base = {
        orgId: s.orgId, receiptMovementId: movement._id, positionId: position._id,
        customerId: position.customerId, currency: position.currency, amountMinor: 1,
        method: "CASH" as const, reason: "seed", requestedBy: s.userId, createdAt: 1, updatedAt: 1,
      };
      for (let i = 0; i < 200; i++) await ctx.db.insert("retainedCreditRefundRequests", { ...base, status: "REJECTED" });
      await ctx.db.insert("retainedCreditRefundRequests", { ...base, status: "EXECUTED" });
    });
    const snapshot = () => s.t.run(async (ctx) => ({
      pos: await ctx.db.query("receiptRetainedPositions").collect(),
      pay: await ctx.db.query("collectionPayments").collect(),
      ev: await ctx.db.query("accountingEvents").collect(),
      cheque: await ctx.db.get(chequeId),
    }));
    const before = await snapshot();
    const err = await s.asOwner.mutation(api.collections.returnClearedCheque, {
      orgId: s.orgId, chequeId, idempotencyKey: crypto.randomUUID(),
    }).then(() => null, (e: unknown) => e as { data?: { code?: string } });
    expect(err?.data?.code).toBe("CHEQUE_RETURN_AFTER_CREDIT_REFUND");
    expect(await snapshot()).toEqual(before);
  }, 60_000);

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

// ---------------------------------------------------------------------------
// SCRUM-724 Sol 6 (c22938): pilot containment, Q2-A clearing, Q3 exits, R4 bound
// ---------------------------------------------------------------------------

const errCode = (promise: Promise<unknown>) =>
  promise.then(() => null, (e: unknown) => (e as { data?: { code?: string } }).data?.code ?? "UNCODED");

const refundApi = () => (api as any).retainedCreditRefunds;

async function allRows(s: Seeded, table: "invoiceReceiptApplications" | "retainedCreditRefundRequests" | "collectionPayments" | "canonicalPayments" | "postDatedCheques") {
  // Loosely typed on purpose: the table is a runtime argument, so the row type is a union.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await s.t.run((ctx) => ctx.db.query(table).collect())) as Array<Record<string, any>>;
}

/** Cleared-after-cancel credit of 30.00 plus request/respond/cancel helpers. */
async function creditFixture(suffix: string) {
  const s = await seed(suffix);
  const base = await clearAfterCancel(s, `${suffix}-1`);
  const request = (amountMinor = 1000, as: { mutation: (...a: never[]) => Promise<unknown> } = s.asOwner as never) =>
    (as as any).mutation(refundApi().requestRetainedCreditRefund, {
      orgId: s.orgId, receiptMovementId: base.movement._id, amountMinor, method: "BANK_TRANSFER",
      reason: "Customer asked for money back",
    }) as Promise<Id<"retainedCreditRefundRequests">>;
  const respond = (requestId: Id<"retainedCreditRefundRequests">, status: "APPROVED" | "REJECTED" = "APPROVED") =>
    (s.approver.as as any).mutation(refundApi().respondToRetainedCreditRefund, {
      orgId: s.orgId, requestId, status, idempotencyKey: crypto.randomUUID(),
    });
  const execute = (requestId: Id<"retainedCreditRefundRequests">, as: unknown = s.asOwner) =>
    (as as any).mutation(refundApi().executeRetainedCreditRefund, {
      orgId: s.orgId, requestId, bankAccountId: s.bankAccountId,
      reference: "PV-1", paidAt: Date.now() - 1000, idempotencyKey: crypto.randomUUID(),
    });
  const cancel = (requestId: Id<"retainedCreditRefundRequests">, reason: string | undefined = "Customer withdrew", as: unknown = s.asOwner, orgId = s.orgId) =>
    (as as any).mutation(refundApi().cancelRetainedCreditRefund, { orgId, requestId, reason });
  const available = async () => (await s.asOwner.query(api.collections.listRetainedCredits, {
    orgId: s.orgId, customerId: s.customerId, onlyRemaining: false, paginationOpts: { cursor: null, numItems: 20 },
  })).page.find((row) => row.receiptMovementId === base.movement._id)!.availableUnappliedMinor;
  return { s, ...base, request, respond, execute, cancel, available };
}

describe("SCRUM-724 pilot containment: new retained-credit payout authority is dark (Q1=b, Q7)", () => {
  test("P1. with the payout switch ON, request, approve and execute are all refused before any write; reject and viewing stay", async () => {
    const f = await creditFixture("p1");
    // Open requests created while the doors were open: one PENDING, one APPROVED.
    const approvedId = await f.request(1000);
    await f.respond(approvedId);
    const pendingId = await f.request(500);
    const before = {
      requests: await allRows(f.s, "retainedCreditRefundRequests"),
      out: (await allRows(f.s, "canonicalPayments")).filter((p) => p.direction === "OUT"),
      events: (await f.s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).length,
    };
    pilot.payoutDisabled = true;
    try {
      expect(await errCode(f.request(100))).toBe("CUSTOMER_CREDIT_PAYOUT_DISABLED");
      expect(await errCode(f.respond(pendingId, "APPROVED"))).toBe("CUSTOMER_CREDIT_PAYOUT_DISABLED");
      expect(await errCode(f.execute(approvedId))).toBe("CUSTOMER_CREDIT_PAYOUT_DISABLED");
      expect(await allRows(f.s, "retainedCreditRefundRequests")).toEqual(before.requests);
      expect((await allRows(f.s, "canonicalPayments")).filter((p) => p.direction === "OUT")).toEqual(before.out);
      expect((await f.s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).length).toBe(before.events);
      // Viewing and the non-payout decision stay available.
      const listed = await (f.s.asOwner as any).query(refundApi().listRetainedCreditRefundRequests,
        { orgId: f.s.orgId, status: "PENDING" });
      expect(listed.map((row: { _id: string }) => row._id)).toContain(pendingId);
      await f.respond(pendingId, "REJECTED");
      expect((await f.s.t.run((ctx) => ctx.db.get(pendingId)))?.status).toBe("REJECTED");
    } finally {
      pilot.payoutDisabled = false;
    }
    // Positive control: with the switch flipped the same calls work.
    await expect(f.execute(approvedId)).resolves.toBeDefined();
  }, 60_000);

  test("P2. a CASH payout stays refused at execute even with the switch flipped off; the request stays APPROVED", async () => {
    const f = await creditFixture("p2");
    const requestId = (await (f.s.asOwner as any).mutation(refundApi().requestRetainedCreditRefund, {
      orgId: f.s.orgId, receiptMovementId: f.movement._id, amountMinor: 1000, method: "CASH", reason: "cash please",
    })) as Id<"retainedCreditRefundRequests">;
    await f.respond(requestId);
    expect(await errCode(f.execute(requestId))).toBe("CUSTOMER_CREDIT_CASH_PAYOUT_UNSUPPORTED");
    expect((await f.s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("APPROVED");
    expect((await allRows(f.s, "canonicalPayments")).filter((p) => p.direction === "OUT")).toHaveLength(0);
  }, 60_000);

  test("P3. each new sale-invoice door is refused with its OWN switch on, before any write; the payout switch does not open them", async () => {
    const s = await seed("p3");
    const saleId = await newSale(s);
    // A PENDING reservation made while the doors were open, to prove activate is refused too.
    const funding = await clearAfterCancel(s, "P3-F");
    const reserved = (await s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
      orgId: s.orgId, saleId, receiptMovementId: funding.movement._id, amountMinor: 1000, idempotencyKey: crypto.randomUUID(),
    })) as Id<"invoiceReceiptApplications">;
    const before = {
      cheques: await allRows(s, "postDatedCheques"),
      apps: await allRows(s, "invoiceReceiptApplications"),
      pays: await allRows(s, "collectionPayments"),
    };
    pilot.invoiceDoorsDisabled = true;
    pilot.payoutDisabled = false; // proves the two switches are independent
    try {
      expect(await errCode(registerCheque(s, saleId, "P3-C"))).toBe("SALE_INVOICE_RECEIPT_DOORS_DISABLED");
      expect(await errCode(s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
        orgId: s.orgId, saleId, receiptMovementId: funding.movement._id, amountMinor: 500, idempotencyKey: crypto.randomUUID(),
      }))).toBe("SALE_INVOICE_RECEIPT_DOORS_DISABLED");
      expect(await errCode(s.asOwner.mutation(api.collections.activateSaleInvoiceReceipt, {
        orgId: s.orgId, applicationId: reserved, amountMinor: 1000, idempotencyKey: crypto.randomUUID(),
      }))).toBe("SALE_INVOICE_RECEIPT_DOORS_DISABLED");
      expect(await errCode(s.asOwner.mutation(api.collections.recordPayment, {
        orgId: s.orgId, customerId: s.customerId, invoiceSaleId: saleId, amount: 10,
        method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      }))).toBe("SALE_INVOICE_RECEIPT_DOORS_DISABLED");
      expect(await allRows(s, "postDatedCheques")).toEqual(before.cheques);
      expect(await allRows(s, "invoiceReceiptApplications")).toEqual(before.apps);
      expect(await allRows(s, "collectionPayments")).toEqual(before.pays);
      // The ordinary receipt door (no invoiceSaleId) is NOT affected.
      await expect(s.asOwner.mutation(api.collections.recordPayment, {
        orgId: s.orgId, customerId: s.customerId, amount: 10,
        method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      })).resolves.toBeDefined();
    } finally {
      pilot.invoiceDoorsDisabled = false;
    }
  }, 90_000);

  test("P4. while the invoice-door switch is ON a clearing sale-invoice cheque still books the bank money as whole, UNRESERVED 2110 credit (never strands)", async () => {
    const s = await seed("p4");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "P4-1");
    await deposit(s, chequeId);
    pilot.invoiceDoorsDisabled = true;
    try {
      const paymentId = await clear(s, chequeId);
      const movement = await movementOf(s.t, s.orgId, paymentId);
      expect(await applicationsFor(s.t, s.orgId)).toHaveLength(0);
      expect(await positionOf(s.t, s.orgId, movement._id)).toMatchObject({
        remainingUnappliedMinor: 3000, sourceChequeId: chequeId, originatingSaleId: saleId,
      });
      const lines = await glLines(s.t, s.orgId, "collectionPayments", String(paymentId));
      expect(lines.find((l) => l.key === SYSTEM_KEYS.BANK_ACCOUNT)?.debit).toBe(3000);
      expect(lines.find((l) => l.key === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.credit).toBe(3000);
    } finally {
      pilot.invoiceDoorsDisabled = false;
    }
  }, 60_000);

  test("P5. the backend publishes availability: false while the switches are on, true when flipped; payout and doors are independent", async () => {
    const s = await seed("p5");
    const saleId = await newSale(s);
    const flags = async () => {
      const status = await s.asOwner.query(api.collections.saleInvoiceReceiptStatus, {
        orgId: s.orgId, saleId, paginationOpts: { cursor: null, numItems: 5 },
      });
      const summary = await s.asOwner.query(api.collections.summary, { orgId: s.orgId });
      return {
        statusPayout: (status as any).retainedCreditPayoutAvailable,
        statusDoors: (status as any).saleInvoiceDoorsAvailable,
        summaryPayout: (summary as any).retainedCreditPayoutAvailable,
      };
    };
    pilot.payoutDisabled = true; pilot.invoiceDoorsDisabled = true;
    try {
      expect(await flags()).toEqual({ statusPayout: false, statusDoors: false, summaryPayout: false });
      pilot.payoutDisabled = false;
      expect(await flags()).toEqual({ statusPayout: true, statusDoors: false, summaryPayout: true });
      pilot.invoiceDoorsDisabled = false;
      expect(await flags()).toEqual({ statusPayout: true, statusDoors: true, summaryPayout: true });
    } finally {
      pilot.payoutDisabled = false; pilot.invoiceDoorsDisabled = false;
    }
  }, 60_000);
});

describe("SCRUM-724 Q2=A: a cheque the bank clears into an over-covered LIVE sale becomes whole unreserved 2110 credit", () => {
  /** Registers a 30.00 cheque, then covers the invoice elsewhere so the cheque is over-covered (outstanding - reserved = 20.00 < 30.00). */
  async function overCovered(s: Seeded, no: string, depositFirst: boolean) {
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, no);
    if (depositFirst) await deposit(s, chequeId);
    await s.asOwner.mutation(api.collections.recordPayment, {
      orgId: s.orgId, customerId: s.customerId, invoiceSaleId: saleId, amount: 80,
      method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
    });
    return { saleId, chequeId };
  }

  test("Q2a. deposited -> over-covered -> clear: whole face to unreserved 2110, one journal, lineage, sale/AR untouched, replay adds nothing", async () => {
    const s = await seed("q2a");
    const { saleId, chequeId } = await overCovered(s, "Q2A-1", true);
    const appsBefore = await applicationsFor(s.t, s.orgId);
    expect(appsBefore).toHaveLength(1); // only the 80.00 cash reservation
    const invoiceId = (await s.t.run((ctx) => ctx.db.get(saleId)))!.canonicalReceivableDocumentId!;
    const arBefore = await s.t.run((ctx) => ctx.db.get(invoiceId));
    const key = crypto.randomUUID();
    const paymentId = await clear(s, chequeId, key);
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("CLEARED");
    const movement = await movementOf(s.t, s.orgId, paymentId);
    expect(await positionOf(s.t, s.orgId, movement._id)).toMatchObject({
      remainingUnappliedMinor: 3000, sourceChequeId: chequeId, originatingSaleId: saleId,
    });
    const lines = await glLines(s.t, s.orgId, "collectionPayments", String(paymentId));
    expect(sum(lines, "debit")).toBe(3000);
    expect(sum(lines, "credit")).toBe(3000);
    expect(lines.find((l) => l.key === SYSTEM_KEYS.BANK_ACCOUNT)?.debit).toBe(3000);
    expect(lines.find((l) => l.key === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.credit).toBe(3000);
    // No new reservation for this cheque; AR, invoice and sale are untouched.
    expect(await applicationsFor(s.t, s.orgId)).toHaveLength(1);
    expect(await s.t.run((ctx) => ctx.db.get(invoiceId))).toEqual(arBefore);
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("COMPLETED");
    // Exactly once: same key replays the stored payment, nothing more is posted.
    expect(await clear(s, chequeId, key)).toBe(paymentId);
    expect(await glLines(s.t, s.orgId, "collectionPayments", String(paymentId))).toHaveLength(lines.length);
    expect((await s.t.run((ctx) => ctx.db.query("collectionPayments")
      .withIndex("by_cheque", (q) => q.eq("chequeId", chequeId)).collect()))).toHaveLength(1);
    // The credit is spendable (unreserved) through the listing.
    const credits = await s.asOwner.query(api.collections.listRetainedCredits, {
      orgId: s.orgId, customerId: s.customerId, paginationOpts: { cursor: null, numItems: 20 },
    });
    expect(credits.page.find((row) => row.receiptMovementId === movement._id))
      .toMatchObject({ availableUnappliedMinor: 3000, reservedForSaleInvoicesMinor: 0 });
  }, 60_000);

  test("Q2b. a still-HELD uncovered cheque cannot be deposited or cleared (coded refusal), nothing changes", async () => {
    const s = await seed("q2b");
    const { chequeId } = await overCovered(s, "Q2B-1", false);
    const before = { cheques: await allRows(s, "postDatedCheques"), pays: await allRows(s, "collectionPayments") };
    expect(await errCode(deposit(s, chequeId))).toBe("CHEQUE_INVOICE_UNCOVERED_HELD");
    expect(await errCode(clear(s, chequeId))).toBe("CHEQUE_INVOICE_UNCOVERED_HELD");
    expect(await allRows(s, "postDatedCheques")).toEqual(before.cheques);
    expect(await allRows(s, "collectionPayments")).toEqual(before.pays);
    // It can still go back to the customer.
    await s.asOwner.mutation(api.collections.returnCheque, { orgId: s.orgId, chequeId, returnReason: "uncovered" });
    expect((await s.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("RETURNED");
  }, 60_000);

  test("Q2c. control: a covered DEPOSITED cheque still clears into a PENDING reservation when the doors are open", async () => {
    const s = await seed("q2c");
    const saleId = await newSale(s);
    const chequeId = await registerCheque(s, saleId, "Q2C-1");
    await deposit(s, chequeId);
    await clear(s, chequeId);
    expect(await applicationsFor(s.t, s.orgId)).toMatchObject([{ status: "PENDING", amountMinor: 3000 }]);
  }, 60_000);
});

describe("SCRUM-724 Q3: open refund requests always have an audited MANAGE_FINANCE exit", () => {
  test("X1. a PENDING request is withdrawn by its requester with a reason: audited, hold released, works while the payout switch is ON", async () => {
    const f = await creditFixture("x1");
    const requestId = await f.request(2500);
    expect(await f.available()).toBe(500);
    pilot.payoutDisabled = true;
    try {
      expect(await f.cancel(requestId, "Customer changed their mind")).toBe(requestId);
    } finally { pilot.payoutDisabled = false; }
    expect(await f.s.t.run((ctx) => ctx.db.get(requestId))).toMatchObject({
      status: "CANCELLED", cancelledBy: f.s.userId, cancelReason: "Customer changed their mind",
      cancelledFromStatus: "PENDING",
    });
    expect(typeof (await f.s.t.run((ctx) => ctx.db.get(requestId)) as any).cancelledAt).toBe("number");
    expect(await f.available()).toBe(3000);
    // A cancelled request can be neither approved nor executed.
    expect(await errCode(f.respond(requestId))).toBe("RETAINED_CREDIT_REFUND_NOT_PENDING");
    expect(await errCode(f.execute(requestId))).toBe("RETAINED_CREDIT_REFUND_NOT_APPROVED");
    // Exactly once: a retry is a no-op and keeps the original audit.
    const first = await f.s.t.run((ctx) => ctx.db.get(requestId)) as any;
    expect(await f.cancel(requestId, "different reason")).toBe(requestId);
    expect(await f.s.t.run((ctx) => ctx.db.get(requestId))).toEqual(first);
  }, 60_000);

  test("X2. an APPROVED request is cancelled by a different MANAGE_FINANCE user: hold released, no payout, no journal", async () => {
    const f = await creditFixture("x2");
    const requestId = await f.request(1000);
    await f.respond(requestId);
    const eventsBefore = (await f.s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).length;
    await f.cancel(requestId, "Wrong bank account", f.s.financeOnly.as);
    expect(await f.s.t.run((ctx) => ctx.db.get(requestId))).toMatchObject({
      status: "CANCELLED", cancelledBy: f.s.financeOnly.actorId, cancelledFromStatus: "APPROVED",
    });
    expect(await f.available()).toBe(3000);
    expect((await allRows(f.s, "canonicalPayments")).filter((p) => p.direction === "OUT")).toHaveLength(0);
    expect((await f.s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).length).toBe(eventsBefore);
  }, 60_000);

  test("X3. EXECUTED and REJECTED are never cancellable; a missing reason, no MANAGE_FINANCE and a wrong org are refused with nothing written", async () => {
    const f = await creditFixture("x3");
    const executedId = await f.request(1000);
    await f.respond(executedId);
    await f.execute(executedId);
    const rejectedId = await f.request(500);
    await f.respond(rejectedId, "REJECTED");
    const openId = await f.request(400);
    expect(await errCode(f.cancel(executedId))).toBe("RETAINED_CREDIT_REFUND_NOT_CANCELLABLE");
    expect(await errCode(f.cancel(rejectedId))).toBe("RETAINED_CREDIT_REFUND_NOT_CANCELLABLE");
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect(await errCode(f.cancel(openId, reason))).toBe("RETAINED_CREDIT_REFUND_CANCEL_REASON_REQUIRED");
    }
    expect(await errCode(f.cancel(openId, "ok", f.s.viewOnly.as))).not.toBeNull();
    const foreign = await seed("x3x");
    expect(await errCode(f.cancel(openId, "ok", foreign.asOwner, foreign.orgId))).not.toBeNull();
    expect((await f.s.t.run((ctx) => ctx.db.get(executedId)))?.status).toBe("EXECUTED");
    expect((await f.s.t.run((ctx) => ctx.db.get(rejectedId)))?.status).toBe("REJECTED");
    expect((await f.s.t.run((ctx) => ctx.db.get(openId)))?.status).toBe("PENDING");
  }, 90_000);

  test("X4. returning the cleared source cheque cancels open requests (audited) BEFORE reversing the source; none is left to strand", async () => {
    const f = await creditFixture("x4");
    const pendingId = await f.request(500);
    const approvedId = await f.request(700);
    await f.respond(approvedId);
    pilot.payoutDisabled = true; // the pilot state: the return must still work
    try {
      await f.s.asOwner.mutation(api.collections.returnClearedCheque, {
        orgId: f.s.orgId, chequeId: f.chequeId, idempotencyKey: crypto.randomUUID(),
      });
    } finally { pilot.payoutDisabled = false; }
    for (const id of [pendingId, approvedId]) {
      const row = (await f.s.t.run((ctx) => ctx.db.get(id)))!;
      expect(row).toMatchObject({ status: "CANCELLED", cancelledBy: f.s.userId });
      expect(row.cancelReason).toMatch(/cheque/i);
    }
    expect((await f.s.t.run((ctx) => ctx.db.get(approvedId)))?.cancelledFromStatus).toBe("APPROVED");
    expect((await positionOf(f.s.t, f.s.orgId, f.movement._id)).remainingUnappliedMinor).toBe(0);
    expect((await f.s.t.run((ctx) => ctx.db.get(f.chequeId)))?.status).toBe("RETURNED");
    expect(await errCode(f.execute(approvedId))).toBe("RETAINED_CREDIT_REFUND_NOT_APPROVED");
  }, 90_000);
});

describe("SCRUM-724 R4: the reservation bound equals the reversal bound (100 PENDING per receipt / sale)", () => {
  test("B1. the 101st PENDING reservation on one receipt is refused; 100 are accepted", async () => {
    const f = await creditFixture("b1");
    const target = await newSale(f.s);
    const position = await positionOf(f.s.t, f.s.orgId, f.movement._id);
    const invoiceId = (await f.s.t.run((ctx) => ctx.db.get(target)))!.canonicalReceivableDocumentId!;
    await f.s.t.run(async (ctx) => {
      for (let i = 0; i < 99; i++) {
        await ctx.db.insert("invoiceReceiptApplications", {
          orgId: f.s.orgId, receiptMovementId: f.movement._id, saleId: target, receivableDocumentId: invoiceId,
          customerId: f.s.customerId, currency: position.currency, amountMinor: 1, status: "PENDING",
          createdBy: f.s.userId, createdAt: Date.now(),
        });
      }
    });
    const reserve = (amountMinor: number) => f.s.asOwner.mutation(api.collections.reserveSaleInvoiceReceipt, {
      orgId: f.s.orgId, saleId: target, receiptMovementId: f.movement._id, amountMinor, idempotencyKey: crypto.randomUUID(),
    });
    await expect(reserve(1)).resolves.toBeDefined(); // the 100th
    await expect(reserve(1)).rejects.toThrow(/too many pending applications/i); // the 101st
    const pending = (await applicationsFor(f.s.t, f.s.orgId)).filter((row) => row.status === "PENDING");
    expect(pending).toHaveLength(100);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// SCRUM-831: a default MANAGER (approve:requests, no view:finance) works the queue
// ---------------------------------------------------------------------------

describe("SCRUM-831 manager retained-credit refund approval queue", () => {
  const queueApi = () => refundApi().listRetainedCreditRefundApprovalQueue;

  /** An actor holding EXACTLY a shipped role template, so a template edit changes the outcome. */
  async function templateActor(s: Seeded, template: string, suffix: string) {
    const name = `tpl${template.toLowerCase()}`;
    const permissions = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === template)!.permissions;
    const actorId = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("users", { clerkId: `${name}_${suffix}`, email: `${name}_${suffix}@x.com`, name });
      const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: template, permissions: [...permissions] });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId: id, roleId });
      return id;
    });
    return { actorId, as: s.t.withIdentity({ subject: `${name}_${suffix}`, clerkId: `${name}_${suffix}` }) };
  }
  const queue = (as: unknown, orgId: Id<"organizations">) =>
    (as as any).query(queueApi(), { orgId, paginationOpts: { numItems: 50, cursor: null } });
  const idsOf = (rows: Array<{ _id: string }>) => rows.map((row) => row._id);

  /**
   * Strict SCRUM-486 permission oracle. A call is REFUSED (false) only with the FORBIDDEN refusal
   * for exactly the one permission it requires; it is AUTHORIZED (true) only if it succeeds or
   * fails with one of the named domain codes. Anything else (a crash, another permission, an
   * unexpected code) throws, so an unexpected failure can never read as "authorized".
   */
  async function isAuthorized(call: Promise<unknown>, required: string, domainCodes: readonly string[] = []): Promise<boolean> {
    try {
      await call;
      return true;
    } catch (error) {
      const data = (error as { data?: { code?: unknown; message?: unknown } }).data;
      if (data?.code === "FORBIDDEN" && data.message === `Forbidden: Missing required permissions: ${required}`) return false;
      if (typeof data?.code === "string" && domainCodes.includes(data.code)) return true;
      throw new Error(`Unexpected outcome for a call requiring ${required}: ${data?.code ?? String(error)}`, { cause: error });
    }
  }

  test("Q1. the default MANAGER sees the pending request without view:finance; the finance query still refuses them", async () => {
    const f = await creditFixture("q1");
    const manager = await templateActor(f.s, "MANAGER", "q1");
    expect(DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "MANAGER")!.permissions).not.toContain("view:finance");
    const requestId = await f.request(1000);

    const result = await queue(manager.as, f.s.orgId);
    expect(idsOf(result.page)).toEqual([requestId]);
    expect(result.page[0]).toMatchObject({
      amountMinor: 1000, currency: "USD", method: "BANK_TRANSFER", reason: "Customer asked for money back",
      customerName: "Cust q1", requestedByMe: false,
    });
    // The finance listing stays finance-only: the narrow path did not broaden it.
    await expect((manager.as as any).query(refundApi().listRetainedCreditRefundRequests,
      { orgId: f.s.orgId, status: "PENDING" })).rejects.toThrow(/view:finance/);
  }, 60_000);

  test("Q2. the row carries only what a manager needs to judge; no internal ids, keys or decision fields", async () => {
    const f = await creditFixture("q2");
    const manager = await templateActor(f.s, "MANAGER", "q2");
    await f.request(1000);
    const [row] = (await queue(manager.as, f.s.orgId)).page;
    expect(Object.keys(row).sort()).toEqual([
      "_id", "amountMinor", "createdAt", "currency", "customerName", "method", "originatingSaleStatus",
      "payoutAvailable", "reason", "requestedByMe", "requestedByName", "sourceChequeLabel",
    ]);
    expect(row.sourceChequeLabel).toBe("Test Bank #q2-1");
    expect(row.originatingSaleStatus).toBe("CANCELLED");
    expect(row.requestedByName).toBe("Owner");
  }, 60_000);

  test("Q3. the default ACCOUNTANT (manage:finance, no approve:requests) and a view-only finance user are refused", async () => {
    const f = await creditFixture("q3");
    await f.request(1000);
    const accountant = await templateActor(f.s, "ACCOUNTANT", "q3");
    expect(DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "ACCOUNTANT")!.permissions).not.toContain("approve:requests");
    await expect(queue(accountant.as, f.s.orgId)).rejects.toThrow(/approve:requests/);
    await expect(queue(f.s.financeOnly.as, f.s.orgId)).rejects.toThrow(/approve:requests/);
    await expect(queue(f.s.viewOnly.as, f.s.orgId)).rejects.toThrow(/approve:requests/);
  }, 60_000);

  test("Q4. another organization's approver neither reads nor learns of this organization's requests", async () => {
    const f = await creditFixture("q4");
    const requestId = await f.request(1000);
    // The second tenant lives in the SAME database: a separate harness would hand out
    // identical ids and make the cross-tenant call vacuous.
    const otherOrgId = await f.s.t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "CCSC q4 other", createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: "mgr_q4_other", email: "mgr_q4_other@x.com", name: "Other" });
      const roleId = await ctx.db.insert("roles", {
        orgId, name: "MANAGER",
        permissions: [...DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "MANAGER")!.permissions],
      });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return orgId;
    });
    const otherManager = f.s.t.withIdentity({ subject: "mgr_q4_other", clerkId: "mgr_q4_other" });
    // Not a member of the credit's organization: refused outright.
    await expect(queue(otherManager, f.s.orgId)).rejects.toThrow(/not a member/i);
    // A member of their own organization sees only their own (empty) queue.
    const own = await queue(otherManager, otherOrgId);
    expect(own.page).toEqual([]);
    expect(JSON.stringify(own)).not.toContain(String(requestId));
  }, 60_000);

  test("Q4b. a request whose customer id points into another organization never exposes that customer's name", async () => {
    const f = await creditFixture("q4b");
    const manager = await templateActor(f.s, "MANAGER", "q4b");
    const requestId = await f.request(1000);
    expect((await queue(manager.as, f.s.orgId)).page[0].customerName).toBe("Cust q4b");

    // Same database as the request: a separate harness would hand out colliding ids.
    const foreignCustomerId = await f.s.t.run(async (ctx) => {
      const foreignOrgId = await ctx.db.insert("organizations", { name: "CCSC q4b foreign", createdAt: Date.now() });
      return await ctx.db.insert("customers", {
        orgId: foreignOrgId, firstName: "Foreign", lastName: "Secret", createdAt: Date.now(),
      });
    });
    await f.s.t.run((ctx) => ctx.db.patch(requestId, { customerId: foreignCustomerId }));

    const result = await queue(manager.as, f.s.orgId);
    // The request is still queued for the decision; only the foreign name is withheld.
    expect(idsOf(result.page)).toEqual([requestId]);
    expect(result.page[0].customerName).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/Foreign|Secret/);
  }, 60_000);

  test("Q5. only PENDING requests are queued, newest first; APPROVED, REJECTED and CANCELLED leave it", async () => {
    const f = await creditFixture("q5");
    const manager = await templateActor(f.s, "MANAGER", "q5");
    const older = await f.request(300);
    const newer = await f.request(400);
    const approved = await f.request(500);
    const rejected = await f.request(600);
    const cancelled = await f.request(700);
    await f.respond(approved, "APPROVED");
    await f.respond(rejected, "REJECTED");
    await f.cancel(cancelled);
    expect(idsOf((await queue(manager.as, f.s.orgId)).page)).toEqual([newer, older]);
  }, 60_000);

  test("Q6. the queue states whether payout is available; with the pilot switch ON it is readable and says false", async () => {
    const f = await creditFixture("q6");
    const manager = await templateActor(f.s, "MANAGER", "q6");
    const requestId = await f.request(1000);
    expect((await queue(manager.as, f.s.orgId)).page[0].payoutAvailable).toBe(true);
    pilot.payoutDisabled = true;
    try {
      const closed = await queue(manager.as, f.s.orgId);
      expect(closed.page[0].payoutAvailable).toBe(false);
      expect(idsOf(closed.page)).toEqual([requestId]);
    } finally {
      pilot.payoutDisabled = false;
    }
  }, 60_000);

  test("Q7. different-actor rule: the requester cannot decide their own request; the manager can; the read writes nothing", async () => {
    const f = await creditFixture("q7");
    const manager = await templateActor(f.s, "MANAGER", "q7");
    // `approver` holds manage:finance AND approve:requests, so only the different-actor rule stops it.
    const requestId = (await (f.s.approver.as as any).mutation(refundApi().requestRetainedCreditRefund, {
      orgId: f.s.orgId, receiptMovementId: f.movement._id, amountMinor: 1000, method: "BANK_TRANSFER", reason: "Own request",
    })) as Id<"retainedCreditRefundRequests">;

    const seenByRequester = (await queue(f.s.approver.as, f.s.orgId)).page;
    expect(seenByRequester.find((row: { _id: string }) => row._id === requestId)?.requestedByMe).toBe(true);
    const decide = (as: unknown, status: "APPROVED" | "REJECTED") => (as as any).mutation(refundApi().respondToRetainedCreditRefund, {
      orgId: f.s.orgId, requestId, status, idempotencyKey: crypto.randomUUID(),
    });
    await expect(decide(f.s.approver.as, "APPROVED")).rejects.toThrow(/Requester cannot approve or reject their own/);
    await expect(decide(f.s.approver.as, "REJECTED")).rejects.toThrow(/Requester cannot approve or reject their own/);
    expect((await f.s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");

    const before = await allRows(f.s, "retainedCreditRefundRequests");
    const seenByManager = (await queue(manager.as, f.s.orgId)).page;
    expect(seenByManager.find((row: { _id: string }) => row._id === requestId)?.requestedByMe).toBe(false);
    expect(await allRows(f.s, "retainedCreditRefundRequests")).toEqual(before);

    await decide(manager.as, "APPROVED");
    expect((await f.s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("APPROVED");
    expect((await queue(manager.as, f.s.orgId)).page).toEqual([]);
    // The manager holds no manage:finance, so execute and cancel stay finance-only.
    await expect(f.execute(requestId, manager.as)).rejects.toThrow(/manage:finance/);
    await expect(f.cancel(requestId, "nope", manager.as)).rejects.toThrow(/manage:finance/);
  }, 90_000);

  test("Q8. SCRUM-486 permission matrix: refund authority per shipped role template (literal expectations)", async () => {
    // Literals, written from the SCRUM-831 c23014 ruling and SCRUM-724: the approval queue and
    // the decision need approve:requests; the finance list needs view:finance; execute and
    // cancel need manage:finance. A template that gains or loses one of these changes a cell.
    const MATRIX: Record<string, { queue: boolean; financeList: boolean; decide: boolean; execute: boolean; cancel: boolean }> = {
      OWNER: { queue: true, financeList: true, decide: true, execute: true, cancel: true },
      MANAGER: { queue: true, financeList: false, decide: true, execute: false, cancel: false },
      SALES: { queue: false, financeList: false, decide: false, execute: false, cancel: false },
      RECEPTION: { queue: false, financeList: false, decide: false, execute: false, cancel: false },
      ACCOUNTANT: { queue: false, financeList: true, decide: false, execute: true, cancel: true },
      SENIOR_ACCOUNTANT: { queue: false, financeList: true, decide: false, execute: true, cancel: true },
    };
    expect(DEFAULT_ROLE_TEMPLATES.map((role) => role.name).sort()).toEqual(Object.keys(MATRIX).sort());

    const f = await creditFixture("q8");

    // Requesting is itself refused while the payout switch is ON, so each role's request is raised first.
    const requestIds: Record<string, Id<"retainedCreditRefundRequests">> = {};
    for (const role of DEFAULT_ROLE_TEMPLATES) requestIds[role.name] = await f.request(100);

    // The pilot state: the payout switch stays ON. Reject authorizes nothing and stays live; execute
    // is refused by the switch only AFTER its permission check.
    pilot.payoutDisabled = true;
    try {
      for (const role of DEFAULT_ROLE_TEMPLATES) {
        const expected = MATRIX[role.name];
        const actor = await templateActor(f.s, role.name, `q8${role.name.toLowerCase()}`);
        const requestId = requestIds[role.name];
        const cells = {
          queue: await isAuthorized(queue(actor.as, f.s.orgId), "approve:requests"),
          financeList: await isAuthorized((actor.as as any).query(refundApi().listRetainedCreditRefundRequests,
            { orgId: f.s.orgId, status: "PENDING" }), "view:finance"),
          // An empty reason is refused AFTER the permission check, so it never cancels the request.
          cancel: await isAuthorized(f.cancel(requestId, "", actor.as), "manage:finance",
            ["RETAINED_CREDIT_REFUND_CANCEL_REASON_REQUIRED"]),
          execute: await isAuthorized(f.execute(requestId, actor.as), "manage:finance",
            ["CUSTOMER_CREDIT_PAYOUT_DISABLED"]),
          decide: await isAuthorized((actor.as as any).mutation(refundApi().respondToRetainedCreditRefund, {
            orgId: f.s.orgId, requestId, status: "REJECTED", idempotencyKey: crypto.randomUUID(),
          }), "approve:requests"),
        };
        expect({ role: role.name, ...cells }).toEqual({ role: role.name, ...expected });
        expect((await f.s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe(expected.decide ? "REJECTED" : "PENDING");
      }
    } finally {
      pilot.payoutDisabled = false;
    }
    // Only the PENDING requests of roles that cannot decide are still queued.
    const pendingAfter = await f.s.t.run((ctx) => ctx.db.query("retainedCreditRefundRequests").collect());
    expect(pendingAfter.filter((row) => row.status === "PENDING")).toHaveLength(4);
    expect(pendingAfter.filter((row) => row.status === "REJECTED")).toHaveLength(2);
  }, 120_000);

  test("Q9. every PENDING request is reachable by cursor, newest first; a page is capped; another tenant's rows never join", async () => {
    const f = await creditFixture("q9");
    const manager = await templateActor(f.s, "MANAGER", "q9");
    const seedId = await f.request(1000);
    // The regression scenario schema cannot express this setup: one valid seed request is cloned into 130 PENDING
    // requests in the same org (distinct amounts), plus a PENDING row of a foreign org in the same database.
    const TOTAL = 130; // more than the 100 the unpaged read used to stop at
    const ids = await f.s.t.run(async (ctx) => {
      const { _id, _creationTime, ...fields } = (await ctx.db.get(seedId))!;
      const inserted: Array<Id<"retainedCreditRefundRequests">> = [_id];
      for (let i = 1; i < TOTAL; i++) {
        inserted.push(await ctx.db.insert("retainedCreditRefundRequests", { ...fields, amountMinor: 1000 + i }));
      }
      // A PENDING request of ANOTHER organization, in the same database.
      const foreignOrgId = await ctx.db.insert("organizations", { name: "CCSC q9 foreign", createdAt: Date.now() });
      await ctx.db.insert("retainedCreditRefundRequests", { ...fields, orgId: foreignOrgId });
      return inserted;
    });

    const page = (numItems: number, cursor: string | null) =>
      (manager.as as any).query(queueApi(), { orgId: f.s.orgId, paginationOpts: { numItems, cursor } });
    const walked: Array<{ _id: string; payoutAvailable: boolean }> = [];
    let cursor: string | null = null;
    let pages = 0;
    for (; pages < 20; pages++) {
      const next: { page: typeof walked; isDone: boolean; continueCursor: string } = await page(50, cursor);
      expect(next.page.length).toBeLessThanOrEqual(50);
      walked.push(...next.page);
      if (next.isDone) { pages++; break; }
      cursor = next.continueCursor;
    }
    expect(pages).toBe(3); // 50 + 50 + 30
    // Item 101 and beyond are reachable: all 130, none twice, newest first, none from another tenant.
    expect(walked.map((row) => row._id)).toEqual([...ids].reverse());
    expect(walked.every((row) => row.payoutAvailable === true)).toBe(true);

    // The numItems of a first-page request is capped server-side (one page fans out several reads per row).
    // This proves the cap on the first page only: the oversized continuation just returns the 30 remaining rows,
    // so it proves neither a continuation cap nor an end-cursor replay cap.
    const oversized = await page(100_000, null);
    expect(oversized.page).toHaveLength(100);
    expect(oversized.isDone).toBe(false);
    expect(idsOf((await page(100_000, oversized.continueCursor)).page)).toEqual([...ids].reverse().slice(100));
  }, 90_000);

  test("Q8b. negative control: the matrix oracle refuses to read an unrelated failure as a verdict", async () => {
    const forbidden = (permission: string) =>
      Promise.reject(new ConvexError({ code: "FORBIDDEN", message: `Forbidden: Missing required permissions: ${permission}` }));
    const coded = (code: string) => Promise.reject(new ConvexError({ code, message: "domain refusal" }));
    const CANCEL_CODE = ["RETAINED_CREDIT_REFUND_CANCEL_REASON_REQUIRED"];

    // What it must accept.
    expect(await isAuthorized(forbidden("manage:finance"), "manage:finance")).toBe(false);
    expect(await isAuthorized(Promise.resolve("ok"), "manage:finance")).toBe(true);
    expect(await isAuthorized(coded(CANCEL_CODE[0]), "manage:finance", CANCEL_CODE)).toBe(true);

    // What it must reject: each would have been a false "authorized" under the old any-other-error rule.
    await expect(isAuthorized(Promise.reject(new Error("boom")), "manage:finance", CANCEL_CODE)).rejects.toThrow(/Unexpected outcome/);
    await expect(isAuthorized(coded("RETAINED_CREDIT_REFUND_NOT_FOUND"), "manage:finance", CANCEL_CODE)).rejects.toThrow(/Unexpected outcome/);
    await expect(isAuthorized(coded(CANCEL_CODE[0]), "manage:finance")).rejects.toThrow(/Unexpected outcome/);
    // A refusal for a different permission, or for a list of them, is not the exact one required.
    await expect(isAuthorized(forbidden("view:finance"), "manage:finance")).rejects.toThrow(/Unexpected outcome/);
    await expect(isAuthorized(forbidden("manage:finance, view:finance"), "manage:finance")).rejects.toThrow(/Unexpected outcome/);
  });
});
