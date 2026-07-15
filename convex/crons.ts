import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, MutationCtx, ActionCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { notifyManagers, notifyUser } from "./utils/notifications";
import { PLANS, PlanId } from "./subscriptions";
import { Doc, Id } from "./_generated/dataModel";
import { isSystemOwnerRole } from "./utils/permissions";

const crons = cronJobs();

// Run every 5 minutes to check for upcoming tasks
crons.interval(
  "check-upcoming-tasks",
  { minutes: 5 }, // Every 5 minutes
  internal.crons.triggerAlarms
);

// Run daily at 08:00 UTC (11:00 Jordan time) to send subscription reminders
crons.cron(
  "subscription-reminders",
  "0 8 * * *",
  internal.crons.triggerSubscriptionReminders,
  {}
);

// Run daily at 06:30 UTC (09:30 Jordan time) for receivable and cheque reminders.
crons.cron(
  "collection-reminders",
  "30 6 * * *",
  internal.collections.processDailyCollectionReminders,
  {}
);

// Expire stale marketplace buyer requests (Phase 57) past their expiresAt.
crons.cron(
  "expire-marketplace-requests",
  "0 3 * * *",
  internal.marketplaceRequests.expireStaleRequests,
  {}
);

// Weekly dealer proof report (Phase 58B) — Mondays at 06:00 UTC (09:00 Jordan time).
crons.cron(
  "marketplace-weekly-dealer-report",
  "0 6 * * 1",
  internal.marketplaceReports.sendWeeklyProofReports,
  {}
);

// Recompute marketplace dealer badges (Phase 60) — daily; also refreshed
// immediately on the events that most commonly change them (a response
// scored, a phone manually verified) so this is a freshness backstop, not
// the only path.
crons.cron(
  "marketplace-recompute-dealer-badges",
  "30 3 * * *",
  internal.marketplaceDealers.recomputeAllDealerBadges,
  {}
);

// Retry membership removals whose external Clerk cleanup did not complete.
crons.interval(
  "membership-offboarding-retries",
  { minutes: 5 },
  internal.memberships.drainDueMembershipOffboardingJobs,
  {}
);

// Release expired inventory reservations and their non-financial vehicle holds.
crons.interval(
  "expire-vehicle-reservations",
  { minutes: 15 },
  internal.vehicles.expireReservations,
  {}
);

// Refresh Instagram long-lived tokens for orgs whose token expires within 7 days.
// Instagram tokens last 60 days; refreshing weekly keeps them perpetually valid.
crons.cron(
  "instagram-token-refresh",
  "0 5 * * *",
  internal.crons.triggerInstagramTokenRefresh,
  {}
);

// Scan for webhook events stuck in "received" status for >2 h and flag them as
// dead_letter so they surface clearly in the admin Webhook Delivery Log.
crons.interval(
  "dead-letter-webhook-scan",
  { hours: 2 },
  internal.adminSystem.scanDeadLetterWebhooks,
  {}
);

// Retry Facebook/Instagram auto-replies that failed on the initial webhook
// send. Picks up events where pendingAutoReplyText is set but autoRepliedAt
// is not, retries up to 3 times, then leaves the conversation as
// "needs reply" in the Social Inbox for manual follow-up.
crons.interval(
  "social-auto-reply-retries",
  { minutes: 15 },
  internal.crons.triggerSocialAutoReplyRetries,
  {}
);

// GL Phase 11: post one month of straight-line depreciation for every ACTIVE
// fixed asset, across every org. Runs once a month; depreciateAssetForMonth
// is idempotent per (assetId, yearMonth) so a redrive/redeploy can't double-post.
crons.cron(
  "fixed-asset-depreciation",
  "0 3 1 * *",
  internal.crons.triggerFixedAssetDepreciation,
  {}
);

// GL Phase 19: post one month of ratable F&I commission recognition for every
// ACTIVE dealer product deferral (resold warranty/GAP margin), across every
// org. Runs once a month, same idempotency reasoning as the depreciation cron
// above — recognizeDeferredCommissionForMonth is idempotent per
// (deferralId, yearMonth).
crons.cron(
  "fi-commission-recognition",
  "0 4 1 * *",
  internal.crons.triggerFiCommissionRecognition,
  {}
);

// Post one calendar month of prepaid-expense amortization for every ACTIVE
// prepaid schedule, across every org. Same monthly shape and idempotency
// reasoning as the two crons above — amortizePrepaidExpenseForMonth recognizes
// the delta due through its calendar month, so a re-run posts nothing and a
// missed month is caught up.
crons.cron(
  "prepaid-expense-amortization",
  "0 5 1 * *",
  internal.crons.triggerPrepaidExpenseAmortization,
  {}
);

