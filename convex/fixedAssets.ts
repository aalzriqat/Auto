// ⚠️ SCRUM-302 — imported FIRST, deliberately. `utils/orgLifecycle` and
// `utils/webhookLog` are leaves: neither imports anything from this
// application. Appended at the END of an import block, the binding was
// still uninitialized when a module cycle re-entered this file mid-init
// (`Cannot access '__vite_ssr_import_9__' before initialization`, thrown
// from enqueuePendingPost under full-suite ordering only). A leaf with no
// app edges is safe to initialize before anything that can participate in
// a cycle, so it goes above every local import.
import { orgEconomicLifecycleBlock } from "./utils/orgLifecycle";
import { v, ConvexError } from "convex/values";
import { internalQuery, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, internalMutation } from "./functions";
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
import { paymentMethodValidator, PaymentMethod } from "./utils/paymentMethods";
import { runWithIdempotency } from "./utils/idempotency";
import { assertMonthClaim } from "./utils/expenseAmortization";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { isFutureUtcDay, isRepresentableTimestamp, utcDay } from "./utils/ledgerCalendar";

const methodValidator = v.literal("STRAIGHT_LINE");

/**
 * SCRUM-542. The English text of every accounting-date refusal `impair` and
 * `dispose` can raise. Must equal `ServerError_<code>` (en) in
 * lib/i18n/domains/common.ts; no amounts or ids, so one string serves every asset.
 */
export const FIXED_ASSET_DATE_REFUSALS = {
  ASSET_EVENT_DATE_INVALID: "The accounting date is not a valid date.",
  ASSET_EVENT_DATE_IN_FUTURE: "The accounting date cannot be later than today.",
  ASSET_EVENT_BEFORE_CAPITALIZATION: "The accounting date cannot be earlier than the day the asset was capitalized.",
  ASSET_EVENT_BEFORE_DEPRECIATION: "The accounting date cannot be earlier than the asset's latest posted depreciation.",
  ASSET_EVENT_BEFORE_IMPAIRMENT: "The accounting date cannot be earlier than the day the asset was impaired.",
  ASSET_PURCHASE_DATE_IN_FUTURE: "The purchase date cannot be after today.",
  ASSET_PURCHASE_DATE_INVALID: "The purchase date is not a valid date.",
  ASSET_DEPRECIATION_START_DATE_INVALID: "The depreciation start date is not a valid date.",
} as const satisfies Record<string, string>;

function refuseAssetDate(code: keyof typeof FIXED_ASSET_DATE_REFUSALS): never {
  return throwAppError(AppErrorCode[code], FIXED_ASSET_DATE_REFUSALS[code]);
}

/**
 * SCRUM-542 invariant: an impairment or disposal is dated on a UTC day that has
 * begun, and never before the asset's own earlier events — capitalization, the
 * latest posted depreciation, and (for a disposal of an impaired asset) the
 * impairment. Days compare as whole UTC days, so the same day is always allowed.
 * Raised before the caller's first write.
 *
 * Out of scope here (SCRUM-560): catch-up depreciation, GL-posted prerequisites
 * and period-lock gates.
 */
