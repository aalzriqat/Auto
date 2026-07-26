import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireSuperAdmin, isSuperAdminUser } from "./utils/tenancy";
import {
  assertMarketplaceListingImagesAllowed,
  MARKETPLACE_LISTING_IMAGE_CONTENT_TYPES,
} from "./utils/storageValidation";
import { rateLimiter } from "./rateLimit";

// ─── Validators ──────────────────────────────────────────────────────────────

const sellerKindValidator = v.union(v.literal("INDIVIDUAL"), v.literal("UNAFFILIATED_DEALER"));

const conditionValidator = v.union(
  v.literal("EXCELLENT"),
  v.literal("GOOD"),
  v.literal("FAIR"),
  v.literal("POOR")
);

// Fields that change what a buyer is actually being shown — editing any of
// these on a LIVE listing sends it back to PENDING_VERIFICATION for another
// admin look. Contact-info-only edits (phone/WhatsApp/display name) do not,
// since they don't change the vehicle being represented to buyers.
const MATERIAL_FIELDS = [
  "make",
  "model",
  "year",
  "mileage",
  "price",
  "currency",
  "transmission",
  "fuelType",
  "city",
  "condition",
  "description",
  "imageIds",
] as const;

// A caller could otherwise submit an arbitrarily long imageIds array, which
// fans out one storage-doc read per id and then persists forever on the
// document.
const MAX_LISTING_IMAGES = 20;

// Matches the year-bounds convention already used for other orgless-buyer
// marketplace intake flows (see marketplaceTradeIns.ts / marketplaceWhatsAppIntake.ts).
const MIN_LISTING_YEAR = 1980;

// Free-text field bounds: keep listings reachable (non-empty contact info)
// and bounded (a public-facing description can't grow into something that
// trips Convex document size limits, surfacing as a generic error instead of
// a clear validation message).
const MAX_SELLER_DISPLAY_NAME_LENGTH = 120;
const MAX_SELLER_PHONE_LENGTH = 32;
const MAX_CITY_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_MAKE_LENGTH = 60;
const MAX_MODEL_LENGTH = 60;
const MAX_TRANSMISSION_LENGTH = 40;
const MAX_FUEL_TYPE_LENGTH = 40;

// This repo has no existing shared currency-code allowlist to reuse —
// orgSettings.ts stores an org's currency as a free-form v.string() with no
// enum constraint of its own (checked convex/orgSettings.ts and
// lib/currencyFormat.ts; neither defines a canonical list). Expanded beyond
// JOD/USD to the broader set of regional currencies this platform's target
// markets realistically transact in. A shared canonical list should be
// established later so this doesn't drift from orgSettings' free-form field.
const ALLOWED_CURRENCIES = ["JOD", "USD", "SAR", "AED", "KWD", "EGP", "QAR", "BHD", "OMR"] as const;

// Same 5MB limit assertMarketplaceListingImagesAllowed enforces after upload
// (convex/utils/storageValidation.ts) — checked again here, before issuing
// the upload URL, so an oversized/disallowed file is rejected up front.
const MAX_LISTING_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

/** Trims `value`, then throws unless the result is non-empty and within `maxLength`. */
function assertRequiredText(value: string, label: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConvexError(`${label} is required.`);
  }
  if (trimmed.length > maxLength) {
    throw new ConvexError(`${label} must be at most ${maxLength} characters.`);
  }
  return trimmed;
}

/**
 * Same bound as assertRequiredText, but for optional fields (sellerWhatsapp):
 * `undefined` passes through untouched, and a value that's only whitespace
 * is treated as "not provided" rather than rejected, since this field isn't
 * required in the first place.
 */
function assertOptionalText(value: string | undefined, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ConvexError(`${label} must be at most ${maxLength} characters.`);
  }
  return trimmed || undefined;
}

function assertImageCountWithinBounds(imageIds: Id<"_storage">[]): void {
  if (imageIds.length === 0) {
    throw new ConvexError("At least one image is required to list a vehicle.");
  }
  if (imageIds.length > MAX_LISTING_IMAGES) {
    throw new ConvexError(`A listing can have at most ${MAX_LISTING_IMAGES} images.`);
  }
}

function assertValidPrice(price: number): void {
  if (!Number.isFinite(price) || price <= 0) {
    throw new ConvexError("Price must be a finite number greater than zero.");
  }
}

