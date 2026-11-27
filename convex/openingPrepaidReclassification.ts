import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { postAccountingEvent } from "./accounting/postingEngine";
import {
  beneficiariesAreActiveMembers, evaluatePrepaidReclass, PREPAID_RECLASS_EVENT, PREPAID_RECLASS_SOURCE, PREPAID_RECLASS_VERSION,
  prepaidReclassKey, RECLASS_REASON_MAX, scheduleReclassRows, type ReclassLineInput, type ReclassPlan, refusePrepaidReclass, requirePeriodOpenToday, requireRecognitionInSamePeriod, validateReclassLines,
} from "./accounting/prepaidReclassification";
import { auditLog } from "./utils/financialAuditWriter";
import { AppErrorCode } from "./utils/errors";
import { isSystemOwnerRole, PERMISSIONS, type Permission } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

/**
 * SCRUM-961: request, approve and dismiss moving employee advances out of an opening prepaid schedule, plus the readers
 * the screen needs. Payroll-restricted: every entry point needs finance AND payroll management, because the request
 * names people and their amounts. A caught failure would still COMMIT in Convex, so every refusal throws uncaught and
 * the boundary below only translates unexpected errors.
 */
const lineValidator = v.object({ userId: v.id("users"), amountMinor: v.number() });
// `name` is null when the person cannot be resolved to a member of this organization; the screen words that case.
const namedLineValidator = v.object({ userId: v.id("users"), name: v.union(v.string(), v.null()), amountMinor: v.number() });
const personValidator = v.object({ userId: v.id("users"), name: v.union(v.string(), v.null()) });
const figuresFields = {
  trueUpMinor: v.number(), newTotalMinor: v.number(), newRecognizedMinor: v.number(),
  remainingMonths: v.number(), regularMonthlyMinor: v.number(), finalMonthlyMinor: v.number(),
};
const figuresValidator = v.union(v.object({ ok: v.literal(true), ...figuresFields }), v.object({ ok: v.literal(false), code: v.string() }));
const statusValidator = v.object({
  eligible: v.boolean(),
  blockedReason: v.union(v.string(), v.null()),
  reclassifiedMinor: v.union(v.number(), v.null()),
  pending: v.union(v.null(), v.object({
    reclassificationId: v.id("openingPrepaidReclassifications"), requestedByMe: v.boolean(), requestedBy: personValidator, requestedAt: v.number(),
    totalMinor: v.number(), trueUpMinor: v.union(v.number(), v.null()), lines: v.array(namedLineValidator), reason: v.string(), figures: figuresValidator,
  })),
  approved: v.union(v.null(), v.object({
    reclassificationId: v.id("openingPrepaidReclassifications"), totalMinor: v.number(), trueUpMinor: v.number(),
    advanceIds: v.array(v.id("employeeAdvances")), approvedAt: v.number(), approvedBy: personValidator, eventId: v.id("accountingEvents"),
    journalEntryId: v.id("journalEntries"), journalNumber: v.union(v.string(), v.null()), lines: v.array(namedLineValidator), reason: v.string(),
  })),
});
const previewValidator = v.union(v.object({ ok: v.literal(true), ...figuresFields }), v.object({ ok: v.literal(false), code: v.string() }));
export type ReclassStatus = Infer<typeof statusValidator>;
export type ReclassPreview = Infer<typeof previewValidator>;

/** The advances list's display rule (name, else email), limited to people who belong to this organization. */
async function nameInOrg(ctx: QueryCtx, orgId: Id<"organizations">, userId: Id<"users">): Promise<string | null> {
  const membership = await ctx.db.query("memberships").withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId)).unique();
  if (!membership) return null;
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? null;
}

async function namedLines(ctx: QueryCtx, orgId: Id<"organizations">, lines: Doc<"openingPrepaidReclassifications">["lines"]) {
  return Promise.all(lines.map(async (line) => ({ userId: line.userId, name: await nameInOrg(ctx, orgId, line.userId), amountMinor: line.amountMinor })));
}

function planFigures(plan: ReclassPlan) {
  return { trueUpMinor: plan.trueUpMinor, newTotalMinor: plan.newTotalMinor, newRecognizedMinor: plan.newRecognizedMinor,
    remainingMonths: plan.remainingMonths, regularMonthlyMinor: plan.regularMonthlyMinor, finalMonthlyMinor: plan.finalMonthlyMinor };
}

