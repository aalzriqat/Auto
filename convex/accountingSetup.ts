import { v } from "convex/values";
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
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

const FAILURE_REASON_MAX_CHARS = 300;

// A dead-lettered row's reason is what the last attempt recorded in
// `lastError` (the enqueue-time `reason` is only why it was deferred). It is
// truncated and never accompanied by the payload.
function failedEventSummary(
  event: PendingEventSummary & { lastError?: string }
): PendingEventSummary {
  const summary = pendingEventSummary(event);
  const failure = event.lastError ?? event.reason;
  return {
    ...summary,
    reason: failure === undefined ? undefined : failure.slice(0, FAILURE_REASON_MAX_CHARS),
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

    const pendingSample = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .order("desc")
      .take(11);
    const pendingEvents = pendingSample.slice(0, 10);

    // SCRUM-226 — dead-lettered (FAILED) rows are invisible to the PENDING
    // sample above, so the operator could never see or retry them. Same index,
    // same bound; shown only to callers who can actually act on them
    // (`retryFailed` requires MANAGE_FINANCE).
    const canManageFinance =
      isSystemOwnerRole(auth.role) || auth.role.permissions.includes(PERMISSIONS.MANAGE_FINANCE);
    const failedSample = canManageFinance
      ? await ctx.db
          .query("pendingAccountingEvents")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "FAILED"))
          .order("desc")
          .take(11)
      : [];
    const failedEvents = failedSample.slice(0, 10);

    return {
      chartInitialized: firstAccount !== null,
      systemAccountsValid: missingSystemAccountKeys.length === 0,
      missingSystemAccountKeys,
      currentOpenPeriod: currentOpenPeriod ? periodSummary(currentOpenPeriod) : null,
      recentPeriods: recentPeriods.map(periodSummary),
      pendingEvents: pendingEvents.map(pendingEventSummary),
      hasMorePendingEvents: pendingSample.length > pendingEvents.length,
      failedEvents: failedEvents.map(failedEventSummary),
      hasMoreFailedEvents: failedSample.length > failedEvents.length,
    };
  },
});