export default crons;

export const triggerAlarms = internalMutation({
  args: {},
  handler: async (ctx) => {
    try {
      const result = await runTriggerAlarms(ctx);
      await ctx.db.insert("cronHeartbeats", { jobName: "check-upcoming-tasks", ranAt: Date.now(), success: true, detail: result });
      return result;
    } catch (err) {
      await ctx.db.insert("cronHeartbeats", {
        jobName: "check-upcoming-tasks",
        ranAt: Date.now(),
        success: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

async function runTriggerAlarms(ctx: MutationCtx) {
  const now = Date.now();
  // Look for tasks due in the next 15 minutes (or overdue) that haven't been triggered
  const upcomingThreshold = now + 15 * 60 * 1000;

  const allPendingTasks = await ctx.db
    .query("tasks")
    .withIndex("by_status_alarm", (q) => q.eq("status", "PENDING"))
    .filter((q) => q.neq(q.field("alarmTriggered"), true))
    .collect();

  let triggeredCount = 0;

  for (const task of allPendingTasks) {
    if (task.dueDate <= upcomingThreshold) {
      // Mark as triggered
      await ctx.db.patch(task._id, { alarmTriggered: true });

      // Create in-app notification for the assignee
      await notifyUser(
        ctx,
        task.orgId,
        task.assignedTo,
        "task.due_soon",
        { taskTitle: task.title, dueTime: new Date(task.dueDate).toLocaleTimeString() },
        { link: `/${task.orgId}/tasks`, relatedTaskId: task._id }
      );

      // Fetch assignee details for notifications and email
      const assignee = await ctx.db.get(task.assignedTo);
      const assigneeName = assignee ? (assignee.name || assignee.email) : 'someone';
      const email = assignee?.email;

      // Notify managers about the upcoming/overdue task
      await notifyManagers(
        ctx,
        task.orgId,
        "task.overdue_warning",
        { taskTitle: task.title, assigneeName },
        { link: "/tasks" }
      );

      if (email) {
        await ctx.scheduler.runAfter(0, internal.email.sendTaskAlarm, {
          toEmail: email,
          taskTitle: task.title,
          taskDescription: task.description,
          dueDate: task.dueDate,
        });
      }

      triggeredCount++;
    }
  }

  return `Triggered alarms for ${triggeredCount} tasks.`;
}

// ─── Subscription reminder cron ───────────────────────────────────────────────

export const triggerSubscriptionReminders = internalAction({
  args: {},
  handler: async (ctx: ActionCtx) => {
    try {
      const result = await runSubscriptionReminders(ctx);
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "subscription-reminder",
        status: "success",
        summary: result,
      });
      return result;
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "subscription-reminder",
        status: "error",
        summary: "subscription-reminders cron failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

async function runSubscriptionReminders(ctx: ActionCtx): Promise<string> {
  let sent = 0;

  // Send renewal reminders 2 days before the next billing date for paid orgs
  const expiringRenewals = await ctx.runQuery(internal.subscriptions.getExpiringRenewals, {
    withinMs: TWO_DAYS_MS,
  });

  for (const sub of expiringRenewals) {
    const ownerEmail = await ctx.runQuery(internal.crons.getOrgOwnerEmail, { orgId: sub.orgId });
    const org = await ctx.runQuery(internal.organizations.getInternal, { orgId: sub.orgId });

    if (ownerEmail && org) {
      await ctx.runAction(internal.email.sendSubscriptionReminderEmail, {
        toEmail: ownerEmail,
        orgName: org.name,
        kind: "renewal_due",
        planName: PLANS[sub.plan as PlanId].name,
        endsAt: sub.currentPeriodEnd ?? Date.now(),
        priceJod: PLANS[sub.plan as PlanId].priceJod,
      });
      await ctx.runMutation(internal.subscriptions.markRenewalReminderSent, {
        subscriptionId: sub._id,
      });
      sent++;
    }
  }

  return `Sent ${sent} renewal reminder(s).`;
}

// ─── Instagram token refresh cron ────────────────────────────────────────────

export const triggerInstagramTokenRefresh = internalAction({
  args: {},
  handler: async (ctx: ActionCtx) => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const orgs: Doc<"orgSettings">[] = await ctx.runQuery(
      internal.socialIntegrations.getOrgsNeedingInstagramRefresh,
      { withinMs: SEVEN_DAYS_MS }
    );

    let refreshed = 0;
    for (const org of orgs) {
      try {
        await ctx.runAction(internal.socialIntegrations.refreshInstagramToken, {
          orgId: org.orgId,
        });
        refreshed++;
      } catch (err) {
        // Individual failures are already logged inside refreshInstagramToken;
        // continue so one bad token doesn't block the rest.
      }
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "instagram",
      status: "success",
      summary: `Instagram token refresh cron: refreshed ${refreshed}/${orgs.length} token(s).`,
    });

    return `Refreshed ${refreshed}/${orgs.length} Instagram token(s).`;
  },
});

export const triggerSocialAutoReplyRetries = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<string> => {
    try {
      const result: string = await ctx.runAction(
        internal.socialAutoReplyRetry.retryPendingSocialAutoReplies,
        {}
      );
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "social-auto-reply-retry",
        status: "success",
        summary: result,
      });
      return result;
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "social-auto-reply-retry",
        status: "error",
        summary: "social-auto-reply-retries cron failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

// ─── GL Phase 11: monthly fixed-asset depreciation cron ──────────────────────

type DepreciationOutcome = "posted" | "skippedNoOwner" | "skippedOther";

type DepreciationRunStats = {
  total: number;
  posted: number;
  skippedNoOwner: number;
  skippedOther: number;
};

async function getCachedOrgOwnerUserId(
  ctx: ActionCtx,
  ownerByOrg: Map<string, Id<"users"> | null>,
  orgId: Id<"organizations">
): Promise<Id<"users"> | null> {
  const orgKey = orgId.toString();
  if (!ownerByOrg.has(orgKey)) {
    const ownerUserId = await ctx.runQuery(internal.crons.getOrgOwnerUserId, { orgId });
    ownerByOrg.set(orgKey, ownerUserId);
  }
  return ownerByOrg.get(orgKey) ?? null;
}

async function depreciateCronAsset(
  ctx: ActionCtx,
  asset: Doc<"fixedAssets">,
  args: {
    ownerByOrg: Map<string, Id<"users"> | null>;
    yearMonth: string;
    occurredAt: number;
  }
): Promise<DepreciationOutcome> {
  const systemActorId = await getCachedOrgOwnerUserId(ctx, args.ownerByOrg, asset.orgId);
  if (!systemActorId) {
    return "skippedNoOwner";
  }

  const result = await ctx.runMutation(internal.fixedAssets.depreciateAssetForMonth, {
    orgId: asset.orgId,
    assetId: asset._id,
    yearMonth: args.yearMonth,
    occurredAt: args.occurredAt,
    systemActorId,
  });
  return result.posted ? "posted" : "skippedOther";
}

function recordDepreciationOutcome(stats: DepreciationRunStats, outcome: DepreciationOutcome): void {
  stats.total++;
  stats[outcome]++;
}

async function runFixedAssetDepreciation(
  ctx: ActionCtx,
  args: { yearMonth: string; occurredAt: number }
): Promise<DepreciationRunStats> {
  const ownerByOrg = new Map<string, Id<"users"> | null>();
  const stats: DepreciationRunStats = {
    total: 0,
    posted: 0,
    skippedNoOwner: 0,
    skippedOther: 0,
  };

  // Drain every page so assets past the page cap are not silently skipped.
  let cursor: string | undefined;
  do {
    const page = await ctx.runQuery(internal.fixedAssets.listActiveAssetsForDepreciation, { cursor });
    for (const asset of page.page) {
      const outcome = await depreciateCronAsset(ctx, asset, {
        ownerByOrg,
        yearMonth: args.yearMonth,
        occurredAt: args.occurredAt,
      });
      recordDepreciationOutcome(stats, outcome);
    }
    cursor = page.isDone ? undefined : page.continueCursor;
  } while (cursor);

  return stats;
}

function depreciationSummary(yearMonth: string, stats: DepreciationRunStats): string {
  return `Depreciation ${yearMonth}: posted ${stats.posted}/${stats.total} asset(s), ${stats.skippedNoOwner} skipped (no org owner), ${stats.skippedOther} skipped (already run / not yet started / inactive / fully depreciated).`;
}

export const triggerFixedAssetDepreciation = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<string> => {
    try {
      const now = Date.now();
      const d = new Date(now);
      const yearMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const stats = await runFixedAssetDepreciation(ctx, { yearMonth, occurredAt: now });
      const summary = depreciationSummary(yearMonth, stats);
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "fixed-asset-depreciation",
        status: "success",
        summary,
      });
      return summary;
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "fixed-asset-depreciation",
        status: "error",
        summary: "fixed-asset-depreciation cron failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

// ─── GL Phase 19: monthly F&I commission recognition cron ────────────────────
// Same shape as the fixed-asset depreciation cron above, one section up —
// paginated cross-org scan, cached per-org owner resolution, one mutation
// call per row, admin audit log on completion/failure.

type RecognitionOutcome = "posted" | "skippedNoOwner" | "skippedOther";

type RecognitionRunStats = {
  total: number;
  posted: number;
  skippedNoOwner: number;
  skippedOther: number;
};

async function recognizeCronDeferral(
  ctx: ActionCtx,
  deferral: Doc<"dealerProductDeferrals">,
  args: {
    ownerByOrg: Map<string, Id<"users"> | null>;
    yearMonth: string;
    occurredAt: number;
  }
): Promise<RecognitionOutcome> {
  const systemActorId = await getCachedOrgOwnerUserId(ctx, args.ownerByOrg, deferral.orgId);
  if (!systemActorId) {
    return "skippedNoOwner";
  }

  const result = await ctx.runMutation(internal.dealerProductDeferrals.recognizeDeferredCommissionForMonth, {
    orgId: deferral.orgId,
    deferralId: deferral._id,
    yearMonth: args.yearMonth,
    occurredAt: args.occurredAt,
    systemActorId,
  });
  return result.posted ? "posted" : "skippedOther";
}

function recordRecognitionOutcome(stats: RecognitionRunStats, outcome: RecognitionOutcome): void {
  stats.total++;
  stats[outcome]++;
}

async function runFiCommissionRecognition(
  ctx: ActionCtx,
  args: { yearMonth: string; occurredAt: number }
): Promise<RecognitionRunStats> {
  const ownerByOrg = new Map<string, Id<"users"> | null>();
  const stats: RecognitionRunStats = {
    total: 0,
    posted: 0,
    skippedNoOwner: 0,
    skippedOther: 0,
  };

  let cursor: string | undefined;
  do {
    const page = await ctx.runQuery(internal.dealerProductDeferrals.listActiveDeferralsForRecognition, { cursor });
    for (const deferral of page.page) {
      const outcome = await recognizeCronDeferral(ctx, deferral, {
        ownerByOrg,
        yearMonth: args.yearMonth,
        occurredAt: args.occurredAt,
      });
      recordRecognitionOutcome(stats, outcome);
    }
    cursor = page.isDone ? undefined : page.continueCursor;
  } while (cursor);

  return stats;
}

function recognitionSummary(yearMonth: string, stats: RecognitionRunStats): string {
  return `F&I commission recognition ${yearMonth}: posted ${stats.posted}/${stats.total} deferral(s), ${stats.skippedNoOwner} skipped (no org owner), ${stats.skippedOther} skipped (already run / fully recognized / not active).`;
}

export const triggerFiCommissionRecognition = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<string> => {
    try {
      const now = Date.now();
      const d = new Date(now);
      const yearMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const stats = await runFiCommissionRecognition(ctx, { yearMonth, occurredAt: now });
      const summary = recognitionSummary(yearMonth, stats);
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "fi-commission-recognition",
        status: "success",
        summary,
      });
      return summary;
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "fi-commission-recognition",
        status: "error",
        summary: "fi-commission-recognition cron failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

// ─── Monthly prepaid-expense amortization cron ───────────────────────────────
// Same shape as the F&I commission recognition cron above — paginated cross-org
// scan, cached per-org owner resolution, one mutation call per schedule row,
// admin audit log on completion/failure.

type PrepaidAmortizationOutcome = "posted" | "skippedNoOwner" | "skippedOther";

type PrepaidAmortizationRunStats = {
  total: number;
  posted: number;
  skippedNoOwner: number;
  skippedOther: number;
  failed: number;
};

async function amortizeCronSchedule(
  ctx: ActionCtx,
  schedule: Doc<"prepaidExpenseSchedules">,
  args: {
    ownerByOrg: Map<string, Id<"users"> | null>;
    currentYearMonth: string;
    now: number;
  }
): Promise<PrepaidAmortizationOutcome> {
  const systemActorId = await getCachedOrgOwnerUserId(ctx, args.ownerByOrg, schedule.orgId);
  if (!systemActorId) {
    return "skippedNoOwner";
  }

  // Recognize every missing calendar month in its OWN month — from the first
  // month not yet recognized through the current month — never lumping missed
  // months into the present. catchUpScheduleMutation shares its recognition
  // logic (catchUpPrepaidSchedule) with the accountant-triggered manual run, is
  // idempotent per month, refuses months at/before the last recognized one, and
  // each posting is dated to its month, so a month whose period is already
  // closed parks in the outbox (postOrEnqueue) rather than posting into a
  // closed period. Re-drives are safe.
  const result = await ctx.runMutation(internal.prepaidExpenses.catchUpScheduleMutation, {
    orgId: schedule.orgId,
    scheduleId: schedule._id,
    throughYearMonth: args.currentYearMonth,
    now: args.now,
    systemActorId,
  });
  return result.monthsPosted > 0 ? "posted" : "skippedOther";
}

async function runPrepaidExpenseAmortization(
  ctx: ActionCtx,
  args: { currentYearMonth: string; now: number }
): Promise<PrepaidAmortizationRunStats> {
  const ownerByOrg = new Map<string, Id<"users"> | null>();
  const stats: PrepaidAmortizationRunStats = {
    total: 0,
    posted: 0,
    skippedNoOwner: 0,
    skippedOther: 0,
    failed: 0,
  };

  let cursor: string | undefined;
  do {
    const page = await ctx.runQuery(internal.prepaidExpenses.listActivePrepaidSchedulesForRecognition, { cursor });
    for (const schedule of page.page) {
      stats.total++;
      try {
        // One malformed schedule (e.g. a chart-of-accounts conflict) must not
        // abort the whole cross-org run and starve every later organization —
        // isolate the failure, count it, and keep going.
        const outcome = await amortizeCronSchedule(ctx, schedule, {
          ownerByOrg,
          currentYearMonth: args.currentYearMonth,
          now: args.now,
        });
        stats[outcome]++;
      } catch (err) {
        stats.failed++;
        // Previously only the aggregate counter above recorded this — the
        // schedule, org, and error itself were discarded, leaving nothing an
        // accountant or support engineer could act on. Record the specifics
        // and alert the org owner so a stuck schedule doesn't sit silent until
        // someone happens to notice a missing month in a report.
        await ctx.runMutation(internal.prepaidExpenses.recordAmortizationFailure, {
          orgId: schedule.orgId,
          scheduleId: schedule._id,
          yearMonth: args.currentYearMonth,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = page.isDone ? undefined : page.continueCursor;
  } while (cursor);

  return stats;
}

export const triggerPrepaidExpenseAmortization = internalAction({
  args: {},
  handler: async (ctx: ActionCtx): Promise<string> => {
    try {
      const now = Date.now();
      const d = new Date(now);
      const currentYearMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const stats = await runPrepaidExpenseAmortization(ctx, { currentYearMonth, now });
      const summary = `Prepaid expense amortization ${currentYearMonth}: posted ${stats.posted}/${stats.total} schedule(s), ${stats.skippedNoOwner} skipped (no org owner), ${stats.skippedOther} skipped (already run / fully amortized / not active), ${stats.failed} failed.`;
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "prepaid-expense-amortization",
        status: "success",
        summary,
      });
      return summary;
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "prepaid-expense-amortization",
        status: "error",
        summary: "prepaid-expense-amortization cron failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

/** Shared by getOrgOwnerEmail/getOrgOwnerUserId: finds the org's OWNER-role member's user doc. */
async function findOrgOwnerUser(ctx: QueryCtx, orgId: Id<"organizations">): Promise<Doc<"users"> | null> {
  // Role *definitions* per org are inherently few (the role list, not member
  // assignments), so collect() is safe here — while a .take(N) cap could
  // silently miss the owner role in an org with many custom roles.
  const roles = await ctx.db
    .query("roles")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();
  const ownerRole = roles.find((r) => isSystemOwnerRole(r));
  if (!ownerRole) return null;

  // Filter by roleId inside the query rather than slicing N memberships
  // client-side — an org with more members than any cap would otherwise
  // "lose" its owner and silently skip automated postings.
  const ownerMembership = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("roleId"), ownerRole._id))
    .first();
  if (!ownerMembership) return null;

  return await ctx.db.get(ownerMembership.userId);
}

/** Returns the email address of the org's OWNER-role member. */
export const getOrgOwnerEmail = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const owner = await findOrgOwnerUser(ctx, args.orgId);
    return owner?.email ?? null;
  },
});

/** Returns the user _id of the org's OWNER-role member — used to attribute automated/system postings (e.g. the depreciation cron) to a real user, since accounting records require a real actorId. */
export const getOrgOwnerUserId = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const owner = await findOrgOwnerUser(ctx, args.orgId);
    return owner?._id ?? null;
  },
});
