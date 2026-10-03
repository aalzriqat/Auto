/**
 * SCRUM-571 slice 1 (D-18 / D-20) — competing-debt containment.
 *
 * Invariant: a sale's customer debt exists only as its canonical sale invoice.
 * After this slice no new legacy `receivables` row carrying a saleId can be
 * created, no sale completes or cancels while one exists, and no receipt,
 * credit, cheque or allocation targets one. Every refusal asserts that NOTHING
 * was written — no payment, allocation, posting, or idempotency record.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { AppErrorCode } from "./utils/errors";
import { SALE_DEBT_CONTAINMENT_REFUSALS, saleHasLegacyReceivable } from "./utils/saleDebtContainment";
import { cancelCompletedSaleOperationalRecords } from "./utils/saleCancellation";

const DUE = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

const TRACKED = [
  "receivables",
  "receivableDocuments",
  "collectionPayments",
  "canonicalPayments",
  "paymentAllocations",
  "postDatedCheques",
  "transactions",
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "commandIdempotency",
  "unmatchedProviderFunds",
] as const;

type T = ReturnType<typeof convexTestWithComponents>;

export async function counts(t: T) {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of TRACKED) out[table] = (await ctx.db.query(table).take(10_000)).length;
    return out;
  });
}

export async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    return data?.code ?? `plain:${String(error)}`;
  }
  return undefined;
}

export async function seedWorld() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "571s1 Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s571s1_user", email: "s571s1@example.com", name: "Finance User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s571s1_approver", email: "s571s1a@example.com", name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Manager",
      permissions: ["view:finance", "manage:finance", "approve:requests", "manage:sales", "view:sales", "create:sales"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  return {
    t,
    orgId,
    userId,
    approverId,
    customerId,
    asFinance: t.withIdentity({ subject: "s571s1_user", clerkId: "s571s1_user" }),
    asApprover: t.withIdentity({ subject: "s571s1_approver", clerkId: "s571s1_approver" }),
  };
}
export type World = Awaited<ReturnType<typeof seedWorld>>;

export async function insertSale(w: World, status: "PENDING" | "COMPLETED" = "PENDING") {
  return await w.t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId: w.orgId,
      vin: `VIN${crypto.randomUUID().slice(0, 12)}`,
      make: "Kia",
      model: "Rio",
      year: 2021,
      mileage: 30_000,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 15_000,
      status: status === "COMPLETED" ? "SOLD" : "AVAILABLE",
      sourceType: "STOCK",
    });
    const saleId = await ctx.db.insert("sales", {
      orgId: w.orgId,
      vehicleId,
      customerId: w.customerId,
      salespersonId: w.userId,
      salePrice: 15_000,
      saleDate: Date.now(),
      status,
    });
    if (status === "COMPLETED") await ctx.db.patch(vehicleId, { soldBySaleId: saleId });
    return { saleId, vehicleId };
  });
}

/** A legacy receivable row inserted directly (the writer is being closed). */
export async function insertLegacyReceivable(
  w: World,
  over: {
    saleId?: Id<"sales">;
    status?: "OPEN" | "PAID" | "CANCELLED" | "REFUNDED";
    orgId?: Id<"organizations">;
    customerId?: Id<"customers">;
    amount?: number;
  } = {}
) {
  const now = Date.now();
  const amount = over.amount ?? 400;
  return await w.t.run((ctx) =>
    ctx.db.insert("receivables", {
      orgId: over.orgId ?? w.orgId,
      customerId: over.customerId ?? w.customerId,
      saleId: over.saleId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Legacy receivable",
      originalAmount: amount,
      outstandingAmount: over.status === "PAID" || over.status === "CANCELLED" ? 0 : amount,
      dueDate: DUE(),
      status: over.status ?? "OPEN",
      createdBy: w.userId,
      createdAt: now,
      updatedAt: now,
    })
  );
}

describe("SCRUM-571 s1 — error strings carry verified Arabic", () => {
  test.each(Object.keys(SALE_DEBT_CONTAINMENT_REFUSALS))("%s has EN equal to the server text and a non-empty AR", (code) => {
    const key = `ServerError_${code}` as keyof typeof commonEn;
    expect(AppErrorCode[code as keyof typeof AppErrorCode]).toBe(code);
    expect(commonEn[key]).toBe(SALE_DEBT_CONTAINMENT_REFUSALS[code as keyof typeof SALE_DEBT_CONTAINMENT_REFUSALS]);
    expect(String(commonAr[key] ?? "").length).toBeGreaterThan(0);
  });
});

