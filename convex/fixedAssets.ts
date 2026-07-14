import { v, ConvexError } from "convex/values";
import { mutation, internalMutation, internalQuery, query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyOwner, getActorName } from "./utils/notifications";
import {
  hookAssetCapitalized,
  hookDepreciationPosted,
  hookAssetImpaired,
  hookAssetDisposed,
  getOrgCurrency,
} from "./accounting/workflowHooks";
import { paymentMethodValidator } from "./utils/paymentMethods";

const methodValidator = v.literal("STRAIGHT_LINE");

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    return await ctx.db
      .query("fixedAssets")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .filter((q) => q.neq(q.field("isDeleted"), true)).paginate(args.paginationOpts);
  },
});

export const listEvents = query({
  args: { orgId: v.id("organizations"), assetId: v.id("fixedAssets") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.orgId !== args.orgId || asset.isDeleted) {
      throw new ConvexError("Fixed asset not found in this organization.");
    }
    return await ctx.db
      .query("fixedAssetEvents")
      .withIndex("by_org_asset_time", (q) => q.eq("orgId", args.orgId).eq("assetId", args.assetId))
      .order("desc")
      .collect();
  },
});

/**
 * Records and capitalizes a new fixed asset in one step: inserts the asset
 * record (ACTIVE, zero accumulated depreciation) and posts DR Fixed Assets /
 * CR cash-or-bank via hookAssetCapitalized. Replaces the old CRUD-only `add`,
 * which never touched the GL.
 */
export const capitalize = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    purchaseDate: v.number(),
    costMinor: v.number(),
    currency: v.optional(v.string()),
    salvageValueMinor: v.optional(v.number()),
    usefulLifeMonths: v.number(),
    method: v.optional(methodValidator),
    depreciationStartDate: v.optional(v.number()),
    paymentMethod: v.optional(paymentMethodValidator),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    if (!Number.isSafeInteger(args.costMinor) || args.costMinor <= 0) {
      throw new ConvexError("Cost must be a positive integer minor-unit amount.");
    }
    const salvageValueMinor = args.salvageValueMinor ?? 0;
    if (!Number.isSafeInteger(salvageValueMinor) || salvageValueMinor < 0) {
      throw new ConvexError("Salvage value must be a non-negative integer minor-unit amount.");
    }
    if (salvageValueMinor >= args.costMinor) {
      throw new ConvexError("Salvage value must be less than the asset's cost.");
    }
    if (!Number.isSafeInteger(args.usefulLifeMonths) || args.usefulLifeMonths <= 0) {
      throw new ConvexError("Useful life must be a positive integer number of months.");
    }

    const currency = args.currency ?? (await getOrgCurrency(ctx, args.orgId));
    const now = Date.now();

    const assetId = await ctx.db.insert("fixedAssets", {
      orgId: args.orgId,
      name: args.name,
      purchaseDate: args.purchaseDate,
      notes: args.notes,
      costMinor: args.costMinor,
      currency,
      salvageValueMinor,
      usefulLifeMonths: args.usefulLifeMonths,
      method: args.method ?? "STRAIGHT_LINE",
      depreciationStartDate: args.depreciationStartDate ?? args.purchaseDate,
      status: "ACTIVE",
      accumulatedDepreciationMinor: 0,
    });

    await ctx.db.insert("fixedAssetEvents", {
      orgId: args.orgId,
      assetId,
      type: "CAPITALIZE",
      amountMinor: args.costMinor,
      currency,
      occurredAt: args.purchaseDate,
      actorId: user._id,
      createdAt: now,
    });

    await hookAssetCapitalized(ctx, {
      orgId: args.orgId,
      assetId,
      costMinor: args.costMinor,
      currency,
      paymentMethod: args.paymentMethod,
      actorId: user._id,
      occurredAt: args.purchaseDate,
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "fixedAsset.changed", { actorName, assetLabel: args.name }, {
      link: `/${args.orgId}/accounting`,
    });

    return assetId;
  },
});

/** Non-financial metadata only — once capitalized, cost/currency/schedule are immutable (see architecture doc's "no in-place money edits" rule). Use impair/dispose for value changes. */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, assetId, ...updates } = args;

    const asset = await ctx.db.get(assetId);
    if (!asset || asset.orgId !== orgId) {
      throw new ConvexError("Fixed asset not found in this organization.");
    }

    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );
    if (Object.keys(cleanedUpdates).length > 0) {
      await ctx.db.patch(assetId, cleanedUpdates);
    }

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, orgId, "fixedAsset.changed", { actorName, assetLabel: asset.name }, {
      link: `/${orgId}/accounting`,
    });
  },
});

