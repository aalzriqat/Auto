/**
 * SCRUM-249 — the generic accounting posting ingress may not claim the reserved
 * direct-receipt occurrence.
 *
 * ## What is being pinned
 *
 * `internal.accountingLedger.post` accepts `eventType`, `sourceType`,
 * `sourceId`, `eventVersion`, `idempotencyKey` and `payload: v.any()` from its
 * caller and forwards them to `postAccountingEvent`. The protected production
 * release system provisions an operator credential for `runInternalMutations`
 * (SCRUM-124 c12729), so that door is a real privileged capability class, not a
 * theoretical one.
 *
 * `postAccountingEvent` compares the idempotency KEY before it compares the
 * economic tuple, and `postOrEnqueue` short-circuits on the key EARLIER STILL —
 * silently, before the engine is reached at all. So a generic caller that gets
 * to a key first owns the occurrence, whatever payload it carried.
 *
 * ## Two dimensions, because one is not enough
 *
 * The reservation cannot be the tuple alone. A caller posting the FOREIGN tuple
 * `COLLECTION_PAYMENT / transactions / …` while supplying the RECEIPT'S key
 * takes the key without ever touching the reserved pair, and the genuine receipt
 * is then absorbed by `postOrEnqueue` without reaching the engine. §3 is that
 * case, and it is the reason the guard reserves the key namespace too.
 *
 * ## What these tests drive
 *
 * The REAL registered mutation (`internal.accountingLedger.post`) and the REAL
 * posting boundary. Nothing here calls `postAccountingEvent` with a hand-built
 * command to simulate the operator — the point of the ticket is what the
 * REGISTERED door permits, and a direct call would prove a different claim.
 *
 * ## Failing-first
 *
 * §1–§4 FAIL against `ca68b2b0e` and pass after the guard. §5 passes in both
 * worlds and is the positive-control half: a guard that also refuses legitimate
 * posting is not a fix, and a refusal suite with no positive control cannot tell
 * "correctly scoped" from "blunt".
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  directCollectionReceipt,
  occurrenceIdempotencyKey,
  occurrenceReversalIdempotencyKey,
  type ReceiptOccurrenceIdentity,
} from "./accounting/receiptOccurrence";
import { postAccountingEvent } from "./accounting/postingEngine";
import { postReceiptOccurrence, findPostedReceiptOccurrence } from "./accounting/workflowHooks";
import { settleOutbox, outboxRows } from "../test-utils/outboxWork";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

/**
 * The whole accounting footprint of one org, in one value.
 *
 * A refusal test that only asserts "it threw" proves nothing about whether the
 * refusal happened BEFORE the money moved — the ticket's requirement 3 is about
 * the writes, not the error. Every table a posting attempt can touch is counted
 * here, so "no monetary effect" is a measured claim rather than an inference
 * from an error message.
 */
async function footprint(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const journals = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    const pending = (await ctx.db.query("pendingAccountingEvents").collect()).filter(
      (r) => r.orgId === orgId
    );
    const snapshots = (await ctx.db.query("accountBalanceSnapshots").collect()).filter(
      (r) => r.orgId === orgId
    );
    return {
      events: events.length,
      journals: journals.length,
      lines: lines.length,
      pending: pending.length,
      // Snapshot ROWS alone would miss a balance moving inside an existing row,
      // which is exactly what `incrementAccountSnapshot` does on a second post.
      snapshotTotal: snapshots.reduce((sum, s) => sum + s.runningDebitMinor + s.runningCreditMinor, 0),
    };
  });
}

