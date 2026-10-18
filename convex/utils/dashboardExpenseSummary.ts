import type { Change } from "convex-helpers/server/triggers";
import { makeFunctionReference } from "convex/server";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isCashOutExpense, isShowroomBorne } from "./costBearer";

/**
 * SCRUM-807: the dashboard's expense figures from one month-level summary.
 *
 * One row per (org, generation, UTC month) holds, for each UTC day of that
 * month, integer thousandths of: cash out, showroom-borne expenses, general
 * (profit) expenses, and the count of showroom-borne rows. The dashboard's
 * MONTH, YEAR and ALL_TIME labels are all functions of the UTC day, so whole
 * days are read from here and only the partial day at a rolling cutoff is read
 * raw. See work/io-dashboard-month-summary-design.md.
 *
 * Exactness: an amount is stored only when it is finite and exactly a whole
 * number of thousandths. Anything else is counted in `unrepresentable` and the
 * reader refuses every window touching that month. Nothing is rounded into a
 * total. `absTotal` bounds every partial sum; past 2^53 the month is marked
 * `overflowed` for good and refused the same way.
 *
 * Maintenance never throws on bad data: an unrepresentable amount is data, so
 * a caller that catches an error cannot leave a half-applied summary behind.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Month key for dates the calendar cannot place; below every real month. */
export const UNPLACEABLE_MONTH = 0;
const DAYS = 31;

export const expenseSummaryPage = makeFunctionReference<
  "mutation",
  { orgId: Id<"organizations">; generation: number }
>("dashboardExpenseSummary:buildPage");

export type SummaryState = Doc<"dashboardExpenseSummaryState">;
type MonthDoc = Doc<"dashboardExpenseMonths">;

/** UTC month key, e.g. 202610. */
export function monthKeyOf(at: number): number {
  const d = new Date(at);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}

export function utcMidnight(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** Exact thousandths, or null when the amount cannot be stored exactly. */
export function toThousandths(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const t = Math.round(amount * 1000);
  if (!Number.isSafeInteger(t) || t / 1000 !== amount) return null;
  return t;
}

export function isLiveExpense(exp: Doc<"expenses">): boolean {
  return exp.isDeleted !== true && exp.reversedAt === undefined;
}

/**
 * The dashboard's three expense predicates, in one place. Mirrors the loop in
 * `dashboard.stats`: cash out is any non-PENDING row whoever bears it; Expenses
 * is showroom-borne; general (profit) is showroom-borne except a vehicle cost
 * capitalized into inventory.
 */
export function expenseFlags(exp: Doc<"expenses">) {
  const showroom = isShowroomBorne(exp);
  return {
    cashOut: isCashOutExpense(exp),
    showroom,
    general: showroom && !(exp.vehicleId && exp.accountingTreatment === "CAPITALIZED_INVENTORY"),
  };
}

type Contribution = {
  month: number;
  day: number;
  cashOut: number;
  showroom: number;
  general: number;
  showroomCount: number;
  unrepresentable: number;
  abs: number;
};

export function contributionOf(exp: Doc<"expenses"> | null | undefined): Contribution | null {
  if (!exp || !isLiveExpense(exp)) return null;
  const year = new Date(exp.date).getUTCFullYear();
  // A date the calendar cannot place (non-finite, or outside years 1-9999)
  // goes to the UNPLACEABLE_MONTH sentinel as unrepresentable, so any window
  // that could reach it (ALL_TIME) falls back to the raw reader.
  if (!Number.isFinite(year) || year < 1 || year > 9999) {
    return { month: UNPLACEABLE_MONTH, day: 0, cashOut: 0, showroom: 0, general: 0, showroomCount: 0, unrepresentable: 1, abs: 0 };
  }
  const month = monthKeyOf(exp.date);
  const day = new Date(exp.date).getUTCDate() - 1;
  const t = toThousandths(exp.amount);
  const flags = expenseFlags(exp);
  if (t === null) {
    return { month, day, cashOut: 0, showroom: 0, general: 0, showroomCount: 0, unrepresentable: 1, abs: 0 };
  }
  return {
    month,
    day,
    cashOut: flags.cashOut ? t : 0,
    showroom: flags.showroom ? t : 0,
    general: flags.general ? t : 0,
    showroomCount: flags.showroom ? 1 : 0,
    unrepresentable: 0,
    abs: Math.abs(t),
  };
}

function sameContribution(a: Contribution | null, b: Contribution | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.month === b.month && a.day === b.day && a.cashOut === b.cashOut && a.showroom === b.showroom &&
    a.general === b.general && a.showroomCount === b.showroomCount && a.unrepresentable === b.unrepresentable &&
    a.abs === b.abs
  );
}

