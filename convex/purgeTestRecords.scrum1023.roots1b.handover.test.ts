import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { seedWorld as seedWorldWith, OCT_20 } from "../test-utils/scrum987Fixture";
import { cloneEntry, codes, dealEvents, linkAsPair, openOctober, preview, reverseDeal } from "../test-utils/purgePreview";
import type { Doc, Id } from "./_generated/dataModel";
import type { World } from "../test-utils/scrum987Fixture";

/**
 * SCRUM-1023 Phase 1b follow-up (2026-11-27): the approved HANDED_OVER application, and which id an approved exception names.
 * Base world: deal 0 fully reversed, so a refusal comes only from the one fact a test adds.
 */

const MODULES = import.meta.glob("./**/*.*s");
const seedWorld = (suffix: string) => seedWorldWith(MODULES, suffix, {});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => { vi.useRealTimers(); });

async function reversedWorld(suffix: string) {
  const w = await seedWorld(suffix);
  await reverseDeal(w, 0);
  return { w, app: w.targets[0].applicationId, keptApp: w.targets[1].applicationId };
}
describe("ruling D follow-up - an approved HANDED_OVER application is purged only when the stale handover is proven harmless", () => {
  async function handedOver(suffix: string, vehicleStatus: Doc<"vehicles">["status"] = "AVAILABLE") {
    const base = await reversedWorld(suffix);
    const vehicleId = await base.w.t.run(async (ctx) => {
      const app = (await ctx.db.get(base.app as Id<"financeApplications">))!;
      await ctx.db.patch(base.app as Id<"financeApplications">, { handoverStatus: "HANDED_OVER", vehicleHandoverAt: 5 });
      await ctx.db.patch(app.vehicleId, { status: vehicleStatus });
      return app.vehicleId;
    });
    return { ...base, vehicleId };
  }

  test("default: refuses LIVE_STATE_ROW only, and no approval is listed", async () => {
    const { w, app } = await handedOver("ho-default");
    const m = await preview(w, { applicationIds: [app] });
    expect(m.refusals.map((r) => [r.code, r.table])).toEqual([["LIVE_STATE_ROW", "financeApplications"]]);
    expect(m.handoverOverrides).toEqual([]);
  });

  test("approved and proven (vehicle AVAILABLE, nothing kept names it, no live event): accepted and itemized", async () => {
    const { w, app, vehicleId } = await handedOver("ho-proven");
    const m = await preview(w, { applicationIds: [app] }, [], [app]);
    expect(m.refusals).toEqual([]);
    expect(m.handoverOverrides).toEqual([{ applicationId: app, vehicleId, vehicleStatus: "AVAILABLE", liveConsequences: [] }]);
  });

  test.each(["SOLD", "RESERVED"] as const)("approved but the vehicle is %s: HANDOVER_LIVE_CONSEQUENCE, approval void", async (status) => {
    const { w, app } = await handedOver(`ho-${status}`, status);
    const m = await preview(w, { applicationIds: [app] }, [], [app]);
    expect(m.refusals.map((r) => [r.code, r.table])).toEqual([["HANDOVER_LIVE_CONSEQUENCE", "financeApplications"]]);
    expect(m.handoverOverrides[0].vehicleStatus).toBe(status);
    expect(m.handoverOverrides[0].liveConsequences.join(" ")).toContain(status);
  });

  test("approved but a KEPT row names the application: HANDOVER_LIVE_CONSEQUENCE", async () => {
    const { w, app } = await handedOver("ho-kept-row");
    await w.t.run(async (ctx) => {
      const keptApp = (await ctx.db.get(w.targets[1].applicationId as Id<"financeApplications">))!;
      await ctx.db.insert("sales", {
        orgId: w.orgId, vehicleId: keptApp.vehicleId, customerId: keptApp.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1,
        status: "COMPLETED", applicationId: app,
      } as never);
    });
    const m = await preview(w, { applicationIds: [app] }, [], [app]);
    expect(codes(m)).toContain("HANDOVER_LIVE_CONSEQUENCE");
    expect(m.handoverOverrides[0].liveConsequences.join(" ")).toContain("sales");
  });

  test("approved but a POSTED un-reversed event names the application: HANDOVER_LIVE_CONSEQUENCE", async () => {
    const { w, app } = await handedOver("ho-live-event");
    await openOctober(w);
    const source = (await dealEvents(w, 1))[0];
    await cloneEntry(w, source._id, "ho-ev", false, { applicationId: app }, "FINANCE_COMPANY_PAYMENT");
    const m = await preview(w, { applicationIds: [app] }, [], [app]);
    expect(codes(m)).toContain("HANDOVER_LIVE_CONSEQUENCE");
  });

  test("the approval of an id that is not in the purge (a kept application) is the stale-approval refusal", async () => {
    const { w, app, keptApp } = await handedOver("ho-stale");
    const m = await preview(w, { applicationIds: [app] }, [], [keptApp]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE", "LIVE_STATE_ROW"]);
  });
});

describe("approvedExceptions[].rootId - which id a custody-cash exception must name", () => {
  test("rootId must be the APPLICATION id passed in applicationIds: the custody record id and the deal event id refuse and say so", async () => {
    const { w, app } = await reversedWorld("exc-rootid");
    const event = (await dealEvents(w, 0))[0];
    const exception = (rootId: string) => [{ rootId, eventIds: [event._id], journalIds: [], expectedNets: [] }];
    const ok = await preview(w, { applicationIds: [app] }, exception(app));
    expect(ok.refusals.filter((r) => r.code === "EXCEPTION_ROOT_NOT_IN_PURGE")).toEqual([]);
    for (const wrong of [event._id, w.orgId]) {
      const m = await preview(w, { applicationIds: [app] }, exception(String(wrong)));
      const refusal = m.refusals.find((r) => r.code === "EXCEPTION_ROOT_NOT_IN_PURGE");
      expect(refusal?.detail).toContain("APPLICATION id");
      expect(refusal?.detail).toContain("never the deal id or the custody record id");
    }
  });
});

describe("SCRUM-961 (main 9958020df): opening prepaid reclassification rows are never silently skipped", () => {
  async function reclassWorld(suffix: string) {
    const base = await reversedWorld(suffix);
    const { w } = base;
    const ids = await w.t.run(async (ctx) => {
      const expenseId = await ctx.db.insert("expenses", { orgId: w.orgId, title: "p", amount: 1, date: 1, category: "OTHER", isDeleted: true } as never);
      const scheduleId = await ctx.db.insert("prepaidExpenseSchedules", {
        orgId: w.orgId, expenseId, currency: "JOD", totalMinor: 1000, termMonths: 12, expenseSystemKey: "k", startYearMonth: "2026-10", recognizedMinor: 0, status: "ACTIVE", createdAt: 1,
      });
      return { expenseId, scheduleId };
    });
    return { ...base, ...ids };
  }
  const reclass = (w: World, scheduleId: Id<"prepaidExpenseSchedules">, extra: Partial<Doc<"openingPrepaidReclassifications">> = {}) =>
    w.t.run((ctx) => ctx.db.insert("openingPrepaidReclassifications", {
      orgId: w.orgId, scheduleId, status: "APPROVED", lines: [{ userId: w.actorId, amountMinor: 1 }], totalMinor: 1, reason: "r", requestedBy: w.actorId, requestedAt: 1, ...extra,
    }));

  test("a kept reclassification that names a PURGED accounting event refuses SURVIVING_REFERENCE on its table", async () => {
    const { w, app, scheduleId } = await reclassWorld("961-event");
    const event = (await dealEvents(w, 0))[0];
    await reclass(w, scheduleId, { eventId: event._id });
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => s.table)).toEqual(["openingPrepaidReclassifications"]);
  });

  test("an expense root whose prepaid schedule is still kept refuses on the schedule (the reclassification hangs off it)", async () => {
    const { w, expenseId, scheduleId } = await reclassWorld("961-expense");
    await openOctober(w);
    const source = (await dealEvents(w, 1))[0];
    const original = await cloneEntry(w, source._id, "961-a", false, { expenseId });
    const reversal = await cloneEntry(w, source._id, "961-b", true, { expenseId });
    await linkAsPair(w, original, reversal);
    await reclass(w, scheduleId);
    const m = await preview(w, { expenseIds: [expenseId] });
    expect(codes(m)).toEqual(["SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => s.table)).toEqual(["prepaidExpenseSchedules"]);
  });

  test("a clean cancelled payroll run root is unaffected by the new tables (no reference path from a run to a reclassification)", async () => {
    const { w } = await reclassWorld("961-payroll");
    await reclass(w, (await w.t.run((ctx) => ctx.db.query("prepaidExpenseSchedules").first()))!._id);
    const [runId] = await w.t.run(async (ctx) => {
      const run = await ctx.db.insert("payrollRuns", { orgId: w.orgId, periodYear: 2026, periodMonth: 10, currency: "JOD", status: "CANCELLED", totalGrossMinor: 1, totalNetMinor: 1, createdAt: 1, updatedAt: 1 });
      return [run];
    });
    const m = await preview(w, { payrollRunIds: [runId] });
    expect(m.refusals).toEqual([]);
  });
});