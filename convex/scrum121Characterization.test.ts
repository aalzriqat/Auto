/**
 * SCRUM-121A-PRE — the regression suite for collection target correlation and
 * cancellation authority.
 *
 * ## What these tests are, and how to read a name
 *
 * This began as a CHARACTERIZATION file: every test asserted what `main` did
 * today, including where that was the defect, to satisfy one rule — a
 * behavioural finding is a claim until it is reproduced, and code-reasoning
 * alone is not reproduction.
 *
 * FOURTEEN of them have since been INVERTED. Each was written against unfixed
 * code, asserting the defect; each FAILED the moment its fix landed; each was
 * then flipped to assert the correct behaviour. That sequence is the
 * failing-first evidence for its defect, and the comment at each inversion
 * records it. `EV1` was RE-BASED rather than inverted (see below), and
 * `CODEXR6` is failing-first without being an inversion: it was written to
 * assert a refusal, run against the unfixed code, and observed to fail.
 *
 * The count was stated as eleven for several hours, in this header and in the
 * published record, without ever being recounted — a figure repeated from
 * memory rather than re-derived, which is the same failure this ticket has hit
 * before with enumerations.
 *
 * So it is written to be reconcilable rather than trusted: `grep -n INVERTED`
 * returns SEVENTEEN lines — fourteen fixture markers, two in this header, and
 * one on R3-04's control. If those three numbers stop adding up, the header is
 * wrong and the fixtures are right. They keep their original names (`D1`, `F4`, `EV4`, `CODEX121A02`
 * …) because those names are how the design document, the reviewer findings and
 * the Jira record refer to them; renaming would silently orphan that trail.
 *
 * The `FLOOR_*` tests are different and are labelled so in their own block:
 * they were written AFTER the implementation, so they are not failing-first
 * evidence. They pin branches of the new rules that no inverted fixture
 * reaches.
 *
 * Two fixtures assert defects that are still OPEN and belong to SCRUM-218 —
 * `EV1` (a reversal under a cancelled document resurrects it to PAID) and `D6`.
 * Both are explicitly marked, and `EV1` first proves that the route by which a
 * public caller could reach that state is now closed.
 *
 * Right-reason evidence: every guard added by this change was mutated
 * individually and killed by the single named test above, run in isolation.
 */
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const DUE = () => Date.now() + 7 * 24 * 60 * 60 * 1000;

/**
 * Every table a Collections money path can write. A refusal must leave all of
 * them byte-identical — that is what "atomic refusal" means, and asserting only
 * the obvious table is how a partial write survives a green test.
 *
 * `commandIdempotency` is in the list deliberately: `runWithIdempotency` inserts
 * a STARTED row BEFORE running the body, so a refusal that somehow committed
 * would leave that row behind and permanently poison the key.
 */
const MONEY_TABLES = [
  "receivables",
  "collectionPayments",
  "postDatedCheques",
  "receivableDocuments",
  "canonicalPayments",
  "paymentAllocations",
  "transactions",
  "accountingEvents",
  "pendingAccountingEvents",
  "commandIdempotency",
  "collectionApprovalRequests",
  // PRE-04 (Codex, round 4): omitting this made "whole money world" blind to a
  // payment intent being inserted or having its status/links rewritten — and
  // the intent tests are exactly where that matters.
  "paymentIntents",
] as const;

/**
 * A stable, order-independent snapshot of the whole money world.
 *
 * Sorted by `_id` because Convex does not promise scan order, and an unsorted
 * snapshot would produce false differences that get "fixed" by loosening the
 * assertion — which would silently disarm every zero-write test that depends
 * on it.
 */
async function snapshotMoneyWorld(t: ReturnType<typeof convexTestWithComponents>) {
  return await t.run(async (ctx) => {
    const world: Record<string, unknown[]> = {};
    for (const table of MONEY_TABLES) {
      const rows = await ctx.db.query(table as never).collect();
      world[table] = (rows as { _id: string }[])
        .slice()
        .sort((a, b) => String(a._id).localeCompare(String(b._id)));
    }
    return JSON.stringify(world);
  });
}

async function seedFinanceMember(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Collections Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "c121_user", email: "u@example.com", name: "Finance User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "c121_approver", email: "a@example.com", name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Finance Manager",
      permissions: ["view:finance", "manage:finance", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );

  return {
    orgId,
    userId,
    approverId,
    customerId,
    asFinance: t.withIdentity({ subject: "c121_user", clerkId: "c121_user" }),
    asApprover: t.withIdentity({ subject: "c121_approver", clerkId: "c121_approver" }),
  };
}

describe("SCRUM-121 characterization of current main", () => {
  /**
   * D1 — a contradictory payer identity is silently discarded, not refused.
   *
   * The control is the second half: the payment is not merely accepted, it is
   * recorded against the receivable's customer, proving the caller's stated
   * customer was dropped rather than merged or ignored harmlessly.
   */
  test("D1_contradictory_payer_identity_is_silently_preferred_not_refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId: customerA, asFinance } = await seedFinanceMember(t);

    const customerB = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Haddad", phone: "+962790000111" })
    );

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId: customerA,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment 1",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // The caller names customer A's debt and customer B as the payer. These
    // describe two different debts.
    //
    // INVERTED by §3.1. This asserted that main recorded the payment against A
    // and dropped B with no error and no audit trace; it failed the moment the
    // refusal landed, which is the failing-first proof for this defect.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        receivableId,
        customerId: customerB,
        amount: 300,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/Payment customer does not match the receivable customer/i);

    // CONTROL — the identical call naming the RIGHT customer still succeeds, so
    // the refusal is caused by the contradiction itself and not by supplying a
    // customerId alongside a receivable at all.
    const paymentId = await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      customerId: customerA,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
    });

    await t.run(async (ctx) => {
      const payment = await ctx.db.get(paymentId);
      expect(payment?.customerId).toBe(customerA);
      const canonical = payment?.canonicalPaymentId ? await ctx.db.get(payment.canonicalPaymentId) : null;
      expect(canonical?.customerId).toBe(customerA);
    });
  });

  /**
   * D3 — an overpayment against a proven row is refused outright, rather than
   * applied to the row's outstanding with the remainder retained unapplied.
   *
   * Control: the same call at exactly the outstanding amount succeeds, so the
   * rejection is caused by the excess and not by the fixture.
   */
  test("D3_overpayment_is_refused_instead_of_capped_and_retained", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const overpaid = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment A",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        receivableId: overpaid,
        amount: 1500,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/cannot exceed the outstanding receivable amount/i);

    // Nothing was retained: no payment row at all, so the 1500 has nowhere to live.
    await t.run(async (ctx) => {
      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_receivable", (q) => q.eq("receivableId", overpaid))
        .collect();
      expect(payments).toHaveLength(0);
    });

    // CONTROL — exact amount is accepted, so the refusal above is the excess.
    const exact = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Installment B",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        receivableId: exact,
        amount: 1000,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).resolves.toBeTruthy();
  });

  /**
   * D10 — CORRECTED MECHANISM.
   *
   * I published this as "invisible from every list but still payable by id",
   * citing the `!row.isDeleted` filter at collections.ts:562. That filter belongs
   * to `listReceivablesDueBetween` — the CALENDAR query — not to
   * `listReceivables`, which is the main list and applies no such filter. The
   * first run of this test disproved the "invisible" half.
   *
   * The true defect is inconsistency, not concealment: soft-delete is honoured
   * by the calendar, ignored by the main list, and checked by NO money path.
   * A withdrawn debt therefore stays visible, stays payable, and disappears only
   * from the one surface that would have made it look withdrawn.
   */
  test("D10_soft_delete_is_honoured_by_the_calendar_ignored_by_the_list_and_by_every_money_path", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Withdrawn installment",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await t.run((ctx) => ctx.db.patch(receivableId, { isDeleted: true, deletedAt: Date.now() }));

    // The MAIN list still shows it — no isDeleted filter here.
    const listed = await asFinance.query(api.collections.listReceivables, {
      orgId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(listed.page.some((r: { _id: string }) => r._id === receivableId)).toBe(true);

    // The CALENDAR excludes it — the one surface that does honour soft-delete.
    const calendar = await asFinance.query(api.collections.listReceivablesDueBetween, {
      orgId,
      startDate: Date.now() - 24 * 60 * 60 * 1000,
      endDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    expect(calendar.some((r: { _id: string }) => r._id === receivableId)).toBe(false);

    // INVERTED by §3.3's forward guard: no longer payable by id. This asserted
    // that the money path ignored soft-delete entirely (the third clause of this
    // test's own name) and failed when the guard landed.
    //
    // Worth stating precisely, because it changes what a surviving mutant here
    // would mean: no PRODUCTION writer sets isDeleted on a receivable, so the
    // guard is unreachable through the real doors — but this fixture constructs
    // the state directly, so the guard is genuinely executed and a mutation of
    // it is killed rather than surviving as unreachable code.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        receivableId,
        amount: 250,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).rejects.toThrow(/receivable has been removed/i);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.outstandingAmount).toBe(1000); // untouched by the refusal
      expect(row?.isDeleted).toBe(true);
    });
  });

  /**
   * D6 — CORRECTED, AND DOWNGRADED TO LATENT BY THIS TEST.
   *
   * I originally published D6 as a LIVE workflow dead-end on the strength of
   * reading `ensureCanonicalReceivableForLegacy` being called at payment time.
   * The first run of this test disproved that: `createReceivable` calls it
   * EAGERLY at collections.ts:664-667, and so does `createInstallmentPlan` at
   * :771 — and those are the only two writers of the `receivables` table. On
   * fresh data every receivable therefore owns a canonical document from birth,
   * with originalAmountMinor == originalAmount and zero allocations, which is
   * correct at that moment. The payment-time call is a FALLBACK that fresh data
   * never reaches.
   *
   * The divergence mechanism is still real: the fallback derives the opening
   * balance from originalAmount regardless of what has already been collected.
   * But it is reachable only for rows that predate the bridge — production data
   * the owner has ruled disposable and out of scope. For the fresh-data
   * authority this work has to prove, D6 is LATENT, not live.
   *
   * The pre-bridge state is therefore CONSTRUCTED DIRECTLY below, and this test
   * is labelled a forward guard rather than a reproduction of a live path.
   *
   * Control: the request itself is accepted, so the failure is in the approval
   * path's canonical unwind and not in refund eligibility.
   */
  test("D6_LATENT_refund_on_a_constructed_pre_bridge_receivable_dead_ends_at_approval", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Legacy installment",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // CONSTRUCTED pre-bridge state: 600 collected historically, and the
    // eagerly-created canonical document removed along with its link, which is
    // what a row created before the bridge existed looks like. Constructed
    // directly precisely because no current writer can produce it.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.canonicalReceivableDocumentId).toBeTruthy(); // eager creation, proven
      if (row?.canonicalReceivableDocumentId) {
        await ctx.db.delete(row.canonicalReceivableDocumentId);
      }
      await ctx.db.patch(receivableId, {
        outstandingAmount: 400,
        status: "PARTIALLY_PAID",
        canonicalReceivableDocumentId: undefined,
      });
    });

    // CONTROL — the request is accepted, so refund eligibility is not the blocker.
    const requestId = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 300,
      disbursementMethod: "CASH",
      reason: "Customer overpaid on a legacy plan",
    });
    expect(requestId).toBeTruthy();

    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/Canonical allocations cover only 0 of the requested refund/i);
  });

  /**
   * F4 — Sonnet MAX's finding, validated here rather than accepted.
   *
   * `registerChequeCore` checks orgId and customerId on the receivable and NOT
   * its status, so a cheque can be registered against an already-CANCELLED
   * receivable. `returnCheque` then gates only on `status !== "PAID"`, so
   * CANCELLED passes and the row is rewritten to OVERDUE — a closed debt back
   * in an active, collectible status.
   *
   * Control: the same returnCheque call against a PAID receivable leaves it
   * PAID, proving the resurrection is caused by the missing CANCELLED case in
   * that guard and not by returnCheque touching every row it sees.
   */
  test("F4_cancelled_receivable_is_resurrected_to_OVERDUE_via_cheque_registration_and_return", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "To be cancelled",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const cancelRequest = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelRequest,
      status: "APPROVED",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.status).toBe("CANCELLED");
      expect(row?.outstandingAmount).toBe(0);
    });

    // INVERTED by §3.3. This registered a cheque against the cancelled debt and
    // asserted the row came back as OVERDUE after the return; it failed the
    // moment DEBT_CLOSED landed. The resurrection is now prevented one step
    // earlier — at registration, where no money has moved — rather than at the
    // return, where an instrument already exists.
    await expect(
      asFinance.mutation(api.collections.registerCheque, {
        orgId,
        receivableId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "990001",
        chequeDate: DUE(),
        amount: 400,
      })
    ).rejects.toThrow(/closed and cannot accept a new cheque/i);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.status).toBe("CANCELLED"); // stays closed
      expect(row?.outstandingAmount).toBe(0);
    });

    // CONTROL, REBUILT — the point of a control is to prove the refusal is
    // specific. The old one registered a cheque against a PAID receivable, which
    // the same guard now also refuses, so it can no longer separate anything.
    //
    // The live question after this change is the opposite one, and §3.3 names it
    // explicitly: returnCheque must keep reopening genuinely collectible rows.
    // So the control is an OPEN receivable taking the identical registration and
    // return, and coming back collectible.
    const openId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Still collectible",
      amount: 500,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const openCheque = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId: openId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "990002",
      chequeDate: DUE(),
      amount: 400,
    });
    await asFinance.mutation(api.collections.returnCheque, { orgId, chequeId: openCheque });
    await t.run(async (ctx) => {
      const row = await ctx.db.get(openId);
      expect(["OPEN", "OVERDUE", "PARTIALLY_PAID"]).toContain(row?.status);
      expect(row?.outstandingAmount).toBe(500);
    });

    // …and a PAID row still refuses the registration, which is the terminal
    // case the old control was really asserting.
    const paidId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Fully paid",
      amount: 500,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId: paidId,
      amount: 500,
      method: "CASH",
      paymentDate: Date.now(),
    });
    await expect(
      asFinance.mutation(api.collections.registerCheque, {
        orgId,
        receivableId: paidId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "990003",
        chequeDate: DUE(),
        amount: 400,
      })
    ).rejects.toThrow(/closed and cannot accept a new cheque/i);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(paidId))?.status).toBe("PAID");
    });
  });

  /**
   * B5 WITHDRAWN — Sonnet MAX's counter-claim, validated here.
   *
   * I published that `clearCheque` has no terminal guard and therefore
   * resurrects a CANCELLED row through `applyPostedPayment`. It cannot. The
   * only production writer of legacy CANCELLED (collections.ts:1652-1656) sets
   * `outstandingAmount: 0` in the SAME patch, and every cheque amount is
   * strictly positive, so `clearCheque`'s amount guard (`cheque.amount >
   * receivable.outstandingAmount`) is `positive > 0` and always throws first.
   *
   * That is the same arithmetic defence I credited for cell A12 and denied to
   * B5 — an inconsistency in my own document. The guard is still absent; it is
   * simply not reachable.
   */
  test("B5_WITHDRAWN_clearCheque_cannot_resurrect_a_cancelled_row_the_amount_guard_fires_first", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled then cleared",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "990003",
      chequeDate: DUE(),
      amount: 400,
    });
    // Cancellation refuses while a HELD cheque exists, so return it first.
    await asFinance.mutation(api.collections.returnCheque, { orgId, chequeId });

    const cancelRequest = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelRequest,
      status: "APPROVED",
    });

    // INVERTED by §3.3, and the conclusion is now stronger than when this was
    // written. B5 argued clearCheque could not resurrect a CANCELLED row because
    // the amount guard always fired first — a defence that rested entirely on
    // arithmetic. The state it had to construct to make that argument is no
    // longer constructible: registering the second cheque is refused outright,
    // so the clearCheque path is unreachable a step earlier and no longer
    // depends on that arithmetic holding.
    await expect(
      asFinance.mutation(api.collections.registerCheque, {
        orgId,
        receivableId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "990004",
        chequeDate: DUE(),
        amount: 400,
      })
    ).rejects.toThrow(/closed and cannot accept a new cheque/i);

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.status).toBe("CANCELLED"); // never resurrected by this path
    });
  });

  /**
   * D9 — a caller-supplied internal accounting document is stored unvalidated
   * when no receivable id accompanies it, and the resulting settlement can only
   * fail. A provider that has already confirmed the money retries into the same
   * deterministic throw.
   *
   * The foreign-org document is a real row in another org, so this reproduces
   * the tenancy case rather than a merely malformed id.
   *
   * Control: an intent created the same way but WITHOUT the foreign document id
   * settles cleanly, proving the failure is caused by the unvalidated target.
   */
  test("D9_unvalidated_client_supplied_document_makes_a_confirmed_receipt_unrecordable", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);

    // A real receivable document belonging to a DIFFERENT organization.
    const foreignOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Rival Dealer", createdAt: Date.now() })
    );
    const foreignDocId = await t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId: foreignOrgId,
        documentType: "INVOICE",
        documentNumber: "RIVAL-0001",
        payerType: "CUSTOMER",
        sourceType: "legacy_receivable",
        sourceId: "rival-source",
        originalAmountMinor: 500_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: DUE(),
        status: "OPEN",
        createdAt: Date.now(),
        createdBy: userId,
      })
    );

    // INVERTED by §4. This asserted that create accepted the foreign document
    // with no existence check and no orgId comparison, and that the resulting
    // settlement could only throw — destroying a receipt the provider had
    // already confirmed. It failed the moment the target proof landed.
    //
    // The refusal has moved to the free side of the funds boundary: no intent is
    // created, so there is never a confirmed receipt with nowhere to live.
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId,
        customerId,
        receivableDocumentId: foreignDocId,
        amountMinor: 100_000,
        currency: "JOD",
        provider: "stripe",
      })
    ).rejects.toThrow(/Receivable document not found/i);

    await t.run(async (ctx) => {
      const intents = await ctx.db
        .query("paymentIntents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(intents).toHaveLength(0); // nothing was stored to fail later
    });

    // CONTROL — same intent shape without the unvalidated document settles.
    const cleanIntentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "stripe",
    });
    await expect(
      asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId: cleanIntentId })
    ).resolves.toBeNull();

    await t.run(async (ctx) => {
      const clean = await ctx.db.get(cleanIntentId);
      expect(clean?.status).toBe("SETTLED");
      // The control receipt DID land as a canonical payment; the foreign-target
      // one above did not. That difference is caused by the unvalidated target.
      const payments = await ctx.db
        .query("canonicalPayments")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(payments).toHaveLength(1);
    });
  });
});