function assertValidMileage(mileage: number): void {
  if (!Number.isFinite(mileage) || mileage < 0) {
    throw new ConvexError("Mileage must be a finite number and cannot be negative.");
  }
}

function assertValidYear(year: number): void {
  const maxYear = new Date().getFullYear() + 1;
  if (!Number.isInteger(year) || year < MIN_LISTING_YEAR || year > maxYear) {
    throw new ConvexError(`Year must be a whole number between ${MIN_LISTING_YEAR} and ${maxYear}.`);
  }
}

/** Trims `currency`, then throws unless it's one of ALLOWED_CURRENCIES. */
function assertValidCurrency(currency: string): string {
  const trimmed = currency.trim();
  if (!(ALLOWED_CURRENCIES as readonly string[]).includes(trimmed)) {
    throw new ConvexError(`Currency must be one of: ${ALLOWED_CURRENCIES.join(", ")}.`);
  }
  return trimmed;
}

/**
 * Verifies every submitted image id was actually uploaded and confirmed by
 * this caller (via generateListingImageUploadUrl + confirmListingImageUpload)
 * before it can be attached to a listing. Without this, any authenticated
 * caller could submit an arbitrary storageId — including one uploaded and
 * confirmed by a completely different seller — into their own listing.
 */
async function assertImagesOwnedByCaller(
  ctx: MutationCtx,
  imageIds: Id<"_storage">[],
  userId: Id<"users">
): Promise<void> {
  const claims = await Promise.all(
    imageIds.map((storageId) =>
      ctx.db
        .query("marketplaceListingImageUploads")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
        .unique()
    )
  );
  if (claims.some((claim) => !claim || claim.uploadedBy !== userId)) {
    throw new ConvexError(
      "Each image must have been uploaded by you (via generateListingImageUploadUrl) before it can be used in a listing."
    );
  }
}

/**
 * Per-caller write rate limit shared by createListing/updateListing/
 * softDeleteListing/markListingSold — these are all orgless (no orgId to key
 * a tenant limit by, unlike checkTenantWriteLimit), so this is keyed by the
 * caller's own userId instead.
 */
async function enforceListingWriteRateLimit(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const status = await rateLimiter.limit(ctx, "marketplaceListingWrite", { key: userId });
  if (!status.ok) {
    throw new ConvexError("Too many requests. Please try again later.");
  }
}

/**
 * Resolves a listing the caller is entitled to manage (edit/soft-delete).
 * Not-found and not-owned collapse into the same generic error, same as
 * getListingById returning null for both cases below — so an authenticated
 * caller can't enumerate whether an arbitrary listingId exists by comparing
 * error messages.
 */
async function requireOwnedListing(
  ctx: MutationCtx,
  listingId: Id<"marketplaceListings">,
  userId: Id<"users">
): Promise<Doc<"marketplaceListings">> {
  const listing = await ctx.db.get(listingId);
  if (!listing || listing.isDeleted || listing.sellerUserId !== userId) {
    throw new ConvexError("Listing not found or you don't have permission to manage it.");
  }
  return listing;
}

// Every field `updateListing` can change, mirrored from the persisted doc
// shape so a helper working with these fields can assign straight into a
// `Partial<Doc<"marketplaceListings">>` patch without casting.
type UpdateListingFields = Partial<
  Pick<
    Doc<"marketplaceListings">,
    | "sellerDisplayName"
    | "sellerPhone"
    | "sellerWhatsapp"
    | "make"
    | "model"
    | "year"
    | "mileage"
    | "price"
    | "currency"
    | "transmission"
    | "fuelType"
    | "city"
    | "description"
    | "condition"
    | "imageIds"
  >
>;

function assertEditableListingStatus(status: Doc<"marketplaceListings">["status"]): void {
  if (status === "SOLD" || status === "REMOVED") {
    throw new ConvexError(`Cannot edit a listing with status "${status}".`);
  }
}

