/**
 * SCRUM-254 — generic operator access is not authority to reverse a certified
 * receipt occurrence.
 *
 * The defect this file pins is an AUTHORITY defect, not a key defect. The
 * registered generic wrapper `internal.accountingLedger.reverse` authenticates
 * the caller against the org and the accounting feature, and then hands any
 * POSTED `accountingEvents` row straight to the shared `reverseAccountingEvent`
 * engine. A privileged internal/operator caller can therefore unwind a
 * certified direct-collection receipt — the row that says a customer's money
 * arrived — using nothing but a reversal key of their own choosing.
 *
 * ⚠️ THERE IS NO KEY GUARD AT THIS BASE, AND §2 DOES NOT DEPEND ON ONE.
 * SCRUM-249 — a separate branch that is NOT an ancestor of this one — adds a
 * reserved `occr…` key-namespace guard inside the engine. `reversals.ts` here
 * contains no such guard, and an earlier revision of this comment asserted
 * otherwise in the present tense. §2's point stands either way and is in fact
 * cleaner without it: the exact derived reserved key must be refused for the
 * same reason an arbitrary operator-invented key is. If key spelling changed
 * the answer, this would be a spelling check rather than an authority boundary.
 *
 * What this ticket deliberately does NOT touch is the shared engine itself.
 * Legitimate domain code calls `reverseAccountingEvent` directly — SCRUM-130's
 * cheque-return seam in `collections.ts` is the one that matters — so §4 pins
 * the engine's receipt-reversal CAPABILITY as a negative control. If a future
 * change closes the receipt door inside the engine instead of at the wrapper,
 * §4 goes red and says so, rather than SCRUM-130 silently losing its authority.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  directCollectionReceipt,
  occurrenceReversalIdempotencyKey,
  RECEIPT_EVENT_TYPE,
  RECEIPT_SOURCE_TYPE,
} from "./accounting/receiptOccurrence";
import { postReceiptOccurrence } from "./accounting/workflowHooks";
import { reverseAccountingEvent } from "./accounting/reversals";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;

/**
 * Fully-applied receipt shape on purpose: it needs no 2110 mapping, so nothing
 * in this suite depends on a chart account SCRUM-231 has not seeded yet. The
 * question here is who may reverse the occurrence, not what its journal is.
 */
function receiptPayload(paymentId: string, customerId: string, amountMinor: number) {
  return {
    paymentId,
    customerId,
    receivedMinor: amountMinor,
    appliedMinor: amountMinor,
    unappliedMinor: 0,
    currency: "USD",
    paymentMethod: "CASH",
  };
}

/**
 * ⚠️ `harness` IS NOT OPTIONAL POLISH — A CROSS-TENANT TEST MUST PASS IT.
 *
 * Each `convexTestWithComponents` call is an independent in-memory database
 * that hands out the SAME deterministic id sequence. Building a "foreign" org
 * from a second harness therefore produces an id that either resolves to
 * nothing in the caller's database, or resolves to an unrelated row that
 * happens to sit at the same counter position. Either way the tenancy branch is
 * never reached and the test silently degrades into the missing-row case.
 *
 * This repo already paid for that lesson once — see the warning above
 * "another org's retained credit is not reachable" in
 * `accountingReceiptMovement.test.ts`. GR6 repeated it, and the Codex seat
 * caught it. Passing one harness to both orgs is what makes the foreign row
 * genuinely present.
 */
async function seedPostableOrg(suffix: string, harness?: TestHarness) {
  const t = harness ?? convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Reversal ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `gr_${suffix}`, email: `${suffix}@gr.com`, name: "Operator" })
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
  const asOperator = t.withIdentity({ subject: `gr_${suffix}`, clerkId: `gr_${suffix}` });
  await asOperator.mutation(api.chartOfAccounts.initialize, { orgId });

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

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;

  return { t, orgId, userId, customerId, asOperator };
}

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

/**
 * Post one certified receipt occurrence through the SCRUM-237 producer — the
 * only constructible forward door — and return the persisted row.
 *
 * Built through the real producer rather than an `accountingEvents` insert so
 * the target of every reversal below is the genuine certified tuple, with the
 * derived idempotency key and a real balanced journal behind it. A hand-inserted
 * look-alike row would exercise the guard's comparison while proving nothing
 * about the occurrence the guard exists to protect.
 */
