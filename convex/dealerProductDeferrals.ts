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
import { internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { fiCommissionRecognizedKey, hookFiCommissionRecognized } from "./accounting/workflowHooks";
import { prereqPosted } from "./utils/commissionSourceLedger";

/** Not org-scoped: the monthly cron runs across every tenant, same reasoning as listActiveAssetsForDepreciation. */
export const listActiveDeferralsForRecognition = internalQuery({
  args: {
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("dealerProductDeferrals")
      .withIndex("by_status", (q) => q.eq("status", "ACTIVE"))
      .paginate({ cursor: args.cursor ?? null, numItems: args.numItems ?? 200 });
  },
});

export const recognizeDeferredCommissionForMonth = internalMutation({
  args: {
    orgId: v.id("organizations"),
    deferralId: v.id("dealerProductDeferrals"),
    yearMonth: v.string(), // "YYYY-MM"
    occurredAt: v.number(),
    systemActorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    // ⚠️ SCRUM-302 — see the identical note in `fixedAssets.depreciateAssetForMonth`.
    // Classified before anything else so a blocked organization is a counted
    // skip in a cross-org cron batch, never a throw that poisons the batch.
    const lifecycle = await orgEconomicLifecycleBlock(ctx, args.orgId);
    if (lifecycle) return { posted: false, reason: "org_lifecycle_blocked" };

    const deferral = await ctx.db.get(args.deferralId);
    if (!deferral || deferral.orgId !== args.orgId) return { posted: false, reason: "not_found" };
    if (deferral.status !== "ACTIVE") return { posted: false, reason: "not_active" };
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

    // ⚠️ SCRUM-537 — a counted skip, never a throw (cross-org cron loop, no
    // per-row try/catch). The deferred balance this releases is created by the
    // sale-completion journal; recognizing before it has POSTED would credit
    // revenue out of a balance that is not yet in the ledger. Recognition
    // resumes on the first monthly run after the sale posts; months skipped
    // meanwhile are not caught up (the cron passes only the current month —
    // catch-up is SCRUM-230).
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
