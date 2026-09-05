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
  assertChannelPrefixesUnambiguous,
  RECEIPT_PAYLOAD_VERSION,
} from "./accounting/receiptOccurrence";
import {
  postReceiptOccurrence,
  findPostedReceiptOccurrence,
  reverseReceiptOccurrence,
} from "./accounting/workflowHooks";
import { reverseAccountingEvent } from "./accounting/reversals";

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
  // This is the compatibility floor. The live ACCOUNTING producers write
  // `collection_payment_<paymentId>` — `makeCollectionHook`, instantiated as
  // `hookCollectionPayment` (workflowHooks.ts), called from `recordPayment` and
  // `clearCheque` (collections.ts) — and `payment_link_received_<intentId>`
  // from `hookPaymentLinkReceived`. NOT `mirrorCollectionPaymentToCanonical`:
  // that builds an identically-spelled key for a `canonicalPayments` row, a
  // different table and a different job. If the derivation drifts from these
  // literals, every already-POSTED event stops matching its own replay check in
  // `postOrEnqueue` and would re-post.
  //
  // Cited by symbol, not line number: the previous revision's numbers went stale
  // within one commit when an earlier fix shifted the file by +20 lines.
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
    // Disjoint namespace + length-prefixed fields. "collection_payment" is 18
    // characters, "pay_abc" is 7.
    expect(occurrenceIdempotencyKey(second)).toBe("occv2:18:collection_payment:7:pay_abc");
  });

  test("occurrence 1 is spelled the legacy way, so existing rows still match", () => {
    const explicit = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence: 1 });
    const implicit = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT });
    expect(occurrenceIdempotencyKey(explicit)).toBe(occurrenceIdempotencyKey(implicit));
    expect(occurrenceIdempotencyKey(explicit)).not.toContain("occv");
  });

  test("REGRESSION — a sourceId carrying the repeat delimiter cannot collide", () => {
    // The exact counterexample that falsified the previous `${base}_occ${v}`
    // derivation, produced independently by two reviewers. Under the old form
    // BOTH of these were "collection_payment_X_occ2":
    //
    //   sourceId "X_occ2" at v1   vs   sourceId "X" at v2
    //
    // Two distinct economic tuples sharing one key, and because postOrEnqueue
    // short-circuits on a POSTED row found BY THAT KEY before postAccountingEvent
    // ever compares the tuple, the second receipt is absorbed silently — in the
    // subledger, absent from the ledger.
    const looksLikeARepeat = directCollectionReceipt({
      orgId: ORG,
      paymentId: "X_occ2" as unknown as Id<"collectionPayments">,
    });
    const genuineRepeat = directCollectionReceipt({
      orgId: ORG,
      paymentId: "X" as unknown as Id<"collectionPayments">,
      occurrence: 2,
    });
    expect(looksLikeARepeat.sourceId).not.toBe(genuineRepeat.sourceId);
    expect(occurrenceIdempotencyKey(looksLikeARepeat)).not.toBe(
      occurrenceIdempotencyKey(genuineRepeat)
    );
  });

  test("the key mapping is INJECTIVE over sourceId AND eventVersion together", () => {
    // The previous version of this test swept eventVersion for ONE fixed
    // sourceId, which is exactly why it did not catch the collision above: the
    // counterexample lives in the two-dimensional space. Sweep both axes, and
    // include delimiter-heavy ids deliberately chosen to collide under the old
    // derivation.
    const sourceIds = ["X", "X_occ2", "X_occ", "a:b", "12:X", "", "occv2:1:a:1:b"];
    const keys = new Set<string>();
    let pairs = 0;
    for (const raw of sourceIds) {
      for (let occurrence = 1; occurrence <= 12; occurrence++) {
        keys.add(
          occurrenceIdempotencyKey(
            directCollectionReceipt({
              orgId: ORG,
              paymentId: raw as unknown as Id<"collectionPayments">,
              occurrence,
            })
          )
        );
        pairs++;
      }
    }
    expect(keys.size).toBe(pairs);
  });

  test("a non-positive or non-integer occurrence is REFUSED at construction", () => {
    // eventVersion is typed `number`, which admits all of these. Each would
    // otherwise become part of a stored key (`_occNaN`, `_occ0`) and reach the
    // ledger as a nonsense economic discriminator.
    for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence: bad })
      ).toThrow(/safe integer/);
    }
    // The valid boundary still constructs.
    expect(() =>
      directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence: 1 })
    ).not.toThrow();
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
    // ⚠️ WHAT THIS TEST IS AND IS NOT — flagged by the Sonnet seat at acfd58429,
    // and the criticism is correct. The assertions below construct no
    // `transactions` row, retag nothing, and pass no legacy token anywhere.
    // They would hold for ANY deterministic string function, so they are
    // ILLUSTRATIVE OF THE RULE, NOT EVIDENCE FOR IT. Left in place because the
    // rule is worth stating at the point a reader looks for it, but it must not
    // be counted as coverage.
    //
    // The property is enforced STRUCTURALLY, and is visible from the signature
    // alone: `occurrenceIdempotencyKey` and `occurrenceReversalIdempotencyKey`
    // take one argument and no `ctx`/database handle, so a legacy token sitting
    // in a row is not merely unused — it is unreachable. What actually holds
    // that line is EV3's two `@ts-expect-error` excess-argument controls, which
    // fail with ts(2578) the day a second parameter of any kind is admitted,
    // plus the §6 compile-time negative controls on the constructors.
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

    // Runtime determinism is necessary but NOT sufficient, as the Codex seat
    // pointed out: it would still pass if someone added an optional
    // caller-supplied key parameter and simply never passed it here. The real
    // guard is a COMPILE error. An unused @ts-expect-error is ts(2578), so these
    // fail loudly the day a second parameter appears.
    // @ts-expect-error a second argument must not exist on the forward key
    occurrenceIdempotencyKey(a, "caller-supplied-key");
    // @ts-expect-error a second argument must not exist on the reversal key
    occurrenceReversalIdempotencyKey(a, "caller-supplied-key");

    // The reversal key tracks the SAME identity as its forward post — change any
    // identity field and it moves — while living in a namespace disjoint from
    // every forward key, so it can never BE one.
    //
    // This previously asserted the literal shape `${forwardKey}_reversal`, which
    // is an assertion about the patch rather than the property: it passed
    // against the very encoding that made a reversal key collide with another
    // occurrence's forward key.
    const other = directCollectionReceipt({ orgId: ORG, paymentId: PAYMENT, occurrence: 2 });
    expect(occurrenceReversalIdempotencyKey(a)).not.toBe(occurrenceReversalIdempotencyKey(other));
    expect(occurrenceReversalIdempotencyKey(a)).not.toBe(occurrenceIdempotencyKey(a));
    expect(occurrenceReversalIdempotencyKey(a)).not.toBe(occurrenceIdempotencyKey(other));
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
  t: TestHarness,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  userId: Id<"users">
): Promise<Id<"collectionPayments">> {
  return (await t.run((ctx) =>
    ctx.db.insert("collectionPayments", {
      orgId, customerId, direction: "IN", method: "CASH",
      amount: 5000, paymentDate: Date.now(), status: "POSTED", cashierId: userId,
      createdAt: Date.now(),
    })
  )) as Id<"collectionPayments">;
}

