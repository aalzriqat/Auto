import { v } from "convex/values";
import { ActionCtx, QueryCtx, internalAction, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { vehicleSlug } from "./websiteProjection";

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Bounds how far back a match/response query looks per org — generous for
// founding-dealer volume, same tradeoff as other marketplace list caps.
const MAX_ROWS_PER_ORG = 200;

// Dealers handled per scheduled invocation. Each dealer costs ~3 queries plus
// one email action, so this keeps a single action well inside its time limit;
// the rest of the roster continues in a freshly scheduled invocation.
export const WEEKLY_REPORT_ORG_PAGE_SIZE = 25;
// Pause between pages, so the shared emailGlobal bucket (300/min, used by every
// other sender) refills before the next page's emails start.
export const WEEKLY_REPORT_PAGE_DELAY_MS = 30_000;

/**
 * One cursor page of opted-in, non-deleted dealer orgs. `isDeleted` has no
 * index, so it is filtered within the page: a page may be short, and `isDone`
 * (not the page length) says whether the roster is exhausted.
 */
export const listOptedInDealerOrgIdsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("marketplaceDealerProfiles")
      .withIndex("by_opted_in", (q) => q.eq("isOptedIn", true))
      .paginate({ numItems: WEEKLY_REPORT_ORG_PAGE_SIZE, cursor: args.cursor });
    return {
      orgIds: page.page.filter((profile) => !profile.isDeleted).map((profile) => profile.orgId),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export type WeeklyMarketplaceReport = {
  pageViews: number;
  vehicleDetailViews: number;
  requestsMatched: number;
  responsesSent: number;
  avgResponseMinutes: number | null;
  mostViewedVehicle: { make: string; model: string; year: number; views: number } | null;
  requestsLost: number;
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
  since: number
): Promise<number> {
  const now = Date.now();
  let requestsLost = 0;
  for (const match of matches) {
    if (respondedRequestIds.has(match.requestId)) continue;
    const request = await ctx.db.get(match.requestId);
    if (request?.status !== "EXPIRED") continue;
    if (request.expiresAt >= since && request.expiresAt < now) requestsLost++;
  }
  return requestsLost;
}

async function summarizePageViews(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  since: number
): Promise<{ pageViews: number; vehicleDetailViews: number; mostViewedVehicle: WeeklyMarketplaceReport["mostViewedVehicle"] }> {
  const events = await ctx.db
    .query("siteVisitorEvents")
    .withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId).gte("createdAt", since))
    .take(5000);

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
  if (topSlug) {
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .take(500);
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
    }
  }

  return { pageViews, vehicleDetailViews, mostViewedVehicle };
}

/** Aggregates one opted-in dealer's marketplace activity since `since`. Returns null when there's nothing to report (no matches, no responses) — callers should skip sending. Exported for adminMarketplace.ts's live "Weekly Reports" console view, which needs the same numbers as the emailed report without a second round-trip through an internalQuery. */
export async function computeWeeklyReport(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  since: number
): Promise<WeeklyMarketplaceReport | null> {
  const matches = await ctx.db
    .query("marketplaceRequestMatches")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .order("desc")
    .take(MAX_ROWS_PER_ORG);
  const responses = await ctx.db
    .query("marketplaceResponses")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .order("desc")
    .take(MAX_ROWS_PER_ORG);

  const matchesThisWeek = matches.filter((match) => match.matchedAt >= since);
  const responsesThisWeek = responses.filter((response) => response.createdAt >= since);
  if (matchesThisWeek.length === 0 && responsesThisWeek.length === 0) {
    return null;
  }

  const matchByRequestId = new Map<Id<"marketplaceRequests">, Doc<"marketplaceRequestMatches">>(
    matches.map((match) => [match.requestId, match])
  );
  const respondedRequestIds = new Set(responses.map((response) => response.requestId));

  const avgResponseMinutes = computeAvgResponseMinutes(responsesThisWeek, matchByRequestId);
  const requestsLost = await countRequestsLost(ctx, matches, respondedRequestIds, since);
  const { pageViews, vehicleDetailViews, mostViewedVehicle } = await summarizePageViews(ctx, orgId, since);

  return {
    pageViews,
    vehicleDetailViews,
    requestsMatched: matchesThisWeek.length,
    responsesSent: responsesThisWeek.length,
    avgResponseMinutes,
    mostViewedVehicle,
    requestsLost,
  };
}

export const buildWeeklyReportForOrg = internalQuery({
  args: { orgId: v.id("organizations"), since: v.number() },
  handler: async (ctx, args) => computeWeeklyReport(ctx, args.orgId, args.since),
});

