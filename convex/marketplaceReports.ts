import { v } from "convex/values";
import { Workpool } from "@convex-dev/workpool";
import { MutationCtx, QueryCtx, internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { components, internal } from "./_generated/api";
import { DataModel, Doc, Id } from "./_generated/dataModel";
import { vehicleSlug } from "./websiteProjection";
import { findOrgOwnerUser } from "./utils/orgOwner";
import { getValidatedEnv } from "./utils/env";
import { recordWebhookLog } from "./utils/webhookLog";
import { renderMarketplaceWeeklyReportEmail } from "./utils/marketplaceWeeklyReportEmail";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Bounds how far back a match/response query looks per org — generous for
// founding-dealer volume, same tradeoff as other marketplace list caps. Every
// capped read fetches one row more than this, so exactly-at-the-cap is not
// mistaken for "there was more".
const MAX_ROWS_PER_ORG = 200;
const MAX_EVENTS_PER_ORG = 5000;
const MAX_VEHICLES_PER_ORG = 500;
// `lt` bound standing in for "no upper bound" (the admin console view passes none).
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

// Dealers produced per roster transaction: one `.paginate`, and at most this
// many delivery rows and queued freeze jobs in that single mutation.
export const WEEKLY_REPORT_ORG_PAGE_SIZE = 25;

/**
 * Resend keeps an idempotency key for 24 h (resend.com/docs/dashboard/emails/idempotency-keys).
 * An attempt is never started after 23 h from the first one, so a retry can
 * never fall outside the window in which the same key + payload returns the
 * original send instead of creating a second email.
 */
export const WEEKLY_SEND_WINDOW_MS = 23 * 60 * 60 * 1000;

// Bounded action retry for the send item (Workpool retries ACTIONS only; its
// mutations are not retried on application errors). Total backoff ≈ 3.5 min.
const WEEKLY_SEND_RETRY = { maxAttempts: 4, initialBackoffMs: 30_000, base: 2 };

// Sends are bounded by this parallelism and by the shared `emailGlobal` budget.
const weeklyPool = new Workpool(components.weeklyReportWorkpool, {
  maxParallelism: 5,
  retryActionsByDefault: false,
});

const EXCLUDE_SUCCESS: ("success" | "failed" | "canceled")[] = ["success"];

type ItemKind = "producer" | "freeze" | "send";

export type WeeklyMarketplaceReport = {
  pageViews: number;
  vehicleDetailViews: number;
  requestsMatched: number;
  responsesSent: number;
  avgResponseMinutes: number | null;
  mostViewedVehicle: { make: string; model: string; year: number; views: number } | null;
  requestsLost: number;
  /** Present only when a plain count's read hit its cap: that figure is "at least N". */
  lowerBound?: string[];
  /** Present only when a figure depends on a capped read and so cannot be trusted at all. */
  unavailable?: string[];
};

function computeAvgResponseMinutes(
  responsesThisWeek: Doc<"marketplaceResponses">[],
  matchByRequestId: Map<Id<"marketplaceRequests">, Doc<"marketplaceRequestMatches">>
): number | null {
  const responseMinutes = responsesThisWeek
    .map((response) => {
      const match = matchByRequestId.get(response.requestId);
      if (!match) return null;
      return Math.max(0, (response.createdAt - (match.notifiedAt ?? match.matchedAt)) / 60000);
    })
    .filter((minutes): minutes is number => minutes !== null);
  return responseMinutes.length > 0
    ? responseMinutes.reduce((sum, minutes) => sum + minutes, 0) / responseMinutes.length
    : null;
}

async function countRequestsLost(
  ctx: QueryCtx,
  matches: Doc<"marketplaceRequestMatches">[],
  respondedRequestIds: Set<Id<"marketplaceRequests">>,
  since: number,
  expiredBefore: number
): Promise<number> {
  let requestsLost = 0;
  for (const match of matches) {
    if (respondedRequestIds.has(match.requestId)) continue;
    const request = await ctx.db.get("marketplaceRequests", match.requestId);
    if (request?.status !== "EXPIRED") continue;
    if (request.expiresAt >= since && request.expiresAt < expiredBefore) requestsLost++;
  }
  return requestsLost;
}

async function summarizePageViews(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  since: number,
  upper: number
): Promise<{
  pageViews: number;
  vehicleDetailViews: number;
  mostViewedVehicle: WeeklyMarketplaceReport["mostViewedVehicle"];
  eventsCapped: boolean;
  vehicleLookupIncomplete: boolean;
}> {
  const fetched = await ctx.db
    .query("siteVisitorEvents")
    .withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId).gte("createdAt", since).lt("createdAt", upper))
    .take(MAX_EVENTS_PER_ORG + 1);
  const eventsCapped = fetched.length > MAX_EVENTS_PER_ORG;
  const events = fetched.slice(0, MAX_EVENTS_PER_ORG);

  let pageViews = 0;
  const vehicleViewCounts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "page_view") continue;
    pageViews++;
    const detailMatch = event.path.match(/^\/inventory\/(.+)$/);
    if (detailMatch) {
      vehicleViewCounts.set(detailMatch[1], (vehicleViewCounts.get(detailMatch[1]) ?? 0) + 1);
    }
  }
  let vehicleDetailViews = 0;
  for (const count of vehicleViewCounts.values()) vehicleDetailViews += count;

  let topSlug: string | null = null;
  let topCount = 0;
  for (const [slug, count] of vehicleViewCounts) {
    if (count > topCount) {
      topCount = count;
      topSlug = slug;
    }
  }

  let mostViewedVehicle: WeeklyMarketplaceReport["mostViewedVehicle"] = null;
  let vehicleLookupIncomplete = false;
  if (topSlug) {
    const fetchedVehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .take(MAX_VEHICLES_PER_ORG + 1);
    const vehicles = fetchedVehicles.slice(0, MAX_VEHICLES_PER_ORG);
    const matchedVehicle = vehicles.find(
      (vehicle) => !vehicle.isDeleted && (vehicleSlug(vehicle) === topSlug || vehicle._id === topSlug)
    );
    if (matchedVehicle) {
      mostViewedVehicle = {
        make: matchedVehicle.make,
        model: matchedVehicle.model,
        year: matchedVehicle.year,
        views: topCount,
      };
    } else if (fetchedVehicles.length > MAX_VEHICLES_PER_ORG) {
      vehicleLookupIncomplete = true;
    }
  }

  return { pageViews, vehicleDetailViews, mostViewedVehicle, eventsCapped, vehicleLookupIncomplete };
}

