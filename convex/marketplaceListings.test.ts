import { convexTest, TestConvex as ConvexTestInstance } from "convex-test";
import { expect, test, describe, beforeEach, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Bare `ReturnType<typeof convexTest>` loses the concrete schema's table/index
// types once passed through a helper function parameter (the generic Schema
// parameter falls back to its unconstrained default), which breaks
// `.withIndex(...)` type-checking inside storeRawImage/seedImage below. This
// binds the helpers' `t` parameter to the real schema instead.
type TestConvex = ConvexTestInstance<typeof schema>;

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  enforceMarketplaceSubmissionRateLimit: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
});

async function seedUser(t: ReturnType<typeof convexTest>, clerkId: string, email: string) {
  await t.run(async (ctx) => ctx.db.insert("users", { clerkId, email }));
  return t.withIdentity({ subject: clerkId });
}

const baseListing = {
  sellerKind: "INDIVIDUAL" as const,
  sellerDisplayName: "Sami K.",
  sellerPhone: "+962791234567",
  make: "Toyota",
  model: "Corolla",
  year: 2020,
  mileage: 45000,
  price: 12000,
  currency: "JOD",
  transmission: "Automatic",
  fuelType: "Petrol",
  city: "Amman",
  description: "Well maintained, single owner.",
  condition: "GOOD" as const,
};

// convex-test's mocked storage.store doesn't persist the Blob's `type` onto
// the `_storage` system doc (unlike the real backend, which captures it from
// the upload's Content-Type) — so metadata.contentType is always undefined
// under test. Patch it in directly to simulate a real JPEG upload having gone
// through generateUploadUrl; this is test-only plumbing, not a production path.
//
// Returns a storage id with NO ownership claim recorded — usable only where a
// test specifically needs an unclaimed/invalid image (see the dedicated
// "listing image upload ownership" tests below). Everywhere else, use
// seedImage, which also records the claim so createListing/updateListing's
// ownership check passes.
async function storeRawImage(t: TestConvex, contentType = "image/jpeg") {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"], { type: contentType })));
  await t.run((ctx) => (ctx.db as unknown as { patch: (id: unknown, patch: unknown) => Promise<void> }).patch(storageId, { contentType }));
  return storageId;
}

/**
 * storeRawImage, plus records `ownerClerkId`'s user row as having confirmed
 * the upload — i.e. what confirmListingImageUpload would have written, but
 * inserted directly (bypassing the mutation itself, which has its own
 * dedicated tests below) so the many createListing/updateListing tests in
 * this file don't each need to run the full generate→upload→confirm dance
 * just to get a legitimately-owned image id.
 */
async function seedImage(t: TestConvex, ownerClerkId: string, contentType = "image/jpeg") {
  const storageId = await storeRawImage(t, contentType);
  await t.run(async (ctx) => {
    const owner = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", ownerClerkId))
      .unique();
    if (!owner) throw new Error(`seedImage: no user seeded for clerkId "${ownerClerkId}"`);
    await ctx.db.insert("marketplaceListingImageUploads", {
      storageId,
      uploadedBy: owner._id,
      createdAt: Date.now(),
    });
  });
  return storageId;
}

// getListingById's return type is a union of the full doc and a variant with
// sellerPhone/sellerWhatsapp omitted, so TS only allows accessing fields
// common to both branches directly. This narrows just enough for tests to
// assert on those two fields either way (present or absent).
function contactFields(listing: unknown): { sellerPhone?: string; sellerWhatsapp?: string } | null {
  return listing as { sellerPhone?: string; sellerWhatsapp?: string } | null;
}

