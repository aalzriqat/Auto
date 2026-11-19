import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { denominationOf } from "./utils/money";
import { assertOrgEconomicallyActive } from "./utils/orgLifecycle";
import { orgResetState } from "./utils/orgResetGeneration";
import { openingChangeBoundary } from "./utils/openingMaintenanceErrors";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";
import {
  OPENING_PREPAID_ADJUSTMENT_SOURCE,
  isOpeningOffset,
  openingPrepaidDeltaLines,
  openingPrepaidAdjustments,
  type OpeningPrepaid,
  type OpeningPrepaidBasisChange,
} from "./utils/openingPrepaidAdjustment";
import { openingJournalLines } from "./utils/openingVoidProof";
import { utcDay } from "./utils/ledgerCalendar";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { auditLog } from "./utils/financialAuditWriter";

function refuseBasisChange(): never {
  throw new ConvexError({
    code: "OPENING_PREPAID_CHANGE_UNAVAILABLE",
    message: "This opening prepaid amount cannot be changed. Ask finance to verify the original balance and later activity.",
  });
}

async function assertNoRecognition(ctx: QueryCtx, schedule: OpeningPrepaid) {
  const id = schedule._id;
  const orgId = schedule.orgId;
  if (schedule.status !== "ACTIVE" || schedule.recognizedMinor !== 0 ||
      (schedule.monthsRecognized ?? 0) !== 0 || schedule.lastRecognizedYearMonth !== undefined) refuseBasisChange();
  const prefix = `prepaid_amort_${id}_`;
  const end = `${prefix}\uffff`;
  const activity = await Promise.all([
    ctx.db.query("accountingEvents").withIndex("by_org_idempotency", q =>
      q.eq("orgId", orgId).gte("idempotencyKey", prefix).lt("idempotencyKey", end)).first(),
    ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", q =>
      q.eq("orgId", orgId).gte("idempotencyKey", prefix).lt("idempotencyKey", end)).first(),
    ctx.db.query("prepaidAmortizationFailures").withIndex("by_schedule", q => q.eq("scheduleId", id)).first(),
    ctx.db.query("prepaidScheduleCorrections").withIndex("by_schedule", q => q.eq("scheduleId", id)).first(),
    ctx.db.query("prepaidCorrectionRequests").withIndex("by_schedule", q => q.eq("scheduleId", id)).first(),
  ]);
  if (activity.some(Boolean)) refuseBasisChange();
}

async function inspectBasis(
  ctx: QueryCtx,
  schedule: OpeningPrepaid,
  offset: Doc<"chartOfAccounts">,
  reversing = false,
) {
  const orgId = schedule.orgId;
  await assertOrgEconomicallyActive(ctx, orgId);
  const org = await ctx.db.get(orgId);
  if (orgResetState(org).inProgress || org?.openingCleanupPayableScan || org?.openingCleanupReferenceScan ||
      (!reversing && schedule.openingBasisChange?.approval) || !isOpeningOffset(offset, schedule)) refuseBasisChange();
  await assertNoRecognition(ctx, schedule);

  const source = await resolvePrepaidScheduleSource(ctx, orgId, schedule._id);
  if (source.kind !== "OPENING" || source.accountId === offset._id) refuseBasisChange();
  const earlierAdjustment = reversing ? source.adjustmentJournalId : null;
  if (reversing && !earlierAdjustment) refuseBasisChange();
  const [draft, original, adjustments] = await Promise.all([
    ctx.db.get(source.draftId), ctx.db.get(source.originalJournalId), openingPrepaidAdjustments(ctx, schedule),
  ]);
  if (adjustments.length !== (earlierAdjustment ? 1 : 0) || (earlierAdjustment && adjustments[0]._id !== earlierAdjustment)) {
    refuseBasisChange();
  }
  if (!draft || draft.voidRequest || !original?.periodId || original.reversedByJournalEntryId) refuseBasisChange();
  const period = await ctx.db.get(original.periodId);
  if (!period || period.orgId !== orgId || period.status !== "OPEN" ||
      utcDay(period.startDate) > utcDay(draft.asOfDate) || utcDay(period.endDate) < utcDay(draft.asOfDate)) refuseBasisChange();
  const denomination = denominationOf(schedule.currency);
  const lines = await openingJournalLines(ctx, draft, original);
  if (!denomination || !lines || !lines.some(line => line.accountId === offset._id && line.creditMinor > 0)) refuseBasisChange();
  const start = Math.min(...lines.map(line => line._creationTime));
  for (const accountId of [source.accountId, offset._id]) {
    const count = lines.filter(line => line.accountId === accountId).length + Number(!!earlierAdjustment);
    const seen = await ctx.db.query("journalLines").withIndex("by_org_account", q =>
      q.eq("orgId", orgId).eq("accountId", accountId).gte("_creationTime", start)).take(count + 1);
    if (seen.length !== count || seen.some(line => line.journalEntryId !== original._id &&
        line.journalEntryId !== earlierAdjustment)) refuseBasisChange();
  }
  return { source, periodId: period._id, asOfDate: draft.asOfDate, currency: denomination.code, scale: denomination.scale };
}

