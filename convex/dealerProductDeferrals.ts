/**
 * dealerProductDeferrals.ts
 *
 * GL Phase 19: the dealer's margin on a resold warranty/GAP product is
 * deferred at sale (see ruleSaleCompleted) and recognized ratably over the
 * product's term — one row per product per sale. Recognition itself is
 * driven by crons.ts's monthly fi-commission-recognition job, which mirrors
 * fixedAssets.ts's depreciation cron exactly (paginated query here +
 * recognizeDeferredCommissionForMonth, same idempotent-per-yearMonth shape).
 */
// ⚠️ SCRUM-302 — imported FIRST, deliberately. `utils/orgLifecycle` and
// `utils/webhookLog` are leaves: neither imports anything from this
// application. Appended at the END of an import block, the binding was
// still uninitialized when a module cycle re-entered this file mid-init
// (`Cannot access '__vite_ssr_import_9__' before initialization`, thrown
// from enqueuePendingPost under full-suite ordering only). A leaf with no
// app edges is safe to initialize before anything that can participate in
// a cycle, so it goes above every local import.
import { orgEconomicLifecycleBlock } from "./utils/orgLifecycle";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { fiCommissionRecognizedKey, hookFiCommissionRecognized } from "./accounting/workflowHooks";
import { prereqPosted } from "./utils/commissionSourceLedger";
import { firstOfferableMonthIndex, yearMonthIndex, yearMonthStringIndex } from "./utils/expenseAmortization";

/** Not org-scoped: the monthly cron runs across every tenant, same reasoning as listActiveAssetsForDepreciation. */
export const listActiveDeferralsForRecognition = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("dealerProductDeferrals")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
    // S230-R1: the deferral liability is created in the SALE's accounting month,
    // so recognition may not start before it. `saleDate` is null when the owning
    // sale is missing, belongs to another org, or has no usable date — the cron
    // treats null as an item-level failure, never as "no floor".
    const page = await Promise.all(
      result.page.map(async (deferral) => {
        const sale = await ctx.db.get(deferral.saleId);
        // S230-R3: `isFinite` alone admits 1e20, which is not a representable Date
        // (yearMonthIndex -> NaN); require a real calendar month.
        const usable =
          sale && sale.orgId === deferral.orgId && Number.isFinite(yearMonthIndex(sale.saleDate));
        return { ...deferral, saleDate: usable ? sale.saleDate : null };
      })
    );
    return { ...result, page };
  },
});

function refuseRecognition(deferralId: Id<"dealerProductDeferrals">, why: string): never {
  throw new Error(`F&I recognition refused for deferral ${deferralId}: ${why}`);
}

/**
 * Every reason recognizeDeferredCommissionForMonth can decline to post. crons.ts
 * classifies each one (done vs abnormal) in a Record keyed by this union, so
 * adding a reason here without classifying it fails typecheck.
 */
export type RecognitionSkipReason =
  | "org_lifecycle_blocked"
  | "not_found"
  | "not_active"
  | "not_after_last_recognized_month"
  | "fully_recognized"
  | "source_sale_not_posted"
  | "ledger_occurrence_conflict";

// The `?: undefined` members keep `result.reason` / `result.amountMinor` readable
// without narrowing, as the pre-existing callers and tests read them.
export type RecognizeDeferredCommissionResult =
  | { posted: true; amountMinor: number; reason?: undefined }
  | { posted: false; reason: RecognitionSkipReason; amountMinor?: undefined };

