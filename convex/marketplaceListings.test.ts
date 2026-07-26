import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

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
async function seedImage(t: ReturnType<typeof convexTest>, contentType = "image/jpeg") {
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["fake-image"], { type: contentType })));
  await t.run((ctx) => (ctx.db as unknown as { patch: (id: unknown, patch: unknown) => Promise<void> }).patch(storageId, { contentType }));
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
    const imageId = await seedImage(t);

    // Use a valid seeded image (and otherwise-valid args) so this can only
    // fail on the auth check, not incidentally on the empty-images check.
    await expect(
      t.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [imageId] })
    ).rejects.toThrow(/unauthenticated/i);
  });

  test("succeeds with >=1 image and starts PENDING_VERIFICATION", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_2", "seller2@test.com");
    const imageId = await seedImage(t);

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
    const pdfId = await seedImage(t, "application/pdf");

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [pdfId] })
    ).rejects.toThrow(/allowed file type/i);
  });

  test("rejects more than MAX_LISTING_IMAGES images", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_21", "seller21@test.com");
    const imageIds = await Promise.all(Array.from({ length: 21 }, () => seedImage(t)));

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds })
    ).rejects.toThrow(/at most 20 images/i);
  });

  test("rejects a non-positive price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_4", "seller4@test.com");
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

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
    const imageId = await seedImage(t);

    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      sellerWhatsapp: "   ",
      imageIds: [imageId],
    });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.sellerWhatsapp).toBeUndefined();
  });
});

describe("ownership: update / soft-delete", () => {
  test("owner can update their own listing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_5", "seller5@test.com");
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    const tooManyImageIds = await Promise.all(Array.from({ length: 21 }, () => seedImage(t)));

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, imageIds: tooManyImageIds })
    ).rejects.toThrow(/at most 20 images/i);
  });

  test("updateListing rejects a NaN price and an out-of-range year", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_29", "seller29@test.com");
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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

  test("updateListing rejects edits once a listing is SOLD", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_30", "seller30@test.com");
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "REMOVED" });

    await expect(
      asSeller.mutation(api.marketplaceListings.updateListing, { listingId, price: 1 })
    ).rejects.toThrow(/cannot edit a listing/i);
  });

  test("editing a REJECTED listing resubmits it to PENDING_VERIFICATION and clears the rejection reason", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_32", "seller32@test.com");
    const asAdmin = await seedUser(t, "admin_11", "admin@autoflow.dev");
    const imageId = await seedImage(t);
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

describe("visibility + admin verification lifecycle", () => {
  test("a PENDING listing is not publicly reachable via getListingById", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_12", "seller12@test.com");
    const imageId = await seedImage(t);
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
    expect(ownView?._id).toBe(listingId);
  });

  test("a non-admin cannot call adminSetListingStatus", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_14", "seller14@test.com");
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    expect(publicView?._id).toBe(listingId);
  });

  test("rejecting requires a reason and records it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_16", "seller16@test.com");
    const asAdmin = await seedUser(t, "admin_2", "admin@autoflow.dev");
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
    const listingId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    // Cannot remove a PENDING_VERIFICATION listing.
    await expect(
      asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "REMOVED" })
    ).rejects.toThrow(/only a live listing/i);

    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "LIVE" });
    await asAdmin.mutation(api.marketplaceListings.adminSetListingStatus, { listingId, status: "REMOVED" });

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.status).toBe("REMOVED");

    // Once REMOVED, it's no longer publicly reachable.
    expect(await t.query(api.marketplaceListings.getListingById, { listingId })).toBeNull();
  });

  test("editing a material field on a LIVE listing sends it back to PENDING_VERIFICATION", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_17", "seller17@test.com");
    const asAdmin = await seedUser(t, "admin_3", "admin@autoflow.dev");
    const imageId = await seedImage(t);
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

  test("editing only contact info on a LIVE listing does not reset it to PENDING_VERIFICATION", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_18", "seller18@test.com");
    const asAdmin = await seedUser(t, "admin_4", "admin@autoflow.dev");
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
    const imageId = await seedImage(t);
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
});

describe("getMyListings", () => {
  test("only returns the caller's own listings", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_19", "seller19@test.com");
    const asOther = await seedUser(t, "seller_20", "seller20@test.com");
    const imageId = await seedImage(t);

    const mineId = await asSeller.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });
    await asOther.mutation(api.marketplaceListings.createListing, {
      ...baseListing,
      imageIds: [imageId],
    });

    const mine = await asSeller.query(api.marketplaceListings.getMyListings, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]._id).toBe(mineId);
  });

  test("live listings survive even when 200+ more-recent deleted listings would otherwise fill the take(200) budget", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const asSeller = await seedUser(t, "seller_38", "seller38@test.com");
    const imageId = await seedImage(t);

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
