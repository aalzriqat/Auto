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
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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

async function expectRefusedAndUnchanged(s: Seeded, call: () => Promise<unknown>) {
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
