/**
 * SCRUM-411 P2-02 - a deposit paid onward to the finance company has a PROVENANCE and a
 * DISPOSITION, and cannot be spent or moved until the payment is recovered.
 *
 * Invariant: the deposit part of a pre-finalize payment (H inside H + D) is pinned, deposit by
 * deposit (and hold by hold), in immutable `financeCompanyForwardSlices` written in the same
 * transaction as the payment. A deposit with a slice in a version that is on the books or in any
 * unsettled state is FORWARDED and may not be refunded, forfeited, voided, written off, released
 * to the pool or moved to another car. It is RECOVERED only when every such version is REVERSED or
 * RETURNED by a POSTED reversal; a request to reverse is not recovery. A deposit the payment did
 * not carry stays spendable. A live version with no slices (recorded before this existed) holds
 * back every deposit of its quote. Cash-sale deposit application is not touched.
 *
 * Worked figures as in scrum411ForwardOrdering.test.ts (JOD): H 200, D 1,375, due 1,575.
 *
 * NOT built, and pinned as such: a CLAIM on the finance company (a recorded receivable that would
 * keep a deposit spendable without the money coming back). The only route is the fail-closed full
 * return. A multi-vehicle quote cannot carry a financed deal today (`createFromQuote` and the sale
 * plan refuse it), so the per-hold shape is exercised with hand-written slice and hold rows.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime.
 */
import { C, H, SCALE, payForwardAsOwner, finalizeAsOwner, readyDeal, refusalDataOf, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { seedBank } from "../test-utils/bankFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { payOutDepositSlice, recordUnpostedDepositTreatment, releaseHeldDeposit } from "./utils/depositHelpers";
import {
  FORWARD_VERSIONS_ONLY, assertDepositNotInLiveForward, depositForwardDisposition, deriveForwardState, forwardIsLive,
} from "./utils/financeCompanyForward";

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
  "reopen:accounting_periods",
];

const GUARD = "DEPOSIT_PAID_ONWARD_TO_FINANCE_COMPANY";
const PROVENANCE = "FORWARD_DEPOSIT_PROVENANCE_UNCLEAR";

async function seed(tag: string) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S411P", vinPrefix: "VIN411P", actors: {}, sourced: false,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type AppId = Id<"financeApplications">;
type ForwardId = Id<"financeCompanyForwards">;

const voidForward = (s: Seeded, applicationId: AppId, forwardId: ForwardId) =>
  s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
    orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
  });
const returnForward = (s: Seeded, applicationId: AppId, forwardId: ForwardId) =>
  s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
    orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
  });
// The seeded deposits were created by the owner, so a refund or forfeiture is chosen by the approver.
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
  treatment: "REFUND_TO_CUSTOMER" | "FORFEITED" | "OTHER" | "RETURN_TO_UNALLOCATED"
) =>
  s.approver.as.mutation(api.deposits.resolveReleasedAllocation, {
    orgId: s.orgId, holdId, treatment, reason: "Customer asked.", idempotencyKey: crypto.randomUUID(),
    ...(treatment === "REFUND_TO_CUSTOMER" ? { refundMethod: "CASH" as const } : {}),
  });

/** A held deposit written the way the fixture writes the first one. */
const rawDeposit = (s: Seeded, quoteId: Id<"quotes">, minor: number) =>
  s.t.run(async (ctx) =>
    ctx.db.insert("deposits", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
      amount: minor / SCALE, amountMinor: minor, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
      createdBy: (await ctx.db.query("users").first())!._id, createdAt: Date.now(),
    } as never)
  );

const rawHold = (
  s: Seeded,
  depositId: Id<"deposits">,
  fields: { active: boolean; allocationStatus: "ALLOCATED" | "RELEASED_AWAITING_DECISION"; allocatedAmountMinor: number }
) =>
  s.t.run((ctx) =>
    ctx.db.insert("depositVehicleHolds", {
      orgId: s.orgId, depositId, vehicleId: s.vehicleId, createdAt: Date.now(), allocatedAt: Date.now(), ...fields,
    })
  );

/**
 * A future multi-car payment, written by hand (a financed deal is single-vehicle): the deposit is
 * released as two halves on the car and the payment's provenance names hold A only.
 */
