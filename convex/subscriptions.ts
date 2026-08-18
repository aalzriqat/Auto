import { v, ConvexError } from "convex/values";
import { query, action, internalQuery } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth, requireSuperAdmin } from "./utils/tenancy";
import { logAdminAction } from "./adminAudit";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";

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

export const planGateValidator = v.union(
  v.literal("socialInbox"),
  v.literal("whatsapp"),
  v.literal("internalMessaging"),
  v.literal("accounting"),
  v.literal("customRoles"),
  v.literal("websiteBuilder"),
  v.literal("multiBranch"),
  v.literal("marketplace"),
  v.literal("marketplaceLeadPackage"),
  v.literal("marketplaceFeatured")
);

/** Page size for the exact seat count in `canAddMember`. */
const SEAT_COUNT_BATCH_SIZE = 100;

const PLAN_GATE_LABELS: Record<PlanGate, string> = {
  socialInbox: "Social Inbox",
  whatsapp: "WhatsApp",
  internalMessaging: "internal messaging",
  accounting: "accounting",
  customRoles: "custom roles",
  websiteBuilder: "website builder",
  multiBranch: "multi-branch",
  marketplace: "the dealer marketplace",
  marketplaceLeadPackage: "marketplace lead packages",
  marketplaceFeatured: "marketplace featured placement",
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** The stored lifecycle states a subscription row can hold. */
export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "expired";

/**
 * The ONE place that decides whether a paid period has lapsed.
 *
 * Takes `now` as an argument and never reads the clock itself. That is the
 * whole point. A query execution that reads the clock is marked `observed_time`
 * by Convex, which does not make it uncacheable outright — it BOUNDS how long
 * the cached result may be reused, after which the entry is rejected on age.
 * The default works out to roughly 17s and is deployment-overridable; measured
 * independently here as longer than 2s and shorter than 20s. Clients
 * re-subscribe about every 52s, so such an entry is always past its limit and
 * every plan-gated query re-executed, every time — ~326 MB/day of production DB
 * I/O per open tab, larger than the entire defect SCRUM-21 was opened for.
 *
 * ⚠️ It is the ACT of calling the clock that starts that bound, not what the
 * value is used for: probes that read `Date.now()` and discarded it behaved
 * identically to ones that used it. Rounding or quantising the timestamp
 * therefore fixes NOTHING — the call has to leave the reactive path entirely,
 * across the whole reachable call graph. Entitlement is now a *stored* fact
 * that a reconciler maintains, and the read path is a pure function of stored
 * fields (SCRUM-145).
 *
 * Only the `active` -> `expired` edge is time-derived. `past_due` and
 * `cancelled` are billing decisions and are never re-derived from the clock —
 * inferring them here would let a cron overrule the billing provider.
 *
 * Idempotent, and NOT a one-way door: re-running it on a row whose
 * `currentPeriodEnd` is in the future returns `active` unchanged, so a renewal
 * applied through `adminUpdateSubscription` sticks and is not undone on the
 * next sweep.
 */
export function settledSubscriptionStatus(
  sub: { plan: PlanId; status: SubscriptionStatus; currentPeriodEnd?: number },
  now: number
): SubscriptionStatus {
  // The free plan has no paid period, so there is nothing that can lapse.
  if (sub.plan === "free") return sub.status;
  // No period end recorded means no expiry was ever agreed. Treating a missing
  // value as "already over" would strip a paying org of its plan.
  //
  // ⚠️ Mutation testing: changing this to `=== null` SURVIVES the whole suite.
  // It is not load-bearing at runtime, because `undefined < now` is already
  // false and the comparison below therefore returns "active" on its own. What
  // actually enforces it is the type system — the mutant fails `tsc` with
  // TS18048 ("'sub.currentPeriodEnd' is possibly 'undefined'"), verified. Kept
  // as an explicit guard rather than relying on a JS coercion, and recorded
  // here so the green suite is not mistaken for behavioural coverage.
  if (sub.currentPeriodEnd === undefined) return sub.status;
  if (sub.status !== "active") return sub.status;
  // `<=`, matching the candidate range's `lte`. They disagreed: the range
  // selected a row sitting exactly on its period end and this test then refused
  // it, so a full page of boundary rows expired nothing and scheduled nothing.
  // Expiring AT the end is not expiring BEFORE it — the period is over at that
  // instant — so the "never downgrade early" rule is untouched.
  return sub.currentPeriodEnd <= now ? "expired" : "active";
}

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

/**
 * Moves subscriptions whose paid period has ended to `expired`.
 *
 * The backstop half of SCRUM-145. The authoritative, immediate path is
 * `adminUpdateSubscription` — this only catches lapses that happen purely
 * because time passed and nobody told us. Runs every 5 minutes, so the maximum
 * stale-paid access caused by reaching `currentPeriodEnd` is 5 minutes.
 *
 * Writes a heartbeat because entitlement expiry now DEPENDS on this job. Before
 * SCRUM-145 expiry was re-derived on every read and could not silently stop;
 * now it can, so the stall has to be visible on the admin panel rather than
 * discovered as orgs quietly keeping paid features.
 */
export const reconcileExpiredSubscriptions = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);

    // ⚠️ BOTH restrictions are load-bearing, and each closes half of the same
    // starvation class. A row that qualifies for this range but is then skipped
    // by the loop qualifies again on every future run, for ever — and because
    // the index orders ascending by `currentPeriodEnd`, those stale timestamps
    // sort AHEAD of a freshly-lapsed paid row's much larger one. Past `limit`
    // of them, no paid subscription is ever reached again: `expired: 0` and a
    // green heartbeat, permanently, with nothing to distinguish it from a quiet
    // day.
    //
    //   gte(-Infinity) — `currentPeriodEnd` is optional and an undefined value
    //   sorts BELOW every number, so a plain `lte(now)` returns every row that
    //   never had a period at all. This bound means "is a number".
    //
    //   plan equality — a FREE row can still carry a real, stale
    //   `currentPeriodEnd`, which the bound above cannot exclude. Downgrading an
    //   org to free through `adminUpdateSubscription` does not require clearing
    //   the optional period-end field, so this is ordinary admin output rather
    //   than a corrupt row.
    //
    // ⚠️ This is deliberately an INDEXED equality per paid plan, not
    // `.filter(neq(plan, "free"))`. A filter still scans and is charged for every
    // discarded document, and a Convex transaction aborts past 32,000 scanned
    // documents — so enough free rows ordered ahead of a lapsed paid row would
    // abort the query before `.take()` reached it, and abort again on every
    // later run. The candidate read also happens before the try/catch below, so
    // that failure would not even leave a heartbeat. Derived from PLANS rather
    // than hardcoded, so a new paid tier cannot be silently left out.
    // ⚠️ Plans are drained in PLANS order, so an extreme backlog concentrated in
    // an earlier tier is processed before a later tier is reached. The chain
    // self-corrects through near-immediate `runAfter(0)` hops, so the five-minute
    // bound holds at realistic churn — but it is a fairness property no test
    // exercises across plans, and at a backlog far beyond organic volume the
    // later tiers would wait. Scoped rather than claimed absolutely.
    const paidPlans = (Object.keys(PLANS) as PlanId[]).filter((p) => p !== "free");
    const candidates: Doc<"subscriptions">[] = [];
    let expired = 0;
    try {
      // ⚠️ The candidate read lives INSIDE the try, not before it. A read can
      // fail too — the documented scanned-document cap is the obvious way — and
      // when it did, the mutation threw before any heartbeat was written. The
      // admin panel then showed neither a failure nor a recent success, which
      // is precisely the silent state the heartbeat exists to prevent.
      for (const plan of paidPlans) {
        if (candidates.length >= limit) break;
        const rows = await ctx.db
          .query("subscriptions")
          .withIndex("by_status_plan_period_end", (q) =>
            q
              .eq("status", "active")
              .eq("plan", plan)
              .gte("currentPeriodEnd", -Infinity)
              .lte("currentPeriodEnd", now)
          )
          .take(limit - candidates.length);
        candidates.push(...rows);
      }

      for (const sub of candidates) {
        // Still re-checked through the shared transition: the range and filter
        // narrow the page, they do not decide the outcome.
        const next = settledSubscriptionStatus(sub, now);
        if (next === sub.status) continue;
        await ctx.db.patch(sub._id, { status: next, updatedAt: now });
        expired += 1;
      }
    } catch (err) {
      // ⚠️ Deliberately NOT rethrown, and this is the opposite of what the
      // only other heartbeat-writing cron does. `crons.triggerAlarms` inserts a
      // `success: false` row and then rethrows — but a Convex mutation is
      // atomic, so the rethrow rolls that failure heartbeat back along with
      // everything else and the failure is recorded nowhere. Verified by
      // mutation, and filed as its own defect rather than copied.
      //
      // Swallowing is safe HERE specifically because this sweep is idempotent
      // and runs every 5 minutes: committing partial progress plus an honest
      // failure row loses nothing, and the next run finishes the batch. Do not
      // copy this into a job where partial commitment is unsafe.
      //
      // ⚠️ DISCLOSED TEST GAP: nothing exercises this branch. No test asserts
      // `failed: true`, the `success:false` row, that earlier in-loop progress
      // survives, or that no continuation is scheduled — because there is no
      // seam to make `ctx.db.patch` throw from outside the mutation, and
      // `adminSystem.test.ts` only checks that the job NAME is registered, not
      // that this control flow runs. So a future edit reintroducing the rethrow
      // — the exact `crons.triggerAlarms` bug this block exists to avoid — would
      // pass the whole suite. Stated here rather than left implied, to the same
      // standard as the scan-limit disclosure above. Tracked on SCRUM-149.
      await ctx.db.insert("cronHeartbeats", {
        jobName: "reconcile-expired-subscriptions",
        ranAt: now,
        success: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return { scanned: candidates.length, expired, failed: true };
    }

    // ⚠️ The five-minute bound is a promise about EVERY subscription, not about
    // the first `limit` of them. The cron fires once every five minutes with no
    // arguments, so left to the cron alone a 101st lapsed subscription waits for
    // the next tick — up to ten minutes from its lapse — and the tail grows by
    // another interval per page. Draining the eligible set in one sweep is what
    // makes the stated contract true rather than true-for-a-hundred.
    //
    // Guarded on PROGRESS, not on a full page. A full page that expired nothing
    // would mean the batch is occupied by rows the loop refuses, which is the
    // starvation shape — rescheduling on fullness alone would spin for ever
    // instead of stopping. Requiring `expired > 0` means every continuation has
    // strictly reduced the eligible set, so the chain terminates on data.
    //
    // ⚠️ This guard was previously documented here as unreachable defence. That
    // was WRONG, and an independent reviewer disproved it by execution: the
    // candidate range used `lte(now)` while the transition used `< now`, so a
    // page of rows sitting exactly on the boundary expired nothing and
    // scheduled nothing. The mismatch is fixed and pinned by a boundary test,
    // which is what makes a no-progress full page unreachable again — the guard
    // stays as defence against exactly that kind of drift recurring, and this
    // note stays as the reason not to trust a fresh "unreachable" claim here.
    if (expired > 0 && candidates.length === limit) {
      await ctx.scheduler.runAfter(0, internal.subscriptions.reconcileExpiredSubscriptions, {
        limit,
      });
    }

    await ctx.db.insert("cronHeartbeats", {
      jobName: "reconcile-expired-subscriptions",
      ranAt: now,
      success: true,
      detail: `${expired} expired of ${candidates.length} scanned`,
    });

    return { scanned: candidates.length, expired, failed: false };
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

    // Impersonation grants and memberships pending offboarding are not seats, so
    // they have to be excluded — but excluding them in memory after a
    // `.take(maxUsers + 50)` made the seat count a guess. The prefix is ordered
    // by _creationTime, not by whether a row is a real seat: an org with more
    // than `maxUsers + 50` membership rows undercounts its real members by
    // however many live seats fall past the prefix, and undercounting is the
    // direction that hands out a free seat.
    //
    // Counting is exact instead. `maxUsers` is single-digit to low-double-digit
    // on every paid plan, so this stops as soon as the cap is reached and reads
    // no more rows than the old prefix did in the ordinary case.
    let realMembers = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await ctx.db
        .query("memberships")
        .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .paginate({ cursor, numItems: SEAT_COUNT_BATCH_SIZE });

      for (const m of page.page) {
        if (!m.impersonationGrantId && !m.offboardingStatus) realMembers++;
      }

      if (realMembers >= plan.maxUsers) {
        return {
          allowed: false,
          limit: plan.maxUsers,
          current: realMembers,
          upgradeRequired: planId as PlanId,
        };
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
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

    // `daysUntilRenewal` used to be computed here from `Date.now()`, which
    // bounded this query's cache lifetime on its own — fixing `getOrgPlan`
    // alone would not have helped it (SCRUM-145). It is a display value derived
    // entirely from `currentPeriodEnd`, which is returned, so any caller that
    // wants it can compute it client-side against the viewer's own clock.
    // Nothing rendered it: it appeared only as a type in the mobile API surface.
    return {
      ...(sub ?? { plan: "free" as const, status: "active" as const }),
      planDetails: plan,
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
      // Membership-checked: throws unless the caller belongs to args.orgId.
      ctx.runQuery(internal.subscriptions._requireMemberOrg, { orgId: args.orgId }),
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

/**
 * Membership-checked counterpart to `_getOrg`, for action call paths.
 *
 * `requestUpgrade` is an action, so it has no `ctx.db` and cannot call
 * `requireTenantAuth` itself. Convex propagates the caller's identity through
 * `ctx.runQuery`, so the check belongs in an internalQuery — the same shape
 * `facebookEngagement.requireSendDmAccess` uses. Without this, any signed-in
 * user could pass any orgId and read that org's name and plan (and have an
 * upgrade email sent on its behalf).
 */
export const _requireMemberOrg = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId);
    return await ctx.db.get(args.orgId);
  },
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
    const admin = await requireSuperAdmin(ctx);

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const now = Date.now();
    const { orgId, ...rest } = args;

    // Both writers settle through the same transition, so an admin cannot leave
    // a row claiming `active` with a period that already ended — which, now that
    // the read path trusts stored state, would grant paid access indefinitely
    // until the next sweep noticed. Before SCRUM-145 the read-time clock check
    // absorbed that inconsistency silently.
    //
    // Settled BEFORE the audit call so `after` records what was actually
    // stored. Logging the requested values instead would make the audit trail
    // disagree with the row whenever settling changed the status.
    //
    // ⚠️ Built from the MERGED row, not the arguments. Convex strips omitted
    // optional arguments, so an admin who edits plan/status without touching
    // the other fields leaves them absent from `rest` — while `ctx.db.patch`
    // PRESERVES whatever is stored. Two things went wrong when this worked off
    // the request alone:
    //
    //   1. Settlement saw no period at all, returned the requested status
    //      untouched, and stored `active` over a period that had already
    //      ended — exactly the state this step exists to make impossible.
    //   2. The audit `after` omitted every field the admin did not retype, so
    //      it could not be reconciled against the row it claims to describe.
    //
    // Spread from `rest` rather than listing fields, so a future argument is
    // carried automatically; the three persisted optionals are then merged
    // explicitly because those are the ones `patch` preserves.
    const effective = {
      ...rest,
      billingInterval: rest.billingInterval ?? existing?.billingInterval,
      currentPeriodStart: rest.currentPeriodStart ?? existing?.currentPeriodStart,
      currentPeriodEnd: rest.currentPeriodEnd ?? existing?.currentPeriodEnd,
    };
    const settled = { ...effective, status: settledSubscriptionStatus(effective, now) };

    // A plan/status change is a billing change, and it used to leave no trace
    // of who made it. Written before the return so both branches are covered.
    await logAdminAction(ctx, admin, {
      action: "adminUpdateSubscription",
      targetTable: "subscriptions",
      targetId: existing?._id,
      orgId,
      before: existing
        ? {
            plan: existing.plan,
            status: existing.status,
            billingInterval: existing.billingInterval,
            currentPeriodStart: existing.currentPeriodStart,
            currentPeriodEnd: existing.currentPeriodEnd,
          }
        : undefined,
      // Effective state, so the trail matches the row that was written. The
      // requested status is preserved alongside it whenever normalisation
      // overruled the admin, because "chose expired" and "chose active and was
      // corrected" are different acts and a billing audit should not conflate
      // them.
      after: settled.status === rest.status
        ? { ...settled }
        : { ...settled, requestedStatus: rest.status },
    });

    if (existing) {
      await ctx.db.patch(existing._id, { ...settled, renewalReminderSentAt: undefined, updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("subscriptions", {
      orgId,
      ...settled,
      createdAt: now,
      updatedAt: now,
    });
  },
});
