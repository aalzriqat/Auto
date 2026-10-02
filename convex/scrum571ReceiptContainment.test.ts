/**
 * SCRUM-571 S1 — receipt containment (finding c21732).
 *
 * Invariant: no receipt posting may credit customer AR by more than it actually
 * allocates to a canonical receivable document. Payment-intent settlement posts
 * the GROSS intent amount while the allocation clamps to what is outstanding,
 * so S1 closes the reachable doors that let an intent (or a manual receipt)
 * carry more than the debt can absorb, or no debt at all:
 *
 *   1. `paymentIntents.create` refuses an intent with no target.
 *   2. `paymentIntents.create` caps the amount at the canonical document's
 *      outstanding, however the document was resolved.
 *   3. `collections.recordPayment` refuses `PAYMENT_LINK`; that money arrives
 *      only through intent settlement.
 *
 * The posting split itself is a later slice and is deliberately NOT touched.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { AppErrorCode } from "./utils/errors";

const DUE = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

const TRACKED = [
  "paymentIntents",
  "collectionPayments",
  "canonicalPayments",
  "paymentAllocations",
  "transactions",
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
  "commandIdempotency",
] as const;

async function counts(t: ReturnType<typeof convexTestWithComponents>) {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of TRACKED) out[table] = (await ctx.db.query(table).take(10_000)).length;
    return out;
  });
}

async function seed(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "S1 Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "s571_user", email: "u@example.com", name: "Finance User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Manager",
      permissions: ["view:finance", "manage:finance", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  const asFinance = t.withIdentity({ subject: "s571_user", clerkId: "s571_user" });
  // 1000 JOD, scale 3 -> 1_000_000 minor units outstanding.
  const receivableId = await asFinance.mutation(api.collections.createReceivable, {
    idempotencyKey: crypto.randomUUID(),
    orgId,
    customerId,
    sourceType: "INTERNAL_INSTALLMENT",
    title: "Debt",
    amount: 1000,
    dueDate: DUE(),
    creditSystemKey: "MISCELLANEOUS_INCOME",
  });
  const receivableDocumentId = await t.run(async (ctx) => {
    const row = await ctx.db.get(receivableId);
    return row!.canonicalReceivableDocumentId!;
  });
  return { orgId, userId, customerId, asFinance, receivableId, receivableDocumentId };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? `plain:${String(error)}`;
  }
  return undefined;
}

describe("SCRUM-571 S1 — paymentIntents.create refuses an untargeted intent", () => {
  test("no receivableId, saleId or receivableDocumentId is refused and writes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seed(t);
    const before = await counts(t);

    const code = await codeOf(
      asFinance.mutation(api.paymentIntents.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        amountMinor: 100_000,
        currency: "JOD",
        provider: "tap",
      })
    );
    expect(code).toBe("PAYMENT_LINK_TARGET_REQUIRED");
    expect(await counts(t)).toEqual(before);
  });

  test("a refused untargeted attempt does not consume its idempotency key", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const idempotencyKey = crypto.randomUUID();
    const base = { idempotencyKey, orgId, customerId, amountMinor: 100_000, currency: "JOD", provider: "tap" };

    expect(await codeOf(asFinance.mutation(api.paymentIntents.create, base))).toBe(
      "PAYMENT_LINK_TARGET_REQUIRED"
    );
    const intentId = await asFinance.mutation(api.paymentIntents.create, { ...base, receivableDocumentId });
    expect(intentId).toBeTruthy();
  });
});

describe("SCRUM-571 S1 — paymentIntents.create caps at the document's outstanding", () => {
  test("document target over outstanding is refused and writes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const before = await counts(t);

    const code = await codeOf(
      asFinance.mutation(api.paymentIntents.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        receivableDocumentId,
        amountMinor: 1_000_001,
        currency: "JOD",
        provider: "tap",
      })
    );
    expect(code).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
    expect(await counts(t)).toEqual(before);
  });

  test("document target exactly at outstanding is accepted", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      receivableDocumentId,
      amountMinor: 1_000_000,
      currency: "JOD",
      provider: "tap",
    });
    const intent = await t.run((ctx) => ctx.db.get(intentId));
    expect(intent?.amountMinor).toBe(1_000_000);
    expect(intent?.receivableDocumentId).toBe(receivableDocumentId);
  });

  test("sale target over outstanding is refused; at outstanding is accepted", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const saleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Kia", model: "Rio", year: 2021, mileage: 30_000,
        color: "Blue", fuelType: "PETROL", transmission: "AUTOMATIC",
        sellingPrice: 15_000, status: "AVAILABLE",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15_000, saleDate: Date.now(), status: "PENDING",
        canonicalReceivableDocumentId: receivableDocumentId,
      });
    });
    const before = await counts(t);
    const base = { orgId, customerId, saleId, currency: "JOD", provider: "tap" };

    expect(
      await codeOf(
        asFinance.mutation(api.paymentIntents.create, {
          ...base, idempotencyKey: crypto.randomUUID(), amountMinor: 1_000_001,
        })
      )
    ).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
    expect(await counts(t)).toEqual(before);

    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      ...base, idempotencyKey: crypto.randomUUID(), amountMinor: 1_000_000,
    });
    expect(intentId).toBeTruthy();
  });

  test("the legacy receivableId path is still capped, with its original message", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableId } = await seed(t);
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        receivableId,
        amountMinor: 1_000_001,
        currency: "JOD",
        provider: "tap",
      })
    ).rejects.toThrow("Payment link amount cannot exceed the receivable outstanding amount.");
  });

  test("the stricter of the legacy and document caps applies", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableId } = await seed(t);
    // Legacy mirror drifts ABOVE the document (2000 vs 1000): only the
    // document cap can refuse 1_500_000.
    await t.run((ctx) => ctx.db.patch(receivableId, { outstandingAmount: 2000 }));
    expect(
      await codeOf(
        asFinance.mutation(api.paymentIntents.create, {
          idempotencyKey: crypto.randomUUID(),
          orgId,
          customerId,
          receivableId,
          amountMinor: 1_500_000,
          currency: "JOD",
          provider: "tap",
        })
      )
    ).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
  });

  test("a partly allocated document caps at what is still owed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableId, receivableDocumentId } = await seed(t);
    await asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      receivableId,
      amount: 400,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const base = { orgId, customerId, receivableDocumentId, currency: "JOD", provider: "tap" };
    expect(
      await codeOf(
        asFinance.mutation(api.paymentIntents.create, {
          ...base, idempotencyKey: crypto.randomUUID(), amountMinor: 600_001,
        })
      )
    ).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      ...base, idempotencyKey: crypto.randomUUID(), amountMinor: 600_000,
    });
    expect(intentId).toBeTruthy();
  });

  test("a document that is not open for payment is refused (control)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(receivableDocumentId, { status: "PAID" }));
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        receivableDocumentId,
        amountMinor: 1,
        currency: "JOD",
        provider: "tap",
      })
    ).rejects.toThrow("This debt can no longer accept payments.");
  });
});

describe("SCRUM-571 S1 — collections.recordPayment refuses PAYMENT_LINK", () => {
  test("refused with the structured code and writes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableId } = await seed(t);
    const before = await counts(t);

    expect(
      await codeOf(
        asFinance.mutation(api.collections.recordPayment, {
          idempotencyKey: crypto.randomUUID(),
          orgId,
          receivableId,
          amount: 300,
          method: "PAYMENT_LINK",
          paymentDate: Date.now(),
        })
      )
    ).toBe("PAYMENT_LINK_RECEIPT_MANUAL_REFUSED");
    expect(
      await codeOf(
        asFinance.mutation(api.collections.recordPayment, {
          idempotencyKey: crypto.randomUUID(),
          orgId,
          customerId,
          amount: 5,
          method: "PAYMENT_LINK",
          paymentDate: Date.now(),
        })
      )
    ).toBe("PAYMENT_LINK_RECEIPT_MANUAL_REFUSED");

    expect(await counts(t)).toEqual(before);
    const receivable = await t.run((ctx) => ctx.db.get(receivableId));
    expect(receivable?.outstandingAmount).toBe(1000);
  });

  test("a replay of a PAYMENT_LINK command completed before the guard is refused too", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seed(t);
    const idempotencyKey = crypto.randomUUID();
    const paymentDate = Date.now();
    // What the pre-guard mutation left behind after a successful call: a
    // COMPLETED command whose stored result is handed back without running the
    // body, so a guard placed inside the body would be bypassed.
    await t.run((ctx) =>
      ctx.db.insert("commandIdempotency", {
        orgId,
        operation: "collections.recordPayment",
        idempotencyKey,
        status: "COMPLETED",
        fingerprint: JSON.stringify({
          receivableId: null,
          customerId,
          vehicleId: null,
          saleId: null,
          amount: 5,
          method: "PAYMENT_LINK",
          paymentDate,
          reference: null,
        }),
        result: "stored-result-of-the-old-call",
        createdBy: userId,
        createdAt: paymentDate,
        completedAt: paymentDate,
      })
    );

    expect(
      await codeOf(
        asFinance.mutation(api.collections.recordPayment, {
          idempotencyKey,
          orgId,
          customerId,
          amount: 5,
          method: "PAYMENT_LINK",
          paymentDate,
        })
      )
    ).toBe("PAYMENT_LINK_RECEIPT_MANUAL_REFUSED");
  });

  test("genuine manual methods still record (control)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seed(t);
    for (const method of ["CASH", "BANK_TRANSFER", "CARD"] as const) {
      const paymentId = await asFinance.mutation(api.collections.recordPayment, {
        idempotencyKey: crypto.randomUUID(),
        orgId,
        customerId,
        amount: 5,
        method,
        paymentDate: Date.now(),
      });
      const payment = await t.run((ctx) => ctx.db.get(paymentId));
      expect(payment?.method, method).toBe(method);
    }
  });
});

describe("SCRUM-571 S1 — pending payment links reserve the document's outstanding", () => {
  const link = (
    orgId: Id<"organizations">,
    customerId: Id<"customers">,
    receivableDocumentId: Id<"receivableDocuments">,
    amountMinor: number
  ) => ({
    idempotencyKey: crypto.randomUUID(),
    orgId,
    customerId,
    receivableDocumentId,
    amountMinor,
    currency: "JOD",
    provider: "tap",
  });

  test("two links each within outstanding but together over it: the second is refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 600_000));
    const before = await counts(t);

    expect(
      await codeOf(asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 600_000)))
    ).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
    expect(await counts(t)).toEqual(before);

    // Exactly the remainder is still accepted.
    const ok = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 400_000));
    expect(ok).toBeTruthy();
  });

  test("expiring the first link frees its amount for the second", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const first = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 600_000));
    expect(
      await codeOf(asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 600_000)))
    ).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");

    await asFinance.mutation(api.paymentIntents.expire, { orgId, intentId: first });
    const second = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 600_000));
    expect(second).toBeTruthy();
  });

  test("a SETTLED or EXPIRED intent does not reserve", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const settled = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 300_000));
    const expired = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 300_000));
    await asFinance.mutation(api.paymentIntents.markSettled, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      intentId: settled,
    });
    await asFinance.mutation(api.paymentIntents.expire, { orgId, intentId: expired });

    // Outstanding is now 700_000 (300_000 allocated); the expired 300_000 and
    // the settled 300_000 must not be reserved a second time.
    expect(
      await codeOf(asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 700_001)))
    ).toBe("PAYMENT_LINK_EXCEEDS_OUTSTANDING");
    const ok = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 700_000));
    expect(ok).toBeTruthy();
  });

  test("a pending intent for a different document of the same customer does not reserve", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const otherDocumentId = await t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId,
        documentType: "INVOICE",
        documentNumber: "OTHER-0001",
        payerType: "CUSTOMER",
        customerId,
        sourceType: "legacy_receivable",
        sourceId: "other-source",
        originalAmountMinor: 900_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: DUE(),
        status: "OPEN",
        createdAt: Date.now(),
        createdBy: userId,
      })
    );
    await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, otherDocumentId, 900_000));

    const ok = await asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 1_000_000));
    expect(ok).toBeTruthy();
  });
});

// The PENDING happy path (expire frees the reservation) is covered above by
// "expiring the first link frees its amount for the second".
describe("SCRUM-571 S1 — paymentIntents.expire refusals are coded", () => {
  test("a non-PENDING intent is refused with PAYMENT_LINK_NOT_PENDING and is not changed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      customerId,
      receivableDocumentId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "tap",
    });
    await asFinance.mutation(api.paymentIntents.expire, { orgId, intentId });

    expect(await codeOf(asFinance.mutation(api.paymentIntents.expire, { orgId, intentId }))).toBe(
      "PAYMENT_LINK_NOT_PENDING"
    );
    const row = await t.run((ctx) => ctx.db.get(intentId));
    expect(row?.status).toBe("EXPIRED");
  });

  test("a foreign-org or missing intent gets the same PAYMENT_LINK_NOT_FOUND refusal", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, asFinance } = await seed(t);
    const foreignIntentId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
      const otherCustomerId = await ctx.db.insert("customers", {
        orgId: otherOrgId,
        firstName: "Omar",
        lastName: "Other",
        phone: "+962790000001",
      });
      return await ctx.db.insert("paymentIntents", {
        orgId: otherOrgId,
        customerId: otherCustomerId,
        amountMinor: 1,
        currency: "JOD",
        provider: "tap",
        status: "PENDING",
        idempotencyKey: "foreign-key",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    const missingIntentId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("paymentIntents", {
        orgId,
        customerId: (await ctx.db.query("customers").first())!._id,
        amountMinor: 1,
        currency: "JOD",
        provider: "tap",
        status: "PENDING",
        idempotencyKey: "gone-key",
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const foreign = await asFinance
      .mutation(api.paymentIntents.expire, { orgId, intentId: foreignIntentId })
      .catch((e: { data?: { code?: string; message?: string } }) => e.data);
    const missing = await asFinance
      .mutation(api.paymentIntents.expire, { orgId, intentId: missingIntentId })
      .catch((e: { data?: { code?: string; message?: string } }) => e.data);

    expect(foreign?.code).toBe("PAYMENT_LINK_NOT_FOUND");
    // One message for both, so a foreign row is indistinguishable from a missing one.
    expect(foreign).toEqual(missing);
    const untouched = await t.run((ctx) => ctx.db.get(foreignIntentId));
    expect(untouched?.status).toBe("PENDING");
  });
});

describe("SCRUM-571 S1 — every new refusal is translated in both locales", () => {
  const codes = [
    "PAYMENT_LINK_TARGET_REQUIRED",
    "PAYMENT_LINK_EXCEEDS_OUTSTANDING",
    "PAYMENT_LINK_RECEIPT_MANUAL_REFUSED",
    "PAYMENT_LINK_NOT_FOUND",
    "PAYMENT_LINK_NOT_PENDING",
  ] as const;

  test.each(codes)("ServerError_%s exists in en and ar", (code) => {
    const en = (commonEn as Record<string, string>)[`ServerError_${code}`];
    const ar = (commonAr as Record<string, string>)[`ServerError_${code}`];
    expect(en).toBeTruthy();
    expect(ar).toBeTruthy();
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(en);
  });

  test.each(codes)("%s is a registered AppErrorCode", (code) => {
    expect(AppErrorCode[code]).toBe(code);
  });
});