/** Trims/bounds-checks whichever free-text fields are present, returning a copy with those replaced by their trimmed values. */
function assertAndNormalizeTextFields(fields: UpdateListingFields): UpdateListingFields {
  const normalized: UpdateListingFields = { ...fields };
  if (fields.sellerDisplayName !== undefined) {
    normalized.sellerDisplayName = assertRequiredText(
      fields.sellerDisplayName,
      "Seller display name",
      MAX_SELLER_DISPLAY_NAME_LENGTH
    );
  }
  if (fields.sellerPhone !== undefined) {
    normalized.sellerPhone = assertRequiredText(fields.sellerPhone, "Seller phone", MAX_SELLER_PHONE_LENGTH);
  }
  if (fields.sellerWhatsapp !== undefined) {
    normalized.sellerWhatsapp = assertOptionalText(
      fields.sellerWhatsapp,
      "Seller WhatsApp",
      MAX_SELLER_PHONE_LENGTH
    );
  }
  if (fields.city !== undefined) {
    normalized.city = assertRequiredText(fields.city, "City", MAX_CITY_LENGTH);
  }
  if (fields.description !== undefined) {
    normalized.description = assertRequiredText(fields.description, "Description", MAX_DESCRIPTION_LENGTH);
  }
  if (fields.make !== undefined) {
    normalized.make = assertRequiredText(fields.make, "Make", MAX_MAKE_LENGTH);
  }
  if (fields.model !== undefined) {
    normalized.model = assertRequiredText(fields.model, "Model", MAX_MODEL_LENGTH);
  }
  if (fields.transmission !== undefined) {
    normalized.transmission = assertRequiredText(fields.transmission, "Transmission", MAX_TRANSMISSION_LENGTH);
  }
  if (fields.fuelType !== undefined) {
    normalized.fuelType = assertRequiredText(fields.fuelType, "Fuel type", MAX_FUEL_TYPE_LENGTH);
  }
  if (fields.currency !== undefined) {
    normalized.currency = assertValidCurrency(fields.currency);
  }
  return normalized;
}

async function assertUpdateFieldsValid(
  ctx: MutationCtx,
  fields: UpdateListingFields,
  userId: Id<"users">
): Promise<UpdateListingFields> {
  if (fields.imageIds !== undefined) {
    assertImageCountWithinBounds(fields.imageIds);
    await assertMarketplaceListingImagesAllowed(ctx, fields.imageIds);
    await assertImagesOwnedByCaller(ctx, fields.imageIds, userId);
  }
  if (fields.price !== undefined) assertValidPrice(fields.price);
  if (fields.mileage !== undefined) assertValidMileage(fields.mileage);
  if (fields.year !== undefined) assertValidYear(fields.year);
  return assertAndNormalizeTextFields(fields);
}

function buildListingPatchFields(fields: UpdateListingFields): Partial<Doc<"marketplaceListings">> {
  const patch: Partial<Doc<"marketplaceListings">> = {};
  if (fields.sellerDisplayName !== undefined) patch.sellerDisplayName = fields.sellerDisplayName;
  if (fields.sellerPhone !== undefined) patch.sellerPhone = fields.sellerPhone;
  if (fields.sellerWhatsapp !== undefined) patch.sellerWhatsapp = fields.sellerWhatsapp;
  if (fields.make !== undefined) patch.make = fields.make;
  if (fields.model !== undefined) patch.model = fields.model;
  if (fields.year !== undefined) patch.year = fields.year;
  if (fields.mileage !== undefined) patch.mileage = fields.mileage;
  if (fields.price !== undefined) patch.price = fields.price;
  if (fields.currency !== undefined) patch.currency = fields.currency;
  if (fields.transmission !== undefined) patch.transmission = fields.transmission;
  if (fields.fuelType !== undefined) patch.fuelType = fields.fuelType;
  if (fields.city !== undefined) patch.city = fields.city;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.condition !== undefined) patch.condition = fields.condition;
  if (fields.imageIds !== undefined) patch.imageIds = fields.imageIds;
  return patch;
}

/** True when the edit touches any MATERIAL_FIELDS value away from what's currently persisted. */
function isMaterialFieldChanged(fields: UpdateListingFields, listing: Doc<"marketplaceListings">): boolean {
  return MATERIAL_FIELDS.some((field) => {
    const nextValue = (fields as Record<string, unknown>)[field];
    if (nextValue === undefined) return false;
    if (field === "imageIds") {
      const nextImages = nextValue as Id<"_storage">[];
      const currentImages = listing.imageIds;
      return (
        nextImages.length !== currentImages.length ||
        nextImages.some((id, i) => id !== currentImages[i])
      );
    }
    return nextValue !== listing[field as keyof Doc<"marketplaceListings">];
  });
}

