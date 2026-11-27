import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { SYSTEM_KEYS, type SystemKey } from "../utils/defaultChart";
import { AppErrorCode, throwAppError } from "../utils/errors";
import { recognizedDueThroughDateMinor, yearMonthStringIndex } from "../utils/expenseAmortization";
import { resolvePrepaidScheduleSource } from "../utils/openingPrepaidBasis";
import { checkPostingAllowed } from "../utils/postingPeriod";
import {
  PREPAID_RECLASS_SOURCE, PREPAID_RECLASS_VERSION, prepaidReclassKey, prepaidReclassPayload, RECLASS_READ_BOUND,
} from "../utils/prepaidReclassificationProof";
import type { RuleResult } from "./postingRules";

export { PREPAID_RECLASS_EVENT, PREPAID_RECLASS_SOURCE, PREPAID_RECLASS_VERSION, prepaidReclassKey, RECLASS_READ_BOUND } from "../utils/prepaidReclassificationProof";

/**
 * SCRUM-961 (ADR 2026-11-27): an opening prepaid schedule that held employee advances is split. The advances move to
 * Employee Advances (1230), one row per person; the prepaid asset falls by the same total; and the month(s) already
 * recognised on the old, larger base are trued up to what the smaller base would have recognised. Cash is untouched.
 * Nothing the caller types decides a figure: the true-up is derived from the stored schedule, for the command and again
 * for the posting engine.
 */
export type PrepaidReclassCode =
  | typeof AppErrorCode.PREPAID_RECLASS_LINES | typeof AppErrorCode.PREPAID_RECLASS_AMOUNT
  | typeof AppErrorCode.PREPAID_RECLASS_REASON | typeof AppErrorCode.PREPAID_RECLASS_BENEFICIARY_INVALID
  | typeof AppErrorCode.PREPAID_RECLASS_BENEFICIARY | typeof AppErrorCode.PREPAID_RECLASS_AUTHORITY
  | typeof AppErrorCode.PREPAID_RECLASS_INELIGIBLE | typeof AppErrorCode.PREPAID_RECLASS_PENDING
  | typeof AppErrorCode.PREPAID_RECLASS_ALREADY | typeof AppErrorCode.PREPAID_RECLASS_SECOND_PERSON
  | typeof AppErrorCode.PREPAID_RECLASS_FIGURES | typeof AppErrorCode.PREPAID_RECLASS_STATE
  | typeof AppErrorCode.PREPAID_RECLASS_PERIOD | typeof AppErrorCode.PREPAID_RECLASS_REVERSAL
  | typeof AppErrorCode.PREPAID_RECLASS_CROSS_PERIOD | typeof AppErrorCode.PREPAID_RECLASS_RECOGNITION
  | typeof AppErrorCode.PREPAID_RECLASS_UNAVAILABLE;

/** English text of every refusal; `ServerError_<code>` in lib/i18n/domains/common.ts carries the Arabic and must match. */
export const PREPAID_RECLASS_MESSAGES: Record<PrepaidReclassCode, string> = {
  PREPAID_RECLASS_LINES: "List each employee once, with a whole positive amount.",
  PREPAID_RECLASS_AMOUNT: "The total must be less than what is still unrecognized in this prepaid schedule.",
  PREPAID_RECLASS_REASON: "Enter a reason of up to 500 characters for moving these amounts to employee advances.",
  PREPAID_RECLASS_BENEFICIARY_INVALID: "Every listed person must be an active member of this organization.",
  PREPAID_RECLASS_BENEFICIARY: "A person who receives one of these advances cannot request or approve this change.",
  PREPAID_RECLASS_AUTHORITY: "Finance and payroll management permissions are both required for this change.",
  PREPAID_RECLASS_INELIGIBLE: "This prepaid schedule cannot be changed. Ask finance to review it.",
  PREPAID_RECLASS_PENDING: "A change request for this schedule is already waiting for a decision.",
  PREPAID_RECLASS_ALREADY: "Amounts were already moved out of this schedule. This change is available once.",
  PREPAID_RECLASS_SECOND_PERSON: "A different authorised user must approve this change.",
  PREPAID_RECLASS_FIGURES: "The figures changed since you reviewed them. Review the updated figures and try again. Nothing was posted.",
  PREPAID_RECLASS_STATE: "This request is no longer waiting for a decision.",
  PREPAID_RECLASS_PERIOD: "The accounting period for today is closed or not open. Nothing was posted.",
  PREPAID_RECLASS_CROSS_PERIOD: "The recognized months being corrected and today are not in the same open accounting period. Nothing was posted.",
  PREPAID_RECLASS_RECOGNITION: "Monthly recognition for this schedule is still queued, failed or does not match the ledger. Resolve it first. Nothing was posted.",
  PREPAID_RECLASS_REVERSAL: "This change cannot be reversed here. Ask finance to review a correction.",
  PREPAID_RECLASS_UNAVAILABLE: "The change could not be completed. Please try again later.",
};

