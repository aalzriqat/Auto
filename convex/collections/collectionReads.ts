import type { PaginationOptions } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { isCustomerCreditPayoutDisabled } from "../utils/customerCreditPayoutContainment";
import { isFcLineage } from "../utils/fcCheque";
import {
  calendarDateInTimeZone,
  calendarDateOfKey,
  calendarKeyOf,
  getOrgTimeZone,
  type InstantRange,
  orgDayCalendarKeyRange,
  orgDayWindow,
  type OrgDayWindow,
  paymentOnOrgDay,
} from "../utils/orgBusinessDay";
import { PERMISSIONS } from "../utils/permissions";
import { requireTenantAuth } from "../utils/tenancy";
import { DAY_MS, roundMoney } from "./amounts";
import { getOptionalVehicle } from "./collectionLinks";
import type { ReceivableStatus } from "./receivableState";

/**
 * SCRUM-265: a report that reads a bounded prefix must say so. Each read asks for one row more than
 * the cap; seeing that extra row proves the prefix hid qualifying rows, so the totals built from it
 * are partial and the response carries `incomplete`.
 *
 * "Partial" is not "lower bound". The prefix is the EARLIEST rows, and a total that nets refunds
 * (`collectedToday`, the daily collections report: direction OUT / REFUND subtract) can hide a refund
 * and so overstate as easily as understate. Only a figure that cannot be negative (receivables,
 * aging, cheques) is a true lower bound. The screen words the two cases differently.
 */
export const COLLECTIONS_REPORT_ROW_CAP = 500;

export const COLLECTIONS_UPCOMING_CHEQUE_CAP = 200;

function capRows<T>(rows: T[], cap: number): { rows: T[]; incomplete: boolean } {
  return rows.length > cap ? { rows: rows.slice(0, cap), incomplete: true } : { rows, incomplete: false };
}

/**
 * Reads `budget` rows at most across the ranges, in order. `read` receives only what is left of the
 * budget, so a later range is never read when an earlier one already filled it.
 */
export async function takeAcrossRanges<T>(
  ranges: InstantRange[],
  budget: number,
  read: (range: InstantRange, take: number) => Promise<T[]>
): Promise<T[]> {
  const rows: T[] = [];
  for (const range of ranges) {
    const left = budget - rows.length;
    if (left <= 0) break;
    rows.push(...(await read(range, left)));
  }
  return rows;
}

/**
 * What one organization day's `collectionPayments` read can honestly say (SCRUM-264).
 *  - `rows`: the payments the stored facts place on the date (any status; callers filter).
 *  - `uncertain`: a POSTED payment in the read could be on this date or on a neighbouring one and
 *    nothing stored says which (`paymentOnOrgDay` UNPLACEABLE). It is left out of `rows`.
 *  - `incomplete`: the figures built from `rows` are partial - the read hit its budget, or `uncertain`.
 */
interface OrgDayPaymentsRead {
  rows: Doc<"collectionPayments">[];
  incomplete: boolean;
  uncertain: boolean;
}

/**
 * Files a raw `paymentDate` index read under one organization day, decided per row by the writer's
 * stored footprint (`paymentOnOrgDay`), never by the shape of the number. The raw read is at most
 * `cap + 1` rows across the day's ranges: seeing more than `cap` proves the prefix may hide
 * qualifying rows (the extra row may be a neighbouring date's key that merely sits inside the span,
 * which is why the flag is conservative), and only the first `cap` are placed.
 */
function placeOrgDayPayments(
  window: OrgDayWindow,
  raw: Doc<"collectionPayments">[],
  cap: number
): OrgDayPaymentsRead {
  const rows: Doc<"collectionPayments">[] = [];
  let uncertain = false;
  for (const payment of raw.slice(0, cap)) {
    const verdict = paymentOnOrgDay(window, payment);
    if (verdict === "IN_DAY") rows.push(payment);
    else if (verdict === "UNPLACEABLE" && payment.status === "POSTED") uncertain = true;
  }
  return { rows, incomplete: raw.length > cap || uncertain, uncertain };
}

/**
 * The `collectionPayments` of one organization day (SCRUM-264): the rows in the zone's span of the
 * date plus the date's own calendar key, then placed by provenance (`placeOrgDayPayments`).
 */
async function readOrgDayPayments(
  ctx: Pick<QueryCtx, "db">,
  orgId: Id<"organizations">,
  window: OrgDayWindow
): Promise<OrgDayPaymentsRead> {
  const raw = await takeAcrossRanges(window.ranges, COLLECTIONS_REPORT_ROW_CAP + 1, (range, take) =>
    ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) =>
        q.eq("orgId", orgId).gte("paymentDate", range.start).lte("paymentDate", range.end)
      )
      .take(take)
  );
  return placeOrgDayPayments(window, raw, COLLECTIONS_REPORT_ROW_CAP);
}