async function postCertifiedReceipt(suffix: string, harness?: TestHarness) {
  const seeded = await seedPostableOrg(suffix, harness);
  const { t, orgId, userId, customerId } = seeded;
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

  const receipt = (await t.run(async (ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
  )) as Doc<"accountingEvents">;

  // The target really is the certified tuple, asserted rather than assumed —
  // the guard reads exactly these two columns.
  expect(receipt.eventType).toBe(RECEIPT_EVENT_TYPE);
  expect(receipt.sourceType).toBe(RECEIPT_SOURCE_TYPE);
  expect(receipt.status).toBe("POSTED");

  return { ...seeded, paymentId, identity, receipt };
}

/**
 * Everything a reversal would COMMIT, in one value.
 *
 * ⚠️ WHAT THIS DOES AND DOES NOT PROVE — an earlier revision of this comment
 * overclaimed, and the Codex seat disproved it with a mutant I then reproduced.
 * Comparing this snapshot across the refused call proves the refused call
 * commits nothing. It does **not** prove the refusal happens before the engine
 * is entered: Convex rolls an uncaught throw's writes back, so relocating the
 * guard to AFTER `reverseAccountingEvent` leaves this comparison — and all
 * eight tests — green. That mutant (M5) survives this helper entirely.
 *
 * Ordering is therefore proved separately and behaviorally, by §7/GR9, which
 * puts the receipt in a state the ENGINE would itself refuse and checks which
 * refusal wins. Keep both: this one pins "no committed effect", GR9 pins
 * "before the engine".
 *
 * The audit tables are in here because `reverseAccountingEvent` writes a
 * `REVERSE_EVENT` row to `financialAuditLog` (`reversals.ts`, via
 * `auditLog`), and `requireTenantAuth` writes `adminAuditLog` under an
 * impersonation session before this guard runs. A "whole footprint" that
 * omitted them was not whole.
 */
async function economicFootprint(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const events = await ctx.db
      .query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
    const entries = await ctx.db
      .query("journalEntries").withIndex("by_org_date", (q) => q.eq("orgId", orgId)).collect();
    const lines = await ctx.db.query("journalLines").collect();
    const pending = await ctx.db.query("pendingAccountingEvents").collect();
    const snapshots = await ctx.db.query("accountBalanceSnapshots").collect();
    const financialAudit = await ctx.db.query("financialAuditLog").collect();
    const adminAudit = await ctx.db.query("adminAuditLog").collect();
    return {
      financialAuditCount: financialAudit.filter((a) => a.orgId === orgId).length,
      adminAuditCount: adminAudit.length,
      events: events.map((e) => ({
        id: e._id, status: e.status, reversedByEventId: e.reversedByEventId ?? null,
      })),
      eventCount: events.length,
      entries: entries.map((e) => ({ id: e._id, status: e.status })),
      entryCount: entries.length,
      lineCount: lines.filter((l) => l.orgId === orgId).length,
      pendingCount: pending.filter((p) => p.orgId === orgId).length,
      // `runningDebitMinor` / `runningCreditMinor` are the real column names.
      // An earlier revision of this helper read `debitMinor` / `creditMinor`,
      // which do not exist on this table: every entry stringified to
      // `<id>:undefined:undefined`, so the balance dimension compared equal
      // before and after no matter what the reversal had done to it. The
      // comparison passed while proving nothing, which is why GR1 also asserts
      // this array is non-empty — a dimension that is vacuous cannot fail.
      balances: snapshots
        .filter((s) => s.orgId === orgId)
        .map((s) => `${s.accountId}:${s.runningDebitMinor}:${s.runningCreditMinor}`)
        .sort(),
    };
  });
}

describe("SCRUM-254 §1 — the generic wrapper cannot reverse a certified receipt under an arbitrary key", () => {
  test("GR1 — operator-chosen non-reserved key against a certified receipt is REFUSED", async () => {
    const { t, orgId, receipt, asOperator } = await postCertifiedReceipt("gr1");

    const before = await economicFootprint(t, orgId);
    // The balance dimension must actually carry values, or comparing it across
    // the refusal proves nothing. Pinned here rather than assumed.
    expect(before.balances.length).toBeGreaterThan(0);
    expect(before.balances.every((b) => !b.includes("undefined"))).toBe(true);

    await expect(
      asOperator.mutation(internal.accountingLedger.reverse, {
        orgId,
        originalEventId: receipt._id,
        reversalDate: Date.now(),
        reason: "operator decided to unwind this receipt",
        // Deliberately outside the reserved `occr…` namespace, so that even
        // once SCRUM-249's engine key guard exists it would have nothing to say
        // about this string. Anything that refuses it is refusing on authority.
        idempotencyKey: "operator_adhoc_reversal_gr1",
      })
    ).rejects.toThrow(/certified receipt/i);

    // Whole footprint, not just the thrown error.
    const after = await economicFootprint(t, orgId);
    expect(after).toEqual(before);
    expect(after.eventCount).toBe(1);
    expect(after.events[0].status).toBe("POSTED");
    expect(after.events[0].reversedByEventId).toBeNull();
    expect(after.entryCount).toBe(1);
    expect(after.entries[0].status).toBe("POSTED");
    expect(after.pendingCount).toBe(0);
    // No REVERSE_EVENT audit row was committed. `reverseAccountingEvent` writes
    // one on every successful reversal, so this dimension moves when the guard
    // is removed rather than sitting inert.
    expect(after.financialAuditCount).toBe(before.financialAuditCount);
    expect(after.adminAuditCount).toBe(before.adminAuditCount);
  });
});