/**
 * Aggregates one opted-in dealer's marketplace activity in `[since, until)`.
 * Returns null when there's nothing to report (no matches, no responses) —
 * callers should skip sending. Exported for adminMarketplace.ts's live "Weekly
 * Reports" console view, which passes no `until` and gets the same numbers as
 * before.
 *
 * Matches and responses are each read ONCE, newest first, bounded above by
 * `until` (any age below it): a response this week can answer a match from
 * last week, a request answered before `since` must not count as lost, and a
 * request matched earlier can expire inside the window. The window counts are
 * the in-`[since, until)` prefix of that same read. The read is an index range,
 * so rows newer than `until` can never use up the row cap, and a read that
 * fills its cap is reported, never presented as exact.
 */
export async function computeWeeklyReport(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  since: number,
  until?: number
): Promise<WeeklyMarketplaceReport | null> {
  const upper = until ?? UNBOUNDED;

  const matchLookupRaw = await ctx.db
    .query("marketplaceRequestMatches")
    .withIndex("by_org_matchedAt", (q) => q.eq("orgId", orgId).lt("matchedAt", upper))
    .order("desc")
    .take(MAX_ROWS_PER_ORG + 1);
  const responseLookupRaw = await ctx.db
    .query("marketplaceResponses")
    .withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId).lt("createdAt", upper))
    .order("desc")
    .take(MAX_ROWS_PER_ORG + 1);
  // The window `[since, upper)` is exactly the newest-first prefix of the lookup
  // (same index, same upper bound, newest first), so it needs no second read of
  // its own. Its cap holds only when the whole cap+1 prefix lies in the window.
  const windowMatchesRaw = matchLookupRaw.filter((match) => match.matchedAt >= since);
  const windowResponsesRaw = responseLookupRaw.filter((response) => response.createdAt >= since);

  if (windowMatchesRaw.length === 0 && windowResponsesRaw.length === 0) {
    return null;
  }

  const matchLookupCapped = matchLookupRaw.length > MAX_ROWS_PER_ORG;
  const responseLookupCapped = responseLookupRaw.length > MAX_ROWS_PER_ORG;
  const windowMatchesCapped = windowMatchesRaw.length > MAX_ROWS_PER_ORG;
  const windowResponsesCapped = windowResponsesRaw.length > MAX_ROWS_PER_ORG;
  const matchLookup = matchLookupRaw.slice(0, MAX_ROWS_PER_ORG);
  const responseLookup = responseLookupRaw.slice(0, MAX_ROWS_PER_ORG);
  const matchesThisWeek = windowMatchesRaw.slice(0, MAX_ROWS_PER_ORG);
  const responsesThisWeek = windowResponsesRaw.slice(0, MAX_ROWS_PER_ORG);

  const matchByRequestId = new Map<Id<"marketplaceRequests">, Doc<"marketplaceRequestMatches">>(
    matchLookup.map((match) => [match.requestId, match])
  );
  const respondedRequestIds = new Set(responseLookup.map((response) => response.requestId));

  const avgResponseMinutes = computeAvgResponseMinutes(responsesThisWeek, matchByRequestId);
  const requestsLost = await countRequestsLost(
    ctx,
    matchLookup,
    respondedRequestIds,
    since,
    until ?? Date.now()
  );
  const { pageViews, vehicleDetailViews, mostViewedVehicle, eventsCapped, vehicleLookupIncomplete } =
    await summarizePageViews(ctx, orgId, since, upper);

  // Plain counts are honest lower bounds when their own read was capped.
  const lowerBound: string[] = [];
  if (eventsCapped) lowerBound.push("pageViews", "vehicleDetailViews");
  if (windowMatchesCapped) lowerBound.push("requestsMatched");
  if (windowResponsesCapped) lowerBound.push("responsesSent");
  // These are not lower bounds: a capped read can push them either way.
  const unavailable: string[] = [];
  if (matchLookupCapped || windowResponsesCapped) unavailable.push("avgResponseMinutes");
  if (matchLookupCapped || responseLookupCapped) unavailable.push("requestsLost");
  if (eventsCapped || vehicleLookupIncomplete) unavailable.push("mostViewedVehicle");

  return {
    pageViews,
    vehicleDetailViews,
    requestsMatched: matchesThisWeek.length,
    responsesSent: responsesThisWeek.length,
    avgResponseMinutes,
    mostViewedVehicle,
    requestsLost,
    ...(lowerBound.length > 0 ? { lowerBound } : {}),
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
}