export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.orgId !== args.orgId) {
      throw new ConvexError("Fixed asset not found in this organization.");
    }
    // A capitalized asset has its cost sitting on the GL. Soft-deleting it
    // would hide it from the list and the depreciation cron while leaving
    // that cost on the books forever — the only GL-safe exit is dispose().
    // Legacy pre-Phase-11 assets never posted anything, so they may be
    // removed freely, as may already-DISPOSED assets (already derecognized).
    if (asset.costMinor != null && asset.status !== "DISPOSED") {
      throw new ConvexError("This asset is on the general ledger. Dispose it instead of deleting it.");
    }
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.assetId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "fixedAsset.changed", { actorName, assetLabel: asset.name }, {
      link: `/${args.orgId}/accounting`,
    });
  },
});

/**
 * Books an impairment: increases accumulated depreciation (reducing net book
 * value) by amountMinor and marks the asset IMPAIRED, which stops further
 * automatic monthly depreciation (this phase's model treats impairment as a
 * terminal revaluation, not a schedule restart — see GL Phase 11 notes).
 */
export const impair = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    amountMinor: v.number(),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.orgId !== args.orgId || asset.isDeleted) {
      throw new ConvexError("Fixed asset not found in this organization.");
    }
    if (asset.status !== "ACTIVE") {
      throw new ConvexError(`Only an ACTIVE asset can be impaired (this one is ${asset.status}).`);
    }
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
      throw new ConvexError("Impairment amount must be a positive integer minor-unit amount.");
    }

    const costMinor = asset.costMinor ?? 0;
    const accumulatedDepreciationMinor = asset.accumulatedDepreciationMinor ?? 0;
    const netBookValue = costMinor - accumulatedDepreciationMinor;
    if (args.amountMinor > netBookValue) {
      throw new ConvexError(
        `Impairment of ${args.amountMinor} exceeds the asset's net book value of ${netBookValue}.`
      );
    }

    const occurredAt = args.occurredAt ?? Date.now();
    const currency = asset.currency ?? (await getOrgCurrency(ctx, args.orgId));

    await ctx.db.patch(args.assetId, {
      accumulatedDepreciationMinor: accumulatedDepreciationMinor + args.amountMinor,
      status: "IMPAIRED",
    });

    await ctx.db.insert("fixedAssetEvents", {
      orgId: args.orgId,
      assetId: args.assetId,
      type: "IMPAIR",
      amountMinor: args.amountMinor,
      currency,
      occurredAt,
      actorId: user._id,
      createdAt: Date.now(),
    });

    await hookAssetImpaired(ctx, {
      orgId: args.orgId,
      assetId: args.assetId,
      amountMinor: args.amountMinor,
      currency,
      actorId: user._id,
      occurredAt,
    });
  },
});

/**
 * Derecognizes the asset: removes its cost and accumulated depreciation from
 * the GL, records any proceeds, and books the balancing gain/loss on disposal.
 */
export const dispose = mutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    proceedsMinor: v.optional(v.number()),
    occurredAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.orgId !== args.orgId || asset.isDeleted) {
      throw new ConvexError("Fixed asset not found in this organization.");
    }
    if (asset.status === "DISPOSED") {
      throw new ConvexError("This asset has already been disposed.");
    }
    if (asset.costMinor == null) {
      throw new ConvexError("This asset predates GL Phase 11 and has no capitalized cost on record; it cannot be disposed through this flow.");
    }

    const proceedsMinor = args.proceedsMinor ?? 0;
    if (!Number.isSafeInteger(proceedsMinor) || proceedsMinor < 0) {
      throw new ConvexError("Disposal proceeds must be a non-negative integer minor-unit amount.");
    }

    const occurredAt = args.occurredAt ?? Date.now();
    const currency = asset.currency ?? (await getOrgCurrency(ctx, args.orgId));
    const accumulatedDepreciationMinor = asset.accumulatedDepreciationMinor ?? 0;

    await ctx.db.patch(args.assetId, {
      status: "DISPOSED",
      disposedAt: occurredAt,
      disposalProceedsMinor: proceedsMinor,
    });

    await ctx.db.insert("fixedAssetEvents", {
      orgId: args.orgId,
      assetId: args.assetId,
      type: "DISPOSE",
      amountMinor: proceedsMinor,
      currency,
      occurredAt,
      actorId: user._id,
      createdAt: Date.now(),
    });

    await hookAssetDisposed(ctx, {
      orgId: args.orgId,
      assetId: args.assetId,
      costMinor: asset.costMinor,
      accumulatedDepreciationMinor,
      proceedsMinor,
      currency,
      actorId: user._id,
      occurredAt,
    });

    const actorName = await getActorName(ctx);
    await notifyOwner(ctx, args.orgId, "fixedAsset.changed", { actorName, assetLabel: asset.name }, {
      link: `/${args.orgId}/accounting`,
    });
  },
});