async function forwardedHalfAndFreeHalf(s: Seeded, depositId: Id<"deposits">) {
  const released = { active: false, allocationStatus: "RELEASED_AWAITING_DECISION", allocatedAmountMinor: H / 2 } as const;
  const holdA = await rawHold(s, depositId, released);
  const holdB = await rawHold(s, depositId, released);
  await s.t.run(async (ctx) => {
    for (const slice of await ctx.db.query("financeCompanyForwardSlices").collect()) {
      await ctx.db.patch(slice._id, { holdId: holdA, amountMinor: H / 2 });
    }
  });
  return { holdA, holdB };
}

/** As the cancellation matrix sets its financed deal up before finalizing. */
const useManualCommission = (s: Seeded) =>
  s.t.run(async (ctx) => {
    await ctx.db.patch((await ctx.db.query("orgSettings").first())!._id, { commissionMode: "MANUAL" });
  });

const eventTypesOf = (s: Seeded) =>
  s.t.run(async (ctx) => (await ctx.db.query("accountingEvents").collect()).map((event) => event.eventType).sort());

const slicesOf = (s: Seeded) => s.t.run((ctx) => ctx.db.query("financeCompanyForwardSlices").collect());
const forwardsOf = (s: Seeded) => s.t.run((ctx) => ctx.db.query("financeCompanyForwards").collect());

const dispositionOf = (s: Seeded, depositId: Id<"deposits">, holdId?: Id<"depositVehicleHolds">) =>
  s.t.run(async (ctx) => await depositForwardDisposition(ctx, (await ctx.db.get(depositId))!, holdId));

/** Whether any version of the deal's payment is on the books or unsettled (versions only: the deal is not finalized). */
const forwardLiveOf = (s: Seeded, applicationId: AppId) =>
  s.t.run(async (ctx) => forwardIsLive(await deriveForwardState(ctx, (await ctx.db.get(applicationId))!, FORWARD_VERSIONS_ONLY)));

/** The code the guard refuses with for this deposit (or hold), or null when it lets the spend through. */
const guardCodeOf = async (s: Seeded, depositId: Id<"deposits">, holdId?: Id<"depositVehicleHolds">) => {
  const refusal = await refusalDataOf(
    s.t.run(async (ctx) => assertDepositNotInLiveForward(ctx, (await ctx.db.get(depositId))!, holdId))
  );
  return refusal === null ? null : refusal.code ?? "UNCODED";
};

/** The first (fixture-written) deposit. */
const firstDepositId = async (s: Seeded) => (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0]._id;

/** The deal, its on-books payment (through the real mutation, for the amount finalize would freeze) and its one deposit. */
async function paidDeal(tag: string) {
  const s = await seed(tag);
  const { applicationId, quoteId } = await readyDeal(s);
  const forwardId = await payForwardAsOwner(s, applicationId);
  if (forwardId === null) throw new Error("fixture: the deal owes the finance company nothing");
  const depositId = await firstDepositId(s);
  return { s, applicationId, quoteId, forwardId, depositId };
}

/** Everything a refused spend must leave untouched. */
async function untouched(s: Seeded, depositId: Id<"deposits">) {
  return await s.t.run(async (ctx) => ({
    deposit: await ctx.db.get(depositId),
    events: (await ctx.db.query("accountingEvents").collect()).length,
    entries: (await ctx.db.query("journalEntries").collect()).length,
    slices: (await ctx.db.query("financeCompanyForwardSlices").collect()).length,
  }));
}

/** Net debit-minus-credit per account over every journal line; zero entries dropped. */
async function ledgerNetByAccount(s: Seeded): Promise<Record<string, number>> {
  return await s.t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const account = await ctx.db.get(line.accountId);
      const key = account?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + line.debitMinor - line.creditMinor;
    }
    return Object.fromEntries(Object.entries(net).filter(([, value]) => value !== 0));
  });
}