export const requestBasisChange = mutation({
  args: {
    orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules"),
    offsetAccountId: v.id("chartOfAccounts"), correctedTotalMinor: v.number(), reason: v.string(),
  },
  returns: v.object({ version: v.number() }),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_COST_PRICE]);
    const schedule = await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    const offset = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", args.offsetAccountId);
    const reason = args.reason.trim();
    if (membership.impersonationGrantId || schedule.kind !== "OPENING" ||
        !Number.isSafeInteger(args.correctedTotalMinor) || args.correctedTotalMinor <= 0 ||
        args.correctedTotalMinor === schedule.totalMinor || !reason || reason.length > 500) refuseBasisChange();
    const previous = schedule.openingBasisChange;
    if (previous && previous.requestedBy !== user._id) refuseBasisChange();
    const { source } = await inspectBasis(ctx, schedule, offset);
    if (previous && previous.originalJournalId === source.originalJournalId && previous.offsetAccountId === offset._id &&
        previous.correctedTotalMinor === args.correctedTotalMinor && previous.reason === reason) {
      return { version: previous.version };
    }
    const version = (previous?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version) || version < 1) refuseBasisChange();
    await ctx.db.patch(schedule._id, { openingBasisChange: {
      version, originalJournalId: source.originalJournalId, assetAccountId: source.accountId, offsetAccountId: offset._id,
      originalTotalMinor: source.originalTotalMinor, correctedTotalMinor: args.correctedTotalMinor, requestedBy: user._id, reason,
    } });
    await auditLog(ctx, { orgId: args.orgId, actorId: user._id, actionType: "REQUEST_OPENING_PREPAID_BASIS_CHANGE",
      resourceType: "prepaidExpenseSchedules", resourceId: String(schedule._id),
      description: "Requested independent review of an opening prepaid basis change.", after: { version } });
    return { version };
  }),
});

async function postBasisChange(
  ctx: MutationCtx,
  schedule: OpeningPrepaid,
  change: OpeningPrepaidBasisChange,
  plan: Awaited<ReturnType<typeof inspectBasis>>,
  actorId: Id<"users">,
  reversing?: { journalId: Id<"journalEntries">; reason: string },
) {
  const orgId = schedule.orgId;
  const now = Date.now();
  const journalId = await ctx.db.insert("journalEntries", {
    orgId, periodId: plan.periodId, accountingDate: plan.asOfDate,
    journalNumber: `OB-PREPAID${reversing ? "-REV" : ""}-${String(schedule._id).slice(-10).toUpperCase()}`,
    sourceType: OPENING_PREPAID_ADJUSTMENT_SOURCE, sourceId: String(schedule._id),
    category: reversing ? "REVERSAL" : "ADJUSTMENT", reversalOfJournalEntryId: reversing?.journalId,
    memo: reversing?.reason ?? change.reason, status: "POSTED", currency: plan.currency, postedBy: actorId, postedAt: now, createdAt: now,
  });
  for (const line of openingPrepaidDeltaLines(change, reversing !== undefined)) {
    await ctx.db.insert("journalLines", { ...line, orgId, journalEntryId: journalId, currency: plan.currency,
      scale: plan.scale, accountingDate: plan.asOfDate });
    await incrementAccountSnapshot(ctx, { orgId, accountId: line.accountId, periodId: plan.periodId,
      currency: plan.currency, debitMinor: line.debitMinor, creditMinor: line.creditMinor });
  }
  return journalId;
}