describe("SCRUM-571 s1 W1 — no new legacy receivable may carry a saleId", () => {
  const planArgs = (w: World, saleId?: Id<"sales">) => ({
    idempotencyKey: crypto.randomUUID(),
    orgId: w.orgId,
    customerId: w.customerId,
    saleId,
    title: "Plan",
    totalAmount: 900,
    installmentCount: 3,
    firstDueDate: DUE(),
    creditSystemKey: "MISCELLANEOUS_INCOME" as const,
  });
  const receivableArgs = (w: World, saleId?: Id<"sales">) => ({
    idempotencyKey: crypto.randomUUID(),
    orgId: w.orgId,
    customerId: w.customerId,
    saleId,
    sourceType: "INTERNAL_INSTALLMENT" as const,
    title: "Debt",
    amount: 400,
    dueDate: DUE(),
    creditSystemKey: "MISCELLANEOUS_INCOME" as const,
  });

  test("createReceivable with a saleId is refused and writes nothing", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.createReceivable, receivableArgs(w, saleId)))).toBe(
      "SALE_DEBT_COMPETING_RECEIVABLE_REFUSED"
    );
    expect(await counts(w.t)).toEqual(before);
  });

  test("createInstallmentPlan with a saleId is refused and writes nothing", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.createInstallmentPlan, planArgs(w, saleId)))).toBe(
      "SALE_DEBT_COMPETING_RECEIVABLE_REFUSED"
    );
    expect(await counts(w.t)).toEqual(before);
  });

  test("a sale from another org still reports Sale not found (precedence kept)", async () => {
    const w = await seedWorld();
    const otherOrg = await w.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() })
    );
    const otherW = { ...w, orgId: otherOrg } as World;
    const { saleId } = await insertSale(otherW);
    const code = await codeOf(w.asFinance.mutation(api.collections.createReceivable, receivableArgs(w, saleId)));
    expect(code).toContain("Sale not found");
  });

  test("a replay of a command completed before the guard is refused too", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const args = receivableArgs(w, saleId);
    // What the pre-guard mutation left behind after a successful call.
    await w.t.run((ctx) =>
      ctx.db.insert("commandIdempotency", {
        orgId: w.orgId,
        operation: "collections.createReceivable",
        idempotencyKey: args.idempotencyKey,
        status: "COMPLETED",
        // Same shape createReceivable fingerprints, so the replay reaches the
        // stored result instead of failing the fingerprint check.
        fingerprint: JSON.stringify({
          customerId: args.customerId.toString(),
          sourceType: args.sourceType,
          amount: args.amount,
          dueDate: args.dueDate,
          saleId: saleId.toString(),
          creditSystemKey: null,
          title: args.title.trim(),
          vehicleId: null,
          quoteId: null,
          applicationId: null,
          assignedTo: null,
          notes: null,
        }),
        result: "stored-result-of-the-old-call",
        createdBy: w.userId,
        createdAt: Date.now(),
        completedAt: Date.now(),
      })
    );
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.createReceivable, { ...args, creditSystemKey: undefined }))).toBe(
      "SALE_DEBT_COMPETING_RECEIVABLE_REFUSED"
    );
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: a receivable and a plan with no saleId are still created", async () => {
    const w = await seedWorld();
    const receivableId = await w.asFinance.mutation(api.collections.createReceivable, receivableArgs(w));
    const planIds = await w.asFinance.mutation(api.collections.createInstallmentPlan, planArgs(w));
    const row = await w.t.run((ctx) => ctx.db.get(receivableId));
    expect(row?.saleId).toBeUndefined();
    expect(row?.canonicalReceivableDocumentId).toBeTruthy();
    expect(planIds).toBeTruthy();
  });
});