export async function latestSummaryState(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
): Promise<SummaryState | null> {
  return await ctx.db
    .query("dashboardExpenseSummaryState")
    .withIndex("by_org_generation", (q) => q.eq("orgId", orgId))
    .order("desc")
    .first();
}

/** Has this generation already counted a row created at `creationTime`? */
function counted(state: SummaryState, creationTime: number): boolean {
  if (state.phase === "READY") return true;
  if (state.phase === "BLOCKED") return false;
  return state.countedThrough !== undefined && creationTime <= state.countedThrough;
}

function emptyDays(): number[] {
  return new Array<number>(DAYS).fill(0);
}

/** Add `sign` × each contribution to its month row, in this transaction. */
export async function applyContributions(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  generation: number,
  items: ReadonlyArray<{ c: Contribution; sign: 1 | -1 }>,
): Promise<void> {
  const byMonth = new Map<number, Array<{ c: Contribution; sign: 1 | -1 }>>();
  for (const item of items) {
    const list = byMonth.get(item.c.month) ?? [];
    list.push(item);
    byMonth.set(item.c.month, list);
  }
  for (const [month, list] of byMonth) {
    const existing = await ctx.db
      .query("dashboardExpenseMonths")
      .withIndex("by_org_generation_month", (q) =>
        q.eq("orgId", orgId).eq("generation", generation).eq("month", month))
      .unique();
    const row: Omit<MonthDoc, "_id" | "_creationTime"> = existing
      ? {
        orgId, generation, month,
        cashOut: [...existing.cashOut], showroom: [...existing.showroom],
        general: [...existing.general], showroomCount: [...existing.showroomCount],
        unrepresentable: existing.unrepresentable, absTotal: existing.absTotal, overflowed: existing.overflowed,
      }
      : {
        orgId, generation, month,
        cashOut: emptyDays(), showroom: emptyDays(), general: emptyDays(), showroomCount: emptyDays(),
        unrepresentable: 0, absTotal: 0, overflowed: false,
      };
    for (const { c, sign } of list) {
      row.cashOut[c.day] += sign * c.cashOut;
      row.showroom[c.day] += sign * c.showroom;
      row.general[c.day] += sign * c.general;
      row.showroomCount[c.day] += sign * c.showroomCount;
      row.unrepresentable += sign * c.unrepresentable;
      row.absTotal += sign * c.abs;
      if (!Number.isSafeInteger(row.absTotal) || row.absTotal > Number.MAX_SAFE_INTEGER) row.overflowed = true;
    }
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("dashboardExpenseMonths", row);
  }
}

/**
 * Trigger body for `expenses`. For each org the row was in before or after,
 * removes the old contribution and adds the new one, but only for a generation
 * whose build has already passed this row (a row it has not reached is counted
 * in its final state when the build gets there). Irrelevant edits write nothing.
 */
