/**
 * SCRUM-760 ruling 11 (c23812): the legacy COLLECTION REFUND door is blocked SERVER-SIDE
 * for the narrow pilot (convex/utils/legacyCollectionRefundContainment.ts).
 *
 * Two doors, two EXPECTED-REFUSAL cells (docs/architecture/scrum486-certification-oracle.md,
 * row LREF). A cell passes only when:
 *   - the call goes through the door's own public entry, by an authorized actor, with valid arguments;
 *   - it asserts the specific containment code and that the text says nothing was changed;
 *   - a full snapshot of EVERY schema table AND the scheduler is identical before and after
 *     (journals, payments, allocations, receivables, outbox, idempotency ledger: not a spot check);
 *   - flipping the server-side switch turns the cell red (the mutation attack, run in-suite).
 *
 * Also pinned: a REFUND request created BEFORE the switch is not payable while it is ON, a stored
 * replay of an approval done before the switch is refused too, REJECTING a REFUND request still
 * works, and the non-REFUND approval types (RESCHEDULE, CANCEL_RECEIVABLE) still work.
 *
 * The census of suites that run with the block off lives in
 * scripts/legacyCollectionRefundOptOutCensus.test.ts.
 *
 * Evidence boundary: convex-test only. It is repository behaviour, not the Convex runtime, and
 * not the real-backend replay that SCRUM-762 requires.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import type { LegacyCollectionRefundSwitchState } from "../test-utils/legacyCollectionRefundSwitches";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { hookCollectionRefund } from "./accounting/workflowHooks";
import schema from "./schema";
import { reverseAllocation } from "./subledger";
import { outboxRows, settleOutbox } from "../test-utils/outboxWork";

/** Live handle on the switch; the shipped state is ON. Only this file's mock reads it. */
const switches = vi.hoisted(
  (): LegacyCollectionRefundSwitchState => ({
    legacyCollectionRefund: true,
  })
);
vi.mock("./utils/legacyCollectionRefundContainment", async (importOriginal) =>
  (await import("../test-utils/legacyCollectionRefundSwitches")).withLegacyCollectionRefundSwitch(
    await importOriginal(),
    switches
  )
);

const CODE = "LEGACY_COLLECTION_REFUND_PILOT_DISABLED";
const ALL_TABLES = Object.keys(schema.tables);

// Notifications schedule work; fake timers keep it from firing after environment teardown.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTestWithComponents>;