describe("createListing", () => {
  test("rejects a listing with zero images", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_1", "seller1@test.com");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [] })
    ).rejects.toThrow(/at least one image/i);
  });

  test("rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const imageId = await storeRawImage(t);

    // Use a valid seeded image (and otherwise-valid args) so this can only
    // fail on the auth check, not incidentally on the empty-images check.
    await expect(
      t.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [imageId] })
    ).rejects.toThrow(/unauthenticated/i);
  });

  test("succeeds with >=1 image and starts PENDING_VERIFICATION", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_2", "seller2@test.com");
    const imageId = await seedImage(t, "seller_2");

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("PENDING_VERIFICATION");
    expect(listing?.imageIds).toEqual([imageId]);
    expect(listing?.isDeleted).toBe(false);
  });

  test("rejects a non-image storage id", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_3", "seller3@test.com");
    // Use seedImage (which patches contentType directly) so this actually
    // exercises the allowlist-rejection branch, not the "no content type"
    // branch — see the comment on seedImage for why raw ctx.storage.store
    // doesn't work for this.
    const pdfId = await storeRawImage(t, "application/pdf");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [pdfId] })
    ).rejects.toThrow(/allowed file type/i);
  });

  test("rejects more than MAX_LISTING_IMAGES images", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_21", "seller21@test.com");
    const imageIds = await Promise.all(Array.from({ length: 21 }, () => seedImage(t, "seller_21")));

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds })
    ).rejects.toThrow(/at most 20 images/i);
  });

  test("rejects a non-positive price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_4", "seller4@test.com");
    const imageId = await seedImage(t, "seller_4");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        price: 0,
        imageIds: [imageId],
      })
    ).rejects.toThrow(/price/i);
  });

  test("rejects a NaN price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_22", "seller22@test.com");
    const imageId = await seedImage(t, "seller_22");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        price: NaN,
        imageIds: [imageId],
      })
    ).rejects.toThrow(/price/i);
  });

  test("rejects an Infinity price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_23", "seller23@test.com");
    const imageId = await seedImage(t, "seller_23");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        price: Infinity,
        imageIds: [imageId],
      })
    ).rejects.toThrow(/price/i);
  });

  test("rejects a NaN mileage", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_24", "seller24@test.com");
    const imageId = await seedImage(t, "seller_24");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        mileage: NaN,
        imageIds: [imageId],
      })
    ).rejects.toThrow(/mileage/i);
  });

  test("rejects an out-of-range year", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_25", "seller25@test.com");
    const imageId = await seedImage(t, "seller_25");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        year: 1900,
        imageIds: [imageId],
      })
    ).rejects.toThrow(/year/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        year: new Date().getFullYear() + 5,
        imageIds: [imageId],
      })
    ).rejects.toThrow(/year/i);
  });

  test("rejects an empty (or whitespace-only) sellerPhone", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_39", "seller39@test.com");
    const imageId = await seedImage(t, "seller_39");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        sellerPhone: "   ",
        imageIds: [imageId],
      })
    ).rejects.toThrow(/seller phone is required/i);
  });

  test("rejects an empty (or whitespace-only) sellerDisplayName", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_40", "seller40@test.com");
    const imageId = await seedImage(t, "seller_40");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        sellerDisplayName: "",
        imageIds: [imageId],
      })
    ).rejects.toThrow(/seller display name is required/i);
  });

  test("rejects an oversized description", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_41", "seller41@test.com");
    const imageId = await seedImage(t, "seller_41");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        description: "x".repeat(5001),
        imageIds: [imageId],
      })
    ).rejects.toThrow(/description must be at most 5000 characters/i);
  });

  test("stores free-text fields trimmed, not raw", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_42", "seller42@test.com");
    const imageId = await seedImage(t, "seller_42");

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      sellerDisplayName: "  Sami K.  ",
      sellerPhone: "  +962791234567  ",
      sellerWhatsapp: "  +962791111111  ",
      city: "  Amman  ",
      description: "  Well maintained, single owner.  ",
      imageIds: [imageId],
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.sellerDisplayName).toBe("Sami K.");
    expect(listing?.sellerPhone).toBe("+962791234567");
    expect(listing?.sellerWhatsapp).toBe("+962791111111");
    expect(listing?.city).toBe("Amman");
    expect(listing?.description).toBe("Well maintained, single owner.");
  });

  test("treats a whitespace-only sellerWhatsapp as not provided rather than rejecting it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_43", "seller43@test.com");
    const imageId = await seedImage(t, "seller_43");

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      sellerWhatsapp: "   ",
      imageIds: [imageId],
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.sellerWhatsapp).toBeUndefined();
  });

  test("rejects an empty (or whitespace-only) make, model, transmission, or fuelType", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_46", "seller46@test.com");
    const imageId = await seedImage(t, "seller_46");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, make: "   ", imageIds: [imageId] })
    ).rejects.toThrow(/make is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, model: "", imageIds: [imageId] })
    ).rejects.toThrow(/model is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        transmission: "   ",
        imageIds: [imageId],
      })
    ).rejects.toThrow(/transmission is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        fuelType: "",
        imageIds: [imageId],
      })
    ).rejects.toThrow(/fuel type is required/i);
  });

  test("rejects an oversized model", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_47", "seller47@test.com");
    const imageId = await seedImage(t, "seller_47");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        model: "x".repeat(61),
        imageIds: [imageId],
      })
    ).rejects.toThrow(/model must be at most 60 characters/i);
  });

  test("rejects an invalid currency code and accepts a valid one", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_48", "seller48@test.com");
    const imageId = await seedImage(t, "seller_48");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        currency: "not-a-currency",
        imageIds: [imageId],
      })
    ).rejects.toThrow(/currency must be one of/i);

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      currency: "JOD",
      imageIds: [imageId],
    });
    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.currency).toBe("JOD");
  });

  test("accepts additional regional currency codes beyond JOD/USD (SAR, AED)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_59", "seller59@test.com");
    const imageId = await seedImage(t, "seller_59");

    const sarListingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      currency: "SAR",
      imageIds: [imageId],
    });
    const sarListing = await t.run((ctx) => ctx.db.get(sarListingId));
    expect(sarListing?.currency).toBe("SAR");

    const aedListingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      currency: "AED",
      imageIds: [imageId],
    });
    const aedListing = await t.run((ctx) => ctx.db.get(aedListingId));
    expect(aedListing?.currency).toBe("AED");
  });

  test("stores make, model, transmission, and fuelType trimmed, not raw", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_49", "seller49@test.com");
    const imageId = await seedImage(t, "seller_49");

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      make: "  Toyota  ",
      model: "  Corolla  ",
      transmission: "  Automatic  ",
      fuelType: "  Petrol  ",
      imageIds: [imageId],
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.make).toBe("Toyota");
    expect(listing?.model).toBe("Corolla");
    expect(listing?.transmission).toBe("Automatic");
    expect(listing?.fuelType).toBe("Petrol");
  });
});