describe("P2-02 - the payment pins which deposit it carries, in the same transaction", () => {
  test("single car, no hold rows: one slice for the one deposit, whole amount, conserved against the deposit portion", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("p1");
    const [slice, ...rest] = await slicesOf(s);
    const forward = await s.t.run((ctx) => ctx.db.get(forwardId));
    expect(rest).toEqual([]);
    expect(slice).toMatchObject({
      orgId: s.orgId, applicationId, forwardId, version: 1, depositId, vehicleId: s.vehicleId, amountMinor: H, currency: "JOD",
    });
    expect(slice.holdId).toBeUndefined();
    expect(forward?.depositPortionMinor).toBe(H);
    expect(slice.amountMinor).toBe(forward?.depositPortionMinor);
  });

  test("several deposits: one slice each, and the slices add up to the deposit portion exactly", async () => {
    const s = await seed("p2");
    const { applicationId, quoteId } = await readyDeal(s);
    const second = await rawDeposit(s, quoteId, 100_000);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: H + 100_000 }));
    const forwardId = await payForwardAsOwner(s, applicationId);
    expect(forwardId).not.toBeNull();
    const slices = await slicesOf(s);
    const forward = await s.t.run((ctx) => ctx.db.get(forwardId!));
    expect(slices.map((slice) => slice.amountMinor).sort((a, b) => a - b)).toEqual([100_000, H]);
    expect(new Set(slices.map((slice) => slice.depositId)).size).toBe(2);
    expect(slices.map((slice) => slice.depositId)).toContain(second);
    expect(slices.reduce((sum, slice) => sum + slice.amountMinor, 0)).toBe(forward?.depositPortionMinor);
    expect(slices.every((slice) => slice.forwardId === forwardId && slice.version === 1)).toBe(true);
  });

  test("a deposit that carries one live hold on the car pins that hold", async () => {
    const s = await seed("p3");
    const { applicationId } = await readyDeal(s);
    const depositId = await firstDepositId(s);
    const holdId = await rawHold(s, depositId, { active: true, allocationStatus: "ALLOCATED", allocatedAmountMinor: H });
    expect(await payForwardAsOwner(s, applicationId)).not.toBeNull();
    const [slice, ...rest] = await slicesOf(s);
    expect(rest).toEqual([]);
    expect(slice).toMatchObject({ depositId, holdId, amountMinor: H });
  });

  test("two live holds on the car cannot be pinned: the payment is refused and NOTHING is written", async () => {
    const s = await seed("p4");
    const { applicationId } = await readyDeal(s);
    const depositId = await firstDepositId(s);
    await rawHold(s, depositId, { active: true, allocationStatus: "ALLOCATED", allocatedAmountMinor: H / 2 });
    await rawHold(s, depositId, { active: true, allocationStatus: "ALLOCATED", allocatedAmountMinor: H / 2 });
    const before = await untouched(s, depositId);
    const refusal = await refusalDataOf(payForwardAsOwner(s, applicationId));
    expect(refusal?.code).toBe(PROVENANCE);
    expect(await forwardsOf(s)).toEqual([]);
    expect(await untouched(s, depositId)).toEqual(before);
  });

  test("a multi-vehicle quote cannot carry the payment: refused, no payment and no slice", async () => {
    const s = await seed("p5");
    const { applicationId, quoteId } = await readyDeal(s);
    await s.t.run((ctx) =>
      ctx.db.patch(quoteId, {
        vehicleItems: [
          { vehicleId: s.vehicleId, unitPrice: 12_500 },
          { vehicleId: s.vehicleId, unitPrice: 12_500 },
        ],
      } as never)
    );
    // Called directly: the fixture's payer reads a refused plan as "nothing owed" and never reaches the mutation.
    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
        orgId: s.orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: await seedBank(s.t, s.orgId), paidAt: Date.now(),
        expectedAmountMinor: H + C, idempotencyKey: crypto.randomUUID(),
      })
    );
    expect(refusal?.message).toMatch(/more than one vehicle/i);
    expect(await forwardsOf(s)).toEqual([]);
    expect(await slicesOf(s)).toEqual([]);
  });

  test("a replayed command (same key) returns the first payment and writes no second set of slices; a new key is refused as a duplicate", async () => {
    const s = await seed("p6");
    const { applicationId } = await readyDeal(s);
    // One `paidAt` for every call: the server fingerprints the request, so a replay must be identical.
    const paidAt = Date.now();
    const bankAccountId = await seedBank(s.t, s.orgId);
    const args = (key: string) => ({
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER" as const, bankAccountId, paidAt,
      expectedAmountMinor: H + C, idempotencyKey: key,
    });
    const key = crypto.randomUUID();
    const first = await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, args(key));
    const replay = await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, args(key));
    expect(replay).toBe(first);
    expect(await slicesOf(s)).toHaveLength(1);
    const duplicate = await refusalDataOf(
      s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, args(crypto.randomUUID()))
    );
    expect(duplicate).not.toBeNull();
    expect(await forwardsOf(s)).toHaveLength(1);
    expect(await slicesOf(s)).toHaveLength(1);
  });
});