async function eventsFor(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

async function journalsFor(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

async function seedCollectionPayment(
  t: TestHarness,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  userId: Id<"users">
): Promise<Id<"collectionPayments">> {
  return (await t.run((ctx) =>
    ctx.db.insert("collectionPayments", {
      orgId,
      customerId,
      direction: "IN",
      method: "CASH",
      amount: 5000,
      paymentDate: Date.now(),
      status: "POSTED",
      cashierId: userId,
      createdAt: Date.now(),
    })
  )) as Id<"collectionPayments">;
}

/**
 * An org whose chart is initialised, whose period is open, and whose owner
 * holds `manage:finance` — i.e. exactly the authenticated, same-tenant finance
 * authority `accountingLedger.post` requires today.
 *
 * The operator being AUTHORIZED is the whole point. This ticket is not about an
 * unauthenticated caller; it is about a legitimately privileged one holding
 * infrastructure capability that is not authority to mint a domain-reserved
 * receipt.
 */
async function seedPostableOrg(suffix: string, openPeriod = true) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Ingress ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `op_${suffix}`, email: `${suffix}@op.com`, name: "Operator" })
  )) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "USD",
      currencySymbol: "$",
      enabledPaymentTypes: ["CASH"],
    })
  );
  const asOperator = t.withIdentity({ subject: `op_${suffix}`, clerkId: `op_${suffix}` });
  await asOperator.mutation(api.chartOfAccounts.initialize, { orgId });

  const year = new Date().getUTCFullYear();
  if (openPeriod) {
    await asOperator.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asOperator.query(api.accountingPeriods.list, { orgId }))[0];
    await asOperator.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;
  return { t, orgId, userId, customerId, asOperator };
}

/** A structurally valid receipt payload — this one is what the attacker sends. */
function arbitraryReceiptPayload(paymentId: string, customerId: string) {
  return {
    paymentId,
    customerId,
    receivedMinor: 9_999_00,
    appliedMinor: 9_999_00,
    unappliedMinor: 0,
    currency: "USD",
    paymentMethod: "CASH",
  };
}

/** The certified split the real SCRUM-218-C producer would seal and post. */
function certifiedReceiptPayload(paymentId: string, customerId: string) {
  return {
    paymentId,
    customerId,
    receivedMinor: 500_00,
    appliedMinor: 500_00,
    unappliedMinor: 0,
    currency: "USD",
    paymentMethod: "CASH",
  };
}

function genericPostArgs(args: {
  orgId: Id<"organizations">;
  eventType: string;
  sourceType: string;
  sourceId: string;
  eventVersion?: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}) {
  const now = Date.now();
  return {
    orgId: args.orgId,
    eventType: args.eventType,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    eventVersion: args.eventVersion ?? 1,
    accountingDate: now,
    occurredAt: now,
    currency: "USD",
    idempotencyKey: args.idempotencyKey,
    payload: args.payload,
  };
}

/* ========================================================================== *
 * §1 — THE GENERIC INGRESS MUST NOT MINT THE RESERVED OCCURRENCE
 * ========================================================================== */

describe("SCRUM-249 §1 — the reserved occurrence is not the generic ingress's to create", () => {
  test("R1 — an authorized operator cannot post COLLECTION_PAYMENT / collectionPayments through the generic door", async () => {
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("r1");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);

    await expect(
      asOperator.mutation(
        internal.accountingLedger.post,
        genericPostArgs({
          orgId,
          eventType: "COLLECTION_PAYMENT",
          sourceType: "collectionPayments",
          sourceId: paymentId.toString(),
          idempotencyKey: `collection_payment_${paymentId}`,
          payload: arbitraryReceiptPayload(paymentId.toString(), customerId.toString()),
        })
      )
    ).rejects.toThrow(/reserved/i);
  });

  test("R2 — the refusal lands BEFORE any journal, event, snapshot or outbox row", async () => {
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("r2");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);

    const before = await footprint(t, orgId);
    await expect(
      asOperator.mutation(
        internal.accountingLedger.post,
        genericPostArgs({
          orgId,
          eventType: "COLLECTION_PAYMENT",
          sourceType: "collectionPayments",
          sourceId: paymentId.toString(),
          idempotencyKey: `collection_payment_${paymentId}`,
          payload: arbitraryReceiptPayload(paymentId.toString(), customerId.toString()),
        })
      )
    ).rejects.toThrow();
    const after = await footprint(t, orgId);

    // Requirement 3 in full: not "it threw", but "nothing moved". Measured over
    // every table a post can write, including the running balance INSIDE an
    // existing snapshot row.
    expect(after).toEqual(before);
  });

  test("R3 — varying eventVersion, key spelling or source spelling does not open the door", async () => {
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("r3");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const payload = arbitraryReceiptPayload(paymentId.toString(), customerId.toString());

    // Every axis the ticket says the guard must not be bypassable on. The
    // reservation is the occurrence FAMILY, so no member of it is reachable.
    const variants: { why: string; eventVersion: number; key: string; sourceId: string }[] = [
      { why: "legacy v1 key", eventVersion: 1, key: `collection_payment_${paymentId}`, sourceId: paymentId.toString() },
      { why: "repeat occurrence", eventVersion: 2, key: `occv2:18:collection_payment:${paymentId.toString().length}:${paymentId}`, sourceId: paymentId.toString() },
      { why: "high occurrence", eventVersion: 97, key: `occv97:18:collection_payment:${paymentId.toString().length}:${paymentId}`, sourceId: paymentId.toString() },
      { why: "unrelated key spelling", eventVersion: 1, key: `something_entirely_different_${paymentId}`, sourceId: paymentId.toString() },
      { why: "reversal namespace key", eventVersion: 1, key: `occr1:18:collection_payment:${paymentId.toString().length}:${paymentId}`, sourceId: paymentId.toString() },
      { why: "sourceId that is not a real payment", eventVersion: 1, key: "collection_payment_fabricated", sourceId: "fabricated" },
      { why: "sourceId shaped like a framed key", eventVersion: 1, key: "collection_payment_occv2:1:a:1:b", sourceId: "occv2:1:a:1:b" },
    ];

    for (const v of variants) {
      await expect(
        asOperator.mutation(
          internal.accountingLedger.post,
          genericPostArgs({
            orgId,
            eventType: "COLLECTION_PAYMENT",
            sourceType: "collectionPayments",
            sourceId: v.sourceId,
            eventVersion: v.eventVersion,
            idempotencyKey: v.key,
            payload,
          })
        ),
        `variant should be refused: ${v.why}`
      ).rejects.toThrow(/reserved/i);
    }

    // And nothing in the sweep left a trace.
    expect(await footprint(t, orgId)).toEqual({
      events: 0,
      journals: 0,
      lines: 0,
      pending: 0,
      snapshotTotal: 0,
    });
  });
});

