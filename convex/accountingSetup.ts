import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, roleHasPermission } from "./utils/permissions";
import { isOutboxRowRevivable } from "./accountingOutbox";
import { requireFeature } from "./subscriptions";
import { REQUIRED_SYSTEM_KEYS } from "./utils/defaultChart";

type AccountingPeriodStatus = "FUTURE" | "OPEN" | "CLOSING" | "CLOSED" | "LOCKED";
type PendingAccountingStatus = "PENDING" | "POSTED" | "FAILED";

type PeriodSummary = {
  _id: Id<"accountingPeriods">;
  fiscalYear: number;
  periodNumber: number;
  startDate: number;
  endDate: number;
  status: AccountingPeriodStatus;
};

type PendingEventSummary = {
  _id: Id<"pendingAccountingEvents">;
  kind: "POST" | "REVERSE";
  status: PendingAccountingStatus;
  eventType?: string;
  sourceType: string;
  sourceId: string;
  accountingDate: number;
  attempts: number;
  createdAt: number;
  reason?: string;
};

function periodSummary(period: PeriodSummary): PeriodSummary {
  return {
    _id: period._id,
    fiscalYear: period.fiscalYear,
    periodNumber: period.periodNumber,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
  };
}

function pendingEventSummary(event: PendingEventSummary): PendingEventSummary {
  return {
    _id: event._id,
    kind: event.kind,
    status: event.status,
    eventType: event.eventType,
    sourceType: event.sourceType,
    sourceId: event.sourceId,
    accountingDate: event.accountingDate,
    attempts: event.attempts,
    createdAt: event.createdAt,
    reason: event.reason,
  };
}

const OUTBOX_SAMPLE_LIMIT = 10;
const FAILURE_REASON_MAX_CHARS = 300;

// Reads limit + 1 rows so `hasMore` is known without a second query.
async function takeByStatus(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  status: PendingAccountingStatus,
  limit: number
) {
  const sample = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
    .order("desc")
    .take(limit + 1);
  return { rows: sample.slice(0, limit), hasMore: sample.length > limit };
}

// A dead-lettered row's reason is what the last attempt recorded in
// `lastError` (the enqueue-time `reason` is only why it was deferred). It is
// truncated and never accompanied by the payload. `retryable` is computed by
// the same predicate `reviveFailedEntry` enforces, so Retry is never offered
// on a row the server will refuse.
function failedEventSummary(
  event: PendingEventSummary & { lastError?: string }
): PendingEventSummary & { retryable: boolean } {
  const failure = event.lastError ?? event.reason;
  return {
    ...pendingEventSummary(event),
    reason: failure === undefined ? undefined : failure.slice(0, FAILURE_REASON_MAX_CHARS),
    retryable: isOutboxRowRevivable(event),
  };
}

export const status = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");

    const firstAccount = await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();

    const missingSystemAccountKeys: string[] = [];
    for (const key of REQUIRED_SYSTEM_KEYS) {
      const account = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", args.orgId).eq("systemKey", key))
        .unique();
      if (!account || !account.active) missingSystemAccountKeys.push(key);
    }

    const openPeriods = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "OPEN"))
      .order("desc")
      .take(12);
    const now = Date.now();
    const currentOpenPeriod = openPeriods.find(
      (period) => period.startDate <= now && period.endDate >= now
    );

    const recentPeriods = await ctx.db
      .query("accountingPeriods")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(24);
    recentPeriods.sort((a, b) => {
      if (a.fiscalYear !== b.fiscalYear) return b.fiscalYear - a.fiscalYear;
      return b.periodNumber - a.periodNumber;
    });

    // SCRUM-226 — dead-lettered (FAILED) rows are invisible to a PENDING-only
    // sample, so the operator could never see or retry them. Same index, same
    // bound; FAILED rows are read only for callers who can act on them
    // (`retryFailed` requires MANAGE_FINANCE).
    const canManageFinance = roleHasPermission(auth.role, PERMISSIONS.MANAGE_FINANCE);
    const [pending, failed] = await Promise.all([
      takeByStatus(ctx, args.orgId, "PENDING", OUTBOX_SAMPLE_LIMIT),
      canManageFinance
        ? takeByStatus(ctx, args.orgId, "FAILED", OUTBOX_SAMPLE_LIMIT)
        : Promise.resolve({ rows: [], hasMore: false }),
    ]);

    return {
      chartInitialized: firstAccount !== null,
      systemAccountsValid: missingSystemAccountKeys.length === 0,
      missingSystemAccountKeys,
      currentOpenPeriod: currentOpenPeriod ? periodSummary(currentOpenPeriod) : null,
      recentPeriods: recentPeriods.map(periodSummary),
      pendingEvents: pending.rows.map(pendingEventSummary),
      hasMorePendingEvents: pending.hasMore,
      failedEvents: failed.rows.map(failedEventSummary),
      hasMoreFailedEvents: failed.hasMore,
    };
  },
});
