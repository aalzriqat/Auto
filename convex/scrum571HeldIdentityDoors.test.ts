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

// `tag` makes a second, fully independent org/user in the same harness.
async function seed(t: Harness, tag = "") {
  const clerkId = `d14_user${tag}`;
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `D14 Dealer${tag}`, createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId, email: `u${tag}@example.com`, name: `Finance User${tag}` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance", "approve:requests"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  const asFinance = t.withIdentity({ subject: clerkId, clerkId });
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

// D-20: payment links are shut, so the public `create` door always refuses
// (PAYMENT_LINKS_DISABLED) before it reads the provider reference. `createLink`
// calls the real door to prove that; `newLink` seeds a PENDING intent directly
// for the tests that exercise the webhook and quarantine behaviour.
const createLink = (w: World, over: Record<string, unknown> = {}) =>
  w.asFinance.mutation(api.paymentIntents.create, createArgs(w, over) as never);

const newLink = (w: World, over: Record<string, unknown> = {}): Promise<Id<"paymentIntents">> => {
  const { idempotencyKey, ...rest } = createArgs(w, over) as Record<string, unknown>;
  return w.t.run((ctx) =>
    ctx.db.insert("paymentIntents", {
      ...rest,
      createdBy: w.userId,
      status: "PENDING",
      idempotencyKey: idempotencyKey as string,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never)
  ) as Promise<Id<"paymentIntents">>;
};

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

// New link, then verified captures while the org is suspended (each is held as
// LIFECYCLE_REFUSED), then the org is reactivated. Returns the PENDING intent.
async function holdViaSuspension(w: World, ...laterCaptures: Record<string, unknown>[]) {
  const intentId = await newLink(w);
  await setSuspended(w, true);
  await capture(w);
  for (const over of laterCaptures) await capture(w, over);
  await setSuspended(w, false);
  return intentId;
}

const STATES: HeldState[] = [
  {
    name: "(i) OPEN LIFECYCLE_REFUSED row, no conflict",
    seed: async (w) => {
      const intentId = await holdViaSuspension(w);
      const [row] = await heldRows(w);
      expect(row).toMatchObject({ reason: "LIFECYCLE_REFUSED", reviewStatus: "OPEN", amountConflict: false });
      expect((await doc(w, intentId))?.status).toBe("PENDING");
      return intentId;
    },
  },
  {
    name: "(ii) OPEN row with amountConflict",
    seed: async (w) => {
      const intentId = await holdViaSuspension(w, { providerEventId: "evt_2", amountMinor: 250_000 });
      const [row] = await heldRows(w);
      expect(row).toMatchObject({ reviewStatus: "OPEN", amountConflict: true });
      return intentId;
    },
  },
  {
    name: "(iii) RESOLVED row",
    seed: async (w) => {
      const intentId = await holdViaSuspension(w);
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
  // D-20: the shutdown refuses create before the quarantine lookup, so the
  // PROVIDER_REFERENCE_UNAVAILABLE refusal is dormant; create still inserts nothing.
  test("create is refused (PAYMENT_LINKS_DISABLED) and inserts no intent", async () => {
    const w = await makeWorld();
    await state.seed(w);
    const before = await economicCounts(w.t);
    const out = await refusal(createLink(w, { externalId: EXT, idempotencyKey: "create-key-1" }));
    expect(out.code).toBe("PAYMENT_LINKS_DISABLED");
    expect(await economicCounts(w.t)).toEqual(before);
  });

  test("create with a differently-cased provider and padded id is refused the same way", async () => {
    const w = await makeWorld();
    await state.seed(w);
    const out = await refusal(createLink(w, { provider: " TAP ", externalId: `  ${EXT}  ` }));
    expect(out.code).toBe("PAYMENT_LINKS_DISABLED");
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

  // D-20: markSettled is shut before the quarantine check; both the first call
  // and a retry of the same key are refused and record nothing.
  test("markSettled with externalId supplied is refused (PAYMENT_LINKS_DISABLED), and a retry of the same key still refuses", async () => {
    const w = await makeWorld();
    let intentId = await state.seed(w);
    // (iv): no intent can carry the reference; settle an intent that has none.
    if (!intentId) {
      intentId = await newLink(w, { externalId: undefined });
    }
    const before = await economicCounts(w.t);
    const key = `settle-key-${state.name}`;

    const first = await refusal(settle(w, intentId, { externalId: EXT, idempotencyKey: key }));
    expect(first.code).toBe("PAYMENT_LINKS_DISABLED");
    const retry = await refusal(settle(w, intentId, { externalId: EXT, idempotencyKey: key }));
    expect(retry.code).toBe("PAYMENT_LINKS_DISABLED");

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
    expect(out.code).toBe("PAYMENT_LINKS_DISABLED"); // D-20: shut before the quarantine check
    expect(await economicCounts(w.t)).toEqual(before);
  });
});

describe("SCRUM-571 D-14 — cross-door and cross-tenant", () => {
  test("a different org creating with a no-org held reference gets the same refusal", async () => {
    const w = await makeWorld();
    await STATES[3].seed(w);

    const other: World = { t: w.t, ...(await seed(w.t, "_other")) };
    const mine = await refusal(createLink(w));
    const theirs = await refusal(createLink(other));
    // D-20: the shutdown refuses identically for every org, so a held reference
    // belonging to nobody (or to another tenant) is still not disclosed.
    expect(mine.code).toBe("PAYMENT_LINKS_DISABLED");
    expect(theirs).toEqual(mine);
  });

  test("D-20: B (no externalId) settled with A's externalId is refused by the shutdown, and neither intent moves", async () => {
    const w = await makeWorld();
    const a = await newLink(w, { externalId: "ext-A-owner" });
    const b = await newLink(w, { externalId: undefined });
    const before = await economicCounts(w.t);
    const out = await refusal(settle(w, b, { externalId: "ext-A-owner" }));
    expect(out.code).toBe("PAYMENT_LINKS_DISABLED");
    expect(await economicCounts(w.t)).toEqual(before);
    expect((await doc(w, a))?.status).toBe("PENDING");
    expect((await doc(w, b))?.status).toBe("PENDING");
  });
});

describe("SCRUM-571 D-14 — controls", () => {
  // D-20: no identity settles at either door while the pilot is shut. A clean
  // identity's capture is held (PAYMENT_LINKS_DISABLED) and markSettled refuses.
  test("a clean identity no longer settles at either door; the capture is held and nothing settles", async () => {
    const w = await makeWorld();
    const viaWebhook = await newLink(w, { externalId: "ext-clean-1", amountMinor: 100_000 });
    const held = await capture(w, { externalId: "ext-clean-1" });
    expect(held).toMatchObject({ kind: "HELD" });
    expect((await doc(w, viaWebhook))?.status).toBe("PENDING");

    const viaStaff = await newLink(w, { externalId: "ext-clean-2", amountMinor: 100_000 });
    expect((await refusal(settle(w, viaStaff))).code).toBe("PAYMENT_LINKS_DISABLED");
    expect((await doc(w, viaStaff))?.status).toBe("PENDING");
    const rows = await heldRows(w);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("PAYMENT_LINKS_DISABLED");
  });

  test("a held row for a DIFFERENT externalId does not merge with another identity's capture", async () => {
    const w = await makeWorld();
    await capture(w, { externalId: "ext-someone-else" });
    expect(await heldRows(w)).toHaveLength(1);

    const a = await newLink(w, { externalId: "ext-free-1" });
    expect(await capture(w, { externalId: "ext-free-1" })).toMatchObject({ kind: "HELD" });
    expect((await doc(w, a))?.status).toBe("PENDING");
    // Two identities, two rows: the held row is keyed per (provider, externalId).
    expect(await heldRows(w)).toHaveLength(2);
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