/* ========================================================================== *
 * §2 — PREEMPTION AND ABSORPTION, END TO END
 * ========================================================================== */

describe("SCRUM-249 §2 — a preempted occurrence must not absorb the certified receipt", () => {
  test("P1 — after a generic attempt, the occurrence on the books carries the CERTIFIED payload", async () => {
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("p1");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    // The operator gets there first, with a payload that never came through the
    // certified receipt authority.
    await asOperator
      .mutation(
        internal.accountingLedger.post,
        genericPostArgs({
          orgId,
          eventType: "COLLECTION_PAYMENT",
          sourceType: "collectionPayments",
          sourceId: paymentId.toString(),
          idempotencyKey: occurrenceIdempotencyKey(identity),
          payload: arbitraryReceiptPayload(paymentId.toString(), customerId.toString()),
        })
      )
      // Refused after the fix; accepted before it. Either way the LEGITIMATE
      // producer runs next, and the assertion is about what ends up on the books
      // — not about which of the two calls threw.
      .catch(() => undefined);

    // ...then the real SCRUM-218-C producer posts the occurrence it owns.
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });

    const events = await eventsFor(t, orgId);
    expect(events).toHaveLength(1);
    // THE DEFECT, STATED AS AN ASSERTION: today this event carries 9_999_00,
    // because the key-first short-circuit returned the preempting row and the
    // certified payload was never compared to it.
    expect((events[0].payload as { receivedMinor: number }).receivedMinor).toBe(500_00);

    // And the journal reflects the certified economics, not the fabricated ones.
    const journals = await journalsFor(t, orgId);
    expect(journals).toHaveLength(1);
    const lines = await t.run(async (ctx) =>
      ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journals[0]._id))
        .collect()
    );
    expect(lines.reduce((sum, l) => sum + l.debitMinor, 0)).toBe(500_00);
  });
});

/* ========================================================================== *
 * §3 — THE KEY NAMESPACE, TAKEN FROM OUTSIDE THE RESERVED TUPLE
 * ========================================================================== */