/** A same-org quote + finance application, used for finance-company lineage. */
async function insertApplication(w: World, vehicleId: Id<"vehicles">) {
  return await w.t.run(async (ctx) => {
    const quoteId = await ctx.db.insert("quotes", {
      orgId: w.orgId,
      customerId: w.customerId,
      vehicleId,
      vehiclePrice: 15_000,
      downPayment: 2000,
      termMonths: 36,
      status: "ACCEPTED",
      createdBy: w.userId,
      createdAt: Date.now(),
    });
    return await ctx.db.insert("financeApplications", {
      orgId: w.orgId,
      quoteId,
      customerId: w.customerId,
      vehicleId,
      salespersonId: w.userId,
      status: "APPROVED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function insertCheque(
  w: World,
  over: {
    receivableId?: Id<"receivables">;
    saleId?: Id<"sales">;
    status?: "HELD" | "DEPOSITED" | "RETURNED";
    fcApplicationId?: Id<"financeApplications">;
    number?: string;
  } = {}
) {
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("postDatedCheques", {
      orgId: w.orgId,
      customerId: w.customerId,
      receivableId: over.receivableId,
      saleId: over.saleId,
      ...(over.fcApplicationId
        ? {
            applicationId: over.fcApplicationId,
            originApplicationId: over.fcApplicationId,
            drawerType: "FINANCE_COMPANY" as const,
          }
        : {}),
      bank: "Test Bank",
      chequeNumber: over.number ?? `CHQ${crypto.randomUUID().slice(0, 8)}`,
      chequeDate: DUE(),
      amount: 100,
      status: over.status ?? "HELD",
      createdBy: w.userId,
      createdAt: now,
      updatedAt: now,
    })
  );
}

describe("SCRUM-571 s1 R1 — recordPayment refuses a sale-linked target or caller saleId", () => {
  const pay = (w: World, over: Record<string, unknown>) => ({
    idempotencyKey: crypto.randomUUID(),
    orgId: w.orgId,
    amount: 100,
    method: "CASH" as const,
    paymentDate: Date.now(),
    ...over,
  });

  test("a receipt against a sale-linked legacy receivable is refused and writes nothing", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.recordPayment, pay(w, { receivableId })))).toBe(
      "SALE_DEBT_RECEIPT_REFUSED"
    );
    expect(await counts(w.t)).toEqual(before);
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(400);
  });

  test("a caller-supplied saleId is refused on an ad-hoc receipt", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const before = await counts(w.t);
    expect(
      await codeOf(w.asFinance.mutation(api.collections.recordPayment, pay(w, { customerId: w.customerId, saleId })))
    ).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("a caller-supplied saleId is refused against an unrelated same-customer receivable", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w);
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.recordPayment, pay(w, { receivableId, saleId })))).toBe(
      "SALE_DEBT_RECEIPT_REFUSED"
    );
    expect(await counts(w.t)).toEqual(before);
  });

  test("a replay of a receipt completed before the guard is refused too", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const args = pay(w, { receivableId });
    await w.t.run((ctx) =>
      ctx.db.insert("commandIdempotency", {
        orgId: w.orgId,
        operation: "collections.recordPayment",
        idempotencyKey: args.idempotencyKey,
        status: "COMPLETED",
        fingerprint: JSON.stringify({
          receivableId,
          customerId: null,
          vehicleId: null,
          saleId: null,
          amount: args.amount,
          method: args.method,
          paymentDate: args.paymentDate,
          reference: null,
        }),
        result: "stored-result-of-the-old-call",
        createdBy: w.userId,
        createdAt: Date.now(),
        completedAt: Date.now(),
      })
    );
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.recordPayment, args))).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: a non-sale receivable and an ad-hoc customer receipt still record", async () => {
    const w = await seedWorld();
    const receivableId = await insertLegacyReceivable(w);
    const paid = await w.asFinance.mutation(api.collections.recordPayment, pay(w, { receivableId, amount: 100 }));
    const adHoc = await w.asFinance.mutation(api.collections.recordPayment, pay(w, { customerId: w.customerId, amount: 50 }));
    expect(paid).toBeTruthy();
    expect(adHoc).toBeTruthy();
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(300);
  });
});

describe("SCRUM-571 s1 R2 — applyRetainedCredit refuses a sale-linked receivable", () => {
  async function retainedWorld() {
    const w = await seedWorld();
    // An ad-hoc receipt with no debt is wholly retained customer credit.
    await w.asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId: w.orgId,
      customerId: w.customerId,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const movement = await w.t.run((ctx) => ctx.db.query("receiptMovements").first());
    return { w, receiptMovementId: movement!._id };
  }

  test("refused and writes nothing", async () => {
    const { w, receiptMovementId } = await retainedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const before = await counts(w.t);
    expect(
      await codeOf(
        w.asFinance.mutation(api.collections.applyRetainedCredit, {
          idempotencyKey: crypto.randomUUID(),
          orgId: w.orgId,
          receiptMovementId,
          receivableId,
          requestedAmount: 100,
        })
      )
    ).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(400);
  });

  // Control: the happy path of applyRetainedCredit needs a fully posted receipt
  // (chart, open period, drained outbox). It is exercised by
  // accountingReceiptMovement.test.ts and idempotencyEconomicCommands.test.ts,
  // which stay green in the regression run for this slice; the guard sits before
  // the movement lookup, so a non-sale receivable reaches exactly the old path.
  test("a receivable that is not sale-linked is not refused by the containment guard", async () => {
    const { w, receiptMovementId } = await retainedWorld();
    const receivableId = await insertLegacyReceivable(w);
    // Reaches the pre-existing "not posted to the ledger yet" refusal, i.e. it
    // got past the guard to the same place it always did.
    const code = await codeOf(
      w.asFinance.mutation(api.collections.applyRetainedCredit, {
        idempotencyKey: crypto.randomUUID(),
        orgId: w.orgId,
        receiptMovementId,
        receivableId,
        requestedAmount: 100,
      })
    );
    expect(code).not.toBe("SALE_DEBT_RECEIPT_REFUSED");
  });
});

