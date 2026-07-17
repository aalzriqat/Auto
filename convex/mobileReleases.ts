import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";

const platformValidator = v.union(v.literal("ANDROID"), v.literal("IOS"));

/**
 * Public: the newest published native build for a platform, plus whether the
 * caller (an installed app reporting its own buildNumber) is behind it. Read by
 * the in-app updater on launch — no auth, since it only exposes the same build
 * metadata a download page would, and the anonymous marketplace surfaces of the
 * app may call it before sign-in.
 *
 * "updateAvailable" is strictly a NATIVE-build comparison: JS-only changes ship
 * over-the-air via expo-updates and never appear here, so this never nags the
 * user to reinstall for a change OTA already delivered.
 */
export const getLatestRelease = query({
  args: {
    platform: platformValidator,
    currentBuildNumber: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query("mobileAppReleases")
      .withIndex("by_platform_build", (q) => q.eq("platform", args.platform))
      .order("desc")
      .first();
    if (!latest) return null;

    const updateAvailable =
      args.currentBuildNumber === undefined ? false : latest.buildNumber > args.currentBuildNumber;

    return {
      buildNumber: latest.buildNumber,
      versionName: latest.versionName,
      runtimeVersion: latest.runtimeVersion,
      apkUrl: latest.apkUrl,
      releaseNotesEn: latest.releaseNotesEn ?? null,
      releaseNotesAr: latest.releaseNotesAr ?? null,
      mandatory: latest.mandatory ?? false,
      updateAvailable,
    };
  },
});

/**
 * Super-admin: register a freshly-built native APK so installed apps start
 * prompting for it. buildNumber must strictly exceed the current newest for the
 * platform — a monotonic ordinal is what makes "am I behind" a safe numeric
 * compare rather than a fragile version-string parse.
 */
export const publishRelease = mutation({
  args: {
    platform: platformValidator,
    buildNumber: v.number(),
    versionName: v.string(),
    runtimeVersion: v.string(),
    apkUrl: v.string(),
    releaseNotesEn: v.optional(v.string()),
    releaseNotesAr: v.optional(v.string()),
    mandatory: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);

    if (!Number.isInteger(args.buildNumber) || args.buildNumber <= 0) {
      throw new ConvexError("Build number must be a positive integer.");
    }
    if (!/^https:\/\//.test(args.apkUrl)) {
      throw new ConvexError("APK URL must be an https link.");
    }

    const current = await ctx.db
      .query("mobileAppReleases")
      .withIndex("by_platform_build", (q) => q.eq("platform", args.platform))
      .order("desc")
      .first();
    if (current && args.buildNumber <= current.buildNumber) {
      throw new ConvexError(
        `Build number must be greater than the current latest (${current.buildNumber}) for ${args.platform}.`
      );
    }

    return await ctx.db.insert("mobileAppReleases", {
      platform: args.platform,
      buildNumber: args.buildNumber,
      versionName: args.versionName.trim(),
      runtimeVersion: args.runtimeVersion.trim(),
      apkUrl: args.apkUrl.trim(),
      releaseNotesEn: args.releaseNotesEn?.trim() || undefined,
      releaseNotesAr: args.releaseNotesAr?.trim() || undefined,
      mandatory: args.mandatory ?? false,
      createdBy: admin._id,
      createdAt: Date.now(),
    });
  },
});
