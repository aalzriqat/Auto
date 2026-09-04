/**
 * SCRUM-237 — contract tests for the canonical receipt occurrence identity.
 *
 * §1–§7 are pure unit tests: the module under test touches no database and the
 * properties that matter are structural. The one property that genuinely cannot
 * be tested at runtime — that a legacy `transactions` id cannot reach a
 * constructor — is asserted at COMPILE time with `@ts-expect-error`, because a
 * runtime test could only observe the mistake after someone had already cast
 * their way past the type.
 *
 * §8–§9 are the evidence additions required by owner-proxy c17593 §8. §9 is
 * DB-backed against the real posting path, because the properties it pins —
 * that the forward, causal and reversal addresses are ONE fact, and that a
 * payload-version change cannot mint a second journal — are claims about what
 * actually lands in `accountingEvents`, and structural reasoning about the
 * helpers cannot establish them.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  directCollectionReceipt,
  paymentLinkReceipt,
  occurrenceIdempotencyKey,
  occurrenceReversalIdempotencyKey,
  occurrenceIndexRange,
  describeOccurrence,
  RECEIPT_PAYLOAD_VERSION,
} from "./accounting/receiptOccurrence";
import {
  postReceiptOccurrence,
  findPostedReceiptOccurrence,
  reverseReceiptOccurrence,
} from "./accounting/workflowHooks";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const ORG = "org_123" as unknown as Id<"organizations">;
const PAYMENT = "pay_abc" as unknown as Id<"collectionPayments">;
const INTENT = "int_xyz" as unknown as Id<"paymentIntents">;

describe("SCRUM-237 §1 — the identity map matches the owner-proxy ruling", () => {
  test("direct collection is COLLECTION_PAYMENT / collectionPayments / <paymentId>", () => {
    const id = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(id.eventType).toBe("COLLECTION_PAYMENT");
    expect(id.sourceType).toBe("collectionPayments");
    expect(id.sourceId).toBe("pay_abc");
    expect(id.eventVersion).toBe(1);
  });

  test("payment link is PAYMENT_LINK_RECEIVED / paymentIntents / <intentId>", () => {
    const id = paymentLinkReceipt({ orgId: ORG, intentId: INTENT });
    expect(id.eventType).toBe("PAYMENT_LINK_RECEIVED");
    expect(id.sourceType).toBe("paymentIntents");
    expect(id.sourceId).toBe("int_xyz");
  });

  test("payment link sources from the INTENT, never from the collectionPayments row", () => {
    // The payment-link mutation writes a `collectionPayments` row in the same
    // transaction as it books its economics. That row is operational lineage.
    // If this ever reads "collectionPayments", payment-link receipts have
    // acquired a second occurrence identity beside the one they already carry.
    const id = paymentLinkReceipt({ orgId: ORG, intentId: INTENT });
    expect(id.sourceType).not.toBe("collectionPayments");
  });
});

describe("SCRUM-237 §2 — the derived key is byte-identical to what production stores", () => {
  // This is the compatibility floor. The live producers write
  // `collection_payment_<paymentId>` (collections.ts:474) and
  // `payment_link_received_<intentId>` (the payment-link hook). If the
  // derivation drifts from these literals, every already-POSTED event stops
  // matching its own replay check in `postOrEnqueue` and would re-post.
  test("direct collection reproduces collection_payment_<paymentId> exactly", () => {
    const id = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(occurrenceIdempotencyKey(id)).toBe("collection_payment_pay_abc");
  });

  test("payment link reproduces payment_link_received_<intentId> exactly", () => {
    const id = paymentLinkReceipt({ orgId: ORG, intentId: INTENT });
    expect(occurrenceIdempotencyKey(id)).toBe("payment_link_received_int_xyz");
  });
});

describe("SCRUM-237 §3 — a repeat occurrence is a DIFFERENT key", () => {
  // The trap this closes: the stored key format contains no eventVersion, so a
  // second economic occurrence against one source would carry the first one's
  // key, and `postOrEnqueue`'s POSTED short-circuit would return without
  // posting — a receipt in the subledger and nothing in the ledger.
  test("occurrence 2 does not collide with occurrence 1", () => {
    const first = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    const second = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence: 2 });
    expect(occurrenceIdempotencyKey(second)).not.toBe(occurrenceIdempotencyKey(first));
    expect(occurrenceIdempotencyKey(second)).toBe("collection_payment_pay_abc_occ2");
  });

  test("occurrence 1 is spelled the legacy way, so existing rows still match", () => {
    const explicit = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence: 1 });
    const implicit = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(occurrenceIdempotencyKey(explicit)).toBe(occurrenceIdempotencyKey(implicit));
    expect(occurrenceIdempotencyKey(explicit)).not.toContain("_occ");
  });

  test("the key mapping is INJECTIVE across the versions the type permits", () => {
    // c17593 §3 requires injectivity over every representable eventVersion, not
    // just over the two the live channels happen to use today. Supporting
    // eventVersion > 1 in the type while deriving a key that ignored it is the
    // exact trap being closed, so sweep a range rather than spot-checking v2.
    const keys = new Set<string>();
    for (let occurrence = 1; occurrence <= 25; occurrence++) {
      keys.add(occurrenceIdempotencyKey(directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence })));
    }
    expect(keys.size).toBe(25);
  });
});

describe("SCRUM-237 §4 — one identity addresses one indexed range", () => {
  test("the range is exactly the by_org_event_source_version columns", () => {
    const id = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(occurrenceIndexRange(id)).toEqual({
      index: "by_org_event_source_version",
      orgId: ORG,
      eventType: "COLLECTION_PAYMENT",
      sourceType: "collectionPayments",
      sourceId: "pay_abc",
      eventVersion: 1,
    });
  });

  test("two channels never address the same range", () => {
    const a = occurrenceIndexRange(directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT }));
    const b = occurrenceIndexRange(paymentLinkReceipt({ orgId: ORG, intentId: INTENT }));
    expect(a).not.toEqual(b);
  });
});

describe("SCRUM-237 §5 — payload version is NOT the economic discriminator", () => {
  test("payload version is a separate constant and never lands in eventVersion", () => {
    const id = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    // Setting eventVersion to 2 to mean "v2 payload" would declare a SECOND
    // economic receipt against the same source and post the ledger twice.
    expect(id.eventVersion).toBe(1);
    expect(RECEIPT_PAYLOAD_VERSION).toBe(2);
    expect(id.eventVersion).not.toBe(RECEIPT_PAYLOAD_VERSION);
  });

  test("payload version does not appear in the derived key at all", () => {
    // c17593 §3: letting the payload version into the key would mint a SECOND
    // idempotency key — and therefore a second journal — for one economic
    // receipt. The key must be blind to it.
    const id = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(occurrenceIdempotencyKey(id)).not.toContain(String(RECEIPT_PAYLOAD_VERSION));
    expect(occurrenceIdempotencyKey(id)).toBe("collection_payment_pay_abc");
  });
});

describe("SCRUM-237 §6 — NEGATIVE CONTROLS: what cannot mint a receipt identity", () => {
  test("a legacy transactions id is a COMPILE error, not a runtime check", () => {
    const legacyRow = "tx_legacy_1" as unknown as Id<"transactions">;
    // @ts-expect-error a transactions row carries no receipt identity and
    // cannot be given one — this is the enforcement, and if this line ever
    // stops erroring the contract has been weakened.
    directCollectionReceipt({ orgId: ORG, paymentId: legacyRow });
    expect(legacyRow).toBeDefined();
  });

  test("a deposit id is a COMPILE error too — deposits are the negative control", () => {
    const deposit = "dep_1" as unknown as Id<"deposits">;
    // @ts-expect-error deposits are sourced from `deposits` and are not a
    // receipt occurrence family. If this compiles, a deposit has become
    // constructible as a receipt and the change is wrong.
    paymentLinkReceipt({ orgId: ORG, intentId: deposit });
    expect(deposit).toBeDefined();
  });

  test("the identity cannot be assembled from an object literal", () => {
    // @ts-expect-error the brand is unproducible by callers, so the only way to
    // obtain an identity is a channel constructor. Any `as` cast onto this type
    // in production code is a defect.
    const forged: ReturnType<typeof directCollectionReceipt> = {
      orgId: ORG,
      eventType: "COLLECTION_PAYMENT",
      sourceType: "collectionPayments",
      sourceId: "forged",
      eventVersion: 1,
      channel: "DIRECT_COLLECTION",
    };
    expect(forged.sourceId).toBe("forged");
  });
});

describe("SCRUM-237 §7 — the description is one-way", () => {
  test("describeOccurrence carries every addressing field", () => {
    const id = paymentLinkReceipt({ orgId: ORG, intentId: INTENT, occurrence: 3 });
    expect(describeOccurrence(id)).toBe("PAYMENT_LINK_RECEIVED/paymentIntents/int_xyz@v3");
  });
});

describe("SCRUM-237 §8 — c17593 evidence: legacy tokens and channel confusion", () => {
  test("EV4 — a retagged legacy transactions key cannot influence the derived key", () => {
    // The SCRUM-223 certification finding, carried into this contract as a
    // negative rule (c17593 §4): a row retagged to COLLECTION_PAYMENT through
    // `transactions.update` keeps the idempotencyKey it was born with, inherited
    // from an unrelated original category. That is a plausible-looking token
    // that correlates to NOTHING — worse than an absence, because an absence is
    // detectable and a false positive is not.
    //
    // The enforcement is structural: there is no parameter on any function in
    // the module through which such a token could arrive. The derived key is a
    // function of the identity alone, so a legacy token sitting in the database
    // cannot reach it.
    const id = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    const derived = occurrenceIdempotencyKey(id);

    // A token that LOOKS exactly like a valid collection key, but was inherited
    // by a retagged expense row. It has nowhere to go.
    const plausibleInheritedToken = "collection_payment_pay_SOMETHING_ELSE";
    expect(derived).not.toBe(plausibleInheritedToken);
    expect(occurrenceIdempotencyKey(id)).toBe(derived); // stable, input-free
  });

  test("EV5 — the payment-link downstream collectionPayments row cannot change its identity", () => {
    // The payment-link mutation writes a `collectionPayments` row in the same
    // transaction. If a producer reconstructed the tuple from that row instead
    // of calling the channel constructor, the receipt would acquire a second
    // identity. The intent-sourced identity must be unaffected by the existence
    // of any such row — and the two addresses must not coincide even when the
    // raw ids collide.
    const viaIntent = paymentLinkReceipt({ orgId: ORG, intentId: INTENT });
    const collidingRawId = "int_xyz" as unknown as Id<"collectionPayments">;
    const viaRow = directCollectionReceipt({ orgId: ORG, paymentId: collidingRawId });

    expect(viaIntent.sourceType).toBe("paymentIntents");
    expect(viaRow.sourceType).toBe("collectionPayments");
    expect(occurrenceIdempotencyKey(viaIntent)).not.toBe(occurrenceIdempotencyKey(viaRow));
    expect(occurrenceIndexRange(viaIntent)).not.toEqual(occurrenceIndexRange(viaRow));
  });

  test("EV3 — there is no parameter through which a caller can supply a key", () => {
    // c17593 §3: the key "may never be caller-supplied independently for a v2
    // receipt occurrence". Structurally there is no such argument to pass, so
    // the runtime-observable form of this property is that the key is a pure
    // function of the identity: same identity in, same key out, always.
    const a = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    const b = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(occurrenceIdempotencyKey(a)).toBe(occurrenceIdempotencyKey(b));
    expect(occurrenceReversalIdempotencyKey(a)).toBe(occurrenceReversalIdempotencyKey(b));
    // And the reversal key is derived from the SAME base, so a reversal can
    // never be pointed at a different occurrence than its forward post.
    expect(occurrenceReversalIdempotencyKey(a)).toBe(`${occurrenceIdempotencyKey(a)}_reversal`);
  });
});

/* -------------------------------------------------------------------------- *
 * §9 — DB-backed evidence (c17593 §8 items 6, 7, 8)
 *
 * These run the REAL posting path. The claims are about what lands in
 * `accountingEvents` and what a later lookup can find, which structural
 * reasoning about the helpers cannot establish.
 * -------------------------------------------------------------------------- */