describe("SCRUM-249 §3 — the reserved KEY cannot be taken from a foreign tuple either", () => {
  /**
   * The reason a tuple-only reservation is not sound, demonstrated rather than
   * argued.
   *
   * `COLLECTION_PAYMENT / transactions` is a real, legitimate shape — it is what
   * `accountingMigration` posts. Nothing about that tuple is reserved. But the
   * KEY `collection_payment_<paymentId>` is the exact string
   * `occurrenceIdempotencyKey` derives for occurrence 1, and once a POSTED row
   * holds it, `postOrEnqueue`'s `alreadyPosted` short-circuit returns SILENTLY —
   * before `postAccountingEvent` is reached at all. The receipt never posts and
   * nothing anywhere reports a problem.
   */
  test("K1 — a foreign tuple holding the receipt's derived key cannot block the receipt", async () => {
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("k1");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });
    const reservedKey = occurrenceIdempotencyKey(identity);

    const legacyTransactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        category: "COLLECTION_PAYMENT",
        amount: 42,
        date: Date.now(),
        description: "legacy",
      })
    );

    await asOperator
      .mutation(
        internal.accountingLedger.post,
        genericPostArgs({
          orgId,
          eventType: "COLLECTION_PAYMENT",
          // NOT the reserved pair — this tuple is legitimate for the migration.
          sourceType: "transactions",
          sourceId: legacyTransactionId.toString(),
          // ...but the key belongs to the receipt authority.
          idempotencyKey: reservedKey,
          payload: arbitraryReceiptPayload(legacyTransactionId.toString(), customerId.toString()),
        })
      )
      // Refused after the fix. Accepted before it — and the assertion below is
      // deliberately about the END STATE, not about which call threw, because
      // the defect's signature is that NOTHING throws: `postOrEnqueue` finds a
      // POSTED row under this key and returns silently, so the receipt simply
      // never posts and no error is raised anywhere.
      .catch(() => undefined);

    // The receipt then posts normally, because nothing ever took its key.
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });

    const posted = await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity));
    expect(posted).not.toBeNull();
    expect(posted?.idempotencyKey).toBe(reservedKey);
  });

  test("K3 — the REVERSAL door cannot occupy the reserved key space either", async () => {
    // `reverseAccountingEvent` writes an `accountingEvents` row carrying the
    // caller's key, so `internal.accountingLedger.reverse` is a second way into
    // the same namespace — and a row holding `collection_payment_<paymentId>`
    // drops the genuine receipt just as silently, whichever door wrote it.
    //
    // ⚠️ SCOPE: this is about WHICH KEY a reversal may use, not WHICH EVENTS may
    // be reversed. Whether a generic operator may reverse a certified receipt at
    // all is a separate authority question that would refuse `clearCheque`'s
    // existing direct reversal, and it belongs to SCRUM-130. Recorded, not
    // closed by implication.
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("k3");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const reservedKey = occurrenceIdempotencyKey(directCollectionReceipt({ orgId, paymentId }));

    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        title: "Something reversible",
        category: "OTHER",
        amount: 25,
        date: Date.now(),
      })
    );
    const posted = await asOperator.mutation(
      internal.accountingLedger.post,
      genericPostArgs({
        orgId,
        eventType: "EXPENSE_POSTED",
        sourceType: "expenses",
        sourceId: expenseId.toString(),
        idempotencyKey: `expense_posted_${expenseId}`,
        payload: {
          expenseId: expenseId.toString(),
          amountMinor: 25_00,
          currency: "USD",
          paymentMethod: "CASH",
        },
      })
    );
    expect(posted.eventId).not.toBeNull();

    await expect(
      asOperator.mutation(internal.accountingLedger.reverse, {
        orgId,
        originalEventId: posted.eventId!,
        reversalDate: Date.now(),
        reason: "taking the receipt's key",
        idempotencyKey: reservedKey,
      })
    ).rejects.toThrow(/reserved/i);

    // The receipt is still free to post under its own key.
    const identity = directCollectionReceipt({ orgId, paymentId });
    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity))).not.toBeNull();
  });

  test("K2 — the repeat and reversal namespaces are reserved from a foreign tuple too", async () => {
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("k2");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity2 = directCollectionReceipt({ orgId, paymentId, occurrence: 2 });

    for (const key of [
      occurrenceIdempotencyKey(identity2),
      occurrenceReversalIdempotencyKey(identity2),
      occurrenceReversalIdempotencyKey(directCollectionReceipt({ orgId, paymentId })),
    ]) {
      await expect(
        asOperator.mutation(
          internal.accountingLedger.post,
          genericPostArgs({
            orgId,
            eventType: "COLLECTION_REFUND",
            sourceType: "collectionPayments",
            sourceId: paymentId.toString(),
            idempotencyKey: key,
            payload: {
              paymentId: paymentId.toString(),
              customerId: customerId.toString(),
              amountMinor: 100_00,
              currency: "USD",
              paymentMethod: "CASH",
            },
          })
        ),
        `reserved namespace key must be refused: ${key}`
      ).rejects.toThrow(/reserved/i);
    }
  });
});