describe("P2-02 - the disposition is derived from the ledger, never stored", () => {
  test("NOT_FORWARDED -> FORWARDED -> RECOVERED (taken back) -> FORWARDED (v2) -> RECOVERED (returned); slices are never rewritten", async () => {
    const s = await seed("d1");
    const { applicationId } = await readyDeal(s);
    const depositId = await firstDepositId(s);
    expect(await dispositionOf(s, depositId)).toBe("NOT_FORWARDED");

    const v1 = (await payForwardAsOwner(s, applicationId))!;
    expect(await dispositionOf(s, depositId)).toBe("FORWARDED");
    const v1Slices = await slicesOf(s);

    await voidForward(s, applicationId, v1);
    expect(await dispositionOf(s, depositId)).toBe("RECOVERED");

    const v2 = (await payForwardAsOwner(s, applicationId))!;
    expect(await dispositionOf(s, depositId)).toBe("FORWARDED");
    const both = await slicesOf(s);
    expect(both).toHaveLength(2);
    expect(both.find((slice) => slice.forwardId === v1)).toEqual(v1Slices[0]);
    expect(both.find((slice) => slice.forwardId === v2)).toMatchObject({ version: 2, depositId, amountMinor: H });

    await returnForward(s, applicationId, v2);
    expect(await dispositionOf(s, depositId)).toBe("RECOVERED");
  });

  test("a reversal that is only REQUESTED is not recovery: cannot tell means FORWARDED", async () => {
    const { s, forwardId, depositId } = await paidDeal("d2");
    // The request is on the row but no reversal was posted or even queued.
    await s.t.run((ctx) => ctx.db.patch(forwardId, { reversalRequestedAt: Date.now(), reversalKind: "VOID" }));
    expect(await dispositionOf(s, depositId)).toBe("FORWARDED");
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
  });

  test("a slice whose deal cannot be read is FORWARDED, not skipped", async () => {
    const { s, applicationId, depositId } = await paidDeal("d3");
    await s.t.run((ctx) => ctx.db.delete(applicationId));
    expect(await dispositionOf(s, depositId)).toBe("FORWARDED");
  });
});