describe("SCRUM-254 §2 — key spelling does not create authority", () => {
  test("GR2 — the exact derived reserved reversal key is refused for the same reason", async () => {
    const { t, orgId, receipt, identity, asOperator } = await postCertifiedReceipt("gr2");

    const before = await economicFootprint(t, orgId);
    // The genuine key the sanctioned facade would itself derive. If the wrapper
    // let this one through, the boundary would be "did you guess the key",
    // which is not an authority boundary at all.
    const reservedKey = occurrenceReversalIdempotencyKey(identity);
    expect(reservedKey.startsWith("occr")).toBe(true);

    await expect(
      asOperator.mutation(internal.accountingLedger.reverse, {
        orgId,
        originalEventId: receipt._id,
        reversalDate: Date.now(),
        reason: "operator with the right key is still a generic operator",
        idempotencyKey: reservedKey,
      })
    ).rejects.toThrow(/certified receipt/i);

    const after = await economicFootprint(t, orgId);
    expect(after).toEqual(before);
    expect(after.eventCount).toBe(1);
    expect(after.events[0].status).toBe("POSTED");
    expect(after.events[0].reversedByEventId).toBeNull();
  });
});

describe("SCRUM-254 §3 — supported non-receipt generic reversal is preserved", () => {
  test("GR3 — a POSTED non-receipt event still reverses through the generic wrapper", async () => {
    const { t, orgId, customerId, asOperator } = await seedPostableOrg("gr3");
    const now = Date.now();

    const posted = await asOperator.mutation(internal.accountingLedger.post, {
      orgId,
      eventType: "DEPOSIT_RECEIVED",
      sourceType: "deposits",
      sourceId: "dep_gr3",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "USD",
      idempotencyKey: "dep_gr3_post",
      payload: {
        depositId: "dep_gr3", amountMinor: 2000, currency: "USD",
        paymentMethod: "CASH", customerId: customerId.toString(),
      },
    });

    const result = await asOperator.mutation(internal.accountingLedger.reverse, {
      orgId,
      originalEventId: posted.eventId!,
      reversalDate: now,
      reason: "deposit cancelled",
      idempotencyKey: "dep_gr3_reversal",
    });

    expect(result.alreadyReversed).toBe(false);
    const original = await t.run((ctx) => ctx.db.get(posted.eventId!));
    expect(original?.status).toBe("REVERSED");
    expect(original?.reversedByEventId).toBe(result.reversalEventId);
  });
});

describe("SCRUM-254 §4 — the shared engine keeps receipt-reversal capability", () => {
  test("GR4 — reverseAccountingEvent called directly on a certified receipt still reverses", async () => {
    const { t, orgId, userId, receipt } = await postCertifiedReceipt("gr4");

    // ⚠️ SCOPE OF THIS CONTROL, STATED EXACTLY. This calls the shared engine
    // directly with a domain-built key, in the shape `collections.ts`'s
    // cheque-return path uses. It therefore proves the ENGINE still has the
    // capability SCRUM-130 depends on, and it goes red if a future change moves
    // the receipt denylist out of the wrapper and into the engine.
    //
    // It is NOT a `returnClearedCheque` lifecycle test and must not be cited as
    // one — the Codex seat was right that the earlier heading overstated it.
    // The real cheque-return behavior is covered by `collections.test.ts` and
    // `accountingPhase9.test.ts`, which this ticket does not touch.
    const outcome = await t.run(async (ctx) =>
      reverseAccountingEvent(ctx, {
        orgId,
        originalEventId: receipt._id,
        reversalDate: Date.now(),
        reason: "cheque returned after clearing",
        actorId: userId,
        idempotencyKey: `cheque_return_after_clear_${receipt.sourceId}`,
      })
    );

    expect(outcome.alreadyReversed).toBe(false);
    const original = await t.run((ctx) => ctx.db.get(receipt._id));
    expect(original?.status).toBe("REVERSED");
    expect(original?.reversedByEventId).toBe(outcome.reversalEventId);
  });
});