/**
 * Every GL command a path queues, normalized and ordered so it can be compared
 * as a value. No chart is seeded in these fixtures, so `postOrEnqueue` durably
 * enqueues instead of posting — and the PAYLOAD is what the posting rule
 * consumes, so the payload set is the GL claim.
 */
async function accountingCommands(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">
) {
  return await t.run(async (ctx) => {
    // `ReturnType<typeof convexTestWithComponents>` erases the schema type
    // argument, so `ctx.db` here only knows system indexes. Scan and narrow
    // in JS rather than widening the helper's signature — the fixtures are
    // tiny and this keeps the helper usable from any test.
    const rows = (await ctx.db.query("pendingAccountingEvents" as never).collect()) as unknown as Array<{
      orgId: string;
      eventType: string;
      sourceType: string;
      currency: string;
      payload: unknown;
    }>;
    return rows
      .filter((r) => r.orgId === orgId)
      .map((r) => ({
        eventType: r.eventType,
        sourceType: r.sourceType,
        amountMinor: (r.payload as { amountMinor?: number })?.amountMinor ?? null,
        currency: r.currency,
      }))
      .sort((a, b) =>
        `${a.eventType}:${a.sourceType}:${a.amountMinor}`.localeCompare(
          `${b.eventType}:${b.sourceType}:${b.amountMinor}`
        )
      );
  });
}

/**
 * GOLDEN GL BASELINES — captured from current main BEFORE any 121A code exists.
 *
 * SCRUM-121A's defining constraint is that no change may alter any monetary
 * amount posted to the general ledger. That is only provable against a baseline
 * recorded beforehand; measuring it afterwards would compare the implementation
 * to itself.
 *
 * These assertions are deliberately exact values rather than shape checks. If
 * an implementation moves any amount, the diff names the path and the number.
 *
 * ⚠️ These encode what main DOES, including where it is wrong. The 160-against-100
 * baseline below is the reproduced CODEX-01 overstatement, and it must stay
 * exactly that until SCRUM-218 changes it deliberately. A 121A change that
 * "improves" it is out of scope and must fail here.
 */
describe("SCRUM-121A — golden GL baselines from current main", () => {
  test("recordPayment queues one AR credit for the paid amount", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Baseline cash",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const baseline = await accountingCommands(t, orgId);

    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 300,
      method: "CASH",
      paymentDate: Date.now(),
    });

    const after = await accountingCommands(t, orgId);
    const key = (c: unknown) => JSON.stringify(c);
    const added = after.filter((c) => !baseline.some((b) => key(b) === key(c)));
    // Removal-aware, for the reason G4 demonstrates: an additions-only delta
    // reads a cancelled pending post as "no GL effect". These two paths are
    // purely additive, and that is now asserted rather than assumed.
    expect(baseline.filter((b) => !after.some((c) => key(c) === key(b)))).toEqual([]);
    expect(added).toEqual([
      { eventType: "COLLECTION_PAYMENT", sourceType: "collectionPayments", amountMinor: 300_000, currency: "JOD" },
    ]);
  });

  test("clearCheque queues one AR credit for the cheque face amount", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Baseline cheque",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "BASE-1",
      chequeDate: DUE(),
      amount: 400,
    });
    const baseline = await accountingCommands(t, orgId);

    await asFinance.mutation(api.collections.clearCheque, { orgId, chequeId });

    const after = await accountingCommands(t, orgId);
    const key = (c: unknown) => JSON.stringify(c);
    const added = after.filter((c) => !baseline.some((b) => key(b) === key(c)));
    // Removal-aware, for the reason G4 demonstrates: an additions-only delta
    // reads a cancelled pending post as "no GL effect". These two paths are
    // purely additive, and that is now asserted rather than assumed.
    expect(baseline.filter((b) => !after.some((c) => key(c) === key(b)))).toEqual([]);
    expect(added).toEqual([
      { eventType: "COLLECTION_PAYMENT", sourceType: "collectionPayments", amountMinor: 400_000, currency: "JOD" },
    ]);
  });

  test("payment-link settlement queues the GROSS receipt — the CODEX-01 baseline 218 must change, not 121A", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Baseline link",
      amount: 100,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "stripe",
    });
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 60,
      method: "CASH",
      paymentDate: Date.now(),
    });
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const commands = await accountingCommands(t, orgId);
    const money = commands.filter(
      (c) => c.eventType === "COLLECTION_PAYMENT" || c.eventType === "PAYMENT_LINK_RECEIVED"
    );
    // 60 applied by cash + 100 GROSS for the link whose allocation was only 40.
    expect(money).toEqual([
      { eventType: "COLLECTION_PAYMENT", sourceType: "collectionPayments", amountMinor: 60_000, currency: "JOD" },
      { eventType: "PAYMENT_LINK_RECEIVED", sourceType: "paymentIntents", amountMinor: 100_000, currency: "JOD" },
    ]);
  });
});

/**
 * Proves the technique 121A's verification floor rests on, BEFORE eight refusal
 * codes are built on top of it. If the snapshot cannot distinguish a write from
 * a no-write, every zero-write test in the stage would pass vacuously.
 *
 * Positive control included deliberately: an ACCEPTED payment must make the
 * snapshot differ. Without that, a snapshot helper that always returned a
 * constant would pass the zero-write half and prove nothing at all.
 */
describe("SCRUM-121A — whole-world zero-write harness", () => {
  test("a refused call leaves every money table byte-identical, and an accepted one does not", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Zero-write probe",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const before = await snapshotMoneyWorld(t);

    // REFUSED — an overpayment, with an idempotency key so the STARTED row in
    // commandIdempotency would also have to roll back.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        receivableId,
        amount: 5000,
        method: "CASH",
        paymentDate: Date.now(),
        idempotencyKey: "zero-write-probe-1",
      })
    ).rejects.toThrow();

    const afterRefusal = await snapshotMoneyWorld(t);
    expect(afterRefusal).toBe(before);

    // POSITIVE CONTROL — an accepted payment must move the world, or the
    // assertion above is vacuous.
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 250,
      method: "CASH",
      paymentDate: Date.now(),
      idempotencyKey: "zero-write-probe-2",
    });

    const afterAccept = await snapshotMoneyWorld(t);
    expect(afterAccept).not.toBe(before);
  });
});

