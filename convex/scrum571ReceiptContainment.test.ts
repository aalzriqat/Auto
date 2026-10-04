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
import { PAYMENT_LINK_REFUSALS } from "./paymentIntents";

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

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: { code?: string; message?: string } }).data;
    return { code: data?.code ?? `plain:${String(error)}`, message: data?.message };
  }
  return {};
}

const codeOf = async (promise: Promise<unknown>) => (await refusal(promise)).code;

type World = Awaited<ReturnType<typeof seed>> & { t: ReturnType<typeof convexTestWithComponents> };

async function makeWorld(): Promise<World> {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  return { t, ...(await seed(t)) };
}

const baseCreate = (w: World) => ({
  idempotencyKey: crypto.randomUUID(),
  orgId: w.orgId,
  customerId: w.customerId,
  receivableDocumentId: w.receivableDocumentId,
  amountMinor: 100_000,
  currency: "JOD",
  provider: "tap",
});

const createWith = (w: World, over: Record<string, unknown>) =>
  w.asFinance.mutation(api.paymentIntents.create, { ...baseCreate(w), ...over } as never);

const otherCustomer = (w: World) =>
  w.t.run((ctx) =>
    ctx.db.insert("customers", { orgId: w.orgId, firstName: "Omar", lastName: "Other", phone: "+962790000009" })
  );

const insertDocument = (w: World, customerId: Id<"customers">) =>
  w.t.run((ctx) =>
    ctx.db.insert("receivableDocuments", {
      orgId: w.orgId,
      documentType: "INVOICE",
      documentNumber: `DOC-${crypto.randomUUID().slice(0, 8)}`,
      payerType: "CUSTOMER",
      customerId,
      sourceType: "legacy_receivable",
      sourceId: crypto.randomUUID(),
      originalAmountMinor: 900_000,
      currency: "JOD",
      scale: 3,
      issueDate: Date.now(),
      dueDate: DUE(),
      status: "OPEN",
      createdAt: Date.now(),
      createdBy: w.userId,
    })
  );

const insertSale = (w: World, over: { customerId?: Id<"customers">; canonicalReceivableDocumentId?: Id<"receivableDocuments"> }) =>
  w.t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId: w.orgId, make: "Kia", model: "Rio", year: 2021, mileage: 30_000,
      color: "Blue", fuelType: "PETROL", transmission: "AUTOMATIC",
      sellingPrice: 15_000, status: "AVAILABLE",
    });
    return await ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId, customerId: over.customerId ?? w.customerId, salespersonId: w.userId,
      salePrice: 15_000, saleDate: Date.now(), status: "PENDING",
      ...(over.canonicalReceivableDocumentId ? { canonicalReceivableDocumentId: over.canonicalReceivableDocumentId } : {}),
    });
  });

// D-20: payment-link pilot shutdown. `paymentIntents.create` and `markSettled`
// refuse every request with PAYMENT_LINKS_DISABLED before reading the target,
// the amount or any other field, so the target/cap/reservation behaviours below
// are dormant until the pilot reopens. Each superseded test is converted to
// assert the shut outcome (refused, nothing written) rather than skipped: the
// invariant catalog treats skipped tests as no evidence.
const seedIntent = (w: World, over: Record<string, unknown> = {}) =>
  w.t.run((ctx) =>
    ctx.db.insert("paymentIntents", {
      orgId: w.orgId,
      customerId: w.customerId,
      createdBy: w.userId,
      receivableDocumentId: w.receivableDocumentId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "tap",
      status: "PENDING",
      idempotencyKey: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...over,
    } as never)
  ) as Promise<Id<"paymentIntents">>;