function sameRequest(row: Doc<"openingPrepaidReclassifications">, requester: Id<"users">, lines: ReclassLineInput[], reason: string): boolean {
  const key = (items: ReclassLineInput[]) => items.map((line) => `${line.userId}:${line.amountMinor}`).sort().join("|");
  return row.requestedBy === requester && row.reason === reason && key(row.lines) === key(lines);
}
const RESTRICTED = { eligible: false, blockedReason: AppErrorCode.PREPAID_RECLASS_AUTHORITY, reclassifiedMinor: null, pending: null, approved: null };

function holds(role: Doc<"roles">, permission: Permission): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(permission);
}

/** Payroll management on top of the finance guard each entry point states itself (the request names people and their amounts). */
function requirePayrollAuthority(auth: { role: Doc<"roles"> }): void {
  if (!holds(auth.role, PERMISSIONS.MANAGE_PAYROLL)) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_AUTHORITY);
}

/** Domain refusals stay coded; anything else is logged and returned as one generic refusal, never as a caught partial write. */
async function boundary<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ConvexError) throw error;
    console.error("Prepaid reclassification failed", error);
    return refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_UNAVAILABLE);
  }
}

export const requestPrepaidReclassification = mutation({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules"), lines: v.array(lineValidator), reason: v.string() },
  returns: v.object({ reclassificationId: v.id("openingPrepaidReclassifications"), version: v.number() }),
  handler: async (ctx, args) => boundary(async () => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    requirePayrollAuthority(auth);
    if (auth.membership.impersonationGrantId) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_AUTHORITY);
    await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    const reason = args.reason.trim();
    if (!reason || reason.length > RECLASS_REASON_MAX) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_REASON);
    const totalMinor = validateReclassLines(args.lines);
    if (totalMinor === null) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_LINES);
    if (args.lines.some((line) => line.userId === auth.user._id)) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_BENEFICIARY);
    if (!(await beneficiariesAreActiveMembers(ctx, args.orgId, args.lines))) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_BENEFICIARY_INVALID);
    // A retry after a lost response is the same request: replay it instead of refusing it as a second pending request.
    const rows = await scheduleReclassRows(ctx, args.orgId, args.scheduleId);
    if (rows === null) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_INELIGIBLE);
    const same = rows.find((row) => row.status === "PENDING" && sameRequest(row, auth.user._id, args.lines, reason));
    if (same) return { reclassificationId: same._id, version: 1 };
    const evaluation = await evaluatePrepaidReclass(ctx, args.orgId, args.scheduleId, totalMinor);
    if (!evaluation.ok) refusePrepaidReclass(evaluation.code);
    const reclassificationId = await ctx.db.insert("openingPrepaidReclassifications", {
      orgId: args.orgId, scheduleId: args.scheduleId, status: "PENDING", lines: args.lines, totalMinor, reason,
      requestedBy: auth.user._id, requestedAt: Date.now(),
    });
    await auditLog(ctx, { orgId: args.orgId, actorId: auth.user._id, actionType: "REQUEST_PREPAID_RECLASSIFICATION",
      resourceType: "openingPrepaidReclassifications", resourceId: String(reclassificationId),
      description: "Requested moving employee advances out of an opening prepaid schedule",
      after: { scheduleId: args.scheduleId, totalMinor, lines: args.lines, reason } });
    return { reclassificationId, version: 1 };
  }),
});