/**
 * SCRUM-264: the business date the caller named, as the organization's own day. `businessDate` is a
 * calendar date sent as its UTC midnight (lib/dateInput.ts `dateInputToUtcMs`). `key` is that same
 * calendar key (what `cashierReconciliations.businessDate` stores); `window` carries the
 * `paymentDate` index ranges of that date and what is needed to place each row on it.
 */
export async function orgBusinessDay(ctx: Pick<QueryCtx, "db">, orgId: Id<"organizations">, businessDate: number) {
  if (!Number.isFinite(businessDate)) throw new ConvexError("Business date is invalid.");
  const timeZone = await getOrgTimeZone(ctx, orgId);
  const date = calendarDateOfKey(businessDate);
  return { key: calendarKeyOf(businessDate), window: orgDayWindow(timeZone, date) };
}

export function customerName(customer: Doc<"customers"> | null) {
  if (!customer) return "Unknown customer";
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unknown customer";
}

function vehicleLabel(vehicle: Doc<"vehicles"> | null | undefined) {
  if (!vehicle) return undefined;
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim();
}

async function hydrateReceivable(ctx: QueryCtx, receivable: Doc<"receivables">) {
  const [customer, vehicle] = await Promise.all([
    ctx.db.get(receivable.customerId),
    getOptionalVehicle(ctx, receivable.vehicleId),
  ]);
  return {
    ...receivable,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
  };
}

async function hydrateCheque(ctx: QueryCtx, cheque: Doc<"postDatedCheques">) {
  const [customer, vehicle, receivable, invoiceSale] = await Promise.all([
    ctx.db.get(cheque.customerId),
    getOptionalVehicle(ctx, cheque.vehicleId),
    cheque.receivableId ? ctx.db.get(cheque.receivableId) : null,
    cheque.invoiceSaleId ? ctx.db.get(cheque.invoiceSaleId) : null,
  ]);
  const isFinanceCompanyCheque = isFcLineage(cheque);
  let drawerName: string | null = null;
  if (isFinanceCompanyCheque && cheque.drawerType === "FINANCE_COMPANY" && cheque.financeCompanyId) {
    const drawer = await ctx.db.get(cheque.financeCompanyId);
    if (drawer && drawer.orgId === cheque.orgId) drawerName = drawer.name;
  }
  return {
    ...cheque,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
    receivableTitle: receivable?.title,
    // SCRUM-724: the sale this cheque was written for, so a cheque on a
    // cancelled sale can say it becomes customer credit when it clears.
    invoiceSaleStatus: invoiceSale && invoiceSale.orgId === cheque.orgId ? invoiceSale.status : undefined,
    // SCRUM-447 D2/D5: lineage and the named drawer, for the read side. A row
    // with lineage but no recorded drawer is UNVERIFIED (drawerName null).
    isFinanceCompanyCheque,
    drawerName,
  };
}

async function hydratePayment(ctx: QueryCtx, payment: Doc<"collectionPayments">) {
  const [customer, vehicle, receivable] = await Promise.all([
    ctx.db.get(payment.customerId),
    getOptionalVehicle(ctx, payment.vehicleId),
    payment.receivableId ? ctx.db.get(payment.receivableId) : null,
  ]);
  return {
    ...payment,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
    receivableTitle: receivable?.title,
  };
}