export const buildWeeklyReportForOrg = internalQuery({
  // `until` is required: with it the report never reads the clock, so this query
  // is not left holding a stale `Date.now()` (Convex best practices: "Don't use
  // Date.now() in queries"). The admin console's live view calls
  // `computeWeeklyReport` directly, unchanged.
  args: { orgId: v.id("organizations"), since: v.number(), until: v.number() },
  handler: async (ctx, args) => computeWeeklyReport(ctx, args.orgId, args.since, args.until),
});

/** Bucket key for "has this org already been sent the report via WhatsApp this week" — the most recent Monday 00:00 UTC, independent of the trailing-7-day stat window computeWeeklyReport uses. */
export function currentWeekStart(now: number = Date.now()): number {
  const date = new Date(now);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

// ─── Weekly automatic email run (SCRUM-807) ──────────────────────────────────
//
// Durable, bounded, and honest about what it cannot know. The business state
// is two retained tables; Workpool only carries the temporary queue.
//
//   cron → sendWeeklyProofReports   one run row per business week, a no-op if it exists
//        → produceWeeklyDeliveries  one roster page per transaction; inserts PENDING rows,
//                                   queues a freeze job per NEW row and the next producer,
//                                   all atomically with the cursor advance
//        → freezeWeeklyDelivery     computes the report, renders and stores the FULL email
//        → sendFrozenWeeklyDelivery (convex/email.ts) one attempt per action try
//        → weeklyItemDone           reconciliation of failed/canceled items only
//
// Not exactly-once and not crash-proof. Provider acceptance is not delivery.
// Workpool does not retry mutations on application errors and does not store
// onComplete failures: a lost callback leaves a delivery non-terminal, so the
// run never reaches COMPLETE — visible, never silently "done".

type DeliveryState = Doc<"marketplaceWeeklyReportDeliveries">["state"];

const NONTERMINAL_STATES: DeliveryState[] = ["PENDING", "FROZEN", "SENDING"];
// Any of these makes the finished run an error in the admin log (an
// unfinished-business signal, not a delivery guarantee).
const NOT_ACCEPTED_STATES: DeliveryState[] = ["FAILED_TERMINAL", "AMBIGUOUS", "CANCELED", "MOCK"];

function itemOptions(context: {
  kind: ItemKind;
  runId: Id<"marketplaceWeeklyReportRuns">;
  deliveryId?: Id<"marketplaceWeeklyReportDeliveries">;
}) {
  return {
    onComplete: internal.marketplaceReports.weeklyItemDone,
    context,
    onCompleteExcludeKinds: EXCLUDE_SUCCESS,
  };
}

function runIsCanceled(run: Doc<"marketplaceWeeklyReportRuns"> | null): boolean {
  return !run || run.status === "CANCELED" || run.cancelRequestedAt !== undefined;
}

async function hasDeliveryInState(
  ctx: QueryCtx,
  runId: Id<"marketplaceWeeklyReportRuns">,
  state: DeliveryState
): Promise<boolean> {
  const row = await ctx.db
    .query("marketplaceWeeklyReportDeliveries")
    .withIndex("by_run_state", (q) => q.eq("runId", runId).eq("state", state))
    .first();
  return row !== null;
}

/**
 * COMPLETE only when the roster is exhausted (PRODUCED) AND no delivery is
 * still PENDING, FROZEN or SENDING. Idempotent; the only run-row write besides
 * the producer's, so many parallel senders never contend on it.
 */
async function maybeCompleteRun(ctx: MutationCtx, runId: Id<"marketplaceWeeklyReportRuns">): Promise<void> {
  const run = await ctx.db.get("marketplaceWeeklyReportRuns", runId);
  if (!run || run.status !== "PRODUCED") return;
  for (const state of NONTERMINAL_STATES) {
    if (await hasDeliveryInState(ctx, runId, state)) return;
  }
  await ctx.db.patch("marketplaceWeeklyReportRuns", runId, { status: "COMPLETE" });

  let notAccepted = false;
  for (const state of NOT_ACCEPTED_STATES) {
    if (await hasDeliveryInState(ctx, runId, state)) notAccepted = true;
  }
  await recordWebhookLog(ctx, {
    source: "marketplace-weekly-report",
    status: notAccepted ? "error" : "success",
    summary: notAccepted
      ? "Weekly proof report run finished; some dealers were not accepted by the email provider (see delivery states)."
      : "Weekly proof report run finished; every dealer with activity was accepted by the email provider.",
  });
}

/**
 * A row left in SENDING can only end two ways: a definite refusal on the
 * current attempt with no earlier uncertain one, or ambiguity. A later 429 or
 * quota answer cannot disprove an earlier attempt the provider may have taken.
 */
function settledSendingState(delivery: Doc<"marketplaceWeeklyReportDeliveries">): "FAILED_TERMINAL" | "AMBIGUOUS" {
  return !delivery.anyAttemptAmbiguous && delivery.errorClass === "rejected" ? "FAILED_TERMINAL" : "AMBIGUOUS";
}

/**
 * Weekly cron entrypoint. Replaces the old single-action page chain. Starts
 * the week's run once: a repeat — a manual re-run, a duplicate cron, a restart
 * — finds the week's row in ANY status and does nothing, so it can neither
 * start a second producer chain nor re-send. (The 24 h idempotency key alone
 * would not stop a second send after a day.) Ops are read-only: a stalled or
 * stuck run is final and visible; nothing resumes it automatically.
 */
export const sendWeeklyProofReports = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const now = Date.now();
    const weekKey = currentWeekStart(now);
    const existing = await ctx.db
      .query("marketplaceWeeklyReportRuns")
      .withIndex("by_weekKey", (q) => q.eq("weekKey", weekKey))
      .first();
    if (existing) {
      return `A weekly proof report run already exists for this week (${existing.status}); nothing was started.`;
    }
    const runId = await ctx.db.insert("marketplaceWeeklyReportRuns", {
      weekKey,
      runStartedAt: now,
      since: now - ONE_WEEK_MS,
      until: now,
      status: "PRODUCING",
      cursor: null,
    });
    await weeklyPool.enqueueMutation(
      ctx,
      internal.marketplaceReports.produceWeeklyDeliveries,
      { runId, expectedCursor: null },
      itemOptions({ kind: "producer", runId })
    );
    return "Started this week's proof report run.";
  },
});

