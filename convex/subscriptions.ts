import { v, ConvexError } from "convex/values";
import { query, mutation, action, internalMutation, internalQuery } from "./_generated/server";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth, requireSuperAdmin } from "./utils/tenancy";
import { internal } from "./_generated/api";
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
    featuresAr: [
      "حتى 15 مركبة",
      "مستخدمان",
      "إدارة العملاء والعملاء المحتملين والمبيعات والمهام",
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
    featuresAr: [
      "حتى 50 مركبة",
      "5 مستخدمين",
      "إدارة علاقات عملاء كاملة + تمويل + تقارير + مصروفات",
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
    featuresAr: [
      "حتى 150 مركبة",
      "15 مستخدمًا",
      "صندوق التواصل الاجتماعي (إنستغرام + فيسبوك)",
      "إشعارات واتساب",
      "المراسلة الداخلية",
      "وحدة المحاسبة والتقارير المتقدمة",
      "أدوار وصلاحيات مخصصة",
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
    featuresAr: [
      "مركبات ومستخدمون غير محدودين",
      "منشئ المواقع (جميع القوالب المميزة)",
      "متعدد الفروع / متعدد المؤسسات",
      "دعم ذو أولوية",
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

export const planGateValidator = v.union(
  v.literal("socialInbox"),
  v.literal("whatsapp"),
  v.literal("internalMessaging"),
  v.literal("accounting"),
  v.literal("customRoles"),
  v.literal("websiteBuilder"),
  v.literal("multiBranch")
);

const PLAN_GATE_LABELS: Record<PlanGate, string> = {
  socialInbox: "Social Inbox",
  whatsapp: "WhatsApp",
  internalMessaging: "internal messaging",
  accounting: "accounting",
  customRoles: "custom roles",
  websiteBuilder: "website builder",
  multiBranch: "multi-branch",
};

/** Returns the org's active plan, defaulting to "free" if no subscription row exists. */
export async function getOrgPlan(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<PlanId> {
  const sub = await ctx.db
    .query("subscriptions")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  if (!sub) return "free";
  if (sub.status !== "active") return "free";
  if (sub.currentPeriodEnd !== undefined && sub.currentPeriodEnd < Date.now()) return "free";
  return sub.plan;
}

export async function hasPlanFeature(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  gate: PlanGate
) {
  const planId = await getOrgPlan(ctx, orgId);
  return PLANS[planId].gates[gate];
}

export async function requireFeature(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  gate: PlanGate
) {
  if (await hasPlanFeature(ctx, orgId, gate)) return;
  throw new ConvexError(`Upgrade required: your current plan does not include ${PLAN_GATE_LABELS[gate]}.`);
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
      .take(1000);

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

    // Count non-deleted vehicles — filter before take so deleted rows do not
    // consume the prefix and cause the limit check to undercount.
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .take(plan.maxVehicles + 1);

    const activeCount = vehicles.length;
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

    // Fetch enough rows to account for impersonation/offboarding rows that will
    // be excluded, so the real-member count isn't undercounted by the prefix.
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(plan.maxUsers + 50);

    // Exclude impersonation grants and members pending offboarding.
    const realMembers = memberships.filter((m) => !m.impersonationGrantId && !m.offboardingStatus);
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
    gate: planGateValidator,
  },
  handler: async (ctx, args) => {
    return await hasPlanFeature(ctx, args.orgId, args.gate);
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

    const planId = await getOrgPlan(ctx, args.orgId);
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
    const memberCount = memberships.filter((m) => !m.impersonationGrantId && !m.offboardingStatus).length;

    return {
      vehicleCount,
      memberCount,
      maxVehicles: plan.maxVehicles,
      maxUsers: plan.maxUsers,
    };
  },
});

// ─── Admin mutations (super admin only) ──────────────────────────────────────

export const getShowPricing = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("siteConfig")
      .withIndex("by_key", (q) => q.eq("key", "showPlanPricing"))
      .unique();
    return (row?.value as boolean | null | undefined) ?? true;
  },
});

export const requestUpgrade = action({
  args: {
    orgId: v.id("organizations"),
    targetPlan: v.string(),
    phone: v.string(),
    message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    const [user, org] = await Promise.all([
      ctx.runQuery(internal.subscriptions._getCallerUser, { clerkId: identity.subject }),
      ctx.runQuery(internal.subscriptions._getOrg, { orgId: args.orgId }),
    ]);

    if (!org) throw new ConvexError("Organization not found");

    const currentSub = await ctx.runQuery(internal.subscriptions.getByOrg, { orgId: args.orgId });

    await ctx.runAction(internal.email.sendUpgradeRequestEmail, {
      orgName: org.name,
      orgId: args.orgId,
      currentPlan: currentSub?.plan ?? "free",
      targetPlan: args.targetPlan,
      userName: user?.name ?? identity.name ?? "Unknown",
      userEmail: user?.email ?? identity.email ?? "unknown@unknown.com",
      phone: args.phone,
      message: args.message,
    });
  },
});

export const _getCallerUser = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
  },
});

export const _getOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => ctx.db.get(args.orgId),
});

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