export function refusePrepaidReclass(code: PrepaidReclassCode): never {
  return throwAppError(code, PREPAID_RECLASS_MESSAGES[code]);
}

/**
 * What the schedule's cron has recognised after `months` months on `totalMinor`: the cron's own rule (remaining
 * balance over remaining months, rounded down, the last month taking the rest; prepaidExpenses.ts
 * `amortizeScheduleForMonth`). Pure.
 */
export function cronRecognizedMinor(totalMinor: number, termMonths: number, months: number): number {
  let remaining = totalMinor;
  let left = termMonths;
  let recognized = 0;
  for (let index = 0; index < months; index++) {
    const share = left <= 1 ? remaining : Math.floor(remaining / left);
    recognized += share;
    remaining -= share;
    left -= 1;
  }
  return recognized;
}

export function ruleRecognitionTrueUp(totalMinor: number, termMonths: number, months: number, recognizedMinor: number): number {
  return recognizedMinor - cronRecognizedMinor(totalMinor, termMonths, months);
}

/**
 * What the cron will recognise in each remaining month of the reduced schedule, read from the cron's own projection
 * (`recognizedDueThroughDateMinor`, the shortfall reader's engine) rather than a second formula: the share of the next
 * month and of the last month, taken as differences of the cumulative figure.
 */
export function remainingMonthlyAmounts(schedule: Doc<"prepaidExpenseSchedules">, newTotalMinor: number, newRecognizedMinor: number, months: number) {
  const like = { totalMinor: newTotalMinor, termMonths: schedule.termMonths, startYearMonth: schedule.startYearMonth, currency: schedule.currency };
  const progress = { recognizedMinor: newRecognizedMinor, monthsRecognized: months };
  const startIndex = yearMonthStringIndex(schedule.startYearMonth);
  const dueAfter = (monthNumber: number) => recognizedDueThroughDateMinor(like, progress,
    Date.UTC(Math.floor((startIndex + monthNumber - 1) / 12), (startIndex + monthNumber - 1) % 12, 15));
  return {
    remainingMonths: schedule.termMonths - months,
    regularMonthlyMinor: dueAfter(months + 1) - newRecognizedMinor,
    finalMonthlyMinor: dueAfter(schedule.termMonths) - dueAfter(schedule.termMonths - 1),
  };
}

export function rulePrepaidReclassified(value: unknown): RuleResult {
  const parsed = prepaidReclassPayload.safeParse(value);
  if (!parsed.success) throw new ConvexError("The reclassification could not be verified.");
  const { totalMinor, trueUpMinor, expenseSystemKey } = parsed.data;
  if (trueUpMinor >= totalMinor) throw new ConvexError("The reclassification could not be verified.");
  const memo = "Opening prepaid moved to employee advances";
  return {
    lines: [
      { accountSystemKey: SYSTEM_KEYS.EMPLOYEE_ADVANCES, debitMinor: totalMinor, creditMinor: 0, description: memo },
      { accountSystemKey: SYSTEM_KEYS.PREPAID_EXPENSES, debitMinor: 0, creditMinor: totalMinor - trueUpMinor, description: memo },
      ...(trueUpMinor > 0
        ? [{ accountSystemKey: expenseSystemKey as SystemKey, debitMinor: 0, creditMinor: trueUpMinor, description: "Recognition trued up to the reduced prepaid base" }]
        : []),
    ],
    memo,
    category: "ADJUSTMENT",
  };
}