export const approvePrepaidReclassification = mutation({
  args: {
    orgId: v.id("organizations"), reclassificationId: v.id("openingPrepaidReclassifications"),
    expectedTotalMinor: v.number(), expectedTrueUpMinor: v.number(),
  },
  returns: v.object({
    eventId: v.id("accountingEvents"), journalEntryId: v.id("journalEntries"),
    advanceIds: v.array(v.id("employeeAdvances")), trueUpMinor: v.number(),
  }),
  handler: async (ctx, args) => boundary(async () => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    requirePayrollAuthority(auth);
    const row = await requireOwnedRow(ctx, args.orgId, "openingPrepaidReclassifications", args.reclassificationId);
    if (row.status !== "PENDING") refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_STATE);
    if (row.requestedBy === auth.user._id || auth.membership.impersonationGrantId) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_SECOND_PERSON);
    if (row.lines.some((line) => line.userId === auth.user._id)) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_BENEFICIARY);
    if (!(await beneficiariesAreActiveMembers(ctx, args.orgId, row.lines))) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_BENEFICIARY_INVALID);
    if (args.expectedTotalMinor !== row.totalMinor) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_FIGURES);
    const evaluation = await evaluatePrepaidReclass(ctx, args.orgId, row.scheduleId, validateReclassLines(row.lines), row._id);
    if (!evaluation.ok) refusePrepaidReclass(evaluation.code);
    const { plan } = evaluation;
    if (plan.totalMinor !== row.totalMinor || args.expectedTrueUpMinor !== plan.trueUpMinor) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_FIGURES);
    const now = Date.now();
    await requirePeriodOpenToday(ctx, args.orgId, now);
    await requireRecognitionInSamePeriod(ctx, args.orgId, plan, now);
    const { schedule } = plan;
    const advanceIds: Id<"employeeAdvances">[] = [];
    for (const line of row.lines) {
      advanceIds.push(await ctx.db.insert("employeeAdvances", {
        orgId: args.orgId, userId: line.userId, amountMinor: line.amountMinor, recoveredMinor: 0, currency: schedule.currency,
        date: now, status: "OUTSTANDING", note: "Moved from opening prepaid expenses", prepaidReclassificationId: row._id,
        createdBy: auth.user._id, createdAt: now, updatedAt: now,
      }));
    }
    const posted = await postAccountingEvent(ctx, {
      orgId: args.orgId, eventType: PREPAID_RECLASS_EVENT, sourceType: PREPAID_RECLASS_SOURCE, sourceId: String(row._id),
      eventVersion: PREPAID_RECLASS_VERSION, accountingDate: now, occurredAt: now, currency: schedule.currency,
      payload: { reclassificationId: String(row._id), scheduleId: String(row.scheduleId), totalMinor: row.totalMinor,
        trueUpMinor: plan.trueUpMinor, expenseSystemKey: schedule.expenseSystemKey },
      actorId: auth.user._id, idempotencyKey: prepaidReclassKey(String(row._id)),
    });
    if (!posted.eventId || !posted.journalEntryId) throw new ConvexError("The reclassification was not posted.");
    await ctx.db.patch(schedule._id, { totalMinor: plan.newTotalMinor, recognizedMinor: plan.newRecognizedMinor });
    await ctx.db.patch(row._id, {
      status: "APPROVED", decidedBy: auth.user._id, decidedAt: now, priorTotalMinor: schedule.totalMinor,
      priorRecognizedMinor: schedule.recognizedMinor, monthsRecognized: schedule.monthsRecognized ?? 0,
      trueUpMinor: plan.trueUpMinor, eventId: posted.eventId, journalEntryId: posted.journalEntryId, advanceIds,
    });
    await auditLog(ctx, { orgId: args.orgId, actorId: auth.user._id, actionType: "APPROVE_PREPAID_RECLASSIFICATION",
      resourceType: "openingPrepaidReclassifications", resourceId: String(row._id),
      description: "Approved moving employee advances out of an opening prepaid schedule",
      after: { totalMinor: row.totalMinor, trueUpMinor: plan.trueUpMinor, eventId: posted.eventId, journalEntryId: posted.journalEntryId } });
    return { eventId: posted.eventId, journalEntryId: posted.journalEntryId, advanceIds, trueUpMinor: plan.trueUpMinor };
  }),
});

export const dismissPrepaidReclassification = mutation({
  args: { orgId: v.id("organizations"), reclassificationId: v.id("openingPrepaidReclassifications") },
  returns: v.null(),
  handler: async (ctx, args) => boundary(async () => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    requirePayrollAuthority(auth);
    const row = await requireOwnedRow(ctx, args.orgId, "openingPrepaidReclassifications", args.reclassificationId);
    if (row.status !== "PENDING") refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_STATE);
    await ctx.db.patch(row._id, { status: "DISMISSED", decidedBy: auth.user._id, decidedAt: Date.now() });
    await auditLog(ctx, { orgId: args.orgId, actorId: auth.user._id, actionType: "DISMISS_PREPAID_RECLASSIFICATION",
      resourceType: "openingPrepaidReclassifications", resourceId: String(row._id),
      description: "Dismissed a request to move employee advances out of an opening prepaid schedule" });
    return null;
  }),
});

