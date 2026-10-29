/**
 * SCRUM-869 S3a - the due date and aging of a supplier obligation.
 *
 * Owner ruling SCRUM-869#c23883 (OQ-1; the coordinator's Jira record of a chat ruling):
 *  - an agreed due date always takes precedence;
 *  - otherwise the ownership-model trigger applies, read ONLY from recorded facts;
 *  - with no reliable date or trigger the answer is "No due date": never invented, never overdue;
 *  - aging buckets are Current, 1-30, 31-60, 61-90 and 90+ days overdue, in Asia/Amman.
 *
 * Pure: no database, no clock. Callers pass `now` and the recorded facts they read.
 *
 * Time zone: calendar days are taken in the IANA zone `Asia/Amman` through `Intl.DateTimeFormat`
 * (ECMA-402), so the tz database decides the offset for each instant. Jordan has been on permanent
 * UTC+3 since October 2022 and was UTC+2 in winter / UTC+3 in summer before; a hard-coded +03:00
 * would misplace every pre-2022 winter instant.
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
 * https://www.iana.org/time-zones
 *
 * Aging convention: days past the DUE date, bucketed into 30-day bands, is the standard receivables
 * and payables aging layout. "90+" is read as strictly more than 90 days, so 90 days overdue is
 * still in 61-90.
 */

export const AMMAN_TIME_ZONE = "Asia/Amman";

const MS_PER_DAY = 86_400_000;

const AMMAN_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: AMMAN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type DatePart = "year" | "month" | "day";

/** One calendar field of an instant as read in Asia/Amman (a two-digit string for month and day). */
function ammanPart(instantMs: number, type: DatePart): string {
  return AMMAN_DATE_FORMAT.formatToParts(new Date(instantMs)).find((p) => p.type === type)?.value ?? "";
}

/** The Amman calendar date of an instant, as `YYYY-MM-DD`. */
export function ammanDateString(instantMs: number): string {
  return `${ammanPart(instantMs, "year")}-${ammanPart(instantMs, "month")}-${ammanPart(instantMs, "day")}`;
}

/** Whole days since 1970-01-01 of the Amman calendar date of an instant. */
function ammanDayNumber(instantMs: number): number {
  const year = Number(ammanPart(instantMs, "year"));
  const month = Number(ammanPart(instantMs, "month"));
  const day = Number(ammanPart(instantMs, "day"));
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/**
 * Amman calendar days between the due date and now. Positive = overdue, 0 = due today,
 * negative = not yet due.
 */
export function daysOverdue(dueAtMs: number, nowMs: number): number {
  return ammanDayNumber(nowMs) - ammanDayNumber(dueAtMs);
}

export type AgingBucket =
  | "CURRENT"
  | "DAYS_1_30"
  | "DAYS_31_60"
  | "DAYS_61_90"
  | "DAYS_90_PLUS"
  | "NO_DUE_DATE";

export function bucketFor(days: number): Exclude<AgingBucket, "NO_DUE_DATE"> {
  if (days <= 0) return "CURRENT";
  if (days <= 30) return "DAYS_1_30";
  if (days <= 60) return "DAYS_31_60";
  if (days <= 90) return "DAYS_61_90";
  return "DAYS_90_PLUS";
}

/** A missing due date is its own bucket and has no day count: it can never be overdue. */
export function agingFor(
  dueAtMs: number | null,
  nowMs: number
): { daysOverdue: number | null; bucket: AgingBucket } {
  if (dueAtMs === null) return { daysOverdue: null, bucket: "NO_DUE_DATE" };
  const days = daysOverdue(dueAtMs, nowMs);
  return { daysOverdue: days, bucket: bucketFor(days) };
}

export type DueRuleCode =
  | "AGREED_DATE"
  | "DELIVERY_RECORDED"
  | "CLEARED_PROCEEDS_NOT_RECORDED"
  | "DELIVERY_NOT_RECORDED"
  | "TERMS_NOT_RECORDED"
  | "COLLECTIBILITY_NOT_RECORDED";

/** The recorded facts a trigger may read. Every field is optional: absence is the common case. */
export interface DueFacts {
  /** A stored agreed due date (epoch ms). */
  agreedDueAt?: number;
  /** The explicit delivery record (financed `handoverStatus === HANDED_OVER` and its timestamp). */
  deliveredAt?: number;
}

export interface DerivedDue {
  dueAt: number | null;
  rule: DueRuleCode;
  explanation: string;
}

export type DueTriggerKey =
  | "SOURCED_THROUGH_DEALERSHIP_PAYABLE"
  | "SOURCED_DIRECT_RECEIVABLE"
  | "OWNED_ON_ACCOUNT_PAYABLE"
  | "COST_RECOVERY";

type TriggerResolution = { dueAt: number; rule: DueRuleCode; explanation: string } | { dueAt: null; rule: DueRuleCode; explanation: string };

/**
 * The ownership-model trigger table. ONE entry per model, so an owner ruling on what "cleared
 * proceeds", "terms" or "collectibility" mean changes one entry and its test.
 *
 * Coordinator rulings 2026-10-29 within c23883:
 *  - THROUGH_DEALERSHIP payable: cleared proceeds are not a recorded fact, so no trigger.
 *  - DIRECT_TO_SUPPLIER commission receivable: only an explicit delivery record counts. A completed
 *    sale is NOT delivery.
 *  - OWNED ON_ACCOUNT payable: supplier terms are not stored, so only an agreed date applies.
 *  - Cost recovery: no collectibility record exists, so only an agreed date applies.
 */
export const DUE_TRIGGERS: Record<DueTriggerKey, (facts: DueFacts) => TriggerResolution> = {
  SOURCED_THROUGH_DEALERSHIP_PAYABLE: () => ({
    dueAt: null,
    rule: "CLEARED_PROCEEDS_NOT_RECORDED",
    explanation: "No due date: no agreed date, and cleared proceeds are not recorded.",
  }),
  SOURCED_DIRECT_RECEIVABLE: (facts) => {
    if (isRecordedInstant(facts.deliveredAt)) {
      return {
        dueAt: facts.deliveredAt,
        rule: "DELIVERY_RECORDED",
        explanation: "Due on the recorded delivery of the vehicle.",
      };
    }
    return {
      dueAt: null,
      rule: "DELIVERY_NOT_RECORDED",
      explanation: "No due date: no agreed date, and delivery is not recorded.",
    };
  },
  OWNED_ON_ACCOUNT_PAYABLE: () => ({
    dueAt: null,
    rule: "TERMS_NOT_RECORDED",
    explanation: "No due date: no agreed date, and the supplier's payment terms are not recorded.",
  }),
  COST_RECOVERY: () => ({
    dueAt: null,
    rule: "COLLECTIBILITY_NOT_RECORDED",
    explanation: "No due date: no agreed date, and the reimbursement's collectibility is not recorded.",
  }),
};

/** A recorded instant is a positive finite number. Anything else is a missing fact, never a date. */
function isRecordedInstant(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function deriveDueDate(model: DueTriggerKey, facts: DueFacts): DerivedDue {
  if (isRecordedInstant(facts.agreedDueAt)) {
    return {
      dueAt: facts.agreedDueAt,
      rule: "AGREED_DATE",
      explanation: "Due on the agreed due date.",
    };
  }
  return DUE_TRIGGERS[model](facts);
}
