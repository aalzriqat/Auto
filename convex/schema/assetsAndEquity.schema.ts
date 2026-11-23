import { defineTable } from "convex/server";
import { v } from "convex/values";
import { paymentMethodValidator } from "../utils/paymentMethods";

export const assetsAndEquityTables = {
  fixedAssets: defineTable({
    orgId: v.id("organizations"),
    name: v.string(), // e.g., "أثاث مكتب"
    // Legacy field, kept optional through the widen-migrate-narrow transition —
    // GL Phase 11 replaces it with costMinor/currency. New rows leave it unset.
    purchaseValue: v.optional(v.number()),
    purchaseDate: v.number(), // Timestamp
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
    // ─── GL Phase 11: capitalization + depreciation lifecycle ────────────────
    costMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    salvageValueMinor: v.optional(v.number()),
    usefulLifeMonths: v.optional(v.number()),
    method: v.optional(v.literal("STRAIGHT_LINE")),
    depreciationStartDate: v.optional(v.number()),
    status: v.optional(v.union(
      v.literal("ACTIVE"),
      v.literal("IMPAIRED"),
      v.literal("DISPOSED"),
    )),
    // Derived cache, kept in sync by the lifecycle mutations below — always
    // recomputable from fixedAssetEvents, never the source of truth.
    accumulatedDepreciationMinor: v.optional(v.number()),
    lastDepreciatedYearMonth: v.optional(v.string()), // "YYYY-MM" of the last posted depreciation run
    // Contractual month count actually depreciated so far — same role as
    // dealerProductDeferrals.monthsRecognized: distinct from
    // lastDepreciatedYearMonth, which alone can't tell depreciateAssetForMonth
    // whether the *next* call is the final contractual month (the one that
    // must absorb the remainder so the schedule finishes in exactly
    // usefulLifeMonths, not usefulLifeMonths+1).
    monthsDepreciated: v.optional(v.number()),
    disposedAt: v.optional(v.number()),
    disposalProceedsMinor: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    // `list` pages live rows only through this index, with no post-index filter, using
    // `.lt("isDeleted", true)`, which matches unset or false. That is defensive: no current
    // fixed-asset writer sets false, because admin restore refuses financial tables. Should a
    // false row ever exist, the index orders it as its own group, apart from the unset rows.
    .index("by_org_deleted", ["orgId", "isDeleted"])
    .index("by_status", ["status"]),

  // Immutable, append-only log of every capitalization/depreciation/impairment/
  // disposal event posted for a fixed asset — the audit trail behind the
  // derived accumulatedDepreciationMinor cache on fixedAssets.
  fixedAssetEvents: defineTable({
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    bankAccountId: v.optional(v.id("bankAccounts")),
    type: v.union(
      v.literal("CAPITALIZE"),
      v.literal("DEPRECIATE"),
      v.literal("IMPAIR"),
      v.literal("DISPOSE"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    occurredAt: v.number(),
    accountingEventId: v.optional(v.id("accountingEvents")),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_asset", ["assetId"])
    .index("by_org_asset_time", ["orgId", "assetId", "occurredAt"])
    // One bounding event per type for the date guard: the latest of a type is a single read.
    .index("by_org_asset_type_time", ["orgId", "assetId", "type", "occurredAt"]),

  partnerEquity: defineTable({
    orgId: v.id("organizations"),
    partnerName: v.string(), // e.g., "علاء جراد"
    userId: v.optional(v.id("users")),
    // Legacy major-unit fields, frozen as of GL Phase 12 — no mutation writes
    // them anymore. Superseded by openingBalanceMinor (GL Phase 17); kept
    // only until that backfill has run and been verified in production, per
    // the widen-migrate-narrow discipline this whole track follows.
    initialCapital: v.optional(v.number()),
    currentBalance: v.optional(v.number()),
    // GL Phase 17: minor-unit backfill of currentBalance. Once set, this is
    // what derivePartnerBalanceMinor reads as the opening base instead of
    // converting currentBalance live.
    openingBalanceMinor: v.optional(v.number()),
    openingBalanceDraftId: v.optional(v.id("openingBalanceDrafts")),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"]),

  // GL Phase 12: immutable equity movements — the source of truth behind each
  // partner's balance. Append-only; corrections are new offsetting entries,
  // never edits.
  partnerEquityTransactions: defineTable({
    orgId: v.id("organizations"),
    partnerId: v.id("partnerEquity"),
    type: v.union(
      v.literal("CONTRIBUTION"),
      v.literal("DRAW"),
      v.literal("PROFIT_DISTRIBUTION"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
    occurredAt: v.number(),
    notes: v.optional(v.string()),
    accountingEventId: v.optional(v.id("accountingEvents")),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_partner_time", ["orgId", "partnerId", "occurredAt"]),

  claims: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    financingEntity: v.string(), // "جهة التمويل"
    buyerName: v.string(), // "اسم المشتري"
    // Legacy major-unit amount, frozen as of GL Phase 13 — new claims store
    // claimAmountMinor/currency instead. Narrowed in GL Phase 17.
    claimAmount: v.optional(v.number()),
    status: v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED"), v.literal("CANCELLED")),
    claimDate: v.number(),
    notes: v.optional(v.string()),
    // ─── GL Phase 13: subledger-backed claim lifecycle ────────────────────
    claimAmountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    settledAt: v.optional(v.number()),
    settledBy: v.optional(v.id("users")),
    rejectedAt: v.optional(v.number()),
    rejectedBy: v.optional(v.id("users")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_status", ["orgId", "status"]),
};