/** Figures for a request that has not been submitted yet, so the requester sees the true-up before asking. */
export const previewPrepaidReclassification = query({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules"), totalMinor: v.number() },
  returns: previewValidator,
  handler: async (ctx, args) => {
    requirePayrollAuthority(await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]));
    await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    const total = Number.isSafeInteger(args.totalMinor) && args.totalMinor > 0 ? args.totalMinor : null;
    const evaluation = await evaluatePrepaidReclass(ctx, args.orgId, args.scheduleId, total);
    if (!evaluation.ok) return { ok: false as const, code: evaluation.code };
    const { plan } = evaluation;
    return { ok: true as const, ...planFigures(plan) };
  },
});

export const prepaidReclassificationStatus = query({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  returns: statusValidator,
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    if (!holds(auth.role, PERMISSIONS.MANAGE_FINANCE) || !holds(auth.role, PERMISSIONS.MANAGE_PAYROLL)) return RESTRICTED;
    await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
    const rows = await scheduleReclassRows(ctx, args.orgId, args.scheduleId);
    if (rows === null) return { eligible: false, blockedReason: AppErrorCode.PREPAID_RECLASS_INELIGIBLE, reclassifiedMinor: null, pending: null, approved: null };
    const pendingRow = rows.find((row) => row.status === "PENDING");
    const approvedRow = rows.find((row) => row.status === "APPROVED");
    let pending: Infer<typeof statusValidator>["pending"] = null;
    if (pendingRow) {
      const evaluation = await evaluatePrepaidReclass(ctx, args.orgId, args.scheduleId, validateReclassLines(pendingRow.lines), pendingRow._id);
      pending = { reclassificationId: pendingRow._id, requestedByMe: pendingRow.requestedBy === auth.user._id,
        requestedBy: { userId: pendingRow.requestedBy, name: await nameInOrg(ctx, args.orgId, pendingRow.requestedBy) },
        requestedAt: pendingRow.requestedAt, totalMinor: pendingRow.totalMinor, trueUpMinor: evaluation.ok ? evaluation.plan.trueUpMinor : null,
        lines: await namedLines(ctx, args.orgId, pendingRow.lines), reason: pendingRow.reason,
        figures: evaluation.ok ? { ok: true as const, ...planFigures(evaluation.plan) } : { ok: false as const, code: evaluation.code } };
    }
    const complete = approvedRow && approvedRow.trueUpMinor !== undefined && approvedRow.advanceIds && approvedRow.decidedAt !== undefined &&
      approvedRow.decidedBy && approvedRow.eventId && approvedRow.journalEntryId ? { ...approvedRow, decidedAt: approvedRow.decidedAt, decidedBy: approvedRow.decidedBy,
        eventId: approvedRow.eventId, journalEntryId: approvedRow.journalEntryId, trueUpMinor: approvedRow.trueUpMinor, advanceIds: approvedRow.advanceIds } : null;
    const journal = complete ? await ctx.db.get(complete.journalEntryId) : null;
    const approved: Infer<typeof statusValidator>["approved"] = complete
      ? { reclassificationId: complete._id, totalMinor: complete.totalMinor, trueUpMinor: complete.trueUpMinor, advanceIds: complete.advanceIds,
        approvedAt: complete.decidedAt, approvedBy: { userId: complete.decidedBy, name: await nameInOrg(ctx, args.orgId, complete.decidedBy) },
        eventId: complete.eventId, journalEntryId: complete.journalEntryId, journalNumber: journal?.journalNumber ?? null,
        lines: await namedLines(ctx, args.orgId, complete.lines), reason: complete.reason }
      : null;
    if (pending || approved) {
      return { eligible: false, blockedReason: approved ? AppErrorCode.PREPAID_RECLASS_ALREADY : AppErrorCode.PREPAID_RECLASS_PENDING,
        reclassifiedMinor: approved?.totalMinor ?? null, pending, approved };
    }
    const evaluation = await evaluatePrepaidReclass(ctx, args.orgId, args.scheduleId, null);
    const eligible = !evaluation.ok && evaluation.code === AppErrorCode.PREPAID_RECLASS_LINES;
    return { eligible, blockedReason: eligible || evaluation.ok ? null : evaluation.code, reclassifiedMinor: null, pending: null, approved: null };
  },
});