type Reader = QueryCtx | MutationCtx;

export interface ReclassLineInput { userId: Id<"users">; amountMinor: number }

export interface ReclassPlan {
  schedule: Doc<"prepaidExpenseSchedules">;
  totalMinor: number;
  newTotalMinor: number;
  newRecognizedMinor: number;
  trueUpMinor: number;
  /** Accounting dates of the posted amortisation events whose months are being trued up. */
  recognitionDates: number[];
  remainingMonths: number;
  /** The next remaining month and the last one; they differ when a remainder is carried into the later months. */
  regularMonthlyMinor: number;
  finalMonthlyMinor: number;
}

export type ReclassEvaluation = { ok: true; plan: ReclassPlan } | { ok: false; code: PrepaidReclassCode };

export const RECLASS_MAX_LINES = 50;
export const RECLASS_REASON_MAX = 500;

export function validateReclassLines(lines: ReclassLineInput[]): number | null {
  if (lines.length === 0 || lines.length > RECLASS_MAX_LINES) return null;
  const seen = new Set<string>();
  let total = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0 || seen.has(String(line.userId))) return null;
    seen.add(String(line.userId));
    total += line.amountMinor;
  }
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * The single decision "may this schedule be split, and by how much recognition". Pure reads. `selfId` is the request
 * being decided, so it does not count as a second pending request.
 */
/** Every request row for a schedule, or null when the read came back full and so cannot be proven complete. */
export async function scheduleReclassRows(ctx: Reader, orgId: Id<"organizations">, scheduleId: Id<"prepaidExpenseSchedules">): Promise<Doc<"openingPrepaidReclassifications">[] | null> {
  const rows = await ctx.db.query("openingPrepaidReclassifications")
    .withIndex("by_org_schedule", (q) => q.eq("orgId", orgId).eq("scheduleId", scheduleId)).take(RECLASS_READ_BOUND);
  return rows.length >= RECLASS_READ_BOUND ? null : rows;
}

export async function evaluatePrepaidReclass(
  ctx: Reader, orgId: Id<"organizations">, scheduleId: Id<"prepaidExpenseSchedules">, totalMinor: number | null, selfId?: Id<"openingPrepaidReclassifications">,
): Promise<ReclassEvaluation> {
  const refuse = (code: PrepaidReclassCode): ReclassEvaluation => ({ ok: false, code });
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule || schedule.orgId !== orgId || schedule.kind !== "OPENING" || schedule.status !== "ACTIVE") {
    return refuse(AppErrorCode.PREPAID_RECLASS_INELIGIBLE);
  }
  const rows = await scheduleReclassRows(ctx, orgId, scheduleId);
  if (rows === null) return refuse(AppErrorCode.PREPAID_RECLASS_INELIGIBLE);
  if (rows.some((row) => row.status === "APPROVED")) return refuse(AppErrorCode.PREPAID_RECLASS_ALREADY);
  if (rows.some((row) => row.status === "PENDING" && row._id !== selfId)) return refuse(AppErrorCode.PREPAID_RECLASS_PENDING);
  const source = await resolvePrepaidScheduleSource(ctx, orgId, scheduleId);
  if (source.kind !== "OPENING") return refuse(AppErrorCode.PREPAID_RECLASS_INELIGIBLE);
  const months = schedule.monthsRecognized ?? 0;
  // The true-up is only meaningful when the recognised history is exactly what the cron rule produces from the
  // stored total. A corrected, refunded or hand-edited schedule is refused instead of guessed.
  if (months >= schedule.termMonths || cronRecognizedMinor(schedule.totalMinor, schedule.termMonths, months) !== schedule.recognizedMinor) {
    return refuse(AppErrorCode.PREPAID_RECLASS_INELIGIBLE);
  }
  const settled = await recognitionSettled(ctx, orgId, schedule);
  if (!settled.ok) return refuse(AppErrorCode.PREPAID_RECLASS_RECOGNITION);
  if (totalMinor === null) return refuse(AppErrorCode.PREPAID_RECLASS_LINES);
  if (totalMinor >= schedule.totalMinor - schedule.recognizedMinor) return refuse(AppErrorCode.PREPAID_RECLASS_AMOUNT);
  const newTotalMinor = schedule.totalMinor - totalMinor;
  const newRecognizedMinor = cronRecognizedMinor(newTotalMinor, schedule.termMonths, months);
  const trueUpMinor = ruleRecognitionTrueUp(newTotalMinor, schedule.termMonths, months, schedule.recognizedMinor);
  if (trueUpMinor < 0 || trueUpMinor >= totalMinor) return refuse(AppErrorCode.PREPAID_RECLASS_INELIGIBLE);
  return { ok: true, plan: { schedule, totalMinor, newTotalMinor, newRecognizedMinor, trueUpMinor, recognitionDates: settled.dates,
    ...remainingMonthlyAmounts(schedule, newTotalMinor, newRecognizedMinor, months) } };
}