export const recognizeDeferredCommissionForMonth = internalMutation({
  args: {
    orgId: v.id("organizations"),
    deferralId: v.id("dealerProductDeferrals"),
    yearMonth: v.string(), // "YYYY-MM"
    occurredAt: v.number(),
    systemActorId: v.id("users"),
  },
  handler: async (ctx, args): Promise<RecognizeDeferredCommissionResult> => {
    // ⚠️ SCRUM-302 — see the identical note in `fixedAssets.depreciateAssetForMonth`.
    // Classified before anything else so a blocked organization is a counted
    // skip in a cross-org cron batch, never a throw that poisons the batch.
    const lifecycle = await orgEconomicLifecycleBlock(ctx, args.orgId);
    if (lifecycle) return { posted: false, reason: "org_lifecycle_blocked" };

    const deferral = await ctx.db.get(args.deferralId);
    if (!deferral || deferral.orgId !== args.orgId) return { posted: false, reason: "not_found" };
    if (deferral.status !== "ACTIVE") return { posted: false, reason: "not_active" };

    // ⚠️ S230-R2 — the month floor is enforced HERE, at the mutation boundary, not
    // only in the cron's offer loop: this is an internal mutation any caller can
    // invoke with any month. The deferral liability is created in the SALE's
    // accounting month, so revenue may not be released for an earlier month, and
    // the posting must be dated inside the month it claims. Thrown (not a counted
    // skip): these are caller/data bugs, and a throw rolls the whole mutation
    // back, so no patch or ledger hook runs. Deliberately NOT given
    // `lastPostedYearMonth` — replay of an already-recognized month keeps its
    // benign `not_after_last_recognized_month` return below.
    const sale = await ctx.db.get(deferral.saleId);
    if (!sale) refuseRecognition(args.deferralId, "owning sale is missing");
    if (sale.orgId !== deferral.orgId) {
      refuseRecognition(args.deferralId, "owning sale belongs to another organization");
    }
    if (!Number.isFinite(yearMonthIndex(sale.saleDate))) {
      refuseRecognition(args.deferralId, "owning sale has no valid sale date");
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(args.yearMonth)) {
      refuseRecognition(args.deferralId, "yearMonth is not YYYY-MM");
    }
    if (
      yearMonthStringIndex(args.yearMonth) <
      firstOfferableMonthIndex({ startAt: sale.saleDate, createdAt: deferral.createdAt })
    ) {
      refuseRecognition(args.deferralId, `${args.yearMonth} precedes the sale's accounting month`);
    }
    if (
      !Number.isFinite(args.occurredAt) ||
      yearMonthIndex(args.occurredAt) !== yearMonthStringIndex(args.yearMonth)
    ) {
      refuseRecognition(args.deferralId, `occurredAt is not within ${args.yearMonth}`);
    }

    // Lexicographic comparison is safe for "YYYY-MM" strings. Equality alone
    // (the old check) only blocked re-running the *same* month — it let a
    // stale/earlier month slip through as a genuine second posting (its
    // idempotency key differs from any month already posted), silently
    // over-recognizing revenue.
    if (deferral.lastRecognizedYearMonth && args.yearMonth <= deferral.lastRecognizedYearMonth) {
      return { posted: false, reason: "not_after_last_recognized_month" };
    }

    const remaining = deferral.totalMarginMinor - deferral.recognizedMinor;
    if (remaining <= 0) return { posted: false, reason: "fully_recognized" };

    // Explicit month-count schedule: the (termMonths)th month always absorbs
    // whatever remains, so the deferral finishes in exactly termMonths
    // (never termMonths+1, which Math.floor's remainder could previously
    // require) regardless of rounding. Earlier months recognize a ceil'd
    // flat share so the schedule never has to overshoot to catch up.
    const monthsRecognized = deferral.monthsRecognized ?? 0;
    // The ledger eventVersion of this recognition (1-based month ordinal).
    const occurrence = monthsRecognized + 1;
    const isFinalContractualMonth = occurrence >= deferral.termMonths;
    const flatMonthlyAmount = Math.ceil(deferral.totalMarginMinor / deferral.termMonths);
    const amountMinor = isFinalContractualMonth ? remaining : Math.min(flatMonthlyAmount, remaining);

    // ⚠️ SCRUM-537 — a counted skip, never a throw. The deferred balance this
    // releases is created by the sale-completion journal; recognizing before it
    // has POSTED would credit revenue out of a balance that is not yet in the
    // ledger. This is a normal waiting state, not an error. The cron isolates
    // each item (SCRUM-230: one item's throw never stops the cross-org run) and
    // catches up: the item stops at this month, and the first monthly run after
    // the sale posts offers every missed month in order, each dated in its own
    // month.
    if (!(await prereqPosted(ctx, args.orgId, `sale_completed_${deferral.saleId}`))) {
      return { posted: false, reason: "source_sale_not_posted" };
    }

    // ⚠️ SCRUM-537 — the subledger must never advance without creating a NEW
    // ledger occurrence. If the ledger already holds this occurrence number, or
    // anything under this month's key, the two have diverged; advancing would
    // post nothing and leave recognizedMinor ahead of the GL. Refuse, loudly.
    const monthKey = fiCommissionRecognizedKey(args.deferralId, args.yearMonth);
    const [occurrenceTaken, monthKeyPosted, monthKeyQueued] = await Promise.all([
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_event_source_version", (q) =>
          q
            .eq("orgId", args.orgId)
            .eq("eventType", "FI_COMMISSION_RECOGNIZED")
            .eq("sourceType", "dealerProductDeferrals")
            .eq("sourceId", args.deferralId.toString())
            .eq("eventVersion", occurrence)
        )
        .first(),
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", args.orgId).eq("idempotencyKey", monthKey))
        .first(),
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", args.orgId).eq("idempotencyKey", monthKey))
        .first(),
    ]);
    if (occurrenceTaken || monthKeyPosted || monthKeyQueued) {
      console.error(
        `SCRUM-537: ledger_occurrence_conflict deferral=${args.deferralId} yearMonth=${args.yearMonth} occurrence=${occurrence}`
      );
      return { posted: false, reason: "ledger_occurrence_conflict" };
    }
    const newRecognizedMinor = deferral.recognizedMinor + amountMinor;
    await ctx.db.patch(args.deferralId, {
      recognizedMinor: newRecognizedMinor,
      monthsRecognized: occurrence,
      lastRecognizedYearMonth: args.yearMonth,
      status: newRecognizedMinor >= deferral.totalMarginMinor ? "FULLY_RECOGNIZED" : "ACTIVE",
    });

    await hookFiCommissionRecognized(ctx, {
      orgId: args.orgId,
      deferralId: args.deferralId,
      yearMonth: args.yearMonth,
      occurrence,
      amountMinor,
      currency: deferral.currency,
      actorId: args.systemActorId,
      occurredAt: args.occurredAt,
    });

    return { posted: true, amountMinor };
  },
});
