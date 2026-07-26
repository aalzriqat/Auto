import { v, ConvexError } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireSuperAdmin, isSuperAdminUser } from "./utils/tenancy";
import { assertMarketplaceListingImagesAllowed } from "./utils/storageValidation";

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

// This repo has no existing shared currency-code allowlist (orgSettings.ts
// stores an org's currency as a free-form string) — this app's two primary
// markets per its i18n conventions are Jordan and USD-denominated deals, so
// that's the floor for this allowlist until a broader one is needed.
const ALLOWED_CURRENCIES = ["JOD", "USD"] as const;

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
  fields: UpdateListingFields
): Promise<UpdateListingFields> {
  if (fields.imageIds !== undefined) {
    assertImageCountWithinBounds(fields.imageIds);
    await assertMarketplaceListingImagesAllowed(ctx, fields.imageIds);
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

      assertImageCountWithinBounds(args.imageIds);
      await assertMarketplaceListingImagesAllowed(ctx, args.imageIds);

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

      const listing = await requireOwnedListing(ctx, args.listingId, user._id);
      assertEditableListingStatus(listing.status);

      const { listingId, ...fields } = args;
      const normalizedFields = await assertUpdateFieldsValid(ctx, fields);

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

/** A LIVE listing with the raw seller contact fields stripped out. */
function toPublicListing(
  listing: Doc<"marketplaceListings">
): Omit<Doc<"marketplaceListings">, "sellerPhone" | "sellerWhatsapp"> {
  const { sellerPhone: _sellerPhone, sellerWhatsapp: _sellerWhatsapp, ...rest } = listing;
  return rest;
}

/**
 * Public if LIVE and not deleted; otherwise only visible to the owning
 * seller or a super admin. Returns null (rather than throwing) when the
 * caller isn't entitled to see it, so we don't leak listing existence.
 *
 * Even in the public LIVE case, raw `sellerPhone`/`sellerWhatsapp` are only
 * included for the listing's owner or a super admin — every other caller
 * (including unauthenticated ones) gets `sellerDisplayName` only, so a LIVE
 * listing id can't be used to scrape a seller's real contact details.
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
      const isEntitled = !!caller && (caller._id === listing.sellerUserId || isSuperAdminUser(caller));

      if (listing.status !== "LIVE") {
        return isEntitled ? listing : null;
      }

      return isEntitled ? listing : toPublicListing(listing);
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.getListingById failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});
