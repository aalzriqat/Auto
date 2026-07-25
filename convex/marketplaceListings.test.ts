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
    await expect(
      t.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [] })
    ).rejects.toThrow();
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
    const pdfId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4"], { type: "application/pdf" })));

    await expect(
      asSeller.mutation(api.marketplaceListings.createListing, { ...baseListing, imageIds: [pdfId] })
    ).rejects.toThrow(/allowed file type/i);
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
    ).rejects.toThrow(/forbidden|own/i);
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
    ).rejects.toThrow(/forbidden|own/i);

    const listing = await t.run((ctx) => ctx.db.get(listingId));
    expect(listing?.isDeleted).toBe(false);
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
});
