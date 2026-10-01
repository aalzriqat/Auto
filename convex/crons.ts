import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internalQuery, internalAction, MutationCtx, ActionCtx, QueryCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { internal } from "./_generated/api";
import { notifyManagers, notifyUser } from "./utils/notifications";
import { PLANS, PlanId } from "./subscriptions";
import { Doc, Id } from "./_generated/dataModel";
import { isSystemOwnerRole } from "./utils/permissions";
import { toYearMonth } from "./utils/expenseAmortization";
import type { DepreciationSkipReason } from "./fixedAssets";
import type { RecognitionSkipReason } from "./dealerProductDeferrals";
import { firstOfferableMonthIndex, occurredAtForMonthIndex, yearMonthFromIndex, yearMonthIndex } from "./utils/expenseAmortization";

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

// Move subscriptions whose paid period has ended to `expired`.
//
// Entitlement used to be re-derived from `Date.now()` on every read. That did
// not make the plan-gated queries uncacheable outright; it bounded how long
// each cached result could be reused, and at the client's re-subscription
// interval the bound always expired first, so none of them were ever served
// from cache (SCRUM-145). The read path now trusts stored state, so this job is
// what makes that state true.
//
// ⚠️ FIVE MINUTES IS THE CONTRACT. The owner separately said a one-hour lapse
// would not harm the business; that is the failure budget if a run is missed,
// NOT permission to lengthen this interval. Anyone widening it is changing the
// entitlement guarantee and needs a fresh owner decision, not this comment.
//
// The sweep also self-schedules while a full page still makes progress, so a
// cohort larger than one batch does not push the tail past five minutes.
crons.interval(
  "reconcile-expired-subscriptions",
  { minutes: 5 },
  internal.subscriptions.reconcileExpiredSubscriptions,
  {}
);

// Release expired inventory reservations and their non-financial vehicle holds.
crons.interval(
  "expire-vehicle-reservations",
  { minutes: 15 },
  internal.vehicles.expireReservations,
  {}
);

// SCRUM-208 c15825 — settle vehicle authority owed by completed accounting
// reversals, and observe what became of each settlement execution.
//
// ⚠️ THIS IS DELIBERATELY NOT ATTACHED TO ACCOUNTING TRAFFIC. The predecessor
// re-offered owed work when an organization's accounting drain finished, which
// meant an organization that stopped draining stopped retrying — a car's
// authority left unresolved indefinitely with nothing to surface it. A fixed
// tick over `nextActionAt` is the whole point.
//
// One minute, because the queue holds cars whose commitment state is unsettled
// and a salesperson may be about to promise one of them twice. It is bounded
// per tick and reads an exact due-time range, so an empty queue costs one
// indexed read.
crons.interval(
  "dispatch-authority-work",
  { minutes: 1 },
  internal.accountingOutbox.dispatchDueAuthorityWork,
  {}
);