describe("listing image upload ownership", () => {
  test("full flow: generateListingImageUploadUrl, confirmListingImageUpload, then createListing succeeds", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_72", "seller72@test.com");

    const uploadUrl = await asSeller.mutation(api.marketplaceListings.generateListingImageUploadUrl, {
      mimeType: "image/jpeg",
      sizeInBytes: 1024,
    });
    expect(typeof uploadUrl).toBe("string");
    expect(uploadUrl.length).toBeGreaterThan(0);

    // convex-test doesn't wire up a real HTTP endpoint for the URL returned
    // above, so simulate "the direct upload went through" the same way
    // storeRawImage does elsewhere in this file: store the blob directly,
    // then confirm it exactly as the real client would after a real upload.
    const storageId = await storeRawImage(t);
    await asSeller.mutation(api.marketplaceListings.confirmListingImageUpload, { storageId });

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [storageId],
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.imageIds).toEqual([storageId]);
  });

  test("generateListingImageUploadUrl rejects a disallowed mime type and an oversized file before issuing a URL", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_73", "seller73@test.com");

    await expect(
      asSeller.mutation(api.marketplaceListings.generateListingImageUploadUrl, {
        mimeType: "application/pdf",
        sizeInBytes: 1024,
      })
    ).rejects.toThrow(/allowed file type/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.generateListingImageUploadUrl, {
        mimeType: "image/jpeg",
        sizeInBytes: 6 * 1024 * 1024,
      })
    ).rejects.toThrow(/exceeds the allowed file size/i);
  });

  test("generateListingImageUploadUrl requires authentication (an orgless caller is not blocked by a tenant check)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    await expect(
      t.mutation(api.marketplaceListings.generateListingImageUploadUrl, {
        mimeType: "image/jpeg",
        sizeInBytes: 1024,
      })
    ).rejects.toThrow(/unauthenticated/i);
  });

  test("createListing rejects an image id nobody confirmed", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_74", "seller74@test.com");
    const unclaimedImageId = await storeRawImage(t);

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [unclaimedImageId] })
    ).rejects.toThrow(/uploaded by you/i);
  });

  test("createListing rejects an image id confirmed by a different user, but the rightful owner can still use it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asOwner = await seedUser(t, "seller_75", "seller75@test.com");
    const asOther = await seedUser(t, "seller_76", "seller76@test.com");
    const imageId = await seedImage(t, "seller_75");

    await expect(
      asOther.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [imageId] })
    ).rejects.toThrow(/uploaded by you/i);

    const listingId = await asOwner.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.imageIds).toEqual([imageId]);
  });

  test("updateListing rejects an image id nobody confirmed", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_77", "seller77@test.com");
    const imageId = await seedImage(t, "seller_77");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    const unclaimedImageId = await storeRawImage(t);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, imageIds: [unclaimedImageId] })
    ).rejects.toThrow(/uploaded by you/i);
  });

  test("updateListing rejects an image id confirmed by a different user, but the owner's own confirmed image still works", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asOwner = await seedUser(t, "seller_79", "seller79@test.com");
    const asOther = await seedUser(t, "seller_80", "seller80@test.com");
    const originalImageId = await seedImage(t, "seller_79");
    const listingId = await asOwner.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [originalImageId],
    });
    const othersImageId = await seedImage(t, "seller_80");

    await expect(
      asOwner.mutation(api.marketplaceListings.updateListing, { listingId, imageIds: [othersImageId] })
    ).rejects.toThrow(/uploaded by you/i);

    const anotherOwnImageId = await seedImage(t, "seller_79");
    await asOwner.mutation(api.marketplaceListings.updateListing, { listingId, imageIds: [anotherOwnImageId] });
    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.imageIds).toEqual([anotherOwnImageId]);
  });

  test("confirmListingImageUpload rejects a non-image storage id", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_78", "seller78@test.com");
    const pdfId = await storeRawImage(t, "application/pdf");

    await expect(
      asSeller.mutation(api.marketplaceListings.confirmListingImageUpload, { storageId: pdfId })
    ).rejects.toThrow(/allowed file type/i);
  });

  test("confirming the same storage id twice by the same user does not error", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_79", "seller79@test.com");
    const imageId = await storeRawImage(t);

    await asSeller.mutation(api.marketplaceListings.confirmListingImageUpload, { storageId: imageId });
    await expect(
      asSeller.mutation(api.marketplaceListings.confirmListingImageUpload, { storageId: imageId })
    ).resolves.toBeNull();
  });

  test("confirming a storage id already claimed by someone else throws", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asFirst = await seedUser(t, "seller_80", "seller80@test.com");
    const asSecond = await seedUser(t, "seller_81", "seller81@test.com");
    const imageId = await storeRawImage(t);

    await asFirst.mutation(api.marketplaceListings.confirmListingImageUpload, { storageId: imageId });

    await expect(
      asSecond.mutation(api.marketplaceListings.confirmListingImageUpload, { storageId: imageId })
    ).rejects.toThrow(/already uploaded by another user/i);
  });
});