/**
 * One roster page, in ONE transaction: a single `.paginate`, PENDING delivery
 * rows (unique per run + dealer), a queued freeze job for each NEWLY inserted
 * row, and either the next producer or the PRODUCED status. The cursor advance
 * and the enqueues commit together or not at all. `expectedCursor` is the
 * optimistic guard: a duplicate or stale producer sees a different cursor and
 * exits, so two chains cannot both advance the roster.
 */
export const produceWeeklyDeliveries = internalMutation({
  args: { runId: v.id("marketplaceWeeklyReportRuns"), expectedCursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.db.get("marketplaceWeeklyReportRuns", args.runId);
    if (!run || run.status !== "PRODUCING" || run.cancelRequestedAt !== undefined) return null;
    if (run.cursor !== args.expectedCursor) return null;

    // `isDeleted` has no index, so it is filtered within the page: a page may be
    // short, and `isDone` (not the page length) says whether the roster is exhausted.
    const page = await ctx.db
      .query("marketplaceDealerProfiles")
      .withIndex("by_opted_in", (q) => q.eq("isOptedIn", true))
      .paginate({ numItems: WEEKLY_REPORT_ORG_PAGE_SIZE, cursor: args.expectedCursor });

    const now = Date.now();
    const newDeliveryIds: Id<"marketplaceWeeklyReportDeliveries">[] = [];
    for (const profile of page.page) {
      if (profile.isDeleted) continue;
      const existing = await ctx.db
        .query("marketplaceWeeklyReportDeliveries")
        .withIndex("by_run_org", (q) => q.eq("runId", run._id).eq("orgId", profile.orgId))
        .first();
      if (existing) continue;
      newDeliveryIds.push(
        await ctx.db.insert("marketplaceWeeklyReportDeliveries", {
          runId: run._id,
          orgId: profile.orgId,
          state: "PENDING",
          idempotencyKey: `mpw:${run.weekKey}:${profile.orgId}`,
          attempts: 0,
          anyAttemptAmbiguous: false,
          createdAt: now,
          updatedAt: now,
        })
      );
    }
    if (newDeliveryIds.length > 0) {
      // One batch call for the page. The batch shares one onComplete context, so
      // each row records its own work id for `weeklyItemDone` to find it by.
      const workIds = await weeklyPool.enqueueMutationBatch(
        ctx,
        internal.marketplaceReports.freezeWeeklyDelivery,
        newDeliveryIds.map((deliveryId) => ({ deliveryId })),
        itemOptions({ kind: "freeze", runId: run._id })
      );
      for (const [index, deliveryId] of newDeliveryIds.entries()) {
        await ctx.db.patch("marketplaceWeeklyReportDeliveries", deliveryId, { freezeWorkId: workIds[index] });
      }
    }

    if (page.isDone) {
      await ctx.db.patch("marketplaceWeeklyReportRuns", run._id, { status: "PRODUCED", cursor: null });
      await maybeCompleteRun(ctx, run._id);
    } else {
      await ctx.db.patch("marketplaceWeeklyReportRuns", run._id, { cursor: page.continueCursor });
      await weeklyPool.enqueueMutation(
        ctx,
        internal.marketplaceReports.produceWeeklyDeliveries,
        { runId: run._id, expectedCursor: page.continueCursor },
        itemOptions({ kind: "producer", runId: run._id })
      );
    }
    return null;
  },
});