export async function maintainExpenseSummary(
  ctx: MutationCtx,
  change: Change<DataModel, "expenses">,
): Promise<void> {
  const oldDoc = change.oldDoc ?? null;
  const newDoc = change.newDoc ?? null;
  const before = contributionOf(oldDoc);
  const after = contributionOf(newDoc);
  const creationTime = (newDoc ?? oldDoc)!._creationTime;
  const orgs = new Set<Id<"organizations">>();
  if (oldDoc) orgs.add(oldDoc.orgId);
  if (newDoc) orgs.add(newDoc.orgId);
  if (orgs.size === 1 && sameContribution(before, after)) return;
  for (const orgId of orgs) {
    const items: Array<{ c: Contribution; sign: 1 | -1 }> = [];
    if (before && oldDoc?.orgId === orgId) items.push({ c: before, sign: -1 });
    if (after && newDoc?.orgId === orgId) items.push({ c: after, sign: 1 });
    if (items.length === 0) continue;
    const state = await latestSummaryState(ctx, orgId);
    if (!state || !counted(state, creationTime)) continue;
    await applyContributions(ctx, orgId, state.generation, items);
  }
}

export type ExpenseDayBucket = {
  /** UTC midnight of the day. */
  day: number;
  cashOut: number;
  showroom: number;
  general: number;
  showroomCount: number;
};

/** The most month rows one window may read: 50 years of occupied months. */
export const MAX_SUMMARY_MONTHS = 600;

/**
 * Whole UTC days in [fromDay, untilDay) (both UTC midnights; undefined means
 * unbounded on that side), from the org's READY generation. Null when there is no
 * READY generation, when a month in range is refused (unrepresentable or
 * overflowed), or when the range holds more month rows than the bound — the
 * caller then falls back to the capped raw reader.
 */
export async function readSummaryDays(
  ctx: QueryCtx,
  state: SummaryState,
  fromDay: number | undefined,
  untilDay: number | undefined,
): Promise<ExpenseDayBucket[] | null> {
  if (state.phase !== "READY") return null;
  const fromMonth = fromDay === undefined ? undefined : monthKeyOf(fromDay);
  const untilMonth = untilDay === undefined ? undefined : monthKeyOf(untilDay - 1);
  const rows = await ctx.db
    .query("dashboardExpenseMonths")
    .withIndex("by_org_generation_month", (q) => {
      const org = q.eq("orgId", state.orgId).eq("generation", state.generation);
      const lower = fromMonth === undefined ? org : org.gte("month", fromMonth);
      return untilMonth === undefined ? lower : lower.lte("month", untilMonth);
    })
    .take(MAX_SUMMARY_MONTHS + 1);
  if (rows.length > MAX_SUMMARY_MONTHS) return null;
  const buckets: ExpenseDayBucket[] = [];
  for (const row of rows) {
    if (row.unrepresentable !== 0 || row.overflowed) return null;
    const year = Math.floor(row.month / 100);
    const monthIndex = (row.month % 100) - 1;
    for (let d = 0; d < DAYS; d++) {
      if (row.showroomCount[d] === 0 && row.cashOut[d] === 0 && row.general[d] === 0 && row.showroom[d] === 0) continue;
      const day = Date.UTC(year, monthIndex, d + 1);
      if ((fromDay !== undefined && day < fromDay) || (untilDay !== undefined && day >= untilDay)) continue;
      buckets.push({
        day,
        cashOut: row.cashOut[d],
        showroom: row.showroom[d],
        general: row.general[d],
        showroomCount: row.showroomCount[d],
      });
    }
  }
  return buckets;
}

/**
 * Sum of exact thousandths plus anything that was not representable. When
 * every term is representable the result is the exact decimal total, whatever
 * order the terms arrive in — so the summary and raw readers agree.
 */
export class ExactSum {
  private milli = 0;
  private extra = 0;
  addAmount(amount: number): void {
    const t = toThousandths(amount);
    if (t === null) this.extra += amount;
    else this.milli += t;
  }
  addThousandths(t: number): void {
    this.milli += t;
  }
  value(): number {
    return this.milli / 1000 + this.extra;
  }
}