describe("P2-02 - every door that spends or moves the deposit honours the disposition", () => {
  test("release (refund/forfeit) and void are refused while FORWARDED and write nothing", async () => {
    const { s, depositId } = await paidDeal("g1");
    const before = await untouched(s, depositId);
    for (const resolution of ["REFUNDED", "FORFEITED"] as const) {
      expect((await refusalDataOf(release(s, depositId, resolution)))?.code).toBe(GUARD);
    }
    expect((await refusalDataOf(voidDeposit(s, depositId)))?.code).toBe(GUARD);
    expect(await untouched(s, depositId)).toEqual(before);
    expect(before.deposit).toMatchObject({ status: "HELD", holdActive: true });
  });

  test("a released slice cannot be paid out, written off, moved or returned to the pool while FORWARDED", async () => {
    const { s, depositId } = await paidDeal("g2");
    const releasedHold = await rawHold(s, depositId, {
      active: false, allocationStatus: "RELEASED_AWAITING_DECISION", allocatedAmountMinor: H,
    });
    const before = await untouched(s, depositId);
    for (const treatment of ["REFUND_TO_CUSTOMER", "FORFEITED", "OTHER", "RETURN_TO_UNALLOCATED"] as const) {
      expect((await refusalDataOf(resolveSlice(s, releasedHold, treatment)))?.code).toBe(GUARD);
    }
    expect(await untouched(s, depositId)).toEqual(before);
    expect((await s.t.run((ctx) => ctx.db.get(releasedHold)))?.allocationStatus).toBe("RELEASED_AWAITING_DECISION");
  });

  test("stale plan: a deposit added AFTER the payment was not carried by it and stays spendable; the carried one stays held", async () => {
    const { s, quoteId, depositId } = await paidDeal("g3");
    const later = await rawDeposit(s, quoteId, 50_000);
    expect(await dispositionOf(s, later)).toBe("NOT_FORWARDED");
    expect(await refusalDataOf(release(s, later, "FORFEITED"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(later)))?.status).toBe("FORFEITED");
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("HELD");
  });

  test("per hold: the forwarded car's share is held back, another car's share of the same deposit is not, the deposit as a whole is", async () => {
    const { s, depositId } = await paidDeal("g4");
    const { holdA, holdB } = await forwardedHalfAndFreeHalf(s, depositId);
    expect(await guardCodeOf(s, depositId, holdA)).toBe(GUARD);
    expect(await guardCodeOf(s, depositId, holdB)).toBeNull();
    expect(await guardCodeOf(s, depositId)).toBe(GUARD);
    expect(await dispositionOf(s, depositId, holdB)).toBe("NOT_FORWARDED");
  });

  test("a cash sale's deposit application is untouched: no slice, the deposit is applied as before", async () => {
    const s = await seed("g5");
    const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
      mode: "CASH", vehiclePrice: 12_500, downPayment: 0, termMonths: 0,
    });
    await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 200, method: "CASH", idempotencyKey: "dep-g5",
    });
    await s.owner.as.mutation(api.sales.create, {
      idempotencyKey: "sale-g5", orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
      salespersonId: s.owner.userId, salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED", quoteId,
    });
    expect(await slicesOf(s)).toEqual([]);
    const deposit = (await s.t.run((ctx) => ctx.db.query("deposits").collect()))[0];
    expect(deposit.status).toBe("APPLIED");
    expect(await dispositionOf(s, deposit._id)).toBe("NOT_FORWARDED");
  });
});

describe("P2-02 - recovery comes first, with its GL effect", () => {
  test("pre-finalize: refused while FORWARDED (ledger untouched); once taken back the payment nets to zero and the deposit can go", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("r1");
    const paid = await ledgerNetByAccount(s);
    expect(Object.values(paid).some((value) => value !== 0)).toBe(true);
    const before = await untouched(s, depositId);
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
    expect(await untouched(s, depositId)).toEqual(before);
    expect(await ledgerNetByAccount(s)).toEqual(paid);

    await voidForward(s, applicationId, forwardId);
    expect(await ledgerNetByAccount(s)).toEqual({});
    expect(await dispositionOf(s, depositId)).toBe("RECOVERED");
    expect(await refusalDataOf(release(s, depositId, "FORFEITED"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("FORFEITED");
  });

  test("after the sale: the cancel is refused while the payment is on the books, no refund/forfeit is posted, and the deposit is spendable only after the return", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("r2");
    await useManualCommission(s);
    await finalizeAsOwner(s, applicationId, { payForward: false });
    const cancel = () =>
      s.owner.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
      });

    expect((await refusalDataOf(cancel()))?.code).toBe("FORWARD_CANCEL_ON_BOOKS");
    expect((await eventTypesOf(s)).filter((type) => /REFUND|FORFEIT/.test(type))).toEqual([]);

    // A completed sale consumed the deposit, so the slice is skipped; the cancel gate speaks for the payment.
    const appRow = () => s.t.run((ctx) => ctx.db.get(applicationId));
    expect(await appRow()).toMatchObject({ status: "CLOSED", finalizedSaleId: expect.anything() });
    expect(await dispositionOf(s, depositId)).toBe("NOT_FORWARDED");
    // A cancelled deal that still carries a payment on the books is NOT recovered: the ledger decides, not the status.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));
    expect(await dispositionOf(s, depositId)).toBe("FORWARDED");
    await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "CLOSED" }));

    await returnForward(s, applicationId, forwardId);
    expect(await refusalDataOf(cancel())).toBeNull();
    // The sale id survives the cancel (applications.ts keeps it); only the posted return makes this RECOVERED.
    expect(await appRow()).toMatchObject({ status: "CANCELLED", finalizedSaleId: expect.anything() });
    expect(await dispositionOf(s, depositId)).toBe("RECOVERED");
    // Cancelling gave the customer's deposit back as a held deposit; nothing was refunded on the way past.
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))).toMatchObject({ status: "HELD", holdActive: true });
    expect((await eventTypesOf(s)).filter((type) => /REFUND|FORFEIT/.test(type))).toEqual([]);
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).not.toBe(GUARD);
  });
});