/**
 * Computes one dealer's report for the run's frozen window, renders the
 * COMPLETE email (sender, recipient, subject, html) and stores it before any
 * send. After this nothing re-reads source data for that email, so a retry —
 * or a template deploy between attempts — cannot change what the provider sees
 * for the same idempotency key.
 */
export const freezeWeeklyDelivery = internalMutation({
  args: { deliveryId: v.id("marketplaceWeeklyReportDeliveries") },
  handler: async (ctx, args): Promise<null> => {
    const delivery = await ctx.db.get("marketplaceWeeklyReportDeliveries", args.deliveryId);
    if (!delivery || delivery.state !== "PENDING") return null;
    const run = await ctx.db.get("marketplaceWeeklyReportRuns", delivery.runId);
    if (!run) return null;
    const now = Date.now();

    if (runIsCanceled(run)) {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: "CANCELED", updatedAt: now });
      await maybeCompleteRun(ctx, run._id);
      return null;
    }

    const report = await computeWeeklyReport(ctx, delivery.orgId, run.since, run.until);
    if (!report) {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: "SKIPPED", errorName: "no_activity", updatedAt: now });
      await maybeCompleteRun(ctx, run._id);
      return null;
    }

    // Plain helpers in this transaction, not ctx.runQuery: the same owner
    // lookup `crons.getOrgOwnerEmail` serves, and the row `organizations.getInternal` reads.
    const ownerEmail = (await findOrgOwnerUser(ctx, delivery.orgId))?.email ?? null;
    const org = await ctx.db.get("organizations", delivery.orgId);
    if (!ownerEmail || !org) {
      // Unlike a quiet week (a legitimate SKIP), a dealer WITH activity whose
      // report cannot be addressed is an unsent report: a failure the run's
      // completion verdict must show, never a skip.
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, {
        state: "FAILED_TERMINAL",
        errorName: org ? "missing_recipient" : "missing_organization",
        updatedAt: now,
      });
      await maybeCompleteRun(ctx, run._id);
      return null;
    }

    const rendered = renderMarketplaceWeeklyReportEmail({
      ...report,
      orgName: org.name,
      appUrl: getValidatedEnv().NEXT_PUBLIC_APP_URL,
    });
    await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, {
      state: "FROZEN",
      envelope: { from: rendered.from, to: ownerEmail, subject: rendered.subject, html: rendered.html },
      report,
      updatedAt: now,
    });
    await weeklyPool.enqueueAction(
      ctx,
      internal.email.sendFrozenWeeklyDelivery,
      { deliveryId: delivery._id },
      { ...itemOptions({ kind: "send", runId: run._id, deliveryId: delivery._id }), retry: WEEKLY_SEND_RETRY }
    );
    return null;
  },
});