/** Bucket key for "has this org already been sent the report via WhatsApp this week" — the most recent Monday 00:00 UTC, independent of the trailing-7-day stat window computeWeeklyReport uses. */
export function currentWeekStart(now: number = Date.now()): number {
  const date = new Date(now);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

type WeeklyReportOutcome = "sent" | "skipped" | "failed";

type WeeklyReportPageResult = Record<WeeklyReportOutcome, number>;

/** Runs `processOrg` for every org in order, isolating failures: one dealer's throw (or "failed" outcome) is counted but never stops the rest of the page. */
export async function deliverWeeklyReportsForOrgs(
  orgIds: Id<"organizations">[],
  processOrg: (orgId: Id<"organizations">) => Promise<WeeklyReportOutcome>
): Promise<WeeklyReportPageResult> {
  const result: WeeklyReportPageResult = { sent: 0, skipped: 0, failed: 0 };
  for (const orgId of orgIds) {
    try {
      result[await processOrg(orgId)]++;
    } catch (error) {
      result.failed++;
      console.error("marketplace weekly report failed for org", orgId, error);
    }
  }
  return result;
}

function summarizePage(result: WeeklyReportPageResult, hasMore: boolean): string {
  const failed = result.failed > 0 ? ` ${result.failed} dealer(s) failed.` : "";
  const more = hasMore ? " More dealers continue in a follow-up run." : "";
  return `Sent ${result.sent} weekly proof report(s), skipped ${result.skipped} dealer(s) with no activity.${failed}${more}`;
}

/**
 * Weekly cron entrypoint (Phase 58B). WhatsApp delivery is deferred until
 * Business Verification clears (master plan A5b) — this sends the proof
 * report by email only for now, the documented fallback channel.
 *
 * The roster is walked one bounded page per invocation. A page finishes its
 * sends and only then schedules its successor (after a fixed delay, carrying
 * the same `since` so every dealer sees the same window), so pages run strictly
 * one after another. A dealer whose send fails or throws is counted and logged
 * and does not stop the page or the chain.
 *
 * This is not exactly-once and not crash-proof: nothing durable records which
 * dealers were handled, so a process that dies mid-page ends the chain there
 * (the last logged page then still says dealers continue), and a manual re-run
 * of the cron re-emails every dealer with activity.
 */
export const sendWeeklyProofReports = internalAction({
  args: {},
  handler: async (ctx) => runLoggedPage(ctx, null, Date.now() - ONE_WEEK_MS),
});

/** Continuation of `sendWeeklyProofReports` for the next page of dealers. */
export const sendWeeklyProofReportsPage = internalAction({
  args: { cursor: v.string(), since: v.number() },
  handler: async (ctx, args) => runLoggedPage(ctx, args.cursor, args.since),
});

async function runLoggedPage(ctx: ActionCtx, cursor: string | null, since: number): Promise<string> {
  try {
    const { summary, failed } = await runWeeklyProofReportsPage(ctx, cursor, since);
    const hasFailures = failed > 0;
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "marketplace-weekly-report",
      status: hasFailures ? "error" : "success",
      summary,
      ...(hasFailures ? { error: `${failed} dealer report(s) failed; see Convex logs.` } : {}),
    });
    return summary;
  } catch (err) {
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "marketplace-weekly-report",
      status: "error",
      summary: "marketplace weekly report cron failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function runWeeklyProofReportsPage(
  ctx: ActionCtx,
  cursor: string | null,
  since: number
): Promise<{ summary: string; failed: number }> {
  const page = await ctx.runQuery(internal.marketplaceReports.listOptedInDealerOrgIdsPage, { cursor });

  const result = await deliverWeeklyReportsForOrgs(page.orgIds, async (orgId) => {
    const report = await ctx.runQuery(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since });
    if (!report) return "skipped";

    const [ownerEmail, org] = await Promise.all([
      ctx.runQuery(internal.crons.getOrgOwnerEmail, { orgId }),
      ctx.runQuery(internal.organizations.getInternal, { orgId }),
    ]);
    if (!ownerEmail || !org) return "skipped";

    const delivery = await ctx.runAction(internal.email.sendMarketplaceWeeklyReportEmail, {
      orgId,
      toEmail: ownerEmail,
      orgName: org.name,
      ...report,
    });
    if (!delivery.success) {
      // The email action reports rate limiting and provider errors as a value
      // rather than throwing. Its own detail may name the recipient, so only a
      // coarse reason is logged here.
      console.error(
        "marketplace weekly report not delivered for org",
        orgId,
        delivery.error === "rate_limited" ? "rate_limited" : "send_failed"
      );
      return "failed";
    }
    return "sent";
  });

  if (!page.isDone) {
    await ctx.scheduler.runAfter(WEEKLY_REPORT_PAGE_DELAY_MS, internal.marketplaceReports.sendWeeklyProofReportsPage, {
      cursor: page.continueCursor,
      since,
    });
  }

  return { summary: summarizePage(result, !page.isDone), failed: result.failed };
}