describe("SCRUM-121A — Sonnet MAX F1, validated independently", () => {
  /**
   * F1 — the REFUNDED sibling of CODEX-04, and it is strictly worse.
   *
   * CANCELLED zeroes outstandingAmount in the same patch, so a late settlement
   * applies min(amount, 0) = 0 — an inert ghost row and a wrong label. REFUND
   * *increases* outstandingAmount back toward the original, so the identical
   * code path applies a NONZERO amount: a real payment row, a real GL post, and
   * the loss of the REFUNDED terminal label.
   *
   * Control: the CANCELLED variant (CODEX04, in this same file) exercises the
   * same code path with the same missing terminal check and produces applied=0.
   * The difference is purely the arithmetic each terminal writer leaves behind,
   * which isolates outstandingAmount — not the missing check — as the reason
   * this variant moves money.
   */
  test("F1_late_intent_settles_against_a_REFUNDED_receivable_and_applies_real_money", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Refunded then settled",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // A payment link is raised while the debt is live, and stays PENDING.
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "stripe",
    });

    // The customer pays 600 in cash, then the whole 600 is refunded.
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 600,
      method: "CASH",
      paymentDate: Date.now(),
    });
    const refundReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "REFUND",
      requestedAmount: 600,
      disbursementMethod: "CASH",
      reason: "Customer returned the vehicle",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: refundReq,
      status: "APPROVED",
    });

    const canonicalDocId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.status).toBe("REFUNDED");
      expect(row?.outstandingAmount).toBe(1000); // refund pushed it back up
      return row?.canonicalReceivableDocumentId;
    });

    // The stale intent settles.
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      // The REFUNDED terminal label is gone and real money was applied.
      expect(row?.status).not.toBe("REFUNDED");
      expect(row?.outstandingAmount).toBe(600); // 1000 - 400 applied

      const intent = await ctx.db.get(intentId);
      const paymentRow = intent?.collectionPaymentId
        ? await ctx.db.get(intent.collectionPaymentId)
        : null;
      expect(paymentRow?.amount).toBe(400); // NOT the inert 0 of the CANCELLED case
      expect(paymentRow?.status).toBe("POSTED");

      // And the canonical side allocated too — the §2 writer guard would NOT
      // refuse this, because the refund legitimately reopened the document to
      // OPEN. Canonical says collectible; the legacy row said REFUNDED.
      const alloc = intent?.paymentAllocationId ? await ctx.db.get(intent.paymentAllocationId) : null;
      expect(alloc?.amountMinor).toBe(400_000);
      expect(alloc?.status).toBe("ACTIVE");
      if (canonicalDocId) {
        const doc = await ctx.db.get(canonicalDocId);
        expect(doc?.status).toBe("PARTIALLY_PAID");
      }
    });
  });
});

describe("SCRUM-121A — Codex F2, validated independently", () => {
  /**
   * CODEX 121A-02 — a CANCELLED canonical document WITH a surviving ACTIVE
   * allocation is reachable on current main, through public mutations only.
   *
   * This falsifies the load-bearing claim in my §2: that all three CANCELLED
   * writers guarantee zero active allocations before closing. The manual
   * cancellation path proves it by reading the LEGACY row's paidAmount, which
   * a document-only intent never touches — so the canonical allocation is
   * invisible to the gate that is supposed to prevent exactly this.
   *
   * Control: the same sequence with the intent carrying `receivableId` as well
   * makes the legacy mirror run, `paidAmount` becomes non-zero, and the
   * cancellation is REFUSED. That isolates the legacy-only gate — not the
   * cancellation logic in general — as the reason the canonical allocation
   * survives.
   */
  test("CODEX121A02_document_only_intent_leaves_an_ACTIVE_allocation_under_a_CANCELLED_document", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Document-only target",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.canonicalReceivableDocumentId).toBeTruthy();
      return row!.canonicalReceivableDocumentId!;
    });

    // Document-only intent: the supported shape proven by accountingPhase8.
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableDocumentId: docId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
    });
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    await t.run(async (ctx) => {
      const intent = await ctx.db.get(intentId);
      const alloc = intent?.paymentAllocationId ? await ctx.db.get(intent.paymentAllocationId) : null;
      expect(alloc?.status).toBe("ACTIVE");
      expect(alloc?.amountMinor).toBe(400_000);
      // The legacy row never learned about it — the mirror needs receivableId.
      const row = await ctx.db.get(receivableId);
      expect(row?.outstandingAmount).toBe(1000);
    });

    // The legacy paidAmount is still zero, so the pre-existing check cannot
    // see this money. INVERTED by §5.1: the canonical gate can, and refuses.
    //
    // This is the fixture that mattered most in the whole stage — it is the one
    // that reached CANCELLED + ACTIVE through PUBLIC mutations only, with no
    // constructed state anywhere. It asserted that state was produced; it failed
    // the moment the gate landed.
    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId: cancelReq,
        status: "APPROVED",
      })
    ).rejects.toThrow(/still has payments applied to it/i);

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      // Not cancelled, and the money is untouched: the refusal is a zero-delta,
      // not a partial cancellation that stopped halfway.
      expect(doc?.status).not.toBe("CANCELLED");
      const allocs = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      expect(allocs).toHaveLength(1);
      expect(allocs[0]!.amountMinor).toBe(400_000);
      // The approval request itself rolled back with everything else — the
      // refusal throws uncaught, which is the only thing that undoes the
      // STARTED idempotency row and the request patch made before this branch.
      const req = await ctx.db.get(cancelReq);
      expect(req?.status).toBe("PENDING");
    });
  });

  test("CONTROL_the_same_sequence_with_receivableId_is_refused_at_cancellation", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Legacy-linked target",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
    });
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    // The legacy mirror ran, so paidAmount > 0 and cancellation is refused.
    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId: cancelReq,
        status: "APPROVED",
      })
    ).rejects.toThrow(/already received payments/i);
  });
});

describe("SCRUM-121 — Codex findings, validated independently", () => {
  /**
   * CODEX-01 — the GL is credited the GROSS receipt while canonical and
   * operational application are capped. This is the finding that decides
   * whether the ruling's authorized file list is workable.
   *
   * Control: settle the intent BEFORE the competing cash payment; gross and
   * applied then coincide and the same posting rule agrees with the debt
   * reduction, so the divergence is the gross-versus-applied distinction and
   * not payment-link posting in general.
   */
  test("CODEX01_gl_event_carries_gross_receipt_while_allocation_is_capped", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Raced installment",
      amount: 100,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "stripe",
    });

    // Another channel settles 60 of the same debt first.
    await asFinance.mutation(api.collections.recordPayment, {
      orgId,
      receivableId,
      amount: 60,
      method: "CASH",
      paymentDate: Date.now(),
    });

    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.outstandingAmount).toBe(0);

      const intent = await ctx.db.get(intentId);
      const alloc = intent?.paymentAllocationId ? await ctx.db.get(intent.paymentAllocationId) : null;
      expect(alloc?.amountMinor).toBe(40_000); // capped to what was still owed

      const canonical = intent?.canonicalPaymentId ? await ctx.db.get(intent.canonicalPaymentId) : null;
      expect(canonical?.amountMinor).toBe(100_000); // gross actually received

      // No chart is seeded here, so the GL commands are durably enqueued
      // rather than posted. The PAYLOAD is what the posting rule will consume,
      // and ruleCollectionPayment credits ACCOUNTS_RECEIVABLE_CUSTOMERS by
      // exactly this amountMinor — so the payload is the GL claim.
      const queued = await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId))
        .collect();

      const linkEvent = queued.find((e) => e.eventType === "PAYMENT_LINK_RECEIVED");
      // The GL command carries the GROSS 100, not the applied 40.
      expect((linkEvent?.payload as { amountMinor?: number } | undefined)?.amountMinor).toBe(100_000);

      const arCredited = queued
        .filter((e) => e.eventType === "COLLECTION_PAYMENT" || e.eventType === "PAYMENT_LINK_RECEIVED")
        .reduce((s, e) => s + ((e.payload as { amountMinor?: number })?.amountMinor ?? 0), 0);
      // AR will be credited 60 + 100 = 160 against a debt of 100.
      expect(arCredited).toBe(160_000);
    });
  });

  /**
   * CODEX-04 — the pending-intent race. If this reproduces on fresh data then
   * terminal-state resurrection is LIVE, not merely latent as both I and the
   * Sonnet seat concluded.
   */
  test("CODEX04_pending_intent_settling_after_cancellation_rewrites_CANCELLED_to_PAID", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled mid-flight",
      amount: 100,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 100_000,
      currency: "JOD",
      provider: "stripe",
    });

    // Cancellation does not consider pending intents.
    const req = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Customer withdrew",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: req,
      status: "APPROVED",
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(receivableId))?.status).toBe("CANCELLED");
    });

    // The provider settles anyway.
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      // INVERTED by the §6 implementation. This asserted "PAID" against
      // unmodified main and failed the moment the fix landed, which is the
      // failing-first proof for this defect. It now asserts the debt stays
      // closed.
      expect(row?.status).toBe("CANCELLED");
    });
  });
});

/**
 * SCRUM-121A — evidence fixtures required by owner ruling c16581.
 *
 * c16581 makes one standard binding: "No load-bearing reachability claim
 * without an executable fixture." Every assertion in the amended design that a
 * state is reachable, is unreachable, changes no money, cannot carry an ACTIVE
 * allocation, preserves a supported API, or affects only one accounting layer
 * must have an executed fixture behind it.
 *
 * These are the fixtures for the claims the amended design actually leans on.
 * Where the honest answer weakens my own design, the fixture says so — EV2 is
 * the clearest case: it proves a guard I described as closing a hole is really
 * only replacing an accidental refusal with a deliberate one.
 */
