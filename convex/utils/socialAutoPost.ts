import { MutationCtx } from "../_generated/server";
import { Id, Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { hasPlanFeature } from "../subscriptions";

/**
 * Queues an auto-post to Instagram when a vehicle transitions to AVAILABLE,
 * if the org has opted in (`orgSettings.socialAutoPostEnabled`) and has an
 * active Instagram connection. No-ops silently otherwise — this must never
 * surface an error or block the status-change mutation it's called from.
 * Fully scheduler-deferred (`runAfter(0, ...)`), so any Instagram failure
 * is isolated to the resulting `socialPosts` row, never the caller.
 */
export async function maybeAutoPostToInstagram(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicle: Doc<"vehicles">;
    triggeredByUserId: Id<"users">;
  }
): Promise<void> {
  const { orgId, vehicle, triggeredByUserId } = args;
  if (!(await hasPlanFeature(ctx, orgId, "socialInbox"))) return;

  const orgSettings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  if (!orgSettings?.socialAutoPostEnabled) return;
  if (!orgSettings.instagramAccessToken || !orgSettings.instagramBusinessAccountId) return;
  if (!vehicle.imageIds || vehicle.imageIds.length === 0) return;

  const caption = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""} — ${vehicle.sellingPrice.toLocaleString()} JOD\n${vehicle.mileage.toLocaleString()} km · ${vehicle.transmission} · ${vehicle.fuelType}\n\n#${vehicle.make.replace(/\s+/g, "")} #${vehicle.model.replace(/\s+/g, "")} #ForSale`;

  const socialPostId = await ctx.db.insert("socialPosts", {
    orgId,
    vehicleId: vehicle._id,
    platform: "instagram",
    status: "PENDING",
    caption,
    imageStorageIds: vehicle.imageIds,
    triggeredBy: "auto",
    requestedBy: triggeredByUserId,
    requestedAt: Date.now(),
  });

  await ctx.scheduler.runAfter(0, internal.socialPosting.publishToInstagram, { socialPostId });
}

/**
 * Queues an auto-post to Facebook when a vehicle transitions to AVAILABLE,
 * under the same shared `socialAutoPostEnabled` toggle Instagram uses — each
 * platform independently no-ops if its own connection isn't active. Mirrors
 * `maybeAutoPostToInstagram` exactly; called alongside it at every call site.
 */
export async function maybeAutoPostToFacebook(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicle: Doc<"vehicles">;
    triggeredByUserId: Id<"users">;
  }
): Promise<void> {
  const { orgId, vehicle, triggeredByUserId } = args;
  if (!(await hasPlanFeature(ctx, orgId, "socialInbox"))) return;

  const orgSettings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  if (!orgSettings?.socialAutoPostEnabled) return;
  if (!orgSettings.facebookPageAccessToken || !orgSettings.facebookPageId) return;
  if (!vehicle.imageIds || vehicle.imageIds.length === 0) return;

  const caption = `${vehicle.year} ${vehicle.make} ${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ""} — ${vehicle.sellingPrice.toLocaleString()} JOD\n${vehicle.mileage.toLocaleString()} km · ${vehicle.transmission} · ${vehicle.fuelType}\n\n#${vehicle.make.replace(/\s+/g, "")} #${vehicle.model.replace(/\s+/g, "")} #ForSale`;

  const socialPostId = await ctx.db.insert("socialPosts", {
    orgId,
    vehicleId: vehicle._id,
    platform: "facebook",
    status: "PENDING",
    caption,
    imageStorageIds: vehicle.imageIds,
    triggeredBy: "auto",
    requestedBy: triggeredByUserId,
    requestedAt: Date.now(),
  });

  await ctx.scheduler.runAfter(0, internal.facebookPosting.publishToFacebook, { socialPostId });
}