async function seed() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "LREF Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "lref_requester", email: "lref.requester@example.com", name: "LREF Requester" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "lref_approver", email: "lref.approver@example.com", name: "LREF Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Finance Manager", permissions: ["view:finance", "manage:finance", "approve:requests"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser", phone: "+962790000000" })
  );
  const bankAccountId = await t.run((ctx) =>
    ctx.db.insert("bankAccounts", {
      orgId, name: "LREF bank", currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now(),
      isActive: true, isReconciliationTarget: false, createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  return {
    t, orgId, customerId, bankAccountId,
    asFinance: t.withIdentity({ subject: "lref_requester", clerkId: "lref_requester" }),
    asApprover: t.withIdentity({ subject: "lref_approver", clerkId: "lref_approver" }),
  };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** A receivable with `paid` collected (the legitimate, still-enabled collection path). */
async function receivableWithPayment(s: Seeded, title: string, paid = 1000) {
  const receivableId = await s.asFinance.mutation(api.collections.createReceivable, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, customerId: s.customerId,
    sourceType: "RESERVATION_PAYMENT", title, amount: 1000, dueDate: Date.now() + 7 * 86_400_000,
  });
  if (paid > 0) {
    await s.asFinance.mutation(api.collections.recordPayment, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, receivableId, amount: paid, method: "CASH",
      paymentDate: Date.now(),
    });
  }
  return receivableId;
}

const refundRequest = (s: Seeded, receivableId: Id<"receivables">, method: "CASH" | "BANK_TRANSFER" = "CASH") =>
  s.asFinance.mutation(api.collections.requestApproval, {
    orgId: s.orgId, receivableId, requestType: "REFUND", requestedAmount: 200, disbursementMethod: method,
    ...(method === "BANK_TRANSFER" ? { bankAccountId: s.bankAccountId } : {}),
    reason: "Customer overpaid",
  });

const respond = (s: Seeded, requestId: Id<"collectionApprovalRequests">, status: "APPROVED" | "REJECTED", key = crypto.randomUUID()) =>
  s.asApprover.mutation(api.collections.respondToApproval, { orgId: s.orgId, requestId, status, idempotencyKey: key });

/** Runs `fn` with the switch off (the door open), then restores the shipped state. */
async function withSwitchOff<R>(fn: () => Promise<R>): Promise<R> {
  switches.legacyCollectionRefund = false;
  try {
    return await fn();
  } finally {
    switches.legacyCollectionRefund = true;
  }
}

/** Every schema table AND the scheduler: a refusal that queued work is a write. */
async function snapshot(t: T) {
  const tables = await dbSnapshot(t, ALL_TABLES);
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return { tables, scheduled };
}

async function expectRefusedAndUnchanged(s: { t: T }, call: () => Promise<unknown>) {
  const before = await snapshot(s.t);
  const refusal = await refusalDataOf(call());
  expect(refusal?.code).toBe(CODE);
  expect(refusal?.message).toMatch(/pilot/i);
  expect(refusal?.message).toMatch(/Nothing has been changed/);
  expect(await snapshot(s.t)).toEqual(before);
}

async function outPayments(s: Seeded, receivableId: Id<"receivables">) {
  return (await s.t.run((ctx) =>
    ctx.db.query("collectionPayments").withIndex("by_receivable", (q) => q.eq("receivableId", receivableId)).collect()
  )).filter((p) => p.direction === "OUT");
}

describe("the shipped switch is ON (unmocked pin)", () => {
  test("the switch is the literal true and the pure guard and accessor follow it", async () => {
    const real = await vi.importActual<typeof import("./utils/legacyCollectionRefundContainment")>(
      "./utils/legacyCollectionRefundContainment"
    );
    expect(real.LEGACY_COLLECTION_REFUND_PILOT_DISABLED).toBe(true);
    expect(() => real.assertLegacyCollectionRefundAllowed()).toThrow();
    // The pure guard passes when its switch is off, so a flipped switch is observable.
    expect(() => real.assertLegacyCollectionRefundAllowed(false)).not.toThrow();
    expect(real.isLegacyCollectionRefundDisabled()).toBe(true);
    expect(real.isLegacyCollectionRefundDisabled(false)).toBe(false);
  });

  test("the refusal code is an AppErrorCode with its own pilot message", async () => {
    const real = await vi.importActual<typeof import("./utils/legacyCollectionRefundContainment")>(
      "./utils/legacyCollectionRefundContainment"
    );
    const { AppErrorCode } = await import("./utils/errors");
    expect(Object.keys(real.LEGACY_COLLECTION_REFUND_REFUSALS)).toEqual([CODE]);
    expect(Object.values(AppErrorCode)).toContain(CODE);
  });
});

describe("collections.requestApproval REFUND is blocked", () => {
  test.each(["CASH", "BANK_TRANSFER"] as const)("a %s refund request is refused and nothing changes", async (method) => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, `Refund request ${method}`);
    await expectRefusedAndUnchanged(s, () => refundRequest(s, receivableId, method));
  });

  test("MUTATION ATTACK: with the switch flipped off the same request is accepted", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Request attack");
    const requestId = await withSwitchOff(() => refundRequest(s, receivableId));
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
  });
});

describe("collections.respondToApproval APPROVED on a REFUND request is blocked", () => {
  test("a request created before the switch is not payable: refused, nothing changes, request stays PENDING", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Pre-switch request");
    const requestId = await withSwitchOff(() => refundRequest(s, receivableId));
    await expectRefusedAndUnchanged(s, () => respond(s, requestId, "APPROVED"));
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING");
    expect(await outPayments(s, receivableId)).toHaveLength(0);
  });

  test("a bank-rail request is refused too", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Bank request");
    const requestId = await withSwitchOff(() => refundRequest(s, receivableId, "BANK_TRANSFER"));
    await expectRefusedAndUnchanged(s, () => respond(s, requestId, "APPROVED"));
  });

  test("a stored replay of an approval done before the switch is refused too (refusal precedes the idempotency wrapper)", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Replay");
    const requestId = await withSwitchOff(() => refundRequest(s, receivableId));
    const key = crypto.randomUUID();
    await withSwitchOff(() => respond(s, requestId, "APPROVED", key));
    await expectRefusedAndUnchanged(s, () => respond(s, requestId, "APPROVED", key));
  });

  test("MUTATION ATTACK: with the switch flipped off the same approval pays the refund", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Approval attack");
    const requestId = await withSwitchOff(() => refundRequest(s, receivableId));
    expect(await refusalDataOf(withSwitchOff(() => respond(s, requestId, "APPROVED")))).toBeNull();
    expect(await outPayments(s, receivableId)).toHaveLength(1);
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(200);
  });

  test("REJECTING a pending REFUND request stays possible and pays nothing", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Reject");
    const requestId = await withSwitchOff(() => refundRequest(s, receivableId));
    const before = await s.t.run((ctx) => ctx.db.get(receivableId));
    expect(await refusalDataOf(respond(s, requestId, "REJECTED"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("REJECTED");
    expect(await outPayments(s, receivableId)).toHaveLength(0);
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(before?.outstandingAmount);
  });
});