async function seedPostableOrg(suffix: string, openPeriod = true) {
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
  if (openPeriod) {
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;
  return { t, orgId, userId, customerId };
}

function receiptPayload(paymentId: string, customerId: string, amountMinor: number) {
  return { paymentId, customerId, amountMinor, currency: "USD", paymentMethod: "CASH" };
}

// Pinned to `typeof schema`. The bare `ReturnType<typeof convexTestWithComponents>`
// drops the Schema generic, which collapses ctx.db to the system data model and
// makes `withIndex("by_org", ...)` a type error — the reason a helper like this
// is usually written with `t: any`, which then erases the row types too.
type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

async function eventsFor(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

describe("SCRUM-237 §9 — the forward, causal and reversal addresses are ONE fact", () => {
  test("EV6 — what is persisted matches the identity field-for-field, and the causal lookup finds it", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev6");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
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
    const found = await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity));
    expect(found?._id).toBe(persisted._id);
  });

  test("EV7 — a lookup whose identity differs in one economic field MISSES, with no key-only fallback", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev7");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });

    // Present under its own identity.
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity))).not.toBeNull();

    // eventVersion differs -> MISS. This is the field a key-only match would
    // ignore: `collection_payment_<id>` is a prefix of the v2 key's base, so a
    // lookup that fell back to the key could plausibly return the v1 row.
    const otherOccurrence = directCollectionReceipt({ orgId, paymentId, occurrence: 2 });
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, otherOccurrence))).toBeNull();

    // eventType + sourceType differ (a payment-link identity carrying the SAME
    // raw id) -> MISS. Nothing about the shared id may make these match.
    const crossChannel = paymentLinkReceipt({
      orgId,
      intentId: paymentId as unknown as Id<"paymentIntents">,
    });
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, crossChannel))).toBeNull();

    // sourceId differs -> MISS.
    const otherPaymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const otherSource = directCollectionReceipt({ orgId, paymentId: otherPaymentId });
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, otherSource))).toBeNull();
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
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    // v2-shaped payload for the SAME economic occurrence, carrying a DIFFERENT
    // amount. If the payload version could reach the key, this would mint a
    // second occurrence and the ledger would carry both.
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: { ...receiptPayload(paymentId, customerId, 9999), receiptPayloadVersion: RECEIPT_PAYLOAD_VERSION },
      });
    });

    const events = await eventsFor(t, orgId);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe(occurrenceIdempotencyKey(identity));

    const journals = await t.run(async (ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(journals).toHaveLength(1);
  });

  test("EV6b — the reversal addresses the same occurrence the forward post created", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev6b");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });

    const outcome = await t.run(async (ctx) =>
      reverseReceiptOccurrence(ctx, {
        identity, reason: "SCRUM-237 contract test", actorId: userId, reversalDate: Date.now(),
      })
    );
    expect(outcome).toBe("REVERSED");

    // The causal check must now refuse it: REVERSED is not POSTED, and c17593
    // §7 makes POSTED the only eligible status.
    const found = await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity));
    expect(found).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * §10 — the gaps two independent reviewers found in §9
 *
 * §9 covered exactly one of `ReversalOutcome`'s three values, and every
 * DB-backed post used the default v1 identity. Both omissions let a real
 * mutation survive the whole suite. Each test below was written against a
 * specific surviving mutant and must fail when that mutant is applied.
 * -------------------------------------------------------------------------- */