/**
 * Fields to merge into the patch when this edit needs to send (or re-send)
 * the listing back through admin review: a REJECTED listing has no other
 * path back to review, so ANY edit resets it to PENDING_VERIFICATION so the
 * seller can resubmit whatever they fixed. A LIVE listing only resets when
 * the edit changes a MATERIAL_FIELDS value that buyers are actually shown;
 * a still-pending listing simply keeps collecting edits until an admin
 * looks at it. Returns null when no re-review reset is needed.
 */
function resolveReviewResetFields(
  listing: Doc<"marketplaceListings">,
  materialChanged: boolean
): Partial<Doc<"marketplaceListings">> | null {
  const needsReviewReset =
    listing.status === "REJECTED" || (materialChanged && listing.status === "LIVE");
  if (!needsReviewReset) return null;
  return {
    status: "PENDING_VERIFICATION",
    verifiedBy: undefined,
    verifiedAt: undefined,
    rejectionReason: undefined,
  };
}

/**
 * Keeps the cached `marketplaceIndividualSellerProfiles` row (used by
 * createListing to skip re-collecting contact info, and by a future admin
 * queue to show "already verified before" context) in sync when an edit
 * actually changes sellerPhone and/or city. A no-op when neither field was
 * touched. If the profile row is somehow missing (it should always exist,
 * since createListing always upserts one), this skips rather than throwing —
 * a stale/missing cache row isn't worth failing the whole edit over.
 */
