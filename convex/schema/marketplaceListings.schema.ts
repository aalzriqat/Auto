import { defineTable } from "convex/server";
import { v } from "convex/values";

export const marketplaceListingsTables = {
  // Phase 64 — WhatsApp-native dealer intake (structured, no LLM, master
  // plan A8). One row per phone number's in-progress guided listing flow —
  // a dealer texts AutoFlow's platform WhatsApp number and answers one
  // sequential prompt per message (make/model/year/mileage/price/photos),
  // then confirms via a button reply. Confirming creates a PENDING
  // `vehicleEdits` CREATE request (see `marketplaceWhatsAppIntake.ts`) —
  // reuses the existing approval-workflow pattern rather than inserting a
  // vehicle directly, so nothing goes live from an inbound message without
  // a staff review step. Deliberately NOT keyed by orgId in the index below
  // (a phone number is resolved to an org via `marketplaceDealerProfiles`
  // at flow-start, then stamped) — the lookup path is always by phone.
  marketplaceWhatsAppFlows: defineTable({
    orgId: v.id("organizations"),
    phone: v.string(),
    step: v.union(
      v.literal("AWAITING_MAKE"),
      v.literal("AWAITING_MODEL"),
      v.literal("AWAITING_YEAR"),
      v.literal("AWAITING_MILEAGE"),
      v.literal("AWAITING_PRICE"),
      v.literal("AWAITING_PHOTOS"),
      v.literal("AWAITING_CONFIRM"),
      v.literal("COMPLETED"),
      v.literal("CANCELLED")
    ),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    mileage: v.optional(v.number()),
    sellingPrice: v.optional(v.number()),
    photoStorageIds: v.array(v.id("_storage")),
    vehicleEditId: v.optional(v.id("vehicleEdits")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_org", ["orgId"]),

  // Direct-listing marketplace (additive to the dealer-to-dealer reverse
  // marketplace above): lets an individual or a non-AutoFlow-subscriber
  // dealer list a car for sale directly. Deliberately has no `orgId` — the
  // seller is just a `users` row with zero `memberships` rows, same as any
  // orgless buyer/individual in this schema. Every listing starts
  // PENDING_VERIFICATION and only a super admin can move it to LIVE/REJECTED
  // (see marketplaceListings.ts's adminSetListingStatus — the admin queue
  // UI itself is a separate follow-up ticket).
  marketplaceListings: defineTable({
    sellerUserId: v.id("users"),
    sellerKind: v.union(v.literal("INDIVIDUAL"), v.literal("UNAFFILIATED_DEALER")),
    sellerDisplayName: v.string(),
    sellerPhone: v.string(),
    sellerWhatsapp: v.optional(v.string()),
    make: v.string(),
    model: v.string(),
    year: v.number(),
    mileage: v.number(),
    price: v.number(),
    currency: v.string(),
    transmission: v.string(),
    fuelType: v.string(),
    city: v.string(),
    description: v.string(),
    condition: v.union(
      v.literal("EXCELLENT"),
      v.literal("GOOD"),
      v.literal("FAIR"),
      v.literal("POOR")
    ),
    // Enforced non-empty in mutation code (createListing/updateListing) —
    // Convex validators can't express "min length 1" declaratively.
    imageIds: v.array(v.id("_storage")),
    status: v.union(
      v.literal("PENDING_VERIFICATION"),
      v.literal("LIVE"),
      v.literal("REJECTED"),
      v.literal("SOLD"),
      v.literal("REMOVED")
    ),
    verifiedBy: v.optional(v.id("users")),
    verifiedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    // Set only on an admin takedown of an already-LIVE listing (-> REMOVED).
    // Deliberately separate from verifiedBy/verifiedAt/rejectionReason so a
    // takedown doesn't overwrite the original approval's audit trail, and
    // separate from rejectionReason so intake rejection and post-live
    // removal aren't conflated into the same field.
    removedBy: v.optional(v.id("users")),
    removedAt: v.optional(v.number()),
    removalReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("users")),
  })
    .index("by_sellerUserId", ["sellerUserId"])
    .index("by_sellerUserId_and_isDeleted", ["sellerUserId", "isDeleted"])
    .index("by_status", ["status"])
    .index("by_isDeleted_and_status", ["isDeleted", "status"]),

  // One row per orgless seller so repeat listings don't re-collect contact
  // info and a future admin queue can show "this seller was already
  // verified before" context. Minimal by design (see marketplaceListings
  // ticket) — just contact info + verification timestamp.
  marketplaceIndividualSellerProfiles: defineTable({
    sellerUserId: v.id("users"),
    sellerKind: v.union(v.literal("INDIVIDUAL"), v.literal("UNAFFILIATED_DEALER")),
    phone: v.string(),
    phoneVerifiedAt: v.optional(v.number()),
    city: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_sellerUserId", ["sellerUserId"]),

  // Ownership record for a storageId issued by
  // marketplaceListings.generateListingImageUploadUrl, written by
  // confirmListingImageUpload once the client's direct upload to that URL
  // succeeds. createListing/updateListing check this table (by storageId)
  // before accepting an id into imageIds, so an orgless caller can't claim or
  // reuse another user's already-uploaded storageId.
  marketplaceListingImageUploads: defineTable({
    storageId: v.id("_storage"),
    uploadedBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_storageId", ["storageId"]),
};