export async function summaryHandler(ctx: QueryCtx, args: { orgId: Id<"organizations"> }) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const currency = await getOrgCurrency(ctx, args.orgId);

  const now = Date.now();
  // SCRUM-264: "today" is the organization's business day. A payment is an instant, so it is
  // bounded by the real span of that day; a due date is a calendar key (UTC midnight).
  const timeZone = await getOrgTimeZone(ctx, args.orgId);
  const today = calendarDateInTimeZone(timeZone, now);
  const todayWindow = orgDayWindow(timeZone, today);
  const dueDay = orgDayCalendarKeyRange(timeZone, now);
  const openStatuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED"];
  let totalOutstanding = 0;
  let overdueOutstanding = 0;
  let dueToday = 0;
  let receivablesIncomplete = false;

  for (const status of openStatuses) {
    const read = await ctx.db
      .query("receivables")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
      .take(COLLECTIONS_REPORT_ROW_CAP + 1);
    const { rows, incomplete } = capRows(read, COLLECTIONS_REPORT_ROW_CAP);
    receivablesIncomplete ||= incomplete;
    for (const row of rows) {
      totalOutstanding += row.outstandingAmount;
      if (row.dueDate < now || row.status === "OVERDUE") overdueOutstanding += row.outstandingAmount;
      if (row.dueDate >= dueDay.start && row.dueDate <= dueDay.end) dueToday += row.outstandingAmount;
    }
  }

  const todaysPayments = await readOrgDayPayments(ctx, args.orgId, todayWindow);
  const collectedToday = todaysPayments.rows
    .filter((payment) => payment.status === "POSTED")
    .reduce((sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount), 0);

  // Bounded by the week in the index range itself: a prefix of ALL future cheques, filtered
  // afterwards, could fill with later cheques and hide this week's. A cheque date is a calendar key
  // (00:00Z of its date), so the week runs from the organization's own date to seven days on, in
  // keys. Bounding it by the instant `now` dropped today's cheque from 00:00Z onward.
  const upcomingChequesRead = await ctx.db
    .query("postDatedCheques")
    .withIndex("by_org_chequeDate", (q) =>
      q.eq("orgId", args.orgId).gte("chequeDate", dueDay.start).lte("chequeDate", dueDay.start + 7 * DAY_MS)
    )
    .take(COLLECTIONS_UPCOMING_CHEQUE_CAP + 1);
  const upcomingCheques = capRows(upcomingChequesRead, COLLECTIONS_UPCOMING_CHEQUE_CAP);
  const upcomingChequesThisWeek = upcomingCheques.rows
    .filter((cheque) => cheque.status === "HELD" || cheque.status === "DEPOSITED");
  const upcomingChequeTotal = upcomingChequesThisWeek.reduce((sum, cheque) => sum + cheque.amount, 0);

  return {
    totalOutstanding: roundMoney(totalOutstanding, currency),
    overdueOutstanding: roundMoney(overdueOutstanding, currency),
    dueToday: roundMoney(dueToday, currency),
    collectedToday: roundMoney(collectedToday, currency),
    upcomingChequeTotal: roundMoney(upcomingChequeTotal, currency),
    upcomingChequeCount: upcomingChequesThisWeek.length,
    // Additive (SCRUM-265): true means the matching figures come from a capped read. For receivables
    // and cheques they are lower bounds; `collectedToday` nets refunds, so it may be higher or lower.
    // Older clients ignore it, so they keep showing the bounded number they showed before.
    incomplete: {
      receivables: receivablesIncomplete,
      collectedToday: todaysPayments.incomplete,
      upcomingCheques: upcomingCheques.incomplete,
    },
    // Additive (SCRUM-264): true means a posted payment could be on today or on a neighbouring day
    // and nothing stored says which, so it is left out of `collectedToday` (which is then also
    // `incomplete`). Only a refund the sale-completion deposit refund wrote at a date key can do this.
    paymentDateUncertain: {
      collectedToday: todaysPayments.uncertain,
    },
    // Additive (SCRUM-724): false while the pilot payout switch is on.
    retainedCreditPayoutAvailable: !isCustomerCreditPayoutDisabled(),
  };
}

export async function listReceivablesHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    paginationOpts: PaginationOptions;
    status?: Doc<"receivables">["status"];
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const result = args.status
    ? await ctx.db
        .query("receivables")
        .withIndex("by_org_status_and_dueDate", (q) =>
          q.eq("orgId", args.orgId).eq("status", args.status!)
        )
        .order("asc")
        .paginate(args.paginationOpts)
    : await ctx.db
        .query("receivables")
        .withIndex("by_org_dueDate", (q) => q.eq("orgId", args.orgId))
        .order("asc")
        .paginate(args.paginationOpts);

  return {
    ...result,
    page: await Promise.all(result.page.map((row) => hydrateReceivable(ctx, row))),
  };
}

export async function listReceivablesDueBetweenHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    startDate: number;
    endDate: number;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const rows = await ctx.db
    .query("receivables")
    .withIndex("by_org_dueDate", (q) =>
      q.eq("orgId", args.orgId).gte("dueDate", args.startDate).lte("dueDate", args.endDate)
    )
    .collect();
  const openRows = rows.filter((row) => !row.isDeleted && !["PAID", "CANCELLED", "REFUNDED"].includes(row.status));
  return Promise.all(openRows.map((row) => hydrateReceivable(ctx, row)));
}