describe("SCRUM-237 §10 — occurrence and reversal branches the first suite missed", () => {
  test("EV9 — occurrences 1 and 2 post as TWO separate events (kills a hardcoded eventVersion)", async () => {
    // SURVIVING MUTANT THIS KILLS: `eventVersion: 1` hardcoded in
    // postReceiptOccurrence instead of `id.eventVersion`. Every §9 post used the
    // default v1 identity, so the forward path could ignore the identity's
    // version entirely and all 23 tests still passed — the facade reconstructing
    // the tuple independently, which is the exact defect this contract exists to
    // make impossible.
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev9");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);

    const first = directCollectionReceipt({ orgId, paymentId });
    const second = directCollectionReceipt({ orgId, paymentId, occurrence: 2 });

    for (const identity of [first, second]) {
      await t.run(async (ctx) => {
        await postReceiptOccurrence(ctx, {
          identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
          payload: receiptPayload(paymentId, customerId, 5000),
        });
      });
    }

    const events = await eventsFor(t, orgId);
    expect(events).toHaveLength(2);
    expect([...events.map((e) => e.eventVersion)].sort()).toEqual([1, 2]);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(2);

    // And each is independently addressable by its own identity.
    const foundFirst = await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, first));
    const foundSecond = await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, second));
    expect(foundFirst?.eventVersion).toBe(1);
    expect(foundSecond?.eventVersion).toBe(2);
    expect(foundFirst?._id).not.toBe(foundSecond?._id);
  });

  test("EV10 — NOT_POSTED cancels the queued forward entry the SAME identity enqueued", async () => {
    // SURVIVING MUTANT THIS KILLS: passing anything other than
    // occurrenceIdempotencyKey(id) as pendingPostIdempotencyKey. On a mismatch
    // cancelPendingPostByKey cancels nothing and an unposted forward entry
    // survives behind a NOT_POSTED result — the caller is told no money moved
    // while a post is still queued to move it.
    //
    // No open period, so the forward post enqueues instead of posting.
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev10", false);
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });

    const pendingRows = async () =>
      await t.run(async (ctx) =>
        ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
          .collect()
      );

    const queuedBefore = await pendingRows();
    expect(queuedBefore).toHaveLength(1);
    // The queued entry is addressed by the DERIVED key — this is the fact the
    // reversal below must be able to rediscover from the identity alone.
    expect(queuedBefore[0].idempotencyKey).toBe(occurrenceIdempotencyKey(identity));
    expect(await eventsFor(t, orgId)).toHaveLength(0);

    const outcome = await t.run(async (ctx) =>
      reverseReceiptOccurrence(ctx, {
        identity, reason: "SCRUM-237 §10", actorId: userId, reversalDate: Date.now(),
      })
    );
    expect(outcome).toBe("NOT_POSTED");

    // Nothing may still be queued to post. If the reversal had been handed any
    // key other than the one the forward post enqueued, this row survives and
    // the caller has been told NOT_POSTED while a post is still pending.
    expect(await pendingRows()).toHaveLength(0);
  });

  test("EV11 — DEFERRED leaves the original POSTED until the outbox drains", async () => {
    // The third ReversalOutcome. DEFERRED and REVERSED must not be collapsed:
    // the original entry is STILL POSTED when a reversal defers, and anything
    // treating the amount as recovered before the outbox drains is spending
    // money the ledger still shows as spent.
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev11");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity))).not.toBeNull();

    // A reversal dated into a year with no open period.
    const outsideOpenPeriod = Date.UTC(new Date().getUTCFullYear() - 3, 5, 1);
    const outcome = await t.run(async (ctx) =>
      reverseReceiptOccurrence(ctx, {
        identity, reason: "SCRUM-237 §10", actorId: userId, reversalDate: outsideOpenPeriod,
      })
    );
    expect(outcome).toBe("DEFERRED");

    // Still POSTED — the defining property of DEFERRED.
    const stillPosted = await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity));
    expect(stillPosted).not.toBeNull();
    expect(stillPosted?.status).toBe("POSTED");
  });

  test("EV12 — an ambiguous exact tuple REFUSES rather than choosing a favourable row", async () => {
    // Convex has no unique indexes, so nothing in the schema stops two rows
    // sharing one exact economic tuple. The earlier lookup filtered to POSTED
    // and took .first(), which would report a live occurrence from a corrupt
    // POSTED/REVERSED pair — choosing the favourable row and hiding the
    // corruption, while postAccountingEvent reads the same tuple with .unique()
    // and fails closed. A causal check laxer than the writer it guards is worse
    // than no check.
    const { t, orgId, userId, customerId } = await seedPostableOrg("ev12");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    const [original] = await eventsFor(t, orgId);
    expect(original.status).toBe("POSTED");

    // Forge the corruption: a second row on the identical economic tuple.
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = original;
      await ctx.db.insert("accountingEvents", { ...rest, status: "REVERSED" });
    });

    await expect(
      t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity))
    ).rejects.toThrow(/ambiguous receipt occurrence/);
  });
});