export const approveBasisChange = mutation({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules"), version: v.number() },
  returns: v.object({ journalId: v.id("journalEntries") }),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_COST_PRICE]);
    const schedule = await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    if (schedule.kind !== "OPENING" || membership.impersonationGrantId) refuseBasisChange();
    const change = schedule.openingBasisChange;
    if (!change || change.version !== args.version) refuseBasisChange();
    if (change.requestedBy === user._id) {
      throw new ConvexError({ code: "OPENING_PREPAID_SECOND_PERSON", message: "A different finance user must approve the prepaid opening change." });
    }
    if (change.approval) {
      const source = await resolvePrepaidScheduleSource(ctx, args.orgId, schedule._id);
      if (source.kind !== "OPENING" || source.adjustmentJournalId !== change.approval.journalId) refuseBasisChange();
      return { journalId: source.adjustmentJournalId };
    }
    const offset = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", change.offsetAccountId);
    const plan = await inspectBasis(ctx, schedule, offset);
    if (plan.source.originalJournalId !== change.originalJournalId || plan.source.accountId !== change.assetAccountId ||
        plan.source.originalTotalMinor !== change.originalTotalMinor || !Number.isSafeInteger(change.correctedTotalMinor) ||
        change.correctedTotalMinor <= 0 || change.correctedTotalMinor === change.originalTotalMinor) refuseBasisChange();
    const journalId = await postBasisChange(ctx, schedule, change, plan, user._id);
    await ctx.db.patch(schedule._id, { totalMinor: change.correctedTotalMinor, openingBasisChange: {
      ...change, approval: { by: user._id, journalId },
    } });
    await auditLog(ctx, { orgId: args.orgId, actorId: user._id, actionType: "APPROVE_OPENING_PREPAID_BASIS_CHANGE",
      resourceType: "prepaidExpenseSchedules", resourceId: String(schedule._id),
      description: "Approved an opening prepaid basis change.", after: { version: args.version, journalId } });
    return { journalId };
  }),
});

export const requestBasisReversal = mutation({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules"), version: v.number(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_COST_PRICE]);
    const schedule = await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    if (schedule.kind !== "OPENING" || membership.impersonationGrantId) refuseBasisChange();
    const change = schedule.openingBasisChange;
    const reason = args.reason.trim();
    if (!change?.approval || args.version !== change.version || !reason || reason.length > 500) refuseBasisChange();
    if (change.reversal) {
      if (change.reversal.requestedBy === user._id && change.reversal.reason === reason) return null;
      refuseBasisChange();
    }
    const offset = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", change.offsetAccountId);
    await inspectBasis(ctx, schedule, offset, true);
    await ctx.db.patch(schedule._id, { openingBasisChange: { ...change, reversal: { requestedBy: user._id, reason } } });
    await auditLog(ctx, { orgId: args.orgId, actorId: user._id, actionType: "REQUEST_OPENING_PREPAID_BASIS_REVERSAL",
      resourceType: "prepaidExpenseSchedules", resourceId: String(schedule._id),
      description: "Requested independent review to reverse an opening prepaid adjustment.", after: { version: args.version } });
    return null;
  }),
});

export const approveBasisReversal = mutation({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules"), version: v.number() },
  returns: v.object({ journalId: v.id("journalEntries") }),
  handler: async (ctx, args) => openingChangeBoundary(async () => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_COST_PRICE]);
    const schedule = await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    if (schedule.kind !== "OPENING" || membership.impersonationGrantId) refuseBasisChange();
    const change = schedule.openingBasisChange;
    const reversal = change?.reversal;
    if (!change?.approval || args.version !== change.version || !reversal) refuseBasisChange();
    if (reversal.requestedBy === user._id) throw new ConvexError({
      code: "OPENING_PREPAID_SECOND_PERSON", message: "A different finance user must approve the prepaid opening reversal.",
    });
    if (reversal.approval) {
      const source = await resolvePrepaidScheduleSource(ctx, args.orgId, schedule._id);
      if (source.kind !== "OPENING" || source.adjustmentJournalId !== change.approval.journalId) refuseBasisChange();
      return { journalId: reversal.approval.journalId };
    }
    const offset = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", change.offsetAccountId);
    const plan = await inspectBasis(ctx, schedule, offset, true);
    const journalId = await postBasisChange(ctx, schedule, change, plan, user._id, {
      journalId: change.approval.journalId, reason: reversal.reason,
    });
    await ctx.db.patch(change.approval.journalId, { status: "REVERSED", reversedByJournalEntryId: journalId });
    await ctx.db.patch(schedule._id, { totalMinor: change.originalTotalMinor, openingBasisChange: {
      ...change, reversal: { ...reversal, approval: { by: user._id, journalId } },
    } });
    await auditLog(ctx, { orgId: args.orgId, actorId: user._id, actionType: "APPROVE_OPENING_PREPAID_BASIS_REVERSAL",
      resourceType: "prepaidExpenseSchedules", resourceId: String(schedule._id),
      description: "Reversed an opening prepaid adjustment and restored the original basis.", after: { version: args.version, journalId } });
    return { journalId };
  }),
});
