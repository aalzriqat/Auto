/**
 * SCRUM-571 S1 D-8 — a verified provider capture is never acknowledged blind.
 *
 * Invariant: a signature-verified provider capture is acknowledged (HTTP 200)
 * only after it has a durable outcome in the same transaction: exactly one
 * settlement, OR exactly one finance-visible unmatched-funds record. An
 * unmatched record never creates AR, an allocation, a canonical payment or a GL
 * posting.
 *
 * `paymentIntents.settleByExternalId` used to return null with no durable
 * finance record for an unknown reference, a non-PENDING intent (EXPIRED by the
 * operator, FAILED earlier), a lifecycle refusal's finance side and an
 * amount/currency/account mismatch; convex/http.ts answers 200 to the null.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { AppErrorCode } from "./utils/errors";
import { UNMATCHED_FUNDS_REFUSALS } from "./paymentIntents";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const DUE = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

// Everything a held capture must NOT touch. paymentIntents is tracked too: the
// count must not move (the mismatch path patches a row, never inserts one).
const ECONOMIC = [
  "paymentIntents",
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
    return out;
  });
}

async function seed(t: Harness) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "D8 Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "d8_user", email: "u@example.com", name: "Finance User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Manager",
      permissions: ["view:finance", "manage:finance", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "d8_viewer", email: "v@example.com", name: "Viewer" })
  );
  const viewerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Viewer", permissions: ["view:finance"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  const asFinance = t.withIdentity({ subject: "d8_user", clerkId: "d8_user" });
  const asViewer = t.withIdentity({ subject: "d8_viewer", clerkId: "d8_viewer" });
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
  return { orgId, userId, customerId, asFinance, asViewer, receivableId, receivableDocumentId };
}

type World = Awaited<ReturnType<typeof seed>> & { t: Harness };

async function makeWorld(): Promise<World> {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  return { t, ...(await seed(t)) };
}

const EXTERNAL = "tap_chg_d8";

// D-20: `paymentIntents.create` is shut, so a PENDING link can no longer be made
// through the public door. The link is seeded directly: this file is about what
// the webhook door does with a verified capture, not about creating links.
async function newLink(w: World, over: Record<string, unknown> = {}): Promise<Id<"paymentIntents">> {
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("paymentIntents", {
      orgId: w.orgId,
      customerId: w.customerId,
      createdBy: w.userId,
      receivableId: w.receivableId,
      receivableDocumentId: w.receivableDocumentId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "tap",
      externalId: EXTERNAL,
      status: "PENDING",
      idempotencyKey: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...over,
    } as never)
  );
}

const capture = (w: World, over: Record<string, unknown> = {}) =>
  w.t.mutation(internal.paymentIntents.settleByExternalId, {
    provider: "tap",
    externalId: EXTERNAL,
    amountMinor: 100_000,
    currency: "JOD",
    providerSignatureVerifiedAt: Date.now(),
    providerEventId: "evt_1",
    ...over,
  } as never);

const heldRows = (w: World) => w.t.run((ctx) => ctx.db.query("unmatchedProviderFunds").take(1000));

const outstanding = (w: World) => w.t.run(async (ctx) => (await ctx.db.get(w.receivableId))!.outstandingAmount);

const doc = <T extends TableNames>(w: World, id: Id<T>) => w.t.run((ctx) => ctx.db.get(id));

const otherOrg = (w: World) =>
  w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));

async function refusal(promise: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: { code?: string; message?: string } }).data;
    return { code: data?.code ?? `plain:${String(error)}`, message: data?.message };
  }
  return {};
}

describe("SCRUM-571 D-8 — a verified capture on a link that is no longer PENDING is held, not lost", () => {
  test("expired link, then a verified late webhook: one OPEN record, nothing economic", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w);
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: true });
    const before = await economicCounts(w.t);
    const owedBefore = await outstanding(w);

    const result = await capture(w, { providerAccountId: undefined });
    expect(result).toMatchObject({ kind: "HELD" });

    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: w.orgId,
      provider: "tap",
      externalId: EXTERNAL,
      intentId,
      reason: "INTENT_NOT_PENDING",
      intentStatusAtReceipt: "EXPIRED",
      amountMinor: 100_000,
      currency: "JOD",
      reviewStatus: "OPEN",
      deliveryCount: 1,
      amountConflict: false,
      providerEventIds: ["evt_1"],
    });
    expect((await doc(w, intentId))?.status).toBe("CAPTURE_HELD");
    expect(await economicCounts(w.t)).toEqual(before);
    expect(await outstanding(w)).toBe(owedBefore);
  });

  test("a FAILED link (any non-PENDING status) holds the capture too", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w);
    await w.t.run((ctx) => ctx.db.patch(intentId, { status: "FAILED" }));
    await capture(w);
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("INTENT_NOT_PENDING");
    expect(rows[0].intentStatusAtReceipt).toBe("FAILED");
  });

  // D-20: a new link cannot be created while the pilot is shut, so "a new link is
  // accepted after expire" is unreachable. What survives is that expire still
  // works on a PENDING link and releases it.
  test("expire still works on a PENDING link while the pilot is shut, and creating a new one is refused", async () => {
    const w = await makeWorld();
    const first = await newLink(w, { amountMinor: 1_000_000, externalId: "ext_full_1" });
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId: first, providerStatusConfirmed: true });
    expect((await doc(w, first))?.status).toBe("EXPIRED");
    await expect(
      w.asFinance.mutation(api.paymentIntents.create, {
        idempotencyKey: crypto.randomUUID(),
        orgId: w.orgId,
        customerId: w.customerId,
        receivableDocumentId: w.receivableDocumentId,
        amountMinor: 1_000_000,
        currency: "JOD",
        provider: "tap",
        externalId: "ext_full_2",
      } as never)
    ).rejects.toMatchObject({ data: { code: "PAYMENT_LINKS_DISABLED" } });
  });
});

describe("SCRUM-571 D-8 — an unknown reference is held with no organization", () => {
  test("one record, UNKNOWN_REFERENCE, no orgId, no intent, nothing economic", async () => {
    const w = await makeWorld();
    const before = await economicCounts(w.t);
    const result = await capture(w, { externalId: "tap_nobody_knows", amountMinor: 55_000 });
    expect(result).toMatchObject({ kind: "HELD" });

    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "tap",
      externalId: "tap_nobody_knows",
      reason: "UNKNOWN_REFERENCE",
      amountMinor: 55_000,
      currency: "JOD",
      reviewStatus: "OPEN",
    });
    expect(rows[0].orgId).toBeUndefined();
    expect(rows[0].intentId).toBeUndefined();
    expect(await economicCounts(w.t)).toEqual(before);
  });
});

describe("SCRUM-571 D-8 — an amount, currency or account mismatch is held", () => {
  // D-20: the pilot shutdown hold precedes the mismatch check, so a PENDING
  // intent's capture is held as PAYMENT_LINKS_DISABLED whatever its amount,
  // account or currency, and the intent is NOT flipped to FAILED (D-22: it moves
  // to CAPTURE_HELD). The AMOUNT_OR_ACCOUNT_MISMATCH reason returns when links reopen.
  test("PENDING intent, wrong amount: held as PAYMENT_LINKS_DISABLED, intent moves to CAPTURE_HELD, nothing economic; redelivery stays ONE record", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w);
    const before = await economicCounts(w.t);

    expect(await capture(w, { amountMinor: 99_000 })).toMatchObject({ kind: "HELD" });
    expect((await doc(w, intentId))?.status).toBe("CAPTURE_HELD");
    let rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: w.orgId,
      intentId,
      reason: "PAYMENT_LINKS_DISABLED",
      intentStatusAtReceipt: "PENDING",
      amountMinor: 99_000,
      deliveryCount: 1,
    });
    expect(await economicCounts(w.t)).toEqual(before);

    expect(await capture(w, { amountMinor: 99_000, providerEventId: "evt_2" })).toMatchObject({ kind: "HELD" });
    rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(2);
    expect(rows[0].reason).toBe("PAYMENT_LINKS_DISABLED");
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("a provider-account mismatch is held (as PAYMENT_LINKS_DISABLED while the pilot is shut)", async () => {
    const w = await makeWorld();
    await newLink(w, { providerAccountId: "acct_A" });
    await capture(w, { providerAccountId: "acct_B" });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("PAYMENT_LINKS_DISABLED");
    expect(rows[0].providerAccountId).toBe("acct_B");
  });

  test("a currency mismatch is held (as PAYMENT_LINKS_DISABLED while the pilot is shut)", async () => {
    const w = await makeWorld();
    await newLink(w);
    await capture(w, { currency: "USD" });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "PAYMENT_LINKS_DISABLED", currency: "USD" });
  });
});

describe("SCRUM-571 D-8 — redelivery dedupes on the capture, not the event", () => {
  async function heldOnce(w: World) {
    const intentId = await newLink(w);
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: true });
    await capture(w, { providerEventId: "evt_1" });
  }

  test("same event id: deliveryCount 2 and one event id", async () => {
    const w = await makeWorld();
    await heldOnce(w);
    await capture(w, { providerEventId: "evt_1" });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(2);
    expect(rows[0].providerEventIds).toEqual(["evt_1"]);
  });

  test("a different event id is appended", async () => {
    const w = await makeWorld();
    await heldOnce(w);
    await capture(w, { providerEventId: "evt_2" });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(2);
    expect(rows[0].providerEventIds).toEqual(["evt_1", "evt_2"]);
  });

  test("no event id at all still dedupes to one row", async () => {
    const w = await makeWorld();
    await heldOnce(w);
    await capture(w, { providerEventId: undefined });
    await capture(w, { providerEventId: undefined });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(3);
    expect(rows[0].providerEventIds).toEqual(["evt_1"]);
  });

  test("the event id list is bounded to the 20 most recent", async () => {
    const w = await makeWorld();
    await heldOnce(w);
    for (let i = 2; i <= 30; i++) await capture(w, { providerEventId: `evt_${i}` });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliveryCount).toBe(30);
    expect(rows[0].providerEventIds).toHaveLength(20);
    expect(rows[0].providerEventIds.at(-1)).toBe("evt_30");
    expect(rows[0].providerEventIds).not.toContain("evt_1");
  });

  test("a later delivery with a different amount flags amountConflict on the same single row", async () => {
    const w = await makeWorld();
    await heldOnce(w);
    await capture(w, { providerEventId: "evt_2", amountMinor: 250_000 });
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountConflict).toBe(true);
    expect(rows[0].deliveryCount).toBe(2);
  });

  test("a RESOLVED row stays resolved on a plain redelivery but reopens when a conflict newly appears", async () => {
    const w = await makeWorld();
    await heldOnce(w);
    const [row] = await heldRows(w);
    await w.asFinance.mutation(api.paymentIntents.resolveUnmatchedProviderFunds, {
      orgId: w.orgId,
      id: row._id,
      note: "Refunded to the customer through the bank",
    });

    await capture(w, { providerEventId: "evt_2" });
    let [after] = await heldRows(w);
    expect(after.reviewStatus).toBe("RESOLVED");
    expect(after.deliveryCount).toBe(2);

    await capture(w, { providerEventId: "evt_3", amountMinor: 7 });
    [after] = await heldRows(w);
    expect(after.amountConflict).toBe(true);
    expect(after.reviewStatus).toBe("OPEN");
    expect(await heldRows(w)).toHaveLength(1);
  });
});

describe("SCRUM-571 D-8 — a SETTLED link is an idempotent acknowledgement, with no record", () => {
  // D-20: a link already SETTLED (settled before the shutdown) is still an
  // idempotent acknowledgement. It is seeded directly: no new link can settle.
  test("already-SETTLED link, redelivered: intent id returned, zero records, nothing economic", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w, { status: "SETTLED" });
    const before = await economicCounts(w.t);

    expect(await capture(w, { providerEventId: "evt_dup" })).toMatchObject({ kind: "ALREADY_SETTLED", intentId });
    expect(await heldRows(w)).toHaveLength(0);
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("PENDING control (D-20): a normal capture no longer settles; it is held and settles nothing", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w);
    const before = await economicCounts(w.t);
    expect(await capture(w)).toMatchObject({ kind: "HELD" });
    const intent = await doc(w, intentId);
    expect(intent?.status).toBe("CAPTURE_HELD");
    expect(intent?.canonicalPaymentId).toBeUndefined();
    expect(intent?.paymentAllocationId).toBeUndefined();
    expect(await heldRows(w)).toHaveLength(1);
    expect(await economicCounts(w.t)).toEqual(before);
  });
});

describe("SCRUM-571 D-8 — a lifecycle refusal keeps its webhook log AND writes the recovery record", () => {
  const suspend = (w: World) =>
    w.t.run((ctx) => ctx.db.patch(w.orgId, { suspended: true, suspendedAt: Date.now(), suspendedReason: "D-8 test" }));
  const refusalLogs = (w: World) =>
    w.t.run(async (ctx) => (await ctx.db.query("webhookLogs").take(100)).filter((r) => r.source === "payment" && r.status === "error"));

  test("suspended org, PENDING intent: webhookLogs row AND one LIFECYCLE_REFUSED record, intent untouched", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w);
    await suspend(w);
    const before = await economicCounts(w.t);

    expect(await capture(w)).toMatchObject({ kind: "HELD" });

    expect(await refusalLogs(w)).toHaveLength(1);
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: w.orgId,
      intentId,
      reason: "LIFECYCLE_REFUSED",
      intentStatusAtReceipt: "PENDING",
      reviewStatus: "OPEN",
    });
    expect((await doc(w, intentId))?.status).toBe("CAPTURE_HELD");
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("suspended org, intent ALREADY SETTLED: the earlier settlement is the outcome, so no record (log only)", async () => {
    const w = await makeWorld();
    await newLink(w, { status: "SETTLED" }); // D-20: seeded; no link can settle now
    await suspend(w);
    expect(await capture(w, { providerEventId: "evt_late" })).toMatchObject({ kind: "ALREADY_SETTLED" });
    expect(await refusalLogs(w)).toHaveLength(1);
    expect(await heldRows(w)).toHaveLength(0);
  });
});

describe("SCRUM-571 D-8 — settleByExternalId returns a typed outcome; HELD always names a durable row", () => {
  const suspend = (w: World) =>
    w.t.run((ctx) => ctx.db.patch(w.orgId, { suspended: true, suspendedAt: Date.now(), suspendedReason: "D-8 test" }));

  test("unknown reference: HELD with the id of the one row", async () => {
    const w = await makeWorld();
    const result = await capture(w, { externalId: "tap_kind_unknown" });
    const [row] = await heldRows(w);
    expect(result).toEqual({ kind: "HELD", heldId: row._id });
  });

  test("non-PENDING intent: HELD, and a redelivery names the SAME row", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w);
    await w.asFinance.mutation(api.paymentIntents.expire, { orgId: w.orgId, intentId, providerStatusConfirmed: true });
    const first = await capture(w);
    const second = await capture(w, { providerEventId: "evt_2" });
    const [row] = await heldRows(w);
    expect(first).toEqual({ kind: "HELD", heldId: row._id });
    expect(second).toEqual({ kind: "HELD", heldId: row._id });
  });

  test("mismatch: HELD, and the row records the PRE-patch PENDING status", async () => {
    const w = await makeWorld();
    await newLink(w);
    const result = await capture(w, { amountMinor: 99_000 });
    const [row] = await heldRows(w);
    expect(result).toEqual({ kind: "HELD", heldId: row._id });
    expect(row.intentStatusAtReceipt).toBe("PENDING");
  });

  test("lifecycle-refused on a non-SETTLED intent: HELD", async () => {
    const w = await makeWorld();
    await newLink(w);
    await suspend(w);
    const result = await capture(w);
    const [row] = await heldRows(w);
    expect(result).toEqual({ kind: "HELD", heldId: row._id });
  });

  // D-20: the SETTLED success outcome is unreachable while links are shut; a
  // PENDING capture is HELD and an already-SETTLED one is ALREADY_SETTLED.
  test("PENDING capture: HELD (shutdown); an already-SETTLED link: ALREADY_SETTLED", async () => {
    const w = await makeWorld();
    const pendingId = await newLink(w);
    const result = await capture(w);
    const [row] = await heldRows(w);
    expect(result).toEqual({ kind: "HELD", heldId: row._id });
    expect((await doc(w, pendingId))?.status).toBe("CAPTURE_HELD");

    const settledId = await newLink(w, { status: "SETTLED", externalId: "tap_chg_settled" });
    expect(await capture(w, { externalId: "tap_chg_settled", providerEventId: "evt_dup" })).toEqual({
      kind: "ALREADY_SETTLED",
      intentId: settledId,
    });
    expect(await heldRows(w)).toHaveLength(1);
  });

  test("lifecycle-refused on an ALREADY SETTLED intent: ALREADY_SETTLED, no record", async () => {
    const w = await makeWorld();
    const intentId = await newLink(w, { status: "SETTLED" }); // D-20: seeded
    await suspend(w);
    expect(await capture(w, { providerEventId: "evt_late" })).toEqual({ kind: "ALREADY_SETTLED", intentId });
    expect(await heldRows(w)).toHaveLength(0);
  });
});

async function insertHeld(
  w: World,
  over: Record<string, unknown> & { externalId: string }
): Promise<Id<"unmatchedProviderFunds">> {
  const now = Date.now();
  return await w.t.run((ctx) =>
    ctx.db.insert("unmatchedProviderFunds", {
      orgId: w.orgId,
      provider: "tap",
      reason: "INTENT_NOT_PENDING",
      amountMinor: 1_000,
      currency: "JOD",
      providerEventIds: [],
      deliveryCount: 1,
      amountConflict: false,
      reviewStatus: "OPEN",
      firstReceivedAt: now,
      lastReceivedAt: now,
      ...over,
    } as never)
  );
}

describe("SCRUM-571 D-8 — paymentIntents.listUnmatchedProviderFunds", () => {
  test("shows this org's rows OPEN first, hides other orgs' rows and no-org rows", async () => {
    const w = await makeWorld();
    const otherOrgId = await otherOrg(w);
    const resolved = await insertHeld(w, { externalId: "mine_resolved", reviewStatus: "RESOLVED", resolvedAt: Date.now() });
    const open = await insertHeld(w, { externalId: "mine_open" });
    await insertHeld(w, { externalId: "theirs", orgId: otherOrgId });
    await insertHeld(w, { externalId: "platform", orgId: undefined, reason: "UNKNOWN_REFERENCE" });

    const list = await w.asFinance.query(api.paymentIntents.listUnmatchedProviderFunds, { orgId: w.orgId });
    expect(list.map((r) => r._id)).toEqual([open, resolved]);
  });

  test("returns only the displayed fields: no provider event ids, no resolver id, no org or intent ids", async () => {
    const w = await makeWorld();
    await insertHeld(w, { externalId: "shape", resolvedBy: w.userId, providerEventIds: ["evt_secret"] });
    const [row] = await w.asFinance.query(api.paymentIntents.listUnmatchedProviderFunds, { orgId: w.orgId });
    expect(Object.keys(row).sort()).toEqual(
      [
        "_id",
        "amountConflict",
        "amountMinor",
        "currency",
        "deliveryCount",
        "externalId",
        "firstReceivedAt",
        "intentStatusAtReceipt",
        "lastReceivedAt",
        "provider",
        "reason",
        "resolutionNote",
        "resolvedAt",
        "reviewStatus",
      ].filter((key) => key in row)
    );
    expect(row).not.toHaveProperty("providerEventIds");
    expect(row).not.toHaveProperty("resolvedBy");
  });

  test("is gated on manage:finance, the same permission that reads payment intents", async () => {
    const w = await makeWorld();
    await insertHeld(w, { externalId: "mine_open" });
    const intents = await refusal(w.asViewer.query(api.paymentIntents.list, { orgId: w.orgId, paginationOpts: { numItems: 5, cursor: null } }));
    const held = await refusal(w.asViewer.query(api.paymentIntents.listUnmatchedProviderFunds, { orgId: w.orgId }));
    expect(intents.code).toBe("FORBIDDEN");
    expect(held.code).toBe("FORBIDDEN");
  });
});

describe("SCRUM-571 D-8 — paymentIntents.resolveUnmatchedProviderFunds", () => {
  test("sets RESOLVED with actor, time and note, and has no economic effect", async () => {
    const w = await makeWorld();
    const id = await insertHeld(w, { externalId: "to_resolve" });
    const before = await economicCounts(w.t);
    const owedBefore = await outstanding(w);

    await w.asFinance.mutation(api.paymentIntents.resolveUnmatchedProviderFunds, {
      orgId: w.orgId,
      id,
      note: "  Reconciled through the bank receipt door  ",
    });

    const row = await doc(w, id);
    expect(row).toMatchObject({
      reviewStatus: "RESOLVED",
      resolvedBy: w.userId,
      resolutionNote: "Reconciled through the bank receipt door",
    });
    expect(row?.resolvedAt).toBeGreaterThan(0);
    expect(await economicCounts(w.t)).toEqual(before);
    expect(await outstanding(w)).toBe(owedBefore);
  });

  test("refuses with coded errors: empty note, too-long note, already resolved, missing and foreign rows", async () => {
    const w = await makeWorld();
    const id = await insertHeld(w, { externalId: "refusals" });
    const otherOrgId = await otherOrg(w);
    const foreign = await insertHeld(w, { externalId: "foreign", orgId: otherOrgId });
    const platform = await insertHeld(w, { externalId: "platform", orgId: undefined });
    const gone = await insertHeld(w, { externalId: "gone" });
    await w.t.run((ctx) => ctx.db.delete(gone));
    const seen = new Set<string | undefined>();
    const resolve = async (rowId: Id<"unmatchedProviderFunds">, note: string) => {
      const out = await refusal(
        w.asFinance.mutation(api.paymentIntents.resolveUnmatchedProviderFunds, { orgId: w.orgId, id: rowId, note })
      );
      seen.add(out.code);
      return out;
    };

    expect((await resolve(id, "")).code).toBe("UNMATCHED_FUNDS_NOTE_REQUIRED");
    expect((await resolve(id, "   \n ")).code).toBe("UNMATCHED_FUNDS_NOTE_REQUIRED");
    expect((await resolve(id, "x".repeat(1001))).code).toBe("UNMATCHED_FUNDS_NOTE_TOO_LONG");
    expect((await doc(w, id))?.reviewStatus).toBe("OPEN");

    const missing = await resolve(gone, "ok");
    const other = await resolve(foreign, "ok");
    const platformRow = await resolve(platform, "ok");
    expect(missing.code).toBe("UNMATCHED_FUNDS_NOT_FOUND");
    // One message for missing, foreign and platform-scope rows: never disclose another tenant's row.
    expect(other).toEqual(missing);
    expect(platformRow).toEqual(missing);
    expect((await doc(w, foreign))?.reviewStatus).toBe("OPEN");

    expect((await resolve(id, "done")).code).toBeUndefined();
    const twice = await resolve(id, "again");
    expect(twice.code).toBe("UNMATCHED_FUNDS_ALREADY_RESOLVED");
    expect((await doc(w, id))?.resolutionNote).toBe("done");

    // Every refusal in the table is reachable and was exercised above. Derived
    // from the table, so a new code without a case here fails this test.
    const codes = Object.keys(UNMATCHED_FUNDS_REFUSALS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(seen.has(code), `${code} was never exercised`).toBe(true);
  });

  test("is gated on manage:finance", async () => {
    const w = await makeWorld();
    const id = await insertHeld(w, { externalId: "gated" });
    const out = await refusal(
      w.asViewer.mutation(api.paymentIntents.resolveUnmatchedProviderFunds, { orgId: w.orgId, id, note: "nope" })
    );
    expect(out.code).toBe("FORBIDDEN");
    expect((await doc(w, id))?.reviewStatus).toBe("OPEN");
  });
});

describe("SCRUM-571 D-8 — EN/AR parity for every new message", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const en = commonEn as Record<string, string>;
  const ar = commonAr as Record<string, string>;

  const uiKeys = [
    "HeldPaymentsTitle",
    "HeldPaymentsDesc",
    "HeldPaymentsLoading",
    "HeldPaymentsEmpty",
    "HeldPaymentsError",
    "HeldPaymentsReason_UNKNOWN_REFERENCE",
    "HeldPaymentsReason_INTENT_NOT_PENDING",
    "HeldPaymentsReason_AMOUNT_OR_ACCOUNT_MISMATCH",
    "HeldPaymentsReason_LIFECYCLE_REFUSED",
    "HeldPaymentsReason_PAYMENT_LINKS_DISABLED",
    "HeldPaymentsReceived",
    "HeldPaymentsDeliveries",
    "HeldPaymentsConflict",
    "HeldPaymentsResolve",
    "HeldPaymentsResolved",
    "HeldPaymentsResolveTitle",
    "HeldPaymentsResolveDescription",
    "HeldPaymentsNoteLabel",
    "HeldPaymentsResolvedToast",
    "ExpirePaymentLinkDescription",
  ];
  const serverKeys = Object.keys(UNMATCHED_FUNDS_REFUSALS).map((code) => `ServerError_${code}`);

  test.each([...uiKeys, ...serverKeys])("%s has non-empty EN and AR with matching placeholders", (key) => {
    expect(en[key], `en ${key}`).toBeTruthy();
    expect(ar[key], `ar ${key}`).toBeTruthy();
    expect(ar[key]).toMatch(/[؀-ۿ]/);
    expect(ar[key]).not.toBe(en[key]);
    expect(placeholders(ar[key])).toEqual(placeholders(en[key]));
  });

  test("the server English text equals the dictionary entry the UI translates from", () => {
    expect(Object.keys(UNMATCHED_FUNDS_REFUSALS).length).toBeGreaterThan(0);
    for (const [code, message] of Object.entries(UNMATCHED_FUNDS_REFUSALS)) {
      expect(en[`ServerError_${code}`]).toBe(message);
      expect(AppErrorCode[code as keyof typeof AppErrorCode]).toBe(code);
    }
  });

  test("the corrected Expire copy says what expiring does and does not do", () => {
    expect(en.ExpirePaymentLinkDescription).toContain("{customer}");
    expect(en.ExpirePaymentLinkDescription).toContain("{amount}");
    expect(en.ExpirePaymentLinkDescription).not.toMatch(/will stop accepting payment/i);
    expect(en.ExpirePaymentLinkDescription).toMatch(/deactivate/i);
    expect(en.ExpirePaymentLinkDescription).toMatch(/held for review/i);
    expect(ar.ExpirePaymentLinkDescription).toContain("{customer}");
    expect(ar.ExpirePaymentLinkDescription).toContain("{amount}");
  });
});
