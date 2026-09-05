/**
 * SCRUM-218-C — evidence for the direct-collection receipt movement model.
 *
 * Covers the floor owner-proxy `c17653` fixed BEFORE the implementation existed,
 * so the tests are not chosen to fit the patch:
 *
 *   1  exact debt receipt          full AR, zero 2110                    §1
 *   2  no-receivable receipt       zero AR line, full 2110 liability     §2
 *   3  missing/malformed 2110      receipt survives, zero GL             §3
 *   4  later application           exact 2110 -> AR, no second receipt   §4
 *   5  exact replay                no duplicate allocation/decrement     §5
 *   6  concurrent applications     no retained-position overdraft        §6
 *   7  1220 / deposit lineage      cannot masquerade as 2110 authority   §7
 *   8  persisted 237 snapshot      rehydrates through the sanctioned door §8
 *   9  WeakSet authority           never persisted or module-cached      §9
 *
 * ⚠️ ITEM 6 IS PARTLY UNAVAILABLE, NOT PASSED. `convex-test` serializes every
 * transaction and models no OCC, so a genuine write-conflict cannot be produced
 * here. §6 therefore proves the SEQUENTIAL overdraft guard — which is a real and
 * separate obligation — and states plainly that the concurrent case rests on
 * Convex's optimistic concurrency over the single position row rather than on
 * anything this file demonstrates. Reporting it as a concurrency pass would be a
 * false claim about what ran.
 *
 * ⚠️ THE DEFAULT CHART DOES NOT CONTAIN 2110, AND THAT IS DELIBERATE. Seeding it
 * is a SCRUM-231 cutover decision. Tests that need it seed it explicitly with the
 * exact classification c17653 fixed — LIABILITY / CREDIT — which also means §3
 * gets its "missing account" state for free from `chartOfAccounts.initialize`
 * rather than by deleting a row and hoping that models the real gap.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import {
  rehydrateReceiptOccurrence,
  toReceiptOccurrenceSnapshot,
  directCollectionReceipt,
  RECEIPT_PAYLOAD_VERSION,
} from "./accounting/receiptOccurrence";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;
/** What `t.withIdentity(...)` returns — no `withIdentity`/`registerComponent`. */
type IdentityHarness = ReturnType<TestHarness["withIdentity"]>;

async function seedOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Movement ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `rm_${suffix}`, email: `${suffix}@rm.com`, name: "Owner" })
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
      orgId, currency: "USD", currencySymbol: "$",
      enabledPaymentTypes: ["CASH", "CHEQUE", "BANK_TRANSFER"],
    })
  );
  const asAdmin = t.withIdentity({ subject: `rm_${suffix}`, clerkId: `rm_${suffix}` });
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
  return { t, asAdmin, orgId, userId, customerId };
}

/**
 * Seed 2110 exactly as SCRUM-231's cutover must, so these tests exercise the
 * classification that will actually exist rather than a convenient stand-in.
 * LIABILITY / CREDIT is the whole point: 1220 is ASSET / DEBIT and would make
 * every assertion below pass while the books said the opposite thing.
 */