const AMORTIZED_EVENT = "PREPAID_EXPENSE_AMORTIZED";

/**
 * I14: the schedule's recognised figure is only trustworthy when the ledger has fully caught up with it. Refused (not
 * guessed) when any outbox entry for the schedule's amortisation keys is not POSTED, an amortisation failure is open,
 * an amortisation event is not POSTED, or the POSTED events do not add up to `recognizedMinor` in exactly
 * `monthsRecognized` months. Reads are bounded: a schedule has at most one event per month of its term, and a read that
 * returns the bound is refused because the rows past it were never seen.
 */
async function recognitionSettled(ctx: Reader, orgId: Id<"organizations">, schedule: Doc<"prepaidExpenseSchedules">): Promise<{ ok: true; dates: number[] } | { ok: false }> {
  const prefix = `prepaid_amort_${schedule._id}_`;
  const queued = await ctx.db.query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).gte("idempotencyKey", prefix).lt("idempotencyKey", `${prefix}~`)).take(RECLASS_READ_BOUND);
  if (queued.length >= RECLASS_READ_BOUND || queued.some((row) => row.status !== "POSTED")) return { ok: false };
  const failures = await ctx.db.query("prepaidAmortizationFailures").withIndex("by_schedule", (q) => q.eq("scheduleId", schedule._id)).take(RECLASS_READ_BOUND);
  if (failures.length >= RECLASS_READ_BOUND || failures.some((row) => row.orgId === orgId && row.resolvedAt === undefined)) return { ok: false };
  const events = await ctx.db.query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).gte("idempotencyKey", prefix).lt("idempotencyKey", `${prefix}~`)).take(RECLASS_READ_BOUND);
  if (events.length >= RECLASS_READ_BOUND) return { ok: false };
  const amortizations = events.filter((row) => row.eventType === AMORTIZED_EVENT);
  if (amortizations.some((row) => row.status !== "POSTED")) return { ok: false };
  const sum = amortizations.reduce((total, row) => total + ((row.payload as { amountMinor?: number } | undefined)?.amountMinor ?? Number.NaN), 0);
  if (sum !== schedule.recognizedMinor || amortizations.length !== (schedule.monthsRecognized ?? 0)) return { ok: false };
  return { ok: true, dates: amortizations.map((row) => row.accountingDate) };
}

/**
 * I12: the true-up lands in the period of the approval date, so every month being trued up must sit in that same OPEN
 * period. No cross-period true-up in v1. `accountingDate` is the one clock read the command uses for the advance rows
 * and the posting, so a clock on a boundary is decided once. Nothing to true up means nothing to align.
 */
