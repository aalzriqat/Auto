/**
 * SCRUM-411 P2-01 / P2-02 containment (Opus B1) - the deposit H is paid to the finance
 * company BEFORE the sale, inside the forward H + D. While that payment is on the books
 * (or in any unsettled state) and the deal is not closed, the same held deposit must not
 * also leave the business as a refund, a forfeiture, a void or a released-slice payout:
 * H would leave twice and the deal could neither close nor be cancelled.
 *
 * Invariant: no deposit on a quote may be refunded, forfeited, voided or paid out
 * while an application on that quote carries a live (on-books or unsettled) forward
 * and is not closed. A taken-back or returned forward releases the deposit again.
 *
 * Worked figures as in scrum411ForwardOrdering.test.ts (JOD): H 200, D 1,375, due 1,575.
 *
 * These are the SPEND-door cases of the B1 invariant. Per-deposit provenance (the forward's
 * slices, the derived FORWARDED disposition, the legacy quote-wide fallback) is covered in
 * scrum411P202ForwardedDeposit.test.ts. There is still NO claim route: recovery is the
 * fail-closed full return (take the payment back / report it returned), nothing partial.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime.
 */
import { C, H, readyDeal, refusalDataOf, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { seedBank } from "../test-utils/bankFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { forwardPostKey } from "./utils/financeCompanyForward";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const FORWARD = H + C;
const GUARD = "DEPOSIT_PAID_ONWARD_TO_FINANCE_COMPANY";

async function seed(tag: string) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S411G", vinPrefix: "VIN411G", actors: {}, sourced: false,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type AppId = Id<"financeApplications">;

const payForward = async (s: Seeded, applicationId: AppId) =>
  s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: await seedBank(s.t, s.orgId), paidAt: Date.now(),
    expectedAmountMinor: FORWARD, idempotencyKey: crypto.randomUUID(),
  });
const voidForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
  s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
    orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
  });
const returnForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
  s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
    orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
  });

// The seeded deposit was created by the owner, so a refund or forfeiture is chosen by the approver.
const release = (s: Seeded, depositId: Id<"deposits">, resolution: "REFUNDED" | "FORFEITED") =>
  s.approver.as.mutation(api.deposits.release, {
    orgId: s.orgId, depositId, resolution, idempotencyKey: crypto.randomUUID(),
    ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
  });
const voidDeposit = (s: Seeded, depositId: Id<"deposits">) =>
  s.approver.as.mutation(api.deposits.voidDeposit, { orgId: s.orgId, depositId, reason: "Recorded in error." });
const resolveSlice = (
  s: Seeded,
  holdId: Id<"depositVehicleHolds">,
  treatment: "REFUND_TO_CUSTOMER" | "FORFEITED" | "OTHER"
) =>
  s.approver.as.mutation(api.deposits.resolveReleasedAllocation, {
    orgId: s.orgId, holdId, treatment, reason: "Customer asked.", idempotencyKey: crypto.randomUUID(),
    ...(treatment === "REFUND_TO_CUSTOMER" ? { refundMethod: "CASH" as const } : {}),
  });

/** The seeded deal, its on-books payment, and the one deposit it holds. */
async function paidDeal(tag: string) {
  const s = await seed(tag);
  const { applicationId } = await readyDeal(s);
  const forwardId = await payForward(s, applicationId);
  const depositId = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0]._id;
  return { s, applicationId, forwardId, depositId };
}

/** Everything a refused spend must leave untouched: the deposit row and the number of accounting events. */
async function untouched(s: Seeded, depositId: Id<"deposits">) {
  return await s.t.run(async (ctx) => ({
    deposit: await ctx.db.get(depositId),
    events: (await ctx.db.query("accountingEvents").collect()).length,
    entries: (await ctx.db.query("journalEntries").collect()).length,
  }));
}