async function seedRetainedCreditAccount(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.insert("chartOfAccounts", {
      orgId,
      code: "2110",
      name: "Unapplied Customer Receipts",
      nameAr: "مقبوضات عملاء غير مطبقة",
      type: "LIABILITY",
      normalBalance: "CREDIT",
      isControlAccount: true,
      allowManualPosting: false,
      active: true,
      systemKey: SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
}

async function makeReceivable(
  asAdmin: IdentityHarness,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  amount: number
) {
  return (await asAdmin.mutation(api.collections.createReceivable, {
    orgId,
    customerId,
    sourceType: "OTHER",
    // `OTHER` is deliberately ambiguous in `resolveReceivableCreditKey`, so the
    // credit account must be stated rather than defaulted to income.
    creditSystemKey: "MISCELLANEOUS_INCOME",
    title: "Balance due",
    amount,
    dueDate: Date.now() + 86_400_000,
  })) as Id<"receivables">;
}

/** Journal lines for one source, resolved to their system keys. */
async function linesBySystemKey(
  t: TestHarness,
  orgId: Id<"organizations">,
  sourceType: string,
  sourceId: string
) {
  return await t.run(async (ctx) => {
    const entries = await ctx.db
      .query("journalEntries")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", sourceType).eq("sourceId", sourceId)
      )
      .collect();
    const out: Array<{ systemKey: string | undefined; debitMinor: number; creditMinor: number }> = [];
    for (const entry of entries) {
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
        .collect();
      for (const l of lines) {
        const account = await ctx.db.get(l.accountId);
        out.push({
          systemKey: account?.systemKey,
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
        });
      }
    }
    return out;
  });
}

async function movementFor(t: TestHarness, orgId: Id<"organizations">, paymentId: Id<"collectionPayments">) {
  return await t.run((ctx) =>
    ctx.db
      .query("receiptMovements")
      .withIndex("by_org_payment", (q) => q.eq("orgId", orgId).eq("collectionPaymentId", paymentId))
      .unique()
  );
}

async function positionFor(t: TestHarness, orgId: Id<"organizations">, movementId: Id<"receiptMovements">) {
  return await t.run((ctx) =>
    ctx.db
      .query("receiptRetainedPositions")
      .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movementId))
      .unique()
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §1 — FLOOR ITEM 1: a receipt against a real debt credits AR and nothing else
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §1 — receipt that fully discharges a receivable", () => {
  test("credits Customer AR in full and touches 2110 not at all", async () => {
    const { t, asAdmin, orgId, customerId } = await seedOrg("s1");
    await seedRetainedCreditAccount(t, orgId);
    const receivableId = await makeReceivable(asAdmin, orgId, customerId, 100);

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, receivableId, amount: 100, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    const movement = await movementFor(t, orgId, paymentId);
    expect(movement).not.toBeNull();
    expect(movement!.receivedMinor).toBe(10000);
    expect(movement!.initialAppliedMinor).toBe(10000);
    expect(movement!.initialUnappliedMinor).toBe(0);
    expect(movement!.liabilityTreatment).toBe("NONE");
    // Lineage is the exact allocation this movement created, not a re-derivation.
    expect(movement!.initialAllocationIds).toHaveLength(1);

    // No retained credit means NO position row. An absent row and a drawn-down
    // row are different facts and must stay distinguishable.
    expect(await positionFor(t, orgId, movement!._id)).toBeNull();

    const lines = await linesBySystemKey(t, orgId, "collectionPayments", paymentId.toString());
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.systemKey === SYSTEM_KEYS.CASH_ON_HAND)?.debitMinor).toBe(10000);
    expect(
      lines.find((l) => l.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)?.creditMinor
    ).toBe(10000);
    // The zero leg is OMITTED, not emitted as 0/0 — `validateBalance` rejects a
    // both-zero line, so emitting one would dead-letter the event and make the
    // receipt permanently unpostable.
    expect(
      lines.some((l) => l.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)
    ).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §2 — FLOOR ITEM 2: the defect this ticket exists to fix
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §2 — receipt with no receivable", () => {
  /**
   * THE REGRESSION THIS TICKET IS ABOUT. Before the change this receipt credited
   * ACCOUNTS_RECEIVABLE_CUSTOMERS by the full amount — relief of a debt that was
   * never raised, driving the AR control account credit-negative. The assertion
   * that the AR line is ABSENT is what fails against the old rule.
   */
  test("credits 2110 in full and writes no AR line at all", async () => {
    const { t, asAdmin, orgId, customerId } = await seedOrg("s2");
    await seedRetainedCreditAccount(t, orgId);

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: 60, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    const movement = await movementFor(t, orgId, paymentId);
    expect(movement!.receivedMinor).toBe(6000);
    expect(movement!.initialAppliedMinor).toBe(0);
    expect(movement!.initialUnappliedMinor).toBe(6000);
    expect(movement!.liabilityTreatment).toBe("UNAPPLIED_CUSTOMER_RECEIPTS");
    expect(movement!.initialAllocationIds).toHaveLength(0);
    expect(movement!.receiptPayloadVersion).toBe(RECEIPT_PAYLOAD_VERSION);

    const position = await positionFor(t, orgId, movement!._id);
    expect(position!.initialUnappliedMinor).toBe(6000);
    expect(position!.remainingUnappliedMinor).toBe(6000);
    expect(position!.applicationCount).toBe(0);

    const lines = await linesBySystemKey(t, orgId, "collectionPayments", paymentId.toString());
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.systemKey === SYSTEM_KEYS.CASH_ON_HAND)?.debitMinor).toBe(6000);
    expect(
      lines.find((l) => l.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.creditMinor
    ).toBe(6000);
    expect(lines.some((l) => l.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §3 — FLOOR ITEM 3: the receipt must survive an unmapped 2110
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §3 — 2110 missing at receipt time", () => {
  /**
   * The CRITICAL that ended round 3, now covered. `shouldPost` only asks whether
   * the org has a chart AT ALL, so without the narrow precondition this receipt
   * posts synchronously, `resolveSystemAccount` throws inside the mutation,
   * nothing catches it, and Convex rolls back money the customer actually
   * handed over.
   *
   * No 2110 is seeded here — `chartOfAccounts.initialize` genuinely does not
   * create one, so this is the real gap rather than a simulated one.
   */
  test("receipt, movement and position all survive with ZERO general ledger effect", async () => {
    const { t, asAdmin, orgId, customerId } = await seedOrg("s3");

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: 40, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    // Operationally final.
    expect(await t.run((ctx) => ctx.db.get(paymentId))).not.toBeNull();
    const movement = await movementFor(t, orgId, paymentId);
    expect(movement!.initialUnappliedMinor).toBe(4000);
    expect((await positionFor(t, orgId, movement!._id))!.remainingUnappliedMinor).toBe(4000);

    // ...and accounting-wise, nothing.
    expect(await linesBySystemKey(t, orgId, "collectionPayments", paymentId.toString())).toHaveLength(0);
    const events = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(events).toHaveLength(0);

    // The obligation is DURABLE and lives in SCRUM-222's existing outbox — this
    // ticket invents no new HOLD state (owner-proxy c17653).
    const pending = await t.run((ctx) =>
      ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("PENDING");
    expect(pending[0].reason).toContain("UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY");
  });

  /**
   * POSITIVE CONTROL for the test above. Its zeros only carry information if the
   * SAME org and code path produce a journal once the account exists — otherwise
   * "no lines" could mean "nothing posts here at all" and the assertion would be
   * vacuous.
   */
  test("positive control — the identical receipt DOES post once 2110 exists", async () => {
    const { t, asAdmin, orgId, customerId } = await seedOrg("s3pc");
    await seedRetainedCreditAccount(t, orgId);

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: 40, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    expect(await linesBySystemKey(t, orgId, "collectionPayments", paymentId.toString())).toHaveLength(2);
  });

  /** A receipt needing no 2110 must not be held hostage by its absence. */
  test("a fully-applied receipt still posts when 2110 is absent", async () => {
    const { t, asAdmin, orgId, customerId } = await seedOrg("s3fa");
    const receivableId = await makeReceivable(asAdmin, orgId, customerId, 25);

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, receivableId, amount: 25, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    const lines = await linesBySystemKey(t, orgId, "collectionPayments", paymentId.toString());
    expect(lines).toHaveLength(2);
    expect(
      lines.find((l) => l.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)?.creditMinor
    ).toBe(2500);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §4 — FLOOR ITEM 4: the later application
 * ═══════════════════════════════════════════════════════════════════════════ */

async function retainedCreditFixture(suffix: string, receiptAmount = 100) {
  const seeded = await seedOrg(suffix);
  await seedRetainedCreditAccount(seeded.t, seeded.orgId);
  const paymentId = (await seeded.asAdmin.mutation(api.collections.recordPayment, {
    orgId: seeded.orgId, customerId: seeded.customerId,
    amount: receiptAmount, method: "CASH", paymentDate: Date.now(),
  })) as Id<"collectionPayments">;
  const movement = (await movementFor(seeded.t, seeded.orgId, paymentId))!;
  return { ...seeded, paymentId, movement };
}

describe("SCRUM-218-C §4 — applying retained credit", () => {
  test("transfers 2110 to AR exactly, with no second cash receipt", async () => {
    const { t, asAdmin, orgId, customerId, movement } = await retainedCreditFixture("s4");
    const receivableId = await makeReceivable(asAdmin, orgId, customerId, 30);

    const result = await asAdmin.mutation(api.collections.applyRetainedCredit, {
      orgId, receiptMovementId: movement._id, receivableId, requestedAmount: 30,
    });
    expect(result.appliedMinor).toBe(3000);
    expect(result.sequence).toBe(1);

    const application = await t.run((ctx) => ctx.db.get(result.applicationId));
    expect(application!.amountMinor).toBe(3000);
    expect(application!.status).toBe("APPLIED");

    const position = await positionFor(t, orgId, movement._id);
    expect(position!.remainingUnappliedMinor).toBe(7000);
    expect(position!.applicationCount).toBe(1);

    const lines = await linesBySystemKey(
      t, orgId, "receiptApplications", application!.occurrence.sourceId
    );
    expect(lines).toHaveLength(2);
    expect(
      lines.find((l) => l.systemKey === SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)?.debitMinor
    ).toBe(3000);
    expect(
      lines.find((l) => l.systemKey === SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS)?.creditMinor
    ).toBe(3000);
    // NO cash or bank line. The money arrived at receipt time; a cash line here
    // would record the customer paying twice.
    expect(lines.some((l) => l.systemKey === SYSTEM_KEYS.CASH_ON_HAND)).toBe(false);
    expect(lines.some((l) => l.systemKey === SYSTEM_KEYS.BANK_ACCOUNT)).toBe(false);

    // The receivable it discharged actually moved.
    expect((await t.run((ctx) => ctx.db.get(receivableId)))!.outstandingAmount).toBe(0);
  });

  test("applications #1, #2 and #3 are three distinct economic occurrences", async () => {
    const { t, asAdmin, orgId, customerId, movement } = await retainedCreditFixture("s4multi");
    const sequences: number[] = [];
    for (const amount of [10, 20, 30]) {
      const receivableId = await makeReceivable(asAdmin, orgId, customerId, amount);
      const r = await asAdmin.mutation(api.collections.applyRetainedCredit, {
        orgId, receiptMovementId: movement._id, receivableId, requestedAmount: amount,
      });
      sequences.push(r.sequence);
    }
    expect(sequences).toEqual([1, 2, 3]);

    const applications = await t.run((ctx) =>
      ctx.db
        .query("receiptApplications")
        .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movement._id))
        .collect()
    );
    expect(applications).toHaveLength(3);
    // Distinct identities — a shared tuple is how the second one gets swallowed.
    expect(new Set(applications.map((a) => a.occurrence.sourceId)).size).toBe(3);
    expect(new Set(applications.map((a) => a.eventIdempotencyKey)).size).toBe(3);

    // Three separate journals, not one.
    const events = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "RECEIPT_CREDIT_APPLIED"))
        .collect()
    );
    expect(events).toHaveLength(3);
    expect((await positionFor(t, orgId, movement._id))!.remainingUnappliedMinor).toBe(4000);
  });

  test("refuses a credit whose receipt has not reached the ledger", async () => {
    // No 2110, so the receipt's own event is queued and never POSTED.
    const { asAdmin, orgId, customerId, t } = await seedOrg("s4np");
    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: 50, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;
    const movement = (await movementFor(t, orgId, paymentId))!;
    await seedRetainedCreditAccount(t, orgId);
    const receivableId = await makeReceivable(asAdmin, orgId, customerId, 10);

    await expect(
      asAdmin.mutation(api.collections.applyRetainedCredit, {
        orgId, receiptMovementId: movement._id, receivableId, requestedAmount: 10,
      })
    ).rejects.toThrow(/has not reached the general ledger/i);
  });

  /**
   * A refusal must ESCAPE the money mutation, not be caught and committed.
   *
   * In Convex a caught exception COMMITS every write made before it, so the
   * hazard is not theoretical: an allocation, an application row and a drawn-down
   * position could all survive while the journal refused, leaving the credit
   * spent with no accounting behind it. Nothing in `applyRetainedCredit` catches,
   * and this asserts the observable consequence rather than the absence of a
   * `try`.
   */
  test("a refused application leaves NO partial economic state", async () => {
    const { t, asAdmin, orgId, movement } = await retainedCreditFixture("s4rb");
    const otherCustomer = (await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Wrong", lastName: "Party", createdAt: Date.now() })
    )) as Id<"customers">;
    const receivableId = await makeReceivable(asAdmin, orgId, otherCustomer, 25);

    const allocationsBefore = await t.run((ctx) =>
      ctx.db.query("paymentAllocations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );

    await expect(
      asAdmin.mutation(api.collections.applyRetainedCredit, {
        orgId, receiptMovementId: movement._id, receivableId, requestedAmount: 25,
      })
    ).rejects.toThrow();

    // No child movement, no allocation, and the position is untouched.
    const applications = await t.run((ctx) =>
      ctx.db
        .query("receiptApplications")
        .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movement._id))
        .collect()
    );
    expect(applications).toHaveLength(0);

    const allocationsAfter = await t.run((ctx) =>
      ctx.db.query("paymentAllocations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(allocationsAfter).toHaveLength(allocationsBefore.length);

    const position = await positionFor(t, orgId, movement._id);
    expect(position!.remainingUnappliedMinor).toBe(movement.initialUnappliedMinor);
    expect(position!.applicationCount).toBe(0);

    // POSITIVE CONTROL — the zeros above only mean something if a LEGITIMATE
    // application against this same fixture does move all three.
    const { customerId } = movement;
    const good = await makeReceivable(asAdmin, orgId, customerId, 25);
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      orgId, receiptMovementId: movement._id, receivableId: good, requestedAmount: 25,
    });
    const after = await positionFor(t, orgId, movement._id);
    expect(after!.applicationCount).toBe(1);
    expect(after!.remainingUnappliedMinor).toBe(movement.initialUnappliedMinor - 2500);
  });

  /**
   * ⚠️ WHAT THIS PROVES, PRECISELY. Deleting the guard in `applyRetainedCredit`
   * does NOT make a cross-customer application succeed — `allocatePaymentToReceivable`
   * independently refuses a payer/receivable customer mismatch, and with the
   * guard removed that is the error that surfaces instead.
   *
   * So this is a defence-in-depth assertion, not a sole-barrier one: it pins that
   * the refusal happens HERE, before any write and with an error naming the
   * actual problem, rather than several calls later from a module whose message
   * describes a payment allocation. Both matter — but claiming the money could
   * move without this check would be false, and the mutant that removes it kills
   * this test for the message, not for a missing refusal.
   */
  test("refuses another customer's receivable", async () => {
    const { t, asAdmin, orgId, movement } = await retainedCreditFixture("s4xc");
    const otherCustomer = (await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Other", lastName: "Party", createdAt: Date.now() })
    )) as Id<"customers">;
    const receivableId = await makeReceivable(asAdmin, orgId, otherCustomer, 10);

    await expect(
      asAdmin.mutation(api.collections.applyRetainedCredit, {
        orgId, receiptMovementId: movement._id, receivableId, requestedAmount: 10,
      })
    ).rejects.toThrow(/different customer/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §5 — FLOOR ITEM 5: exact replay
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §5 — exact replay of one application", () => {
  test("same idempotency key produces ONE allocation, ONE decrement, ONE journal", async () => {
    const { t, asAdmin, orgId, customerId, movement } = await retainedCreditFixture("s5");
    const receivableId = await makeReceivable(asAdmin, orgId, customerId, 40);
    const args = {
      orgId, receiptMovementId: movement._id, receivableId,
      requestedAmount: 40, idempotencyKey: "retry-me",
    };

    const first = await asAdmin.mutation(api.collections.applyRetainedCredit, args);
    const second = await asAdmin.mutation(api.collections.applyRetainedCredit, args);
    expect(second.applicationId).toBe(first.applicationId);

    const applications = await t.run((ctx) =>
      ctx.db
        .query("receiptApplications")
        .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movement._id))
        .collect()
    );
    expect(applications).toHaveLength(1);
    expect((await positionFor(t, orgId, movement._id))!.remainingUnappliedMinor).toBe(6000);

    const allocations = await t.run((ctx) =>
      ctx.db.query("paymentAllocations").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(allocations).toHaveLength(1);

    const events = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "RECEIPT_CREDIT_APPLIED"))
        .collect()
    );
    expect(events).toHaveLength(1);
  });

  test("the same key with a different amount is a contradiction, not a retry", async () => {
    const { asAdmin, orgId, customerId, movement } = await retainedCreditFixture("s5fp");
    const receivableId = await makeReceivable(asAdmin, orgId, customerId, 40);
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      orgId, receiptMovementId: movement._id, receivableId,
      requestedAmount: 40, idempotencyKey: "same-key",
    });
    await expect(
      asAdmin.mutation(api.collections.applyRetainedCredit, {
        orgId, receiptMovementId: movement._id, receivableId,
        requestedAmount: 10, idempotencyKey: "same-key",
      })
    ).rejects.toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §6 — FLOOR ITEM 6: no overdraft of the retained position
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §6 — the retained position cannot be overdrawn", () => {
  /**
   * ⚠️ SEQUENTIAL, AND SAID SO. `convex-test` serializes every transaction and
   * models no OCC, so the genuinely CONCURRENT case cannot be produced in this
   * harness. What protects it in production is that both applications read and
   * write the SAME single position row, so Convex's optimistic concurrency
   * retries the loser against the updated remaining balance. That is a design
   * property this file does not demonstrate, and calling this test a concurrency
   * pass would be a false claim about what ran.
   */
  test("a second application cannot spend more than remains", async () => {
    const { t, asAdmin, orgId, customerId, movement } = await retainedCreditFixture("s6", 50);
    const first = await makeReceivable(asAdmin, orgId, customerId, 30);
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      orgId, receiptMovementId: movement._id, receivableId: first, requestedAmount: 30,
    });

    // 20 remains. Ask for 40 against a 40 receivable: capped to 20, never 40.
    const second = await makeReceivable(asAdmin, orgId, customerId, 40);
    const result = await asAdmin.mutation(api.collections.applyRetainedCredit, {
      orgId, receiptMovementId: movement._id, receivableId: second, requestedAmount: 40,
    });
    expect(result.appliedMinor).toBe(2000);

    const position = await positionFor(t, orgId, movement._id);
    expect(position!.remainingUnappliedMinor).toBe(0);

    // Exhausted: a third attempt has nothing to give.
    const third = await makeReceivable(asAdmin, orgId, customerId, 10);
    await expect(
      asAdmin.mutation(api.collections.applyRetainedCredit, {
        orgId, receiptMovementId: movement._id, receivableId: third, requestedAmount: 10,
      })
    ).rejects.toThrow(/nothing to apply/i);

    // Conservation across the whole lifecycle: what was retained equals what was
    // applied plus what remains.
    const applications = await t.run((ctx) =>
      ctx.db
        .query("receiptApplications")
        .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movement._id))
        .collect()
    );
    const applied = applications.reduce((sum, a) => sum + a.amountMinor, 0);
    expect(applied + position!.remainingUnappliedMinor).toBe(movement.initialUnappliedMinor);
  });

  test("an application is capped by the receivable's outstanding balance too", async () => {
    const { asAdmin, orgId, customerId, movement } = await retainedCreditFixture("s6cap", 100);
    const small = await makeReceivable(asAdmin, orgId, customerId, 15);
    const result = await asAdmin.mutation(api.collections.applyRetainedCredit, {
      orgId, receiptMovementId: movement._id, receivableId: small, requestedAmount: 90,
    });
    expect(result.appliedMinor).toBe(1500);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §7 — FLOOR ITEM 7: foreign lineage cannot masquerade as retained credit
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §7 — 1220 and deposit lineage are not 2110 authority", () => {
  /**
   * A customer DEPOSIT is also a settled inbound payment with no allocation. Any
   * design that inferred "unallocated, therefore unapplied receipt" would treat
   * it as retained credit and let it discharge a receivable against the wrong
   * liability. Authority here is a receiptMovements ROW, so a deposit simply has
   * none — there is nothing to infer from.
   */
  test("a settled unallocated deposit payment creates no retained position", async () => {
    const { t, orgId, userId } = await seedOrg("s7");
    const customer = (await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Dep", lastName: "Ositor", createdAt: Date.now() })
    )) as Id<"customers">;
    await t.run((ctx) =>
      ctx.db.insert("canonicalPayments", {
        orgId, direction: "IN", payerType: "CUSTOMER", customerId: customer,
        method: "CASH", amountMinor: 50000, currency: "USD", scale: 2,
        status: "SETTLED", idempotencyKey: "deposit_masquerade", createdBy: userId,
        createdAt: Date.now(),
      })
    );

    const positions = await t.run((ctx) =>
      ctx.db.query("receiptRetainedPositions").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(positions).toHaveLength(0);
    const movements = await t.run((ctx) =>
      ctx.db.query("receiptMovements").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(movements).toHaveLength(0);
  });

  /**
   * 1220 is ASSET / DEBIT and is a different account entirely. The posting rule
   * names 2110 by system key, so seeding only 1220 leaves the receipt unpostable
   * rather than quietly booking a customer credit as a dealership asset.
   */
  test("seeding only 1220 does NOT satisfy the retained-credit requirement", async () => {
    const { t, asAdmin, orgId, customerId } = await seedOrg("s7legacy");
    const legacy = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) =>
          q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.UNAPPLIED_CUSTOMER_CASH)
        )
        .unique()
    );
    // The default chart really does carry 1220, so this is a genuine confusion
    // risk rather than a hypothetical one.
    expect(legacy).not.toBeNull();
    expect(legacy!.type).toBe("ASSET");
    expect(legacy!.normalBalance).toBe("DEBIT");

    const paymentId = (await asAdmin.mutation(api.collections.recordPayment, {
      orgId, customerId, amount: 20, method: "CASH", paymentDate: Date.now(),
    })) as Id<"collectionPayments">;

    expect(await linesBySystemKey(t, orgId, "collectionPayments", paymentId.toString())).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §8 / §9 — FLOOR ITEMS 8 AND 9: the persisted identity boundary
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-218-C §8 — the stored snapshot is data, and rehydration is the only door", () => {
  test("the persisted occurrence rehydrates to the identity that posted it", async () => {
    const { t, orgId, movement, paymentId } = await retainedCreditFixture("s8");
    const stored = movement.occurrence;
    expect(Object.keys(stored).sort()).toEqual(
      ["eventType", "eventVersion", "sourceId", "sourceType"]
    );

    const rehydrated = rehydrateReceiptOccurrence({ orgId, snapshot: stored });
    const minted = directCollectionReceipt({ orgId, paymentId });
    expect(toReceiptOccurrenceSnapshot(rehydrated)).toEqual(toReceiptOccurrenceSnapshot(minted));
    expect(await t.run(async () => true)).toBe(true);
  });

  test("a tampered snapshot is refused rather than repaired", async () => {
    const { orgId, movement } = await retainedCreditFixture("s8bad");
    // Cross-family: a deposits snapshot must not become a collection receipt by
    // being read back out of a row.
    expect(() =>
      rehydrateReceiptOccurrence({
        orgId,
        snapshot: { ...movement.occurrence, sourceType: "deposits" },
      })
    ).toThrow(/outside this contract/i);
    // An extra field is refused, not silently dropped.
    expect(() =>
      rehydrateReceiptOccurrence({
        orgId,
        snapshot: { ...movement.occurrence, channel: "DIRECT" },
      })
    ).toThrow(/unrecognised field/i);
  });
});

describe("SCRUM-218-C §9 — runtime authority is never persisted or cached", () => {
  const SOURCES = [
    "./accounting/receiptMovement.ts",
    "./collections.ts",
  ].map((rel) => ({
    rel,
    text: readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
  }));

  test("no module-scope cache of a receipt identity exists", () => {
    for (const { rel, text } of SOURCES) {
      const moduleScope = text
        .split("\n")
        .filter((l) => /^(const|let|var)\s/.test(l))
        .join("\n");
      expect(moduleScope, `${rel} caches an identity at module scope`).not.toMatch(
        /directCollectionReceipt|rehydrateReceiptOccurrence/
      );
    }
  });

  test("the persisted row stores the snapshot, never the branded identity", async () => {
    const { movement } = await retainedCreditFixture("s9");
    // A branded identity carries a symbol-keyed property; a snapshot must not.
    expect(Object.getOwnPropertySymbols(movement.occurrence)).toHaveLength(0);
    // ...and it carries no orgId, so a row copied between tenants cannot bring a
    // foreign tenant with it.
    expect("orgId" in movement.occurrence).toBe(false);
  });
});