async function assertAssetEventDate(
  ctx: MutationCtx,
  input: { orgId: Id<"organizations">; asset: Doc<"fixedAssets">; occurredAt: number; kind: "IMPAIR" | "DISPOSE" }
): Promise<void> {
  const { orgId, asset, occurredAt, kind } = input;
  if (!isRepresentableTimestamp(occurredAt)) refuseAssetDate("ASSET_EVENT_DATE_INVALID");
  const day = utcDay(occurredAt);
  if (isFutureUtcDay(occurredAt, Date.now())) refuseAssetDate("ASSET_EVENT_DATE_IN_FUTURE");

  const events = await ctx.db
    .query("fixedAssetEvents")
    .withIndex("by_org_asset_time", (q) => q.eq("orgId", orgId).eq("assetId", asset._id))
    .collect();
  // One pass: the latest occurredAt of each event type that bounds the date.
  const latest: Partial<Record<Doc<"fixedAssetEvents">["type"], number>> = {};
  for (const event of events) {
    if (event.type !== "CAPITALIZE" && event.type !== "DEPRECIATE" && event.type !== "IMPAIR") continue;
    const seen = latest[event.type];
    if (seen === undefined || event.occurredAt > seen) latest[event.type] = event.occurredAt;
  }

  // Precedence is the order of this table. A legacy row without a CAPITALIZE
  // event falls back to its purchase date; IMPAIR bounds only a disposal.
  const bounds: ReadonlyArray<[number | undefined, keyof typeof FIXED_ASSET_DATE_REFUSALS]> = [
    [latest.CAPITALIZE ?? asset.purchaseDate, "ASSET_EVENT_BEFORE_CAPITALIZATION"],
    [latest.DEPRECIATE, "ASSET_EVENT_BEFORE_DEPRECIATION"],
    [kind === "DISPOSE" ? latest.IMPAIR : undefined, "ASSET_EVENT_BEFORE_IMPAIRMENT"],
  ];
  for (const [boundAt, code] of bounds) {
    if (boundAt !== undefined && Number.isFinite(boundAt) && day < utcDay(boundAt)) refuseAssetDate(code);
  }
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    // Pages LIVE rows only, through the index: a post-index `.filter` made a page
    // of deleted rows look empty. `isDeleted` is unset on live rows and true once
    // soft-deleted; `lt(true)` matches unset or false. The false case is defensive:
    // no current fixed-asset writer sets it, since admin restore refuses financial
    // tables. Should such a row exist, the index orders it as its own group, apart
    // from the unset rows.
    return await ctx.db
      .query("fixedAssets")
      .withIndex("by_org_deleted", (q) => q.eq("orgId", args.orgId).lt("isDeleted", true))
      .order("desc")
      .paginate(args.paginationOpts);
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
    // SCRUM-57 / SCRUM-313 census. `hookAssetCapitalized` keys its accounting
    // event on `asset_capitalized_${assetId}`, and the asset id is minted by
    // the `ctx.db.insert` below in this same call. A lost-response retry mints
    // asset B, key B and a SECOND capitalization journal that the downstream
    // dedupe cannot see as a duplicate — it is structurally blind to it.
    //
    // Unlike `vehicles.correctAcquisitionCost`, there is no absorbing state to
    // guard on: this command creates the object it would have to check for.
    // Only an identity minted at the user-intent boundary distinguishes a
    // retry from a genuine second asset.
    idempotencyKey: v.string(),
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
    // The CAPITALIZE event is dated purchaseDate, and impair/dispose refuse any date
    // before it, so a future purchase day would strand the asset (SCRUM-542). A future
    // depreciationStartDate stays legitimate: the cron simply postpones it.
    // Every stored date must be a representable whole-ms timestamp: the outbox and the
    // depreciation cron both build `new Date(x).toISOString()` and would throw on one.
    if (!isRepresentableTimestamp(args.purchaseDate)) refuseAssetDate("ASSET_PURCHASE_DATE_INVALID");
    if (args.depreciationStartDate !== undefined && !isRepresentableTimestamp(args.depreciationStartDate)) {
      refuseAssetDate("ASSET_DEPRECIATION_START_DATE_INVALID");
    }
    if (isFutureUtcDay(args.purchaseDate, Date.now())) refuseAssetDate("ASSET_PURCHASE_DATE_IN_FUTURE");

    const currency = args.currency ?? (await getOrgCurrency(ctx, args.orgId));
    const now = Date.now();

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "fixedAssets.capitalize",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // Everything that changes what is capitalized and how it depreciates.
        // A same-key call carrying any different value is a DIFFERENT economic
        // intent and must be refused rather than silently deduped.
        fingerprint: JSON.stringify({
          name: args.name.trim(),
          purchaseDate: args.purchaseDate,
          costMinor: args.costMinor,
          currency,
          salvageValueMinor,
          usefulLifeMonths: args.usefulLifeMonths,
          method: args.method ?? "STRAIGHT_LINE",
          depreciationStartDate: args.depreciationStartDate ?? args.purchaseDate,
          paymentMethod: args.paymentMethod ?? null,
        }),
      },
      async () => await capitalizeCore(ctx, args, { user, currency, salvageValueMinor, now })
    );
  },
});