describe("SCRUM-121A — c16581 evidence fixtures", () => {
  /**
   * EV1 — reversing an allocation under a CANCELLED document RESURRECTS it to
   * PAID. This is the second resurrection in the same subsystem, and it is the
   * concrete value of the c16569 reversal guard.
   *
   * The state is not a constructed hypothesis: CODEX121A02 above reaches
   * CANCELLED-with-ACTIVE through public mutations only. This fixture takes
   * that proven state and demonstrates what the reversal writer does with it.
   *
   * Mechanism: getReceivableOutstandingMinor special-cases CANCELLED to 0
   * (subledger.ts:25), so reverseAllocation's recomputation at :326 reads
   * outstanding 0, fails `0 >= originalAmountMinor`, fails `0 > 0`, and lands
   * on PAID — a document that was cancelled now reads as fully collected.
   */
  test("EV1_reversing_an_allocation_under_a_CANCELLED_document_resurrects_it_to_PAID", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Resurrection target",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });

    // ⚠️ RE-BASED BY §5.1, AND THIS IS THE POINT OF THE FIXTURE NOW.
    //
    // EV1 used to reach CANCELLED-with-ACTIVE through public mutations exactly
    // as CODEX121A02 did. It no longer can: the cancellation gate refuses that
    // sequence, and this test failed at the approval step the moment the gate
    // landed — which is itself the evidence that the public route is closed.
    //
    // c16581 required the cancellation gate and the reversal guard to ship
    // together; c16620 then split the reversal guard into SCRUM-218, whose
    // authorized files include `subledger.ts`. This fixture is what makes that
    // split safe to reason about, so it is re-based rather than deleted: the
    // state is now CONSTRUCTED directly, and the defect it demonstrates is
    // reachable ONLY by construction. SCRUM-218 closes the constructed case;
    // 121A-PRE has closed the reachable one.
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableDocumentId: docId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
    });
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    // First, prove the public route is shut — so "constructed" below is a
    // statement about this branch, not an assumption carried over from before.
    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId,
        requestId: cancelReq,
        status: "APPROVED",
      })
    ).rejects.toThrow(/still has payments applied to it/i);

    // Now construct the state the reversal writer still mishandles.
    await t.run((ctx) => ctx.db.patch(docId, { status: "CANCELLED", cancelledAt: Date.now() }));

    const allocationId = await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).toBe("CANCELLED");
      const allocs = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      expect(allocs).toHaveLength(1);
      return allocs[0]!._id as Id<"paymentAllocations">;
    });

    // The reversal writer, exercised directly. reverseAllocation takes no
    // document-status decision today, so this is the writer's behaviour on a
    // state that public mutations demonstrably produce.
    await t.run(async (ctx) => {
      const { reverseAllocation } = await import("./subledger");
      await reverseAllocation(ctx as never, { orgId, allocationId, actorId: userId });
    });

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      // Cancelled -> "fully collected", with no money and no correction. Still
      // true of the reversal writer, and now reachable only by construction.
      // This is the open half that SCRUM-218 owns.
      expect(doc?.status).toBe("PAID");
    });
  });

  /**
   * EV2 — a correction to my own design, and it lowers the severity I claimed.
   *
   * I described the CANCELLED branch of the allocation guard as closing a hole.
   * It does not. getReceivableOutstandingMinor already returns 0 for CANCELLED,
   * and allocatePaymentToReceivable already refuses `amountMinor > outstanding`
   * — so allocation onto a CANCELLED document is ALREADY refused today.
   *
   * What is wrong with it is the reason, not the outcome: the refusal is a
   * balance coincidence carrying a balance-shaped message, not a status
   * decision. The guard's real value is making the decision explicit and
   * status-driven. That is worth doing, and it is not a hole being closed.
   */
  test("EV2_allocation_onto_a_CANCELLED_document_is_ALREADY_refused_but_only_incidentally", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled target",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });
    await t.run((ctx) => ctx.db.patch(docId, { status: "CANCELLED" }));

    await t.run(async (ctx) => {
      const { createCanonicalPayment, allocatePaymentToReceivable } = await import("./subledger");
      const paymentId = await createCanonicalPayment(ctx as never, {
        orgId, direction: "IN", payerType: "CUSTOMER", customerId,
        method: "CASH", amountMinor: 100_000, currency: "JOD",
        idempotencyKey: "ev2_cash", actorId: userId, status: "SETTLED",
      });
      await expect(
        allocatePaymentToReceivable(ctx as never, {
          orgId, paymentId, receivableDocumentId: docId, amountMinor: 100_000, actorId: userId,
        })
      // The message names a balance, not a closed debt. That is the defect.
      ).rejects.toThrow(/exceeds receivable outstanding balance 0/);
    });
  });

  /**
   * EV3 — and here the guard is NOT vacuous. WRITTEN_OFF and REVERSED get no
   * special case in getReceivableOutstandingMinor, so outstanding reads as the
   * full original amount and allocation SUCCEEDS onto a written-off debt.
   *
   * Reachability, stated exactly: no production writer sets a
   * receivableDocuments row to WRITTEN_OFF or REVERSED — verified whole-tree,
   * every hit is another table, a schema literal, or a reader. So this is a
   * FORWARD guard against a status the schema permits and the writer does not
   * defend, reached here by direct construction. It is not a live defect, and
   * the design must not claim it is.
   */
  test("EV3_allocation_onto_a_WRITTEN_OFF_document_SUCCEEDS_today", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Written off target",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });
    await t.run((ctx) => ctx.db.patch(docId, { status: "WRITTEN_OFF" }));

    await t.run(async (ctx) => {
      const { createCanonicalPayment, allocatePaymentToReceivable } = await import("./subledger");
      const paymentId = await createCanonicalPayment(ctx as never, {
        orgId, direction: "IN", payerType: "CUSTOMER", customerId,
        method: "CASH", amountMinor: 100_000, currency: "JOD",
        idempotencyKey: "ev3_cash", actorId: userId, status: "SETTLED",
      });
      const allocationId = await allocatePaymentToReceivable(ctx as never, {
        orgId, paymentId, receivableDocumentId: docId, amountMinor: 100_000, actorId: userId,
      });
      expect(allocationId).toBeTruthy();
      const doc = await ctx.db.get(docId);
      // A written-off debt is now PARTIALLY_PAID and back on the books.
      expect(doc?.status).toBe("PARTIALLY_PAID");
    });
  });

  /**
   * EV4 — the cost of NOT validating a document-only target at creation.
   *
   * c16581 keeps document-only intents supported and requires the server to
   * prove the document instead of refusing it. This fixture shows what the
   * missing proof costs: `create` stores a document belonging to a DIFFERENT
   * customer with no check at all, and the mismatch is not discovered until
   * settlement — where allocatePaymentToReceivable throws, rolling back the
   * whole mutation and destroying a receipt the provider has already taken.
   *
   * That is the exact shape c16581 draws the boundary around: before funds
   * exist a refusal is correct and free; after funds are confirmed the receipt
   * must survive. Validating at creation moves the refusal to the free side.
   */
  test("EV4_document_only_intent_stores_ANOTHER_customers_document_and_destroys_the_receipt_at_settlement", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const otherCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Omar", lastName: "Haddad", phone: "+962790000001" })
    );
    const othersReceivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId: otherCustomerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Someone else's debt",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const othersDocId = await t.run(async (ctx) => {
      const row = await ctx.db.get(othersReceivableId);
      return row!.canonicalReceivableDocumentId!;
    });

    // INVERTED by §4. This asserted creation accepted another customer's
    // document with no payer correlation whatsoever, and that the mismatch
    // surfaced only at settlement — where the receipt was destroyed rather than
    // recorded. It failed the moment the payer proof landed.
    const before = await snapshotMoneyWorld(t);
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId,
        customerId,
        receivableDocumentId: othersDocId,
        amountMinor: 400_000,
        currency: "JOD",
        provider: "tap",
      })
    ).rejects.toThrow(/document belongs to a different payer/i);
    // The same total-rollback control, now measured on the free side of the
    // boundary: the refusal costs a request instead of a confirmed receipt.
    expect(await snapshotMoneyWorld(t)).toBe(before);
    await t.run(async (ctx) => {
      const intents = await ctx.db
        .query("paymentIntents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(intents).toHaveLength(0);
    });
  });

  /**
   * EV5 — OPEN can never coexist with an ACTIVE allocation, so the reversal
   * rule must NOT refuse OPEN.
   *
   * Two-part evidence, because neither half is sufficient alone:
   *
   *  (a) STATIC: the only writers of receivableDocuments.status whole-tree are
   *      subledger.ts:257 (allocation -> PAID/PARTIALLY_PAID), subledger.ts:326
   *      (reversal, the only producer of OPEN), collections.ts:1663,
   *      saleCancellation.ts:113 and applications.ts:2752 (all three CANCELLED).
   *      No writer produces OPEN except the reversal recomputation.
   *
   *  (b) EXECUTABLE, below: the recomputation reaches OPEN only when live
   *      outstanding returns to the full original, which by construction means
   *      no ACTIVE allocation remains.
   *
   * I am dropping INCONSISTENT_REVERSAL from the design on this evidence. The
   * state is unreachable, so refusing it protects nothing — and a refusal whose
   * only justification is my own whole-tree enumeration is precisely the rule
   * most likely to strand money, given that enumeration has now been wrong
   * three times in this ticket.
   */
  test("EV5_OPEN_is_only_ever_reached_with_zero_ACTIVE_allocations", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Two allocations",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });

    const { first, second } = await t.run(async (ctx) => {
      const { createCanonicalPayment, allocatePaymentToReceivable } = await import("./subledger");
      const mk = async (key: string, minor: number) => {
        const paymentId = await createCanonicalPayment(ctx as never, {
          orgId, direction: "IN", payerType: "CUSTOMER", customerId,
          method: "CASH", amountMinor: minor, currency: "JOD",
          idempotencyKey: key, actorId: userId, status: "SETTLED",
        });
        return await allocatePaymentToReceivable(ctx as never, {
          orgId, paymentId, receivableDocumentId: docId, amountMinor: minor, actorId: userId,
        });
      };
      return { first: await mk("ev5_a", 400_000), second: await mk("ev5_b", 600_000) };
    });

    const statusAfter = async () => (await t.run((ctx) => ctx.db.get(docId)))?.status;
    const activeCount = async () =>
      (await t.run((ctx) =>
        ctx.db
          .query("paymentAllocations")
          .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
          .filter((q) => q.eq(q.field("status"), "ACTIVE"))
          .collect()
      )).length;

    expect(await statusAfter()).toBe("PAID");

    const reverse = async (allocationId: Id<"paymentAllocations">) =>
      await t.run(async (ctx) => {
        const { reverseAllocation } = await import("./subledger");
        await reverseAllocation(ctx as never, { orgId, allocationId, actorId: userId });
      });

    await reverse(first);
    // One ACTIVE remains -> never OPEN.
    expect(await statusAfter()).toBe("PARTIALLY_PAID");
    expect(await activeCount()).toBe(1);

    await reverse(second);
    // OPEN, and only once the last ACTIVE allocation is gone.
    expect(await statusAfter()).toBe("OPEN");
    expect(await activeCount()).toBe(0);
  });
});

/**
 * SCRUM-121A — golden GL baselines for the two paths the amended design
 * actually changes. Captured against UNMODIFIED main, before implementation.
 *
 * Capturing these afterwards would compare the implementation to itself, which
 * is how a GL-neutrality claim passes while being false. The two paths below
 * are the ones §3 (the cancellation gate) and §6 (the terminal-row settlement)
 * touch; the three baselines above cover the ordinary accepted cash paths.
 */
describe("SCRUM-121A — golden GL baselines for the paths 121A changes", () => {
  /**
   * G4 — a PERMITTED cancellation, with zero canonical allocations.
   *
   * This is the accepted path through the new gate. The gate must leave it
   * byte-identical: it may only refuse the case that carries an ACTIVE
   * allocation, and must not alter what a legitimate cancellation posts.
   */
  test("G4_a_permitted_cancellation_queues_the_receivable_reversal_and_nothing_else", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Baseline cancellation",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    const baseline = await accountingCommands(t, orgId);

    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelReq,
      status: "APPROVED",
    });

    const after = await accountingCommands(t, orgId);
    const key = (c: unknown) => JSON.stringify(c);
    const added = after.filter((c) => !baseline.some((b) => key(b) === key(c)));
    // Removals matter as much as additions. A delta that only looks at what
    // appeared reads a CANCELLED pending post as "no GL effect" — which is
    // exactly what G4 does, and exactly how a GL-neutrality claim passes while
    // being false. Both directions are pinned.
    const removed = baseline.filter((b) => !after.some((c) => key(c) === key(b)));
    expect({ added, removed }).toMatchInlineSnapshot(`
      {
        "added": [],
        "removed": [
          {
            "amountMinor": 1000000,
            "currency": "JOD",
            "eventType": "RECEIVABLE_CREATED",
            "sourceType": "receivables",
          },
        ],
      }
    `);

    // And the cancellation genuinely happened — otherwise an empty diff would
    // pass vacuously against a gate that refuses everything.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.status).toBe("CANCELLED");
      const doc = await ctx.db.get(row!.canonicalReceivableDocumentId!);
      expect(doc?.status).toBe("CANCELLED");
    });
  });

  /**
   * G5 — the CODEX-04 sequence: settle a payment intent AFTER the receivable
   * was cancelled. §6 changes the legacy status write on this path and must
   * change nothing else, so what main queues here is pinned before the fix.
   *
   * Note what this baseline proves and does not prove. It proves the queued
   * accounting commands. It does NOT bless them — the receipt is posted gross
   * while zero is applied, which is CODEX-01, and SCRUM-218 owns changing it.
   * 121A's obligation is to leave this exact list alone.
   */
  test("G5_settling_after_cancellation_queues_the_gross_receipt_and_121A_must_not_change_it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Baseline late settlement",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
    });
    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelReq,
      status: "APPROVED",
    });

    const baseline = await accountingCommands(t, orgId);
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const after = await accountingCommands(t, orgId);
    const key = (c: unknown) => JSON.stringify(c);
    const added = after.filter((c) => !baseline.some((b) => key(b) === key(c)));
    // Removals matter as much as additions. A delta that only looks at what
    // appeared reads a CANCELLED pending post as "no GL effect" — which is
    // exactly what G4 does, and exactly how a GL-neutrality claim passes while
    // being false. Both directions are pinned.
    const removed = baseline.filter((b) => !after.some((c) => key(c) === key(b)));
    expect({ added, removed }).toMatchInlineSnapshot(`
      {
        "added": [
          {
            "amountMinor": 400000,
            "currency": "JOD",
            "eventType": "PAYMENT_LINK_RECEIVED",
            "sourceType": "paymentIntents",
          },
        ],
        "removed": [],
      }
    `);

    // INVERTED by §6. The defect this baseline sat next to: the legacy row was
    // resurrected. The fix flipped THIS and left the command list above
    // untouched — when it landed, the inline GL snapshot still passed and only
    // this line failed, which is the GL-neutrality proof rather than an
    // argument for it.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.status).toBe("CANCELLED");
    });
  });
});

/**
 * SCRUM-121A — EV6, closing the one §10 row that had no fixture.
 *
 * The design asserts a soft-deleted PAYER is fresh-production reachable, and
 * that claim was riding on D10 — which actually constructs a soft-deleted
 * RECEIVABLE by direct patch. Different row, different reachability. Under
 * c16581 that is a load-bearing reachability claim with no executable fixture,
 * so here it is.
 *
 * The mechanism is exact: `customers.softDelete` (a public production mutation,
 * customers.ts:507) refuses a customer with associated leads (:533) or sales
 * (:545) — and says nothing about outstanding receivables. A collections
 * receivable requires neither a lead nor a sale, so a customer who owes money
 * can be withdrawn through the ordinary UI door, and remains payable afterwards.
 *
 * Control: the softDelete itself succeeds. If it had been refused, a subsequent
 * successful payment would prove nothing about withdrawn payers.
 */