describe("SCRUM-571 s1 R3 — cheque registration and clearing refuse sale lineage", () => {
  const chequeArgs = (w: World, over: Record<string, unknown>) => ({
    orgId: w.orgId,
    customerId: w.customerId,
    bank: "Test Bank",
    chequeNumber: `CHQ${crypto.randomUUID().slice(0, 8)}`,
    chequeDate: DUE(),
    amount: 100,
    ...over,
  });

  test("registerCheque against a sale-linked receivable is refused and writes nothing", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.registerCheque, chequeArgs(w, { receivableId })))).toBe(
      "SALE_DEBT_RECEIPT_REFUSED"
    );
    expect(await counts(w.t)).toEqual(before);
  });

  test("registerCheque with a caller saleId is refused (ad-hoc and against an unrelated receivable)", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w);
    const before = await counts(w.t);
    expect(await codeOf(w.asFinance.mutation(api.collections.registerCheque, chequeArgs(w, { saleId })))).toBe(
      "SALE_DEBT_RECEIPT_REFUSED"
    );
    expect(
      await codeOf(w.asFinance.mutation(api.collections.registerCheque, chequeArgs(w, { receivableId, saleId })))
    ).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: a customer cheque with no sale lineage still registers", async () => {
    const w = await seedWorld();
    const receivableId = await insertLegacyReceivable(w);
    const chequeId = await w.asFinance.mutation(api.collections.registerCheque, chequeArgs(w, { receivableId }));
    expect(chequeId).toBeTruthy();
  });

  test("control: the finance-company registration path (no saleId) still registers", async () => {
    const w = await seedWorld();
    const { vehicleId } = await insertSale(w);
    const applicationId = await insertApplication(w, vehicleId);
    const { registerChequeCore } = await import("./collections");
    const chequeId = await w.t.run((ctx) =>
      registerChequeCore(ctx, {
        orgId: w.orgId,
        customerId: w.customerId,
        applicationId,
        bank: "FC Bank",
        chequeNumber: "FC-0001",
        chequeDate: DUE(),
        amount: 1000,
        actorId: w.userId,
        amountMinor: 1_000_000,
        currency: "JOD",
        drawerType: "FINANCE_COMPANY",
        originApplicationId: applicationId,
      })
    );
    const row = await w.t.run((ctx) => ctx.db.get(chequeId));
    expect(row?.drawerType).toBe("FINANCE_COMPANY");
    expect(row?.saleId).toBeUndefined();
  });

  test("clearCheque of a sale-linked customer cheque is refused and writes nothing (cheque saleId)", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const chequeId = await insertCheque(w, { saleId });
    const before = await counts(w.t);
    expect(
      await codeOf(
        w.asFinance.mutation(api.collections.clearCheque, {
          idempotencyKey: crypto.randomUUID(),
          orgId: w.orgId,
          chequeId,
        })
      )
    ).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
    expect((await w.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("HELD");
  });

  test("clearCheque is refused when only the cheque's receivable carries the sale, and on replay", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const chequeId = await insertCheque(w, { receivableId });
    const idempotencyKey = crypto.randomUUID();
    await w.t.run((ctx) =>
      ctx.db.insert("commandIdempotency", {
        orgId: w.orgId,
        operation: "collections.clearCheque",
        idempotencyKey,
        status: "COMPLETED",
        fingerprint: JSON.stringify({ chequeId, clearedAt: null }),
        result: "stored-result-of-the-old-call",
        createdBy: w.userId,
        createdAt: Date.now(),
        completedAt: Date.now(),
      })
    );
    const before = await counts(w.t);
    expect(
      await codeOf(w.asFinance.mutation(api.collections.clearCheque, { idempotencyKey, orgId: w.orgId, chequeId }))
    ).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: clearing a non-sale customer cheque still posts its receipt", async () => {
    const w = await seedWorld();
    const receivableId = await insertLegacyReceivable(w);
    const chequeId = await insertCheque(w, { receivableId });
    await w.asFinance.mutation(api.collections.clearCheque, {
      idempotencyKey: crypto.randomUUID(),
      orgId: w.orgId,
      chequeId,
    });
    expect((await w.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("CLEARED");
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(300);
  });
});

