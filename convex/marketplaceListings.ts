import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requireSuperAdmin } from "./utils/tenancy";
import { assertMarketplaceListingImagesAllowed } from "./utils/storageValidation";
import { getValidatedEnv } from "./utils/env";

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

function assertNonEmptyImages(imageIds: Id<"_storage">[]): void {
  if (imageIds.length === 0) {
    throw new ConvexError("At least one image is required to list a vehicle.");
  }
}

function assertOwnsListing(listing: Doc<"marketplaceListings">, userId: Id<"users">): void {
  if (listing.sellerUserId !== userId) {
    throw new ConvexError("Forbidden: You can only manage your own listings.");
  }
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

      assertNonEmptyImages(args.imageIds);
      await assertMarketplaceListingImagesAllowed(ctx, args.imageIds);

      if (args.price <= 0) {
        throw new ConvexError("Price must be greater than zero.");
      }
      if (args.mileage < 0) {
        throw new ConvexError("Mileage cannot be negative.");
      }

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
      // re-collect contact info. Best-effort upsert — not on the critical path.
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

      const listing = await ctx.db.get(args.listingId);
      if (!listing || listing.isDeleted) {
        throw new ConvexError("Listing not found.");
      }
      assertOwnsListing(listing, user._id);

      if (args.imageIds !== undefined) {
        assertNonEmptyImages(args.imageIds);
        await assertMarketplaceListingImagesAllowed(ctx, args.imageIds);
      }
      if (args.price !== undefined && args.price <= 0) {
        throw new ConvexError("Price must be greater than zero.");
      }
      if (args.mileage !== undefined && args.mileage < 0) {
        throw new ConvexError("Mileage cannot be negative.");
      }

      const { listingId, ...fields } = args;
      const patch: Record<string, unknown> = { updatedAt: Date.now() };
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) patch[key] = value;
      }

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

      // Only a listing that already reached LIVE needs to go back through
      // review; a still-pending or already-rejected listing simply keeps
      // collecting edits until an admin looks at it.
      if (materialChanged && listing.status === "LIVE") {
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

      const listing = await ctx.db.get(args.listingId);
      if (!listing || listing.isDeleted) {
        throw new ConvexError("Listing not found.");
      }
      assertOwnsListing(listing, user._id);

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
 * the only way a listing can leave PENDING_VERIFICATION for LIVE, or be
 * REJECTED, is through this super-admin-gated mutation.
 */
export const adminSetListingStatus = mutation({
  args: {
    listingId: v.id("marketplaceListings"),
    status: v.union(v.literal("LIVE"), v.literal("REJECTED")),
    rejectionReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const admin = await requireSuperAdmin(ctx);

      const listing = await ctx.db.get(args.listingId);
      if (!listing || listing.isDeleted) {
        throw new ConvexError("Listing not found.");
      }
      if (listing.status !== "PENDING_VERIFICATION") {
        throw new ConvexError(
          `Cannot verify a listing with status "${listing.status}". Only PENDING_VERIFICATION listings can be approved or rejected.`
        );
      }
      if (args.status === "REJECTED" && !args.rejectionReason) {
        throw new ConvexError("A rejection reason is required.");
      }

      await ctx.db.patch(args.listingId, {
        status: args.status,
        verifiedBy: admin._id,
        verifiedAt: Date.now(),
        rejectionReason: args.status === "REJECTED" ? args.rejectionReason : undefined,
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
      const listings = await ctx.db
        .query("marketplaceListings")
        .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", user._id))
        .order("desc")
        .take(200);
      return listings.filter((listing) => !listing.isDeleted);
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("marketplaceListings.getMyListings failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

/**
 * Public if LIVE and not deleted; otherwise only visible to the owning
 * seller or a super admin. Returns null (rather than throwing) when the
 * caller isn't entitled to see it, so we don't leak listing existence.
 */
export const getListingById = query({
  args: { listingId: v.id("marketplaceListings") },
  handler: async (ctx, args) => {
    try {
      const listing = await ctx.db.get(args.listingId);
      if (!listing || listing.isDeleted) return null;
      if (listing.status === "LIVE") return listing;

      const identity = await ctx.auth.getUserIdentity();
      if (!identity) return null;

      const caller = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
        .unique();
      if (!caller) return null;

      if (caller._id === listing.sellerUserId) return listing;

      const allowlist = (getValidatedEnv().SUPER_ADMIN_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      if (allowlist.includes(caller.email.toLowerCase())) return listing;

      return null;
    } catch (error) {
      console.error("marketplaceListings.getListingById failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});