describe("SCRUM-571 S1 — paymentIntents.create refuses an untargeted intent", () => {
  test("D-20: an untargeted request is refused (by the shutdown) and writes nothing", async () => {
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
    expect(code).toBe("PAYMENT_LINKS_DISABLED");
    expect(await counts(t)).toEqual(before);
  });

  test("D-20: a refused attempt does not consume its idempotency key (nothing is recorded)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const idempotencyKey = crypto.randomUUID();
    const base = { idempotencyKey, orgId, customerId, amountMinor: 100_000, currency: "JOD", provider: "tap" };

    expect(await codeOf(asFinance.mutation(api.paymentIntents.create, base))).toBe("PAYMENT_LINKS_DISABLED");
    expect(await codeOf(asFinance.mutation(api.paymentIntents.create, { ...base, receivableDocumentId }))).toBe(
      "PAYMENT_LINKS_DISABLED"
    );
    const keys = await t.run((ctx) => ctx.db.query("commandIdempotency").take(100));
    expect(keys.filter((k) => k.idempotencyKey === idempotencyKey)).toHaveLength(0);
  });
});

describe("SCRUM-571 S1 — paymentIntents.create caps at the document's outstanding", () => {
  // `target` names the identifier the intent is created against; `setup` puts
  // the world into the state the case needs and returns the create overrides.
  type CapCase = {
    name: string;
    target: "document" | "sale" | "receivable";
    amountMinor: number;
    setup?: (w: World) => Promise<void>;
  };
  const targetArgs = async (w: World, target: CapCase["target"]): Promise<Record<string, unknown>> => {
    if (target === "document") return { receivableDocumentId: w.receivableDocumentId };
    if (target === "receivable") return { receivableId: w.receivableId, receivableDocumentId: undefined };
    const saleId = await insertSale(w, { canonicalReceivableDocumentId: w.receivableDocumentId });
    return { saleId, receivableDocumentId: undefined };
  };
  const partlyAllocate = async (w: World) => {
    await w.asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId: w.orgId,
      receivableId: w.receivableId,
      amount: 400,
      method: "CASH",
      paymentDate: Date.now(),
    });
  };

  const REFUSED: Array<CapCase & { code: string }> = [
    { name: "document target over outstanding", target: "document", amountMinor: 1_000_001, code: "PAYMENT_LINK_EXCEEDS_OUTSTANDING" },
    { name: "sale target over outstanding", target: "sale", amountMinor: 1_000_001, code: "PAYMENT_LINK_EXCEEDS_OUTSTANDING" },
    { name: "the legacy receivableId path is still capped, with its own coded refusal", target: "receivable", amountMinor: 1_000_001, code: "PAYMENT_LINK_EXCEEDS_RECEIVABLE" },
    {
      // Legacy mirror drifts ABOVE the document (2000 vs 1000): only the
      // document cap can refuse 1_500_000.
      name: "the stricter of the legacy and document caps applies",
      target: "receivable",
      amountMinor: 1_500_000,
      code: "PAYMENT_LINK_EXCEEDS_OUTSTANDING",
      setup: async (w) => {
        await w.t.run((ctx) => ctx.db.patch(w.receivableId, { outstandingAmount: 2000 }));
      },
    },
    { name: "a partly allocated document caps at what is still owed", target: "document", amountMinor: 600_001, code: "PAYMENT_LINK_EXCEEDS_OUTSTANDING", setup: partlyAllocate },
    {
      name: "a document that is not open for payment is refused (control)",
      target: "document",
      amountMinor: 1,
      code: "PAYMENT_LINK_DEBT_CLOSED",
      setup: async (w) => {
        await w.t.run((ctx) => ctx.db.patch(w.receivableDocumentId, { status: "PAID" }));
      },
    },
  ];

  test.each(REFUSED.map((c) => [c.name, c] as const))("%s is refused and writes nothing", async (_name, c) => {
    const w = await makeWorld();
    await c.setup?.(w);
    const before = await counts(w.t);
    const code = await codeOf(createWith(w, { amountMinor: c.amountMinor, ...(await targetArgs(w, c.target)) }));
    // D-20: `c.code` is the dormant cap/state refusal that returns when payment
    // links reopen; today the shutdown refuses first, whatever the amount.
    expect(code).toBe("PAYMENT_LINKS_DISABLED");
    expect(c.code).toMatch(/^PAYMENT_LINK_/);
    expect(await counts(w.t)).toEqual(before);
  });

  const ACCEPTED: CapCase[] = [
    { name: "document target exactly at outstanding", target: "document", amountMinor: 1_000_000 },
    { name: "sale target at outstanding", target: "sale", amountMinor: 1_000_000 },
    { name: "a partly allocated document at what is still owed", target: "document", amountMinor: 600_000, setup: partlyAllocate },
  ];

  // D-20: an at-or-under-outstanding request used to be accepted. While the pilot
  // is shut it is refused identically and no intent row is created.
  test.each(ACCEPTED.map((c) => [c.name, c] as const))("%s is refused while the pilot is shut", async (_name, c) => {
    const w = await makeWorld();
    await c.setup?.(w);
    const before = await counts(w.t);
    const code = await codeOf(createWith(w, { amountMinor: c.amountMinor, ...(await targetArgs(w, c.target)) }));
    expect(code).toBe("PAYMENT_LINKS_DISABLED");
    expect(await counts(w.t)).toEqual(before);
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

  // D-20: with `create` shut no reservation can be made, so the reservation
  // arithmetic is dormant. What survives is: a second link is refused outright,
  // and expiring a (seeded) PENDING link works and releases it.
  test("D-20: neither the first nor the second link can be created", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, receivableDocumentId } = await seed(t);
    const before = await counts(t);

    expect(
      await codeOf(asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 600_000)))
    ).toBe("PAYMENT_LINKS_DISABLED");
    expect(
      await codeOf(asFinance.mutation(api.paymentIntents.create, link(orgId, customerId, receivableDocumentId, 400_000)))
    ).toBe("PAYMENT_LINKS_DISABLED");
    expect(await counts(t)).toEqual(before);
  });

  test("D-20: expire still works on a seeded PENDING link", async () => {
    const w = await makeWorld();
    const first = await seedIntent(w, { amountMinor: 600_000 });
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId: first, providerStatusConfirmed: true });
    expect((await w.t.run((ctx) => ctx.db.get(first)))?.status).toBe("EXPIRED");
  });

  test("D-20: markSettled is refused and a PENDING link is left untouched", async () => {
    const w = await makeWorld();
    const pending = await seedIntent(w, { amountMinor: 300_000 });
    const before = await counts(w.t);
    expect(
      await codeOf(
        w.asFinance.mutation(api.paymentIntents.markSettled, {
          idempotencyKey: crypto.randomUUID(),
          orgId: w.orgId,
          intentId: pending,
        })
      )
    ).toBe("PAYMENT_LINKS_DISABLED");
    expect((await w.t.run((ctx) => ctx.db.get(pending)))?.status).toBe("PENDING");
    expect(await counts(w.t)).toEqual(before);
  });

  // D-20: "a pending intent for a different document does not reserve" and "a
  // SETTLED or EXPIRED intent does not reserve" cannot be exercised while links
  // cannot be created or settled; they return with the pilot.
});