describe("CONTROLS: the other approval types still work with the switch ON", () => {
  test("RESCHEDULE request and approval", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Reschedule", 0);
    const newDue = Date.now() + 30 * 86_400_000;
    const requestId = await s.asFinance.mutation(api.collections.requestApproval, {
      orgId: s.orgId, receivableId, requestType: "RESCHEDULE", requestedDueDate: newDue, reason: "Customer asked",
    });
    await respond(s, requestId, "APPROVED");
    const row = await s.t.run((ctx) => ctx.db.get(receivableId));
    expect(row?.dueDate).toBe(newDue);
    expect(row?.status).toBe("RESCHEDULED");
  });

  test("CANCEL_RECEIVABLE request and approval on an unpaid receivable", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Cancel", 0);
    const requestId = await s.asFinance.mutation(api.collections.requestApproval, {
      orgId: s.orgId, receivableId, requestType: "CANCEL_RECEIVABLE", reason: "Raised in error",
    });
    await respond(s, requestId, "APPROVED");
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("CANCELLED");
  });

  test("recording the collection itself (the enabled path) still works", async () => {
    const s = await seed();
    const receivableId = await receivableWithPayment(s, "Collect", 400);
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.outstandingAmount).toBe(600);
  });
});


// ---------------------------------------------------------------------------------------------
// INTERNAL DOORS (Seat 2 P1 on PR #698). The public pair above is not the only way to start a
// refund payout or post a refund: operator-only internal mutations and the posting producer reach
// the same money. Caller enumeration (git grep over non-test code, 2026-10-28):
//   accountingLedger.post                 no production caller (operator door, tests only)
//   subledger.recordPayment               no production caller
//   subledger.reverseAllocationMutation   no production caller (cancel, unwind and cheque return
//                                         call the `reverseAllocation` HELPER directly, not this)
//   hookCollectionRefund                  one caller: collections.respondToApproval (blocked above)
//   accountingOutbox.postOutboxRow        only posts rows that enqueuePendingPost wrote; the only
//                                         producer of a COLLECTION_REFUND row is hookCollectionRefund
// So no new refund can start through any door. A refund event queued BEFORE the switch records a
// payout that already happened (the OUT payment and allocation reversal committed in the same
// transaction as the enqueue), so the outbox is deliberately NOT blocked: holding or failing that
// row would leave the books without accounting that is owed.
// ---------------------------------------------------------------------------------------------