/* ========================================================================== *
 * §3b — WHAT THE AUTHORITY ACTUALLY IS
 *
 * §1-§3 drive the registered mutation, which is the ticket's threat model. These
 * go one level lower and call `postAccountingEvent` directly, because that is
 * the only way to ask what the capability itself proves. Without them, a mutant
 * deleting the trust check or the field comparison would survive the whole
 * suite: the registered door supplies no authority at all, so it is refused long
 * before either line runs.
 * ========================================================================== */

describe("SCRUM-249 §3b - the capability is object identity, and it is claim-bound", () => {
  test("A1 - a SPREAD CLONE of a real identity authorizes nothing", async () => {
    // The exact forgery B237-HEAD-01 walked through. TypeScript copies the
    // phantom brand across a spread, so `forged` type-checks as an identity and
    // every field is correct - and it is a different OBJECT, so it is absent
    // from the module-private WeakSet. Shape is what an attacker can copy;
    // membership is not.
    const { t, orgId, userId, customerId } = await seedPostableOrg("a1");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const real = directCollectionReceipt({ orgId, paymentId });
    const forged: ReceiptOccurrenceIdentity = { ...real };

    const before = await footprint(t, orgId);
    await expect(
      t.run(async (ctx) =>
        postAccountingEvent(ctx, {
          ...genericPostArgs({
            orgId,
            eventType: "COLLECTION_PAYMENT",
            sourceType: "collectionPayments",
            sourceId: paymentId.toString(),
            idempotencyKey: occurrenceIdempotencyKey(real),
            payload: arbitraryReceiptPayload(paymentId.toString(), customerId.toString()),
          }),
          actorId: userId,
          receiptAuthority: forged,
        })
      )
    ).rejects.toThrow(/untrusted receipt occurrence identity/);
    expect(await footprint(t, orgId)).toEqual(before);
  });

  test("A2 - authority for ONE occurrence does not authorize another", async () => {
    // A capability proving only "you hold some receipt authority" would be a
    // skeleton key: one legitimately obtained identity would post any receipt in
    // the org. It has to bind to the exact claim, key included.
    const { t, orgId, userId, customerId } = await seedPostableOrg("a2");
    const minePaymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const theirsPaymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const mine = directCollectionReceipt({ orgId, paymentId: minePaymentId });

    const before = await footprint(t, orgId);
    await expect(
      t.run(async (ctx) =>
        postAccountingEvent(ctx, {
          ...genericPostArgs({
            orgId,
            eventType: "COLLECTION_PAYMENT",
            sourceType: "collectionPayments",
            // ...a DIFFERENT customer receipt than the one this authority covers
            sourceId: theirsPaymentId.toString(),
            idempotencyKey: `collection_payment_${theirsPaymentId}`,
            payload: arbitraryReceiptPayload(theirsPaymentId.toString(), customerId.toString()),
          }),
          actorId: userId,
          receiptAuthority: mine,
        })
      )
    ).rejects.toThrow(/authority does not cover this reserved posting command/);
    expect(await footprint(t, orgId)).toEqual(before);
  });

  test("A3 - a real identity cannot be used to take a key that is not its own", async () => {
    // Tuple right, authority genuine, key somebody else's. If the derived key
    // were not compared, a legitimate producer could still park a row on the
    // wrong side of the namespace.
    const { t, orgId, userId, customerId } = await seedPostableOrg("a3");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await expect(
      t.run(async (ctx) =>
        postAccountingEvent(ctx, {
          ...genericPostArgs({
            orgId,
            eventType: "COLLECTION_PAYMENT",
            sourceType: "collectionPayments",
            sourceId: paymentId.toString(),
            idempotencyKey: occurrenceReversalIdempotencyKey(identity),
            payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
          }),
          actorId: userId,
          receiptAuthority: identity,
        })
      )
    ).rejects.toThrow(/idempotencyKey differ|authority does not cover/);
  });
});

