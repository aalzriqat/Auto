// SCRUM-987 slice 1 — the per-target proof and the read-only planner. Split from
// scrum987CancelledDealReversal.ts (file-size guardrail); no logic changed.
import type { Doc, Id } from "../_generated/dataModel";
import { getOpenPeriodForDate } from "./postingPeriod";
import { assertNotCustodian, custodyEntriesFor } from "./financeDealCosts/custodyRecords";
import { loadActiveFees } from "./settlementDeductions";
import { SCRUM987_REASON, type CorrectionTarget } from "./scrum987Targets";
import {
  eventsFor,
  forwardFeeShape,
  forwardIssueShape,
  journalShape,
  pendingFor,
  refuse,
  requireActor,
  reversedProblems,
  type AppliedInspection,
  type Ctx,
  type OriginalInspection,
  type TargetInspection,
} from "./scrum987LedgerProof";
export type CorrectionPlan =
  | { kind: "ALREADY_APPLIED"; targets: AppliedInspection[] }
  | {
      kind: "READY";
      periodId: Id<"accountingPeriods">;
      orgId: Id<"organizations">;
      actor: Doc<"users">;
      targets: OriginalInspection[];
    };
// ─── Per-target proof ────────────────────────────────────────────────────────

export async function inspectTarget(
  ctx: Ctx,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  target: CorrectionTarget,
  expectedPeriodId: Id<"accountingPeriods"> | undefined,
  reason: string = SCRUM987_REASON
): Promise<TargetInspection> {
  const fail = (problems: string[]): TargetInspection => ({ label: target.label, target, state: "INVALID", problems, appliedProblems: [] });
  const applicationId = ctx.db.normalizeId("financeApplications", target.applicationId);
  const feeId = ctx.db.normalizeId("financeDealFees", target.feeId);
  const custodyId = ctx.db.normalizeId("financeDealCustody", target.custodyId);
  const entryId = ctx.db.normalizeId("financeDealCustodyEntries", target.entryId);
  if (!applicationId || !feeId || !custodyId || !entryId) {
    return fail(["an allow-listed id is not a well-formed id of its table (typo?)"]);
  }
  const [app, fee, custody, entry] = await Promise.all([
    ctx.db.get(applicationId), ctx.db.get(feeId), ctx.db.get(custodyId), ctx.db.get(entryId),
  ]);
  if (!app || app.orgId !== orgId) return fail(["the application is missing or belongs to another organization"]);
  if (!fee || fee.orgId !== orgId) return fail(["the fee is missing or belongs to another organization"]);
  if (!custody || custody.orgId !== orgId) return fail(["the custody record is missing or belongs to another organization"]);
  if (!entry || entry.orgId !== orgId) return fail(["the custody entry is missing or belongs to another organization"]);

  const amount = target.amountMinor;
  const [entries, liveFees, feeEvents, entryEvents, custodyEvents, feePending, entryPending, custodyPending] = await Promise.all([
    custodyEntriesFor(ctx, custodyId, "proving the SCRUM-987 correction"),
    loadActiveFees(ctx, applicationId),
    eventsFor(ctx, orgId, "financeDealFees", feeId),
    eventsFor(ctx, orgId, "financeDealCustodyEntries", entryId),
    eventsFor(ctx, orgId, "financeDealCustody", custodyId),
    pendingFor(ctx, orgId, "financeDealFees", feeId),
    pendingFor(ctx, orgId, "financeDealCustodyEntries", entryId),
    pendingFor(ctx, orgId, "financeDealCustody", custodyId),
  ]);

  // Facts true BEFORE and AFTER the correction.
  const common: string[] = [];
  if (app.status !== "CANCELLED") common.push(`application status is ${app.status}, not CANCELLED`);
  if (fee.applicationId !== applicationId) common.push("fee is on another deal");
  if (custody.applicationId !== applicationId) common.push("custody is on another deal");
  if (entry.custodyId !== custodyId) common.push("entry is on another custody record");
  if (fee.custodyId !== custodyId) common.push("fee.custodyId is not the custody record");
  if (fee.actualAmountMinor !== amount) common.push(`fee actual is ${String(fee.actualAmountMinor)}, expected ${amount}`);
  if (fee.deductedFromSettlement) common.push("fee is deducted from settlement");
  if (fee.directPayment !== undefined) common.push("fee carries a direct payment");
  if (entry.kind !== "ISSUED" || entry.amountMinor !== amount) common.push(`entry is ${entry.kind} ${entry.amountMinor}, expected ISSUED ${amount}`);
  if (custody.ledgerPosting !== "CANONICAL") common.push("custody is not CANONICAL");
  if (custody.status !== "RECONCILED") common.push(`custody status is ${custody.status}, not RECONCILED`);
  if (custody.returnedMinor !== 0 || custody.reimbursedMinor !== 0) common.push("custody has returned/reimbursed money");
  if ((custody.payableTargetMinor ?? 0) !== 0 || (custody.payableReclassIssued ?? []).length > 0) common.push("custody carries a payable reclassification");
  if (custody.writeOffPosted !== undefined) common.push("custody carries a write-off");
  try {
    assertNotCustodian(custody, actorId, "The SCRUM-987 correction");
  } catch {
    common.push("the actor is the custodian of this record");
  }
  if (target.finalized) {
    if (app.finalizedSaleId === undefined) common.push("deal was expected to be finalized");
    else {
      const sale = await ctx.db.get(app.finalizedSaleId);
      if (!sale || sale.orgId !== orgId || sale.status !== "CANCELLED") common.push("the finalized sale is not CANCELLED");
    }
    const active = await ctx.db
      .query("dealUnwinds")
      .withIndex("by_org_application_status", (q) => q.eq("orgId", orgId).eq("applicationId", applicationId).eq("status", "ACTIVE"))
      .take(1);
    if (active.length > 0) common.push("an ACTIVE unwind exists for this deal");
  } else if (app.finalizedSaleId !== undefined) common.push("deal was not expected to be finalized");
  // The non-terminal outbox rows would post or reverse behind our back.
  for (const row of [...feePending, ...entryPending, ...custodyPending]) {
    if (row.status !== "POSTED") common.push(`outbox row ${row._id} (${row.kind}) is ${row.status}`);
  }
  if (custodyEvents.length > 0) common.push(`custody record carries accounting events (${custodyEvents.map((e) => e.eventType).join(", ")})`);

  // ORIGINAL: nothing done yet.
  const original = [...common];
  if (fee.voidedAt !== undefined) original.push("fee is already voided");
  const posted = fee.custodyPosted;
  if (posted === undefined || posted.custodyId !== custodyId || posted.amountMinor !== amount || !Number.isSafeInteger(posted.version)) {
    original.push("fee.custodyPosted does not match the custody/amount");
  }
  if (custody.issuedMinor !== amount) original.push(`custody issued is ${custody.issuedMinor}, expected ${amount}`);
  if (entries.length !== 1 || entries[0]._id !== entryId) original.push(`custody log has ${entries.length} entries, expected exactly the ISSUED entry`);
  const liveOnCustody = liveFees.filter((f) => f.custodyId === custodyId || f.custodyPosted?.custodyId === custodyId);
  if (liveOnCustody.length !== 1 || liveOnCustody[0]._id !== feeId) original.push("custody does not have exactly one live fee (this one)");
  if (posted !== undefined) {
    const originalFee = feeEvents.filter((e) => e.eventType === "CUSTODY_FEE_PAID");
    if (feeEvents.length !== 1 || originalFee.length !== 1 || originalFee[0].status !== "POSTED" || originalFee[0].eventVersion !== posted.version) {
      original.push(`fee source events are ${feeEvents.map((e) => `${e.eventType}/v${e.eventVersion}/${e.status}`).join(", ") || "none"}, expected one POSTED CUSTODY_FEE_PAID v${posted.version}`);
    } else {
      const shape = await journalShape(ctx, orgId, originalFee[0].journalEntryId);
      if (JSON.stringify(shape) !== JSON.stringify(forwardFeeShape(amount))) original.push(`fee journal is ${JSON.stringify(shape)}`);
    }
  }
  if (entryEvents.length !== 1 || entryEvents[0].eventType !== "CUSTODY_CASH_ISSUED" || entryEvents[0].status !== "POSTED") {
    original.push(`entry source events are ${entryEvents.map((e) => `${e.eventType}/${e.status}`).join(", ") || "none"}, expected one POSTED CUSTODY_CASH_ISSUED`);
  } else {
    const shape = await journalShape(ctx, orgId, entryEvents[0].journalEntryId);
    if (JSON.stringify(shape) !== JSON.stringify(forwardIssueShape(amount))) original.push(`issue journal is ${JSON.stringify(shape)}`);
  }

  const ids = { applicationId, feeId, custodyId, entryId };
  if (original.length === 0) return { label: target.label, target, state: "ORIGINAL", problems: [], appliedProblems: [], ids };

  // APPLIED: everything done, proven on the rows AND the ledger.
  const applied = [...common];
  if (fee.voidedAt === undefined) applied.push("fee is not voided");
  if (!(fee.voidReason ?? "").includes(reason)) applied.push("fee void reason does not carry the ruling");
  if (fee.custodyPosted !== undefined) applied.push("fee still carries custodyPosted");
  if (custody.issuedMinor !== 0) applied.push(`custody issued is ${custody.issuedMinor}, expected 0 net`);
  const reversals = entries.filter((e) => e.kind === "REVERSAL");
  if (entries.length !== 2 || reversals.length !== 1 || reversals[0].reversesEntryId !== entryId || reversals[0].amountMinor !== amount ||
      !(reversals[0].note ?? "").includes(reason)) {
    applied.push("custody log is not exactly [ISSUED, its REVERSAL carrying the ruling]");
  }
  applied.push(...(await reversedProblems(ctx, orgId, feeEvents, "CUSTODY_FEE_PAID", forwardFeeShape(amount), "fee posting", expectedPeriodId)));
  applied.push(...(await reversedProblems(ctx, orgId, entryEvents, "CUSTODY_CASH_ISSUED", forwardIssueShape(amount), "custody issuance", expectedPeriodId)));
  if (applied.length === 0) return { label: target.label, target, state: "APPLIED", problems: [], appliedProblems: [], ids };
  return { label: target.label, target, state: "INVALID", problems: original, appliedProblems: applied, ids };
}

