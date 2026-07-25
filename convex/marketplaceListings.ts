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

      const now = Date.now();
      const listingId = await ctx.db.insert("marketplaceListings", {
        sellerUserId: user._id,
        sellerKind: args.sellerKind,
        sellerDisplayName: args.sellerDisplayName,
        sellerPhone: args.sellerPhone,
        sellerWhatsapp: args.sellerWhatsapp,
        make: args.make,
        model: args.model,
        year: args.year,
        mileage: args.mileage,
        price: args.price,
        currency: args.currency,
        transmission: args.transmission,
        fuelType: args.fuelType,
        city: args.city,
        description: args.description,
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
          phone: args.sellerPhone,
          city: args.city,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("marketplaceIndividualSellerProfiles", {
          sellerUserId: user._id,
          sellerKind: args.sellerKind,
          phone: args.sellerPhone,
          city: args.city,
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

      if (listing.status === "SOLD" || listing.status === "REMOVED") {
        throw new ConvexError(`Cannot edit a listing with status "${listing.status}".`);
      }

      if (args.imageIds !== undefined) {
        assertImageCountWithinBounds(args.imageIds);
        await assertMarketplaceListingImagesAllowed(ctx, args.imageIds);
      }
      if (args.price !== undefined) assertValidPrice(args.price);
      if (args.mileage !== undefined) assertValidMileage(args.mileage);
      if (args.year !== undefined) assertValidYear(args.year);

      const { listingId, ...fields } = args;
      const patch: Partial<Doc<"marketplaceListings">> = { updatedAt: Date.now() };
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

      const materialChanged = MATERIAL_FIELDS.some((field) => {
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

      if (listing.status === "REJECTED") {
        // A rejected listing has no other path back to review — route any
        // edit back to PENDING_VERIFICATION so the seller can resubmit
        // whatever they fixed, rather than leaving it stuck as REJECTED.
        patch.status = "PENDING_VERIFICATION";
        patch.verifiedBy = undefined;
        patch.verifiedAt = undefined;
        patch.rejectionReason = undefined;
      } else if (materialChanged && listing.status === "LIVE") {
        // Only a listing that already reached LIVE needs to go back through
        // review for a material change; a still-pending listing simply keeps
        // collecting edits until an admin looks at it.
        patch.status = "PENDING_VERIFICATION";
        patch.verifiedBy = undefined;
        patch.verifiedAt = undefined;
        patch.rejectionReason = undefined;
      }

      await ctx.db.patch(args.listingId, patch);
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

      if (args.status === "REMOVED") {
        if (listing.status !== "LIVE") {
          throw new ConvexError(
            `Cannot remove a listing with status "${listing.status}". Only a LIVE listing can be taken down.`
          );
        }
      } else if (listing.status !== "PENDING_VERIFICATION") {
        throw new ConvexError(
          `Cannot verify a listing with status "${listing.status}". Only PENDING_VERIFICATION listings can be approved or rejected.`
        );
      }

      if (args.status === "REJECTED" && !trimmedReason) {
        throw new ConvexError("A rejection reason is required.");
      }

      await ctx.db.patch(args.listingId, {
        status: args.status,
        verifiedBy: admin._id,
        verifiedAt: Date.now(),
        rejectionReason: args.status === "REJECTED" || args.status === "REMOVED" ? trimmedReason : undefined,
        updatedAt: Date.now(),
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
      // The isDeleted filter is applied by the query itself (before take),
      // not on the resolved array afterward — otherwise a seller with 200+
      // deleted listings could have their live listings pushed out of the
      // take(200) budget entirely.
      return await ctx.db
        .query("marketplaceListings")
        .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", user._id))
        .filter((q) => q.neq(q.field("isDeleted"), true))
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
