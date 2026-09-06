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
});

/**
 * §8 — no path may ENTER the engine and refuse afterwards.
 *
 * §7/GR9 proves ordering only for the one status it probes. The Codex seat
 * refused to close on that and built the counterexample; I reproduced it before
 * accepting, and it survives all nine behavioral tests:
 *
 *     if (isCertifiedReceipt && original.status === "FAILED") throw refusal;  // satisfies GR9
 *     const result = await reverseAccountingEvent(ctx, cmd);                  // POSTED receipts ENTER
 *     if (isCertifiedReceipt) throw refusal;                                  // satisfies GR1/GR2 via rollback
 *
 * That mutant (M7) is why this section exists. For a plain POSTED receipt there
 * is NO behavioral discriminator available from outside the transaction: the
 * only difference between guarding before and guarding after is work that gets
 * rolled back, and rolled-back work is unobservable. So the ordering invariant
 * cannot be closed behaviorally, and a syntactic rule is the honest instrument.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves a textual dominance property
 * of one handler: exactly one engine call, and every refusal ahead of it. It is
 * not a dataflow proof and it cannot see a refusal moved into a helper. That
 * limit is stated rather than papered over — the check FAILS CLOSED in that
 * case (it would find no refusal in the handler) and tells the author so.
 *
 * The self-tests come first deliberately, following the house convention in
 * `economicsRevisionGuard.test.ts`: a guard nobody has watched fail is not a
 * guard. They pin that the analyzer clears the real shape, rejects M5, rejects
 * M7, and refuses rather than silently passing when it cannot find what it is
 * looking for.
 */
const HANDLER_MARKER = "export const reverse = internalMutation({";
const ENGINE_CALL = "reverseAccountingEvent(";
const REFUSAL_TOKEN = "GENERIC_RECEIPT_REVERSAL_REFUSED";

function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Returns a reason string. "ok" is the only passing value; every other outcome
 * names what went wrong, so a failure here is actionable rather than a bare
 * boolean. Every non-"ok" path is a REFUSAL — an analyzer that cannot find the
 * handler must not report success.
 */
function reverseHandlerRefusesBeforeEngine(source: string): string {
  const start = source.indexOf(HANDLER_MARKER);
  if (start < 0) return `handler not found: no "${HANDLER_MARKER}"`;
  const body = source.slice(start);

  const engineCalls = indicesOf(body, ENGINE_CALL);
  if (engineCalls.length !== 1) {
    return `expected exactly one ${ENGINE_CALL} in the reverse handler, found ${engineCalls.length}`;
  }
  const refusals = indicesOf(body, REFUSAL_TOKEN);
  if (refusals.length === 0) {
    return `no ${REFUSAL_TOKEN} in the reverse handler — the receipt refusal must live in this handler, not behind a helper`;
  }
  if (Math.max(...refusals) > engineCalls[0]) {
    return `a ${REFUSAL_TOKEN} refusal appears AFTER ${ENGINE_CALL} — a certified receipt would enter the engine and be refused only by rollback`;
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
    const original = await ctx.db.get(args.originalEventId);
    const result = await ${ENGINE_CALL}ctx, cmd);
    if (isReceipt) { throw new ConvexError(${REFUSAL_TOKEN}); }
    return result;
  },
});`;

const M7_SHAPE = `${HANDLER_MARKER}
  handler: async (ctx, args) => {
    const original = await ctx.db.get(args.originalEventId);
    if (isReceipt && original.status === "FAILED") { throw new ConvexError(${REFUSAL_TOKEN}); }
    const result = await ${ENGINE_CALL}ctx, cmd);
    if (isReceipt) { throw new ConvexError(${REFUSAL_TOKEN}); }
    return result;
  },
});`;

describe("SCRUM-254 §8 — the ordering analyzer, watched failing before it is trusted", () => {
  test("clears the real shape", () => {
    expect(reverseHandlerRefusesBeforeEngine(CORRECT_SHAPE)).toBe("ok");
  });

  test("rejects M5 — the refusal relocated after the engine call", () => {
    expect(reverseHandlerRefusesBeforeEngine(M5_SHAPE)).toMatch(/appears AFTER/);
  });

  test("rejects M7 — a narrow early branch plus a late refusal", () => {
    expect(reverseHandlerRefusesBeforeEngine(M7_SHAPE)).toMatch(/appears AFTER/);
  });

  test("refuses rather than passes when it cannot find what it is looking for", () => {
    // No handler at all — must not report success.
    expect(reverseHandlerRefusesBeforeEngine("export const other = 1;")).toMatch(/handler not found/);
    // Handler present, refusal absent (e.g. moved behind a helper) — fails closed.
    expect(
      reverseHandlerRefusesBeforeEngine(`${HANDLER_MARKER}\n  return ${ENGINE_CALL}ctx, cmd);\n});`)
    ).toMatch(/no GENERIC_RECEIPT_REVERSAL_REFUSED/);
    // Two engine calls — the single-call assumption is asserted, not assumed.
    expect(
      reverseHandlerRefusesBeforeEngine(
        `${HANDLER_MARKER}\n throw ${REFUSAL_TOKEN};\n ${ENGINE_CALL}a);\n ${ENGINE_CALL}b);\n});`
      )
    ).toMatch(/exactly one/);
  });
});

describe("SCRUM-254 §8 — applied to the real handler", () => {
  test("GR10 — every receipt refusal in `reverse` precedes the single engine call", () => {
    const source = fs.readFileSync(path.join(path.resolve(__dirname), "accountingLedger.ts"), "utf8");

    // Liveness: the file really is the one under test and really contains the
    // handler. Without this the analyzer could be reading something inert and
    // reporting a reason string nobody notices is about nothing.
    expect(source).toContain(HANDLER_MARKER);
    expect(source.slice(source.indexOf(HANDLER_MARKER))).toContain("requireTenantAuth");

    expect(reverseHandlerRefusesBeforeEngine(source)).toBe("ok");
  });
});