async function seedLedger(tag: string, withChart = true) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `LREF ledger ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `lref_ledger_${tag}`, email: `${tag}@lref.example.com`, name: "LREF Operator" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true, permissions: ["view:finance", "manage:finance", "view:sales"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"] })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Cust", lastName: tag, createdAt: Date.now() })
  );
  const asOperator = t.withIdentity({ subject: `lref_ledger_${tag}`, clerkId: `lref_ledger_${tag}` });
  const s = { t, orgId, userId, customerId, asOperator };
  if (withChart) await openChartAndPeriod(s);
  return s;
}
type LedgerSeed = Awaited<ReturnType<typeof seedLedger>>;

async function openChartAndPeriod(s: Pick<LedgerSeed, "orgId" | "asOperator">) {
  await s.asOperator.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
  const year = new Date().getUTCFullYear();
  await s.asOperator.mutation(api.accountingPeriods.create, {
    orgId: s.orgId, startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year, periodNumber: 1,
  });
  const period = (await s.asOperator.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
  await s.asOperator.mutation(api.accountingPeriods.open, { orgId: s.orgId, periodId: period._id });
}

const ledgerRefundArgs = (s: LedgerSeed, key: string) => {
  const now = Date.now();
  return {
    orgId: s.orgId, eventType: "COLLECTION_REFUND", sourceType: "collectionPayments", sourceId: `pay_${key}`,
    eventVersion: 1, accountingDate: now, occurredAt: now, currency: "USD", idempotencyKey: `collection_refund_${key}`,
    payload: { paymentId: `pay_${key}`, amountMinor: 2500, currency: "USD", customerId: s.customerId.toString(), paymentMethod: "CASH" },
  };
};

const hookRefundArgs = (s: LedgerSeed, paymentId: Id<"collectionPayments">) => ({
  orgId: s.orgId, paymentId, customerId: s.customerId, amountMinor: 2500, currency: "USD",
  paymentMethod: "CASH", actorId: s.userId, occurredAt: Date.now(),
});

const insertOutPayment = (s: LedgerSeed) =>
  s.t.run((ctx) =>
    ctx.db.insert("collectionPayments", {
      orgId: s.orgId, customerId: s.customerId, direction: "OUT", method: "CASH", amount: 25,
      paymentDate: Date.now(), status: "POSTED", cashierId: s.userId, createdAt: Date.now(),
    })
  );

const refundEvents = async (s: LedgerSeed) =>
  (await s.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()))
    .filter((e) => e.eventType === "COLLECTION_REFUND");

describe("accountingLedger.post COLLECTION_REFUND (internal door)", () => {
  test("is refused and nothing changes", async () => {
    const s = await seedLedger("ledger-refused");
    await expectRefusedAndUnchanged(s, () => s.asOperator.mutation(internal.accountingLedger.post, ledgerRefundArgs(s, "a")));
    expect(await refundEvents(s)).toHaveLength(0);
  });

  test("MUTATION ATTACK: with the switch flipped off the same call posts the refund event", async () => {
    const s = await seedLedger("ledger-attack");
    await withSwitchOff(() => s.asOperator.mutation(internal.accountingLedger.post, ledgerRefundArgs(s, "b")));
    expect(await refundEvents(s)).toHaveLength(1);
  });

  test("CONTROL: another event type still posts through the door with the switch ON", async () => {
    const s = await seedLedger("ledger-control");
    const now = Date.now();
    const result = await s.asOperator.mutation(internal.accountingLedger.post, {
      orgId: s.orgId, eventType: "DEPOSIT_RECEIVED", sourceType: "deposits", sourceId: "dep_lref_control", eventVersion: 1,
      accountingDate: now, occurredAt: now, currency: "USD", idempotencyKey: "dep_received_lref_control",
      payload: { depositId: "dep_lref_control", amountMinor: 5000, currency: "USD", paymentMethod: "CASH", customerId: s.customerId.toString() },
    });
    expect(result.alreadyPosted).toBe(false);
    expect(result.journalEntryId).toBeTruthy();
  });
});

describe("hookCollectionRefund (the one producer of a refund posting)", () => {
  test("is refused before it posts or enqueues anything", async () => {
    const s = await seedLedger("hook-refused");
    const paymentId = await insertOutPayment(s);
    await expectRefusedAndUnchanged(s, () => s.t.run((ctx) => hookCollectionRefund(ctx, hookRefundArgs(s, paymentId))));
    expect(await refundEvents(s)).toHaveLength(0);
  });

  test("is refused when it would enqueue (no chart yet) and the outbox stays empty", async () => {
    const s = await seedLedger("hook-refused-queue", false);
    const paymentId = await insertOutPayment(s);
    await expectRefusedAndUnchanged(s, () => s.t.run((ctx) => hookCollectionRefund(ctx, hookRefundArgs(s, paymentId))));
    expect(await outboxRows(s.t, s.orgId)).toHaveLength(0);
  });

  test("MUTATION ATTACK: with the switch flipped off the hook posts the refund event", async () => {
    const s = await seedLedger("hook-attack");
    const paymentId = await insertOutPayment(s);
    await withSwitchOff(() => s.t.run((ctx) => hookCollectionRefund(ctx, hookRefundArgs(s, paymentId))));
    expect(await refundEvents(s)).toHaveLength(1);
  });
});

describe("a refund event queued BEFORE the switch still posts (the payout already happened)", () => {
  test("outbox row written with the door open posts after the switch is ON; nothing is dropped or held", async () => {
    const s = await seedLedger("queued", false);
    const paymentId = await insertOutPayment(s);
    // Pre-switch: no chart yet, so the hook durably enqueues the accounting for the payout.
    await withSwitchOff(() => s.t.run((ctx) => hookCollectionRefund(ctx, hookRefundArgs(s, paymentId))));
    const queued = await outboxRows(s.t, s.orgId);
    expect(queued).toHaveLength(1);
    expect(queued[0].eventType).toBe("COLLECTION_REFUND");
    expect(queued[0].status).toBe("PENDING");

    await openChartAndPeriod(s);
    // The switch is ON (shipped state) for the whole drain.
    await settleOutbox(s.t, s.orgId);

    const [row] = await outboxRows(s.t, s.orgId);
    expect(row.status).toBe("POSTED");
    const events = await refundEvents(s);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("POSTED");
    const journals = await s.t.run((ctx) => ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect());
    expect(journals).toHaveLength(1);
  });
});

describe("subledger.recordPayment OUT to a customer (internal door)", () => {
  const args = (s: LedgerSeed, key: string, direction: "IN" | "OUT", withCustomer = true) => ({
    orgId: s.orgId, direction, ...(withCustomer ? { customerId: s.customerId } : {}),
    method: "CASH" as const, amountMinor: 2500, currency: "USD", idempotencyKey: key,
  });

  test("a customer OUT payment is refused and nothing changes", async () => {
    const s = await seedLedger("pay-refused", false);
    await expectRefusedAndUnchanged(s, () => s.asOperator.mutation(internal.subledger.recordPayment, args(s, "out-1", "OUT")));
  });

  test("MUTATION ATTACK: with the switch flipped off the same call records the customer payout", async () => {
    const s = await seedLedger("pay-attack", false);
    const id = await withSwitchOff(() => s.asOperator.mutation(internal.subledger.recordPayment, args(s, "out-2", "OUT")));
    expect((await s.t.run((ctx) => ctx.db.get(id)))?.direction).toBe("OUT");
  });

  test("CONTROLS: a customer IN payment and an OUT payment with no customer still record with the switch ON", async () => {
    const s = await seedLedger("pay-controls", false);
    const inId = await s.asOperator.mutation(internal.subledger.recordPayment, args(s, "in-1", "IN"));
    expect((await s.t.run((ctx) => ctx.db.get(inId)))?.direction).toBe("IN");
    const outId = await s.asOperator.mutation(internal.subledger.recordPayment, args(s, "out-nocust", "OUT", false));
    expect((await s.t.run((ctx) => ctx.db.get(outId)))?.direction).toBe("OUT");
  });
});

describe("subledger.reverseAllocationMutation (internal door)", () => {
  async function allocated(s: LedgerSeed, key: string) {
    const now = Date.now();
    const receivableDocumentId = await s.asOperator.mutation(internal.subledger.createReceivable, {
      orgId: s.orgId, documentType: "INVOICE", payerType: "CUSTOMER", customerId: s.customerId,
      sourceType: "manual_adjustment", sourceId: `lref_${key}`, originalAmountMinor: 4000, currency: "USD",
      issueDate: now, dueDate: now + 30 * 86_400_000,
    });
    const paymentId = await s.asOperator.mutation(internal.subledger.recordPayment, {
      orgId: s.orgId, direction: "IN", customerId: s.customerId, method: "CASH", amountMinor: 4000, currency: "USD",
      idempotencyKey: `lref_pay_${key}`,
    });
    const allocationId = await s.asOperator.mutation(internal.subledger.allocate, {
      orgId: s.orgId, paymentId, receivableDocumentId, amountMinor: 4000,
    });
    return { allocationId, receivableDocumentId };
  }

  test("is refused and the allocation stays ACTIVE with nothing else changed", async () => {
    const s = await seedLedger("rev-refused", false);
    const { allocationId } = await allocated(s, "refused");
    await expectRefusedAndUnchanged(s, () =>
      s.asOperator.mutation(internal.subledger.reverseAllocationMutation, { orgId: s.orgId, allocationId })
    );
    expect((await s.t.run((ctx) => ctx.db.get(allocationId)))?.status).toBe("ACTIVE");
  });

  test("MUTATION ATTACK: with the switch flipped off the same call reverses the allocation", async () => {
    const s = await seedLedger("rev-attack", false);
    const { allocationId } = await allocated(s, "attack");
    await withSwitchOff(() =>
      s.asOperator.mutation(internal.subledger.reverseAllocationMutation, { orgId: s.orgId, allocationId })
    );
    expect((await s.t.run((ctx) => ctx.db.get(allocationId)))?.status).toBe("REVERSED");
  });

  test("CONTROL: the reverseAllocation helper that cancel, unwind and cheque return call is not gated", async () => {
    const s = await seedLedger("rev-helper", false);
    const { allocationId, receivableDocumentId } = await allocated(s, "helper");
    await s.t.run((ctx) => reverseAllocation(ctx, { orgId: s.orgId, allocationId, actorId: s.userId }));
    expect((await s.t.run((ctx) => ctx.db.get(allocationId)))?.status).toBe("REVERSED");
    expect((await s.t.run((ctx) => ctx.db.get(receivableDocumentId)))?.status).toBe("OPEN");
  });
});