describe("SCRUM-571 s1 R4 — replace and deposit refuse a sale-linked customer cheque", () => {
  const replaceArgs = (w: World, chequeId: Id<"postDatedCheques">) => ({
    orgId: w.orgId,
    chequeId,
    bank: "New Bank",
    chequeNumber: `NEW${crypto.randomUUID().slice(0, 8)}`,
    chequeDate: DUE(),
    amount: 100,
  });

  test("depositCheque is refused (cheque saleId and receivable-only lineage) and writes nothing", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const byCheque = await insertCheque(w, { saleId });
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const byReceivable = await insertCheque(w, { receivableId });
    const before = await counts(w.t);
    for (const chequeId of [byCheque, byReceivable]) {
      expect(await codeOf(w.asFinance.mutation(api.collections.depositCheque, { orgId: w.orgId, chequeId }))).toBe(
        "SALE_DEBT_RECEIPT_REFUSED"
      );
      expect((await w.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("HELD");
    }
    expect(await counts(w.t)).toEqual(before);
  });

  test("replaceCheque is refused (cheque saleId and receivable-only lineage) and writes nothing", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const byCheque = await insertCheque(w, { saleId });
    const receivableId = await insertLegacyReceivable(w, { saleId });
    const byReceivable = await insertCheque(w, { receivableId, status: "RETURNED" });
    const before = await counts(w.t);
    for (const chequeId of [byCheque, byReceivable]) {
      expect(await codeOf(w.asFinance.mutation(api.collections.replaceCheque, replaceArgs(w, chequeId)))).toBe(
        "SALE_DEBT_RECEIPT_REFUSED"
      );
      expect((await w.t.run((ctx) => ctx.db.get(chequeId)))?.status).not.toBe("REPLACED");
    }
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: a non-sale customer cheque still deposits and replaces", async () => {
    const w = await seedWorld();
    const receivableId = await insertLegacyReceivable(w);
    const a = await insertCheque(w, { receivableId });
    const b = await insertCheque(w, { receivableId });
    await w.asFinance.mutation(api.collections.depositCheque, { orgId: w.orgId, chequeId: a });
    expect((await w.t.run((ctx) => ctx.db.get(a)))?.status).toBe("DEPOSITED");
    const replacement = await w.asFinance.mutation(api.collections.replaceCheque, replaceArgs(w, b));
    expect(replacement).toBeTruthy();
    expect((await w.t.run((ctx) => ctx.db.get(b)))?.status).toBe("REPLACED");
  });

  test("control: a finance-company cheque carrying a saleId is NOT refused (FC lineage is separate)", async () => {
    const w = await seedWorld();
    const { saleId, vehicleId } = await insertSale(w);
    const applicationId = await insertApplication(w, vehicleId);
    const chequeId = await insertCheque(w, { saleId, fcApplicationId: applicationId });
    await w.asFinance.mutation(api.collections.depositCheque, { orgId: w.orgId, chequeId });
    expect((await w.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("DEPOSITED");
  });

  test("audit: returning a sale-linked cheque stays allowed (it records bad news, writes no money)", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w);
    const chequeId = await insertCheque(w, { saleId });
    await w.asFinance.mutation(api.collections.returnCheque, { orgId: w.orgId, chequeId });
    expect((await w.t.run((ctx) => ctx.db.get(chequeId)))?.status).toBe("RETURNED");
  });
});