/**
 * Inserts one COMPLETED collection-payment row and returns its id, typed.
 *
 * `t.run` with an untyped callback returns `unknown`, and an `unknown` flowing
 * into `directCollectionReceipt` would defeat the very compile-time control
 * §6 asserts — the constructor would accept it. Narrowing here keeps the
 * source-family type live at every call site in this file.
 */
async function seedCollectionPayment(
  t: any,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  userId: Id<"users">
): Promise<Id<"collectionPayments">> {
  return (await t.run((ctx: any) =>
    ctx.db.insert("collectionPayments", {
      orgId, customerId, direction: "IN", method: "CASH",
      amount: 5000, paymentDate: Date.now(), status: "POSTED", cashierId: userId,
      createdAt: Date.now(),
    })
  )) as Id<"collectionPayments">;
}

async function seedPostableOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Receipt ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `ro_${suffix}`, email: `${suffix}@ro.com`, name: "Owner" })
  )) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"],
    })
  );
  const asAdmin = t.withIdentity({ subject: `ro_${suffix}`, clerkId: `ro_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });

  const year = new Date().getUTCFullYear();
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
  await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;
  return { t, orgId, userId, customerId };
}

function receiptPayload(paymentId: string, customerId: string, amountMinor: number) {
  return { paymentId, customerId, amountMinor, currency: "USD", paymentMethod: "CASH" };
}

async function eventsFor(t: any, orgId: any) {
  return await t.run(async (ctx: any) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect()
  );
}

describe("SCRUM-237 §9 — the forward, causal and reversal addresses are ONE fact", () => {
  test("EV6 — what is persisted matches the identity field-for-field, and the causal lookup finds it", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev6");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx: any) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });

    const events = await eventsFor(t, orgId);
    expect(events).toHaveLength(1);
    const persisted = events[0];

    // Field-for-field: every economic addressing field, plus the key. If any
    // one of these is assembled separately at some call site, this is where the
    // drift becomes visible.
    expect(persisted.eventType).toBe(identity.eventType);
    expect(persisted.sourceType).toBe(identity.sourceType);
    expect(persisted.sourceId).toBe(identity.sourceId);
    expect(persisted.eventVersion).toBe(identity.eventVersion);
    expect(persisted.idempotencyKey).toBe(occurrenceIdempotencyKey(identity));
    expect(persisted.status).toBe("POSTED");

    // And the causal lookup addressed by the SAME identity returns that row.
    const found = await t.run(async (ctx: any) => findPostedReceiptOccurrence(ctx, identity));
    expect(found?._id).toBe(persisted._id);
  });

  test("EV7 — a lookup whose identity differs in one economic field MISSES, with no key-only fallback", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev7");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });
    await t.run(async (ctx: any) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });

    // Present under its own identity.
    expect(await t.run(async (ctx: any) => findPostedReceiptOccurrence(ctx, identity))).not.toBeNull();

    // eventVersion differs -> MISS. This is the field a key-only match would
    // ignore: `collection_payment_<id>` is a prefix of the v2 key's base, so a
    // lookup that fell back to the key could plausibly return the v1 row.
    const otherOccurrence = directCollectionReceipt({ orgId, paymentId, occurrence: 2 });
    expect(await t.run(async (ctx: any) => findPostedReceiptOccurrence(ctx, otherOccurrence))).toBeNull();

    // eventType + sourceType differ (a payment-link identity carrying the SAME
    // raw id) -> MISS. Nothing about the shared id may make these match.
    const crossChannel = paymentLinkReceipt({
      orgId,
      intentId: paymentId as unknown as Id<"paymentIntents">,
    });
    expect(await t.run(async (ctx: any) => findPostedReceiptOccurrence(ctx, crossChannel))).toBeNull();

    // sourceId differs -> MISS.
    const otherPaymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const otherSource = directCollectionReceipt({ orgId, paymentId: otherPaymentId });
    expect(await t.run(async (ctx: any) => findPostedReceiptOccurrence(ctx, otherSource))).toBeNull();
  });

  test("EV8 — a v1 and a v2 payload for ONE occurrence cannot both post", async () => {
    // The catastrophic case c17593 §2 names: same economic tuple, different
    // payload version. They must COLLIDE on one occurrence rather than becoming
    // two keys and two journals. Posting twice with materially different
    // payloads must leave exactly ONE event and ONE journal.
    //
    // ⚠️ SCOPE, precisely. c17593 §2 requires two things of this case: that the
    // two commands COLLIDE on one occurrence, and that the second then FAIL
    // SEMANTIC REPLAY because the payload/authority contradicts. This test pins
    // the FIRST only. The second is not implemented and cannot be yet: refusing
    // requires comparing the incoming payload version against the one stored on
    // the occurrence, and nothing persists `receiptPayloadVersion` until
    // SCRUM-218-C. Today the second command is silently ABSORBED by
    // `postOrEnqueue`'s POSTED short-circuit — no second journal, but also no
    // refusal. Collision is the precondition for refusal, so this is the half
    // that had to land first; do not read it as the whole requirement.
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev8");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    // v1-shaped gross payload.
    await t.run(async (ctx: any) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    // v2-shaped payload for the SAME economic occurrence, carrying a DIFFERENT
    // amount. If the payload version could reach the key, this would mint a
    // second occurrence and the ledger would carry both.
    await t.run(async (ctx: any) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: { ...receiptPayload(paymentId, customerId, 9999), receiptPayloadVersion: RECEIPT_PAYLOAD_VERSION },
      });
    });

    const events = await eventsFor(t, orgId);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe(occurrenceIdempotencyKey(identity));

    const journals = await t.run(async (ctx: any) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect()
    );
    expect(journals).toHaveLength(1);
  });

  test("EV6b — the reversal addresses the same occurrence the forward post created", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev6b");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });
    await t.run(async (ctx: any) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });

    const outcome = await t.run(async (ctx: any) =>
      reverseReceiptOccurrence(ctx, {
        identity, reason: "SCRUM-237 contract test", actorId: userId, reversalDate: Date.now(),
      })
    );
    expect(outcome).toBe("REVERSED");

    // The causal check must now refuse it: REVERSED is not POSTED, and c17593
    // §7 makes POSTED the only eligible status.
    const found = await t.run(async (ctx: any) => findPostedReceiptOccurrence(ctx, identity));
    expect(found).toBeNull();
  });
});
