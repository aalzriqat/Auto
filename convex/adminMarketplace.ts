import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";
import { computeWeeklyReport, currentWeekStart } from "./marketplaceReports";

const MAX_REQUEST_ROWS = 100;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const requestStatusValidator = v.optional(
  v.union(
    v.literal("OPEN"),
    v.literal("MATCHED"),
    v.literal("FULFILLED"),
    v.literal("EXPIRED"),
    v.literal("SPAM")
  )
);

/**
 * Cross-org: marketplace requests have no orgId (per master plan A1/A3), so they
 * can't go through the generic `adminData.ts` ADMIN_TABLES browser — this is the
 * one purpose-built admin surface Phase 57 needs (master plan A11). Also where the
 * manual WhatsApp-send buttons live (§0.5): each match carries its dealer's
 * whatsappNumber so the frontend can build a wa.me link.
 */
export const listRequests = query({
  args: { status: requestStatusValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    const requests = args.status
      ? await ctx.db
          .query("marketplaceRequests")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
          .order("desc")
          .take(MAX_REQUEST_ROWS)
      : await ctx.db.query("marketplaceRequests").order("desc").take(MAX_REQUEST_ROWS);

    return await Promise.all(
      requests.map(async (request) => {
        const matches = await ctx.db
          .query("marketplaceRequestMatches")
          .withIndex("by_request", (q) => q.eq("requestId", request._id))
          .collect();

        const matchDetails = await Promise.all(
          matches.map(async (match) => {
            const org = await ctx.db.get(match.orgId);
            const profile = await ctx.db
              .query("marketplaceDealerProfiles")
              .withIndex("by_org", (q) => q.eq("orgId", match.orgId))
              .unique();

            return {
              matchId: match._id,
              orgId: match.orgId,
              dealerName: org?.name ?? "Unknown dealer",
              whatsappNumber: profile?.whatsappNumber ?? null,
              matchedAt: match.matchedAt,
              notifiedAt: match.notifiedAt ?? null,
              notifiedVia: match.notifiedVia ?? null,
            };
          })
        );

        return { ...request, matches: matchDetails };
      })
    );
  },
});

/** Staff clicks "Send via WhatsApp" — the frontend opens the wa.me link and calls this in the same click, so response-time scoring (Phase 60) has a real notifiedAt to measure from. */
export const markMatchNotified = mutation({
  args: { matchId: v.id("marketplaceRequestMatches") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const match = await ctx.db.get(args.matchId);
    if (!match) throwAppError(AppErrorCode.VALIDATION_FAILED, "Match not found.");

    await ctx.db.patch(args.matchId, { notifiedAt: Date.now(), notifiedVia: "WHATSAPP_MANUAL" });

    await logAdminAction(ctx, admin, {
      action: "marketplaceMarkMatchNotified",
      targetTable: "marketplaceRequestMatches",
      targetId: args.matchId,
      orgId: match.orgId,
    });
  },
});

export const markSpam = mutation({
  args: { requestId: v.id("marketplaceRequests") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const request = await ctx.db.get(args.requestId);
    if (!request) throwAppError(AppErrorCode.VALIDATION_FAILED, "Request not found.");

    await ctx.db.patch(args.requestId, { status: "SPAM" });

    await logAdminAction(ctx, admin, {
      action: "marketplaceMarkSpam",
      targetTable: "marketplaceRequests",
      targetId: args.requestId,
    });
  },
});

/**
 * Live "Weekly Reports" console view (Phase 58B) — same numbers the Monday
 * cron emails, computed on demand so staff can manually WhatsApp-send them
 * any time via the wa.me deep-link pattern (master plan §0.5), same as the
 * request-matching flow above. Only lists dealers with something to report.
 */
export const listWeeklyReports = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);

    const profiles = await ctx.db
      .query("marketplaceDealerProfiles")
      .withIndex("by_opted_in", (q) => q.eq("isOptedIn", true))
      .collect();
    const since = Date.now() - ONE_WEEK_MS;
    const weekStart = currentWeekStart();

    const rows = await Promise.all(
      profiles
        .filter((profile) => !profile.isDeleted)
        .map(async (profile) => {
          const org = await ctx.db.get(profile.orgId);
          if (!org) return null;

          const report = await computeWeeklyReport(ctx, profile.orgId, since);
          if (!report) return null;

          const sent = await ctx.db
            .query("marketplaceWeeklyReportSends")
            .withIndex("by_org_week", (q) => q.eq("orgId", profile.orgId).eq("weekStart", weekStart))
            .first();

          return {
            orgId: profile.orgId,
            dealerName: org.name,
            whatsappNumber: profile.whatsappNumber ?? null,
            report,
            sentAt: sent?.sentAt ?? null,
          };
        })
    );

    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});

/** Staff clicks "Send via WhatsApp" on a weekly report — mirrors markMatchNotified above. */
export const markWeeklyReportSentViaWhatsApp = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.VALIDATION_FAILED, "Organization not found.");

    const weekStart = currentWeekStart();
    const existing = await ctx.db
      .query("marketplaceWeeklyReportSends")
      .withIndex("by_org_week", (q) => q.eq("orgId", args.orgId).eq("weekStart", weekStart))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { sentAt: Date.now(), sentBy: admin._id });
    } else {
      await ctx.db.insert("marketplaceWeeklyReportSends", {
        orgId: args.orgId,
        weekStart,
        sentAt: Date.now(),
        sentBy: admin._id,
      });
    }

    await logAdminAction(ctx, admin, {
      action: "marketplaceMarkWeeklyReportSent",
      targetTable: "marketplaceWeeklyReportSends",
      targetId: args.orgId,
      orgId: args.orgId,
    });
  },
});
