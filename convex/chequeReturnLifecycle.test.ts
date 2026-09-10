/**
 * SCRUM-130 — the collection/customer cleared-cheque return, as one fail-closed
 * economic lifecycle.
 *
 * A returned cleared cheque invalidates the SAME TENDER that created the
 * receipt. Every still-live economic consequence of that tender must therefore
 * be unwound exactly once — and the complete set is NOT "the initial receipt".
 * It is the initial receipt occurrence, PLUS every persisted later
 * retained-credit application occurrence, PLUS each of their canonical
 * allocation/debt effects, PLUS the residual retained 2110 position, PLUS the
 * exact canonical pending forward receipt obligation.
 *
 * The enumeration that closes that set (search surface: every non-test `.ts`
 * under `convex/` at the integration base; method: `grep -rn` on each event-type
 * constant, every candidate classified) is:
 *
 *   COLLECTION_PAYMENT / collectionPayments / <collectionPaymentId> / v1
 *     sole forward producer  postReceiptOccurrence  <- clearCheque, recordPayment
 *   RECEIPT_CREDIT_APPLIED / receiptApplications / rcapp:<n>:<movementId>:<seq> / v1
 *     sole forward producer  hookReceiptCreditApplied  <- applyRetainedCredit
 *
 * The only other `COLLECTION_PAYMENT` writer in the tree is
 * `accountingMigration.ts`, whose `sourceType` is `transactions` — explicitly
 * outside the reserved tuple (`receiptOccurrence.ts`: "posting a tuple that is
 * NOT reserved — COLLECTION_PAYMENT / transactions") and owned by SCRUM-223/231.
 * `RECEIPT_CREDIT_APPLIED` has exactly one producer. The legacy `transactions`
 * cashbook row written by `insertLedgerTransaction` is deliberately NOT unwound
 * here: it is untouched by the pre-existing return path and stays owned by
 * SCRUM-223/231 per `c17764`.
 *
 * ## What this file can and cannot prove
 *
 * ⚠️ THE STALE-WORKER RACE IS PROVABLE ONLY AS ORDERING, NEVER AS A CONFLICT.
 * `convex-test` serializes every transaction and models no OCC, so a genuine
 * write conflict between `returnClearedCheque` and `postOutboxRow` cannot be
 * produced here. The two ORDERINGS are proven — return-then-drain and
 * drain-then-return — which is a real and separate obligation, and the
 * concurrent case rests on Convex's optimistic concurrency over the exact
 * pending row rather than on anything demonstrated below. Reporting it as a
 * concurrency pass would be a false claim about what ran. This is the same
 * limitation SCRUM-218-C's §6 already declares about the retained position.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { MAX_REVOCABLE_APPLICATIONS } from "./accounting/receiptMovement";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/**
 * ⚠️ THE DRAIN SCHEDULES; IT DOES NOT POST.
 *
 * `drainPendingAccountingEvents` returns `{ scheduled: n }` and the SCRUM-222
 * worker (`claimOutboxRow` -> `postOutboxRow`) runs as scheduled work. An
 * assertion made after calling the drain alone therefore observes a world where
 * the worker never ran, and "no journal appeared" passes VACUOUSLY — which is
 * exactly how the first version of this file reported the resurrection as
 * already-fixed. `vi.useFakeTimers()` must be installed BEFORE anything
 * schedules, or the scheduler stays on the real clock and `runAllTimers` has
 * nothing to fire.
 */
afterEach(() => {
  vi.useRealTimers();
});

type TestHarness = ReturnType<typeof convexTestWithComponents<typeof schema>>;
type IdentityHarness = ReturnType<TestHarness["withIdentity"]>;

/**
 * An org with a chart, an open period for the CURRENT calendar year, and 2110.
 *
 * The open period covers this year only, so a date in a PREVIOUS year has no
 * open period and any event dated there routes to the durable outbox instead of
 * posting. That is how the tests below obtain a genuinely PENDING occurrence
 * without hand-writing an outbox row.
 */
async function seedOrg(suffix: string) {
  vi.useFakeTimers();
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Return ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `cr_${suffix}`, email: `${suffix}@cr.com`, name: "Owner" })
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
  const asAdmin = t.withIdentity({ subject: `cr_${suffix}`, clerkId: `cr_${suffix}` });
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

  // 2110 exactly as SCRUM-231's cutover must define it. LIABILITY / CREDIT is
  // the point: 1220 is ASSET / DEBIT and would make every assertion below pass
  // while the books said the opposite thing.
  await t.run((ctx) =>
    ctx.db.insert("chartOfAccounts", {
      orgId,
      code: "2110",
      name: "Unapplied Customer Receipts",
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

  // A SECOND member who can approve: `respondToApproval` refuses to let the
  // requester approve their own request, so a one-user org cannot drive the
  // real refund path at all.
  const approverId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `ap_${suffix}`, email: `ap_${suffix}@cr.com`, name: "Approver" })
  )) as Id<"users">;
  const approverRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "MANAGER",
      permissions: ["view:finance", "manage:finance", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId: approverRoleId }));
  const asApprover = t.withIdentity({ subject: `ap_${suffix}`, clerkId: `ap_${suffix}` });

  const customerId = (await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: suffix, createdAt: Date.now() })
  )) as Id<"customers">;
  return { t, asAdmin, asApprover, orgId, userId, customerId };
}

/** A date with NO open period — the previous calendar year. */
const UNPOSTABLE_DATE = Date.UTC(new Date().getUTCFullYear() - 1, 5, 1);

async function makeReceivable(
  asAdmin: IdentityHarness,
  orgId: Id<"organizations">,
  customerId: Id<"customers">,
  amount: number,
  title = "Balance due",
  // Defaults to TOMORROW. Every receivable in this suite is therefore NOT yet
  // due, which is exactly why the reopened-status defect Codex found (CX-3)
  // could hide here: an assertion of `OVERDUE` on a debt due tomorrow looks
  // like a lifecycle assertion and is really an assertion of a hardcode.
  dueDate: number = Date.now() + 86_400_000
) {
  return (await asAdmin.mutation(api.collections.createReceivable, {
    orgId, customerId, sourceType: "OTHER",
    creditSystemKey: "MISCELLANEOUS_INCOME",
    title, amount, dueDate,
  })) as Id<"receivables">;
}