describe("SCRUM-121A — EV6, the withdrawn payer", () => {
  test("EV6_a_customer_who_owes_money_can_be_soft_deleted_and_stays_payable", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    // customers.softDelete calls checkTenantWriteLimit, which reaches the
    // rateLimiter component. It is opt-in per instance by design, so this
    // fixture registers it rather than stubbing the module — the point is to
    // exercise the REAL production door, guards and all.
    registerRateLimiter(t);
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    // The seeded finance role does not carry delete:customers; grant it so the
    // fixture exercises the real production door rather than a direct patch.
    await t.run(async (ctx) => {
      const role = await ctx.db
        .query("roles")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .first();
      await ctx.db.patch(role!._id, {
        permissions: [...role!.permissions, "delete:customers"],
      });
    });

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Owed by a customer about to be withdrawn",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // CONTROL: the production door accepts it. No lead, no sale, and no
    // receivable check anywhere in softDelete's guards.
    await expect(
      asFinance.mutation(api.customers.softDelete, { orgId, customerId })
    ).resolves.not.toThrow();

    await t.run(async (ctx) => {
      const c = await ctx.db.get(customerId);
      expect(c?.isDeleted).toBe(true);
    });

    // And the debt is still collectible against a payer who no longer exists
    // as far as every customer-facing surface is concerned.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId,
        receivableId,
        amount: 250,
        method: "CASH",
        paymentDate: Date.now(),
      })
    ).resolves.toBeTruthy();

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.outstandingAmount).toBe(750);
    });
  });
});

/**
 * SCRUM-121A — Codex round-3 findings, validated independently.
 *
 * Reproduced here rather than accepted on the reviewer's say-so. Where my own
 * design or citations were wrong, the fixture records that rather than the
 * claim I originally made.
 */
describe("SCRUM-121A — Codex R3 findings, validated independently", () => {
  /**
   * R3-04 — a collections-cancelled receivable is counted in AR aging FOREVER.
   *
   * This is a live GL-vs-subledger divergence and it is independent of every
   * other finding in this ticket.
   *
   * Mechanism, and the code documents it against itself. `getReceivablesAsOf`
   * (accountingReports.ts:473) excludes a cancelled document only when
   * `cancelledAt <= asOfDate`; a document with NO `cancelledAt` is included at
   * every asOfDate. `arAging`'s own comment (accountingReports.ts:517-521)
   * states the requirement exactly: "a cancelled receivable's reversed
   * allocations stop counting as of cancelledAt, so the receivable itself must
   * also stop counting from cancelledAt onward, or it would reappear as fully
   * outstanding forever after cancellation."
   *
   * But `collections.respondToApproval` patches ONLY `{ status: "CANCELLED" }`
   * onto the canonical document (collections.ts:1663) — no `cancelledAt`,
   * `cancelledBy` or `cancellationReason`. Meanwhile the same transition calls
   * `hookReceivableCancelled`, which reverses the GL side. So the ledger is
   * zeroed and the subledger report is not.
   *
   * Control: `saleCancellation.ts:112-117` writes all four fields, and the
   * second half of this test proves a document carrying `cancelledAt` IS
   * excluded — isolating the missing metadata, not the report logic, as cause.
   */
  test("R3_04_a_collections_cancelled_receivable_is_still_counted_in_AR_aging_forever", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);
    // arAging is plan-gated; collections mutations are not.
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId, plan: "professional", status: "active",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cancelled but still aging",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });

    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelReq,
      status: "APPROVED",
    });

    // INVERTED by §5.2. This asserted all three metadata fields were absent —
    // the state that kept a cancelled debt in AR aging forever — and failed the
    // moment the writer started stamping them.
    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).toBe("CANCELLED");
      expect(typeof doc?.cancelledAt).toBe("number");
      expect(doc?.cancelledBy).toBeDefined();
      // The requester's mandatory reason, because the approver left no notes.
      expect(doc?.cancellationReason).toBe("Booked in error");
    });

    // Aging run for a date well AFTER the cancellation no longer carries it.
    const asOfDate = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const aging = await asFinance.query(api.accountingReports.arAging, { orgId, asOfDate });
    const rows = aging.byCurrency["JOD"]?.rows ?? [];
    expect(rows.find((r) => r.receivableId === docId)).toBeUndefined();

    // CONTROL, INVERTED WITH IT — strip the timestamp back off and the same
    // report carries the debt at full value again. The report logic never
    // changed; the metadata is what does the work, which is what makes this a
    // test of the fix rather than of the reader.
    await t.run((ctx) => ctx.db.patch(docId, { cancelledAt: undefined }));
    const agingWithout = await asFinance.query(api.accountingReports.arAging, { orgId, asOfDate });
    const rowsWithout = agingWithout.byCurrency["JOD"]?.rows ?? [];
    const stillAging = rowsWithout.find((r) => r.receivableId === docId);
    expect(stillAging).toBeDefined();
    expect(stillAging!.outstandingMinor).toBe(1_000_000);
  });

  /**
   * R3-01 — the raw `subledger.allocate` door defeats the `disbursedAt` proof.
   *
   * My design claimed applications.ts:2752 cannot produce CANCELLED+ACTIVE
   * because confirmDisbursement requires app.status === "CLOSED" and sets
   * disbursedAt in the same transaction as the allocation, while cancellation
   * refuses once disbursedAt is set. Both halves are true and the conclusion is
   * still wrong: `subledger.allocate` (subledger.ts:465) allocates WITHOUT
   * touching the application at all, so disbursedAt stays unset and the
   * cancellation gate sees a clean deal.
   *
   * This contradicts my own document. I published the two internal doors as
   * "the one door no caller-side gate can cover" and then proved a writer safe
   * with a caller-side argument. Codex caught the contradiction; I did not.
   *
   * Control: the same sequence via confirmDisbursement sets disbursedAt and
   * cancellation is refused — isolating the raw door, not cancellation logic.
   */
  test("R3_01_the_raw_allocate_door_leaves_a_finance_document_CANCELLED_with_an_ACTIVE_allocation", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId } = await seedFinanceMember(t);

    // A finance-company receivable, built directly: this fixture is about the
    // allocation/cancellation interaction, not about finalizeDeal's own path.
    const docId = await t.run(async (ctx) => {
      const { createReceivableDocument } = await import("./subledger");
      const financeCompanyId = await ctx.db.insert("financeCompanies", {
        orgId, name: "Test Finance Co", isActive: true,
        profitRate: 5.5, maxTermMonths: 72, gracePeriodMonths: 3,
      });
      return await createReceivableDocument(ctx as never, {
        orgId,
        documentType: "INVOICE",
        payerType: "FINANCE_COMPANY",
        financeCompanyId,
        customerId,
        sourceType: "finance_application",
        sourceId: "app_r301",
        originalAmountMinor: 5_000_000,
        currency: "JOD",
        issueDate: Date.now(),
        dueDate: Date.now(),
        actorId: userId,
      });
    });

    // The raw door: allocate settled money with no application lifecycle.
    await t.run(async (ctx) => {
      const { createCanonicalPayment, allocatePaymentToReceivable } = await import("./subledger");
      const paymentId = await createCanonicalPayment(ctx as never, {
        orgId, direction: "IN", payerType: "FINANCE_COMPANY",
        method: "BANK_TRANSFER", amountMinor: 5_000_000, currency: "JOD",
        idempotencyKey: "r301_raw", actorId: userId, status: "SETTLED",
      });
      await allocatePaymentToReceivable(ctx as never, {
        orgId, paymentId, receivableDocumentId: docId,
        amountMinor: 5_000_000, actorId: userId,
      });
    });

    // The document is now PAID with an ACTIVE allocation, and no application
    // anywhere records a disbursement.
    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).toBe("PAID");
      const allocs = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      expect(allocs).toHaveLength(1);
    });

    // Cancellation writers patch the document to CANCELLED unconditionally —
    // applications.ts:2752 guards only on app.disbursedAt, which the raw door
    // never set. Demonstrated here as the writer's own behaviour.
    await t.run((ctx) => ctx.db.patch(docId, { status: "CANCELLED" }));

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).toBe("CANCELLED");
      const allocs = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      // CANCELLED + ACTIVE on the finance side. The planned reversal guard
      // would make this permanently uncorrectable.
      expect(allocs).toHaveLength(1);
      expect(allocs[0]!.amountMinor).toBe(5_000_000);
    });
  });

  /**
   * R3-03 — `collections.ts:364` is reached by a POST-funds path too.
   *
   * My §5.3 classified allocation call sites, and classified this one as
   * pre-funds because `recordPayment` reaches it. `applyPostedPayment` has two
   * callers: collections.ts:875 (recordPayment, pre-funds) and collections.ts:1134
   * (clearCheque, POST-funds — the bank has already cleared the cheque).
   *
   * So the funds boundary is a property of the LIFECYCLE PATH, not of the call
   * site, and a design that classifies call sites cannot express it. That is
   * the structural correction, and it is why this fixture exists.
   *
   * This test pins current behaviour: clearing a cheque whose receivable was
   * closed by an intervening payment. It documents what a terminal-status
   * refusal at the writer would roll back.
   */
  test("R3_03_clearCheque_reaches_the_same_allocation_site_after_the_bank_confirmed_the_funds", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Cheque then closed",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const chequeId = await asFinance.mutation(api.collections.registerCheque, {
      orgId,
      receivableId,
      customerId,
      bank: "Arab Bank",
      chequeNumber: "R303-1",
      chequeDate: DUE(),
      amount: 400,
    });

    // Clearing works today and allocates through collections.ts:364 — the same
    // writer call site recordPayment uses, reached after the bank confirmed.
    await asFinance.mutation(api.collections.clearCheque, { orgId, chequeId });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      expect(row?.outstandingAmount).toBe(600);
      const docId = row!.canonicalReceivableDocumentId!;
      const allocs = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      expect(allocs).toHaveLength(1);
      expect(allocs[0]!.amountMinor).toBe(400_000);
    });
  });
});

/**
 * SCRUM-121A-PRE — R3-05, the last §9 row that had no fixture.
 *
 * c16620 requires that customer, receivable, sale, vehicle and canonical
 * document identify ONE payer and ONE debt. My round-3 design claimed the
 * "business identifier mode" already enforced that. It does not, and this is
 * the reproduction Codex's R3-05 asked for.
 *
 * `paymentIntents.create` derives an authoritative document only inside
 * `if (args.receivableId)` (paymentIntents.ts:291), which forces
 * `receivableDocumentId` to that receivable's canonical document (:299).
 * `saleId` is stored and NEVER correlated with anything — not with the
 * receivable, not with the document, not even for existence or organization.
 *
 * Control: the sibling assertion shows the receivable-vs-document check DOES
 * fire, so the acceptance below is the absence of a saleId rule specifically,
 * not a generally permissive mutation.
 */