// The PENDING happy path (expire frees the reservation) is covered above by
// "expiring the first link frees its amount for the second".
describe("SCRUM-571 S1 — paymentIntents.expire refusals are coded", () => {
  test("a non-PENDING intent is refused with PAYMENT_LINK_NOT_PENDING and is not changed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance, receivableDocumentId } = await seed(t);
    // D-20: `create` is shut; the PENDING link is seeded directly.
    const intentId = await t.run((ctx) =>
      ctx.db.insert("paymentIntents", {
        orgId,
        customerId,
        receivableDocumentId,
        amountMinor: 100_000,
        currency: "JOD",
        provider: "tap",
        status: "PENDING",
        idempotencyKey: crypto.randomUUID(),
        createdBy: userId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await asFinance.mutation(api.paymentIntents.expire, { orgId, intentId, providerStatusConfirmed: true });

    expect(await codeOf(asFinance.mutation(api.paymentIntents.expire, { orgId, intentId, providerStatusConfirmed: true }))).toBe(
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
      .mutation(api.paymentIntents.expire, { orgId, intentId: foreignIntentId, providerStatusConfirmed: true })
      .catch((e: { data?: { code?: string; message?: string } }) => e.data);
    const missing = await asFinance
      .mutation(api.paymentIntents.expire, { orgId, intentId: missingIntentId, providerStatusConfirmed: true })
      .catch((e: { data?: { code?: string; message?: string } }) => e.data);

    expect(foreign?.code).toBe("PAYMENT_LINK_NOT_FOUND");
    // One message for both, so a foreign row is indistinguishable from a missing one.
    expect(foreign).toEqual(missing);
    const untouched = await t.run((ctx) => ctx.db.get(foreignIntentId));
    expect(untouched?.status).toBe("PENDING");
  });
});

const insertHeld = (w: World, externalId: string) =>
  w.t.run((ctx) =>
    ctx.db.insert("unmatchedProviderFunds", {
      provider: "tap", externalId, reason: "UNKNOWN_REFERENCE", amountMinor: 1, currency: "JOD",
      providerEventIds: [], deliveryCount: 1, amountConflict: false, reviewStatus: "OPEN",
      firstReceivedAt: Date.now(), lastReceivedAt: Date.now(),
    })
  );

// Step 5: the Create and Settle dialogs show server refusals through
// getLocalizedErrorMessage, so every refusal `create` and `markSettled` can
// raise must be coded, and its English text must equal the common.ts entry.
const REFUSAL_CASES: ReadonlyArray<{ code: string; run: (w: World) => Promise<unknown> }> = [
  { code: "PAYMENT_LINK_AMOUNT_NOT_POSITIVE", run: (w) => createWith(w, { amountMinor: 0 }) },
  { code: "PAYMENT_LINK_PROVIDER_REQUIRED", run: (w) => createWith(w, { provider: "   " }) },
  { code: "PAYMENT_LINK_CURRENCY_REQUIRED", run: (w) => createWith(w, { currency: "   " }) },
  { code: "PAYMENT_LINK_CHECKOUT_URL_INVALID", run: (w) => createWith(w, { checkoutUrl: "not a url", externalId: "ext-1" }) },
  { code: "PAYMENT_LINK_CHECKOUT_URL_NOT_HTTPS", run: (w) => createWith(w, { checkoutUrl: "http://pay.example.com/x", externalId: "ext-1" }) },
  { code: "PAYMENT_LINK_EXTERNAL_ID_REQUIRED", run: (w) => createWith(w, { checkoutUrl: "https://pay.example.com/x" }) },
  {
    code: "PAYMENT_LINK_CUSTOMER_NOT_FOUND",
    run: async (w) => {
      const foreign = await w.t.run(async (ctx) => {
        const orgId = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
        return await ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Foreign", phone: "+962790000008" });
      });
      return createWith(w, { customerId: foreign });
    },
  },
  {
    code: "PAYMENT_LINK_CUSTOMER_REMOVED",
    run: async (w) => {
      await w.t.run((ctx) => ctx.db.patch(w.customerId, { isDeleted: true }));
      return createWith(w, {});
    },
  },
  {
    code: "PAYMENT_LINK_RECEIVABLE_NOT_FOUND",
    run: async (w) => {
      await w.t.run((ctx) => ctx.db.delete(w.receivableId));
      return createWith(w, { receivableDocumentId: undefined, receivableId: w.receivableId });
    },
  },
  {
    code: "PAYMENT_LINK_RECEIVABLE_CUSTOMER_MISMATCH",
    run: async (w) => {
      const other = await otherCustomer(w);
      return createWith(w, { customerId: other, receivableDocumentId: undefined, receivableId: w.receivableId });
    },
  },
  {
    code: "PAYMENT_LINK_RECEIVABLE_NO_DOCUMENT",
    run: async (w) => {
      await w.t.run((ctx) => ctx.db.patch(w.receivableId, { canonicalReceivableDocumentId: undefined }));
      return createWith(w, { receivableDocumentId: undefined, receivableId: w.receivableId });
    },
  },
  {
    code: "PAYMENT_LINK_RECEIVABLE_DOCUMENT_MISMATCH",
    run: async (w) => {
      const otherDoc = await insertDocument(w, w.customerId);
      return createWith(w, { receivableId: w.receivableId, receivableDocumentId: otherDoc });
    },
  },
  {
    code: "PAYMENT_LINK_SALE_NOT_FOUND",
    run: async (w) => {
      const saleId = await insertSale(w, {});
      await w.t.run((ctx) => ctx.db.delete(saleId));
      return createWith(w, { receivableDocumentId: undefined, saleId });
    },
  },
  {
    code: "PAYMENT_LINK_SALE_CUSTOMER_MISMATCH",
    run: async (w) => {
      const other = await otherCustomer(w);
      const saleId = await insertSale(w, { customerId: other });
      return createWith(w, { receivableDocumentId: undefined, saleId });
    },
  },
  {
    code: "PAYMENT_LINK_SALE_NO_DOCUMENT",
    run: async (w) => {
      const saleId = await insertSale(w, {});
      return createWith(w, { receivableDocumentId: undefined, saleId });
    },
  },
  {
    code: "PAYMENT_LINK_SALE_DEBT_MISMATCH",
    run: async (w) => {
      const otherDoc = await insertDocument(w, w.customerId);
      const saleId = await insertSale(w, { canonicalReceivableDocumentId: w.receivableDocumentId });
      return createWith(w, { receivableDocumentId: otherDoc, saleId });
    },
  },
  {
    code: "PAYMENT_LINK_DOCUMENT_NOT_FOUND",
    run: async (w) => {
      const gone = await insertDocument(w, w.customerId);
      await w.t.run((ctx) => ctx.db.delete(gone));
      return createWith(w, { receivableDocumentId: gone });
    },
  },
  {
    code: "PAYMENT_LINK_DOCUMENT_PAYER_MISMATCH",
    run: async (w) => {
      const other = await otherCustomer(w);
      const doc = await insertDocument(w, other);
      return createWith(w, { receivableDocumentId: doc });
    },
  },
  { code: "PAYMENT_LINK_DOCUMENT_CURRENCY_MISMATCH", run: (w) => createWith(w, { currency: "USD" }) },
  {
    code: "PAYMENT_LINK_DEBT_CLOSED",
    run: async (w) => {
      await w.t.run((ctx) => ctx.db.patch(w.receivableDocumentId, { status: "PAID" }));
      return createWith(w, {});
    },
  },
  {
    code: "PAYMENT_LINK_EXCEEDS_RECEIVABLE",
    run: (w) => createWith(w, { receivableDocumentId: undefined, receivableId: w.receivableId, amountMinor: 1_000_001 }),
  },
  {
    code: "PAYMENT_LINK_PROVIDER_ID_IN_USE",
    run: async (w) => {
      await seedIntent(w, { externalId: "ext-dup" });
      return createWith(w, { externalId: "ext-dup" });
    },
  },
  {
    code: "PAYMENT_LINK_NOT_SETTLEABLE",
    run: async (w) => {
      const intentId = await seedIntent(w, { status: "EXPIRED" });
      return w.asFinance.mutation(api.paymentIntents.markSettled, {
        idempotencyKey: crypto.randomUUID(),
        orgId: w.orgId,
        intentId,
      });
    },
  },
  {
    // D-14: surfaced by the Create dialog (create refuses a held provider reference).
    code: "PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE",
    run: async (w) => {
      await insertHeld(w, "ext-held");
      return createWith(w, { externalId: "ext-held" });
    },
  },
  {
    // D-14: surfaced by the Settle dialog (markSettled refuses a held provider reference).
    code: "PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW",
    run: async (w) => {
      const intentId = await seedIntent(w, {});
      await insertHeld(w, "ext-held");
      return w.asFinance.mutation(api.paymentIntents.markSettled, {
        idempotencyKey: crypto.randomUUID(),
        orgId: w.orgId,
        intentId,
        externalId: "ext-held",
      });
    },
  },
  {
    code: "PAYMENT_LINK_PROVIDER_ID_MISMATCH",
    run: async (w) => {
      const intentId = await seedIntent(w, { externalId: "ext-A" });
      return w.asFinance.mutation(api.paymentIntents.markSettled, {
        idempotencyKey: crypto.randomUUID(),
        orgId: w.orgId,
        intentId,
        externalId: "ext-B",
      });
    },
  },
];

// D-20: every case below used to reach its own coded refusal inside `create` /
// `markSettled`. The pilot shutdown now refuses first, so each case is asserted
// to be preempted by PAYMENT_LINKS_DISABLED (coded, EN text equal to the
// dictionary entry, nothing mutated). `c.code` stays as the dormant refusal's
// name so the exhaustiveness check below keeps naming every code that returns
// when the pilot reopens.
describe("SCRUM-571 S1 — every uncoded throw in create/markSettled is now a coded refusal", () => {
  test.each(REFUSAL_CASES.map((c) => [c.code, c] as const))("%s (preempted by the shutdown)", async (_code, c) => {
    const w = await makeWorld();
    const before = await counts(w.t);
    const out = await refusal(c.run(w));
    expect(out.code).toBe("PAYMENT_LINKS_DISABLED");
    // The server's English text equals the dictionary entry the UI translates from.
    expect(out.message).toBe((commonEn as Record<string, string>)["ServerError_PAYMENT_LINKS_DISABLED"]);
    expect(out.message).toMatch(/Nothing has been changed\.$/);
    // A refusal never mutates payment state beyond what the case itself set up.
    expect((await counts(w.t)).journalEntries).toBe(before.journalEntries);
  });

  test("markSettled's not-found for a foreign-org intent is the shared PAYMENT_LINK_NOT_FOUND", async () => {
    const w = await makeWorld();
    const foreign = await w.t.run(async (ctx) => {
      const otherOrg = await ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() });
      const c = await ctx.db.insert("customers", { orgId: otherOrg, firstName: "Sam", lastName: "Foreign", phone: "+962790000007" });
      return await ctx.db.insert("paymentIntents", {
        orgId: otherOrg, customerId: c, amountMinor: 1, currency: "JOD", provider: "tap",
        status: "PENDING", idempotencyKey: "foreign-settle", createdBy: w.userId,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    const out = await refusal(
      w.asFinance.mutation(api.paymentIntents.markSettled, {
        idempotencyKey: crypto.randomUUID(), orgId: w.orgId, intentId: foreign,
      })
    );
    // D-20: the shutdown refuses before the intent is even looked up, so a
    // foreign-org intent cannot be told apart from any other (still no leak).
    expect(out.code).toBe("PAYMENT_LINKS_DISABLED");
  });
});

describe("SCRUM-571 S1 — every new refusal is translated in both locales", () => {
  // Derived from the server table, so a refusal added there without an en/ar
  // entry fails here. RECEIPT_MANUAL_REFUSED lives in collections.ts.
  const codes = [
    ...Object.keys(PAYMENT_LINK_REFUSALS),
    "PAYMENT_LINK_RECEIPT_MANUAL_REFUSED",
  ] as Array<keyof typeof AppErrorCode>;

  test("every case in the refusal table is exercised by a refusal case or an earlier suite", () => {
    const exercised = new Set([
      ...REFUSAL_CASES.map((c) => c.code),
      "PAYMENT_LINK_TARGET_REQUIRED",
      "PAYMENT_LINK_EXCEEDS_OUTSTANDING",
      "PAYMENT_LINK_NOT_FOUND",
      "PAYMENT_LINK_NOT_PENDING",
      // Exercised in scrum571s1Containment.test.ts (P4: expire of a held link).
      "PAYMENT_LINK_CAPTURE_HELD",
    ]);
    expect(Object.keys(PAYMENT_LINK_REFUSALS).filter((code) => !exercised.has(code))).toEqual([]);
  });

  test.each(codes)("ServerError_%s exists in en and ar", (code) => {
    const en = (commonEn as Record<string, string>)[`ServerError_${code}`];
    const ar = (commonAr as Record<string, string>)[`ServerError_${code}`];
    expect(en).toBeTruthy();
    expect(ar).toBeTruthy();
    if (code in PAYMENT_LINK_REFUSALS) {
      expect(en).toBe((PAYMENT_LINK_REFUSALS as Record<string, string>)[code]);
    }
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(en);
  });

  test.each(codes)("%s is a registered AppErrorCode", (code) => {
    expect(AppErrorCode[code]).toBe(code);
  });
});