describe("SCRUM-254 §5 — tenancy and existence answers are unchanged, and leak no classification", () => {
  test("GR5 — a deleted original still produces the engine's precise not-found error", async () => {
    const { t, orgId, receipt, asOperator } = await postCertifiedReceipt("gr5");
    await t.run((ctx) => ctx.db.delete(receipt._id));

    await expect(
      asOperator.mutation(internal.accountingLedger.reverse, {
        orgId,
        originalEventId: receipt._id,
        reversalDate: Date.now(),
        reason: "missing original",
        idempotencyKey: "missing_gr5",
      })
    ).rejects.toThrow(/Accounting event not found in this organization/i);
  });

  test("GR6 — foreign receipt, foreign non-receipt and missing id are one indistinguishable answer", async () => {
    // ONE harness, so the foreign rows genuinely exist in the database the
    // caller queries. See the warning on `seedPostableOrg`: the previous
    // revision of this test used two harnesses, the foreign id resolved to
    // nothing in the caller's database, and it silently re-tested GR5's
    // missing-row branch while claiming to test tenancy.
    const t = convexTestWithComponents(schema, MODULE_GLOB);

    // The caller's own org, where they legitimately hold MANAGE_FINANCE.
    const home = await seedPostableOrg("gr6home", t);
    // A foreign tenant holding a certified receipt the caller must not learn about.
    const foreign = await postCertifiedReceipt("gr6foreign", t);

    // A foreign NON-receipt, so the oracle has all three arms.
    const foreignDeposit = await foreign.asOperator.mutation(internal.accountingLedger.post, {
      orgId: foreign.orgId,
      eventType: "DEPOSIT_RECEIVED",
      sourceType: "deposits",
      sourceId: "dep_gr6",
      eventVersion: 1,
      accountingDate: Date.now(),
      occurredAt: Date.now(),
      currency: "USD",
      idempotencyKey: "dep_gr6_post",
      payload: {
        depositId: "dep_gr6", amountMinor: 1000, currency: "USD",
        paymentMethod: "CASH", customerId: foreign.customerId.toString(),
      },
    });

    // A well-formed id that resolves to nothing, in the SAME database.
    const missingId = (await t.run(async (ctx) => {
      const { _id: _ignoredId, _creationTime: _ignoredCreated, ...fields } = foreign.receipt;
      const id = await ctx.db.insert("accountingEvents", {
        ...fields,
        sourceId: "doomed_gr6",
        idempotencyKey: "doomed_gr6_key",
      });
      await ctx.db.delete(id);
      return id;
    })) as Id<"accountingEvents">;

    // ⚠️ LIVENESS FIRST — without this the whole test can decay back into GR5.
    // Both foreign rows must actually be present in the caller's database, and
    // the missing one must actually be absent.
    expect(await t.run((ctx) => ctx.db.get(foreign.receipt._id))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(foreignDeposit.eventId!))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(missingId))).toBeNull();

    async function messageFor(originalEventId: Id<"accountingEvents">, key: string) {
      try {
        await home.asOperator.mutation(internal.accountingLedger.reverse, {
          orgId: home.orgId,
          originalEventId,
          reversalDate: Date.now(),
          reason: "cross-tenant probe",
          idempotencyKey: key,
        });
        return "NO REFUSAL";
      } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    const foreignReceiptMsg = await messageFor(foreign.receipt._id, "cross_org_receipt_gr6");
    const foreignDepositMsg = await messageFor(foreignDeposit.eventId!, "cross_org_deposit_gr6");
    const missingMsg = await messageFor(missingId, "cross_org_missing_gr6");

    // All three are the engine's precise not-found answer...
    for (const m of [foreignReceiptMsg, foreignDepositMsg, missingMsg]) {
      expect(m).toMatch(/Accounting event not found in this organization/i);
      // ...and none classifies a row whose tenancy the caller never established.
      expect(m).not.toMatch(/certified receipt/i);
      expect(m).not.toMatch(new RegExp(RECEIPT_EVENT_TYPE, "i"));
      expect(m).not.toMatch(new RegExp(RECEIPT_SOURCE_TYPE, "i"));
    }
    // Indistinguishable from each other, so the error is no oracle: a caller
    // cannot learn whether a foreign id is a receipt, a non-receipt, or nothing.
    expect(foreignReceiptMsg).toBe(foreignDepositMsg);
    expect(foreignDepositMsg).toBe(missingMsg);

    // And neither foreign row was touched.
    expect((await t.run((ctx) => ctx.db.get(foreign.receipt._id)))?.status).toBe("POSTED");
    expect((await t.run((ctx) => ctx.db.get(foreignDeposit.eventId!)))?.status).toBe("POSTED");
  });
});