describe("ownership: update / soft-delete", () => {
  test("owner can update their own listing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_5", "seller5@test.com");
    const imageId = await seedImage(t, "seller_5");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await asSeller.mutation(api.marketplaceListings.updateListing, {
      listingId,
      price: 11500,
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.price).toBe(11500);
  });

  test("a different user cannot update someone else's listing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_6", "seller6@test.com");
    const asOther = await seedUser(t, "seller_7", "seller7@test.com");
    const imageId = await seedImage(t, "seller_6");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asOther.mutation(api.marketplaceListings.updateListing, { listingId, price: 1 })
    ).rejects.toThrow(/not found or you don't have permission/i);
  });

  test("a different user cannot soft-delete someone else's listing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_8", "seller8@test.com");
    const asOther = await seedUser(t, "seller_9", "seller9@test.com");
    const imageId = await seedImage(t, "seller_8");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asOther.mutation(api.marketplaceListings.softDeleteListing, { listingId })
    ).rejects.toThrow(/not found or you don't have permission/i);

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.isDeleted).toBe(false);
  });

  test("updateListing gives the same error for a nonexistent listing as for someone else's listing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_26", "seller26@test.com");
    const asOther = await seedUser(t, "seller_27", "seller27@test.com");
    const imageId = await seedImage(t, "seller_26");
    const ownedListingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    // A valid-format id that no longer resolves to any document, so we get a
    // real "not found" (as opposed to "forbidden") comparison.
    const deletedListingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await t.run((ctx) => ctx.db.delete(deletedListingId));

    let notFoundMessage = "";
    let forbiddenMessage = "";
    try {
      await asOther.mutation(api.marketplaceListings.updateListing, { listingId: deletedListingId, price: 1 });
    } catch (error) {
      notFoundMessage = error instanceof Error ? error.message : String(error);
    }
    try {
      await asOther.mutation(api.marketplaceListings.updateListing, { listingId: ownedListingId, price: 1 });
    } catch (error) {
      forbiddenMessage = error instanceof Error ? error.message : String(error);
    }

    expect(notFoundMessage).not.toBe("");
    expect(forbiddenMessage).not.toBe("");
    expect(notFoundMessage).toBe(forbiddenMessage);
  });

  test("owner can soft-delete their own listing, and it drops out of getMyListings", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_10", "seller10@test.com");
    const imageId = await seedImage(t, "seller_10");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await asSeller.mutation(api.marketplaceListings.softDeleteListing, { listingId });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.isDeleted).toBe(true);
    expect(listing?.deletedAt).toBeTypeOf("number");

    const mine = await asSeller.query(api.marketplaceListings.getMyListings, {});
    expect(mine.find((l) => l._id === listingId)).toBeUndefined();
  });

  test("updateListing rejects clearing all images down to zero", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_11", "seller11@test.com");
    const imageId = await seedImage(t, "seller_11");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, imageIds: [] })
    ).rejects.toThrow(/at least one image/i);
  });

  test("updateListing rejects more than MAX_LISTING_IMAGES images", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_28", "seller28@test.com");
    const imageId = await seedImage(t, "seller_28");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    const tooManyImageIds = await Promise.all(Array.from({ length: 21 }, () => seedImage(t, "seller_28")));

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, imageIds: tooManyImageIds })
    ).rejects.toThrow(/at most 20 images/i);
  });

  test("updateListing rejects a NaN price and an out-of-range year", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_29", "seller29@test.com");
    const imageId = await seedImage(t, "seller_29");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, price: NaN })
    ).rejects.toThrow(/price/i);
    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, year: 1900 })
    ).rejects.toThrow(/year/i);
  });

  test("updateListing rejects an empty sellerPhone, an empty sellerDisplayName, and an oversized description", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_44", "seller44@test.com");
    const imageId = await seedImage(t, "seller_44");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, sellerPhone: "   " })
    ).rejects.toThrow(/seller phone is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, sellerDisplayName: "" })
    ).rejects.toThrow(/seller display name is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, description: "x".repeat(5001) })
    ).rejects.toThrow(/description must be at most 5000 characters/i);
  });

  test("updateListing stores free-text fields trimmed, not raw", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_45", "seller45@test.com");
    const imageId = await seedImage(t, "seller_45");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await asSeller.mutation(api.marketplaceListings.updateListing, {
      listingId,
      sellerDisplayName: "  Sami K. Jr.  ",
      city: "  Amman  ",
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.sellerDisplayName).toBe("Sami K. Jr.");
    expect(listing?.city).toBe("Amman");
  });

  test("updateListing rejects an empty make/model/transmission/fuelType, an oversized model, and an invalid currency", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_50", "seller50@test.com");
    const imageId = await seedImage(t, "seller_50");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, make: "   " })
    ).rejects.toThrow(/make is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, model: "" })
    ).rejects.toThrow(/model is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, transmission: "   " })
    ).rejects.toThrow(/transmission is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, fuelType: "" })
    ).rejects.toThrow(/fuel type is required/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, model: "x".repeat(61) })
    ).rejects.toThrow(/model must be at most 60 characters/i);

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, currency: "not-a-currency" })
    ).rejects.toThrow(/currency must be one of/i);
  });

  test("updateListing stores make/model/transmission/fuelType trimmed, not raw", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_51", "seller51@test.com");
    const imageId = await seedImage(t, "seller_51");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await asSeller.mutation(api.marketplaceListings.updateListing, {
      listingId,
      make: "  Honda  ",
      model: "  Civic  ",
      transmission: "  Manual  ",
      fuelType: "  Diesel  ",
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.make).toBe("Honda");
    expect(listing?.model).toBe("Civic");
    expect(listing?.transmission).toBe("Manual");
    expect(listing?.fuelType).toBe("Diesel");
  });

  test("updateListing keeps the cached seller profile in sync when phone/city change", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_52", "seller52@test.com");
    const imageId = await seedImage(t, "seller_52");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await asSeller.mutation(api.marketplaceListings.updateListing, {
      listingId,
      sellerPhone: "+962788888888",
      city: "Irbid",
    });

    const seller = await t.run((ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "seller_52"))
        .unique()
    );
    const profile = await t.run((ctx) =>
      ctx.db
        .query("marketplaceIndividualSellerProfiles")
        .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", seller!._id))
        .unique()
    );
    expect(profile?.phone).toBe("+962788888888");
    expect(profile?.city).toBe("Irbid");
  });

  test("updateListing rejects edits once a listing is SOLD", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_30", "seller30@test.com");
    const imageId = await seedImage(t, "seller_30");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await t.run((ctx) => ctx.db.patch(listingId, { status: "SOLD" }));

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, price: 1 })
    ).rejects.toThrow(/cannot edit a listing/i);
  });

  test("updateListing rejects edits once a listing is REMOVED", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_31", "seller31@test.com");
    const asAdmin = await seedUser(t, "admin_10", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_31");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId,
      status: "REMOVED",
      rejectionReason: "Fraudulent listing.",
    });

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, price: 1 })
    ).rejects.toThrow(/cannot edit a listing/i);
  });

  test("editing a REJECTED listing resubmits it to PENDING_VERIFICATION and clears the rejection reason", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_32", "seller32@test.com");
    const asAdmin = await seedUser(t, "admin_11", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_32");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId,
      status: "REJECTED",
      rejectionReason: "Photos too blurry.",
    });

    await asSeller.mutation(api.marketplaceListings.updateListing, {
      listingId,
      description: "New, clearer description.",
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("PENDING_VERIFICATION");
    expect(listing?.rejectionReason).toBeUndefined();
    expect(listing?.verifiedBy).toBeUndefined();
    expect(listing?.verifiedAt).toBeUndefined();
  });
});