describe("B1 - a deposit already inside an on-books forward cannot also leave as a refund, forfeiture or void", () => {
  test.each(["REFUNDED", "FORFEITED"] as const)("single vehicle: release %s is refused and writes nothing", async (resolution) => {
    const { s, depositId } = await paidDeal(`g1${resolution[0]}`);
    const before = await untouched(s, depositId);
    const refusal = await refusalDataOf(release(s, depositId, resolution));
    expect(refusal?.code).toBe(GUARD);
    expect(refusal?.message).toMatch(/paid .*to the finance company/i);
    expect(refusal?.message).not.toMatch(/200|1[,.]?375|1[,.]?575/);
    expect(await untouched(s, depositId)).toEqual(before);
    expect(before.deposit?.status).toBe("HELD");
    expect(before.deposit?.holdActive).toBe(true);
  });

  test("single vehicle: void as recorded in error is refused and writes nothing", async () => {
    const { s, depositId } = await paidDeal("g2");
    const before = await untouched(s, depositId);
    expect((await refusalDataOf(voidDeposit(s, depositId)))?.code).toBe(GUARD);
    expect(await untouched(s, depositId)).toEqual(before);
    expect(before.deposit?.isDeleted).not.toBe(true);
  });

  test("multi-vehicle: a released slice cannot be refunded, forfeited or written off, and the active slice's deposit cannot be released or voided", async () => {
    const { s, depositId } = await paidDeal("g3");
    // A multi-vehicle quote's deposit carries per-car hold rows: one slice still held, one released
    // and waiting for a decision. Modelled as rows (the allocation door is covered elsewhere).
    const { activeHold, releasedHold } = await s.t.run(async (ctx) => {
      const base = { orgId: s.orgId, depositId, vehicleId: s.vehicleId, createdAt: Date.now() };
      return {
        activeHold: await ctx.db.insert("depositVehicleHolds", {
          ...base, active: true, allocatedAmountMinor: H / 2, allocatedAt: Date.now(), allocationStatus: "ALLOCATED",
        }),
        releasedHold: await ctx.db.insert("depositVehicleHolds", {
          ...base, active: false, allocatedAmountMinor: H / 2, allocatedAt: Date.now(),
          allocationStatus: "RELEASED_AWAITING_DECISION",
        }),
      };
    });
    const before = await untouched(s, depositId);
    for (const treatment of ["REFUND_TO_CUSTOMER", "FORFEITED", "OTHER"] as const) {
      expect((await refusalDataOf(resolveSlice(s, releasedHold, treatment)))?.code).toBe(GUARD);
    }
    expect((await refusalDataOf(release(s, depositId, "REFUNDED")))?.code).toBe(GUARD);
    expect((await refusalDataOf(voidDeposit(s, depositId)))?.code).toBe(GUARD);
    expect(await untouched(s, depositId)).toEqual(before);
    const holds = await s.t.run(async (ctx) => [await ctx.db.get(activeHold), await ctx.db.get(releasedHold)]);
    expect(holds[0]?.allocationStatus).toBe("ALLOCATED");
    expect(holds[1]?.allocationStatus).toBe("RELEASED_AWAITING_DECISION");
  });

  test("a payment the books cannot confirm (NEEDS_REPAIR) blocks as well: cannot tell means hold", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("g4");
    // The forward row stays but its posted event is gone: the proof can no longer say it is on the books or gone.
    await s.t.run(async (ctx) => {
      const event = await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", forwardPostKey(applicationId, 1)))
        .unique();
      await ctx.db.delete(event!._id);
    });
    expect(forwardId).toBeTruthy();
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
    expect((await refusalDataOf(voidDeposit(s, depositId)))?.code).toBe(GUARD);
  });
});

describe("B1 - no false block once the payment is gone", () => {
  test("control: a deal with no payment recorded can still have its deposit forfeited", async () => {
    const s = await seed("g5");
    await readyDeal(s);
    const depositId = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0]._id;
    expect(await refusalDataOf(release(s, depositId, "FORFEITED"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("FORFEITED");
  });

  test("a payment taken back (REVERSED) releases the deposit again", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("g6");
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
    await voidForward(s, applicationId, forwardId);
    expect(await refusalDataOf(release(s, depositId, "FORFEITED"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("FORFEITED");
  });

  test("a payment reported returned (RETURNED) releases the deposit again", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("g7");
    await returnForward(s, applicationId, forwardId);
    expect(await refusalDataOf(voidDeposit(s, depositId))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("VOIDED");
  });

  test("a deposit that names no quote is still held back: its slice, not its quote, says it was paid onward", async () => {
    const { s, depositId } = await paidDeal("g8");
    // The B1 containment found the deal through the deposit's quote and could not see this one (P2-02 closes it).
    await s.t.run((ctx) => ctx.db.patch(depositId, { quoteId: undefined }));
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
    expect((await refusalDataOf(voidDeposit(s, depositId)))?.code).toBe(GUARD);
  });
});

describe("B1 - the operator is not stranded: the payment stays visible and cancel is withheld", () => {
  const status = (s: Seeded, applicationId: AppId, planReady?: boolean) =>
    s.owner.as.query(api.financeCompanyForward.preFinalizeForwardStatus, {
      orgId: s.orgId, applicationId, ...(planReady === undefined ? {} : { planReady }),
    });

  test("the stranded shape (deposit refunded behind the payment) still names the payment to take back and blocks cancel", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("g9");
    await s.t.run((ctx) =>
      ctx.db.patch(depositId, { status: "REFUNDED", holdActive: false, refundedAmountMinor: H, releasedAmountMinor: H })
    );
    expect(await status(s, applicationId)).toEqual({
      state: "FIRST_PAYMENT_UNFUNDED", mayRecord: true, onBooksForwardId: forwardId, blocksCancel: true, money: null,
    });
  });

  test("planReady false asks only the cheap question: NOT_READY, but a live payment is still named", async () => {
    const { s, applicationId, forwardId } = await paidDeal("g10");
    expect(await status(s, applicationId, false)).toEqual({
      state: "NOT_READY", mayRecord: true, onBooksForwardId: forwardId, blocksCancel: true, money: null,
    });
  });

  test("planReady false with no payment recorded blocks nothing", async () => {
    const s = await seed("g11");
    const { applicationId } = await readyDeal(s);
    expect(await status(s, applicationId, false)).toEqual({
      state: "NOT_READY", mayRecord: true, onBooksForwardId: null, blocksCancel: false, money: null,
    });
  });

  test("after the payment is taken back, cancel is no longer blocked", async () => {
    const { s, applicationId, forwardId } = await paidDeal("g12");
    expect((await status(s, applicationId))?.blocksCancel).toBe(true);
    await voidForward(s, applicationId, forwardId);
    expect((await status(s, applicationId))?.blocksCancel).toBe(false);
  });

  test("the server cancel stays refused while the payment is on the books, and names the way out", async () => {
    const { s, applicationId } = await paidDeal("g13");
    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal?.code).toBe("FORWARD_CANCEL_ON_BOOKS");
  });
});