describe("SCRUM-121A-PRE — R3-05, saleId is never correlated", () => {
  test("R3_05_an_intent_may_carry_a_saleId_unrelated_to_its_canonical_document", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    // Two unrelated debts for the same customer, so no payer check can mask
    // the missing saleId correlation.
    const mkReceivable = async (title: string) =>
      await asFinance.mutation(api.collections.createReceivable, {
        orgId, customerId, sourceType: "INTERNAL_INSTALLMENT",
        title, amount: 1000, dueDate: DUE(), creditSystemKey: "MISCELLANEOUS_INCOME",
      });
    const receivableA = await mkReceivable("Debt A");
    const receivableB = await mkReceivable("Debt B");
    const docB = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableB);
      return row!.canonicalReceivableDocumentId!;
    });

    // A sale that has nothing to do with debt B.
    const unrelatedSaleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Toyota", model: "Corolla", year: 2020, mileage: 40_000,
        color: "White", fuelType: "PETROL", transmission: "AUTOMATIC",
        sellingPrice: 20_000, status: "AVAILABLE",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 20_000, saleDate: Date.now(), status: "PENDING",
      });
    });

    // CONTROL: the receivable-vs-document rule DOES fire, so this mutation is
    // not simply permissive — the saleId gap below is specific.
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableId: receivableA, receivableDocumentId: docB,
        amountMinor: 100_000, currency: "JOD", provider: "tap",
      })
    ).rejects.toThrow(/does not match the selected receivable/);

    // INVERTED after the Sonnet MAX seat's Finding 1. This asserted that
    // document B plus a saleId related to nothing was accepted and stored with
    // no correlation of any kind, and it failed the moment the correlation
    // landed — the failing-first proof for that finding.
    //
    // Why it existed in this shape: design revision 3 scoped the
    // UNPROVEN_TARGET refusal to sale-ONLY mode, so this combination — a sale
    // with no document of its own, alongside a document resolved from some
    // other identifier — fell between the two branches. The commit message then
    // claimed every supplied identifier must agree, which this test disproved.
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableDocumentId: docB, saleId: unrelatedSaleId,
        amountMinor: 100_000, currency: "JOD", provider: "tap",
      })
    ).rejects.toThrow(/sale does not match the selected debt/i);

    await t.run(async (ctx) => {
      const intents = await ctx.db
        .query("paymentIntents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(intents).toHaveLength(0);
      const row = await ctx.db.get(receivableB);
      expect(row?.saleId).toBeUndefined();
    });
  });

  /**
   * The CONTROL for that fix, and the reason the reviewer's proposed form of it
   * was not adopted.
   *
   * The seat proposed refusing whenever a supplied sale carries no canonical
   * document. That is too blunt: `createReceivable` accepts a `saleId` with no
   * completion requirement, and `sale.canonicalReceivableDocumentId` is written
   * only at completion — so a receivable naming its own PENDING sale is an
   * ordinary state, and a payment link for it must keep working.
   *
   * Measured, not asserted: with the blunt form applied, 2 of 40 tests fail —
   * this control, and R3-05 itself on the changed message text. R3-05's failure
   * is the kind a reviewer papers over by relaxing a regex, which would leave
   * this control as the only thing standing between the blunt fix and a
   * legitimate everyday call being refused.
   */
  test("R3_05_CONTROL_a_receivable_may_still_be_billed_alongside_its_own_pending_sale", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    const saleId = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Kia", model: "Rio", year: 2021, mileage: 30_000,
        color: "Blue", fuelType: "PETROL", transmission: "AUTOMATIC",
        sellingPrice: 15_000, status: "AVAILABLE",
      });
      return await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15_000, saleDate: Date.now(), status: "PENDING",
      });
    });

    // The receivable names the pending sale, which therefore has no canonical
    // document of its own yet.
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId, customerId, saleId, sourceType: "INTERNAL_INSTALLMENT",
      title: "Owed against a deal still in progress",
      amount: 1000, dueDate: DUE(), creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(saleId))?.canonicalReceivableDocumentId).toBeUndefined();
      expect((await ctx.db.get(receivableId))?.saleId).toBe(saleId);
    });

    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId, customerId, receivableId, saleId,
      amountMinor: 100_000, currency: "JOD", provider: "tap",
    });
    expect(intentId).toBeTruthy();

    // …and the end-to-end assertion the cross-family seat's verification floor
    // asked for: the intent and the receipt settlement produces must identify
    // the SAME sale.
    //
    // This is the half that made the finding matter rather than being cosmetic.
    // The legacy mirror stamps `saleId: receivable.saleId` — the RECEIVABLE's
    // sale, never the intent's — so before the correlation landed an intent
    // could name S2 while its own receipt named S1, and the two records of one
    // payment disagreed about which deal it belonged to. Equality here is only
    // guaranteed because creation now refuses the pair that could differ.
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });
    await t.run(async (ctx) => {
      const intent = await ctx.db.get(intentId);
      expect(intent?.status).toBe("SETTLED");
      const receipt = intent?.collectionPaymentId ? await ctx.db.get(intent.collectionPaymentId) : null;
      expect(receipt).toBeTruthy();
      expect(receipt?.saleId).toBe(saleId);
      expect(intent?.saleId).toBe(saleId);
      expect(receipt?.saleId).toBe(intent?.saleId);
    });
  });
});

/**
 * SCRUM-121A-PRE — Codex round-4 findings, validated independently.
 *
 * PRE-03 and PRE-04 both say the same thing in different places: the design
 * made load-bearing promises whose evidence either bypassed the real writer or
 * could not observe the fields the promise is about. These close both.
 */
describe("SCRUM-121A-PRE — Codex R4 findings, validated independently", () => {
  /**
   * PRE-04 — §6's actual promise, made observable.
   *
   * §6 promises the zero-applied `collectionPayments` lineage row survives.
   * Nothing in the suite asserted that: CODEX04 asserted only the status flip
   * to PAID, and G5 asserted only the queued GL commands. So an implementation
   * that dropped the row, unlinked it, or changed its timestamps would have
   * passed every test while breaking the one thing §6 exists to protect.
   *
   * This pins current-main behaviour across the whole promise: the row, its
   * amount, its status, its links in both directions, and both readers that
   * surface it. Row visibility and numeric totals are asserted separately,
   * because Sonnet checked the totals and Codex checked the row and they were
   * both right about different halves.
   */
  test("PRE04_the_zero_applied_lineage_row_and_both_readers_that_surface_it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Lineage after cancellation",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
    });
    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelReq,
      status: "APPROVED",
    });
    await asFinance.mutation(api.paymentIntents.markSettled, { orgId, intentId });

    const paymentId = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("collectionPayments")
        .withIndex("by_org_paymentDate", (q) => q.eq("orgId", orgId))
        .collect();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // The lineage row exists and is honest about applying nothing.
      expect(row.amount).toBe(0);
      expect(row.status).toBe("POSTED");
      expect(row.method).toBe("PAYMENT_LINK");
      expect(row.direction).toBe("IN");
      expect(row.receivableId).toBe(receivableId);
      expect(row.customerId).toBe(customerId);
      expect(row.canonicalPaymentId).toBeTruthy();
      // No allocation was made against the cancelled debt.
      expect(row.paymentAllocationId).toBeUndefined();

      // Linked in both directions: the intent points at the row too.
      const intent = await ctx.db.get(intentId);
      expect(intent?.collectionPaymentId).toBe(row._id);
      return row._id;
    });

    // Reader 1 — the receipt/audit list surfaces it.
    const listed = await asFinance.query(api.collections.listPayments, {
      orgId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(listed.page.some((p: { _id: string }) => p._id === paymentId)).toBe(true);

    // Reader 2 — daily collections surfaces it as a PAYMENT_LINK entry, while
    // contributing zero to the method total. Both halves matter: dropping the
    // row would leave the total identical and silently lose the receipt.
    const daily = await asFinance.query(api.collections.dailyCollectionList, {
      orgId,
      businessDate: Date.now(),
    });
    const dailyRows = (daily as { rows?: Array<{ _id: string }> }).rows ?? [];
    expect(dailyRows.some((p) => p._id === paymentId)).toBe(true);
    expect((daily as { totalsByMethod?: Record<string, number> }).totalsByMethod?.PAYMENT_LINK ?? 0).toBe(0);
  });

  /**
   * PRE-03 — the application-cancellation hole, through the REAL mutation.
   *
   * My R3-01 fixture constructed the document directly and then patched
   * `{status: "CANCELLED"}` in a `t.run`. Codex is right that this proves the
   * state is expressible, not that `api.applications.cancelApplication`
   * produces it — it exercises no permission check, no CLOSED eligibility, no
   * disbursedAt guard, no source-key resolution, and no rollback behaviour.
   * Since §7's whole purpose is to justify skipping production repair, the
   * proof has to run the real writer.
   *
   * Here it does. The application is CLOSED with NO disbursedAt (nothing was
   * ever confirmed through confirmDisbursement), so the existing guard at
   * applications.ts:2572 sees a clean deal — while the raw `subledger.allocate`
   * door has already put settled money against the canonical finance document.
   *
   * Control: the same application WITH disbursedAt set is refused, isolating
   * the missing canonical check rather than cancellation logic generally.
   */
  test("PRE03_the_REAL_cancelApplication_mutation_cancels_a_finance_document_holding_an_ACTIVE_allocation", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    await t.run(async (ctx) => {
      const role = await ctx.db.query("roles").filter((q) => q.eq(q.field("orgId"), orgId)).first();
      await ctx.db.patch(role!._id, {
        permissions: [...role!.permissions, "create:finance_application", "finalize:financed_deal"],
      });
    });

    const { applicationId, docId } = await t.run(async (ctx) => {
      const financeCompanyId = await ctx.db.insert("financeCompanies", {
        orgId, name: "Test Bank", isActive: true,
        profitRate: 4.0, maxTermMonths: 60, gracePeriodMonths: 2,
      });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Kia", model: "Optima", year: 2022, mileage: 0,
        color: "Red", fuelType: "Petrol", transmission: "Automatic",
        sellingPrice: 13_000, status: "AVAILABLE",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 13_000, downPayment: 3_000,
        totalFinancedAmount: 10_000, termMonths: 12, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      });
      const appId = await ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId,
        status: "CLOSED",
        // Deliberately NO disbursedAt: nothing was confirmed through
        // confirmDisbursement, so the cancellation guard sees a clean deal.
        createdAt: Date.now(), updatedAt: Date.now(),
      });

      const { createReceivableDocument } = await import("./subledger");
      const receivableDocumentId = await createReceivableDocument(ctx as never, {
        orgId,
        documentType: "INVOICE",
        payerType: "FINANCE_COMPANY",
        financeCompanyId,
        customerId,
        sourceType: "finance_application",
        sourceId: appId,
        originalAmountMinor: 10_000_000,
        currency: "JOD",
        issueDate: Date.now(),
        dueDate: Date.now(),
        actorId: userId,
      });
      return { applicationId: appId, docId: receivableDocumentId };
    });

    // The raw internal door: settled money allocated with no application
    // lifecycle touched, so disbursedAt stays unset.
    await t.run(async (ctx) => {
      const { createCanonicalPayment, allocatePaymentToReceivable } = await import("./subledger");
      const paymentId = await createCanonicalPayment(ctx as never, {
        orgId, direction: "IN", payerType: "FINANCE_COMPANY",
        method: "BANK_TRANSFER", amountMinor: 10_000_000, currency: "JOD",
        idempotencyKey: "pre03_raw", actorId: userId, status: "SETTLED",
      });
      await allocatePaymentToReceivable(ctx as never, {
        orgId, paymentId, receivableDocumentId: docId,
        amountMinor: 10_000_000, actorId: userId,
      });
    });

    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      expect(app?.disbursedAt).toBeUndefined();
    });

    // THE REAL WRITER. INVERTED by §5.1: it now refuses.
    //
    // `disbursedAt` is still unset here — that was the whole finding, and it is
    // why the gate had to read the document rather than the application.
    await expect(
      asFinance.mutation(api.applications.cancelApplication, {
        orgId,
        applicationId,
        reason: "Deal voided",
      })
    ).rejects.toThrow(/still has payments applied to it/i);

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).not.toBe("CANCELLED");
      const allocs = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", docId))
        .filter((q) => q.eq(q.field("status"), "ACTIVE"))
        .collect();
      expect(allocs).toHaveLength(1);
      expect(allocs[0]!.amountMinor).toBe(10_000_000);
      // The application is untouched too. The gate is hoisted above every write
      // in the CLOSED branch, so a refusal cannot leave a half-unwound deal —
      // the sale reversal, the commission void and the teardown all sit below
      // it and never ran.
      const stillOpen = await ctx.db.get(applicationId);
      expect(stillOpen?.status).not.toBe("CANCELLED");
    });
  });
});

/**
 * SCRUM-121A-PRE — Codex round-5 findings, validated independently.
 *
 * Two of the three are defects in my own round-4 CORRECTIONS: the fixture I
 * added to close "the floor cannot observe what §6 promises" still did not
 * observe all of it, and the refusal I added for withdrawn payers created a
 * branch no fixture pins. Recording that plainly, because a fix that needs its
 * own fix is the shape the convergence breaker watches for — it stayed MEDIUM,
 * so the breaker did not fire, but the pattern is the point.
 */