/** The canonical `receivableDocuments` row mirroring a legacy receivable. */
async function canonicalFor(
  t: TestHarness,
  orgId: Id<"organizations">,
  receivableId: Id<"receivables">
) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("receivableDocuments").collect()).find(
      (d) =>
        d.orgId === orgId &&
        d.sourceType === "legacy_receivable" &&
        d.sourceId === receivableId
    )
  );
}

async function movementFor(t: TestHarness, orgId: Id<"organizations">, paymentId: Id<"collectionPayments">) {
  return await t.run((ctx) =>
    ctx.db
      .query("receiptMovements")
      .withIndex("by_org_payment", (q) => q.eq("orgId", orgId).eq("collectionPaymentId", paymentId))
      .unique()
  );
}

/** Register + clear a cheque, returning the payment and its sealed movement. */
async function clearedCheque(
  seeded: Awaited<ReturnType<typeof seedOrg>>,
  suffix: string,
  amount: number,
  receivableId?: Id<"receivables">
) {
  const chequeId = (await seeded.asAdmin.mutation(api.collections.registerCheque, {
    orgId: seeded.orgId, customerId: seeded.customerId, receivableId,
    bank: "Bank", chequeNumber: `C-${suffix}`, chequeDate: Date.now(), amount,
  })) as Id<"postDatedCheques">;
  const paymentId = (await seeded.asAdmin.mutation(api.collections.clearCheque, {
      idempotencyKey: crypto.randomUUID(),
    orgId: seeded.orgId, chequeId,
  })) as Id<"collectionPayments">;
  const movement = (await movementFor(seeded.t, seeded.orgId, paymentId))!;
  return { chequeId, paymentId, movement };
}

async function positionFor(t: TestHarness, orgId: Id<"organizations">, movementId: Id<"receiptMovements">) {
  return await t.run((ctx) =>
    ctx.db
      .query("receiptRetainedPositions")
      .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movementId))
      .unique()
  );
}

async function applicationsFor(t: TestHarness, orgId: Id<"organizations">, movementId: Id<"receiptMovements">) {
  return await t.run((ctx) =>
    ctx.db
      .query("receiptApplications")
      .withIndex("by_org_movement", (q) => q.eq("orgId", orgId).eq("receiptMovementId", movementId))
      .collect()
  );
}

async function events(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
  );
}

async function pendingRows(t: TestHarness, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.query("pendingAccountingEvents").collect()
  ).then((rows) => rows.filter((r) => r.orgId === orgId));
}

/** Net movement on one system account across EVERY journal line in the org. */
async function netOn(t: TestHarness, orgId: Id<"organizations">, systemKey: string) {
  return await t.run(async (ctx) => {
    const entries = await ctx.db
      .query("journalEntries")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .collect();
    let debit = 0;
    let credit = 0;
    for (const entry of entries) {
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
        .collect();
      for (const l of lines) {
        const account = await ctx.db.get(l.accountId);
        if (account?.systemKey === systemKey) {
          debit += l.debitMinor;
          credit += l.creditMinor;
        }
      }
    }
    return { debitMinor: debit, creditMinor: credit, netCreditMinor: credit - debit };
  });
}

/**
 * Drain AND run the worker the drain schedules. Both halves are required: see
 * the note at the top of this file about the vacuous pass.
 */
async function drain(t: TestHarness, orgId: Id<"organizations">) {
  const result = await t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return result;
}

const WORLD_TABLES = [
  "postDatedCheques", "collectionPayments", "canonicalPayments", "paymentAllocations",
  "receivables", "receivableDocuments", "accountingEvents", "journalEntries",
  "journalLines", "receiptApplications", "receiptRetainedPositions",
  "pendingAccountingEvents", "accountBalanceSnapshots",
] as const;

/**
 * Every mutable surface a fail-closed refusal must leave untouched.
 *
 * Compared as a whole rather than field by field: a refusal that is supposed to
 * produce ZERO economic delta is easiest to prove by showing the entire relevant
 * world is byte-identical, and hardest to fake.
 */