/**
 * Authorizes ONE send attempt (the only path to the provider) and records the
 * attempt as ambiguous BEFORE the provider is called, so whatever the process
 * does next — answer, crash, time out — cannot leave an earlier attempt's
 * outcome standing for this one.
 */
export const beginWeeklySend = internalMutation({
  args: { deliveryId: v.id("marketplaceWeeklyReportDeliveries") },
  handler: async (
    ctx,
    args
  ): Promise<
    | { go: false }
    | { go: true; send: { orgId: Id<"organizations">; from: string; to: string; subject: string; html: string; idempotencyKey: string } }
  > => {
    const delivery = await ctx.db.get("marketplaceWeeklyReportDeliveries", args.deliveryId);
    if (!delivery) return { go: false };
    // PENDING has no frozen email yet; terminal rows are done. Neither writes.
    if (delivery.state !== "FROZEN" && delivery.state !== "SENDING") return { go: false };
    const run = await ctx.db.get("marketplaceWeeklyReportRuns", delivery.runId);
    const now = Date.now();

    if (runIsCanceled(run)) {
      // Never reached the provider → CANCELED. A row already SENDING may have
      // been taken by the provider, so it settles by the ambiguity rule and is
      // not sent again.
      const next = delivery.state === "FROZEN" ? "CANCELED" : settledSendingState(delivery);
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: next, updatedAt: now });
      await maybeCompleteRun(ctx, delivery.runId);
      return { go: false };
    }
    if (delivery.state === "SENDING" && now - (delivery.firstAttemptAt ?? now) >= WEEKLY_SEND_WINDOW_MS) {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: "AMBIGUOUS", errorName: "retry_window_elapsed", updatedAt: now });
      await maybeCompleteRun(ctx, delivery.runId);
      return { go: false };
    }
    if (!delivery.envelope) {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: "FAILED_TERMINAL", errorName: "envelope_missing", updatedAt: now });
      await maybeCompleteRun(ctx, delivery.runId);
      return { go: false };
    }

    await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, {
      state: "SENDING",
      firstAttemptAt: delivery.firstAttemptAt ?? now,
      attempts: delivery.attempts + 1,
      // The previous attempt ended without a recorded definite refusal: it may
      // have been accepted. Remembered for good.
      anyAttemptAmbiguous:
        delivery.anyAttemptAmbiguous || (delivery.attempts > 0 && delivery.errorClass === "ambiguous"),
      errorClass: "ambiguous",
      errorName: "attempt_in_flight",
      updatedAt: now,
    });
    return {
      go: true,
      send: {
        orgId: delivery.orgId,
        from: delivery.envelope.from,
        to: delivery.envelope.to,
        subject: delivery.envelope.subject,
        html: delivery.envelope.html,
        idempotencyKey: delivery.idempotencyKey,
      },
    };
  },
});