describe("SCRUM-121A-PRE — Codex R5 findings, validated independently", () => {
  /**
   * PRE-09 — §6's promise through the OTHER settlement door, plus the two
   * timestamps the design explicitly promises to preserve.
   *
   * PRE04 called only `api.paymentIntents.markSettled`. The whole
   * characterization file never called `settleByExternalId` — the internal
   * webhook door that shares `createCanonicalIntentSettlement` — so a
   * wrapper-specific regression would have passed the floor. It also asserted
   * neither `lastPaymentAt` nor `updatedAt`, which §6 names as deliberately
   * preserved, nor that the canonical payment the legacy row points at is the
   * same one the intent points at.
   */
  test("PRE09_the_webhook_door_preserves_the_same_lineage_links_and_timestamps", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Webhook settlement after cancellation",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const intentId = await asFinance.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_pre09",
    });

    const before = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return { lastPaymentAt: row?.lastPaymentAt, updatedAt: row?.updatedAt };
    });

    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId,
      receivableId,
      requestType: "CANCEL_RECEIVABLE",
      reason: "Booked in error",
    });
    await asApprover.mutation(api.collections.respondToApproval, {
      orgId,
      requestId: cancelReq,
      status: "APPROVED",
    });

    // The OTHER door: the internal webhook settlement, not markSettled.
    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_pre09",
      amountMinor: 400_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
    });

    await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      // INVERTED with §6: the webhook door leaves the debt closed too. Both
      // settlement entry points share createCanonicalIntentSettlement, and
      // this is what proves the fix is in the shared helper rather than in one
      // wrapper.
      expect(row?.status).toBe("CANCELLED");
      // The timestamps §6 promises to keep writing DO advance here — pinning
      // them so an implementation that suppresses the whole patch is caught.
      expect(row?.lastPaymentAt).toBeDefined();
      expect(row?.lastPaymentAt).not.toBe(before.lastPaymentAt);
      expect(row?.updatedAt).not.toBe(before.updatedAt);

      const payments = await ctx.db
        .query("collectionPayments")
        .withIndex("by_org_paymentDate", (q) => q.eq("orgId", orgId))
        .collect();
      expect(payments).toHaveLength(1);
      const payment = payments[0]!;
      expect(payment.amount).toBe(0);
      expect(payment.status).toBe("POSTED");
      expect(payment.paymentAllocationId).toBeUndefined();

      // Both sides name the SAME canonical receipt. PRE04 asserted each link
      // existed; it never asserted they agree.
      const intent = await ctx.db.get(intentId);
      expect(intent?.collectionPaymentId).toBe(payment._id);
      expect(intent?.canonicalPaymentId).toBeTruthy();
      expect(payment.canonicalPaymentId).toBe(intent?.canonicalPaymentId);
      expect(intent?.paymentAllocationId).toBeUndefined();
    });
  });

  /**
   * PRE-10 — the withdrawn-payer refusal has more doors than EV6 exercises.
   *
   * EV6 proved a soft-deleted customer stays payable through `recordPayment`.
   * §3.3 extends the refusal to `paymentIntents.create` and cheque
   * registration, and neither had a fixture — so an implementation that
   * covered only `recordPayment`, or put the cheque check in the public
   * wrapper instead of the shared `registerChequeCore`, would have passed.
   *
   * These pin current main's acceptance at each door, so each becomes a
   * failing-first regression when the refusal lands.
   */
  test("PRE10_a_withdrawn_payer_can_still_be_sent_a_payment_link_and_a_new_cheque", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    registerRateLimiter(t);
    const { orgId, customerId, asFinance } = await seedFinanceMember(t);

    await t.run(async (ctx) => {
      const role = await ctx.db.query("roles").filter((q) => q.eq(q.field("orgId"), orgId)).first();
      await ctx.db.patch(role!._id, {
        permissions: [...role!.permissions, "delete:customers"],
      });
    });

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Owed by a withdrawn payer",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    await asFinance.mutation(api.customers.softDelete, { orgId, customerId });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(customerId))?.isDeleted).toBe(true);
    });

    // INVERTED by §3.3, both doors. Each asserted acceptance against main and
    // each failed when its refusal landed — separately, which is the point of
    // pinning them independently: an implementation covering only one door
    // would still be failing this test.
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId,
        customerId,
        receivableId,
        amountMinor: 100_000,
        currency: "JOD",
        provider: "tap",
      })
    ).rejects.toThrow(/removed and can no longer be sent a payment request/i);

    await expect(
      asFinance.mutation(api.collections.registerCheque, {
        orgId,
        receivableId,
        customerId,
        bank: "Arab Bank",
        chequeNumber: "PRE10-1",
        chequeDate: DUE(),
        amount: 200,
      })
    ).rejects.toThrow(/removed and cannot have new cheques registered/i);

    await t.run(async (ctx) => {
      const cheques = await ctx.db
        .query("postDatedCheques")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(cheques).toHaveLength(0);
      const intents = await ctx.db
        .query("paymentIntents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();
      expect(intents).toHaveLength(0);
    });
  });
});

/**
 * SCRUM-121A-PRE — the verification floor §8 still owed after the fixtures
 * above were inverted.
 *
 * Every test here was written AGAINST the implemented behaviour rather than
 * before it, so none of them is failing-first evidence and none is presented as
 * such. Their job is different: each pins a branch of the new rules that no
 * inverted fixture reaches, so that a later change which quietly widens one of
 * them fails here. The failing-first proofs are the fourteen inverted fixtures
 * plus `CODEXR6`.
 */
