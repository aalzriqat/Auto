import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, MutationCtx, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { notifyManagers, notifyUser } from "./utils/notifications";
import { PLANS, PlanId } from "./subscriptions";
import { Doc } from "./_generated/dataModel";
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

/** Returns the email address of the org's OWNER-role member. */
export const getOrgOwnerEmail = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const roles = await ctx.db
      .query("roles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(20);
    const ownerRole = roles.find((r) => isSystemOwnerRole(r));
    if (!ownerRole) return null;

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(50);
    const ownerMembership = memberships.find((m) => m.roleId === ownerRole._id);
    if (!ownerMembership) return null;

    const user = await ctx.db.get(ownerMembership.userId);
    return user?.email ?? null;
  },
});