describe("SCRUM-237 §11 — the key mapping must be injective over ROLE, not only version", () => {
  // Found by the Codex seat at 45dd608b0, reproduced here before fixing.
  //
  // §3 closed the VERSION axis by replacing an unframed `_occ${v}` suffix with a
  // length-prefixed disjoint namespace. The ROLE axis kept exactly the defect
  // that was just removed: the reversal key was `${forwardKey}_reversal`, an
  // unframed suffix, so a sourceId ending in `_reversal` re-creates the same
  // collision one axis over.
  //
  // Reachability is honest: a real Convex id cannot contain `_reversal`, so this
  // is not reachable through today's producers. It is fixed because the contract
  // ASSERTS injectivity for arbitrary `sourceId` — and a sibling elsewhere in the
  // codebase already builds a composite sourceId (`${vehicleId}_${editToken}`),
  // so the assumption that source ids are opaque Convex ids is not one this
  // module is entitled to make.

  test("R1 — a reversal key cannot equal the FORWARD key of a different occurrence", () => {
    const a = directCollectionReceipt({
      orgId: ORG,
      paymentId: "X" as unknown as Id<"collectionPayments">,
    });
    const b = directCollectionReceipt({
      orgId: ORG,
      paymentId: "X_reversal" as unknown as Id<"collectionPayments">,
    });
    expect(a.sourceId).not.toBe(b.sourceId);
    // Both were "collection_payment_X_reversal". Both accountingEvents and
    // pendingAccountingEvents dedupe on by_org_idempotency, so this could report
    // REVERSED while the original stayed POSTED, discard a forward post, or skip
    // enqueueing a reversal.
    expect(occurrenceReversalIdempotencyKey(a)).not.toBe(occurrenceIdempotencyKey(b));
  });

  test("R1 — a reversal key cannot equal another occurrence's REVERSAL key", () => {
    const a = directCollectionReceipt({
      orgId: ORG,
      paymentId: "Y" as unknown as Id<"collectionPayments">,
      occurrence: 2,
    });
    const b = directCollectionReceipt({
      orgId: ORG,
      paymentId: "Y" as unknown as Id<"collectionPayments">,
      occurrence: 3,
    });
    expect(occurrenceReversalIdempotencyKey(a)).not.toBe(occurrenceReversalIdempotencyKey(b));
  });

  test("the mapping is INJECTIVE over ROLE x sourceId x eventVersion together", () => {
    // The §3 sweep covered sourceId x version and missed the role axis entirely —
    // a sweep shaped like the claim it was written for rather than like the
    // property. This one sweeps all three.
    const sourceIds = ["X", "X_reversal", "reversal", "", "a:b", "occv2:1:a:1:b", "X_occ2", "_reversal"];
    const versions = [1, 2, 3, 12, 23];
    const keys = new Set<string>();
    let minted = 0;
    for (const sourceId of sourceIds) {
      for (const occurrence of versions) {
        const id = directCollectionReceipt({
          orgId: ORG,
          paymentId: sourceId as unknown as Id<"collectionPayments">,
          occurrence,
        });
        keys.add(occurrenceIdempotencyKey(id));
        keys.add(occurrenceReversalIdempotencyKey(id));
        minted += 2;
      }
    }
    expect(minted).toBe(sourceIds.length * versions.length * 2);
    expect(keys.size).toBe(minted);
  });

  test("a future channel prefix that is a PREFIX of another is refused", () => {
    // Raised independently by both seats. The v1 forward branch cannot be
    // length-framed (byte-compat), so its injectivity rests entirely on the
    // prefix set — which makes the prefix set an invariant, not a naming choice.
    //
    //   "collection_payment_"         + "reissue_abc"  ==
    //   "collection_payment_reissue_" + "abc"
    //
    // No exotic characters required. Same absorption mechanism as the original
    // injectivity defect, reached from the channel axis instead.
    expect(() =>
      assertChannelPrefixesUnambiguous(["collection_payment", "collection_payment_reissue"])
    ).toThrow(/is a prefix of/);
    expect(() =>
      assertChannelPrefixesUnambiguous(["payment_link_received", "payment_link"])
    ).toThrow(/is a prefix of/);
  });

  test("two channels sharing the IDENTICAL prefix are refused", () => {
    // Found independently by BOTH seats at acfd58429. The pairwise loop guards
    // `a !== b`, which compares VALUES — so two channels whose prefixes are the
    // same string are never compared against each other at all, and the
    // duplicate passes. That is the most basic way the prefix set can break:
    // two distinct economic tuples minting one identical key.
    expect(() =>
      assertChannelPrefixesUnambiguous([
        "collection_payment",
        "payment_link_received",
        "collection_payment",
      ])
    ).toThrow(/duplicate/i);
  });

  test("a future channel prefix inside a RESERVED namespace is refused", () => {
    expect(() => assertChannelPrefixesUnambiguous(["occv_channel"])).toThrow(/reserved namespace/);
    expect(() => assertChannelPrefixesUnambiguous(["occr_channel"])).toThrow(/reserved namespace/);
  });

  test("the REAL channel prefix set satisfies the property", () => {
    expect(() =>
      assertChannelPrefixesUnambiguous(["collection_payment", "payment_link_received"])
    ).not.toThrow();
  });

  test("R1-COMPAT — a LEGACY-keyed reversal already applied cannot be double-reversed via the facade", async () => {
    // The Codex seat raised this against acfd58429, and it corrected a FALSE
    // claim of mine: I had written that no COLLECTION_PAYMENT reversal exists.
    // It does. `clearCheque`'s return path in collections.ts builds
    // `cheque_return_after_clear_<chequeId>` and calls `reverseAccountingEvent`
    // DIRECTLY on a `sourceType: "collectionPayments"` event. It uses neither
    // `makeReversalHook` nor a `_reversal` suffix, which is exactly why my grep
    // over those two patterns missed it.
    //
    // So a legacy reversal key for a receipt occurrence DOES exist in
    // production shape, and the facade's `occr…` key can never match it.
    //
    // This test pins what actually protects the ledger, which is NOT the key:
    // `reverseAccountingEvent` patches the ORIGINAL event to REVERSED, and
    // refuses when it already is. The facade therefore sees no POSTED
    // occurrence and reports NOT_POSTED instead of minting a second journal.
    const { t, orgId, userId, customerId } = await seedPostableOrg("r1compat");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    const [original] = await eventsFor(t, orgId);
    expect(original.status).toBe("POSTED");

    await t.run(async (ctx) => {
      await reverseAccountingEvent(ctx, {
        orgId,
        originalEventId: original._id,
        reversalDate: Date.now(),
        reason: "Cheque returned after clearing",
        actorId: userId,
        idempotencyKey: `cheque_return_after_clear_${paymentId}`,
      });
    });

    const afterLegacy = await t.run(async (ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(afterLegacy).toHaveLength(2); // the receipt + its legacy reversal

    const outcome = await t.run(async (ctx) =>
      reverseReceiptOccurrence(ctx, {
        identity, reason: "facade reversal after a legacy one", actorId: userId,
        reversalDate: Date.now(),
      })
    );
    expect(outcome).toBe("NOT_POSTED");

    const afterFacade = await t.run(async (ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    // THE ASSERTION THAT MATTERS: still two. No second reversal journal.
    expect(afterFacade).toHaveLength(2);
  });

  test("R1-COMPAT (reverse order) — a legacy-keyed reversal arriving AFTER the facade cannot double-post", async () => {
    // The other ordering, which the first control does not cover. This is the
    // deferred case: `clearCheque` with no open period calls
    // `enqueuePendingReversal` with the legacy key, so the ORIGINAL stays POSTED
    // and the legacy reversal executes later. If the facade reverses during that
    // window, the legacy entry drains afterwards against an already-REVERSED
    // original.
    //
    // Draining the outbox is simulated by calling `reverseAccountingEvent` with
    // the legacy key directly, which is exactly what the drain does.
    const { t, orgId, userId, customerId } = await seedPostableOrg("r1compat2");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    const [original] = await eventsFor(t, orgId);

    const outcome = await t.run(async (ctx) =>
      reverseReceiptOccurrence(ctx, {
        identity, reason: "facade first", actorId: userId, reversalDate: Date.now(),
      })
    );
    expect(outcome).toBe("REVERSED");

    const afterFacade = await t.run(async (ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(afterFacade).toHaveLength(2);

    // The legacy reversal now drains, under a key the facade can never mint.
    await t.run(async (ctx) => {
      await reverseAccountingEvent(ctx, {
        orgId,
        originalEventId: original._id,
        reversalDate: Date.now(),
        reason: "Cheque returned after clearing",
        actorId: userId,
        idempotencyKey: `cheque_return_after_clear_${paymentId}`,
      });
    });

    const afterLegacy = await t.run(async (ctx) =>
      ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    // Still two. reverseAccountingEvent refuses an already-REVERSED original,
    // so the key mismatch cannot produce a second reversal journal in EITHER
    // ordering.
    expect(afterLegacy).toHaveLength(2);
  });

  test("R2 — reversing an AMBIGUOUS exact tuple REFUSES instead of reporting REVERSED", async () => {
    // findPostedReceiptOccurrence (the READ path) already refuses ambiguity.
    // reverseReceiptOccurrence (the MUTATING path) did not: reverseEventIfPosted's
    // exact-version branch filters POSTED and takes .first(), so it reversed one
    // of two duplicate rows and reported REVERSED while the other stayed POSTED.
    // A mutating consumer laxer than the read guarding it is the wrong way round.
    const { t, orgId, userId, customerId } = await seedPostableOrg("r2");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity, currency: "USD", occurredAt: Date.now(), actorId: userId,
        payload: receiptPayload(paymentId, customerId, 5000),
      });
    });
    const [original] = await eventsFor(t, orgId);
    expect(original.status).toBe("POSTED");

    // Two rows on the identical economic tuple, both POSTED. Convex has no
    // unique indexes, so nothing in the schema prevents this.
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = original;
      await ctx.db.insert("accountingEvents", { ...rest });
    });

    await expect(
      t.run(async (ctx) =>
        reverseReceiptOccurrence(ctx, {
          identity, reason: "SCRUM-237 §11 R2", actorId: userId, reversalDate: Date.now(),
        })
      )
    ).rejects.toThrow(/ambiguous receipt occurrence/);
  });
});