async function worldSnapshot(t: TestHarness) {
  return await t.run(async (ctx) => {
    const out: Record<string, string[]> = {};
    for (const table of WORLD_TABLES) {
      out[table] = (await ctx.db.query(table).collect())
        .map((r) => JSON.stringify(r))
        .sort();
    }
    return out;
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 * §A — THE SCRUM-249 ROUND-3 RESURRECTION (c17760 / c17763)
 *
 * canonical receipt POST still PENDING
 *   + a receipt row at the SAME reserved tuple under a FOREIGN key, POSTED
 *   -> return reverses the posted sibling, voids the payment, marks RETURNED
 *   -> canonical pending obligation SURVIVES
 *   -> a later drain publishes it and receipt GL is RESURRECTED for a returned,
 *      voided tender.
 *
 * The binding correction: cancel/supersede the exact canonical pending forward
 * receipt obligation REGARDLESS of whether a posted sibling was also found and
 * reversed. The current branch cancels only in the no-posted-event branch.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-130 §A — a returned tender cannot have its receipt resurrected", () => {
  /**
   * Builds the exact state `c17763` names.
   *
   * ⚠️ WHY THE FOREIGN ROW IS CONSTRUCTED RATHER THAN DRIVEN THROUGH A MUTATION.
   * SCRUM-249's forward guard now refuses a generic producer that tries to post
   * at the reserved tuple, so this state can no longer be MINTED — which is
   * exactly why it has to be modelled here. It represents rows written before
   * that guard existed, and the whole point of `c17763` is that the return
   * lifecycle must survive finding one, not that the posting engine should grow
   * a fourth patch. SCRUM-249 proved a "refuse every REVERSED tuple occupant"
   * proxy blocks legitimate recovery while the payment is still LIVE.
   */
  async function canonicalPendingWithForeignPostedSibling(suffix: string, amount: number) {
    const seeded = await seedOrg(suffix);
    const { chequeId, paymentId, movement } = await clearedCheque(seeded, suffix, amount);

    // The receipt posted normally. Re-key that POSTED row to a foreign,
    // non-canonical idempotency key so it is no longer reachable by the
    // canonical key, while still occupying the exact reserved tuple.
    const canonicalKey = `collection_payment_${paymentId}`;
    const posted = (await events(seeded.t, seeded.orgId)).find(
      (e) => e.idempotencyKey === canonicalKey
    )!;
    await seeded.t.run((ctx) =>
      ctx.db.patch(posted._id, { idempotencyKey: `foreign_ingress_${paymentId}` })
    );

    // ...and re-create the canonical forward obligation that `c17763` says is
    // left alive: same tuple, same canonical key, still PENDING.
    await seeded.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: seeded.orgId,
        kind: "POST" as const,
        status: "PENDING" as const,
        idempotencyKey: canonicalKey,
        accountingDate: posted.accountingDate,
        actorId: seeded.userId,
        reason: "modelled surviving canonical obligation (c17763)",
        attempts: 0,
        createdAt: Date.now(),
        eventType: posted.eventType,
        sourceType: posted.sourceType,
        sourceId: posted.sourceId,
        eventVersion: posted.eventVersion,
        occurredAt: posted.occurredAt,
        currency: posted.currency,
        payload: posted.payload,
      })
    );
    return { ...seeded, chequeId, paymentId, movement, canonicalKey, postedEventId: posted._id };
  }

  test("A1 — the canonical pending obligation is cancelled even though a posted sibling was reversed", async () => {
    const { t, asAdmin, orgId, chequeId, canonicalKey } =
      await canonicalPendingWithForeignPostedSibling("a1", 1000);

    // Precondition: both halves of the reproduced state really exist.
    expect((await pendingRows(t, orgId)).filter((r) => r.idempotencyKey === canonicalKey)).toHaveLength(1);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // THE REQUIREMENT: no eligible canonical forward receipt obligation survives.
    const survivors = (await pendingRows(t, orgId)).filter(
      (r) => r.idempotencyKey === canonicalKey && r.kind === "POST" && r.status !== "POSTED"
    );
    expect(survivors, "canonical pending receipt POST survived a cheque return").toHaveLength(0);
  });

  test("A2 — a stale drain after the return mints no new receipt journal", async () => {
    const { t, asAdmin, orgId, chequeId, paymentId } =
      await canonicalPendingWithForeignPostedSibling("a2", 1000);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    const receiptEventsBefore = (await events(t, orgId)).filter(
      (e) => e.eventType === "COLLECTION_PAYMENT" && e.sourceId === paymentId.toString()
    ).length;

    // The stale worker runs. It must find nothing eligible.
    await drain(t, orgId);

    const receiptEventsAfter = (await events(t, orgId)).filter(
      (e) => e.eventType === "COLLECTION_PAYMENT" && e.sourceId === paymentId.toString()
    );
    expect(
      receiptEventsAfter.length,
      "the drain minted a NEW receipt occurrence for a returned tender"
    ).toBe(receiptEventsBefore);
    // And none of them is live.
    expect(receiptEventsAfter.filter((e) => e.status === "POSTED")).toHaveLength(0);

    // The tender really is dead on every surface.
    const cheque = await t.run((ctx) => ctx.db.get(chequeId));
    expect(cheque!.status).toBe("RETURNED");
    const payment = await t.run((ctx) => ctx.db.get(paymentId));
    expect(payment!.status).toBe("VOIDED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §B — PER-OCCURRENCE UNWIND: a later application that is still PENDING
 *
 * Fully reachable with no constructed row: apply retained credit dated into a
 * period that is not open, and the application's own occurrence enqueues. If the
 * return only reverses POSTED occurrences, that obligation drains afterwards and
 * writes DR 2110 / CR AR for a tender the bank took back.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-130 §B — every later application occurrence is unwound, posted or not", () => {
  test("B1 — a PENDING application obligation cannot publish after the cheque is returned", async () => {
    const seeded = await seedOrg("b1");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "b1", 1000);
    expect(movement.initialUnappliedMinor).toBe(100000);

    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");
    // Dated where no period is open -> the application's occurrence ENQUEUES.
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other,
      requestedAmount: 400, appliedAt: UNPOSTABLE_DATE,
    });
    const queued = (await pendingRows(t, orgId)).filter(
      (r) => r.eventType === "RECEIPT_CREDIT_APPLIED" && r.status === "PENDING"
    );
    expect(queued, "fixture did not actually produce a PENDING application").toHaveLength(1);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // The obligation must be gone, not merely un-drained.
    expect(
      (await pendingRows(t, orgId)).filter(
        (r) => r.eventType === "RECEIPT_CREDIT_APPLIED" && r.kind === "POST" && r.status !== "POSTED"
      ),
      "a retained-credit application obligation survived the cheque return"
    ).toHaveLength(0);

    await drain(t, orgId);
    expect(
      (await events(t, orgId)).filter(
        (e) => e.eventType === "RECEIPT_CREDIT_APPLIED" && e.status === "POSTED"
      ),
      "the drain posted a retained-credit application for a returned tender"
    ).toHaveLength(0);
  });

  /**
   * The §A resurrection, on the APPLICATION axis.
   *
   * ⚠️ WRITTEN BECAUSE A MUTANT SURVIVED. Removing the unconditional cancel from
   * `revokeReceiptApplicationOccurrence` changed nothing in B1, because when an
   * application never posted, `reverseEventIfPosted` takes its NOT_POSTED branch
   * and cancels the queued row itself. B1 therefore proved the OUTCOME without
   * proving WHICH code produced it, and the unconditional cancel looked like
   * dead weight.
   *
   * It is not. The application family has exactly the receipt family's shape: a
   * POSTED row at the occurrence's tuple under a foreign key, plus the canonical
   * forward obligation still queued. `reverseEventIfPosted` then finds the posted
   * row, reverses it, returns REVERSED — and never reaches the branch that
   * cancels. The queued obligation drains afterwards and debits 2110 for a tender
   * the bank took back.
   *
   * Same construction and same justification as §A: SCRUM-249's forward guard
   * means this state can no longer be MINTED, which is precisely why the return
   * lifecycle has to survive finding one.
   */
  test("B3 — a posted application with a surviving queued obligation cannot be resurrected", async () => {
    const seeded = await seedOrg("b3");
    const { t, asAdmin, orgId, customerId, userId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "b3", 1000);

    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
    });

    const application = (await applicationsFor(t, orgId, movement._id))[0];
    const canonicalKey = application.eventIdempotencyKey;
    const posted = (await events(t, orgId)).find((e) => e.idempotencyKey === canonicalKey)!;
    expect(posted.status).toBe("POSTED");

    await t.run((ctx) =>
      ctx.db.patch(posted._id, { idempotencyKey: `foreign_ingress_${application._id}` })
    );
    await t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId,
        kind: "POST" as const,
        status: "PENDING" as const,
        idempotencyKey: canonicalKey,
        accountingDate: posted.accountingDate,
        actorId: userId,
        reason: "modelled surviving application obligation",
        attempts: 0,
        createdAt: Date.now(),
        eventType: posted.eventType,
        sourceType: posted.sourceType,
        sourceId: posted.sourceId,
        eventVersion: posted.eventVersion,
        occurredAt: posted.occurredAt,
        currency: posted.currency,
        payload: posted.payload,
      })
    );

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    expect(
      (await pendingRows(t, orgId)).filter(
        (r) => r.idempotencyKey === canonicalKey && r.kind === "POST" && r.status !== "POSTED"
      ),
      "the queued application obligation survived the return"
    ).toHaveLength(0);

    const appEventsBefore = (await events(t, orgId)).filter(
      (e) => e.eventType === "RECEIPT_CREDIT_APPLIED"
    ).length;
    await drain(t, orgId);
    const appEventsAfter = (await events(t, orgId)).filter(
      (e) => e.eventType === "RECEIPT_CREDIT_APPLIED"
    );
    expect(
      appEventsAfter.length,
      "the drain minted a NEW application occurrence for a returned tender"
    ).toBe(appEventsBefore);
    expect(appEventsAfter.filter((e) => e.status === "POSTED")).toHaveLength(0);
  });

  test("B2 — a POSTED application occurrence is reversed exactly once", async () => {
    const seeded = await seedOrg("b2");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "b2", 1000);

    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
    });
    const applied = (await events(t, orgId)).filter(
      (e) => e.eventType === "RECEIPT_CREDIT_APPLIED" && e.status === "POSTED"
    );
    expect(applied, "fixture did not actually post an application").toHaveLength(1);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    const after = (await events(t, orgId)).filter((e) => e.eventType === "RECEIPT_CREDIT_APPLIED");
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("REVERSED");

    // The persisted lineage records it, so a replay can tell the difference.
    const apps = await applicationsFor(t, orgId, movement._id);
    expect(apps).toHaveLength(1);
    expect(apps[0].status).toBe("REVERSED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §C — PER-RECEIVABLE REOPENING, and the residual 2110
 *
 * The aggregate is a conservation check, never the write amount for any one
 * debt. Two applications against two different receivables must reopen each by
 * ITS OWN persisted application amount.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-130 §C — each debt reopens by its own persisted application amount", () => {
  test("C1 — two applications, two receivables, two exact reopenings", async () => {
    const seeded = await seedOrg("c1");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "c1", 1000);
    expect(movement.initialUnappliedMinor).toBe(100000);

    const debtA = await makeReceivable(asAdmin, orgId, customerId, 300, "Debt A");
    const debtB = await makeReceivable(asAdmin, orgId, customerId, 500, "Debt B");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: debtA, requestedAmount: 300,
    });
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: debtB, requestedAmount: 500,
    });
    expect((await t.run((ctx) => ctx.db.get(debtA)))!.outstandingAmount).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(debtB)))!.outstandingAmount).toBe(0);
    expect((await positionFor(t, orgId, movement._id))!.remainingUnappliedMinor).toBe(20000);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // EXACTLY its own amount. Not the 1000 face value, not the 800 aggregate.
    expect(
      (await t.run((ctx) => ctx.db.get(debtA)))!.outstandingAmount,
      "debt A did not reopen by its own application amount"
    ).toBe(300);
    expect(
      (await t.run((ctx) => ctx.db.get(debtB)))!.outstandingAmount,
      "debt B did not reopen by its own application amount"
    ).toBe(500);

    // Both applications recorded as reversed, and the retained position is dead:
    // no 2110 balance may survive for a tender that no longer exists.
    const apps = await applicationsFor(t, orgId, movement._id);
    expect(apps.map((a) => a.status).sort()).toEqual(["REVERSED", "REVERSED"]);
    expect((await positionFor(t, orgId, movement._id))!.remainingUnappliedMinor).toBe(0);

    // GL conservation: 2110 nets to exactly zero across the whole lifecycle.
    expect(
      (await netOn(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)).netCreditMinor,
      "2110 did not net to zero after the tender was returned"
    ).toBe(0);
  });

  test("C2 — a never-applied retained receipt still leaves no live 2110", async () => {
    const seeded = await seedOrg("c2");
    const { t, asAdmin, orgId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "c2", 1000);
    expect((await positionFor(t, orgId, movement._id))!.applicationCount).toBe(0);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    expect((await positionFor(t, orgId, movement._id))!.remainingUnappliedMinor).toBe(0);
    expect(
      (await netOn(t, orgId, SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY)).netCreditMinor
    ).toBe(0);
  });

  test("C3 — a cheque applied to its own receivable reopens the persisted amount", async () => {
    const seeded = await seedOrg("c3");
    const { t, asAdmin, orgId, customerId } = seeded;
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Own debt");
    const { chequeId, movement } = await clearedCheque(seeded, "c3", 1000, debt);

    // The receipt fully discharged its own receivable, so there is no retained
    // credit at all and the reopening is driven by the sealed movement.
    expect(movement.initialAppliedMinor).toBe(100000);
    expect(movement.initialUnappliedMinor).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(debt)))!.outstandingAmount).toBe(0);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    expect((await t.run((ctx) => ctx.db.get(debt)))!.outstandingAmount).toBe(1000);
    // The FULL original balance is back and the debt is not yet due, so nothing
    // about it is either overdue or partly paid: it is OPEN.
    //
    // This assertion has now been wrong twice, in opposite directions, and both
    // times it agreed with the implementation instead of with the facts —
    // `OVERDUE` while the status was hardcoded, then `PARTIALLY_PAID` while it
    // was derived by a helper with no OPEN branch. Codex R3-STATUS-01.
    expect((await t.run((ctx) => ctx.db.get(debt)))!.status).toBe("OPEN");
    // Legacy and canonical must agree. `reverseAllocation` already computed
    // OPEN on the canonical document from `outstanding >= originalAmountMinor`;
    // a divergence here means one of the two projections is lying.
    expect((await canonicalFor(t, orgId, debt))!.status).toBe("OPEN");
  });

  test("C4 — a reopened debt's status follows its OWN due date, not the return", async () => {
    const seeded = await seedOrg("c4");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "c4", 1000);

    // One debt genuinely past due, one genuinely not. Retained credit from the
    // SAME receipt pays both, so the return reopens both through one helper.
    const pastDue = await makeReceivable(
      asAdmin, orgId, customerId, 300, "Past due", Date.now() - 86_400_000
    );
    const futureDue = await makeReceivable(
      asAdmin, orgId, customerId, 500, "Not yet due", Date.now() + 30 * 86_400_000
    );
    for (const [receivableId, requestedAmount] of [
      [pastDue, 300], [futureDue, 500],
    ] as const) {
      await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
        orgId, receiptMovementId: movement._id, receivableId, requestedAmount,
      });
    }

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // The tender bouncing says nothing about whether a THIRD-PARTY debt it
    // happened to pay is past its own due date. Writing OVERDUE onto a debt due
    // in a month misstates `collections.summary`'s overdue ageing, and — because
    // the reminder cron scans only OPEN / PARTIALLY_PAID / RESCHEDULED and
    // nothing ever transitions a row back OUT of OVERDUE — that debt then
    // receives neither a due-soon nor an overdue reminder, permanently.
    expect(
      (await t.run((ctx) => ctx.db.get(pastDue)))!.status,
      "a genuinely past-due reopened debt must read OVERDUE"
    ).toBe("OVERDUE");
    expect(
      (await t.run((ctx) => ctx.db.get(futureDue)))!.status,
      "a not-yet-due fully-restored debt must read OPEN, not OVERDUE and not PARTIALLY_PAID"
    ).toBe("OPEN");

    // Control: the amounts still reopen per-receivable, so a status fix cannot
    // be mistaken for having changed what money did.
    expect((await t.run((ctx) => ctx.db.get(pastDue)))!.outstandingAmount).toBe(300);
    expect((await t.run((ctx) => ctx.db.get(futureDue)))!.outstandingAmount).toBe(500);
  });

  test("C5 — a reopened debt with a SURVIVING payment stays PARTIALLY_PAID", async () => {
    const seeded = await seedOrg("c5");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "c5", 1000);

    // 1000 owed, 200 paid in cash, 300 covered by this cheque's retained credit.
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Mixed debt");
    await asAdmin.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receivableId: debt, amount: 200, method: "CASH", paymentDate: Date.now(),
    });
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: debt, requestedAmount: 300,
    });
    expect((await t.run((ctx) => ctx.db.get(debt)))!.outstandingAmount).toBe(500);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // The cheque's 300 comes back; the CASH 200 does not — it was a different
    // tender and this return does not touch it. So the debt is genuinely part
    // paid, and PARTIALLY_PAID is the true answer rather than a default.
    //
    // This is the control that stops "always OPEN" from passing: without a
    // surviving payment, every reopened debt would look fully restored.
    const row = (await t.run((ctx) => ctx.db.get(debt)))!;
    expect(row.outstandingAmount, "the surviving cash payment was disturbed").toBe(800);
    expect(row.outstandingAmount).toBeLessThan(row.originalAmount);
    expect(row.status, "a debt with a live payment against it is not OPEN").toBe(
      "PARTIALLY_PAID"
    );
    expect((await canonicalFor(t, orgId, debt))!.status).toBe("PARTIALLY_PAID");
  });

  test("C6 — a fully restored PAST-DUE debt reads OVERDUE, not OPEN", async () => {
    const seeded = await seedOrg("c6");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "c6", 1000);
    const debt = await makeReceivable(
      asAdmin, orgId, customerId, 400, "Past due", Date.now() - 86_400_000
    );
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: debt, requestedAmount: 400,
    });

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // Full restoration and past due at once. The due date wins: a debt that is
    // late is late whether or not anything was ever paid against it, so OVERDUE
    // must take precedence over OPEN.
    const row = (await t.run((ctx) => ctx.db.get(debt)))!;
    expect(row.outstandingAmount).toBe(400);
    expect(row.outstandingAmount).toBe(row.originalAmount);
    expect(row.status, "a past-due fully-restored debt must read OVERDUE").toBe("OVERDUE");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §D — ORDERING TRUTH TABLE (not concurrency; see the file header)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-130 §D — pending vs posted receipt, both orderings", () => {
  /** A cheque cleared into a period that is not open: the receipt only queues. */
  async function clearedIntoClosedPeriod(suffix: string, amount: number) {
    const seeded = await seedOrg(suffix);
    const chequeId = (await seeded.asAdmin.mutation(api.collections.registerCheque, {
      orgId: seeded.orgId, customerId: seeded.customerId,
      bank: "Bank", chequeNumber: `C-${suffix}`, chequeDate: UNPOSTABLE_DATE, amount,
    })) as Id<"postDatedCheques">;
    const paymentId = (await seeded.asAdmin.mutation(api.collections.clearCheque, {
      idempotencyKey: crypto.randomUUID(),
      orgId: seeded.orgId, chequeId, clearedAt: UNPOSTABLE_DATE,
    })) as Id<"collectionPayments">;
    return { ...seeded, chequeId, paymentId };
  }

  test("D1 — RETURN WINS: the queued receipt becomes ineligible and never posts", async () => {
    const { t, asAdmin, orgId, chequeId, paymentId } = await clearedIntoClosedPeriod("d1", 1000);
    const queued = (await pendingRows(t, orgId)).filter((r) => r.eventType === "COLLECTION_PAYMENT");
    expect(queued, "fixture did not queue the receipt").toHaveLength(1);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });
    await drain(t, orgId);

    expect(
      (await events(t, orgId)).filter(
        (e) => e.eventType === "COLLECTION_PAYMENT" && e.sourceId === paymentId.toString()
      ),
      "a receipt occurrence appeared for a cheque returned before it ever posted"
    ).toHaveLength(0);
  });

  test("D2 — WORKER WINS: the return reverses the now-POSTED occurrence exactly once", async () => {
    const { t, asAdmin, orgId, chequeId, paymentId } = await clearedIntoClosedPeriod("d2", 1000);

    // Open the period the receipt was dated into, then let the worker post it.
    const year = new Date().getUTCFullYear() - 1;
    await asAdmin.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      fiscalYear: year,
      periodNumber: 1,
    });
    const prior = (await asAdmin.query(api.accountingPeriods.list, { orgId })).find(
      (p) => p.fiscalYear === year
    )!;
    await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: prior._id });
    await drain(t, orgId);

    const posted = (await events(t, orgId)).filter(
      (e) => e.eventType === "COLLECTION_PAYMENT" && e.sourceId === paymentId.toString()
    );
    expect(posted, "the worker did not post the receipt").toHaveLength(1);
    expect(posted[0].status).toBe("POSTED");

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    const after = (await events(t, orgId)).filter(
      (e) => e.eventType === "COLLECTION_PAYMENT" && e.sourceId === paymentId.toString()
    );
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("REVERSED");
  });

  /**
   * ⚠️ A NEW INTERACTION THIS TICKET INTRODUCES, NOT AN INHERITED ONE.
   *
   * The old return wrote its reversal under `cheque_return_after_clear_<id>`,
   * which sits OUTSIDE SCRUM-249's reserved namespace and therefore never met
   * that ticket's reversal-side guard. Deriving the key moves it INSIDE the
   * namespace (`occr…`), so a DEFERRED reversal — enqueued because no period was
   * open, drained later — now passes through `reverseAccountingEvent`'s reserved
   * check on its way to the ledger.
   *
   * That check recomputes the sanctioned key from the ORIGINAL EVENT'S OWN
   * persisted columns. Reasoning says it must agree with the key the facade
   * derived from the same occurrence. Reasoning is not evidence: if it disagreed,
   * every deferred cheque-return reversal would refuse on drain and dead-letter,
   * with the tender already marked RETURNED — the money would stay reversed in
   * intent and un-reversed in the ledger, forever.
   */
  test("D3 — a DEFERRED reversal survives SCRUM-249's reserved-key guard on drain", async () => {
    const seeded = await seedOrg("d3");
    const { t, asAdmin, orgId, customerId } = seeded;
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Own debt");
    const { chequeId, paymentId } = await clearedCheque(seeded, "d3", 1000, debt);

    const posted = (await events(t, orgId)).find(
      (e) => e.eventType === "COLLECTION_PAYMENT" && e.sourceId === paymentId.toString()
    )!;
    expect(posted.status).toBe("POSTED");

    // Close the period so the reversal defers rather than posting inline.
    const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
    await asAdmin.mutation(api.accountingPeriods.close, { orgId, periodId: period._id });

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    const deferred = (await pendingRows(t, orgId)).filter((r) => r.kind === "REVERSE");
    expect(deferred, "the reversal did not defer").toHaveLength(1);
    // It really is in the reserved namespace — otherwise this test proves nothing
    // about the guard it exists to exercise.
    expect(deferred[0].idempotencyKey.startsWith("occr")).toBe(true);

    // Reopen and let the worker run it through the guard.
    await asAdmin.mutation(api.accountingPeriods.reopen, {
      orgId, periodId: period._id, reason: "drain the deferred cheque-return reversal",
    });
    await drain(t, orgId);

    expect(
      (await t.run((ctx) => ctx.db.get(posted._id)))!.status,
      "the deferred reversal never reached the ledger — it was refused or dead-lettered"
    ).toBe("REVERSED");
    expect(
      (await pendingRows(t, orgId)).filter((r) => r.kind === "REVERSE" && r.status === "FAILED")
    ).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §E — REPLAY AND CONTRADICTION
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-130 §E — an exact replay is one return; a changed command is a conflict", () => {
  test("E1 — replaying the same return key reverses once and reopens once", async () => {
    const seeded = await seedOrg("e1");
    const { t, asAdmin, orgId, customerId } = seeded;
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Own debt");
    const { chequeId } = await clearedCheque(seeded, "e1", 1000, debt);

    await asAdmin.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, idempotencyKey: "return-e1",
    });
    await asAdmin.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, idempotencyKey: "return-e1",
    });

    expect((await t.run((ctx) => ctx.db.get(debt)))!.outstandingAmount).toBe(1000);
    expect(
      (await events(t, orgId)).filter((e) => e.eventType === "JOURNAL_REVERSAL"),
      "an exact replay produced a second reversal"
    ).toHaveLength(1);
  });

  test("E2 — the same key with different economics is refused", async () => {
    const seeded = await seedOrg("e2");
    const { asAdmin, orgId } = seeded;
    const { chequeId } = await clearedCheque(seeded, "e2", 1000);

    await asAdmin.mutation(api.collections.returnClearedCheque, {
      orgId, chequeId, idempotencyKey: "return-e2", bankFeeMinor: 500,
    });
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, {
        orgId, chequeId, idempotencyKey: "return-e2", bankFeeMinor: 900,
      })
    ).rejects.toThrow();
  });

  test("E3 — returning an already-returned cheque refuses", async () => {
    const seeded = await seedOrg("e3");
    const { asAdmin, orgId } = seeded;
    const { chequeId } = await clearedCheque(seeded, "e3", 1000);

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/only cleared cheques/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §F — FAIL-CLOSED BOUNDARIES: refund interaction, contradictory lineage,
 *      the application-owned cheque that belongs to SCRUM-239, and a lineage
 *      too large to unwind in one transaction.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Pads a movement's lineage to exactly `total` application ROWS by cloning the
 * real one as already-REVERSED siblings.
 *
 * REVERSED deliberately: the unwind skips them, so the ONLY thing they change
 * is the row count the plan has to read. That is precisely the property under
 * test — the bound is a READ bound, so it must count rows irrespective of
 * whether they are still live. Driving 100+ real `applyRetainedCredit` calls
 * would test the same guard far more slowly and prove nothing extra about it.
 */
async function padLineage(
  t: TestHarness,
  orgId: Id<"organizations">,
  movementId: Id<"receiptMovements">,
  total: number
) {
  await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("receiptApplications")
      .withIndex("by_org_movement", (q) =>
        q.eq("orgId", orgId).eq("receiptMovementId", movementId)
      )
      .collect();
    const template = rows[0];
    if (!template) throw new Error("padLineage needs one real application to clone");
    for (let i = rows.length; i < total; i++) {
      const { _id, _creationTime, ...rest } = template;
      await ctx.db.insert("receiptApplications", {
        ...rest,
        sequence: 1000 + i,
        status: "REVERSED",
        eventIdempotencyKey: `${rest.eventIdempotencyKey}:pad${i}`,
      });
    }
  });
}