export async function listChequesHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    paginationOpts: PaginationOptions;
    status?: Doc<"postDatedCheques">["status"];
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const result = args.status
    ? await ctx.db
        .query("postDatedCheques")
        .withIndex("by_org_status_and_chequeDate", (q) =>
          q.eq("orgId", args.orgId).eq("status", args.status!)
        )
        .order("asc")
        .paginate(args.paginationOpts)
    : await ctx.db
        .query("postDatedCheques")
        .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId))
        .order("asc")
        .paginate(args.paginationOpts);

  return {
    ...result,
    page: await Promise.all(result.page.map((row) => hydrateCheque(ctx, row))),
  };
}

export async function listPaymentsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    paginationOpts: PaginationOptions;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const result = await ctx.db
    .query("collectionPayments")
    .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId))
    .order("desc")
    .paginate(args.paginationOpts);

  return {
    ...result,
    page: await Promise.all(result.page.map((row) => hydratePayment(ctx, row))),
  };
}

export async function dailyCollectionListHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    businessDate: number;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const currency = await getOrgCurrency(ctx, args.orgId);
  const { window } = await orgBusinessDay(ctx, args.orgId, args.businessDate);
  const { rows: payments, incomplete, uncertain } = await readOrgDayPayments(ctx, args.orgId, window);
  const rows = payments.filter((payment) => payment.status === "POSTED");
  const totalsByMethod: Record<string, number> = {};
  for (const payment of rows) {
    totalsByMethod[payment.method] = roundMoney(
      (totalsByMethod[payment.method] ?? 0) + (payment.direction === "IN" ? payment.amount : -payment.amount),
      currency
    );
  }
  return {
    totalsByMethod,
    total: roundMoney(Object.values(totalsByMethod).reduce((sum, amount) => sum + amount, 0), currency),
    rows: await Promise.all(rows.map((payment) => hydratePayment(ctx, payment))),
    // Additive (SCRUM-265): true means the day held more payments than this report reads, so the
    // rows and totals are partial. The total nets refunds, so it may be higher or lower than the
    // true figure.
    incomplete,
    // Additive (SCRUM-264): true means a posted payment could be on this day or a neighbouring one and
    // nothing stored says which; it is left out of the rows and totals (and `incomplete` is also true).
    paymentDateUncertain: uncertain,
  };
}

export async function upcomingChequeReportHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    startDate: number;
    endDate: number;
  },
) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const currency = await getOrgCurrency(ctx, args.orgId);
  // The window is part of the index range, so the cap applies to the window and not to every
  // later cheque in the organization.
  const read = await ctx.db
    .query("postDatedCheques")
    .withIndex("by_org_chequeDate", (q) =>
      q.eq("orgId", args.orgId).gte("chequeDate", args.startDate).lte("chequeDate", args.endDate)
    )
    .take(COLLECTIONS_REPORT_ROW_CAP + 1);
  const { rows: cheques, incomplete } = capRows(read, COLLECTIONS_REPORT_ROW_CAP);
  const rows = cheques.filter((cheque) => cheque.status === "HELD" || cheque.status === "DEPOSITED");
  return {
    total: roundMoney(rows.reduce((sum, cheque) => sum + cheque.amount, 0), currency),
    rows: await Promise.all(rows.map((cheque) => hydrateCheque(ctx, cheque))),
    // Additive (SCRUM-265): true means the window held more cheques than this report reads.
    incomplete,
  };
}

export async function agingReportHandler(ctx: QueryCtx, args: { orgId: Id<"organizations"> }) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const currency = await getOrgCurrency(ctx, args.orgId);
  const now = Date.now();
  const statuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED"];
  const buckets = {
    current: { count: 0, amount: 0 },
    days1To30: { count: 0, amount: 0 },
    days31To60: { count: 0, amount: 0 },
    days61To90: { count: 0, amount: 0 },
    over90: { count: 0, amount: 0 },
  };

  let incomplete = false;
  for (const status of statuses) {
    const read = await ctx.db
      .query("receivables")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
      .take(COLLECTIONS_REPORT_ROW_CAP + 1);
    const capped = capRows(read, COLLECTIONS_REPORT_ROW_CAP);
    incomplete ||= capped.incomplete;
    for (const row of capped.rows) {
      const ageDays = Math.floor((now - row.dueDate) / DAY_MS);
      const bucket = ageDays <= 0
        ? buckets.current
        : ageDays <= 30
          ? buckets.days1To30
          : ageDays <= 60
            ? buckets.days31To60
            : ageDays <= 90
              ? buckets.days61To90
              : buckets.over90;
      bucket.count += 1;
      bucket.amount = roundMoney(bucket.amount + row.outstandingAmount, currency);
    }
  }

  // Additive (SCRUM-265): true means a status held more receivables than this report reads, so
  // every bucket is a lower bound.
  return { ...buckets, incomplete };
}