export async function requireRecognitionInSamePeriod(ctx: Reader, orgId: Id<"organizations">, plan: ReclassPlan, accountingDate: number): Promise<void> {
  if (plan.trueUpMinor <= 0) return;
  const today = await checkPostingAllowed(ctx, orgId, accountingDate);
  if (!today.ok) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_PERIOD);
  // Independent reads, so they run together (Convex allows parallel db reads in one transaction); the refusal is the same for any failing month.
  const recognized = await Promise.all([...new Set(plan.recognitionDates)].map((date) => checkPostingAllowed(ctx, orgId, date)));
  if (recognized.some((period) => !period.ok || period.periodId !== today.periodId)) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_CROSS_PERIOD);
}
/** Is a retry the same request? Lines compare as a set (person and amount), by plain code-unit order so replay never depends on locale. */
export function sameReclassRequest(row: Doc<"openingPrepaidReclassifications">, requester: Id<"users">, lines: ReclassLineInput[], reason: string): boolean {
  const key = (items: ReclassLineInput[]) => items.map((line) => `${line.userId}:${line.amountMinor}`).sort(byCodeUnit).join("|");
  return row.requestedBy === requester && row.reason === reason && key(row.lines) === key(lines);
}
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
/** The approver's and the requester's membership as an active member: used for every beneficiary. */
export async function beneficiariesAreActiveMembers(ctx: Reader, orgId: Id<"organizations">, lines: ReclassLineInput[]): Promise<boolean> {
  for (const line of lines) {
    const membership = await ctx.db.query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", line.userId)).unique();
    if (!membership || membership.offboardingStatus) return false;
  }
  return true;
}

export async function requirePeriodOpenToday(ctx: Reader, orgId: Id<"organizations">, accountingDate: number): Promise<void> {
  const period = await checkPostingAllowed(ctx, orgId, accountingDate);
  if (!period.ok) refusePrepaidReclass(AppErrorCode.PREPAID_RECLASS_PERIOD);
}

/**
 * Engine-side proof, called from `postAccountingEvent` for this event type only. Whatever the caller sent, the posting
 * must equal what the stored request and schedule say, so no internal caller can post another amount or true-up.
 */
export async function requirePrepaidReclassPosting(
  ctx: MutationCtx,
  command: {
    orgId: Id<"organizations">; currency: string; sourceType: string; sourceId: string; eventVersion: number;
    accountingDate: number; idempotencyKey: string; payload: unknown;
  },
): Promise<void> {
  const unverified = () => new ConvexError("The reclassification could not be verified.");
  if (command.sourceType !== PREPAID_RECLASS_SOURCE || command.eventVersion !== PREPAID_RECLASS_VERSION) throw unverified();
  const parsed = prepaidReclassPayload.safeParse(command.payload);
  if (!parsed.success) throw unverified();
  const payload = parsed.data;
  const reclassId = ctx.db.normalizeId("openingPrepaidReclassifications", payload.reclassificationId);
  if (!reclassId || command.sourceId !== payload.reclassificationId || command.idempotencyKey !== prepaidReclassKey(payload.reclassificationId)) throw unverified();
  const row = await ctx.db.get(reclassId);
  if (!row || row.orgId !== command.orgId || row.status !== "PENDING" || String(row.scheduleId) !== payload.scheduleId) throw unverified();
  const evaluation = await evaluatePrepaidReclass(ctx, command.orgId, row.scheduleId, validateReclassLines(row.lines), row._id);
  if (!evaluation.ok) throw unverified();
  const { plan } = evaluation;
  if (plan.totalMinor !== row.totalMinor || plan.totalMinor !== payload.totalMinor || plan.trueUpMinor !== payload.trueUpMinor ||
      plan.schedule.expenseSystemKey !== payload.expenseSystemKey ||
      plan.schedule.currency.toUpperCase() !== command.currency.toUpperCase()) throw unverified();
  await requireRecognitionInSamePeriod(ctx, command.orgId, plan, command.accountingDate);
}