describe("SCRUM-130 §F — boundaries refuse with zero economic delta", () => {
  test("F1 — a refund that reversed this receipt's allocation blocks the return", async () => {
    const seeded = await seedOrg("f1");
    const { t, asAdmin, asApprover, orgId, customerId } = seeded;
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Own debt");
    const { chequeId } = await clearedCheque(seeded, "f1", 1000, debt);

    // The real refund path: request, then approve. `reverseAllocationsForRefund`
    // reverses the receipt's own persisted allocation, newest first.
    const requestId = await asAdmin.mutation(api.collections.requestApproval, {
      orgId, receivableId: debt, requestType: "REFUND",
      requestedAmount: 400, disbursementMethod: "BANK_TRANSFER", reason: "customer refund",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      idempotencyKey: crypto.randomUUID(),
      orgId, requestId, status: "APPROVED",
    });

    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION/);
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);
  });

  test("F2 — an application-owned cheque is routed to SCRUM-239, not unwound here", async () => {
    const seeded = await seedOrg("f2");
    const { t, asAdmin, orgId, customerId, userId } = seeded;

    // `applications.confirmDisbursement` (applications.ts) clears an
    // application-owned cheque through `markChequeClearedCore` ONLY: no
    // `collectionPayments` mirror, no customer receivable, and — per its own
    // comment — "a cheque that bounces after this point is not yet handled".
    // The resulting STATE is modelled here rather than driving the whole finance
    // fixture; what matters to this control is the shape `returnClearedCheque`
    // receives, and every row below is schema-valid.
    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "Bank", isActive: true,
        profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 1,
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_F2", make: "Honda", model: "Civic", year: 2021,
        mileage: 0, color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE",
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000,
        totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT",
        companyId, createdBy: userId, createdAt: Date.now(),
      })
    );
    const applicationId = await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId, quoteId, salespersonId: userId,
        status: "CLOSED", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const chequeId = (await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId, customerId, applicationId,
        bank: "Bank", chequeNumber: "C-f2", chequeDate: Date.now(), amount: 1000,
        status: "CLEARED", clearedAt: Date.now(),
        createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    )) as Id<"postDatedCheques">;

    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/finance application/i);
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);
  });

  /**
   * DEFECT 1 FROM THE TICKET ITSELF — the guard asymmetry.
   *
   * The old handler guarded the ENTIRE GL/allocation reversal on `clearedPayment`
   * and then reopened `outstandingAmount` OUTSIDE that guard, unconditionally. So
   * with the mirror row absent the cheque was marked RETURNED, the reversal was
   * skipped, and the debt reopened anyway: the same money simultaneously OWED on
   * the legacy row and COLLECTED on its canonical twin, with no throw, no log and
   * no operator signal.
   *
   * The reversal and the reopening are two halves of one movement. Either both
   * execute or the mutation fails closed — a reopening that outlives its reversal
   * is a guard that fails open. Mutant M11 restores the old shape and this test
   * must fail.
   */
  test("F4 — with the mirror row severed, the debt does not reopen on its own", async () => {
    const seeded = await seedOrg("f4");
    const { t, asAdmin, orgId, customerId } = seeded;
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Own debt");
    const { chequeId, paymentId } = await clearedCheque(seeded, "f4", 1000, debt);

    // Sever the mirror row, exactly as the ticket's Defect 1 describes.
    await t.run((ctx) => ctx.db.delete(paymentId));

    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/owed and collected at the same time/i);
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);

    // The specific corruption, named: the debt did NOT reopen while the reversal
    // was skipped.
    expect((await t.run((ctx) => ctx.db.get(debt)))!.outstandingAmount).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(chequeId)))!.status).toBe("CLEARED");
  });

  test("F5 — a mirror row with no sealed receipt lineage refuses rather than guessing", async () => {
    const seeded = await seedOrg("f5");
    const { t, asAdmin, orgId, customerId } = seeded;
    const debt = await makeReceivable(asAdmin, orgId, customerId, 1000, "Own debt");
    const { chequeId, paymentId } = await clearedCheque(seeded, "f5", 1000, debt);

    // Pre-SCRUM-218-C shape: a mirror row whose receipt was never sealed, so
    // what the receipt moved cannot be enumerated from anything.
    const movement = (await movementFor(t, orgId, paymentId))!;
    await t.run((ctx) => ctx.db.delete(movement._id));

    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/no persisted receipt lineage/i);
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);
  });

  test("F3 — a contradictory application lineage refuses before any write", async () => {
    const seeded = await seedOrg("f3");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "f3", 1000);
    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
    });

    // The application row says APPLIED while its allocation is already REVERSED.
    const apps = await applicationsFor(t, orgId, movement._id);
    await t.run((ctx) => ctx.db.patch(apps[0].allocationId, { status: "REVERSED" as const }));

    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION/);
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);
  });

  test("F6 — a lineage AT the bound still returns (the green control for F7)", async () => {
    const seeded = await seedOrg("f6");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "f6", 1000);
    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
    });
    await padLineage(t, orgId, movement._id, MAX_REVOCABLE_APPLICATIONS);

    // Exactly at the bound: no refusal, and the real application still unwinds.
    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });
    expect((await t.run((ctx) => ctx.db.get(other)))!.outstandingAmount).toBe(400);
    expect((await t.run((ctx) => ctx.db.get(chequeId)))!.status).toBe("RETURNED");
  });

  test("F7 — a lineage OVER the bound refuses by name, before any write", async () => {
    const seeded = await seedOrg("f7");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "f7", 1000);
    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
    });
    await padLineage(t, orgId, movement._id, MAX_REVOCABLE_APPLICATIONS + 1);

    // One row past the bound — the ONLY difference from F6. Without this the
    // unwind is O(N) reads, writes, allocation reversals and accounting
    // reversals in one mutation, and a large enough lineage rolls the whole
    // return back identically on every retry, with the tender physically
    // returned and its receipt, debts and GL effects all still live.
    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/CHEQUE_RETURN_LINEAGE_TOO_LARGE/);
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);
  });

  /**
   * F8 — the CONSERVATION check, added during RC integration (SCRUM-313).
   *
   * ⚠️ WHY IT WAS MISSING, AND WHY IT IS NOT A FIXTURE WRITTEN TO PASS.
   *
   * A mutation battery on the surviving guards found `planReceiptRevocation`'s
   * conservation check — "the applications may never have moved more than the
   * receipt retained" — SURVIVING: deleting it changed no test. The check is
   * genuinely UNREACHABLE through the sanctioned writer, and that was verified
   * rather than assumed: `recordRetainedApplication` refuses when
   * `amountMinor > fresh.remainingUnappliedMinor`, and that residue is
   * decremented per application, so the live applications of one movement can
   * never sum past `initialUnappliedMinor`.
   *
   * A survivor that means "unreachable" is not evidence of a gap. But a
   * fail-closed guard whose firing nobody has ever observed is a claim in prose,
   * and this one guards the case the whole ticket exists for: a lineage that
   * CONTRADICTS ITSELF, which is a pre-cutover-data concern rather than a
   * writer concern. So the contradictory state is built directly — the only way
   * it can be built — and the guard is required to refuse with zero delta.
   *
   * The clone is APPLIED, not REVERSED, which is the one thing that separates
   * this from `padLineage`: a REVERSED sibling is skipped by the plan and
   * contributes nothing to the total, so it could never trip this check.
   */
  test("F8 — a lineage that moved more than the receipt retained refuses, before any write", async () => {
    const seeded = await seedOrg("f8");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "f8", 1000);
    expect(movement.initialUnappliedMinor).toBe(100000);

    const other = await makeReceivable(asAdmin, orgId, customerId, 600, "Other debt");
    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 600,
    });

    // Clone the one real application as a second LIVE sibling. 60000 + 60000
    // exceeds the 100000 the receipt retained, which no sequence of
    // `applyRetainedCredit` calls could ever produce.
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("receiptApplications")
        .withIndex("by_org_movement", (q) =>
          q.eq("orgId", orgId).eq("receiptMovementId", movement._id)
        )
        .collect();
      const template = rows.find((r) => r.status === "APPLIED");
      if (!template) throw new Error("F8 needs one live application to clone");
      const { _id, _creationTime, ...rest } = template;
      void _id;
      void _creationTime;
      await ctx.db.insert("receiptApplications", {
        ...rest,
        sequence: rest.sequence + 1000,
        eventIdempotencyKey: `${rest.eventIdempotencyKey}:f8clone`,
      });
    });

    const before = await worldSnapshot(t);
    await expect(
      asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
    ).rejects.toThrow(/CHEQUE_RETURN_UNSUPPORTED_REFUND_INTERACTION/);
    // The refusal escapes uncaught, so nothing partial committed. In Convex an
    // uncaught throw rolls the whole mutation back; a CAUGHT one would have
    // committed every write made before it.
    expect(await worldSnapshot(t), "the refusal was not zero-delta").toEqual(before);
    expect((await t.run((ctx) => ctx.db.get(chequeId)))!.status).toBe("CLEARED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * §G — POSITIVE CONTROLS: the ordinary paths must keep working.
 * ═══════════════════════════════════════════════════════════════════════════ */

describe("SCRUM-130 §G — the ordinary lifecycle is untouched", () => {
  test("G1 — an ordinary receipt and a later application still post normally", async () => {
    const seeded = await seedOrg("g1");
    const { t, asAdmin, orgId, customerId } = seeded;
    const { movement } = await clearedCheque(seeded, "g1", 1000);
    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");

    await asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
      orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
    });

    expect((await t.run((ctx) => ctx.db.get(other)))!.outstandingAmount).toBe(0);
    expect((await positionFor(t, orgId, movement._id))!.remainingUnappliedMinor).toBe(60000);
    expect(
      (await events(t, orgId)).filter(
        (e) => e.eventType === "RECEIPT_CREDIT_APPLIED" && e.status === "POSTED"
      )
    ).toHaveLength(1);
  });

  test("G2 — applying retained credit after the return is refused", async () => {
    const seeded = await seedOrg("g2");
    const { asAdmin, orgId, customerId } = seeded;
    const { chequeId, movement } = await clearedCheque(seeded, "g2", 1000);
    const other = await makeReceivable(asAdmin, orgId, customerId, 400, "Other debt");

    await asAdmin.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId });

    // The causal check is the load-bearing guard: the receipt occurrence is
    // REVERSED, so it is no longer on the books and nothing can be drawn from it.
    await expect(
      asAdmin.mutation(api.collections.applyRetainedCredit, {
      idempotencyKey: crypto.randomUUID(),
        orgId, receiptMovementId: movement._id, receivableId: other, requestedAmount: 400,
      })
    ).rejects.toThrow();
  });
});
