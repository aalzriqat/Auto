import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { Permission, PERMISSIONS, isSystemOwnerRole } from "./permissions";
import { NotificationType, NOTIFICATION_TYPES } from "../../lib/notifications/types";
import { hasPlanFeature } from "../subscriptions";

interface DispatchOpts {
  link?: string;
  relatedTaskId?: Id<"tasks">;
}

type NotificationData = Record<string, string | number>;

async function getPreference(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  category: string
) {
  return await ctx.db
    .query("notificationPreferences")
    .withIndex("by_org_user_category", (q) =>
      q.eq("orgId", orgId).eq("userId", userId).eq("category", category)
    )
    .unique();
}

/**
 * Core fan-out for a single recipient. In-app is never optional (matches how
 * Amazon/Google treat account/order notifications) — it's always inserted.
 * Email/WhatsApp are scheduled as actions (not sent inline) so a slow or
 * failing delivery never blocks or fails the triggering mutation's
 * transaction; each action does its own rate limiting (see convex/email.ts
 * and convex/whatsappSend.ts).
 */
export async function dispatch(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  type: NotificationType,
  data?: NotificationData,
  opts: DispatchOpts = {}
) {
  const def = NOTIFICATION_TYPES[type];

  await ctx.db.insert("notifications", {
    orgId,
    userId,
    type,
    category: def.category,
    priority: def.priority,
    data,
    isRead: false,
    link: opts.link,
    relatedTaskId: opts.relatedTaskId,
  });

  const user = await ctx.db.get(userId);
  if (!user) return;

  const pref = await getPreference(ctx, orgId, userId, def.category);
  // Email defaults to the type's criticalDefault (opt-out for actionable/
  // account-affecting categories, opt-in otherwise) until the user sets an
  // explicit preference. WhatsApp and push are always opt-in.
  const emailEnabled = pref ? pref.emailEnabled : def.criticalDefault;
  const whatsappEnabled = pref ? pref.whatsappEnabled : false;
  const pushEnabled = pref ? (pref.pushEnabled ?? false) : false;
  const locale = user.locale ?? "en";

  if (emailEnabled && user.email) {
    await ctx.scheduler.runAfter(0, internal.email.sendNotificationEmail, {
      toEmail: user.email,
      locale,
      type,
      data: data ?? {},
    });
  }

  const whatsappPlanEnabled = whatsappEnabled && await hasPlanFeature(ctx, orgId, "whatsapp");
  if (whatsappPlanEnabled && user.whatsappPhone) {
    await ctx.scheduler.runAfter(0, internal.whatsappSend.sendNotificationWhatsapp, {
      orgId,
      toPhone: user.whatsappPhone,
      locale,
      type,
      data: data ?? {},
    });
  }

  if (pushEnabled) {
    await ctx.scheduler.runAfter(0, internal.pushSend.sendNotificationPush, {
      orgId,
      userId,
      locale,
      type,
      data: data ?? {},
      link: opts.link,
    });
  }
}

/** Notifies a single specific user. */
export async function notifyUser(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  type: NotificationType,
  data?: NotificationData,
  opts?: DispatchOpts
) {
  await dispatch(ctx, orgId, userId, type, data, opts);
}

/** Notifies every member holding MANAGE_USERS in the org (managers/owners). */
export async function notifyManagers(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  type: NotificationType,
  data?: NotificationData,
  opts?: DispatchOpts & { excludeUserId?: Id<"users"> }
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  for (const membership of memberships) {
    if (opts?.excludeUserId && membership.userId === opts.excludeUserId) continue;
    const role = await ctx.db.get(membership.roleId);
    if (!role) continue;
    if (role.permissions.includes(PERMISSIONS.MANAGE_USERS)) {
      await dispatch(ctx, orgId, membership.userId, type, data, opts);
    }
  }
}

/** Notifies every member holding a specific permission — for cases like `marketplace:respond` where the relevant audience is narrower than "all managers" but wider than a single assignee. */
export async function notifyByPermission(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  permission: Permission,
  type: NotificationType,
  data?: NotificationData,
  opts?: DispatchOpts & { excludeUserId?: Id<"users"> }
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  for (const membership of memberships) {
    if (opts?.excludeUserId && membership.userId === opts.excludeUserId) continue;
    const role = await ctx.db.get(membership.roleId);
    if (!role) continue;
    if (role.permissions.includes(permission)) {
      await dispatch(ctx, orgId, membership.userId, type, data, opts);
    }
  }
}

/** Notifies every member of the org (org-wide events like broadcasts/membership changes). */
export async function notifyAllMembers(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  type: NotificationType,
  data?: NotificationData,
  opts?: DispatchOpts & { excludeUserId?: Id<"users"> }
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  for (const membership of memberships) {
    if (opts?.excludeUserId && membership.userId === opts.excludeUserId) continue;
    await dispatch(ctx, orgId, membership.userId, type, data, opts);
  }
}

/** Notifies only the org's OWNER(s) — for security/financially sensitive events. */
export async function notifyOwner(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  type: NotificationType,
  data?: NotificationData,
  opts?: DispatchOpts
) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  for (const membership of memberships) {
    const role = await ctx.db.get(membership.roleId);
    if (isSystemOwnerRole(role)) {
      await dispatch(ctx, orgId, membership.userId, type, data, opts);
    }
  }
}

/**
 * Helper to get the name of the actor performing the action.
 */
export async function getActorName(ctx: MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return "Someone";

  const user = await ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .first();

  return user?.name || identity.name || "A team member";
}