describe("markListingSold", () => {
  test("owner can mark their own LIVE listing SOLD", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_55", "seller55@test.com");
    const asAdmin = await seedUser(t, "admin_19", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_55");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    await asSeller.mutation(api.marketplaceListings.markListingSold, { listingId });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("SOLD");
  });

  test("a non-owner cannot mark someone else's listing SOLD", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_56", "seller56@test.com");
    const asOther = await seedUser(t, "seller_57", "seller57@test.com");
    const asAdmin = await seedUser(t, "admin_20", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_56");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    await expect(
      asOther.mutation(api.marketplaceListings.markListingSold, { listingId })
    ).rejects.toThrow(/not found or you don't have permission/i);

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("LIVE");
  });

  test("marking a non-LIVE listing (PENDING_VERIFICATION or already SOLD) SOLD is rejected", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_58", "seller58@test.com");
    const asAdmin = await seedUser(t, "admin_21", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_58");

    const pendingListingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await expect(
      asSeller.mutation(api.marketplaceListings.markListingSold, { listingId: pendingListingId })
    ).rejects.toThrow(/only a live listing can be marked sold/i);

    const liveListingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId: liveListingId,
      status: "LIVE",
    });
    await asSeller.mutation(api.marketplaceListings.markListingSold, { listingId: liveListingId });

    await expect(
      asSeller.mutation(api.marketplaceListings.markListingSold, { listingId: liveListingId })
    ).rejects.toThrow(/only a live listing can be marked sold/i);
  });
});