describe("T1/T2 — a sale with ANY legacy receivable cannot complete or cancel", () => {
  const STATUSES = ["OPEN", "PAID", "REFUNDED", "CANCELLED"] as const;

  for (const status of STATUSES) {
    test(`T1 completeDraft refuses a ${status} legacy receivable; the draft stays PENDING and nothing is written`, async () => {
      const w = await seedWorld();
      const { saleId } = await insertSale(w, "PENDING");
      await insertLegacyReceivable(w, { saleId, status });
      const before = await counts(w.t);

      const code = await codeOf(
        w.asFinance.mutation(api.sales.completeDraft, {
          orgId: w.orgId,
          saleId,
          idempotencyKey: crypto.randomUUID(),
        })
      );

      expect(code).toBe("SALE_HAS_LEGACY_RECEIVABLE");
      expect(await counts(w.t)).toEqual(before);
      expect((await w.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("PENDING");
    });
  }

  test("T1 a legacy receivable of ANOTHER sale does not block this one (control)", async () => {
    const w = await seedWorld();
    const mine = await insertSale(w, "PENDING");
    const other = await insertSale(w, "PENDING");
    await insertLegacyReceivable(w, { saleId: other.saleId });

    const code = await codeOf(
      w.asFinance.mutation(api.sales.completeDraft, {
        orgId: w.orgId,
        saleId: mine.saleId,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(code).not.toBe("SALE_HAS_LEGACY_RECEIVABLE");
  });

  test("T1 a sale with no legacy receivable gets past the guard (control)", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w, "PENDING");
    const code = await codeOf(
      w.asFinance.mutation(api.sales.completeDraft, {
        orgId: w.orgId,
        saleId,
        idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(code).not.toBe("SALE_HAS_LEGACY_RECEIVABLE");
  });

  for (const status of STATUSES) {
    test(`T2 cancelling a COMPLETED sale refuses a ${status} legacy receivable before any write`, async () => {
      const w = await seedWorld();
      const { saleId, vehicleId } = await insertSale(w, "COMPLETED");
      await insertLegacyReceivable(w, { saleId, status });
      const before = await counts(w.t);
      const sale = (await w.t.run((ctx) => ctx.db.get(saleId)))!;

      const code = await codeOf(
        w.t.run((ctx) =>
          cancelCompletedSaleOperationalRecords(ctx, {
            orgId: w.orgId,
            sale,
            actorId: w.userId,
            reason: "t2",
            reversalDate: Date.now(),
          })
        )
      );

      expect(code).toBe("SALE_HAS_LEGACY_RECEIVABLE");
      expect(await counts(w.t)).toEqual(before);
      expect((await w.t.run((ctx) => ctx.db.get(vehicleId)))?.status).toBe("SOLD");
    });
  }

  test("T2 a completed sale with no legacy receivable still cancels its operational records (control)", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w, "COMPLETED");
    const sale = (await w.t.run((ctx) => ctx.db.get(saleId)))!;
    const code = await codeOf(
      w.t.run((ctx) =>
        cancelCompletedSaleOperationalRecords(ctx, {
          orgId: w.orgId,
          sale,
          actorId: w.userId,
          reason: "t2 control",
          reversalDate: Date.now(),
        })
      )
    );
    expect(code).toBeUndefined();
  });

  test("T1/T2 a same-id legacy row in ANOTHER org is not this org's debt", async () => {
    const w = await seedWorld();
    const { saleId } = await insertSale(w, "PENDING");
    const otherOrg = await w.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() })
    );
    await insertLegacyReceivable(w, { saleId, orgId: otherOrg });
    const present = await w.t.run((ctx) => saleHasLegacyReceivable(ctx, w.orgId, saleId));
    expect(present).toBe(false);
  });
});

describe("R5 — a refund that would re-allocate a remainder to a sale-linked legacy doc is refused up front", () => {
  async function paidReceivable(w: World, saleLinked: boolean) {
    const receivableId = await w.asFinance.mutation(api.collections.createReceivable, {
      idempotencyKey: crypto.randomUUID(),
      orgId: w.orgId,
      customerId: w.customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "R5 debt",
      amount: 500,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await w.asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId: w.orgId,
      receivableId,
      amount: 500,
      method: "CASH",
      paymentDate: Date.now(),
    });
    if (saleLinked) {
      // A pre-release row: the writer is closed, so link it directly.
      const { saleId } = await insertSale(w, "PENDING");
      await w.t.run((ctx) => ctx.db.patch(receivableId, { saleId }));
    }
    return receivableId;
  }

  async function request(w: World, receivableId: Id<"receivables">, amount: number) {
    return await w.asFinance.mutation(api.collections.requestApproval, {
      orgId: w.orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: amount,
      disbursementMethod: "CASH",
      reason: "R5 refund",
    });
  }

  test("partial refund on a sale-linked legacy doc is refused before any write", async () => {
    const w = await seedWorld();
    const receivableId = await paidReceivable(w, true);
    const requestId = await request(w, receivableId, 200);
    const before = await counts(w.t);
    const allocationsBefore = await w.t.run((ctx) => ctx.db.query("paymentAllocations").take(1000));

    const code = await codeOf(
      w.asApprover.mutation(api.collections.respondToApproval, {
        idempotencyKey: crypto.randomUUID(),
        orgId: w.orgId,
        requestId,
        status: "APPROVED",
      })
    );

    expect(code).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
    expect(await w.t.run((ctx) => ctx.db.query("paymentAllocations").take(1000))).toEqual(allocationsBefore);
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(0);
  });

  test("control: the same partial refund on a NON-sale legacy doc still works", async () => {
    const w = await seedWorld();
    const receivableId = await paidReceivable(w, false);
    const requestId = await request(w, receivableId, 200);
    await w.asApprover.mutation(api.collections.respondToApproval, {
      idempotencyKey: crypto.randomUUID(),
      orgId: w.orgId,
      requestId,
      status: "APPROVED",
    });
    expect((await w.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(200);
  });
});

describe("S1 — internal subledger.createReceivable / subledger.allocate refuse sale debt", () => {
  async function withAccounting(w: World) {
    await w.t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId: w.orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  const docArgs = (w: World, sourceType: string, sourceId: string) => ({
    orgId: w.orgId,
    documentType: "INVOICE" as const,
    payerType: "CUSTOMER" as const,
    customerId: w.customerId,
    sourceType,
    sourceId,
    originalAmountMinor: 100_000,
    currency: "JOD",
    issueDate: Date.now(),
    dueDate: Date.now() + 86_400_000,
  });

  async function insertDoc(w: World, sourceType: string, sourceId: string) {
    return await w.t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: w.orgId,
        documentNumber: `S1-${crypto.randomUUID().slice(0, 8)}`,
        documentType: "INVOICE",
        payerType: "CUSTOMER",
        customerId: w.customerId,
        sourceType,
        sourceId,
        originalAmountMinor: 100_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now() + 86_400_000,
        status: "OPEN",
        createdBy: w.userId,
        createdAt: Date.now(),
      })
    );
  }

  async function insertPayment(w: World) {
    return await w.t.run((ctx) =>
      ctx.db.insert("canonicalPayments", {
        orgId: w.orgId,
        direction: "IN",
        payerType: "CUSTOMER",
        customerId: w.customerId,
        method: "CASH",
        amountMinor: 50_000,
        currency: "JOD",
        scale: 3,
        status: "SETTLED",
        idempotencyKey: `s1-${crypto.randomUUID()}`,
        createdBy: w.userId,
        createdAt: Date.now(),
      })
    );
  }

  test("createReceivable with a `sales` source is refused and writes nothing", async () => {
    const w = await seedWorld();
    await withAccounting(w);
    const { saleId } = await insertSale(w, "PENDING");
    const before = await counts(w.t);
    const code = await codeOf(
      w.asFinance.mutation(internal.subledger.createReceivable, docArgs(w, "sales", saleId))
    );
    expect(code).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("createReceivable mirroring a sale-linked legacy receivable is refused", async () => {
    const w = await seedWorld();
    await withAccounting(w);
    const { saleId } = await insertSale(w, "PENDING");
    const legacy = await insertLegacyReceivable(w, { saleId });
    const before = await counts(w.t);
    const code = await codeOf(
      w.asFinance.mutation(internal.subledger.createReceivable, docArgs(w, "legacy_receivable", legacy))
    );
    expect(code).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: createReceivable for an unrelated source and for a non-sale legacy receivable works", async () => {
    const w = await seedWorld();
    await withAccounting(w);
    const plain = await insertLegacyReceivable(w, {});
    await expect(
      w.asFinance.mutation(internal.subledger.createReceivable, docArgs(w, "manual_adjustment", "m1"))
    ).resolves.toBeTruthy();
    await expect(
      w.asFinance.mutation(internal.subledger.createReceivable, docArgs(w, "legacy_receivable", plain))
    ).resolves.toBeTruthy();
  });

  test("allocate to a sale invoice document is refused and writes nothing", async () => {
    const w = await seedWorld();
    await withAccounting(w);
    const { saleId } = await insertSale(w, "COMPLETED");
    const docId = await insertDoc(w, "sales", saleId);
    const paymentId = await insertPayment(w);
    const before = await counts(w.t);
    const code = await codeOf(
      w.asFinance.mutation(internal.subledger.allocate, {
        orgId: w.orgId,
        paymentId,
        receivableDocumentId: docId,
        amountMinor: 10_000,
      })
    );
    expect(code).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("allocate to the canonical mirror of a sale-linked legacy receivable is refused", async () => {
    const w = await seedWorld();
    await withAccounting(w);
    const { saleId } = await insertSale(w, "PENDING");
    const legacy = await insertLegacyReceivable(w, { saleId });
    const docId = await insertDoc(w, "legacy_receivable", legacy);
    const paymentId = await insertPayment(w);
    const before = await counts(w.t);
    const code = await codeOf(
      w.asFinance.mutation(internal.subledger.allocate, {
        orgId: w.orgId,
        paymentId,
        receivableDocumentId: docId,
        amountMinor: 10_000,
      })
    );
    expect(code).toBe("SALE_DEBT_RECEIPT_REFUSED");
    expect(await counts(w.t)).toEqual(before);
  });

  test("control: allocate to an unrelated doc and to a non-sale legacy mirror works", async () => {
    const w = await seedWorld();
    await withAccounting(w);
    const plain = await insertLegacyReceivable(w, {});
    const manual = await insertDoc(w, "manual_adjustment", "m2");
    const mirror = await insertDoc(w, "legacy_receivable", plain);
    const p1 = await insertPayment(w);
    const p2 = await insertPayment(w);
    await expect(
      w.asFinance.mutation(internal.subledger.allocate, {
        orgId: w.orgId, paymentId: p1, receivableDocumentId: manual, amountMinor: 10_000,
      })
    ).resolves.toBeTruthy();
    await expect(
      w.asFinance.mutation(internal.subledger.allocate, {
        orgId: w.orgId, paymentId: p2, receivableDocumentId: mirror, amountMinor: 10_000,
      })
    ).resolves.toBeTruthy();
  });
});

/** A PENDING payment link inserted directly: `create` is shut, so it cannot be made through the door. */
async function seedLink(w: World, over: Record<string, unknown> = {}) {
  const now = Date.now();
  return (await w.t.run((ctx) =>
    ctx.db.insert("paymentIntents", {
      orgId: w.orgId,
      customerId: w.customerId,
      createdBy: w.userId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_p3_ref",
      status: "PENDING",
      idempotencyKey: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...over,
    } as never)
  )) as Id<"paymentIntents">;
}

const settleCapture = (w: World, over: Record<string, unknown> = {}) =>
  w.t.mutation(internal.paymentIntents.settleByExternalId, {
    provider: "tap",
    externalId: "tap_p3_ref",
    amountMinor: 100_000,
    currency: "JOD",
    providerSignatureVerifiedAt: Date.now(),
    providerEventId: "evt_p3_1",
    ...over,
  } as never);

describe("P1/P2 — payment links are shut at the server boundary (create, markSettled)", () => {
  test("P1: paymentIntents.create is refused before any write or idempotency record", async () => {
    const w = await seedWorld();
    const before = await counts(w.t);
    const key = crypto.randomUUID();
    expect(
      await codeOf(
        w.asFinance.mutation(api.paymentIntents.create, {
          idempotencyKey: key,
          orgId: w.orgId,
          customerId: w.customerId,
          amountMinor: 100_000,
          currency: "JOD",
          provider: "tap",
          externalId: "tap_p1",
        } as never)
      )
    ).toBe("PAYMENT_LINKS_DISABLED");
    expect(await counts(w.t)).toEqual(before);
    const intents = await w.t.run((ctx) => ctx.db.query("paymentIntents").take(10));
    expect(intents).toHaveLength(0);
  });

  test("P2: paymentIntents.markSettled is refused, the link stays PENDING, nothing is written or recorded", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w);
    const before = await counts(w.t);
    expect(
      await codeOf(
        w.asFinance.mutation(api.paymentIntents.markSettled, {
          idempotencyKey: crypto.randomUUID(),
          orgId: w.orgId,
          intentId,
        } as never)
      )
    ).toBe("PAYMENT_LINKS_DISABLED");
    expect(await counts(w.t)).toEqual(before);
    expect((await w.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("PENDING");
  });
});

describe("P3 — a verified provider capture is held atomically, never settled", () => {
  test("a PENDING link's capture is HELD with PAYMENT_LINKS_DISABLED and writes nothing economic", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w);
    const before = await counts(w.t);

    const result = await settleCapture(w);
    expect(result).toMatchObject({ kind: "HELD" });

    const after = await counts(w.t);
    // Only the held-funds row is new: no allocation, payment, receipt or posting.
    expect(after).toEqual({ ...before, unmatchedProviderFunds: before.unmatchedProviderFunds + 1 });
    const rows = await w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(10));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: w.orgId,
      intentId,
      provider: "tap",
      externalId: "tap_p3_ref",
      reason: "PAYMENT_LINKS_DISABLED",
      intentStatusAtReceipt: "PENDING",
      amountMinor: 100_000,
      currency: "JOD",
      reviewStatus: "OPEN",
      deliveryCount: 1,
    });
    // The verified capture is preserved and the link is untouched (not FAILED).
    expect((await w.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("PENDING");
  });

  test("redelivery is idempotent: one row, deliveryCount bumped, still nothing economic", async () => {
    const w = await seedWorld();
    await seedLink(w);
    await settleCapture(w);
    const afterFirst = await counts(w.t);

    const again = await settleCapture(w, { providerEventId: "evt_p3_2" });
    expect(again).toMatchObject({ kind: "HELD" });
    expect(await counts(w.t)).toEqual(afterFirst);
    const rows = await w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(10));
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(2);
  });

  test("a mismatched amount is held the same way and does not flip the link to FAILED", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w);
    expect(await settleCapture(w, { amountMinor: 99_000 })).toMatchObject({ kind: "HELD" });
    const [row] = await w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(10));
    expect(row.reason).toBe("PAYMENT_LINKS_DISABLED");
    expect((await w.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("PENDING");
  });

  test("an already-SETTLED link still acknowledges idempotently with no new row", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w, { status: "SETTLED" });
    const before = await counts(w.t);
    expect(await settleCapture(w)).toEqual({ kind: "ALREADY_SETTLED", intentId });
    expect(await counts(w.t)).toEqual(before);
  });
});

describe("P4 — expire still works and never touches a captured link's held funds", () => {
  test("expiring a PENDING link works while the pilot is shut", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w);
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId });
    expect((await w.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("EXPIRED");
  });

  test("expiring a link whose capture is held leaves the held row untouched", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w);
    await settleCapture(w);
    const [heldBefore] = await w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(10));
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId });
    const rows = await w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(10));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(heldBefore);
  });

  test("expire refuses a SETTLED link (a captured link is never expired)", async () => {
    const w = await seedWorld();
    const intentId = await seedLink(w, { status: "SETTLED" });
    expect(
      await codeOf(w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId }))
    ).toBe("PAYMENT_LINK_NOT_PENDING");
    expect((await w.t.run((ctx) => ctx.db.get(intentId)))?.status).toBe("SETTLED");
  });
});

// ── END ──