/* ========================================================================== *
 * §4 — CHANGED ECONOMICS MUST NOT BE ABSORBED
 * ========================================================================== */

describe("SCRUM-249 §4 — one occurrence, one economics", () => {
  test("C1 — a second post of the same occurrence with different economics REFUSES", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("c1");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });

    const before = await footprint(t, orgId);

    // Same identity, different money. Today this returns the first event and
    // reports `alreadyPosted`, which is the ledger saying "equivalent" about two
    // things that are not.
    await expect(
      t.run(async (ctx) => {
        await postReceiptOccurrence(ctx, {
          identity,
          currency: "USD",
          occurredAt: Date.now(),
          actorId: userId,
          payload: {
            ...certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
            receivedMinor: 750_00,
            appliedMinor: 750_00,
          },
        });
      })
    ).rejects.toThrow(/conflict|differ|economic|payload/i);

    expect(await footprint(t, orgId)).toEqual(before);
  });
});

describe("SCRUM-249 §4b - a QUEUED occurrence is not absorbed by divergent economics", () => {
  test("C2 - changed economics against a queued receipt refuses before it can overwrite the queue", async () => {
    // `postOrEnqueue`'s FIRST short-circuit is the queued-row one, and it fires
    // before the POSTED check and before the engine. A divergent second command
    // returning silently here would leave the queue holding the first payload
    // while its caller believed the second had been accepted.
    const { t, orgId, userId, customerId } = await seedPostableOrg("c2", false);
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });
    expect(await outboxRows(t, orgId)).toHaveLength(1);

    await expect(
      t.run(async (ctx) => {
        await postReceiptOccurrence(ctx, {
          identity,
          currency: "USD",
          occurredAt: Date.now(),
          actorId: userId,
          payload: {
            ...certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
            receivedMinor: 12_00,
            appliedMinor: 12_00,
          },
        });
      })
    ).rejects.toThrow(/payload economics differ/);

    // The queue still holds exactly the one row, with the original economics.
    const rows = await outboxRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { receivedMinor: number }).receivedMinor).toBe(500_00);
  });
});

/* ========================================================================== *
 * §5 — POSITIVE CONTROLS: the guard must be scoped, not blunt
 * ========================================================================== */