// ─── Planner (reads only) ────────────────────────────────────────────────────

export async function planCorrection(
  ctx: Ctx,
  args: {
    orgId: string;
    actorId: Id<"users">;
    targets: ReadonlyArray<CorrectionTarget>;
    now: number;
    expectedUtcMonth: string;
    /** The ruling the corrected rows must carry; defaults to the slice 1 ruling. */
    reason?: string;
  }
): Promise<CorrectionPlan> {
  const orgId = ctx.db.normalizeId("organizations", args.orgId);
  if (orgId === null) return refuse("SCRUM-987: the allow-listed organization id is not a well-formed organization id.");
  const org = await ctx.db.get(orgId);
  if (org === null) return refuse("SCRUM-987: the allow-listed organization does not exist in this deployment.");
  const { user: actor } = await requireActor(ctx, org, args.actorId);

  const targets: TargetInspection[] = [];
  for (const target of args.targets) targets.push(await inspectTarget(ctx, orgId, args.actorId, target, undefined, args.reason));

  const invalid = targets.filter((t) => t.state === "INVALID");
  const original = targets.filter((t): t is OriginalInspection => t.state === "ORIGINAL");
  const applied = targets.filter((t): t is AppliedInspection => t.state === "APPLIED");
  if (invalid.length > 0 || (original.length > 0 && applied.length > 0)) {
    return refuse("SCRUM-987: the targets are not all in the expected original state, or the correction is partially applied. Nothing was changed.", targets);
  }
  if (original.length === 0) return { kind: "ALREADY_APPLIED", targets: applied };

  if (new Date(args.now).toISOString().slice(0, 7) !== args.expectedUtcMonth) {
    return refuse(`SCRUM-987: today is not in ${args.expectedUtcMonth}; the correction is dated into that open period only. Nothing was changed.`);
  }
  const period = await getOpenPeriodForDate(ctx, orgId, args.now);
  if (period === null) return refuse("SCRUM-987: no OPEN accounting period covers today. A reversal would be deferred, not posted. Nothing was changed.");
  return { kind: "READY", periodId: period._id, orgId, actor, targets: original };
}