describe("visibility + admin verification lifecycle", () => {
  test("a PENDING listing is not publicly reachable via getListingById", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_12", "seller12@test.com");
    const imageId = await seedImage(t, "seller_12");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // Anonymous caller.
    const asAnon = t;
    expect(await asAnon.query(api.marketplaceListings.getListingById, { listingId })).toBeNull();

    // A different authenticated, non-admin user.
    const asOther = await seedUser(t, "seller_13", "seller13@test.com");
    expect(await asOther.query(api.marketplaceListings.getListingById, { listingId })).toBeNull();

    // The owner can still see their own pending listing.
    const ownView = await asSeller.query(api.marketplaceListings.getListingById, { listingId });
    expect((ownView as { _id?: unknown } | null)?._id).toBe(listingId);
  });

  test("a non-admin cannot call adminSetListingStatus", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_14", "seller14@test.com");
    const imageId = await seedImage(t, "seller_14");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asSeller.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" })
    ).rejects.toThrow(/super-admin/i);
  });

  test("a LIVE listing is only reachable once a super admin approves it, then becomes publicly visible", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_15", "seller15@test.com");
    const asAdmin = await seedUser(t, "admin_1", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_15");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // Still not public before approval.
    expect(await t.query(api.marketplaceListings.getListingById, { listingId })).toBeNull();

    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("LIVE");
    expect(listing?.verifiedBy).toBeTypeOf("string");
    expect(listing?.verifiedAt).toBeTypeOf("number");

    const publicView = await t.query(api.marketplaceListings.getListingById, { listingId });
    expect((publicView as { id?: unknown } | null)?.id).toBe(listingId);
  });

  test("rejecting requires a reason and records it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_16", "seller16@test.com");
    const asAdmin = await seedUser(t, "admin_2", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_16");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "REJECTED" })
    ).rejects.toThrow(/rejection reason/i);

    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId,
      status: "REJECTED",
      rejectionReason: "Photos too blurry to verify condition.",
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("REJECTED");
    expect(listing?.rejectionReason).toBe("Photos too blurry to verify condition.");
  });

  test("rejecting with a whitespace-only reason is treated as no reason", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_33", "seller33@test.com");
    const asAdmin = await seedUser(t, "admin_12", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_33");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
        listingId,
        status: "REJECTED",
        rejectionReason: "   ",
      })
    ).rejects.toThrow(/rejection reason/i);
  });

  test("a super admin can take a LIVE listing down to REMOVED, but cannot remove a non-LIVE listing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_34", "seller34@test.com");
    const asAdmin = await seedUser(t, "admin_13", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_34");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // Cannot remove a PENDING_VERIFICATION listing.
    await expect(
      asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
        listingId,
        status: "REMOVED",
        rejectionReason: "Fraudulent listing.",
      })
    ).rejects.toThrow(/only a live listing/i);

    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId,
      status: "REMOVED",
      rejectionReason: "Fraudulent listing.",
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("REMOVED");

    // Once REMOVED, it's no longer publicly reachable.
    expect(await t.query(api.marketplaceListings.getListingById, { listingId })).toBeNull();
  });

  test("removing a LIVE listing preserves the original approval's verifiedBy/verifiedAt and records removedBy/removedAt/removalReason distinctly", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_53", "seller53@test.com");
    const asApprover = await seedUser(t, "admin_16", "admin@autoflow.dev");
    const asRemover = await seedUser(t, "admin_17", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_53");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await asApprover.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });
    const afterApproval = await t.run((ctx) => ctx.db.get(listingId));
    const originalVerifiedBy = afterApproval?.verifiedBy;
    const originalVerifiedAt = afterApproval?.verifiedAt;
    expect(originalVerifiedBy).toBeTypeOf("string");
    expect(originalVerifiedAt).toBeTypeOf("number");

    await asRemover.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId,
      status: "REMOVED",
      rejectionReason: "Reported as fraudulent by a buyer.",
    });

    const afterRemoval = await t.run((ctx) => ctx.db.get(listingId));
    expect(afterRemoval?.status).toBe("REMOVED");
    // Original approval audit trail is untouched by the takedown.
    expect(afterRemoval?.verifiedBy).toBe(originalVerifiedBy);
    expect(afterRemoval?.verifiedAt).toBe(originalVerifiedAt);
    // Takedown is recorded on its own, separate fields.
    expect(afterRemoval?.removedBy).toBeTypeOf("string");
    expect(afterRemoval?.removedAt).toBeTypeOf("number");
    expect(afterRemoval?.removalReason).toBe("Reported as fraudulent by a buyer.");
    // rejectionReason (intake-rejection field) is untouched by a removal.
    expect(afterRemoval?.rejectionReason).toBeUndefined();
  });

  test("removing a listing requires a reason, and a whitespace-only reason is treated as no reason", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_54", "seller54@test.com");
    const asAdmin = await seedUser(t, "admin_18", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_54");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    await expect(
      asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "REMOVED" })
    ).rejects.toThrow(/removal reason/i);

    await expect(
      asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
        listingId,
        status: "REMOVED",
        rejectionReason: "   ",
      })
    ).rejects.toThrow(/removal reason/i);

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("LIVE");
  });

  test("editing a material field on a LIVE listing sends it back to PENDING_VERIFICATION", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_17", "seller17@test.com");
    const asAdmin = await seedUser(t, "admin_3", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_17");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    await asSeller.mutation(api.marketplaceListings.updateListing, { listingId, price: 9999 });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("PENDING_VERIFICATION");
    expect(listing?.price).toBe(9999);
    expect(listing?.verifiedBy).toBeUndefined();
  });

  test.each(["transmission", "fuelType", "city"] as const)(
    "editing %s on a LIVE listing sends it back to PENDING_VERIFICATION",
    async (field) => {
      const t = convexTest(schema, import.meta.glob("./**/*.*s"));
      const asSeller = await seedUser(t, `seller_${field}`, `seller_${field}@test.com`);
      const asAdmin = await seedUser(t, `admin_${field}`, "admin@autoflow.dev");
      const imageId = await seedImage(t, `seller_${field}`);
      const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
        ...baseListing,
        imageIds: [imageId],
      });
      await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

      const newValues: Record<string, string> = {
        transmission: "Manual",
        fuelType: "Diesel",
        city: "Zarqa",
      };
      await asSeller.mutation(api.marketplaceListings.updateListing, {
        listingId,
        [field]: newValues[field],
      });

      const listing = await t.run((ctx) => ctx.db.get(listingId));
      expect(listing?.status).toBe("PENDING_VERIFICATION");
      expect((listing as unknown as Record<string, string>)?.[field]).toBe(newValues[field]);
      expect(listing?.verifiedBy).toBeUndefined();
    }
  );

  test("editing only contact info on a LIVE listing does not reset it to PENDING_VERIFICATION", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_18", "seller18@test.com");
    const asAdmin = await seedUser(t, "admin_4", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_18");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    await asSeller.mutation(api.marketplaceListings.updateListing, {
      listingId,
      sellerPhone: "+962799999999",
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("LIVE");
    expect(listing?.sellerPhone).toBe("+962799999999");
  });

  test("a LIVE listing hides sellerPhone/sellerWhatsapp from unauthenticated and non-owner callers, but keeps the rest", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_35", "seller35@test.com");
    const asOther = await seedUser(t, "seller_36", "seller36@test.com");
    const asAdmin = await seedUser(t, "admin_14", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_35");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      sellerWhatsapp: "+962791111111",
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    const anonView = await t.query(api.marketplaceListings.getListingById, { listingId });
    expect(anonView).not.toBeNull();
    expect(contactFields(anonView)?.sellerPhone).toBeUndefined();
    expect(contactFields(anonView)?.sellerWhatsapp).toBeUndefined();
    expect(anonView?.sellerDisplayName).toBe(baseListing.sellerDisplayName);
    expect(anonView?.make).toBe(baseListing.make);

    // The public DTO is an explicit allowlist, not "the raw doc minus two
    // fields" — assert the exact key set so a future edit can't silently
    // reintroduce sellerUserId/verifiedBy/removedBy/etc. into it.
    expect(Object.keys(anonView ?? {}).sort()).toEqual(
      [
        "id",
        "sellerDisplayName",
        "sellerKind",
        "make",
        "model",
        "year",
        "mileage",
        "price",
        "currency",
        "transmission",
        "fuelType",
        "city",
        "description",
        "condition",
        "imageUrls",
        "createdAt",
      ].sort()
    );
    // imageUrls are resolved storage URLs, not raw storage ids.
    const publicImageUrls = (anonView as { imageUrls?: (string | null)[] } | null)?.imageUrls;
    expect(publicImageUrls).toHaveLength(1);
    expect(publicImageUrls?.[0]).not.toBe(imageId);
    expect(typeof publicImageUrls?.[0]).toBe("string");

    const otherView = await asOther.query(api.marketplaceListings.getListingById, { listingId });
    expect(contactFields(otherView)?.sellerPhone).toBeUndefined();
    expect(contactFields(otherView)?.sellerWhatsapp).toBeUndefined();

    // The owner still sees their own full contact info.
    const ownerView = await asSeller.query(api.marketplaceListings.getListingById, { listingId });
    expect(contactFields(ownerView)?.sellerPhone).toBe(baseListing.sellerPhone);
    expect(contactFields(ownerView)?.sellerWhatsapp).toBe("+962791111111");

    // A super admin still sees full contact info too.
    const adminView = await asAdmin.query(api.marketplaceListings.getListingById, { listingId });
    expect(contactFields(adminView)?.sellerPhone).toBe(baseListing.sellerPhone);
    expect(contactFields(adminView)?.sellerWhatsapp).toBe("+962791111111");
  });

  test("a disabled super admin is treated as a regular caller (isSuperAdminUser enforces the disabled check)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_37", "seller37@test.com");
    const asAdmin = await seedUser(t, "admin_15", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_37");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });

    await t.run(async (ctx) => {
      const admin = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "admin_15"))
        .unique();
      if (admin) await ctx.db.patch(admin._id, { disabled: true });
    });

    const disabledAdminView = await asAdmin.query(api.marketplaceListings.getListingById, { listingId });
    expect(contactFields(disabledAdminView)?.sellerPhone).toBeUndefined();
  });

  test("a disabled seller cannot read their own PENDING listing via getListingById (owner-entitlement requires !disabled)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_71", "seller71@test.com");
    const imageId = await seedImage(t, "seller_71");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // Still PENDING_VERIFICATION — only the owner (or a super admin) should
    // ever be able to see it, and only while their account isn't disabled.
    await t.run(async (ctx) => {
      const seller = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "seller_71"))
        .unique();
      if (seller) await ctx.db.patch(seller._id, { disabled: true });
    });

    const view = await asSeller.query(api.marketplaceListings.getListingById, { listingId });
    expect(view).toBeNull();
  });
});