/**
 * Stores what the provider answered for the current attempt. Guarded to
 * SENDING, so a late or duplicate call cannot move a settled row. Returns
 * "retry" when the action should throw so Workpool retries it (the Resend SDK
 * reports API errors as values, which Workpool would otherwise count as success).
 */
export const recordWeeklySendOutcome = internalMutation({
  args: {
    deliveryId: v.id("marketplaceWeeklyReportDeliveries"),
    outcome: v.union(v.literal("accepted"), v.literal("mock"), v.literal("rejected"), v.literal("ambiguous")),
    retryable: v.boolean(),
    errorName: v.optional(v.string()),
    providerEmailId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<"done" | "retry"> => {
    const delivery = await ctx.db.get("marketplaceWeeklyReportDeliveries", args.deliveryId);
    if (!delivery || delivery.state !== "SENDING") return "done";
    const now = Date.now();

    if (args.outcome === "accepted") {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, {
        state: "ACCEPTED",
        providerEmailId: args.providerEmailId,
        errorClass: undefined,
        errorName: undefined,
        updatedAt: now,
      });
    } else if (args.outcome === "mock") {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: "MOCK", errorClass: undefined, errorName: undefined, updatedAt: now });
    } else if (args.outcome === "ambiguous") {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { errorClass: "ambiguous", errorName: args.errorName, updatedAt: now });
      return "retry";
    } else if (args.retryable) {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { errorClass: "rejected", errorName: args.errorName, updatedAt: now });
      return "retry";
    } else {
      // A definite refusal ends FAILED_TERMINAL only if no earlier attempt may have been accepted.
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, {
        state: delivery.anyAttemptAmbiguous ? "AMBIGUOUS" : "FAILED_TERMINAL",
        errorClass: "rejected",
        errorName: args.errorName,
        updatedAt: now,
      });
    }
    await maybeCompleteRun(ctx, delivery.runId);
    return "done";
  },
});