/**
 * The body of `capitalize`, extracted so the mutation above is a thin identity
 * boundary around it. The sequence is unchanged — only moved.
 */
async function capitalizeCore(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    name: string;
    purchaseDate: number;
    costMinor: number;
    usefulLifeMonths: number;
    method?: Doc<"fixedAssets">["method"];
    depreciationStartDate?: number;
    paymentMethod?: PaymentMethod;
    notes?: string;
  },
  deps: { user: Doc<"users">; currency: string; salvageValueMinor: number; now: number }
): Promise<Id<"fixedAssets">> {
  const { user, currency, salvageValueMinor, now } = deps;
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
}

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
    await assertAssetEventDate(ctx, { orgId: args.orgId, asset, occurredAt, kind: "IMPAIR" });
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
    await assertAssetEventDate(ctx, { orgId: args.orgId, asset, occurredAt, kind: "DISPOSE" });
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
 * Every reason depreciateAssetForMonth can decline to post. crons.ts classifies
 * each one (done vs abnormal) in a Record keyed by this union, so adding a
 * reason here without classifying it fails typecheck.
 */
export type DepreciationSkipReason =
  | "org_lifecycle_blocked"
  | "not_found"
  | "not_active"
  | "not_after_last_depreciated_month"
  | "not_capitalized_under_gl_phase_11"
  | "before_depreciation_start"
  | "fully_depreciated";

// The `?: undefined` members keep `result.reason` / `result.amountMinor` readable
// without narrowing, as the pre-existing callers and tests read them.
export type DepreciateAssetResult =
  | { posted: true; amountMinor: number; reason?: undefined }
  | { posted: false; reason: DepreciationSkipReason; amountMinor?: undefined };

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
  handler: async (ctx, args): Promise<DepreciateAssetResult> => {
    // ⚠️ SCRUM-302 — classified HERE, ahead of every other check, rather than
    // left to the engine's throw. This mutation is called once per asset from a
    // CROSS-ORG cron batch, and an uncaught throw inside such a batch aborts the
    // run for every other tenant too — a suspended dealership must not stop the
    // month's depreciation for everybody else. Returning the same
    // `{ posted: false, reason }` shape the rest of this handler already uses
    // makes the refusal a counted, reported outcome instead of an error.
    const lifecycle = await orgEconomicLifecycleBlock(ctx, args.orgId);
    if (lifecycle) return { posted: false, reason: "org_lifecycle_blocked" };

    const asset = await ctx.db.get(args.assetId);
    if (!asset || asset.orgId !== args.orgId || asset.isDeleted) return { posted: false, reason: "not_found" };
    if (asset.status !== "ACTIVE") return { posted: false, reason: "not_active" };
    // SCRUM-542 — the posting must be dated inside the month it claims. Enforced
    // HERE, at the mutation boundary (this is an internal mutation any caller can
    // invoke), after the lifecycle classification above and BEFORE the replay skip
    // below, so a malformed claim is never laundered into a benign skip. A valid
    // replay still reaches that skip. Thrown, not a counted skip: a caller/data
    // bug whose throw rolls back before any patch or ledger write.
    assertMonthClaim({ yearMonth: args.yearMonth, occurredAt: args.occurredAt });
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
 * action loops pages until exhausted (crons.ts runMonthlyCron drains cursors
 * until isDone), so no fleet size silently truncates the run (a flat .take(N)
 * here would skip every asset past N with a success-looking summary).
 *
 * Soft-deleted rows are dropped from each page in JS rather than by a
 * `.filter`; a page may therefore be shorter than numItems (even empty) while
 * `isDone` is still false, which the draining caller already handles.
 */
export const listActiveAssetsForDepreciation = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("fixedAssets")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
    return { ...result, page: result.page.filter((asset) => asset.isDeleted !== true) };
  },
});