describe("getMyListings", () => {
  test("only returns the caller's own listings", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_19", "seller19@test.com");
    const asOther = await seedUser(t, "seller_20", "seller20@test.com");
    const imageId = await seedImage(t, "seller_19");
    const otherImageId = await seedImage(t, "seller_20");

    const mineId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asOther.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [otherImageId],
    });

    const mine = await asSeller.query(api.marketplaceListings.getMyListings, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]._id).toBe(mineId);
  });

  test("live listings survive even when 200+ more-recent deleted listings would otherwise fill the take(200) budget", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_38", "seller38@test.com");
    const imageId = await seedImage(t, "seller_38");

    // Create the live/pending listings FIRST (older _creationTime).
    const liveIds = [];
    for (let i = 0; i < 3; i++) {
      liveIds.push(
        await asSeller.mutation(api.marketplaceListings.createListing, {
          ...baseListing,
          imageIds: [imageId],
        })
      );
    }

    // Then seed exactly 200 deleted listings directly (newer _creationTime,
    // bypassing the mutation for speed). Pre-fix, `.take(200)` grabs the 200
    // most-recent docs before filtering isDeleted, so with 200 more-recent
    // deleted rows the 3 live ones above would be pushed out entirely.
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "seller_38"))
        .unique();
      if (!user) throw new Error("seed user missing");
      const now = Date.now();
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("marketplaceListings", {
          sellerUserId: user._id,
          sellerKind: "INDIVIDUAL",
          sellerDisplayName: baseListing.sellerDisplayName,
          sellerPhone: baseListing.sellerPhone,
          make: baseListing.make,
          model: baseListing.model,
          year: baseListing.year,
          mileage: baseListing.mileage,
          price: baseListing.price,
          currency: baseListing.currency,
          transmission: baseListing.transmission,
          fuelType: baseListing.fuelType,
          city: baseListing.city,
          description: baseListing.description,
          condition: baseListing.condition,
          imageIds: [imageId],
          status: "REMOVED",
          createdAt: now,
          updatedAt: now,
          isDeleted: true,
          deletedAt: now,
          deletedBy: user._id,
        });
      }
    });

    const mine = await asSeller.query(api.marketplaceListings.getMyListings, {});
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((l) => l._id))).toEqual(new Set(liveIds));
  });
});