describe("SCRUM-249 §5 — everything legitimate still works", () => {
  test("L1 — the sanctioned producer posts the receipt exactly once", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("l1");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });

    expect(await eventsFor(t, orgId)).toHaveLength(1);
    expect(await journalsFor(t, orgId)).toHaveLength(1);
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity))).not.toBeNull();
  });

  test("L2 — an EXACT legitimate retry stays idempotent", async () => {
    const { t, orgId, userId, customerId } = await seedPostableOrg("l2");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });
    const payload = certifiedReceiptPayload(paymentId.toString(), customerId.toString());

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await t.run(async (ctx) => {
        await postReceiptOccurrence(ctx, {
          identity,
          currency: "USD",
          occurredAt: Date.now(),
          actorId: userId,
          payload,
        });
      });
    }

    // One receipt, one journal, however many times the caller retried.
    expect(await eventsFor(t, orgId)).toHaveLength(1);
    expect(await journalsFor(t, orgId)).toHaveLength(1);
  });

  test("L3 — the DEFERRED arm still posts: enqueue with no open period, then drain", async () => {
    // The outbox drain holds no in-process identity — it rebuilds the command
    // from a persisted row. If the guard's authority were purely in-memory, this
    // is the test that would go red, so it is the load-bearing positive control
    // for the whole mechanism.
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("l3", false);
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);
    const identity = directCollectionReceipt({ orgId, paymentId });

    await t.run(async (ctx) => {
      await postReceiptOccurrence(ctx, {
        identity,
        currency: "USD",
        occurredAt: Date.now(),
        actorId: userId,
        payload: certifiedReceiptPayload(paymentId.toString(), customerId.toString()),
      });
    });

    // Nothing posted; it is durably queued.
    expect(await eventsFor(t, orgId)).toHaveLength(0);
    const queued = await outboxRows(t, orgId);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("POST");
    expect(queued[0].idempotencyKey).toBe(occurrenceIdempotencyKey(identity));

    // ⚠️ THE CAPABILITY MUST NEVER REACH THE DATABASE. `enqueuePendingPost`
    // enumerates its columns instead of spreading the command, which is why
    // this holds today — and a later `...cmd` would silently persist a frozen
    // trust-registry member as a plain row, at which point reading it back
    // would look like authority while carrying none. Asserted rather than left
    // to inspection.
    expect(Object.keys(queued[0])).not.toContain("receiptAuthority");

    const year = new Date().getUTCFullYear();
    await asOperator.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const period = (await asOperator.query(api.accountingPeriods.list, { orgId }))[0];
    await asOperator.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

    await settleOutbox(t, orgId);

    // The drain rebuilt the reserved occurrence from persisted state and posted
    // it — exactly once.
    const events = await eventsFor(t, orgId);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("POSTED");
    expect(await journalsFor(t, orgId)).toHaveLength(1);
    expect((await outboxRows(t, orgId))[0].status).toBe("POSTED");
    expect(await t.run(async (ctx) => findPostedReceiptOccurrence(ctx, identity))).not.toBeNull();
  });

  test("L4 — a legitimate COLLECTION_REFUND on collectionPayments still posts through the generic door", async () => {
    // Same sourceType as the reserved occurrence, different event type. If the
    // guard reserved `sourceType` alone, refunds would stop working — which is
    // the failure mode owner-proxy c17538 rejected as Option C in SCRUM-236.
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("l4");
    const paymentId = await seedCollectionPayment(t, orgId, customerId, userId);

    await asOperator.mutation(
      internal.accountingLedger.post,
      genericPostArgs({
        orgId,
        eventType: "COLLECTION_REFUND",
        sourceType: "collectionPayments",
        sourceId: paymentId.toString(),
        idempotencyKey: `collection_refund_${paymentId}`,
        payload: {
          paymentId: paymentId.toString(),
          customerId: customerId.toString(),
          amountMinor: 100_00,
          currency: "USD",
          paymentMethod: "CASH",
        },
      })
    );

    expect(await eventsFor(t, orgId)).toHaveLength(1);
    expect(await journalsFor(t, orgId)).toHaveLength(1);
  });

  test("L5 — the migration shape COLLECTION_PAYMENT / transactions still posts", async () => {
    // Same event type as the reserved occurrence, different source family. If
    // the guard reserved `eventType` alone, SCRUM-223's not-yet-retired legacy
    // producer would break — and the reservation would be wrong anyway, because
    // a table name is not a source family.
    const { t, orgId, userId, customerId, asOperator } = await seedPostableOrg("l5");
    const legacyTransactionId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        category: "COLLECTION_PAYMENT",
        amount: 42,
        date: Date.now(),
        description: "legacy",
      })
    );

    await asOperator.mutation(
      internal.accountingLedger.post,
      genericPostArgs({
        orgId,
        eventType: "COLLECTION_PAYMENT",
        sourceType: "transactions",
        sourceId: legacyTransactionId.toString(),
        idempotencyKey: `migrate_${legacyTransactionId}`,
        payload: {
          paymentId: legacyTransactionId.toString(),
          customerId: customerId.toString(),
          receivedMinor: 42_00,
          appliedMinor: 42_00,
          unappliedMinor: 0,
          currency: "USD",
          paymentMethod: "CASH",
        },
      })
    );

    expect(await eventsFor(t, orgId)).toHaveLength(1);
    expect(await journalsFor(t, orgId)).toHaveLength(1);
  });

  test("L6 — an unrelated event family is untouched by the guard", async () => {
    const { t, orgId, userId, asOperator } = await seedPostableOrg("l6");
    const expenseId = await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        title: "Office supplies",
        category: "OTHER",
        amount: 25,
        date: Date.now(),
      })
    );

    await asOperator.mutation(
      internal.accountingLedger.post,
      genericPostArgs({
        orgId,
        eventType: "EXPENSE_POSTED",
        sourceType: "expenses",
        sourceId: expenseId.toString(),
        idempotencyKey: `expense_posted_${expenseId}`,
        payload: {
          expenseId: expenseId.toString(),
          amountMinor: 25_00,
          currency: "USD",
          paymentMethod: "CASH",
        },
      })
    );

    expect(await eventsFor(t, orgId)).toHaveLength(1);
    expect(await journalsFor(t, orgId)).toHaveLength(1);
  });
});
