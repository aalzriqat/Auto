/**
 * SCRUM-571 S1 D-22 — a payment link whose provider capture is held is never
 * represented as unpaid, never reserved as collectible, and never a dead end.
 * The hold itself is the terminal transition: `settleByExternalId` moves the
 * intent to CAPTURE_HELD in the same transaction that records the held row.
 *
 * Nothing here may write a canonical payment, allocation, posting, outbox event
 * or a completed idempotency record.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { AppErrorCode } from "./utils/errors";
import { HELD_CAPTURE_LINK_REFUSALS, getDocumentUncommittedMinor } from "./paymentIntents";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const ECONOMIC = [
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

type Harness = ReturnType<typeof convexTestWithComponents>;

async function economicCounts(t: Harness) {
  return await t.run(async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of ECONOMIC) out[table] = (await ctx.db.query(table).take(10_000)).length;
    return out;
  });
}

async function makeWorld() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "D22 Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "d22_user", email: "u@example.com", name: "Finance User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "d22_viewer", email: "v@example.com", name: "Viewer" })
  );
  const viewerRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Viewer", permissions: ["view:finance"] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  return {
    t,
    orgId,
    userId,
    customerId,
    asFinance: t.withIdentity({ subject: "d22_user", clerkId: "d22_user" }),
    asViewer: t.withIdentity({ subject: "d22_viewer", clerkId: "d22_viewer" }),
  };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

const REF = "tap_d22_ref";

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
      externalId: REF,
      status: "PENDING",
      idempotencyKey: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...over,
    } as never)
  )) as Id<"paymentIntents">;
}

const capture = (w: World, over: Record<string, unknown> = {}) =>
  w.t.mutation(internal.paymentIntents.settleByExternalId, {
    provider: "tap",
    externalId: REF,
    amountMinor: 100_000,
    currency: "JOD",
    providerSignatureVerifiedAt: Date.now(),
    providerEventId: "evt_d22_1",
    ...over,
  } as never);

const heldRows = (w: World) => w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(1000));
const intentDoc = (w: World, id: Id<"paymentIntents">) => w.t.run((ctx) => ctx.db.get(id));

async function insertHeld(w: World, over: Record<string, unknown> = {}) {
  return (await w.t.run((ctx) =>
    ctx.db.insert("unmatchedProviderFunds", {
      orgId: w.orgId,
      provider: "tap",
      externalId: REF,
      reason: "INTENT_NOT_PENDING",
      amountMinor: 100_000,
      currency: "JOD",
      providerEventIds: [],
      deliveryCount: 1,
      amountConflict: false,
      reviewStatus: "OPEN",
      firstReceivedAt: Date.now(),
      lastReceivedAt: Date.now(),
      ...over,
    } as never)
  )) as Id<"unmatchedProviderFunds">;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    return data?.code ?? `plain:${String(error)}`;
  }
  return undefined;
}

describe("D-22 — the hold is the intent's terminal transition", () => {
  test.each(["PENDING", "EXPIRED", "FAILED"] as const)(
    "a verified capture on a %s link holds it AND moves the link to CAPTURE_HELD in one transaction",
    async (status) => {
      const w = await makeWorld();
      const intentId = await seedLink(w, { status });
      const before = await economicCounts(w.t);

      expect(await capture(w)).toMatchObject({ kind: "HELD" });

      const rows = await heldRows(w);
      expect(rows).toHaveLength(1);
      // The pre-transition status is kept on the held row, for audit.
      expect(rows[0]).toMatchObject({ intentId, intentStatusAtReceipt: status, reviewStatus: "OPEN" });
      expect(await intentDoc(w, intentId)).toMatchObject({ status: "CAPTURE_HELD", heldFundsId: rows[0]._id });
      expect(await economicCounts(w.t)).toEqual(before);
    }
  );

  test("SETTLED and REFUNDED links are NEVER patched", async () => {
    const w = await makeWorld();
    const settled = await seedLink(w, { status: "SETTLED", externalId: "tap_settled" });
    const refunded = await seedLink(w, { status: "REFUNDED", externalId: "tap_refunded" });
    await capture(w, { externalId: "tap_settled" });
    await capture(w, { externalId: "tap_refunded" });
    expect((await intentDoc(w, settled))?.status).toBe("SETTLED");
    const after = await intentDoc(w, refunded);
    expect(after?.status).toBe("REFUNDED");
    expect(after?.heldFundsId).toBeUndefined();
  });

  test("a redelivery for a CAPTURE_HELD link bumps the single held row: no second row, no status change, receipt status kept", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    await capture(w);
    const [first] = await heldRows(w);

    const again = await capture(w, { providerEventId: "evt_d22_2" });
    expect(again).toMatchObject({ kind: "HELD", heldId: first._id });

    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(2);
    expect(rows[0].intentStatusAtReceipt).toBe("PENDING");
    expect(await intentDoc(w, intentId)).toMatchObject({ status: "CAPTURE_HELD", heldFundsId: first._id });
  });

  test("a suspended org's capture is held as LIFECYCLE_REFUSED and the link still reaches CAPTURE_HELD", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    await w.t.run((ctx) => ctx.db.patch(w.orgId, { suspended: true }));
    const before = await economicCounts(w.t);
    expect(await capture(w)).toMatchObject({ kind: "HELD" });
    const [row] = await heldRows(w);
    expect(row.reason).toBe("LIFECYCLE_REFUSED");
    expect((await intentDoc(w, intentId))?.status).toBe("CAPTURE_HELD");
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("a held row that names ANOTHER org or intent is not linked: the intent is left alone, the hold is still recorded", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    const otherOrg = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
    const foreign = await insertHeld(w, { orgId: otherOrg });

    expect(await capture(w)).toMatchObject({ kind: "HELD", heldId: foreign });

    expect(await heldRows(w)).toHaveLength(1);
    expect((await w.t.run((ctx) => ctx.db.get(foreign)))?.deliveryCount).toBe(2);
    const intent = await intentDoc(w, intentId);
    expect(intent?.status).toBe("PENDING");
    expect(intent?.heldFundsId).toBeUndefined();

    // Same for a row naming a different intent in the same org.
    const w2 = await makeWorld();
    const intent2 = await seedLink(w2);
    const other = await seedLink(w2, { externalId: "tap_other_intent" });
    await insertHeld(w2, { intentId: other });
    await capture(w2);
    expect((await intentDoc(w2, intent2))?.status).toBe("PENDING");
  });
});

describe("D-22 readers", () => {
  test("getDocumentUncommittedMinor reserves PENDING only: CAPTURE_HELD, EXPIRED, FAILED, SETTLED do not", async () => {
    const w = await makeWorld();
    const documentId = await w.t.run(async (ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: w.orgId,
        documentNumber: "D22-1",
        documentType: "INVOICE",
        payerType: "CUSTOMER",
        customerId: w.customerId,
        sourceType: "manual_adjustment",
        sourceId: "d22",
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now() + 86_400_000,
        originalAmountMinor: 500_000,
        status: "OPEN",
        createdBy: w.userId,
        createdAt: Date.now(),
      } as never)
    );
    const reserved = () =>
      w.t.run(async (ctx) =>
        getDocumentUncommittedMinor(ctx as never, w.orgId, w.customerId, documentId as Id<"receivableDocuments">)
      );
    const base = await reserved();

    for (const [i, status] of (["CAPTURE_HELD", "EXPIRED", "FAILED", "SETTLED"] as const).entries()) {
      await seedLink(w, { receivableDocumentId: documentId, status, externalId: `tap_r_${i}` });
    }
    expect(await reserved()).toBe(base);

    await seedLink(w, { receivableDocumentId: documentId, status: "PENDING", externalId: "tap_r_pending" });
    expect(await reserved()).toBe(base - 100_000);
  });

  test("a CAPTURE_HELD link is in the list status filter", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    await capture(w);
    const page = await w.asFinance.query(api.paymentIntents.list, {
      orgId: w.orgId,
      status: "CAPTURE_HELD",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((row: { _id: string }) => row._id)).toEqual([intentId]);
  });
});

describe("D-22 expire", () => {
  test("refuses a CAPTURE_HELD link with the truthful code, before NOT_PENDING, writing nothing", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    await capture(w);
    const before = await economicCounts(w.t);
    const intentBefore = await intentDoc(w, intentId);
    const [heldBefore] = await heldRows(w);

    expect(
      await codeOf(w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: true }))
    ).toBe("PAYMENT_LINK_CAPTURE_HELD");

    expect(await intentDoc(w, intentId)).toEqual(intentBefore);
    expect((await heldRows(w))[0]).toEqual(heldBefore);
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("still refuses a PENDING link stranded by pre-D-22 code (held row exists)", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    await insertHeld(w, { intentId });
    expect(
      await codeOf(w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: true }))
    ).toBe("PAYMENT_LINK_CAPTURE_HELD");
    expect((await intentDoc(w, intentId))?.status).toBe("PENDING");
  });

  test("an unheld PENDING link expires only with the attestation, and stamps who and when", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);

    // Missing or false attestation is refused by the validator, before any write.
    await expect(
      w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId } as never)
    ).rejects.toThrow();
    await expect(
      w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: false } as never)
    ).rejects.toThrow();
    expect((await intentDoc(w, intentId))?.status).toBe("PENDING");

    const t0 = Date.now();
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: true });
    const after = await intentDoc(w, intentId);
    expect(after?.status).toBe("EXPIRED");
    expect(after?.providerStatusCheckedBy).toBe(w.userId);
    expect(after?.providerStatusCheckedAt).toBeGreaterThanOrEqual(t0);
  });

  test("a foreign-org link reads as not found", async () => {
    const w = await makeWorld();
    const otherOrg = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
    const otherCustomer = await w.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrg, firstName: "Sam", lastName: "Foreign", phone: "+962790000009" })
    );
    const foreign = await seedLink(w, { orgId: otherOrg, customerId: otherCustomer, externalId: "tap_foreign" });
    expect(
      await codeOf(w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId: foreign, providerStatusConfirmed: true }))
    ).toBe("PAYMENT_LINK_NOT_FOUND");
  });
});

describe("D-22 repair — linkHeldCaptureToIntent", () => {
  const link = (w: World, heldFundsId: Id<"unmatchedProviderFunds">) =>
    w.asFinance.mutation(api.paymentIntents.linkHeldCaptureToIntent, { orgId: w.orgId, heldFundsId });

  test.each(["OPEN", "RESOLVED"] as const)(
    "links a held row (%s) to an intent stranded PENDING, with no economic effect",
    async (reviewStatus) => {
      const w = await makeWorld();
      const intentId = await seedLink(w);
      const heldId = await insertHeld(w, { intentId, reviewStatus });
      const before = await economicCounts(w.t);

      await link(w, heldId);

      expect(await intentDoc(w, intentId)).toMatchObject({ status: "CAPTURE_HELD", heldFundsId: heldId });
      expect((await w.t.run((ctx) => ctx.db.get(heldId)))?.reviewStatus).toBe(reviewStatus);
      expect(await economicCounts(w.t)).toEqual(before);
    }
  );

  test("is an idempotent no-op when the intent is already CAPTURE_HELD with the same row", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    const heldId = await insertHeld(w, { intentId });
    await link(w, heldId);
    const once = await intentDoc(w, intentId);
    await link(w, heldId);
    expect(await intentDoc(w, intentId)).toEqual(once);
  });

  test("every refusal precedes any write", async () => {
    const w = await makeWorld();
    const otherOrg = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
    const otherCustomer = await w.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrg, firstName: "Sam", lastName: "Foreign", phone: "+962790000009" })
    );

    const gone = await insertHeld(w, { externalId: "gone" });
    await w.t.run((ctx) => ctx.db.delete(gone));
    const foreignRow = await insertHeld(w, { orgId: otherOrg, externalId: "foreign_row" });
    const noIntent = await insertHeld(w, { externalId: "no_intent" });

    const missingIntent = await seedLink(w, { externalId: "tap_gone_intent" });
    const missingIntentRow = await insertHeld(w, { externalId: "tap_gone_intent", intentId: missingIntent });
    await w.t.run((ctx) => ctx.db.delete(missingIntent));

    const foreignIntent = await seedLink(w, { orgId: otherOrg, customerId: otherCustomer, externalId: "tap_foreign_intent" });
    const foreignIntentRow = await insertHeld(w, { externalId: "tap_foreign_intent", intentId: foreignIntent });

    const mismatchIntent = await seedLink(w, { externalId: "tap_mismatch_a" });
    const mismatchRow = await insertHeld(w, { externalId: "tap_mismatch_b", intentId: mismatchIntent });

    const settled = await seedLink(w, { externalId: "tap_settled", status: "SETTLED" });
    const settledRow = await insertHeld(w, { externalId: "tap_settled", intentId: settled });
    const expired = await seedLink(w, { externalId: "tap_expired", status: "EXPIRED" });
    const expiredRow = await insertHeld(w, { externalId: "tap_expired", intentId: expired });

    const otherHeldIntent = await seedLink(w, { externalId: "tap_held_other", status: "CAPTURE_HELD" });
    const otherHeldRow = await insertHeld(w, { externalId: "tap_held_other", intentId: otherHeldIntent });

    const snapshot = () =>
      w.t.run(async (ctx) => ({
        intents: await ctx.db.query("paymentIntents").take(100),
        held: await ctx.db.query("unmatchedProviderFunds").take(100),
      }));
    const before = await snapshot();
    const econBefore = await economicCounts(w.t);

    const code = (id: Id<"unmatchedProviderFunds">) => codeOf(link(w, id));
    const missing = await code(gone);
    expect(missing).toBe("UNMATCHED_FUNDS_NOT_FOUND");
    // One message for a missing row and another tenant's row.
    expect(await code(foreignRow)).toBe(missing);
    expect(await code(noIntent)).toBe("UNMATCHED_FUNDS_NO_INTENT");
    expect(await code(missingIntentRow)).toBe("UNMATCHED_FUNDS_INTENT_NOT_FOUND");
    expect(await code(foreignIntentRow)).toBe("UNMATCHED_FUNDS_INTENT_NOT_FOUND");
    expect(await code(mismatchRow)).toBe("UNMATCHED_FUNDS_INTENT_MISMATCH");
    expect(await code(settledRow)).toBe("UNMATCHED_FUNDS_INTENT_NOT_LINKABLE");
    expect(await code(expiredRow)).toBe("UNMATCHED_FUNDS_INTENT_NOT_LINKABLE");
    // CAPTURE_HELD but linked to a DIFFERENT held row id is not an idempotent no-op.
    expect(await code(otherHeldRow)).toBe("UNMATCHED_FUNDS_INTENT_NOT_LINKABLE");

    expect(await snapshot()).toEqual(before);
    expect(await economicCounts(w.t)).toEqual(econBefore);
  });

  test("is gated on manage:finance", async () => {
    const w = await makeWorld();
    const intentId = await seedLink(w);
    const heldId = await insertHeld(w, { intentId });
    expect(
      await codeOf(w.asViewer.mutation(api.paymentIntents.linkHeldCaptureToIntent, { orgId: w.orgId, heldFundsId: heldId }))
    ).toBe("FORBIDDEN");
    expect((await intentDoc(w, intentId))?.status).toBe("PENDING");
  });
});

describe("D-22 — EN/AR parity for every new message", () => {
  const en = commonEn as Record<string, string>;
  const ar = commonAr as Record<string, string>;
  const keys = [
    ...Object.keys(HELD_CAPTURE_LINK_REFUSALS).map((code) => `ServerError_${code}`),
    "ServerError_PAYMENT_LINK_CAPTURE_HELD",
    "PaymentLinkStatus_CAPTURE_HELD",
    "ExpireProviderCheckedLabel",
    "HeldPaymentsDesc",
  ];

  test.each(keys)("%s has non-empty EN and AR", (key) => {
    expect(en[key], `en ${key}`).toBeTruthy();
    expect(ar[key], `ar ${key}`).toBeTruthy();
    expect(ar[key]).toMatch(/[؀-ۿ]/);
    expect(ar[key]).not.toBe(en[key]);
  });

  test("server English equals the dictionary entry and the codes are registered", () => {
    for (const [code, message] of Object.entries(HELD_CAPTURE_LINK_REFUSALS)) {
      expect(en[`ServerError_${code}`]).toBe(message);
      expect(AppErrorCode[code as keyof typeof AppErrorCode]).toBe(code);
    }
  });

  test("HeldPaymentsDesc no longer tells finance to expire a held link and says closing a review settles nothing", () => {
    expect(en.HeldPaymentsDesc).not.toMatch(/expire the payment link if/i);
    expect(en.HeldPaymentsDesc).toMatch(/does not settle/i);
    expect(ar.HeldPaymentsDesc).not.toContain("وأنهِ صلاحية رابط الدفع إن كان");
  });

  test("the SALE_HAS_LEGACY_RECEIVABLE copy covers deletion in both locales", () => {
    expect(en.ServerError_SALE_HAS_LEGACY_RECEIVABLE).toMatch(/deleted/);
    expect(ar.ServerError_SALE_HAS_LEGACY_RECEIVABLE).toContain("حذفه");
  });
});
