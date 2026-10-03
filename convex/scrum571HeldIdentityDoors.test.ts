/**
 * SCRUM-571 S1 D-14 — a held provider identity is quarantined at every door.
 *
 * Invariant (D-8 I3): a verified provider capture for a (provider, externalId)
 * ends in EXACTLY one settlement or EXACTLY one `unmatchedProviderFunds` row,
 * never both, and is never recognised twice. Once ANY unmatched row exists for
 * the identity (OPEN or RESOLVED, any reason, with or without org, with or
 * without amountConflict) no door may create an intent with it or settle an
 * intent with it. Recovery is a later slice (SCRUM-581).
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { AppErrorCode } from "./utils/errors";
import { PAYMENT_LINK_REFUSALS } from "./paymentIntents";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const DUE = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

// Money-bearing tables a quarantined identity must never move.
const ECONOMIC = [
  "collectionPayments",
  "canonicalPayments",
  "paymentAllocations",
  "receivableDocuments",
  "transactions",
  "accountingEvents",
  "pendingAccountingEvents",
  "journalEntries",
  "journalLines",
] as const;

type Harness = ReturnType<typeof convexTestWithComponents>;

async function economicCounts(t: Harness) {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of ECONOMIC) out[table] = (await ctx.db.query(table).take(10_000)).length;
    out.paymentIntents = (await ctx.db.query("paymentIntents").take(10_000)).length;
    return out;
  });
}

async function seed(t: Harness) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "D14 Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "d14_user", email: "u@example.com", name: "Finance User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance", "approve:requests"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  const asFinance = t.withIdentity({ subject: "d14_user", clerkId: "d14_user" });
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
  const receivableDocumentId = await t.run(async (ctx) => (await ctx.db.get(receivableId))!.canonicalReceivableDocumentId!);
  return { orgId, userId, customerId, asFinance, receivableId, receivableDocumentId };
}

type World = Awaited<ReturnType<typeof seed>> & { t: Harness };

async function makeWorld(): Promise<World> {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  return { t, ...(await seed(t)) };
}

const EXT = "tap_chg_d14";

const createArgs = (w: World, over: Record<string, unknown> = {}) => ({
  idempotencyKey: crypto.randomUUID(),
  orgId: w.orgId,
  customerId: w.customerId,
  receivableDocumentId: w.receivableDocumentId,
  amountMinor: 100_000,
  currency: "JOD",
  provider: "tap",
  externalId: EXT,
  ...over,
});

const newLink = (w: World, over: Record<string, unknown> = {}) =>
  w.asFinance.mutation(api.paymentIntents.create, createArgs(w, over) as never);

const capture = (w: World, over: Record<string, unknown> = {}) =>
  w.t.mutation(internal.paymentIntents.settleByExternalId, {
    provider: "tap",
    externalId: EXT,
    amountMinor: 100_000,
    currency: "JOD",
    providerSignatureVerifiedAt: Date.now(),
    providerEventId: "evt_1",
    ...over,
  } as never);

const heldRows = (w: World) => w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(1000));
const doc = <T extends "paymentIntents">(w: World, id: Id<T>) => w.t.run((ctx) => ctx.db.get(id));
const setSuspended = (w: World, suspended: boolean) =>
  w.t.run((ctx) => ctx.db.patch(w.orgId, { suspended, suspendedAt: Date.now(), suspendedReason: "D-14 test" }));

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: { code?: string; message?: string } }).data;
    return { code: data?.code ?? `plain:${String(error)}`, message: data?.message };
  }
  return {};
}

const settle = (w: World, intentId: Id<"paymentIntents">, over: Record<string, unknown> = {}) =>
  w.asFinance.mutation(api.paymentIntents.markSettled, {
    idempotencyKey: crypto.randomUUID(),
    orgId: w.orgId,
    intentId,
    ...over,
  } as never);

type HeldState = {
  name: string;
  // Builds the held state; returns the PENDING intent when one can exist.
  seed: (w: World) => Promise<Id<"paymentIntents"> | null>;
};

const STATES: HeldState[] = [
  {
    name: "(i) OPEN LIFECYCLE_REFUSED row, no conflict",
    seed: async (w) => {
      const intentId = await newLink(w);
      await setSuspended(w, true);
      await capture(w);
      await setSuspended(w, false);
      const [row] = await heldRows(w);
      expect(row).toMatchObject({ reason: "LIFECYCLE_REFUSED", reviewStatus: "OPEN", amountConflict: false });
      expect((await doc(w, intentId))?.status).toBe("PENDING");
      return intentId;
    },
  },
  {
    name: "(ii) OPEN row with amountConflict",
    seed: async (w) => {
      const intentId = await newLink(w);
      await setSuspended(w, true);
      await capture(w);
      await capture(w, { providerEventId: "evt_2", amountMinor: 250_000 });
      await setSuspended(w, false);
      const [row] = await heldRows(w);
      expect(row).toMatchObject({ reviewStatus: "OPEN", amountConflict: true });
      return intentId;
    },
  },
  {
    name: "(iii) RESOLVED row",
    seed: async (w) => {
      const intentId = await newLink(w);
      await setSuspended(w, true);
      await capture(w);
      await setSuspended(w, false);
      const [row] = await heldRows(w);
      await w.asFinance.mutation(api.paymentIntents.resolveUnmatchedProviderFunds, {
        orgId: w.orgId,
        id: row._id,
        note: "Recorded through the receipt flow",
      });
      expect((await heldRows(w))[0].reviewStatus).toBe("RESOLVED");
      return intentId;
    },
  },
  {
    name: "(iv) OPEN no-org UNKNOWN_REFERENCE row",
    seed: async (w) => {
      await capture(w);
      const [row] = await heldRows(w);
      expect(row).toMatchObject({ reason: "UNKNOWN_REFERENCE", reviewStatus: "OPEN" });
      expect(row.orgId).toBeUndefined();
      return null;
    },
  },
];

describe.each(STATES)("SCRUM-571 D-14 — held identity $name", (state) => {
  test("create refuses PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE and inserts no intent", async () => {
    const w = await makeWorld();
    await state.seed(w);
    const before = await economicCounts(w.t);
    const out = await refusal(newLink(w, { externalId: EXT, idempotencyKey: "create-key-1" }));
    expect(out.code).toBe("PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE");
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("create normalizes the reference like the webhook writer (case-insensitive provider, trimmed id)", async () => {
    const w = await makeWorld();
    await state.seed(w);
    const out = await refusal(newLink(w, { provider: " TAP ", externalId: `  ${EXT}  ` }));
    expect(out.code).toBe("PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE");
  });

  test("webhook redelivery returns HELD with the SAME row, bumps deliveryCount, settles nothing", async () => {
    const w = await makeWorld();
    const intentId = await state.seed(w);
    const [row] = await heldRows(w);
    const before = await economicCounts(w.t);

    const result = await capture(w, { providerEventId: "evt_redelivery" });
    expect(result).toEqual({ kind: "HELD", heldId: row._id });

    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(row.deliveryCount + 1);
    expect(await economicCounts(w.t)).toEqual(before);
    if (intentId) {
      const intent = await doc(w, intentId);
      expect(intent?.status).toBe("PENDING");
      expect(intent?.canonicalPaymentId).toBeUndefined();
    }
  });

  test("markSettled with externalId supplied refuses SETTLEMENT_REQUIRES_REVIEW, and a retry of the same key still refuses", async () => {
    const w = await makeWorld();
    let intentId = await state.seed(w);
    // (iv): no intent can carry the reference; settle an intent that has none.
    if (!intentId) {
      intentId = await w.asFinance.mutation(api.paymentIntents.create, createArgs(w, { externalId: undefined }) as never);
    }
    const before = await economicCounts(w.t);
    const key = `settle-key-${state.name}`;

    const first = await refusal(settle(w, intentId, { externalId: EXT, idempotencyKey: key }));
    expect(first.code).toBe("PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW");
    const retry = await refusal(settle(w, intentId, { externalId: EXT, idempotencyKey: key }));
    expect(retry.code).toBe("PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW");

    expect(await economicCounts(w.t)).toEqual(before);
    expect((await doc(w, intentId))?.status).toBe("PENDING");
    const stored = await w.t.run((ctx) => ctx.db.query("commandIdempotency").take(1000));
    expect(stored.filter((r) => r.idempotencyKey === key)).toEqual([]);
  });
});

describe("SCRUM-571 D-14 — markSettled with externalId omitted", () => {
  test("an intent carrying the held externalId refuses", async () => {
    const w = await makeWorld();
    const intentId = await STATES[0].seed(w);
    const before = await economicCounts(w.t);
    const out = await refusal(settle(w, intentId!));
    expect(out.code).toBe("PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW");
    expect(await economicCounts(w.t)).toEqual(before);
  });
});

describe("SCRUM-571 D-14 — cross-door and cross-tenant", () => {
  test("a different org creating with a no-org held reference gets the same refusal", async () => {
    const w = await makeWorld();
    await STATES[3].seed(w);

    const otherOrgId = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() }));
    const otherUser = await w.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "d14_other", email: "o@example.com", name: "Other Finance" })
    );
    const otherRole = await w.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: otherOrgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance"] })
    );
    await w.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrgId, userId: otherUser, roleId: otherRole }));
    const otherCustomer = await w.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Omar", lastName: "Other", phone: "+962790000009" })
    );
    const otherDoc = await w.t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: otherOrgId,
        documentType: "INVOICE",
        documentNumber: "DOC-OTHER-1",
        payerType: "CUSTOMER",
        customerId: otherCustomer,
        sourceType: "legacy_receivable",
        sourceId: crypto.randomUUID(),
        originalAmountMinor: 900_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: DUE(),
        status: "OPEN",
        createdBy: otherUser,
        createdAt: Date.now(),
      } as never)
    );
    const asOther = w.t.withIdentity({ subject: "d14_other", clerkId: "d14_other" });
    const mine = await refusal(newLink(w));
    const theirs = await refusal(
      asOther.mutation(api.paymentIntents.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId: otherOrgId,
        customerId: otherCustomer,
        receivableDocumentId: otherDoc,
        amountMinor: 100_000,
        currency: "JOD",
        provider: "tap",
        externalId: EXT,
      } as never)
    );
    expect(mine.code).toBe("PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE");
    expect(theirs).toEqual(mine);
  });

  test("one provider identity never belongs to two intents: B (no externalId) settled with A's externalId refuses PROVIDER_ID_IN_USE", async () => {
    const w = await makeWorld();
    const a = await newLink(w, { externalId: "ext-A-owner" });
    const b = await newLink(w, { externalId: undefined });
    const before = await economicCounts(w.t);
    const out = await refusal(settle(w, b, { externalId: "ext-A-owner" }));
    expect(out.code).toBe("PAYMENT_LINK_PROVIDER_ID_IN_USE");
    expect(await economicCounts(w.t)).toEqual(before);
    expect((await doc(w, a))?.status).toBe("PENDING");
    expect((await doc(w, b))?.status).toBe("PENDING");
  });
});

describe("SCRUM-571 D-14 — controls", () => {
  test("a clean identity still settles at both doors", async () => {
    const w = await makeWorld();
    const viaWebhook = await newLink(w, { externalId: "ext-clean-1", amountMinor: 100_000 });
    expect(await capture(w, { externalId: "ext-clean-1" })).toEqual({ kind: "SETTLED", intentId: viaWebhook });

    const viaStaff = await newLink(w, { externalId: "ext-clean-2", amountMinor: 100_000 });
    await settle(w, viaStaff);
    expect((await doc(w, viaStaff))?.status).toBe("SETTLED");
    expect(await heldRows(w)).toHaveLength(0);
  });

  test("a held row for a DIFFERENT externalId does not block create, webhook or markSettled", async () => {
    const w = await makeWorld();
    await capture(w, { externalId: "ext-someone-else" });
    expect(await heldRows(w)).toHaveLength(1);

    const a = await newLink(w, { externalId: "ext-free-1" });
    expect(await capture(w, { externalId: "ext-free-1" })).toEqual({ kind: "SETTLED", intentId: a });
    const b = await newLink(w, { externalId: "ext-free-2" });
    await settle(w, b);
    expect((await doc(w, b))?.status).toBe("SETTLED");
  });
});

describe("SCRUM-571 D-14 — i18n parity of the new codes", () => {
  const CODES = ["PAYMENT_LINK_PROVIDER_REFERENCE_UNAVAILABLE", "PAYMENT_LINK_SETTLEMENT_REQUIRES_REVIEW"] as const;
  test.each(CODES)("%s has matching EN, distinct non-empty AR, and is a registered code", (code) => {
    const en = (commonEn as Record<string, string>)[`ServerError_${code}`];
    const ar = (commonAr as Record<string, string>)[`ServerError_${code}`];
    expect(en).toBe(PAYMENT_LINK_REFUSALS[code]);
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(ar).not.toBe(en);
    expect(AppErrorCode[code]).toBe(code);
  });
});