/**
 * §6 — the refusal is keyed on the TUPLE, and both of its columns are load-bearing.
 *
 * Without these two, a guard that compared only `eventType`, or only
 * `sourceType`, would pass every other test in this file: §1/§2 target a row
 * that matches both columns, and §3's control is a `DEPOSIT_RECEIVED` /
 * `deposits` event that matches neither. Half the predicate would be
 * unfalsifiable.
 *
 * Neither case below is a shape invented to defeat a mutant. Both are producers
 * that exist at this base:
 *
 *   COLLECTION_PAYMENT / transactions      accountingMigration.ts:385-386
 *   COLLECTION_REFUND  / collectionPayments  makeCollectionHook, workflowHooks.ts
 *
 * They remain generically reversible, which is the ruled predicate (c17764)
 * rather than an oversight: SCRUM-254 closes the door on the CERTIFIED receipt
 * occurrence, the legacy `transactions`-sourced writer is SCRUM-223's to retire
 * and SCRUM-231's to delete at cutover, and a refund is not a receipt.
 */
describe("SCRUM-254 §6 — both columns of the certified tuple discriminate", () => {
  test("GR7 — COLLECTION_PAYMENT sourced from `transactions` is NOT the certified tuple and still reverses", async () => {
    const { t, orgId, customerId, asOperator } = await seedPostableOrg("gr7");
    const now = Date.now();

    const posted = await asOperator.mutation(internal.accountingLedger.post, {
      orgId,
      eventType: RECEIPT_EVENT_TYPE,
      // The one column that differs from the certified occurrence.
      sourceType: "transactions",
      sourceId: "txn_gr7",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "USD",
      idempotencyKey: "txn_gr7_post",
      payload: receiptPayload("txn_gr7", customerId.toString(), 3000),
    });

    const result = await asOperator.mutation(internal.accountingLedger.reverse, {
      orgId,
      originalEventId: posted.eventId!,
      reversalDate: now,
      reason: "legacy-sourced event is outside this ticket's boundary",
      idempotencyKey: "txn_gr7_reversal",
    });

    expect(result.alreadyReversed).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(posted.eventId!)))?.status).toBe("REVERSED");
  });

  test("GR8 — COLLECTION_REFUND sourced from `collectionPayments` is NOT the certified tuple and still reverses", async () => {
    const { t, orgId, customerId, asOperator } = await seedPostableOrg("gr8");
    const now = Date.now();

    const posted = await asOperator.mutation(internal.accountingLedger.post, {
      orgId,
      // The one column that differs from the certified occurrence.
      eventType: "COLLECTION_REFUND",
      sourceType: RECEIPT_SOURCE_TYPE,
      sourceId: "pay_gr8",
      eventVersion: 1,
      accountingDate: now,
      occurredAt: now,
      currency: "USD",
      idempotencyKey: "pay_gr8_post",
      payload: {
        paymentId: "pay_gr8",
        amountMinor: 2500,
        currency: "USD",
        customerId: customerId.toString(),
        paymentMethod: "CASH",
      },
    });

    const result = await asOperator.mutation(internal.accountingLedger.reverse, {
      orgId,
      originalEventId: posted.eventId!,
      reversalDate: now,
      reason: "a refund is not a receipt",
      idempotencyKey: "pay_gr8_reversal",
    });

    expect(result.alreadyReversed).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(posted.eventId!)))?.status).toBe("REVERSED");
  });
});

/**
 * §7 — the refusal happens BEFORE the engine is entered, proved behaviorally.
 *
 * This section exists because the Codex seat disproved a claim I had made, and
 * I reproduced the disproof before accepting it. `economicFootprint`'s
 * before/after comparison proves the refused call COMMITS nothing — but Convex
 * rolls an uncaught throw's writes back, so a mutant that relocates the guard to
 * AFTER `reverseAccountingEvent` still commits nothing and still throws the same
 * error. That mutant (M5) survives every other test in this file.
 *
 * The discriminator is a certified receipt in a state the ENGINE would itself
 * refuse. `reverseAccountingEvent` rejects a non-POSTED original with
 * `Cannot reverse an event with status "..."`. So the two placements answer
 * differently, and the answer names which code ran first:
 *
 *   guard before the engine  ->  the authority refusal wins
 *   guard after  the engine  ->  the engine's status error wins  (M5, killed here)
 *
 * No AST, no source-order matching, no coupling to how the handler is written —
 * just the observable consequence of ordering.
 */