async function syncSellerProfileCache(
  ctx: MutationCtx,
  sellerUserId: Id<"users">,
  fields: UpdateListingFields
): Promise<void> {
  if (fields.sellerPhone === undefined && fields.city === undefined) return;

  const profile = await ctx.db
    .query("marketplaceIndividualSellerProfiles")
    .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", sellerUserId))
    .unique();
  if (!profile) return;

  const patch: Partial<Doc<"marketplaceIndividualSellerProfiles">> = { updatedAt: Date.now() };
  if (fields.sellerPhone !== undefined) patch.phone = fields.sellerPhone;
  if (fields.city !== undefined) patch.city = fields.city;
  await ctx.db.patch(profile._id, patch);
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Issues a direct-upload URL for a listing image. Unlike vehicles.ts's
 * generateUploadUrl, this is NOT tenant-gated — the feature's primary user is
 * an individual seller (or unaffiliated dealer) with no orgId and no
 * membership, so requireTenantAuth would lock them out entirely. Any
 * authenticated user may call this; the mime type and size are validated
 * before the URL is issued (mirroring vehicles.ts's validation-before-issue
 * order), and calls are rate-limited per-caller since there's no orgId to key
 * a tenant limit by.
 *
 * The returned storageId is NOT yet usable in createListing/updateListing —
 * the caller must also call confirmListingImageUpload once the upload
 * completes, which records that THEY are the one who uploaded it.
 */
export const generateListingImageUploadUrl = mutation({
  args: {
    mimeType: v.string(),
    sizeInBytes: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const user = await requireAuth(ctx);

      const status = await rateLimiter.limit(ctx, "marketplaceListingImageUpload", { key: user._id });
      if (!status.ok) {
        throw new ConvexError("Too many upload requests. Please try again later.");
      }

      if (!Number.isFinite(args.sizeInBytes) || args.sizeInBytes <= 0 || args.sizeInBytes > MAX_LISTING_IMAGE_SIZE_BYTES) {
        throw new ConvexError("Listing image exceeds the allowed file size.");
      }
      const mimeType = args.mimeType.toLowerCase();
      if (!(MARKETPLACE_LISTING_IMAGE_CONTENT_TYPES as readonly string[]).includes(mimeType)) {
        throw new ConvexError("Listing image must be an allowed file type.");
      }

      return await ctx.storage.generateUploadUrl();
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.generateListingImageUploadUrl failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Records that the calling user is the one who uploaded `storageId`, so
 * createListing/updateListing can later verify (via assertImagesOwnedByCaller)
 * that every image id in a listing was actually confirmed by its owner —
 * closing off "claim/reuse someone else's storageId". Also re-validates the
 * stored file is actually an allowed image type/size, defending against a
 * client confirming an arbitrary non-image storageId it doesn't own the
 * upload flow for.
 *
 * Idempotent for the SAME caller (confirming your own upload twice is a
 * no-op); throws if a DIFFERENT user already confirmed this storageId.
 */
export const confirmListingImageUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    try {
      const user = await requireAuth(ctx);

      await assertMarketplaceListingImagesAllowed(ctx, [args.storageId]);

      const existing = await ctx.db
        .query("marketplaceListingImageUploads")
        .withIndex("by_storageId", (q) => q.eq("storageId", args.storageId))
        .unique();

      if (existing) {
        if (existing.uploadedBy !== user._id) {
          throw new ConvexError("This image was already uploaded by another user.");
        }
        return null;
      }

      await ctx.db.insert("marketplaceListingImageUploads", {
        storageId: args.storageId,
        uploadedBy: user._id,
        createdAt: Date.now(),
      });
      return null;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.confirmListingImageUpload failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

export const createListing = mutation({
  args: {
    sellerKind: sellerKindValidator,
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
    condition: conditionValidator,
    imageIds: v.array(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    try {
      const user = await requireAuth(ctx);
      await enforceListingWriteRateLimit(ctx, user._id);

      assertImageCountWithinBounds(args.imageIds);
      await assertMarketplaceListingImagesAllowed(ctx, args.imageIds);
      await assertImagesOwnedByCaller(ctx, args.imageIds, user._id);

      assertValidPrice(args.price);
      assertValidMileage(args.mileage);
      assertValidYear(args.year);

      const sellerDisplayName = assertRequiredText(
        args.sellerDisplayName,
        "Seller display name",
        MAX_SELLER_DISPLAY_NAME_LENGTH
      );
      const sellerPhone = assertRequiredText(args.sellerPhone, "Seller phone", MAX_SELLER_PHONE_LENGTH);
      const sellerWhatsapp = assertOptionalText(args.sellerWhatsapp, "Seller WhatsApp", MAX_SELLER_PHONE_LENGTH);
      const city = assertRequiredText(args.city, "City", MAX_CITY_LENGTH);
      const description = assertRequiredText(args.description, "Description", MAX_DESCRIPTION_LENGTH);
      const make = assertRequiredText(args.make, "Make", MAX_MAKE_LENGTH);
      const model = assertRequiredText(args.model, "Model", MAX_MODEL_LENGTH);
      const transmission = assertRequiredText(args.transmission, "Transmission", MAX_TRANSMISSION_LENGTH);
      const fuelType = assertRequiredText(args.fuelType, "Fuel type", MAX_FUEL_TYPE_LENGTH);
      const currency = assertValidCurrency(args.currency);

      const now = Date.now();
      const listingId = await ctx.db.insert("marketplaceListings", {
        sellerUserId: user._id,
        sellerKind: args.sellerKind,
        sellerDisplayName,
        sellerPhone,
        sellerWhatsapp,
        make,
        model,
        year: args.year,
        mileage: args.mileage,
        price: args.price,
        currency,
        transmission,
        fuelType,
        city,
        description,
        condition: args.condition,
        imageIds: args.imageIds,
        status: "PENDING_VERIFICATION",
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      });

      // Keep a lightweight per-seller profile so a future admin queue can show
      // "already verified before" context and repeat listings don't need to
      // re-collect contact info. This upsert runs in the same mutation
      // transaction as the listing insert above, so it is NOT best-effort —
      // if it throws, the listing insert is rolled back too, same as any
      // other write in this handler.
      const existingProfile = await ctx.db
        .query("marketplaceIndividualSellerProfiles")
        .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", user._id))
        .unique();
      if (existingProfile) {
        await ctx.db.patch(existingProfile._id, {
          sellerKind: args.sellerKind,
          phone: sellerPhone,
          city,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("marketplaceIndividualSellerProfiles", {
          sellerUserId: user._id,
          sellerKind: args.sellerKind,
          phone: sellerPhone,
          city,
          createdAt: now,
          updatedAt: now,
        });
      }

      return listingId;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.createListing failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

export const updateListing = mutation({
  args: {
    listingId: v.id("marketplaceListings"),
    sellerDisplayName: v.optional(v.string()),
    sellerPhone: v.optional(v.string()),
    sellerWhatsapp: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    mileage: v.optional(v.number()),
    price: v.optional(v.number()),
    currency: v.optional(v.string()),
    transmission: v.optional(v.string()),
    fuelType: v.optional(v.string()),
    city: v.optional(v.string()),
    description: v.optional(v.string()),
    condition: v.optional(conditionValidator),
    imageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    try {
      const user = await requireAuth(ctx);
      await enforceListingWriteRateLimit(ctx, user._id);

      const listing = await requireOwnedListing(ctx, args.listingId, user._id);
      assertEditableListingStatus(listing.status);

      const { listingId, ...fields } = args;
      const normalizedFields = await assertUpdateFieldsValid(ctx, fields, user._id);

      const patch: Partial<Doc<"marketplaceListings">> = {
        updatedAt: Date.now(),
        ...buildListingPatchFields(normalizedFields),
      };

      const materialChanged = isMaterialFieldChanged(normalizedFields, listing);
      const reviewReset = resolveReviewResetFields(listing, materialChanged);
      if (reviewReset) Object.assign(patch, reviewReset);

      await ctx.db.patch(args.listingId, patch);
      await syncSellerProfileCache(ctx, user._id, normalizedFields);
      return null;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.updateListing failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

export const softDeleteListing = mutation({
  args: { listingId: v.id("marketplaceListings") },
  handler: async (ctx, args) => {
    try {
      const user = await requireAuth(ctx);
      await enforceListingWriteRateLimit(ctx, user._id);

      await requireOwnedListing(ctx, args.listingId, user._id);

      await ctx.db.patch(args.listingId, {
        isDeleted: true,
        deletedAt: Date.now(),
        deletedBy: user._id,
        updatedAt: Date.now(),
      });
      return null;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.softDeleteListing failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * The only production path that can ever move a listing to SOLD: owner-only,
 * and only reachable from LIVE (a listing has to have been publicly visible
 * for a buyer to have bought it through). Any other current status — still
 * pending, rejected, removed, or already sold — is rejected outright.
 */
export const markListingSold = mutation({
  args: { listingId: v.id("marketplaceListings") },
  handler: async (ctx, args) => {
    try {
      const user = await requireAuth(ctx);
      await enforceListingWriteRateLimit(ctx, user._id);

      const listing = await requireOwnedListing(ctx, args.listingId, user._id);
      if (listing.status !== "LIVE") {
        throw new ConvexError(
          `Cannot mark a listing with status "${listing.status}" as sold. Only a LIVE listing can be marked sold.`
        );
      }

      await ctx.db.patch(args.listingId, {
        status: "SOLD",
        updatedAt: Date.now(),
      });
      return null;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.markListingSold failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Fields to patch onto a listing whose status an admin is setting, beyond
 * the status/updatedAt fields both targets share:
 *  - LIVE (approval): stamp verifiedBy/verifiedAt.
 *  - REJECTED (intake rejection): stamp rejectionReason only. verifiedBy/
 *    verifiedAt are intentionally left untouched (a REJECTED listing was
 *    never approved).
 *  - REMOVED (post-live takedown): stamp removedBy/removedAt/removalReason
 *    instead of verifiedBy/verifiedAt/rejectionReason, so taking a LIVE
 *    listing down does NOT overwrite the original approving admin's
 *    identity/timestamp — that audit trail needs to survive a takedown.
 */
type AdminStatusTarget = "LIVE" | "REJECTED" | "REMOVED";

function buildAdminStatusPatch(
  status: AdminStatusTarget,
  adminId: Id<"users">,
  trimmedReason: string | undefined
): Partial<Doc<"marketplaceListings">> {
  if (status === "LIVE") {
    return { verifiedBy: adminId, verifiedAt: Date.now() };
  }
  if (status === "REJECTED") {
    return { rejectionReason: trimmedReason };
  }
  return { removedBy: adminId, removedAt: Date.now(), removalReason: trimmedReason };
}

/** Throws unless `targetStatus` is a legal transition from `currentStatus`. */
function assertValidAdminStatusTransition(
  currentStatus: Doc<"marketplaceListings">["status"],
  targetStatus: AdminStatusTarget
): void {
  if (targetStatus === "REMOVED") {
    if (currentStatus !== "LIVE") {
      throw new ConvexError(
        `Cannot remove a listing with status "${currentStatus}". Only a LIVE listing can be taken down.`
      );
    }
    return;
  }
  if (currentStatus !== "PENDING_VERIFICATION") {
    throw new ConvexError(
      `Cannot verify a listing with status "${currentStatus}". Only PENDING_VERIFICATION listings can be approved or rejected.`
    );
  }
}

/** REJECTED and REMOVED both require a non-empty reason; LIVE does not. */
function assertAdminStatusReasonProvided(
  status: AdminStatusTarget,
  trimmedReason: string | undefined
): void {
  if (status === "REJECTED" && !trimmedReason) {
    throw new ConvexError("A rejection reason is required.");
  }
  if (status === "REMOVED" && !trimmedReason) {
    throw new ConvexError("A removal reason is required.");
  }
}

/**
 * Groundwork for the admin verification queue (separate follow-up ticket):
 * a listing normally only leaves PENDING_VERIFICATION for LIVE or REJECTED
 * through this super-admin-gated mutation. It also lets a super admin take
 * down an already-LIVE listing (-> REMOVED) for abusive/fraudulent content,
 * since softDeleteListing is owner-only and doesn't cover admin takedown.
 */
export const adminSetListingStatus = mutation({
  args: {
    listingId: v.id("marketplaceListings"),
    status: v.union(v.literal("LIVE"), v.literal("REJECTED"), v.literal("REMOVED")),
    rejectionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const admin = await requireSuperAdmin(ctx);

      const listing = await ctx.db.get(args.listingId);
      if (!listing || listing.isDeleted) {
        throw new ConvexError("Listing not found.");
      }

      const trimmedReason = args.rejectionReason?.trim();

      assertValidAdminStatusTransition(listing.status, args.status);
      assertAdminStatusReasonProvided(args.status, trimmedReason);

      await ctx.db.patch(args.listingId, {
        status: args.status,
        updatedAt: Date.now(),
        ...buildAdminStatusPatch(args.status, admin._id, trimmedReason),
      });
      return null;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.adminSetListingStatus failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

// ─── Queries ─────────────────────────────────────────────────────────────────

export const getMyListings = query({
  args: {},
  handler: async (ctx) => {
    try {
      const user = await requireAuth(ctx);
      // isDeleted is part of the index equality prefix (not a post-hoc
      // .filter(), which isn't index-backed and would still scan every one
      // of this seller's rows — including all soft-deleted ones — before
      // the take(200) slice). This keeps the read bounded to live/pending
      // rows only, regardless of how many deleted listings the seller has.
      return await ctx.db
        .query("marketplaceListings")
        .withIndex("by_sellerUserId_and_isDeleted", (q) =>
          q.eq("sellerUserId", user._id).eq("isDeleted", false)
        )
        .order("desc")
        .take(200);
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.getMyListings failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Shape returned for a LIVE listing to any caller who isn't its owner or a
 * super admin. Deliberately an explicit allowlist (not "the raw doc minus a
 * couple of fields") — the raw doc also carries sellerUserId, verifiedBy/At,
 * removedBy/At/removalReason, rejectionReason, isDeleted/deletedAt/deletedBy,
 * and raw `imageIds` storage ids, none of which an unauthenticated scraper
 * (or any non-owner) should ever see: sellerUserId lets listings be
 * correlated back to one internal user, and raw storage ids are internal
 * references that shouldn't be exposed even though finding 1's ownership
 * tracking now stops them from being reused.
 */
type PublicListing = {
  id: Id<"marketplaceListings">;
  sellerDisplayName: string;
  sellerKind: Doc<"marketplaceListings">["sellerKind"];
  make: string;
  model: string;
  year: number;
  mileage: number;
  price: number;
  currency: string;
  transmission: string;
  fuelType: string;
  city: string;
  description: string;
  condition: Doc<"marketplaceListings">["condition"];
  imageUrls: (string | null)[];
  createdAt: number;
};

/** Builds the PublicListing DTO, resolving `imageIds` to signed URLs (mirroring vehicles.ts's imageIds -> imageUrls pattern) instead of exposing raw storage ids. */
async function toPublicListing(ctx: QueryCtx, listing: Doc<"marketplaceListings">): Promise<PublicListing> {
  const imageUrls = await Promise.all(listing.imageIds.map((id) => ctx.storage.getUrl(id)));
  return {
    id: listing._id,
    sellerDisplayName: listing.sellerDisplayName,
    sellerKind: listing.sellerKind,
    make: listing.make,
    model: listing.model,
    year: listing.year,
    mileage: listing.mileage,
    price: listing.price,
    currency: listing.currency,
    transmission: listing.transmission,
    fuelType: listing.fuelType,
    city: listing.city,
    description: listing.description,
    condition: listing.condition,
    imageUrls,
    createdAt: listing.createdAt,
  };
}

/**
 * Public if LIVE and not deleted; otherwise only visible to the owning
 * seller or a super admin. Returns null (rather than throwing) when the
 * caller isn't entitled to see it, so we don't leak listing existence.
 *
 * The owner branch of the entitlement check requires the caller's account
 * not be disabled — requireAuth enforces this for every other mutation/query
 * in this file, but this query resolves the caller manually (to also support
 * anonymous/public reads), so that guard has to be repeated here explicitly;
 * otherwise a disabled seller who still holds a valid session could keep
 * reading their own PENDING/REJECTED listing, contact info included.
 * isSuperAdminUser already enforces the same check for the admin branch.
 *
 * Even in the public LIVE case, raw `sellerPhone`/`sellerWhatsapp` (and every
 * other non-allowlisted field — see toPublicListing) are only included for
 * the listing's owner or a super admin — every other caller (including
 * unauthenticated ones) gets the public DTO only, so a LIVE listing id can't
 * be used to scrape a seller's real contact details or internal identifiers.
 */
export const getListingById = query({
  args: { listingId: v.id("marketplaceListings") },
  handler: async (ctx, args) => {
    try {
      const listing = await ctx.db.get(args.listingId);
      if (!listing || listing.isDeleted) return null;

      const identity = await ctx.auth.getUserIdentity();
      const caller = identity
        ? await ctx.db
            .query("users")
            .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
            .unique()
        : null;
      const isOwner = !!caller && !caller.disabled && caller._id === listing.sellerUserId;
      const isEntitled = isOwner || (!!caller && isSuperAdminUser(caller));

      if (listing.status !== "LIVE") {
        return isEntitled ? listing : null;
      }

      return isEntitled ? listing : await toPublicListing(ctx, listing);
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.getListingById failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Extra context joined onto each row of adminListPendingListings, resolved
 * from the seller's cached marketplaceIndividualSellerProfiles row (see
 * createListing's upsert of that table) — null when no profile row exists yet
 * (e.g. the listing was seeded directly rather than created through
 * createListing, which always upserts one).
 */
type AdminSellerProfileSummary = {
  phone: string;
  city?: string;
  phoneVerifiedAt?: number;
} | null;

/**
 * The admin verification queue backing query: every PENDING_VERIFICATION,
 * non-deleted listing, oldest submission first, so admins clear the backlog
 * fairly rather than newest-first (which is what getMyListings/getListingById
 * use for their own, different purposes). Resolves each listing's imageIds to
 * signed URLs (mirroring toPublicListing) and joins the seller's cached
 * profile row for extra context (phone/city/phoneVerifiedAt) alongside the
 * listing's own sellerPhone/sellerWhatsapp/sellerDisplayName fields — same
 * paginated-list + per-row-join shape as adminUsers.listUsers.
 */
export const adminListPendingListings = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    try {
      await requireSuperAdmin(ctx);

      const page = await ctx.db
        .query("marketplaceListings")
        .withIndex("by_isDeleted_and_status", (q) =>
          q.eq("isDeleted", false).eq("status", "PENDING_VERIFICATION")
        )
        .order("asc")
        .paginate(args.paginationOpts);

      const items = await Promise.all(
        page.page.map(async (listing) => {
          const imageUrls = (
            await Promise.all(listing.imageIds.map((id) => ctx.storage.getUrl(id)))
          ).filter((url): url is string => url !== null);

          const sellerProfileDoc = await ctx.db
            .query("marketplaceIndividualSellerProfiles")
            .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", listing.sellerUserId))
            .unique();

          const sellerProfile: AdminSellerProfileSummary = sellerProfileDoc
            ? {
                phone: sellerProfileDoc.phone,
                city: sellerProfileDoc.city,
                phoneVerifiedAt: sellerProfileDoc.phoneVerifiedAt,
              }
            : null;

          return { ...listing, imageUrls, sellerProfile };
        })
      );

      return { ...page, page: items };
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.adminListPendingListings failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});
