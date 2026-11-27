import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AMOUNTS, CASH, EXP, OCT_20, seedWorld as seedWorldWith, type World } from "../test-utils/scrum987Fixture";
import {
  approvedFor as approvedForDeal, cloneEntry, codes, dealEvents, openOctober, preview, previewResult, reverseDeal,
} from "../test-utils/purgePreview";
import type { Doc, Id } from "./_generated/dataModel";
import { PURGE_CLEARABLE_FIELDS } from "./utils/purgeImpactMap";
import { ReadBudget } from "./utils/purgeBudget";

/**
 * SCRUM-1023 Phase 1, PR #908 round 2: the deposit clear needs the owner's exact id, a forward-linked journal passes
 * the same join guard as every other row, legacy transactions refuse, and exceptions are exact about status, root,
 * duplicates and keys.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});
const approvedFor = (w: World, index: number, amount: number) => approvedForDeal(w, index, amount, CASH, EXP);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

async function saleWorld(suffix: string) {
  const w = await seedWorld(suffix);
  const app = (await w.t.run((ctx) => ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">)))!;
  const saleId = await w.t.run((ctx) => ctx.db.insert("sales", {
    orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 10_500,
    saleDate: Date.now(), status: "CANCELLED", isDeleted: true,
  } as never));
  return { w, app, saleId };
}

const deposit = (w: World, app: Doc<"financeApplications">, saleId: Id<"sales">, extra: Record<string, unknown> = {}) =>
  w.t.run((ctx) => ctx.db.insert("deposits", {
    orgId: w.orgId, customerId: app.customerId, vehicleId: app.vehicleId, quoteId: app.quoteId, amount: 50, amountMinor: 50_000, currency: "JOD",
    status: "REFUNDED", holdActive: false, refundedAmountMinor: 0, releasedAmountMinor: 0, releaseCount: 0, resolutionSaleId: saleId,
    createdBy: w.actorId, createdAt: 1, ...extra,
  } as never));

describe("round 2 / A - a deposit's resolutionSaleId is cleared only for the exact id the owner approved", () => {
  const consequence = PURGE_CLEARABLE_FIELDS.deposits.ownerApproval;

  test("a REFUNDED deposit naming a purged sale refuses until the owner passes its id", async () => {
    const { w, app, saleId } = await saleWorld("dep-unapproved");
    await deposit(w, app, saleId);
    const m = await preview(w, { saleIds: [saleId] });
    expect(codes(m)).toEqual(["FIELD_CLEAR_NEEDS_APPROVAL"]);
    expect(m.fieldClears).toEqual([]);
  });

  test("the approved id is listed with its guarding state and the fixed consequence note", async () => {
    const { w, app, saleId } = await saleWorld("dep-approved");
    const dep = await deposit(w, app, saleId);
    const m = await preview(w, { saleIds: [saleId] }, [], [], [dep]);
    expect(m.refusals).toEqual([]);
    expect(m.fieldClears).toEqual([{ table: "deposits", id: dep, field: "resolutionSaleId", guardField: "status", guardValue: "REFUNDED", consequence }]);
    expect(consequence).toContain("identityCorrectionShowroomRefund");
    expect(consequence).toContain("openingDepositRefunds");
  });

  test("a HELD deposit with the OTHER treatment lists that treatment next to its status", async () => {
    const { w, app, saleId } = await saleWorld("dep-held-other");
    const dep = await deposit(w, app, saleId, { status: "HELD", holdActive: true, resolutionTreatment: "OTHER" });
    const m = await preview(w, { saleIds: [saleId] }, [], [], [dep]);
    expect(m.refusals).toEqual([]);
    expect(m.fieldClears).toEqual([{ table: "deposits", id: dep, field: "resolutionSaleId", guardField: "status", guardValue: "HELD", treatment: "OTHER", consequence }]);
  });

  test("an approved id that is not a pending clear refuses, so a stale approval cannot linger", async () => {
    const { w, app, saleId } = await saleWorld("dep-stale");
    const dep = await deposit(w, app, saleId);
    const stranger = await deposit(w, app, saleId, { resolutionSaleId: undefined });
    const m = await preview(w, { saleIds: [saleId] }, [], [], [dep, stranger]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE"]);
    expect(m.refusals[0].table).toBe("approvedFieldClearIds");
  });

  test("an APPLIED deposit still refuses as a surviving reference even when its id is approved", async () => {
    const { w, app, saleId } = await saleWorld("dep-applied");
    const dep = await deposit(w, app, saleId, { status: "APPLIED" });
    const m = await preview(w, { saleIds: [saleId] }, [], [], [dep]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE", "SURVIVING_REFERENCE"]);
    expect(m.fieldClears).toEqual([]);
  });

  test("M1: a second link in the same deposit keeps it a surviving reference, approved or not", async () => {
    const { w, app, saleId } = await saleWorld("dep-second-link");
    const dep = await deposit(w, app, saleId, { notes: `paid against ${saleId}` });
    const m = await preview(w, { saleIds: [saleId] }, [], [], [dep]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE", "SURVIVING_REFERENCE"]);
    expect(m.fieldClears).toEqual([]);
  });
});

describe("round 2 / A - the vehicle and hold clears carry their guarding state", () => {
  test("an AVAILABLE vehicle is cleared and says so; a second link keeps it a surviving reference", async () => {
    const { w, app, saleId } = await saleWorld("veh-guard");
    await w.t.run((ctx) => ctx.db.patch(app.vehicleId, { status: "AVAILABLE", soldBySaleId: saleId }));
    const m = await preview(w, { saleIds: [saleId] });
    expect(m.refusals).toEqual([]);
    expect(m.fieldClears).toEqual([{ table: "vehicles", id: app.vehicleId, field: "soldBySaleId", guardField: "status", guardValue: "AVAILABLE" }]);
    await w.t.run((ctx) => ctx.db.patch(app.vehicleId, { notes: `was sold by ${saleId}` } as never));
    const twice = await preview(w, { saleIds: [saleId] });
    expect(codes(twice)).toEqual(["SURVIVING_REFERENCE"]);
    expect(twice.fieldClears).toEqual([]);
  });

  async function hold(w: World, app: Doc<"financeApplications">, saleId: Id<"sales">, allocationStatus: "RELEASED_AWAITING_DECISION" | "APPLIED") {
    const dep = await deposit(w, app, saleId, { status: "HELD", holdActive: true, resolutionSaleId: undefined });
    return await w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", {
      orgId: w.orgId, depositId: dep, vehicleId: app.vehicleId, active: false, createdAt: 1, allocationStatus, appliedSaleId: saleId,
    } as never));
  }

  test("a released hold naming a purged sale is cleared with its allocation status; an APPLIED hold refuses", async () => {
    const { w, app, saleId } = await saleWorld("hold-clear");
    const held = await hold(w, app, saleId, "RELEASED_AWAITING_DECISION");
    const m = await preview(w, { saleIds: [saleId] });
    expect(m.refusals).toEqual([]);
    expect(m.fieldClears).toEqual([{ table: "depositVehicleHolds", id: held, field: "appliedSaleId", guardField: "allocationStatus", guardValue: "RELEASED_AWAITING_DECISION" }]);
    await w.t.run((ctx) => ctx.db.patch(held, { allocationStatus: "APPLIED" }));
    const applied = await preview(w, { saleIds: [saleId] });
    expect(codes(applied)).toEqual(["SURVIVING_REFERENCE"]);
    expect(applied.fieldClears).toEqual([]);
  });
});

describe("round 2 / B - a journal reached only through a purged event's journalEntryId passes the join guard", () => {
  test("a journal with no accountingEventId back-link whose sourceId names a live sale is SHARED_WITH_LIVE and is not added", async () => {
    const w = await seedWorld("forward-journal");
    await openOctober(w);
    const app = (await w.t.run((ctx) => ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">)))!;
    const liveSale = await w.t.run((ctx) => ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "COMPLETED",
    } as never));
    const events = await dealEvents(w, 0);
    const clone = await cloneEntry(w, events[0]._id, "forward", false, { ref: w.targets[0].applicationId });
    await w.t.run((ctx) => ctx.db.patch(clone.journalId, { accountingEventId: undefined, sourceId: liveSale }));
    const m = await preview(w, { applicationIds: [w.targets[0].applicationId] }, [await approvedFor(w, 0, AMOUNTS[0])]);
    expect(codes(m)).toContain("SHARED_WITH_LIVE");
    expect(m.idsByTable.journalEntries ?? []).not.toContain(clone.journalId);
    expect(m.ok).toBe(false);
  });
});

describe("round 2 / E - a legacy transactions row that would join must be deleted, or the owner names it", () => {
  const txn = (w: World, saleId: Id<"sales">, extra: Record<string, unknown> = {}) =>
    w.t.run((ctx) => ctx.db.insert("transactions", {
      orgId: w.orgId, type: "IN", amount: 1, date: 1, category: "VEHICLE_SALE", description: "legacy", saleId, ...extra,
    } as never));

  test("a non-deleted row refuses, a deleted one joins, and an approved id joins", async () => {
    const { w, saleId } = await saleWorld("legacy-txn");
    const live = await txn(w, saleId);
    const refused = await preview(w, { saleIds: [saleId] });
    expect(codes(refused)).toEqual(["LEGACY_TRANSACTION_ROW"]);
    const approved = await preview(w, { saleIds: [saleId] }, [], [live]);
    expect(approved.refusals).toEqual([]);
    expect(approved.idsByTable.transactions).toEqual([live]);
    await w.t.run((ctx) => ctx.db.patch(live, { isDeleted: true }));
    const deleted = await preview(w, { saleIds: [saleId] });
    expect(deleted.refusals).toEqual([]);
    expect(deleted.idsByTable.transactions).toEqual([live]);
  });
});

describe("round 2 / F - an exception is exact about status, root, duplicates and keys", () => {
  async function unreversed(suffix: string) {
    const w = await seedWorld(suffix);
    await openOctober(w);
    return w;
  }
  const roots = (w: World) => ({ applicationIds: [w.targets[0].applicationId] });

  test("an exempt journal must be POSTED: a DRAFT one refuses", async () => {
    const w = await unreversed("exempt-draft");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    await w.t.run((ctx) => ctx.db.patch(ex.journalIds[0] as Id<"journalEntries">, { status: "DRAFT" }));
    const m = await preview(w, roots(w), [ex]);
    expect(codes(m)).toEqual(["EXCEPTION_MISMATCH"]);
  });

  test("an exempt event must be POSTED: a PENDING one refuses", async () => {
    const w = await unreversed("exempt-pending");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    await w.t.run((ctx) => ctx.db.patch(ex.eventIds[0] as Id<"accountingEvents">, { status: "PENDING" }));
    const m = await preview(w, roots(w), [ex]);
    expect(codes(m)).toEqual(["EXCEPTION_MISMATCH"]);
  });

  test("ids that belong to another root's deal refuse, even though both roots are in the purge set", async () => {
    const w = await seedWorld("exempt-wrong-root");
    await reverseDeal(w, 0);
    const other = await approvedFor(w, 1, AMOUNTS[1]);
    const both = { applicationIds: [w.targets[0].applicationId, w.targets[1].applicationId] };
    const honest = await preview(w, both, [other]);
    expect(honest.refusals).toEqual([]);
    const m = await preview(w, both, [{ ...other, rootId: w.targets[0].applicationId }]);
    expect(codes(m)).toEqual(["EXCEPTION_NOT_FROM_ROOT"]);
  });

  test("a repeated id is counted once", async () => {
    const w = await unreversed("exempt-dupes");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    const m = await preview(w, roots(w), [{ ...ex, eventIds: [...ex.eventIds, ex.eventIds[0]], journalIds: [...ex.journalIds, ex.journalIds[0]] }]);
    expect(m.refusals).toEqual([]);
  });

  test("caller strings that contain the old separator come back whole", async () => {
    const w = await unreversed("exempt-keys");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    const odd = { periodId: String(w.octPeriodId), accountId: ex.expectedNets[0].accountId, currency: "J|K", bankAccountId: "x|y", netMinor: 5 };
    const m = await preview(w, roots(w), [{ ...ex, expectedNets: [...ex.expectedNets, odd] }]);
    const item = m.exceptionItems.find((i) => i.currency === "J|K");
    expect(item).toMatchObject({ periodId: odd.periodId, accountId: odd.accountId, currency: "J|K", bankAccountId: "x|y", expectedNetMinor: 5 });
  });

  test("an account id that is not an id at all refuses instead of failing the query", async () => {
    const w = await unreversed("exempt-bad-account");
    const ex = await approvedFor(w, 0, AMOUNTS[0]);
    const res = await previewResult(w, roots(w), [{ ...ex, expectedNets: [...ex.expectedNets, { periodId: String(w.octPeriodId), accountId: "not-an-id", currency: "JOD", netMinor: 5 }] }]);
    expect(res.success).toBe(true);
    if (res.success) expect(res.manifest.refusals.map((r) => r.code)).toContain("EXCEPTION_MISMATCH");
  });
});

describe("round 2 / LOW 6 - the read budget checks its document room before every read", () => {
  test("reserve refuses once the documents are spent, even with ranges left", () => {
    const budget = new ReadBudget({ perTableCap: 10, totalDocs: 5, totalRanges: 100 });
    expect(budget.reserve(1)).toBe(true);
    budget.record(5);
    expect(budget.reserve(1)).toBe(false);
    expect(budget.exhausted).toBe(true);
  });

  test("an exhausted scan reports OVER_BOUND alone, without stale-approval noise", async () => {
    const w = await seedWorld("noise");
    await openOctober(w);
    const res = await w.t.run((ctx) => import("./utils/purgeManifest").then((mod) => mod.buildPurgeManifest(
      ctx, w.orgId, { saleIds: [], applicationIds: [w.targets[0].applicationId], expenseIds: [], transferEventIds: [] },
      [{ rootId: w.targets[0].applicationId, eventIds: ["x"], journalIds: [], expectedNets: [] }], ["somerow"], [], { perTableCap: 6000, totalDocs: 3, totalRanges: 4000 },
    )));
    expect([...new Set(res.refusals.map((r) => r.code))]).toEqual(["OVER_BOUND"]);
  });
});
