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
 * SCRUM-249 protects the reserved `occr…` key NAMESPACE. That is a different
 * question. §2 below makes the distinction concrete: the exact derived reserved
 * key must be refused for the same reason an arbitrary operator-invented key
 * is. If key spelling changed the answer, the control would be a spelling check
 * rather than an authority boundary.
 *
 * What this ticket deliberately does NOT touch is the shared engine itself.
 * Legitimate domain code calls `reverseAccountingEvent` directly — SCRUM-130's
 * cheque-return seam in `collections.ts` is the one that matters — so §4 pins
 * that seam as a structural negative control. If a future change closes the
 * receipt door inside the engine instead of at the wrapper, §4 goes red and
 * says so, rather than SCRUM-130 silently losing its reversal authority.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
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

async function seedPostableOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
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
async function postCertifiedReceipt(suffix: string) {
  const seeded = await seedPostableOrg(suffix);
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
 * The whole economic footprint a reversal would leave, in one value.
 *
 * The owner-proxy floor is explicit that atomicity must not be inferred from
 * the thrown error: a mutation that threw after writing, or a guard placed
 * after the first effect, both still throw. So the refusal tests compare this
 * snapshot across the refused call instead of trusting the exception.
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
    return {
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
        // Deliberately outside the reserved `occr…` namespace: SCRUM-249's key
        // guard has nothing to say about this string, so anything that refuses
        // it is refusing on authority.
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

describe("SCRUM-254 §4 — the SCRUM-130 direct-engine seam is behaviorally unchanged", () => {
  test("GR4 — reverseAccountingEvent called directly on a certified receipt still reverses", async () => {
    const { t, orgId, userId, receipt } = await postCertifiedReceipt("gr4");

    // This is the shape `collections.ts`'s cheque-return path uses: the shared
    // engine, directly, with its own domain-built key. SCRUM-254 closes the
    // generic wrapper and must leave this exactly where it found it.
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

  test("GR6 — a certified receipt in ANOTHER org is not-found, and is not disclosed as a receipt", async () => {
    // The caller's own org, where they legitimately hold MANAGE_FINANCE.
    const home = await seedPostableOrg("gr6home");
    // A foreign tenant holding a certified receipt the caller must not learn about.
    const foreign = await postCertifiedReceipt("gr6foreign");

    let message = "";
    await expect(
      home.asOperator
        .mutation(internal.accountingLedger.reverse, {
          orgId: home.orgId,
          originalEventId: foreign.receipt._id,
          reversalDate: Date.now(),
          reason: "cross-tenant probe",
          idempotencyKey: "cross_org_gr6",
        })
        .catch((error: unknown) => {
          message = error instanceof Error ? error.message : String(error);
          throw error;
        })
    ).rejects.toThrow(/Accounting event not found in this organization/i);

    // The refusal must not classify a row whose tenancy the caller has not
    // established. "Not yours" is the whole answer they are entitled to.
    expect(message).not.toMatch(/certified receipt/i);
    expect(message).not.toMatch(new RegExp(RECEIPT_EVENT_TYPE, "i"));
    expect(message).not.toMatch(new RegExp(RECEIPT_SOURCE_TYPE, "i"));

    // And the foreign receipt is untouched.
    const foreignRow = await foreign.t.run((ctx) => ctx.db.get(foreign.receipt._id));
    expect(foreignRow?.status).toBe("POSTED");
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
