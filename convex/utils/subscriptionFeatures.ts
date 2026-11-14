import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

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
      marketplace: true,
      marketplaceLeadPackage: false,
      marketplaceFeatured: false,
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
      marketplace: true,
      marketplaceLeadPackage: false,
      marketplaceFeatured: false,
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
      "Marketplace lead packages",
    ],
    featuresAr: [
      "حتى 150 مركبة",
      "15 مستخدمًا",
      "صندوق التواصل الاجتماعي (إنستغرام + فيسبوك)",
      "إشعارات واتساب",
      "المراسلة الداخلية",
      "وحدة المحاسبة والتقارير المتقدمة",
      "أدوار وصلاحيات مخصصة",
      "باقات عملاء منصة السوق",
    ],
    gates: {
      socialInbox: true,
      whatsapp: true,
      internalMessaging: true,
      accounting: true,
      customRoles: true,
      websiteBuilder: false,
      multiBranch: false,
      marketplace: true,
      marketplaceLeadPackage: true,
      marketplaceFeatured: false,
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
      "Featured marketplace placement",
    ],
    featuresAr: [
      "مركبات ومستخدمون غير محدودين",
      "منشئ المواقع (جميع القوالب المميزة)",
      "متعدد الفروع / متعدد المؤسسات",
      "دعم ذو أولوية",
      "ظهور مميز في منصة السوق",
    ],
    gates: {
      socialInbox: true,
      whatsapp: true,
      internalMessaging: true,
      accounting: true,
      customRoles: true,
      websiteBuilder: true,
      multiBranch: true,
      marketplace: true,
      marketplaceLeadPackage: true,
      marketplaceFeatured: true,
    },
  },
} as const;

export type PlanId = keyof typeof PLANS;
export type PlanGate = keyof (typeof PLANS)["enterprise"]["gates"];

/**
 * Returns the org's active plan, defaulting to "free" if no subscription row exists.
 *
 * Reads STORED state only. It deliberately does not re-check `currentPeriodEnd`
 * against the clock; `reconcileExpiredSubscriptions` is what moves a lapsed row
 * to `expired`, within a bounded lag (5 minutes; owner-accepted, SCRUM-145).
 * Re-adding a `Date.now()` comparison here would silently re-bound the cache
 * lifetime of every plan-gated query, and at the client's re-subscription
 * interval that means none of them are ever served from cache again.
 */
export async function getOrgPlan(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<PlanId> {
  const sub = await ctx.db
    .query("subscriptions")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();

  if (!sub) return "free";
  if (sub.status !== "active") return "free";
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