describe("SCRUM-254 §7 — the authority refusal precedes the engine, not merely its writes", () => {
  test("GR9 — a certified receipt the ENGINE would also refuse still fails on AUTHORITY first", async () => {
    const { t, orgId, receipt, asOperator } = await postCertifiedReceipt("gr9");

    // A state the engine rejects on its own, with a distinguishable message.
    await t.run((ctx) => ctx.db.patch(receipt._id, { status: "FAILED" }));

    let message = "";
    try {
      await asOperator.mutation(internal.accountingLedger.reverse, {
        orgId,
        originalEventId: receipt._id,
        reversalDate: Date.now(),
        reason: "ordering proof",
        idempotencyKey: "gr9_ordering",
      });
      message = "NO REFUSAL";
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Authority is decided before the engine gets an opinion about status.
    expect(message).toMatch(/certified receipt/i);
    // And explicitly NOT the engine's answer — this is the assertion M5 fails.
    expect(message).not.toMatch(/Cannot reverse an event with status/i);
  });

  /**
   * GR9b — the same proof with a receipt nobody had to tamper with.
   *
   * ⚠️ GR9's `status: "FAILED"` is a WHITE-BOX PROBE, not an organic state. The
   * Sonnet seat pointed this out and I verified it: the only production writers
   * of `accountingEvents.status` are `postingEngine.ts` (PENDING, POSTED) and
   * `reversals.ts` (PENDING, POSTED, REVERSED). Nothing writes FAILED to that
   * table — FAILED belongs to `pendingAccountingEvents`. GR9 is still a valid
   * ordering discriminator, because the engine's refusal at that branch is real
   * either way, but it should not be read as evidence about a degraded receipt
   * that could actually occur.
   *
   * This case needs no tampering at all. The receipt is exactly what the
   * producer posted; only the caller's `reversalDate` is unusual, landing in a
   * year the org has no accounting period for — an ordinary operator mistake.
   * The engine calls `assertPostingAllowed` on that date and refuses. So:
   *
   *   guard before the engine  ->  authority refusal
   *   guard after  the engine  ->  "No accounting period found for date …"
   *
   * And this one closes something GR9 could not. M7 — the Codex counterexample
   * — special-cases exactly the state GR9 probes and lets everything else reach
   * the engine. This receipt is POSTED, so it takes M7's late path and gets the
   * period error. GR9b therefore kills M7 BEHAVIORALLY, independently of §8's
   * syntactic rule. Two instruments, two failure modes, one invariant.
   */
  test("GR9b — an untampered POSTED receipt with an unpostable reversal date also fails on AUTHORITY first", async () => {
    const { orgId, receipt, asOperator } = await postCertifiedReceipt("gr9b");

    // The receipt is untouched — still exactly as the SCRUM-237 producer left it.
    expect(receipt.status).toBe("POSTED");

    // A date in a year `seedPostableOrg` created no period for.
    const unpostableDate = Date.UTC(new Date().getUTCFullYear() - 5, 0, 15);

    let message = "";
    try {
      await asOperator.mutation(internal.accountingLedger.reverse, {
        orgId,
        originalEventId: receipt._id,
        reversalDate: unpostableDate,
        reason: "ordering proof, organic fixture",
        idempotencyKey: "gr9b_ordering",
      });
      message = "NO REFUSAL";
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/certified receipt/i);
    // The engine never got as far as having an opinion about the period.
    expect(message).not.toMatch(/No accounting period found/i);
  });
});


/**
 * §8 — a deliberately limited syntactic backstop, with its blind spots named.
 *
 * ## What carries the ordering invariant, and what merely helps
 *
 * The PRIMARY instrument is behavioral: §7/GR9b reverses an untampered POSTED
 * receipt with a reversal date the org has no period for. Any handler that lets
 * a POSTED certified receipt reach `reverseAccountingEvent` fails it, because
 * the engine answers first with its own period error. That is general — it does
 * not care how the late refusal is spelled, aliased, or hidden behind a helper.
 *
 * This section is a CHEAP SECOND OPINION, not the proof. Its value is that it
 * fails differently: it catches shapes at edit time by reading the source,
 * where a behavioral test only catches shapes it happens to exercise.
 *
 * ## History — this analyzer has been defeated twice, and both times honestly
 *
 * v1 required "every refusal token before the single engine call". The Codex
 * seat defeated it with M8: alias the constant into a local before the call and
 * throw the alias after, leaving one early literal token and a late refusal.
 * The seat also showed the slice was not a handler at all — it ran from the
 * marker to end of file, so a decoy declared later could satisfy it — and that
 * a token inside a comment or string counted as a refusal.
 *
 * v2 (here) fixes all three: comments and string literals are blanked before
 * scanning, the handler body is brace-matched rather than sliced to EOF, and
 * the rule is inverted from "a refusal appears early" to **NO `throw` may appear
 * after the engine call**. That inversion is what makes aliasing pointless: M8's
 * late `throw new ConvexError(refusal)` is a `throw` whatever it throws.
 *
 * ## What v2 still CANNOT see — stated, not implied
 *
 * A refusal that is not spelled `throw` in this handler. `if (isReceipt)
 * refuseSomewhereElse();` contains no `throw`, so this analyzer passes it.
 * **GR9b catches that shape and this one does not.** That is the division of
 * labour, and it is why removing either instrument weakens the invariant.
 *
 * It is also not a dominance analysis. It proves textual position within one
 * brace-matched body after comments and strings are removed — nothing about
 * reachability, control flow, or what a called function does.
 */
const HANDLER_MARKER = "export const reverse = internalMutation({";
const HANDLER_KEY = "handler:";
const ENGINE_CALL = "reverseAccountingEvent(";
const REFUSAL_TOKEN = "GENERIC_RECEIPT_REVERSAL_REFUSED";

/**
 * Blank out comments and string/template literals, preserving length and line
 * breaks so every index still refers to the same place in the original text.
 * Without this a token in a comment counts as a refusal — one of the three
 * defects the Codex seat found in v1.
 */
function blankCommentsAndStrings(src: string): string {
  const out = src.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === "`") {
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      blank(i, Math.min(j + 1, src.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** The brace-matched body of the `reverse` handler, or null. */
function reverseHandlerBody(scrubbed: string): string | null {
  const start = scrubbed.indexOf(HANDLER_MARKER);
  if (start < 0) return null;
  const key = scrubbed.indexOf(HANDLER_KEY, start);
  if (key < 0) return null;
  const open = scrubbed.indexOf("{", key);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < scrubbed.length; i++) {
    if (scrubbed[i] === "{") depth++;
    else if (scrubbed[i] === "}") {
      depth--;
      if (depth === 0) return scrubbed.slice(open, i + 1);
    }
  }
  return null;
}

function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * "ok" is the only passing value. Every other path is a REFUSAL — an analyzer
 * that cannot find what it is looking for must never report success.
 */
function reverseHandlerRefusesBeforeEngine(source: string): string {
  const body = reverseHandlerBody(blankCommentsAndStrings(source));
  if (body === null) return `handler not found: no brace-matched "${HANDLER_KEY}" body under "${HANDLER_MARKER}"`;

  const engineCalls = indicesOf(body, ENGINE_CALL);
  if (engineCalls.length !== 1) {
    return `expected exactly one ${ENGINE_CALL} in the reverse handler, found ${engineCalls.length}`;
  }
  const refusals = indicesOf(body, REFUSAL_TOKEN);
  if (refusals.length === 0) {
    return `no ${REFUSAL_TOKEN} in the reverse handler — the receipt refusal must be spelled in this handler`;
  }
  if (Math.max(...refusals) > engineCalls[0]) {
    return `a ${REFUSAL_TOKEN} appears AFTER ${ENGINE_CALL}`;
  }
  // The rule that survives aliasing: nothing may throw once the engine has been
  // entered. A late refusal is a `throw` no matter what value it carries.
  const lateThrow = indicesOf(body, "throw").find((t) => t > engineCalls[0]);
  if (lateThrow !== undefined) {
    return `a throw appears AFTER ${ENGINE_CALL} — a certified receipt would enter the engine and be refused only by rollback`;
  }
  return "ok";
}

const CORRECT_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    const original = await ctx.db.get(args.originalEventId);
    if (isReceipt) { throw new ConvexError(${REFUSAL_TOKEN}); }
    return ${ENGINE_CALL}ctx, cmd);
  },
});`;

const M5_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    const result = await ${ENGINE_CALL}ctx, cmd);
    if (isReceipt) { throw new ConvexError(${REFUSAL_TOKEN}); }
    return result;
  },
});`;