// SCRUM-222 — dispatch due GL posting work, and observe what became of each
// worker execution.
//
// ⚠️ THE SAME "NOT ATTACHED TO ACCOUNTING TRAFFIC" RULE, FOR THE SAME REASON.
// An outbox row used to be retried only when something else caused a drain — a
// period opening, a chart being initialized, an operator pressing redrive. An
// organization that never triggered one of those never retried, so a transient
// failure could park real GL work indefinitely with nothing to surface it.
// Eager dispatch still exists and is still worth having, but it buys LATENCY
// only: losing an eager schedule must never cost liveness.
//
// This tick also owns RECOVERY of a lost worker. A row claimed by a scheduled
// function that never reported back is re-observed from here — never
// re-dispatched — which is why the selector reads a claimed-and-overdue range
// as well as an unclaimed one.
//
// Bounded per tick and reading exact due-time ranges, so an empty queue costs
// two indexed reads.
crons.interval(
  "dispatch-outbox-work",
  { minutes: 1 },
  internal.accountingOutbox.dispatchDueOutboxWork,
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

// Delete cronHeartbeats/webhookLogs rows past their retention window. Both are
// append-only diagnostics that nothing pruned, and the admin Cron Status panel
// re-read every heartbeat on every insert — together the largest source of
// database bandwidth on this deployment.
crons.interval(
  "prune-operational-logs",
  { hours: 1 },
  internal.adminSystem.pruneOperationalLogs,
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

  // `alarmTriggered` is the second field of by_status_alarm, so untriggered
  // tasks can be read directly from the index instead of being sifted out
  // afterwards. The previous shape — withIndex(status) + .filter(alarmTriggered
  // != true) + .collect() — was a POST-READ filter: it loaded every PENDING
  // task in the entire deployment, including ones already alarmed, on every
  // 5-minute run. Alarmed tasks stay PENDING until a human completes them, so
  // that read set only ever grew; once it crossed Convex's per-mutation read
  // limit this cron would throw on every run and alarms would stop firing for
  // every tenant at once. Two bounded index reads instead, since a range can't
  // express "!= true" over an optional boolean (undefined | false | true).
  const ALARM_SCAN_LIMIT = 500;
  const [neverFlagged, explicitlyFalse] = await Promise.all([
    ctx.db
      .query("tasks")
      .withIndex("by_status_alarm", (q) =>
        q.eq("status", "PENDING").eq("alarmTriggered", undefined)
      )
      .take(ALARM_SCAN_LIMIT),
    ctx.db
      .query("tasks")
      .withIndex("by_status_alarm", (q) =>
        q.eq("status", "PENDING").eq("alarmTriggered", false)
      )
      .take(ALARM_SCAN_LIMIT),
  ]);
  const allPendingTasks = [...neverFlagged, ...explicitlyFalse];

  // A task only leaves this candidate pool once its alarm fires, and the index
  // returns oldest-created-first with no org partitioning. So if untriggered
  // PENDING tasks ever exceed the cap, old far-future tasks can hold every scan
  // slot ahead of newer ones that are actually due, and their alarms are delayed
  // indefinitely — the same starvation the unbounded read caused, just under the
  // cap and silent. Saturating the limit is the signal that this is happening.
  if (neverFlagged.length === ALARM_SCAN_LIMIT || explicitlyFalse.length === ALARM_SCAN_LIMIT) {
    console.warn(
      `[crons] triggerAlarms hit the ${ALARM_SCAN_LIMIT}-task scan limit ` +
        `(neverFlagged=${neverFlagged.length}, explicitlyFalse=${explicitlyFalse.length}). ` +
        `Due alarms may be starved behind older untriggered tasks.`
    );
  }

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
        orgId: sub.orgId,
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
  // Optional so the cron can invoke it with no arguments; set when this action
  // reschedules itself for the next page of orgs.
  args: { cursor: v.optional(v.string()) },
  // The explicit return type is load-bearing, not decoration: the body
  // references `internal.crons` to reschedule itself, so without it the inferred
  // type of this export feeds back into the `internal` type it depends on.
  // TypeScript resolves that cycle by widening, and the damage lands in *other*
  // files — every `ctx.db.get()` in the codebase degrades to a union of all 142
  // table types. Same reason triggerSocialAutoReplyRetries below is annotated.
  handler: async (ctx: ActionCtx, args): Promise<string> => {
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const page = await ctx.runQuery(
      internal.socialIntegrations.getOrgsNeedingInstagramRefresh,
      { withinMs: SEVEN_DAYS_MS, cursor: args.cursor }
    );

    let refreshed = 0;
    for (const orgId of page.orgIds) {
      try {
        await ctx.runAction(internal.socialIntegrations.refreshInstagramToken, { orgId });
        refreshed++;
      } catch (err) {
        // Individual failures are already logged inside refreshInstagramToken;
        // continue so one bad token doesn't block the rest.
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.crons.triggerInstagramTokenRefresh, {
        cursor: page.continueCursor,
      });
    }

    // Logged per page rather than once per run: a run that dies partway through
    // still leaves a record of what it managed to refresh.
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "instagram",
      status: "success",
      summary: `Instagram token refresh cron: refreshed ${refreshed}/${page.orgIds.length} token(s) in this page.`,
    });

    return `Refreshed ${refreshed}/${page.orgIds.length} Instagram token(s)${page.isDone ? "" : "; more pages scheduled"}.`;
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

// ─── Shared engine for the two monthly per-row GL crons (SCRUM-230) ──────────
// Fixed-asset depreciation and F&I commission recognition share one discipline:
//  · ISOLATION — one item's throw ends that item for this run and nothing else;
//    the cross-org scan carries on, so no dealer is starved by another's data.
//  · CATCH-UP — every calendar month from the item's first offerable month
//    through the current one is offered in order, one mutation call per month,
//    each dated in its OWN month. The item stops at the first month that does
//    not post (never skipping ahead past a gap), so the schedule's strict
//    month ordering is preserved and the next run resumes where this one ended.

/** Per-run cap on individual failure rows, so a systemic fault cannot flood webhookLogs (zeroState DIAGNOSTIC_ROW_BOUNDS). */
const MAX_ITEM_FAILURE_ROWS = 20;

/** How a non-posting mutation `reason` ends an item: an ordinary state, or one that should never be routine. */
type ReasonClass = "done" | "abnormal";

/** The mutation reason a suspended / purged organization is refused with (SCRUM-302). */
const ORG_BLOCKED_REASON = "org_lifecycle_blocked";

type MonthlyCronStats = {
  total: number;
  /** Items that posted at least one month this run. */
  posted: number;
  monthsPosted: number;
  skippedNoOwner: number;
  /** Items that ended for an ordinary reason (not due, already run, fully done, left ACTIVE, org blocked, sale not yet posted). */
  done: number;
  /** Items that stopped for a reason that should never be routine, by reason. */
  abnormalByReason: Record<string, number>;
  failed: number;
};

type MonthlyPostResult<R extends string> = { posted: true } | { posted: false; reason: R };

type MonthlyCronItem = { _id: string; orgId: Id<"organizations"> };

type MonthlyCronSpec<T extends MonthlyCronItem, R extends string> = {
  source: "fixed-asset-depreciation" | "fi-commission-recognition";
  /** Row noun for the failure rows ("asset" / "deferral"). */
  noun: string;
  /** Summary-line prefix, followed by the run's year-month. */
  label: string;
  /** What the "skipped" bucket of the summary line covers (the `done` reasons, in prose). */
  doneText: string;
  /** Exhaustive over every reason the mutation can return: adding a reason without classifying it fails typecheck. */
  reasonClass: Record<R, ReasonClass>;
  /** One page of ACTIVE items across every org. */
  listPage: (ctx: ActionCtx, cursor: string | undefined) => Promise<{ page: T[]; isDone: boolean; continueCursor: string }>;
  firstOfferableMonthIndex: (item: T) => number;
  postMonth: (
    ctx: ActionCtx,
    item: T,
    args: { systemActorId: Id<"users">; yearMonth: string; occurredAt: number }
  ) => Promise<MonthlyPostResult<R>>;
};

/** Run-scoped state shared by every item of one cron run. */
type MonthlyCronRun = {
  stats: MonthlyCronStats;
  ownerByOrg: Map<string, Id<"users"> | null>;
  /** Orgs the mutation already refused for their lifecycle this run: their remaining items are skipped without a call. */
  blockedOrgs: Set<string>;
  now: number;
};

function newMonthlyCronStats(): MonthlyCronStats {
  return { total: 0, posted: 0, monthsPosted: 0, skippedNoOwner: 0, done: 0, abnormalByReason: {}, failed: 0 };
}

/** The failure row must never be able to break isolation: it has its own try/catch. */
async function recordMonthlyItemFailure<T extends MonthlyCronItem, R extends string>(
  ctx: ActionCtx,
  spec: MonthlyCronSpec<T, R>,
  stats: MonthlyCronStats,
  item: T,
  yearMonth: string | null,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${spec.source}: ${spec.noun} ${item._id} (org ${item.orgId}) failed at ${yearMonth ?? "owner lookup"}:`, err);
  // stats.failed already counts this item: only the first MAX rows are written.
  if (stats.failed > MAX_ITEM_FAILURE_ROWS) return;
  try {
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: spec.source,
      status: "error",
      summary: `${spec.source} item failed: org ${item.orgId} ${spec.noun} ${item._id} month ${yearMonth ?? "n/a"}`,
      error: message.slice(0, 1000),
    });
  } catch (recorderErr) {
    console.error(`${spec.source}: could not record the failure row for ${spec.noun} ${item._id}:`, recorderErr);
  }
}

async function runMonthlyCatchUpForItem<T extends MonthlyCronItem, R extends string>(
  ctx: ActionCtx,
  spec: MonthlyCronSpec<T, R>,
  run: MonthlyCronRun,
  item: T
): Promise<void> {
  const { stats } = run;
  stats.total++;
  const orgKey = item.orgId.toString();
  // A blocked org is refused identically for every one of its items: one mutation per run, not one per item.
  if (run.blockedOrgs.has(orgKey)) {
    stats.done++;
    return;
  }
  let yearMonth: string | null = null;
  try {
    const systemActorId = await getCachedOrgOwnerUserId(ctx, run.ownerByOrg, item.orgId);
    if (!systemActorId) {
      stats.skippedNoOwner++;
      return;
    }
    const currentIdx = yearMonthIndex(run.now);
    let postedAny = false;
    let abnormalReason: R | undefined;
    for (let idx = spec.firstOfferableMonthIndex(item); idx <= currentIdx; idx++) {
      yearMonth = yearMonthFromIndex(idx);
      const result = await spec.postMonth(ctx, item, {
        systemActorId,
        yearMonth,
        occurredAt: occurredAtForMonthIndex(idx, run.now),
      });
      if (!result.posted) {
        if (result.reason === ORG_BLOCKED_REASON) run.blockedOrgs.add(orgKey);
        if (spec.reasonClass[result.reason] === "abnormal") abnormalReason = result.reason;
        break;
      }
      // Counted at the FIRST posted month, not after the loop: an item that posts month 1 and
      // then throws on month 2 still posted (and also failed) — both counters say so.
      if (!postedAny) stats.posted++;
      postedAny = true;
      stats.monthsPosted++;
    }
    if (abnormalReason) {
      stats.abnormalByReason[abnormalReason] = (stats.abnormalByReason[abnormalReason] ?? 0) + 1;
    } else if (!postedAny) {
      stats.done++;
    }
  } catch (err) {
    stats.failed++;
    await recordMonthlyItemFailure(ctx, spec, stats, item, yearMonth, err);
  }
}

/** Drains every page so items past the page cap are not silently skipped. */
async function runMonthlyCron<T extends MonthlyCronItem, R extends string>(
  ctx: ActionCtx,
  spec: MonthlyCronSpec<T, R>,
  now: number
): Promise<MonthlyCronStats> {
  const run: MonthlyCronRun = { stats: newMonthlyCronStats(), ownerByOrg: new Map(), blockedOrgs: new Set(), now };
  let cursor: string | undefined;
  do {
    const page = await spec.listPage(ctx, cursor);
    for (const item of page.page) {
      await runMonthlyCatchUpForItem(ctx, spec, run, item);
    }
    cursor = page.isDone ? undefined : page.continueCursor;
  } while (cursor);
  return run.stats;
}

function monthlyCronSummary<T extends MonthlyCronItem, R extends string>(
  spec: MonthlyCronSpec<T, R>,
  yearMonth: string,
  stats: MonthlyCronStats
): string {
  const abnormal = Object.entries(stats.abnormalByReason);
  const abnormalCount = abnormal.reduce((n, [, c]) => n + c, 0);
  const abnormalDetail = abnormalCount > 0 ? ` (${abnormal.map(([reason, c]) => `${reason}=${c}`).join(", ")})` : "";
  const suppressed = Math.max(0, stats.failed - MAX_ITEM_FAILURE_ROWS);
  const suppressedText = suppressed > 0 ? ` (${suppressed} further failure row(s) not logged individually)` : "";
  return `${spec.label} ${yearMonth}: posted ${stats.posted}/${stats.total} ${spec.noun}(s) (${stats.monthsPosted} month(s)), ${stats.skippedNoOwner} skipped (no org owner), ${stats.done} skipped (${spec.doneText}), ${abnormalCount} stopped abnormally${abnormalDetail}, ${stats.failed} failed${suppressedText}.`;
}

/** A run that failed any item is reported as an error row, but the action itself still returns. */
async function logMonthlyCronSummary<T extends MonthlyCronItem, R extends string>(
  ctx: ActionCtx,
  spec: MonthlyCronSpec<T, R>,
  summary: string,
  stats: MonthlyCronStats
): Promise<void> {
  await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
    source: spec.source,
    status: stats.failed > 0 ? "error" : "success",
    summary,
    ...(stats.failed > 0 ? { error: `${stats.failed} row(s) failed this run; see the failure rows logged under this source.` } : {}),
  });
}

/** The action body shared by both monthly crons: run, summarise, log; a run-level throw is logged and rethrown. */
function monthlyCronHandler<T extends MonthlyCronItem, R extends string>(spec: MonthlyCronSpec<T, R>) {
  return async (ctx: ActionCtx): Promise<string> => {
    try {
      const now = Date.now();
      const stats = await runMonthlyCron(ctx, spec, now);
      const summary = monthlyCronSummary(spec, toYearMonth(now), stats);
      await logMonthlyCronSummary(ctx, spec, summary, stats);
      return summary;
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: spec.source,
        status: "error",
        summary: `${spec.source} cron failed`,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

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

/**
 * Every depreciation skip reason, classified. `done` = an ordinary end for the
 * item (including a suspended org, which is a deliberate counted refusal); any
 * `abnormal` reason is surfaced in the run summary.
 */
export const DEPRECIATION_REASON_CLASS: Record<DepreciationSkipReason, ReasonClass> = {
  org_lifecycle_blocked: "done",
  not_found: "done",
  not_active: "done",
  not_after_last_depreciated_month: "done",
  before_depreciation_start: "done",
  fully_depreciated: "done",
  not_capitalized_under_gl_phase_11: "abnormal",
};

const depreciationSpec: MonthlyCronSpec<Doc<"fixedAssets">, DepreciationSkipReason> = {
  source: "fixed-asset-depreciation",
  noun: "asset",
  label: "Depreciation",
  doneText: "already run / not yet started / inactive / fully depreciated / org suspended",
  reasonClass: DEPRECIATION_REASON_CLASS,
  listPage: (ctx, cursor) => ctx.runQuery(internal.fixedAssets.listActiveAssetsForDepreciation, { cursor }),
  firstOfferableMonthIndex: (asset) =>
    firstOfferableMonthIndex({
      lastPostedYearMonth: asset.lastDepreciatedYearMonth,
      startAt: asset.depreciationStartDate ?? asset.purchaseDate,
      createdAt: asset._creationTime,
    }),
  postMonth: (ctx, asset, a) =>
    ctx.runMutation(internal.fixedAssets.depreciateAssetForMonth, {
      orgId: asset.orgId,
      assetId: asset._id,
      yearMonth: a.yearMonth,
      occurredAt: a.occurredAt,
      systemActorId: a.systemActorId,
    }),
};

// ─── GL Phase 11: monthly fixed-asset depreciation cron ──────────────────────
// Posts one month of straight-line depreciation for every ACTIVE fixed asset,
// across every org (shared engine above). depreciateAssetForMonth is idempotent
// per (assetId, yearMonth), so a redrive/redeploy can't double-post.

export const triggerFixedAssetDepreciation = internalAction({
  args: {},
  handler: monthlyCronHandler(depreciationSpec),
});

// ─── GL Phase 19: monthly F&I commission recognition cron ────────────────────
// Same shape as the fixed-asset depreciation cron above (shared engine):
// paginated cross-org scan, cached per-org owner resolution, per-item
// isolation + month catch-up, admin audit log on completion/failure.

/**
 * Every recognition skip reason, classified. `source_sale_not_posted` is a
 * normal waiting state (the sale journal has not posted yet); a ledger
 * occurrence conflict means the subledger and GL diverged and is abnormal.
 */
export const RECOGNITION_REASON_CLASS: Record<RecognitionSkipReason, ReasonClass> = {
  org_lifecycle_blocked: "done",
  not_found: "done",
  not_active: "done",
  not_after_last_recognized_month: "done",
  fully_recognized: "done",
  source_sale_not_posted: "done",
  ledger_occurrence_conflict: "abnormal",
};

type RecognitionItem = Doc<"dealerProductDeferrals"> & { saleDate: number | null };

const recognitionSpec: MonthlyCronSpec<RecognitionItem, RecognitionSkipReason> = {
  source: "fi-commission-recognition",
  noun: "deferral",
  label: "F&I commission recognition",
  doneText: "already run / fully recognized / not active / org suspended / sale not yet posted",
  reasonClass: RECOGNITION_REASON_CLASS,
  listPage: (ctx, cursor) => ctx.runQuery(internal.dealerProductDeferrals.listActiveDeferralsForRecognition, { cursor }),
  firstOfferableMonthIndex: (deferral) => {
    // S230-R1: never fall back to an earlier month. Thrown inside the item's try, so it
    // is an ordinary item-level failure (counted, failure row, other items unaffected).
    if (deferral.saleDate === null) {
      throw new Error(`deferral ${deferral._id} has no valid owning sale (missing, cross-org or undated); recognition refused`);
    }
    return firstOfferableMonthIndex({
      lastPostedYearMonth: deferral.lastRecognizedYearMonth,
      startAt: deferral.saleDate,
      createdAt: deferral.createdAt,
    });
  },
  postMonth: (ctx, deferral, a) =>
    ctx.runMutation(internal.dealerProductDeferrals.recognizeDeferredCommissionForMonth, {
      orgId: deferral.orgId,
      deferralId: deferral._id,
      yearMonth: a.yearMonth,
      occurredAt: a.occurredAt,
      systemActorId: a.systemActorId,
    }),
};

export const triggerFiCommissionRecognition = internalAction({
  args: {},
  handler: monthlyCronHandler(recognitionSpec),
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
