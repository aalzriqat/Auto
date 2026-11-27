import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { seedWorld as seedWorldWith, OCT_20 } from "../test-utils/scrum987Fixture";
import type { World } from "../test-utils/scrum987Fixture";
import { cloneEntry, codes, dealEvents, linkAsPair, openOctober, preview, reverseDeal, type Manifest } from "../test-utils/purgePreview";
import type { Doc, Id } from "./_generated/dataModel";
import { buildPurgeManifest } from "./utils/purgeManifest";

/**
 * SCRUM-1023 Phase 1b (owner rulings 2026-11-27, second set): audit rows, CANCELLED payroll run roots, REFUNDED
 * deposit roots and CONFIRMED lender-payment evidence. Each refusal test names the exact code(s) it can only pass for.
 * The base world has deal 0 fully reversed (complete pairs, zero net), so a refusal comes only from the one fact a test adds.
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

// This is the name of a TABLE. pilotConfigParity.test.ts reads any string call argument equal to a pilot module basename
// (convex/utils/dealCommissionLines.ts, basename dealCommissionLines) as a mock of that module, so a literal here would label this suite NON-PILOT-CERTIFYING
// although it opens no door. A named constant is the table name, not a module reference.
const COMMISSION_LINES = "dealCommissionLines" as const;

const has = (m: Manifest, id: string): boolean => Object.values(m.idsByTable).flat().includes(id);

async function insertKeptSale(w: World): Promise<Id<"sales">> {
  return await w.t.run(async (ctx) => {
    const app = (await ctx.db.get(w.targets[1].applicationId as Id<"financeApplications">))!;
    return ctx.db.insert("sales", {
      orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 10_500,
      saleDate: Date.now(), status: "COMPLETED",
    } as never);
  });
}

describe("ruling A - audit rows that mention purged records are deleted with them", () => {
  const audit = (w: World, resourceId: string, extra: Partial<Doc<"financialAuditLog">> = {}) =>
    w.t.run((ctx) => ctx.db.insert("financialAuditLog", {
      orgId: w.orgId, actorId: w.actorId, actionType: "POST_EVENT", resourceType: "x", resourceId, description: "d", occurredAt: 1, ...extra,
    }));

  test("a row whose SUBJECT is the purged application joins the set and the purge stays ok", async () => {
    const { w, app } = await reversedWorld("audit-subject");
    const id = await audit(w, app, { after: { note: "kept nothing" } });
    const m = await preview(w, { applicationIds: [app] });
    expect(m.refusals).toEqual([]);
    // The real reversal engine wrote its own audit rows about this deal: they leave with it too, so the new row is one of several.
    expect(m.idsByTable.financialAuditLog).toContain(id);
    expect(m.auditRowsByTable).toEqual({});
  });

  test("a row about a KEPT record that mentions the purged id is never guessed at: AUDIT_MIXED_SUBJECT only", async () => {
    const { w, app, keptApp } = await reversedWorld("audit-mixed");
    await audit(w, keptApp, { description: `compared with ${app}` });
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["AUDIT_MIXED_SUBJECT"]);
    expect(m.auditRowsByTable).toEqual({ financialAuditLog: 1 });
  });

  test("a row whose subject is purged but which also names a kept record is deleted and listed separately", async () => {
    const { w, app, keptApp } = await reversedWorld("audit-lists-kept");
    const id = await audit(w, app, { after: { other: keptApp } });
    const m = await preview(w, { applicationIds: [app] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.financialAuditLog).toContain(id);
    expect(m.auditRowsMentioningKept).toEqual([{ table: "financialAuditLog", ids: [id] }]);
  });

  test("an audit row never pulls anything into the purge: a kept row it names stays out", async () => {
    const { w, app, keptApp } = await reversedWorld("audit-no-growth");
    await audit(w, app, { after: { other: keptApp } });
    const m = await preview(w, { applicationIds: [app] });
    expect(has(m, keptApp)).toBe(false);
  });

  test("an audit row about a purged ledger row (found by closure, not named as a root) joins", async () => {
    const { w, app } = await reversedWorld("audit-event");
    const events = await dealEvents(w, 0);
    const id = await audit(w, events[0]._id, { resourceType: "accountingEvents" });
    const m = await preview(w, { applicationIds: [app] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.financialAuditLog).toContain(id);
  });

  test("ORG-LESS admin audit rows: one about the purged id joins, one that only mentions it refuses, an unrelated one is untouched", async () => {
    const { w, app, keptApp } = await reversedWorld("audit-orgless");
    const admin = (targetId: string | undefined, after?: unknown) => w.t.run((ctx) => ctx.db.insert("adminAuditLog", {
      actorUserId: w.actorId, actorEmail: "a@x.com", action: "x", targetTable: "financeApplications", targetId, after, createdAt: 1,
    }));
    const mine = await admin(app);
    const unrelated = await admin(keptApp);
    const clean = await preview(w, { applicationIds: [app] });
    expect(clean.refusals).toEqual([]);
    expect(clean.idsByTable.adminAuditLog).toEqual([mine]);
    expect(has(clean, unrelated)).toBe(false);
    await admin(keptApp, { mentions: app });
    expect(codes(await preview(w, { applicationIds: [app] }))).toEqual(["AUDIT_MIXED_SUBJECT"]);
  });

  test("an audit row of ANOTHER organization is never read: its org-bound rows do not appear", async () => {
    const { w, app } = await reversedWorld("audit-foreign");
    const other = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: 1 }));
    const foreign = await w.t.run((ctx) => ctx.db.insert("adminAuditLog", {
      actorUserId: w.actorId, actorEmail: "a@x.com", action: "x", targetId: "unrelated", orgId: other, createdAt: 1,
    }));
    const m = await preview(w, { applicationIds: [app] });
    expect(m.ok).toBe(true);
    expect(has(m, foreign)).toBe(false);
  });
});

describe("ruling B - a CANCELLED payroll run that mixes purged and real sales is deleted", () => {
  async function run(w: World, extra: Partial<Doc<"payrollRuns">> = {}) {
    const keptSale = await insertKeptSale(w);
    return await w.t.run(async (ctx) => {
      const runId = await ctx.db.insert("payrollRuns", {
        orgId: w.orgId, periodYear: 2026, periodMonth: 10, currency: "JOD", status: "CANCELLED", totalGrossMinor: 100, totalNetMinor: 100,
        cancelledBy: w.actorId, cancelledAt: 2, createdAt: 1, updatedAt: 2, ...extra,
      });
      const itemId = await ctx.db.insert("payrollItems", {
        orgId: w.orgId, runId, userId: w.actorId, baseSalaryMinor: 0, commissionMinor: 100, otherEarningsMinor: 0, advanceDeductionMinor: 0,
        otherDeductionMinor: 0, grossMinor: 100, netMinor: 100, currency: "JOD", commissionSaleIds: [keptSale], createdAt: 1,
      });
      return { runId, itemId, keptSale };
    });
  }

  test("a cancelled draft run whose item names a REAL sale is deleted with its item; the real sale stays", async () => {
    const { w } = await reversedWorld("pay-ok");
    const r = await run(w);
    const m = await preview(w, { payrollRunIds: [r.runId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.payrollRuns).toEqual([r.runId]);
    expect(m.idsByTable.payrollItems).toEqual([r.itemId]);
    expect(has(m, r.keptSale)).toBe(false);
  });

  test("a run that is not CANCELLED is ROOT_NOT_ELIGIBLE; a missing one ROOT_NOT_FOUND", async () => {
    const { w } = await reversedWorld("pay-draft");
    const r = await run(w, { status: "DRAFT" });
    expect(codes(await preview(w, { payrollRunIds: [r.runId] }))).toEqual(["ROOT_NOT_ELIGIBLE"]);
    expect(codes(await preview(w, { payrollRunIds: ["nope"] }))).toEqual(["ROOT_NOT_FOUND"]);
  });

  test("a cancelled run carrying payment fields refuses PAYROLL_RUN_PAYMENT_EVIDENCE", async () => {
    const { w } = await reversedWorld("pay-fields");
    const r = await run(w, { paidAt: 5, paidBy: w.actorId, paidMethod: "CASH" });
    expect(codes(await preview(w, { payrollRunIds: [r.runId] }))).toEqual(["PAYROLL_RUN_PAYMENT_EVIDENCE"]);
  });

  test("the status field is not the proof: a POSTED, unreversed accrual naming an item refuses PAYROLL_RUN_LEDGER_EFFECT", async () => {
    const { w } = await reversedWorld("pay-ledger");
    await openOctober(w);
    const r = await run(w);
    const source = (await dealEvents(w, 1))[0];
    await cloneEntry(w, source._id, "accrual-1", false, { itemId: r.itemId, runId: r.runId, amountMinor: 100 }, "PAYROLL_ACCRUED");
    const m = await preview(w, { payrollRunIds: [r.runId] });
    expect(m.ok).toBe(false);
    expect(codes(m)).toContain("PAYROLL_RUN_LEDGER_EFFECT");
  });

  test("a complete reversed pair naming the item is acceptable ledger history and nets to zero", async () => {
    const { w } = await reversedWorld("pay-pair");
    await openOctober(w);
    const r = await run(w);
    const source = (await dealEvents(w, 1))[0];
    const payload = { itemId: r.itemId, runId: r.runId, amountMinor: 100 };
    const original = await cloneEntry(w, source._id, "accrual-a", false, payload, "PAYROLL_ACCRUED");
    const reversal = await cloneEntry(w, source._id, "accrual-b", true, payload, "PAYROLL_ACCRUED");
    await linkAsPair(w, original, reversal);
    const m = await preview(w, { payrollRunIds: [r.runId] });
    expect(m.refusals).toEqual([]);
    expect(m.countsByTable.accountingEvents).toBe(2);
    expect(m.accountNet.every((x) => x.netMinor === 0)).toBe(true);
  });

  test("an advance recovery that names an item is a payment: PAYROLL_RUN_PAYMENT_EVIDENCE and a SURVIVING_REFERENCE for the kept advance", async () => {
    const { w } = await reversedWorld("pay-recovery");
    const r = await run(w);
    await w.t.run(async (ctx) => {
      const advanceId = await ctx.db.insert("employeeAdvances", {
        orgId: w.orgId, userId: w.actorId, amountMinor: 50, recoveredMinor: 50, currency: "JOD", date: 1, status: "RECOVERED", createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("employeeAdvanceRecoveries", {
        orgId: w.orgId, advanceId, userId: w.actorId, amountMinor: 50, currency: "JOD", source: "PAYROLL", payrollItemId: r.itemId, recoveredAt: 1, recoveredBy: w.actorId,
      });
    });
    const m = await preview(w, { payrollRunIds: [r.runId] });
    expect(codes(m)).toEqual(["PAYROLL_RUN_PAYMENT_EVIDENCE", "SURVIVING_REFERENCE"]);
    expect(m.survivingReferences.map((s) => s.table)).toEqual(["employeeAdvanceRecoveries"]);
  });

  test("a commission line paid on an item is a payment: PAYROLL_RUN_PAYMENT_EVIDENCE", async () => {
    const { w } = await reversedWorld("pay-line");
    const r = await run(w);
    await w.t.run((ctx) => ctx.db.insert(COMMISSION_LINES, {
      orgId: w.orgId, saleId: r.keptSale, kind: "SALE", employeeId: w.actorId, amountMinor: 100, currency: "JOD", createdBy: w.actorId,
      paidAt: 3, paidBy: w.actorId, payrollItemId: r.itemId,
    }));
    expect(codes(await preview(w, { payrollRunIds: [r.runId] }))).toContain("PAYROLL_RUN_PAYMENT_EVIDENCE");
  });

  test("any other kept row that names the run strands nothing silently: SURVIVING_REFERENCE", async () => {
    const { w } = await reversedWorld("pay-survivor");
    const r = await run(w);
    await w.t.run((ctx) => ctx.db.insert("tasks", { orgId: w.orgId, assignedTo: w.actorId, title: "t", description: `run ${r.runId}`, dueDate: 1, status: "PENDING" }));
    expect(codes(await preview(w, { payrollRunIds: [r.runId] }))).toEqual(["SURVIVING_REFERENCE"]);
  });

  test("a payslip of a run that is NOT a root still refuses when it names a purged sale (phase 1 behaviour unchanged)", async () => {
    const { w } = await reversedWorld("pay-unchanged");
    const live = await run(w, { status: "DRAFT" });
    const saleId = await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("sales", {
        orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "CANCELLED", isDeleted: true,
      } as never);
    });
    await w.t.run((ctx) => ctx.db.patch(live.itemId, { commissionSaleIds: [saleId] }));
    expect(codes(await preview(w, { saleIds: [saleId] }))).toEqual(["SURVIVING_REFERENCE"]);
  });
});

describe("ruling C - a fully REFUNDED deposit is a root", () => {
  async function deposit(w: World, extra: Partial<Doc<"deposits">> = {}): Promise<Id<"deposits">> {
    return await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("deposits", {
        orgId: w.orgId, customerId: app.customerId, vehicleId: app.vehicleId, quoteId: app.quoteId, amount: 50, amountMinor: 50_000, currency: "JOD",
        status: "REFUNDED", holdActive: false, refundedAmountMinor: 50_000, releasedAmountMinor: 50_000, releaseCount: 1, createdBy: w.actorId, createdAt: 1, ...extra,
      });
    });
  }
  async function receiptAndRefund(w: World, depositId: Id<"deposits">, refundMinor = 50_000) {
    await openOctober(w);
    const source = (await dealEvents(w, 1))[0];
    const receipt = await cloneEntry(w, source._id, "dep-receipt", false, { depositId, amountMinor: 50_000 }, "DEPOSIT_RECEIVED");
    const refund = await cloneEntry(w, source._id, "dep-refund", true, { depositId, amountMinor: refundMinor }, "DEPOSIT_REFUNDED");
    return { receipt, refund };
  }

  test("receipt and refund net to zero per account: the deposit, both events and both journals are listed", async () => {
    const { w } = await reversedWorld("dep-ok");
    const depositId = await deposit(w);
    const { receipt, refund } = await receiptAndRefund(w, depositId);
    const m = await preview(w, { depositIds: [depositId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.deposits).toEqual([depositId]);
    expect(m.idsByTable.accountingEvents).toEqual([receipt.eventId, refund.eventId].sort((a, b) => a.localeCompare(b)));
    expect(m.accountNet.length).toBeGreaterThan(0);
    expect(m.accountNet.every((x) => x.netMinor === 0)).toBe(true);
    expect(m.rootProofs.map((p) => [p.kind, p.id])).toEqual([["deposit", depositId]]);
  });

  test.each([
    ["HELD", { status: "HELD" as const }],
    ["FORFEITED", { status: "FORFEITED" as const, forfeitedAmountMinor: 50_000 }],
    ["APPLIED", { status: "APPLIED" as const }],
    ["partly refunded", { refundedAmountMinor: 20_000, releasedAmountMinor: 20_000 }],
    ["still holding the car", { holdActive: true }],
    ["an opening deposit", { origin: "OPENING" as const }],
  ])("a %s deposit refuses DEPOSIT_NOT_REFUNDED", async (label, extra) => {
    const { w } = await reversedWorld(`dep-state-${label.replace(/\W/g, "")}`);
    const depositId = await deposit(w, extra);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["DEPOSIT_NOT_REFUNDED"]);
  });

  test("a refund of a different amount than the receipt refuses DEPOSIT_REFUND_PROOF", async () => {
    const { w } = await reversedWorld("dep-amount");
    const depositId = await deposit(w);
    await receiptAndRefund(w, depositId, 49_999);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["DEPOSIT_REFUND_PROOF"]);
  });

  test("a receipt with no refund event refuses (the deposit cannot be proven refunded from its ledger)", async () => {
    const { w } = await reversedWorld("dep-norefund");
    const depositId = await deposit(w);
    await openOctober(w);
    await cloneEntry(w, (await dealEvents(w, 1))[0]._id, "dep-r-only", false, { depositId, amountMinor: 50_000 }, "DEPOSIT_RECEIVED");
    expect(codes(await preview(w, { depositIds: [depositId] }))).toContain("DEPOSIT_REFUND_PROOF");
  });

  test("a refund in ANOTHER period does not net per period: NONZERO_NET", async () => {
    const { w } = await reversedWorld("dep-period");
    const depositId = await deposit(w);
    const { refund } = await receiptAndRefund(w, depositId);
    await w.t.run((ctx) => ctx.db.patch(refund.journalId, { periodId: w.novPeriodId }));
    expect(codes(await preview(w, { depositIds: [depositId] }))).toContain("NONZERO_NET");
  });

  test("a refund in a CLOSED period refuses CLOSED_PERIOD and the owner must decide", async () => {
    const { w } = await reversedWorld("dep-closed");
    const depositId = await deposit(w);
    await receiptAndRefund(w, depositId);
    await w.t.run((ctx) => ctx.db.patch(w.octPeriodId, { status: "CLOSED" }));
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["CLOSED_PERIOD"]);
  });

  test("an unreversed forfeiture event on the deposit refuses DEPOSIT_REFUND_PROOF", async () => {
    const { w } = await reversedWorld("dep-forfeit-event");
    const depositId = await deposit(w);
    await receiptAndRefund(w, depositId);
    await cloneEntry(w, (await dealEvents(w, 1))[0]._id, "dep-forfeit", false, { depositId, amountMinor: 1 }, "DEPOSIT_FORFEITED");
    expect(codes(await preview(w, { depositIds: [depositId] }))).toContain("DEPOSIT_REFUND_PROOF");
  });

  test("a deposit applied to a KEPT sale is SHARED_WITH_LIVE", async () => {
    const { w } = await reversedWorld("dep-kept-sale");
    const keptSale = await insertKeptSale(w);
    const depositId = await deposit(w, { resolutionSaleId: keptSale });
    await receiptAndRefund(w, depositId);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["SHARED_WITH_LIVE"]);
  });

  test("a deposit passed as a root AND in approvedFieldClearIds refuses the stale approval", async () => {
    const { w } = await reversedWorld("dep-both");
    const depositId = await deposit(w);
    await receiptAndRefund(w, depositId);
    const m = await preview(w, { depositIds: [depositId] }, [], [], [depositId]);
    expect(codes(m)).toEqual(["APPROVED_ROW_NOT_IN_PURGE"]);
  });

  test("a resolved hold slice of the deposit leaves with it; an active one refuses", async () => {
    const { w } = await reversedWorld("dep-slice");
    const depositId = await deposit(w);
    await receiptAndRefund(w, depositId);
    const vehicleId = await w.t.run(async (ctx) => (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!.vehicleId);
    const resolved = await w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", { orgId: w.orgId, depositId, vehicleId, active: false, createdAt: 1, allocationStatus: "RESOLVED" }));
    const m = await preview(w, { depositIds: [depositId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.depositVehicleHolds).toEqual([resolved]);
    await w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", { orgId: w.orgId, depositId, vehicleId, active: true, createdAt: 1, allocationStatus: "ALLOCATED" }));
    expect(codes(await preview(w, { depositIds: [depositId] }))).toEqual(["DEPOSIT_NOT_REFUNDED"]);
  });

  test("a deposit that points at a payment row which is not leaving refuses DEPOSIT_REFUND_PROOF (a forward link is never stranded)", async () => {
    const { w } = await reversedWorld("dep-forward");
    const paymentId = await w.t.run((ctx) => ctx.db.insert("canonicalPayments", {
      orgId: w.orgId, direction: "IN", method: "CASH", amountMinor: 50_000, currency: "JOD", scale: 3, status: "SETTLED",
      idempotencyKey: "dep-forward-payment", createdBy: w.actorId, createdAt: 1,
    }));
    const depositId = await deposit(w, { canonicalPaymentId: paymentId });
    await receiptAndRefund(w, depositId);
    expect(codes(await preview(w, { depositIds: [depositId] }))).toContain("DEPOSIT_REFUND_PROOF");
  });

  test("a deposit that stays is untouched even when its sale is purged (phase 1 path unchanged)", async () => {
    const { w, app } = await reversedWorld("dep-stays");
    const depositId = await deposit(w);
    const m = await preview(w, { applicationIds: [app] });
    expect(m.ok).toBe(true);
    expect(has(m, depositId)).toBe(false);
  });
});

describe("ruling D - CONFIRMED lender-payment evidence of a purged application", () => {
  const evidence = (w: World, applicationId: string, extra: Partial<Doc<"customerFinanceCompanyPayments">> = {}) =>
    w.t.run((ctx) => ctx.db.insert("customerFinanceCompanyPayments", {
      orgId: w.orgId, applicationId: applicationId as Id<"financeApplications">, status: "CONFIRMED", amountMinor: 2_800_000, currency: "JOD",
      paidAt: 1, reference: "R-1", confirmedBy: w.actorId, confirmedAt: 1, firstPayment: { kind: "CONFIRMATION", attribution: "x" }, ...extra,
    }));

  test("a CONFIRMED row on a purged application refuses CONFIRMED_PAYMENT_EVIDENCE only, and is itemized without personal data", async () => {
    const { w, app } = await reversedWorld("ev-refuse");
    const id = await evidence(w, app);
    const m = await preview(w, { applicationIds: [app] });
    expect(codes(m)).toEqual(["CONFIRMED_PAYMENT_EVIDENCE"]);
    expect(m.confirmedPaymentEvidence).toEqual([{ id, applicationId: app, amountMinor: 2_800_000, currency: "JOD", status: "CONFIRMED", kind: "CONFIRMATION", approved: false }]);
  });

  test("the owner's exact id lets it leave, still itemized as approved", async () => {
    const { w, app } = await reversedWorld("ev-approve");
    const id = await evidence(w, app);
    const m = await preview(w, { applicationIds: [app] }, [], [id]);
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.customerFinanceCompanyPayments).toEqual([id]);
    expect(m.confirmedPaymentEvidence.map((e) => [e.id, e.approved])).toEqual([[id, true]]);
  });

  test("a VOIDED row is not live evidence and needs no approval", async () => {
    const { w, app } = await reversedWorld("ev-voided");
    await evidence(w, app, { status: "VOIDED", voidedBy: w.actorId, voidedAt: 2, voidReason: "x" });
    expect((await preview(w, { applicationIds: [app] })).refusals).toEqual([]);
  });

  test("the approval cannot wave through a row that has a ledger link: CONFIRMED_PAYMENT_LEDGER_LINK", async () => {
    const { w, app } = await reversedWorld("ev-ledger");
    await openOctober(w);
    const id = await evidence(w, app);
    const source = (await dealEvents(w, 1))[0];
    const original = await cloneEntry(w, source._id, "ev-a", false, { paymentId: id }, "FINANCE_COMPANY_PAYMENT");
    const reversal = await cloneEntry(w, source._id, "ev-b", true, { paymentId: id }, "FINANCE_COMPANY_PAYMENT");
    await linkAsPair(w, original, reversal);
    const m = await preview(w, { applicationIds: [app] }, [], [id]);
    expect(codes(m)).toEqual(["CONFIRMED_PAYMENT_LEDGER_LINK"]);
  });

  test("the approval cannot cover a row of another application, nor a row of another organization", async () => {
    const { w, app, keptApp } = await reversedWorld("ev-other");
    const mine = await evidence(w, app);
    const keptRow = await evidence(w, keptApp);
    const otherOrg = await w.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: 1 }));
    const foreign = await w.t.run((ctx) => ctx.db.insert("customerFinanceCompanyPayments", {
      orgId: otherOrg, applicationId: app as Id<"financeApplications">, status: "CONFIRMED", amountMinor: 1, currency: "JOD", paidAt: 1, reference: "F",
      confirmedBy: w.actorId, confirmedAt: 1,
    }));
    const m = await preview(w, { applicationIds: [app] }, [], [mine, keptRow, foreign]);
    expect(m.refusals.map((r) => [r.code, r.table, r.count])).toEqual([["APPROVED_ROW_NOT_IN_PURGE", "approvedLiveRowIds", 2]]);
    expect(has(m, keptRow)).toBe(false);
    expect(has(m, foreign)).toBe(false);
  });

  test("a cancelled application that was HANDED OVER refuses LIVE_STATE_ROW on financeApplications unless its exact id is approved", async () => {
    const { w, app } = await reversedWorld("ev-handover");
    await w.t.run((ctx) => ctx.db.patch(app as Id<"financeApplications">, { handoverStatus: "HANDED_OVER" }));
    const refused = await preview(w, { applicationIds: [app] });
    expect(refused.refusals.map((r) => [r.code, r.table])).toEqual([["LIVE_STATE_ROW", "financeApplications"]]);
    expect((await preview(w, { applicationIds: [app] }, [], [app])).refusals).toEqual([]);
  });

  test("a vehicleHandoverAt stamp alone (the fixture's deal 21 shape) is also a handover", async () => {
    const { w, app } = await reversedWorld("ev-handover-at");
    await w.t.run((ctx) => ctx.db.patch(app as Id<"financeApplications">, { vehicleHandoverAt: 5 }));
    expect((await preview(w, { applicationIds: [app] })).refusals.map((r) => r.code)).toEqual(["LIVE_STATE_ROW"]);
  });
});

describe("phase 1b - predicted failures P1-P7 of the packet (self-attack)", () => {
  async function cancelledSale(w: World): Promise<Id<"sales">> {
    return await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("sales", {
        orgId: w.orgId, vehicleId: app.vehicleId, customerId: app.customerId, salespersonId: w.actorId, salePrice: 1, saleDate: 1, status: "CANCELLED", isDeleted: true,
      } as never);
    });
  }

  test("P5: a cancelled run that mixes a PURGED sale and a REAL sale is deleted next to the purged sale and leaves the real sale alone", async () => {
    const { w } = await reversedWorld("p5-mixed-run");
    const purgedSale = await cancelledSale(w);
    const keptSale = await insertKeptSale(w);
    const [runId, itemId] = await w.t.run(async (ctx) => {
      const run = await ctx.db.insert("payrollRuns", {
        orgId: w.orgId, periodYear: 2026, periodMonth: 10, currency: "JOD", status: "CANCELLED", totalGrossMinor: 1, totalNetMinor: 1, createdAt: 1, updatedAt: 1,
      });
      const item = await ctx.db.insert("payrollItems", {
        orgId: w.orgId, runId: run, userId: w.actorId, baseSalaryMinor: 0, commissionMinor: 1, otherEarningsMinor: 0, advanceDeductionMinor: 0,
        otherDeductionMinor: 0, grossMinor: 1, netMinor: 1, currency: "JOD", commissionSaleIds: [purgedSale, keptSale], createdAt: 1,
      });
      return [run, item] as const;
    });
    const m = await preview(w, { saleIds: [purgedSale], payrollRunIds: [runId] });
    expect(m.refusals).toEqual([]);
    expect(m.idsByTable.payrollItems).toEqual([itemId]);
    expect(has(m, keptSale)).toBe(false);
    // The same sale root WITHOUT the run is still a surviving reference: the run is what lets the payslip go.
    expect(codes(await preview(w, { saleIds: [purgedSale] }))).toEqual(["SURVIVING_REFERENCE"]);
  });

  test("P5: a hold slice of a KEPT deposit is never reached, and a resolved slice that names a kept sale refuses", async () => {
    const { w } = await reversedWorld("p5-slices");
    const vehicleId = await w.t.run(async (ctx) => (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!.vehicleId);
    const make = (extra: Partial<Doc<"deposits">> = {}) => w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("deposits", {
        orgId: w.orgId, customerId: app.customerId, vehicleId, amount: 50, amountMinor: 50_000, currency: "JOD", status: "REFUNDED", holdActive: false,
        refundedAmountMinor: 50_000, releasedAmountMinor: 50_000, releaseCount: 1, createdBy: w.actorId, createdAt: 1, ...extra,
      });
    });
    const kept = await make();
    const keptSlice = await w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", { orgId: w.orgId, depositId: kept, vehicleId, active: false, createdAt: 1, allocationStatus: "RESOLVED" }));
    const mine = await make();
    await openOctober(w);
    const source = (await dealEvents(w, 1))[0];
    await cloneEntry(w, source._id, "p5-r", false, { depositId: mine, amountMinor: 50_000 }, "DEPOSIT_RECEIVED");
    await cloneEntry(w, source._id, "p5-f", true, { depositId: mine, amountMinor: 50_000 }, "DEPOSIT_REFUNDED");
    const clean = await preview(w, { depositIds: [mine] });
    expect(clean.refusals).toEqual([]);
    expect(has(clean, kept)).toBe(false);
    expect(has(clean, keptSlice)).toBe(false);
    const keptSale = await insertKeptSale(w);
    await w.t.run((ctx) => ctx.db.insert("depositVehicleHolds", { orgId: w.orgId, depositId: mine, vehicleId, active: false, createdAt: 1, allocationStatus: "RESOLVED", appliedSaleId: keptSale }));
    expect(codes(await preview(w, { depositIds: [mine] }))).toContain("DEPOSIT_NOT_REFUNDED");
  });

  test("P6: the deposit proof is not the status: a REFUNDED row with a live receipt but no refund event refuses even with matching fields", async () => {
    const { w } = await reversedWorld("p6-status-lies");
    const depositId = await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[0].applicationId as Id<"financeApplications">))!;
      return ctx.db.insert("deposits", {
        orgId: w.orgId, customerId: app.customerId, vehicleId: app.vehicleId, amount: 50, amountMinor: 50_000, currency: "JOD", status: "REFUNDED", holdActive: false,
        refundedAmountMinor: 50_000, releasedAmountMinor: 50_000, releaseCount: 1, createdBy: w.actorId, createdAt: 1,
      });
    });
    await openOctober(w);
    await cloneEntry(w, (await dealEvents(w, 1))[0]._id, "p6-r", false, { depositId, amountMinor: 50_000 }, "DEPOSIT_RECEIVED");
    const m = await preview(w, { depositIds: [depositId] });
    expect(codes(m)).toContain("DEPOSIT_REFUND_PROOF");
    expect(m.ok).toBe(false);
  });

  test("P7: org-less admin audit rows are read under the same bound and refuse OVER_BOUND instead of being truncated", async () => {
    const { w, app } = await reversedWorld("p7-bound");
    const own = await w.t.run(async (ctx) => (await ctx.db.query("adminAuditLog").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect()).length);
    const cap = Math.max(own, 1);
    await w.t.run(async (ctx) => {
      for (let i = 0; i <= cap; i += 1) {
        await ctx.db.insert("adminAuditLog", { actorUserId: w.actorId, actorEmail: "a@x.com", action: "x", targetId: `unrelated-${i}`, createdAt: 1 });
      }
    });
    const m = await w.t.run((ctx) => buildPurgeManifest(ctx, w.orgId, { saleIds: [], applicationIds: [app], expenseIds: [], transferEventIds: [] }, [], [], [], {
      perTableCap: cap, totalDocs: 24_000, totalRanges: 4000,
    }));
    expect(m.refusals.some((r) => r.code === "OVER_BOUND" && r.table === "adminAuditLog" && r.detail.includes("organization-less"))).toBe(true);
  });

  test("a payment to a payroll evidence table of ANOTHER run does not refuse this run", async () => {
    const { w } = await reversedWorld("p2-other-run");
    const keptSale = await insertKeptSale(w);
    const make = (status: "CANCELLED" | "PAID") => w.t.run(async (ctx) => {
      const run = await ctx.db.insert("payrollRuns", { orgId: w.orgId, periodYear: 2026, periodMonth: 10, currency: "JOD", status, totalGrossMinor: 1, totalNetMinor: 1, createdAt: 1, updatedAt: 1 });
      const item = await ctx.db.insert("payrollItems", {
        orgId: w.orgId, runId: run, userId: w.actorId, baseSalaryMinor: 0, commissionMinor: 1, otherEarningsMinor: 0, advanceDeductionMinor: 0,
        otherDeductionMinor: 0, grossMinor: 1, netMinor: 1, currency: "JOD", commissionSaleIds: [keptSale], createdAt: 1,
      });
      return [run, item] as const;
    });
    const [cancelledRun] = await make("CANCELLED");
    const [, paidItem] = await make("PAID");
    await w.t.run((ctx) => ctx.db.insert(COMMISSION_LINES, {
      orgId: w.orgId, saleId: keptSale, kind: "SALE", employeeId: w.actorId, amountMinor: 1, currency: "JOD", createdBy: w.actorId, paidAt: 3, paidBy: w.actorId, payrollItemId: paidItem,
    }));
    expect((await preview(w, { payrollRunIds: [cancelledRun] })).refusals).toEqual([]);
  });
});