describe("adminListPendingListings", () => {
  test("rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_82", "seller82@test.com");
    const imageId = await seedImage(t, "seller_82");
    await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    await expect(
      asSeller.query(api.marketplaceListings.adminListPendingListings, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow(/super-admin/i);
  });

  test("only returns non-deleted PENDING_VERIFICATION listings", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_83", "seller83@test.com");
    const asAdmin = await seedUser(t, "admin_22", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_83");

    // Still pending — should be returned.
    const pendingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // LIVE — should NOT be returned.
    const liveId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId: liveId, status: "LIVE" });

    // REJECTED — should NOT be returned.
    const rejectedId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId: rejectedId,
      status: "REJECTED",
      rejectionReason: "Photos too blurry.",
    });

    // SOLD — should NOT be returned.
    const soldId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId: soldId, status: "LIVE" });
    await asSeller.mutation(api.marketplaceListings.markListingSold, { listingId: soldId });

    // REMOVED — should NOT be returned.
    const removedId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId: removedId, status: "LIVE" });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, {
      listingId: removedId,
      status: "REMOVED",
      rejectionReason: "Fraudulent listing.",
    });

    // Soft-deleted while still PENDING_VERIFICATION — should NOT be returned.
    const softDeletedPendingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asSeller.mutation(api.marketplaceListings.softDeleteListing, { listingId: softDeletedPendingId });

    const page = await asAdmin.query(api.marketplaceListings.adminListPendingListings, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    const ids = page.page.map((row) => row._id);
    expect(ids).toContain(pendingId);
    expect(ids).not.toContain(liveId);
    expect(ids).not.toContain(rejectedId);
    expect(ids).not.toContain(soldId);
    expect(ids).not.toContain(removedId);
    expect(ids).not.toContain(softDeletedPendingId);
  });

  test("resolves image URLs and joins the seller's profile row", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_84", "seller84@test.com");
    const asAdmin = await seedUser(t, "admin_23", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_84");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    const page = await asAdmin.query(api.marketplaceListings.adminListPendingListings, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    const row = page.page.find((r) => r._id === listingId);
    expect(row).toBeDefined();
    expect(row?.imageUrls).toHaveLength(1);
    expect(typeof row?.imageUrls[0]).toBe("string");
    expect(row?.imageUrls[0]).not.toBe(imageId);
    expect(row?.sellerProfile).not.toBeNull();
    expect(row?.sellerProfile?.phone).toBe(baseListing.sellerPhone);
    expect(row?.sellerProfile?.city).toBe(baseListing.city);
  });

  test("returns null sellerProfile when no profile row exists for the seller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_85", "seller85@test.com");
    const asAdmin = await seedUser(t, "admin_24", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_85");
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // Remove the profile row createListing upserted, to simulate a listing
    // with no cached profile (e.g. seeded directly rather than through
    // createListing).
    await t.run(async (ctx) => {
      const seller = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", "seller_85"))
        .unique();
      const profile = await ctx.db
        .query("marketplaceIndividualSellerProfiles")
        .withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", seller!._id))
        .unique();
      if (profile) await ctx.db.delete(profile._id);
    });

    const page = await asAdmin.query(api.marketplaceListings.adminListPendingListings, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    const row = page.page.find((r) => r._id === listingId);
    expect(row).toBeDefined();
    expect(row?.sellerProfile).toBeNull();
  });

  test("orders results oldest submission first", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_86", "seller86@test.com");
    const asAdmin = await seedUser(t, "admin_25", "admin@autoflow.dev");
    const imageId = await seedImage(t, "seller_86");

    const firstId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    const secondId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    const thirdId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    const page = await asAdmin.query(api.marketplaceListings.adminListPendingListings, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    const ids = page.page.map((row) => row._id);
    const firstIndex = ids.indexOf(firstId);
    const secondIndex = ids.indexOf(secondId);
    const thirdIndex = ids.indexOf(thirdId);
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(secondIndex);
  });
});