describe("P2-02 - the shared executors refuse a forwarded deposit even when the caller has no guard", () => {
  test("releaseHeldDeposit (reached by sale completion, not only deposits.release) refuses refund and forfeit; recovered, it releases", async () => {
    const { s, applicationId, forwardId, depositId } = await paidDeal("x1");
    const direct = (resolution: "REFUNDED" | "FORFEITED") =>
      s.t.run((ctx) =>
        releaseHeldDeposit(ctx, {
          orgId: s.orgId, depositId, resolution, actorId: s.approver.userId,
          ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
        })
      );
    const before = await untouched(s, depositId);
    for (const resolution of ["REFUNDED", "FORFEITED"] as const) {
      expect((await refusalDataOf(direct(resolution)))?.code).toBe(GUARD);
    }
    expect(await untouched(s, depositId)).toEqual(before);

    await voidForward(s, applicationId, forwardId);
    expect(await refusalDataOf(direct("FORFEITED"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("FORFEITED");
  });

  test("a financed finalize cannot refund or forfeit the deposit it has already paid onward", async () => {
    const { s, applicationId, depositId } = await paidDeal("x2");
    await useManualCommission(s);
    const eventsBefore = await eventTypesOf(s);
    for (const depositResolution of [
      { treatment: "REFUND_TO_CUSTOMER" as const, refundMethod: "CASH" as const },
      { treatment: "FORFEITED" as const },
    ]) {
      // The unfunded-first-payment gate answers before the deposit is released; were it to go,
      // `releaseHeldDeposit`'s own guard (proved directly in x1) answers instead. Nothing else may.
      const refusal = await refusalDataOf(
        s.owner.as.mutation(api.applications.finalizeDeal, {
          orgId: s.orgId, applicationId, depositResolution, idempotencyKey: crypto.randomUUID(),
        })
      );
      expect(["FIRST_PAYMENT_UNFUNDED", GUARD]).toContain(refusal?.code);
    }
    expect(await eventTypesOf(s)).toEqual(eventsBefore);
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("HELD");
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");
  });

  test("payOutDepositSlice refuses the forwarded hold and nothing else", async () => {
    const { s, depositId } = await paidDeal("x3");
    const { holdA, holdB } = await forwardedHalfAndFreeHalf(s, depositId);
    const payOut = (holdId: Id<"depositVehicleHolds">) =>
      s.t.run(async (ctx) =>
        payOutDepositSlice(ctx, {
          orgId: s.orgId, deposit: (await ctx.db.get(depositId))!, holdId, vehicleId: s.vehicleId,
          amountMinor: H / 2, currency: "JOD", resolution: "FORFEITED", actorId: s.approver.userId, occurredAt: Date.now(),
        })
      );
    const before = await untouched(s, depositId);
    expect((await refusalDataOf(payOut(holdA)))?.code).toBe(GUARD);
    expect(await untouched(s, depositId)).toEqual(before);
    // The other car's share is not what the payment carried: the guard lets it reach the rest of the executor.
    expect((await refusalDataOf(payOut(holdB)))?.code).not.toBe(GUARD);
  });
});

describe("P2-02 - the legacy deposit treatments cannot reach a forwarded deposit through a financed finalize", () => {
  const finalizeWith = (
    s: Seeded,
    applicationId: AppId,
    depositResolution: { treatment: "OTHER" | "APPLY_TO_DEALER_AMOUNT" | "APPLY_TO_TRANSACTION_SETTLEMENT"; reason?: string }
  ) =>
    s.owner.as.mutation(api.applications.finalizeDeal, {
      orgId: s.orgId, applicationId, depositResolution, idempotencyKey: crypto.randomUUID(),
    });

  test("recordUnpostedDepositTreatment (OTHER) refuses a forwarded deposit at the executor and keeps its hold; recovered, it records", async () => {
    const { s, quoteId, applicationId, forwardId, depositId } = await paidDeal("o1");
    const other = () =>
      s.t.run((ctx) =>
        recordUnpostedDepositTreatment(ctx, {
          quoteId, vehicleId: s.vehicleId, actorId: s.approver.userId, reason: "Approved by the owner.",
        })
      );
    const before = await untouched(s, depositId);
    expect((await refusalDataOf(other()))?.code).toBe(GUARD);
    expect(await untouched(s, depositId)).toEqual(before);
    expect(before.deposit).toMatchObject({ status: "HELD", holdActive: true });

    await voidForward(s, applicationId, forwardId);
    expect(await refusalDataOf(other())).toBeNull();
    expect(await s.t.run((ctx) => ctx.db.get(depositId))).toMatchObject({
      status: "HELD", holdActive: false, resolutionTreatment: "OTHER",
    });
  });

  test("OTHER and APPLY_TO_DEALER_AMOUNT at finalize are refused while the payment is on the books; only the transaction-settlement treatment consumes H, once", async () => {
    const { s, applicationId, depositId } = await paidDeal("o2");
    await useManualCommission(s);
    const before = await untouched(s, depositId);
    expect(before.deposit).toMatchObject({ status: "HELD", holdActive: true });
    const stillUntouched = async () => {
      expect(await untouched(s, depositId)).toEqual(before);
      expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");
    };

    // The plan reads the deposit as NOT applied, so the first payment it founded is unfunded: refused before any write.
    const other = await refusalDataOf(finalizeWith(s, applicationId, { treatment: "OTHER", reason: "Approved by the owner." }));
    expect(other?.code).toBe("FIRST_PAYMENT_UNFUNDED");
    await stillUntouched();

    // Option A: the deposit is forwarded to the company, never applied against the dealer's amount.
    const dealer = await refusalDataOf(finalizeWith(s, applicationId, { treatment: "APPLY_TO_DEALER_AMOUNT" }));
    expect(dealer?.message).toMatch(/forwarded to the company/i);
    await stillUntouched();

    // Even with no first payment agreed (so nothing is "unfunded"), a plan that does not apply H no longer matches
    // the payment that carried it: finalize is refused as stale, and the payment stays on the books.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: 0 }));
    expect(await refusalDataOf(finalizeWith(s, applicationId, { treatment: "OTHER", reason: "Approved by the owner." }))).not.toBeNull();
    await stillUntouched();
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: H }));

    // Positive control: the one treatment that applies H to the purchase closes the deal and consumes the deposit once.
    await finalizeWith(s, applicationId, { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("APPLIED");
    const applications = await s.t.run((ctx) => ctx.db.query("depositApplications").collect());
    expect(applications.filter((row) => row.depositId === depositId)).toHaveLength(1);
  });
});

describe("P2-02 - re-allocating a hold is unreachable on a financed deal", () => {
  test("allocateToVehicles is refused on a financed (single-vehicle) quote with a forwarded deposit, and no hold row exists to re-point", async () => {
    const { s, quoteId, depositId } = await paidDeal("a1");
    const holdRows = () => s.t.run((ctx) => ctx.db.query("depositVehicleHolds").collect());
    expect(await holdRows()).toEqual([]);
    const before = await untouched(s, depositId);
    const refusal = await refusalDataOf(
      s.approver.as.mutation(api.deposits.allocateToVehicles, {
        orgId: s.orgId, quoteId, allocations: [{ vehicleId: s.vehicleId, amount: H / SCALE }],
      })
    );
    expect(refusal?.message).toMatch(/single vehicle/i);
    expect(await holdRows()).toEqual([]);
    expect(await untouched(s, depositId)).toEqual(before);
  });
});

describe("P2-02 - a payment recorded before slices existed holds back the whole quote", () => {
  test("legacy (unsliced) live version: every deposit of the quote is held back; once taken back they are free", async () => {
    const { s, applicationId, quoteId, forwardId, depositId } = await paidDeal("l1");
    const other = await rawDeposit(s, quoteId, 50_000);
    // Make the payment look like one recorded before provenance existed.
    await s.t.run(async (ctx) => {
      for (const slice of await ctx.db.query("financeCompanyForwardSlices").collect()) await ctx.db.delete(slice._id);
    });
    expect(await dispositionOf(s, depositId)).toBe("NOT_FORWARDED");
    expect((await refusalDataOf(release(s, depositId, "FORFEITED")))?.code).toBe(GUARD);
    expect((await refusalDataOf(voidDeposit(s, other)))?.code).toBe(GUARD);

    await voidForward(s, applicationId, forwardId);
    expect(await refusalDataOf(voidDeposit(s, other))).toBeNull();
    expect(await refusalDataOf(release(s, depositId, "FORFEITED"))).toBeNull();
  });
});

describe("P2-02 - a contribution-only payment (H = 0) carries no deposit", () => {
  /** A deal that holds no deposit when the contribution D alone is paid onward: no slice is written. */
  async function contributionOnlyDeal(tag: string) {
    const s = await seed(tag);
    const { applicationId, quoteId } = await readyDeal(s, { deposit: false });
    const forwardId = await payForwardAsOwner(s, applicationId);
    if (forwardId === null) throw new Error("fixture: the deal owes the finance company nothing");
    return { s, applicationId, quoteId, forwardId };
  }

  test("a deposit taken after the payment stays spendable while the new-era H = 0 payment is on the books", async () => {
    const { s, applicationId, quoteId, forwardId } = await contributionOnlyDeal("z1");
    const forward = await s.t.run((ctx) => ctx.db.get(forwardId));
    expect(forward?.depositPortionMinor).toBe(0);
    expect(forward?.planFingerprint).toBeDefined();
    expect(await slicesOf(s)).toEqual([]);
    // The guard is only tested while the payment is on the books: a reversed one would pass anyway.
    expect(await forwardLiveOf(s, applicationId)).toBe(true);

    const toVoid = await rawDeposit(s, quoteId, 50_000);
    const toForfeit = await rawDeposit(s, quoteId, 60_000);
    expect(await guardCodeOf(s, toVoid)).toBeNull();
    expect(await refusalDataOf(voidDeposit(s, toVoid))).toBeNull();
    expect(await refusalDataOf(release(s, toForfeit, "FORFEITED"))).toBeNull();
    // The payment itself is untouched, and still recoverable.
    expect((await forwardsOf(s)).map((row) => row._id)).toEqual([forwardId]);
    expect(await forwardLiveOf(s, applicationId)).toBe(true);
    await voidForward(s, applicationId, forwardId);
    // Recovered: the payment is no longer live, and the spends above left no slice behind.
    expect(await forwardLiveOf(s, applicationId)).toBe(false);
    expect(await slicesOf(s)).toEqual([]);
  });

  test("a legacy-shaped H = 0 payment (no plan fingerprint) is still held back: it cannot say what it carried", async () => {
    const { s, quoteId, forwardId } = await contributionOnlyDeal("z2");
    await s.t.run((ctx) => ctx.db.patch(forwardId, { planFingerprint: undefined }));
    const later = await rawDeposit(s, quoteId, 50_000);
    expect(await guardCodeOf(s, later)).toBe(GUARD);
    expect((await refusalDataOf(voidDeposit(s, later)))?.code).toBe(GUARD);
  });

  test("a payment that claims a deposit portion but has no slices is still held back", async () => {
    const { s, quoteId, forwardId } = await contributionOnlyDeal("z3");
    await s.t.run((ctx) => ctx.db.patch(forwardId, { depositPortionMinor: H }));
    const later = await rawDeposit(s, quoteId, 50_000);
    expect(await guardCodeOf(s, later)).toBe(GUARD);
    expect((await refusalDataOf(voidDeposit(s, later)))?.code).toBe(GUARD);
  });
});
