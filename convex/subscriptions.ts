import { v, ConvexError } from "convex/values";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth, requireSuperAdmin } from "./utils/tenancy";
import { Id } from "./_generated/dataModel";

// ─── Plan catalogue ──────────────────────────────────────────────────────────

export const PLANS = {
  free: {
    id: "free" as const,
    name: "Free",
    nameAr: "مجاني",
    priceJod: 0,
    annualPriceJod: 0,
    maxVehicles: 15,
    maxUsers: 2,
    features: [
      "Up to 15 vehicles",
      "2 users",
      "Core CRM: customers, leads, sales, tasks",
    ],
    gates: {
      socialInbox: false,
      whatsapp: false,
      internalMessaging: false,
      accounting: false,
      customRoles: false,
      websiteBuilder: false,
      multiBranch: false,
    },
  },
  starter: {
    id: "starter" as const,
    name: "Starter",
    nameAr: "المبتدئ",
    priceJod: 15,
    annualPriceJod: 12, // ~20% off
    maxVehicles: 50,
    maxUsers: 5,
    features: [
      "Up to 50 vehicles",
      "5 users",
      "Full CRM + financing + reports + expenses",
    ],
    gates: {
      socialInbox: false,
      whatsapp: false,
      internalMessaging: false,
      accounting: false,
      customRoles: false,
      websiteBuilder: false,
      multiBranch: false,
    },
  },
  professional: {
    id: "professional" as const,
    name: "Professional",
    nameAr: "الاحترافي",
    priceJod: 35,
    annualPriceJod: 28, // 20% off
    maxVehicles: 150,
    maxUsers: 15,
    features: [
      "Up to 150 vehicles",
      "15 users",
      "Social Inbox (Instagram + Facebook)",
      "WhatsApp notifications",
      "Internal messaging",
      "Accounting module & advanced reports",
      "Custom roles & permissions",
    ],
    gates: {
      socialInbox: true,
      whatsapp: true,
      internalMessaging: true,
      accounting: true,
      customRoles: true,
      websiteBuilder: false,
      multiBranch: false,
    },
  },
  enterprise: {
    id: "enterprise" as const,
    name: "Enterprise",
    nameAr: "المؤسسي",
    priceJod: 75,
    annualPriceJod: 60, // 20% off
    maxVehicles: -1, // unlimited
    maxUsers: -1,   // unlimited
    features: [
      "Unlimited vehicles & users",
      "Website builder (all premium themes)",
      "Multi-branch / multi-org",
      "Priority support",
    ],
    gates: {
      socialInbox: true,
      whatsapp: true,
      internalMessaging: true,
      accounting: true,
      customRoles: true,
      websiteBuilder: true,
      multiBranch: true,
    },
  },
} as const;

export type PlanId = keyof typeof PLANS;
export type PlanGate = keyof (typeof PLANS)["enterprise"]["gates"];

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Returns the org's active plan, defaulting to "free" if no subscription row exists. */
async function getOrgPlan(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<PlanId> {
  const sub = await ctx.db
    .query("subscriptions")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  if (!sub) return "free";
  // Expired paid plan falls back to free
  if (sub.status === "expired") return "free";
  return sub.plan;
}

export const createFreeSubscription = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("subscriptions", {
      orgId: args.orgId,
      plan: "free",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const getByOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();
  },
});

export const markRenewalReminderSent = internalMutation({
  args: { subscriptionId: v.id("subscriptions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.subscriptionId, {
      renewalReminderSentAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/** Fetches active paid subscriptions whose period ends within `withinMs` that haven't been reminded. */
export const getExpiringRenewals = internalQuery({
  args: { withinMs: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cutoff = now + args.withinMs;

    const rows = await ctx.db
      .query("subscriptions")
      .withIndex("by_status_period_end", (q) =>
        q.eq("status", "active").lte("currentPeriodEnd", cutoff)
      )
      .take(100);

    return rows.filter(
      (s) =>
        s.plan !== "free" &&
        (s.currentPeriodEnd ?? 0) >= now &&
        !s.renewalReminderSentAt
    );
  },
});

// ─── Feature gate helpers (internal) ─────────────────────────────────────────

export const canAddVehicle = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const planId = await getOrgPlan(ctx, args.orgId);
    const plan = PLANS[planId];
    if (plan.maxVehicles === -1) return { allowed: true };

    // Count non-deleted vehicles for this org
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(plan.maxVehicles + 1);

    const activeCount = vehicles.filter((v) => !v.isDeleted).length;
    if (activeCount >= plan.maxVehicles) {
      return {
        allowed: false,
        limit: plan.maxVehicles,
        current: activeCount,
        upgradeRequired: planId as PlanId,
      };
    }
    return { allowed: true };
  },
});

export const canAddMember = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const planId = await getOrgPlan(ctx, args.orgId);
    const plan = PLANS[planId];
    if (plan.maxUsers === -1) return { allowed: true };

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(plan.maxUsers + 1);

    // Exclude impersonation grants
    const realMembers = memberships.filter((m) => !m.impersonationGrantId);
    if (realMembers.length >= plan.maxUsers) {
      return {
        allowed: false,
        limit: plan.maxUsers,
        current: realMembers.length,
        upgradeRequired: planId as PlanId,
      };
    }
    return { allowed: true };
  },
});

export const hasFeature = internalQuery({
  args: {
    orgId: v.id("organizations"),
    gate: v.string(),
  },
  handler: async (ctx, args) => {
    const planId = await getOrgPlan(ctx, args.orgId);
    const gates = PLANS[planId].gates as Record<string, boolean>;
    return gates[args.gate] ?? false;
  },
});

// ─── Public queries ───────────────────────────────────────────────────────────

export const getMySubscription = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);

    const sub = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const planId: PlanId = sub?.status === "expired" || !sub ? "free" : sub.plan;
    const plan = PLANS[planId];
    const now = Date.now();

    const daysUntilRenewal =
      sub?.currentPeriodEnd
        ? Math.max(0, Math.ceil((sub.currentPeriodEnd - now) / (24 * 60 * 60 * 1000)))
        : null;

    return {
      ...(sub ?? { plan: "free" as const, status: "active" as const }),
      planDetails: plan,
      daysUntilRenewal,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    };
  },
});

export const getPlans = query({
  args: {},
  handler: async () => Object.values(PLANS),
});

export const getUsageStats = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);

    const planId = await getOrgPlan(ctx, args.orgId);
    const plan = PLANS[planId];

    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const vehicleCount = vehicles.filter((v) => !v.isDeleted).length;

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const memberCount = memberships.filter((m) => !m.impersonationGrantId).length;

    return {
      vehicleCount,
      memberCount,
      maxVehicles: plan.maxVehicles,
      maxUsers: plan.maxUsers,
    };
  },
});

// ─── Admin mutations (super admin only) ──────────────────────────────────────

export const adminUpdateSubscription = mutation({
  args: {
    orgId: v.id("organizations"),
    plan: v.union(
      v.literal("free"),
      v.literal("starter"),
      v.literal("professional"),
      v.literal("enterprise")
    ),
    status: v.union(
      v.literal("active"),
      v.literal("past_due"),
      v.literal("cancelled"),
      v.literal("expired")
    ),
    billingInterval: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const now = Date.now();
    const { orgId, ...rest } = args;

    if (existing) {
      await ctx.db.patch(existing._id, { ...rest, renewalReminderSentAt: undefined, updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("subscriptions", {
      orgId,
      ...rest,
      createdAt: now,
      updatedAt: now,
    });
  },
});