describe("SCRUM-121A-PRE — verification floor", () => {
  async function seedVehicleAndSale(
    t: ReturnType<typeof convexTestWithComponents>,
    orgId: Id<"organizations">,
    customerId: Id<"customers">,
    userId: Id<"users">
  ) {
    return await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Toyota", model: "Corolla", year: 2024, mileage: 0, color: "White",
        fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 20000, status: "SOLD",
      });
      const saleId = await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 20000, saleDate: Date.now(), status: "COMPLETED",
      });
      return { vehicleId, saleId };
    });
  }

  /**
   * §4 — the mode matrix. The rule is that a resolved target is proved however
   * it was resolved, so each row supplies the target a DIFFERENT way and the
   * control proves the consistent call still goes through.
   */
  test("FLOOR_every_mode_that_resolves_a_target_proves_it_before_funds", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId,
      customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Target",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });

    // CURRENCY. The case that used to be accepted here and then destroy a
    // confirmed receipt inside assertSameCurrency at settlement.
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableId,
        amountMinor: 100_000, currency: "USD", provider: "tap",
      })
    ).rejects.toThrow(/currency does not match/i);

    // SALE-ONLY with no document to collect against — UNPROVEN_TARGET.
    const { saleId } = await seedVehicleAndSale(t, orgId, customerId, userId);
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, saleId,
        amountMinor: 100_000, currency: "JOD", provider: "tap",
      })
    ).rejects.toThrow(/no accounting document to collect against/i);

    // SALE contradicting a document that WAS proved. The sale names a debt of
    // its own; the two cannot both be the target.
    const otherDocId = await t.run(async (ctx) => {
      const { createReceivableDocument } = await import("./subledger");
      return (await createReceivableDocument(ctx as never, {
        orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
        sourceType: "legacy_receivable", sourceId: "floor-other-debt",
        originalAmountMinor: 1_000_000, currency: "JOD",
        issueDate: Date.now(), dueDate: DUE(), actorId: userId,
      })) as Id<"receivableDocuments">;
    });
    await t.run((ctx) => ctx.db.patch(saleId, { canonicalReceivableDocumentId: otherDocId }));
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableId, saleId,
        amountMinor: 100_000, currency: "JOD", provider: "tap",
      })
    ).rejects.toThrow(/sale does not match the selected debt/i);

    // TERMINAL canonical status, reached through the document rather than the
    // legacy row — the legacy terminal check cannot see this.
    await t.run((ctx) => ctx.db.patch(docId, { status: "PAID" }));
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableId,
        amountMinor: 100_000, currency: "JOD", provider: "tap",
      })
    ).rejects.toThrow(/can no longer accept payments/i);

    // CONTROL — restore the one field each refusal turned on, and the same call
    // succeeds. Without this the four rejections above would also pass against
    // a mutation that refused everything.
    await t.run((ctx) => ctx.db.patch(docId, { status: "OPEN" }));
    await t.run((ctx) => ctx.db.patch(saleId, { canonicalReceivableDocumentId: docId }));
    await expect(
      asFinance.mutation(api.paymentIntents.create, {
        orgId, customerId, receivableId, saleId,
        amountMinor: 100_000, currency: "JOD", provider: "tap",
      })
    ).resolves.toBeTruthy();
  });

  /**
   * §3.1 — the contradictions D1 does not cover: the vehicle and the sale in
   * receivable mode, and the ad-hoc shape that has no receivable at all.
   */
  test("FLOOR_contradictory_vehicle_sale_and_ad_hoc_targets_are_refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId, userId, asFinance } = await seedFinanceMember(t);
    const { vehicleId, saleId } = await seedVehicleAndSale(t, orgId, customerId, userId);

    const otherCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Rania", lastName: "Saeed", phone: "+962790000222" })
    );
    const other = await seedVehicleAndSale(t, orgId, otherCustomerId, userId);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId, customerId, vehicleId, saleId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Correlated debt",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // Receivable mode: the caller names a different vehicle.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, receivableId, vehicleId: other.vehicleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow(/vehicle does not match/i);

    // Receivable mode: the caller names a different sale.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, receivableId, saleId: other.saleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow(/sale does not match/i);

    // Ad-hoc mode: no receivable, and the sale belongs to somebody else. This
    // is the shape that stored cleanly while attributing the canonical payment
    // to one customer and every operational reader to another.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, customerId, saleId: other.saleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow(/sale belongs to a different customer/i);

    // CONTROL — the ad-hoc shape stays supported when it is consistent, and a
    // vehicle-only ad-hoc payment stays unconstrained: a vehicle does not imply
    // a customer, and refusing that would refuse legitimate counter takings.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, customerId, saleId, vehicleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).resolves.toBeTruthy();
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, customerId, vehicleId: other.vehicleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).resolves.toBeTruthy();
  });

  /**
   * §5.1 — the refused cancellation is a whole-world zero delta, on the
   * finance-application writer specifically.
   *
   * CORRECTED after the cross-family seat's LOW finding, which was right: the
   * first version of this test claimed it proved the gate sits above the
   * destructive teardown, while its fixture had no `finalizedSaleId` and no
   * idempotency key — so neither the teardown branch nor the documented
   * STARTED-row case ever executed. Equality after an uncaught throw showed
   * rollback, which is a weaker property than the one the comment asserted.
   *
   * The fixture now carries BOTH. The application names a COMPLETED sale, so
   * the branch that reverses the sale, voids the commission and runs the
   * destructive teardown is genuinely reachable below the gate; and an
   * idempotency key is supplied, so `runWithIdempotency` inserts its STARTED
   * row before the callback. The assertion that the whole money world plus that
   * row are unchanged is therefore now the claim the comment makes.
   */
  test("FLOOR_a_refused_application_cancellation_writes_nothing_at_all", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    // Cancelling a CLOSED deal requires finalization authority, so the refusal
    // is reached on its merits rather than by falling out at the permission
    // check — which would make this test pass without exercising the gate.
    await t.run(async (ctx) => {
      const role = await ctx.db.query("roles").filter((q) => q.eq(q.field("orgId"), orgId)).first();
      await ctx.db.patch(role!._id, {
        permissions: [...role!.permissions, "create:finance_application", "finalize:financed_deal"],
      });
    });

    const applicationId = await t.run(async (ctx) => {
      const financeCompanyId = await ctx.db.insert("financeCompanies", {
        orgId, name: "Floor Finance Co", isActive: true,
        profitRate: 5.5, maxTermMonths: 72, gracePeriodMonths: 3,
      });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Nissan", model: "Sunny", year: 2023, mileage: 10, color: "Grey",
        fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 15000, status: "SOLD",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 15000, downPayment: 5000,
        totalFinancedAmount: 10000, termMonths: 36, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      });
      const finalizedSaleId = await ctx.db.insert("sales", {
        orgId, vehicleId, customerId, salespersonId: userId,
        salePrice: 15000, saleDate: Date.now(), status: "COMPLETED",
      });
      return await ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId, status: "CLOSED",
        finalizedSaleId,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    });

    const docId = await t.run(async (ctx) => {
      const { createReceivableDocument, createCanonicalPayment, allocatePaymentToReceivable } =
        await import("./subledger");
      const company = await ctx.db
        .query("financeCompanies")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .first();
      const id = await createReceivableDocument(ctx as never, {
        orgId, documentType: "INVOICE", payerType: "FINANCE_COMPANY",
        financeCompanyId: company!._id, customerId,
        sourceType: "finance_application", sourceId: applicationId,
        originalAmountMinor: 10_000_000, currency: "JOD",
        issueDate: Date.now(), dueDate: Date.now(), actorId: userId,
      });
      const paymentId = await createCanonicalPayment(ctx as never, {
        orgId, direction: "IN", payerType: "FINANCE_COMPANY",
        method: "BANK_TRANSFER", amountMinor: 10_000_000, currency: "JOD",
        idempotencyKey: "floor_alloc", actorId: userId, status: "SETTLED",
      });
      await allocatePaymentToReceivable(ctx as never, {
        orgId, paymentId, receivableDocumentId: id,
        amountMinor: 10_000_000, actorId: userId,
      });
      return id as Id<"receivableDocuments">;
    });

    const before = await snapshotMoneyWorld(t);
    await expect(
      asFinance.mutation(api.applications.cancelApplication, {
        orgId, applicationId, reason: "Deal voided",
        // Supplied so runWithIdempotency inserts its STARTED row BEFORE the
        // callback runs. The refusal must roll that row back too — a caught
        // exception in Convex would commit it.
        idempotencyKey: "floor_zero_write_probe",
      })
    ).rejects.toThrow(/still has payments applied to it/i);
    expect(await snapshotMoneyWorld(t)).toBe(before);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(docId))?.status).not.toBe("CANCELLED");
      const app = await ctx.db.get(applicationId);
      expect(app?.status).toBe("CLOSED");
      // The teardown branch below the gate never ran: the sale it would have
      // reversed is still COMPLETED.
      expect((await ctx.db.get(app!.finalizedSaleId!))?.status).toBe("COMPLETED");
      // …and the idempotency STARTED row rolled back with everything else.
      const started = await ctx.db
        .query("commandIdempotency")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .collect();
      expect(started).toHaveLength(0);
    });
  });

  /**
   * §5.2 on the FINANCE writer — the positive case nothing else reaches.
   *
   * PRE03 used to assert this writer left `cancelledAt` undefined. Inverting it
   * into a refusal closed that observation: the refusing path never reaches the
   * patch, so after the inversion no fixture watched the finance writer actually
   * STAMP the metadata. Same document, no allocation, so cancellation proceeds.
   */
  test("FLOOR_the_finance_writer_stamps_cancellation_metadata_when_it_does_cancel", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    await t.run(async (ctx) => {
      const role = await ctx.db.query("roles").filter((q) => q.eq(q.field("orgId"), orgId)).first();
      await ctx.db.patch(role!._id, {
        permissions: [...role!.permissions, "create:finance_application", "finalize:financed_deal"],
      });
    });

    const { applicationId, docId } = await t.run(async (ctx) => {
      const financeCompanyId = await ctx.db.insert("financeCompanies", {
        orgId, name: "Metadata Finance Co", isActive: true,
        profitRate: 5.0, maxTermMonths: 60, gracePeriodMonths: 2,
      });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Hyundai", model: "Accent", year: 2023, mileage: 5, color: "Blue",
        fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 12000, status: "AVAILABLE",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000,
        totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      });
      const appId = await ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId, status: "CLOSED",
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const { createReceivableDocument } = await import("./subledger");
      const id = await createReceivableDocument(ctx as never, {
        orgId, documentType: "INVOICE", payerType: "FINANCE_COMPANY",
        financeCompanyId, customerId,
        sourceType: "finance_application", sourceId: appId,
        originalAmountMinor: 10_000_000, currency: "JOD",
        issueDate: Date.now(), dueDate: Date.now(), actorId: userId,
      });
      return { applicationId: appId, docId: id as Id<"receivableDocuments"> };
    });

    await asFinance.mutation(api.applications.cancelApplication, {
      orgId, applicationId, reason: "Customer withdrew",
    });

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).toBe("CANCELLED");
      expect(typeof doc?.cancelledAt).toBe("number");
      expect(doc?.cancelledBy).toBe(userId);
      expect(doc?.cancellationReason).toBe("Customer withdrew");
    });
  });

  /**
   * CODEX-R6 — a GAP-FILLED link may not contradict the receivable's other facts.
   *
   * The §3.1 contradiction checks compare like-named fields only, and the ad-hoc
   * sale correlation was gated on there being NO receivable. Between those two
   * rules sat this hole: when the receivable carries no sale of its own, the
   * caller's sale is not a contradiction of anything, so it was accepted and
   * derived — attaching customer B's deal to customer A's debt, with the payment
   * stored against A.
   *
   * This is the same class as D1, one level indirect: D1 caught the caller
   * contradicting a value the row HAS; this catches the caller contradicting a
   * value the row IMPLIES.
   */
  test("CODEXR6_a_caller_filled_sale_may_not_contradict_the_receivables_own_customer", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, customerId: customerA, userId, asFinance } = await seedFinanceMember(t);

    const customerB = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Bilal", lastName: "Nasser", phone: "+962790000333" })
    );

    // Customer B's deal.
    const salesB = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Honda", model: "Civic", year: 2022, mileage: 100, color: "Silver",
        fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 18000, status: "SOLD",
      });
      const saleId = await ctx.db.insert("sales", {
        orgId, vehicleId, customerId: customerB, salespersonId: userId,
        salePrice: 18000, saleDate: Date.now(), status: "COMPLETED",
      });
      return { vehicleId, saleId };
    });

    // Customer A's debt, carrying NO sale of its own — so the caller's sale is
    // not a contradiction of any like-named field.
    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId, customerId: customerA,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "A's debt, no sale attached",
      amount: 1000, dueDate: DUE(), creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    const before = await snapshotMoneyWorld(t);
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, receivableId, saleId: salesB.saleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow(/sale belongs to a different customer/i);
    expect(await snapshotMoneyWorld(t)).toBe(before);

    // …and the vehicle variant: the receivable carries no vehicle, so a
    // caller-filled vehicle that disagrees with the resolved sale is the same
    // hole one field over.
    const receivableWithSale = await asFinance.mutation(api.collections.createReceivable, {
      orgId, customerId: customerB, saleId: salesB.saleId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "B's debt, sale but no vehicle",
      amount: 1000, dueDate: DUE(), creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const strangerVehicle = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, make: "Ford", model: "Focus", year: 2019, mileage: 900, color: "Green",
        fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 9000, status: "AVAILABLE",
      })
    );
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, receivableId: receivableWithSale, vehicleId: strangerVehicle,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).rejects.toThrow(/sale is for a different vehicle/i);

    // CONTROL — the same gap-filling is still ACCEPTED when it agrees. The
    // point of the rule is that an absent field stays fillable; only a
    // contradiction is refused.
    await expect(
      asFinance.mutation(api.collections.recordPayment, {
        orgId, receivableId: receivableWithSale, vehicleId: salesB.vehicleId,
        amount: 100, method: "CASH", paymentDate: Date.now(),
      })
    ).resolves.toBeTruthy();
  });

  /**
   * CR-2 — a stale canonical link refuses instead of gating another document.
   *
   * CodeRabbit found that neither the gate's resolver nor
   * `ensureCanonicalReceivableForLegacy` validates the stored link's source
   * key. The finding is real as a property; it is NOT reachable, because
   * `receivables.canonicalReceivableDocumentId` has exactly one production
   * writer and it always stores the document resolved from this receivable's
   * own source key. So this constructs the state.
   *
   * Its proposed fix — validate the link and fall through to the source key —
   * was SUPERSEDED: that would make the gate prove the absence of allocations
   * on one document while the cancellation patched a different one, which is
   * strictly worse than the state it was fixing. Refusing is the fix.
   */
  test("FLOOR_a_stale_canonical_link_refuses_cancellation_rather_than_gating_the_wrong_document", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance, asApprover } = await seedFinanceMember(t);

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId, customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Mislinked debt",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });

    // A real, unrelated document in the same organization, and a live
    // allocation against the receivable's REAL document — so a gate that
    // followed the stale link would read the unrelated document, find it clean,
    // and cancel while real money stayed applied to the true one.
    const { strangerDocId, realDocId } = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      const { createReceivableDocument, createCanonicalPayment, allocatePaymentToReceivable } =
        await import("./subledger");
      const stranger = await createReceivableDocument(ctx as never, {
        orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId,
        sourceType: "legacy_receivable", sourceId: "some-other-receivable",
        originalAmountMinor: 500_000, currency: "JOD",
        issueDate: Date.now(), dueDate: DUE(), actorId: userId,
      });
      const paymentId = await createCanonicalPayment(ctx as never, {
        orgId, direction: "IN", payerType: "CUSTOMER", customerId,
        method: "CASH", amountMinor: 300_000, currency: "JOD",
        idempotencyKey: "stale_link_alloc", actorId: userId, status: "SETTLED",
      });
      await allocatePaymentToReceivable(ctx as never, {
        orgId, paymentId,
        receivableDocumentId: row!.canonicalReceivableDocumentId!,
        amountMinor: 300_000, actorId: userId,
      });
      return {
        strangerDocId: stranger as Id<"receivableDocuments">,
        realDocId: row!.canonicalReceivableDocumentId!,
      };
    });

    await t.run((ctx) => ctx.db.patch(receivableId, { canonicalReceivableDocumentId: strangerDocId }));

    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId, receivableId, requestType: "CANCEL_RECEIVABLE", reason: "Booked in error",
    });
    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId, requestId: cancelReq, status: "APPROVED",
      })
    ).rejects.toThrow(/cannot be identified/i);

    await t.run(async (ctx) => {
      // Neither document was touched, and the live allocation is still live.
      expect((await ctx.db.get(strangerDocId))?.status).not.toBe("CANCELLED");
      expect((await ctx.db.get(realDocId))?.status).not.toBe("CANCELLED");
      expect((await ctx.db.get(receivableId))?.status).not.toBe("CANCELLED");
    });
  });

  /**
   * CR-1 — a blank cancellation reason is normalized, not stored.
   *
   * `args.reason` is an optional STRING, so `??` only catches undefined. An
   * empty or whitespace-only reason passed straight through and produced a
   * cancelledAt/cancelledBy pair with no reason beside it — the one field of
   * that trio a person actually reads.
   */
  test("FLOOR_a_blank_finance_cancellation_reason_is_normalized_not_stored", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance } = await seedFinanceMember(t);

    await t.run(async (ctx) => {
      const role = await ctx.db.query("roles").filter((q) => q.eq(q.field("orgId"), orgId)).first();
      await ctx.db.patch(role!._id, {
        permissions: [...role!.permissions, "create:finance_application", "finalize:financed_deal"],
      });
    });

    const { applicationId, docId } = await t.run(async (ctx) => {
      const financeCompanyId = await ctx.db.insert("financeCompanies", {
        orgId, name: "Blank Reason Finance", isActive: true,
        profitRate: 5.0, maxTermMonths: 60, gracePeriodMonths: 2,
      });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, make: "Mazda", model: "6", year: 2023, mileage: 5, color: "Black",
        fuelType: "PETROL", transmission: "AUTOMATIC", sellingPrice: 12000, status: "AVAILABLE",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000,
        totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      });
      const appId = await ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId, status: "CLOSED",
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const { createReceivableDocument } = await import("./subledger");
      const id = await createReceivableDocument(ctx as never, {
        orgId, documentType: "INVOICE", payerType: "FINANCE_COMPANY",
        financeCompanyId, customerId,
        sourceType: "finance_application", sourceId: appId,
        originalAmountMinor: 10_000_000, currency: "JOD",
        issueDate: Date.now(), dueDate: Date.now(), actorId: userId,
      });
      return { applicationId: appId, docId: id as Id<"receivableDocuments"> };
    });

    await asFinance.mutation(api.applications.cancelApplication, {
      orgId, applicationId, reason: "   ",
    });

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(docId);
      expect(doc?.status).toBe("CANCELLED");
      expect(doc?.cancellationReason).toBe("Finance application cancelled");
      expect(doc?.cancellationReason?.trim()).not.toBe("");
    });
  });

  /**
   * §5.1 — the bounded probe's own refusal. The limit exists because
   * `by_receivable` carries no status, so a long REVERSED history is scanned
   * whether or not it is returned; this pins that the gate fails CLOSED when it
   * cannot prove the absence, rather than reading a truncated page and
   * permitting the cancellation.
   *
   * Constructed, deliberately: no fixture can produce 200 real allocations
   * cheaply, and the property under test is the limit itself.
   */
  test("FLOOR_an_unprovable_allocation_history_refuses_rather_than_permitting", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId, customerId, asFinance, asApprover } = await seedFinanceMember(t);
    // Read the bound from the implementation rather than restating it, so the
    // test cannot silently drift out of agreement with the gate it pins.
    const { ALLOCATION_HISTORY_PROBE_LIMIT } = await import("./collections");

    const receivableId = await asFinance.mutation(api.collections.createReceivable, {
      orgId, customerId,
      sourceType: "INTERNAL_INSTALLMENT",
      title: "Long history",
      amount: 1000,
      dueDate: DUE(),
      creditSystemKey: "MISCELLANEOUS_INCOME",
    });
    const docId = await t.run(async (ctx) => {
      const row = await ctx.db.get(receivableId);
      return row!.canonicalReceivableDocumentId!;
    });

    // 201 REVERSED allocations: none is ACTIVE, so the gate would permit the
    // cancellation if it read them — but it cannot prove that within its bound.
    await t.run(async (ctx) => {
      const paymentId = await ctx.db.insert("canonicalPayments", {
        orgId, direction: "IN", method: "CASH", amountMinor: 1,
        currency: "JOD", scale: 3, status: "SETTLED",
        idempotencyKey: "floor_history_probe",
        receivedAt: Date.now(), createdAt: Date.now(), createdBy: userId,
      });
      for (let i = 0; i < ALLOCATION_HISTORY_PROBE_LIMIT + 1; i++) {
        await ctx.db.insert("paymentAllocations", {
          orgId, paymentId, receivableDocumentId: docId,
          amountMinor: 1, currency: "JOD", scale: 3,
          allocationDate: Date.now(), status: "REVERSED",
          createdBy: userId, createdAt: Date.now(),
        });
      }
    });

    const cancelReq = await asFinance.mutation(api.collections.requestApproval, {
      orgId, receivableId, requestType: "CANCEL_RECEIVABLE", reason: "Booked in error",
    });
    await expect(
      asApprover.mutation(api.collections.respondToApproval, {
        orgId, requestId: cancelReq, status: "APPROVED",
      })
    ).rejects.toThrow(/too long an allocation history/i);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(docId))?.status).not.toBe("CANCELLED");
    });
  });
});