/**
 * Cron-callable: posts one month of straight-line depreciation for a single
 * ACTIVE asset, if it isn't already fully depreciated and this month is after
 * whatever was last posted. Uses the same explicit month-count schedule as
 * dealerProductDeferrals.recognizeDeferredCommissionForMonth: the
 * (usefulLifeMonths)th month always absorbs whatever remains, so the asset
 * always finishes depreciating in exactly usefulLifeMonths (never
 * usefulLifeMonths+1, which a plain Math.floor's rounding remainder could
 * previously require) regardless of rounding. Idempotent both via the
 * lastDepreciatedYearMonth/monthsDepreciated pre-checks (cheap, skip the call
 * entirely) and the underlying accounting event's own idempotency key
 * (authoritative).
 */
export const depreciateAssetForMonth = internalMutation({
  args: {
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    yearMonth: v.string(), // "YYYY-MM"
    occurredAt: v.number(),
    systemActorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.orgId !== args.orgId || asset.isDeleted) return { posted: false, reason: "not_found" };
    if (asset.status !== "ACTIVE") return { posted: false, reason: "not_active" };
    // Lexicographic comparison is safe for "YYYY-MM" strings. Equality alone
    // (the old check) only blocked re-running the *same* month — it let a
    // stale/earlier month slip through as a genuine second posting (its
    // idempotency key differs from any month already posted), silently
    // over-depreciating the asset.
    if (asset.lastDepreciatedYearMonth && args.yearMonth <= asset.lastDepreciatedYearMonth) {
      return { posted: false, reason: "not_after_last_depreciated_month" };
    }
    if (asset.costMinor == null || asset.usefulLifeMonths == null) return { posted: false, reason: "not_capitalized_under_gl_phase_11" };

    // Don't start the schedule before the asset's depreciation start date
    // (defaults to the purchase date at capitalization). "YYYY-MM" strings
    // compare correctly lexicographically.
    const startDate = new Date(asset.depreciationStartDate ?? asset.purchaseDate);
    const startYearMonth = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;
    if (args.yearMonth < startYearMonth) return { posted: false, reason: "before_depreciation_start" };

    const salvageValueMinor = asset.salvageValueMinor ?? 0;
    const accumulatedDepreciationMinor = asset.accumulatedDepreciationMinor ?? 0;
    const depreciableBase = asset.costMinor - salvageValueMinor;
    const remaining = depreciableBase - accumulatedDepreciationMinor;
    if (remaining <= 0) return { posted: false, reason: "fully_depreciated" };

    // Explicit month-count schedule, not just "cap at remaining": a plain
    // min(Math.floor(base/life), remaining) still needs a (life+1)th call
    // whenever base doesn't divide evenly (e.g. 100/3 -> 33+33+33, 1 left
    // over). Using ceil for every month before the last guarantees the last
    // contractual month is always <= the flat share, so it can absorb
    // whatever remains without overshooting past usefulLifeMonths.
    const monthsDepreciated = asset.monthsDepreciated ?? 0;
    const isFinalContractualMonth = monthsDepreciated + 1 >= asset.usefulLifeMonths;
    const flatMonthlyAmount = Math.ceil(depreciableBase / asset.usefulLifeMonths);
    const amountMinor = isFinalContractualMonth ? remaining : Math.min(flatMonthlyAmount, remaining);

    const currency = asset.currency ?? (await getOrgCurrency(ctx, args.orgId));

    await ctx.db.patch(args.assetId, {
      accumulatedDepreciationMinor: accumulatedDepreciationMinor + amountMinor,
      monthsDepreciated: monthsDepreciated + 1,
      lastDepreciatedYearMonth: args.yearMonth,
    });

    await ctx.db.insert("fixedAssetEvents", {
      orgId: args.orgId,
      assetId: args.assetId,
      type: "DEPRECIATE",
      amountMinor,
      currency,
      occurredAt: args.occurredAt,
      actorId: args.systemActorId,
      createdAt: Date.now(),
    });

    await hookDepreciationPosted(ctx, {
      orgId: args.orgId,
      assetId: args.assetId,
      yearMonth: args.yearMonth,
      amountMinor,
      currency,
      actorId: args.systemActorId,
      occurredAt: args.occurredAt,
    });

    return { posted: true, amountMinor };
  },
});

/**
 * Not org-scoped: the monthly depreciation cron runs across every tenant, so
 * it needs a global (by_status, not by_org) index scan. Paginated — the cron
 * action loops pages until exhausted, so no fleet size silently truncates
 * the run (a flat .take(N) here would skip every asset past N with a
 * success-looking summary).
 */
export const listActiveAssetsForDepreciation = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("fixedAssets")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
  },
});