const M7_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    if (isReceipt && original.status === "FAILED") { throw new ConvexError(${REFUSAL_TOKEN}); }
    const result = await ${ENGINE_CALL}ctx, cmd);
    if (isReceipt) { throw new ConvexError(${REFUSAL_TOKEN}); }
    return result;
  },
});`;

// M8 — the Codex counterexample. Only ONE literal token, and it is early.
const M8_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    const refusal = ${REFUSAL_TOKEN};
    if (isReceipt && original.status === "FAILED") { throw new ConvexError(refusal); }
    const result = await ${ENGINE_CALL}ctx, cmd);
    if (isReceipt) { throw new ConvexError(refusal); }
    return result;
  },
});`;

// The token present ONLY inside a comment and a string — no real refusal.
const DECOY_COMMENT_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    // ${REFUSAL_TOKEN} is handled elsewhere
    const message = "${REFUSAL_TOKEN}";
    return ${ENGINE_CALL}ctx, cmd);
  },
});`;

// A later declaration that would have satisfied the v1 end-of-file slice.
const DECOY_TRAILING_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    const result = await ${ENGINE_CALL}ctx, cmd);
    return result;
  },
});

function decoy() {
  throw new Error(${REFUSAL_TOKEN});
}`;

// The KNOWN blind spot, pinned so it is recorded rather than discovered later.
const HELPER_REFUSAL_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    if (isReceipt) { throw new ConvexError(${REFUSAL_TOKEN}); }
    const result = await ${ENGINE_CALL}ctx, cmd);
    if (isReceipt) { refuseElsewhere(); }
    return result;
  },
});`;

describe("SCRUM-254 §8 — the analyzer, watched failing before it is trusted", () => {
  test("clears the real shape", () => {
    expect(reverseHandlerRefusesBeforeEngine(CORRECT_SHAPE)).toBe("ok");
  });

  test("rejects M5 — the refusal relocated after the engine call", () => {
    expect(reverseHandlerRefusesBeforeEngine(M5_SHAPE)).toMatch(/AFTER/);
  });

  test("rejects M7 — a narrow early branch plus a late refusal", () => {
    expect(reverseHandlerRefusesBeforeEngine(M7_SHAPE)).toMatch(/AFTER/);
  });

  test("rejects M8 — the late refusal aliased so only one early literal remains", () => {
    // v1 returned "ok" here. The late-throw rule is what closes it.
    expect(reverseHandlerRefusesBeforeEngine(M8_SHAPE)).toMatch(/a throw appears AFTER/);
  });

  test("a token in a comment or a string is not a refusal", () => {
    expect(reverseHandlerRefusesBeforeEngine(DECOY_COMMENT_SHAPE)).toMatch(/no GENERIC_RECEIPT_REVERSAL_REFUSED/);
  });

  test("scanning stops at the end of the handler, not the end of the file", () => {
    // v1 sliced to EOF, so this trailing function supplied the refusal token.
    expect(reverseHandlerRefusesBeforeEngine(DECOY_TRAILING_SHAPE)).toMatch(/no GENERIC_RECEIPT_REVERSAL_REFUSED/);
  });

  test("refuses rather than passes when it cannot find what it is looking for", () => {
    expect(reverseHandlerRefusesBeforeEngine("export const other = 1;")).toMatch(/handler not found/);
    expect(
      reverseHandlerRefusesBeforeEngine(
        `${HANDLER_MARKER}\n  handler: async () => {\n throw ${REFUSAL_TOKEN};\n ${ENGINE_CALL}a);\n ${ENGINE_CALL}b);\n},\n});`
      )
    ).toMatch(/exactly one/);
  });

  test("KNOWN BLIND SPOT — a late refusal that is not spelled `throw` is NOT caught here", () => {
    // Recorded deliberately. GR9b catches this shape behaviorally, because the
    // POSTED receipt reaches the engine and gets the engine's answer. If this
    // assertion ever flips to a rejection, the analyzer got stronger and the
    // comment above it is stale.
    expect(reverseHandlerRefusesBeforeEngine(HELPER_REFUSAL_SHAPE)).toBe("ok");
  });
});

describe("SCRUM-254 §8 — applied to the real handler", () => {
  test("GR10 — nothing in `reverse` throws after the single engine call", () => {
    const source = fs.readFileSync(path.join(path.resolve(__dirname), "accountingLedger.ts"), "utf8");

    // Liveness: the file really contains the handler, and the brace-matched
    // body really is that handler's body. Without this the analyzer could be
    // reporting a reason string about nothing.
    expect(source).toContain(HANDLER_MARKER);
    const body = reverseHandlerBody(blankCommentsAndStrings(source));
    expect(body).not.toBeNull();
    expect(body!).toContain("requireTenantAuth");
    expect(body!).toContain(ENGINE_CALL);
    // And the body must be a strict subset of the file — proof the brace match
    // terminated rather than running to the end.
    expect(body!.length).toBeLessThan(source.length);

    expect(reverseHandlerRefusesBeforeEngine(source)).toBe("ok");
  });
});