// Named so it can be passed as `defineOnComplete`'s second type argument:
// TypeScript has no partial inference, so naming only `DataModel` would leave
// the context validator at its `VAny` default and erase the `Id` types.
const weeklyItemContext = v.object({
  kind: v.union(v.literal("producer"), v.literal("freeze"), v.literal("send")),
  runId: v.id("marketplaceWeeklyReportRuns"),
  deliveryId: v.optional(v.id("marketplaceWeeklyReportDeliveries")),
});

/**
 * Reconciliation for items that ended `failed` or `canceled` (successes finish
 * their own state). Honest labels: CANCELED only for a real cancellation —
 * a failed item that never started is FAILED_TERMINAL — and a row that may
 * have reached the provider is never marked failed on the strength of a later
 * refusal. Producer failure marks the run STALLED (final and visible; nothing
 * resumes it).
 *
 * Builder exception: `defineOnComplete` builds its own internal mutation inside
 * the Workpool package, so it cannot take the trigger-wrapped `internalMutation`
 * from ./functions. That is safe only because this callback writes nothing but
 * the weekly-report tables (and webhookLogs), none of which has an aggregate
 * trigger. If it ever writes a triggered table, move that write into a
 * ./functions mutation and call it from here. The aggregateWiring guard is not
 * bypassed: this module imports no mutation builder from _generated/server.
 */
export const weeklyItemDone = weeklyPool.defineOnComplete<DataModel, typeof weeklyItemContext>({
  context: weeklyItemContext,
  handler: async (ctx, { workId, context, result }): Promise<void> => {
    if (result.kind === "success") return;

    if (context.kind === "producer") {
      const run = await ctx.db.get("marketplaceWeeklyReportRuns", context.runId);
      if (run && run.status === "PRODUCING") {
        await ctx.db.patch("marketplaceWeeklyReportRuns", run._id, { status: "STALLED" });
        await recordWebhookLog(ctx, {
          source: "marketplace-weekly-report",
          status: "error",
          summary: "Weekly proof report roster production stalled; later dealers were not queued.",
        });
      }
      return;
    }

    // Send items carry their delivery in the context; freeze items are enqueued
    // as a batch sharing one context, so they are found by their own work id.
    const delivery = context.deliveryId
      ? await ctx.db.get("marketplaceWeeklyReportDeliveries", context.deliveryId)
      : await ctx.db
          .query("marketplaceWeeklyReportDeliveries")
          .withIndex("by_freezeWorkId", (q) => q.eq("freezeWorkId", workId))
          .first();
    if (!delivery) return;
    const run = await ctx.db.get("marketplaceWeeklyReportRuns", delivery.runId);
    const canceled = result.kind === "canceled" || runIsCanceled(run);
    const now = Date.now();

    if (delivery.state === "PENDING" || delivery.state === "FROZEN") {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, canceled
        ? { state: "CANCELED", updatedAt: now }
        : {
            state: "FAILED_TERMINAL",
            errorName: context.kind === "freeze" ? "freeze_failed" : "send_not_started",
            updatedAt: now,
          });
    } else if (delivery.state === "SENDING") {
      await ctx.db.patch("marketplaceWeeklyReportDeliveries", delivery._id, { state: settledSendingState(delivery), updatedAt: now });
    } else {
      return;
    }
    await maybeCompleteRun(ctx, delivery.runId);
  },
});

/**
 * Records a cancel intent for a run. Producer, freeze and send steps re-read
 * the run and stop; rows that never reached the provider end CANCELED. Not
 * wired to any UI or cron: an explicit, internal operation.
 */
export const cancelWeeklyRun = internalMutation({
  args: { runId: v.id("marketplaceWeeklyReportRuns") },
  handler: async (ctx, args): Promise<null> => {
    const run = await ctx.db.get("marketplaceWeeklyReportRuns", args.runId);
    if (!run || run.status === "COMPLETE" || run.status === "CANCELED") return null;
    await ctx.db.patch("marketplaceWeeklyReportRuns", run._id, { status: "CANCELED", cancelRequestedAt: Date.now() });
    return null;
  },
});
