import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

type StorageMetadata = {
  _id: Id<"_storage">;
  contentType?: string;
  size: number;
};

export const VEHICLE_IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const FINANCE_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export async function assertStoredFileAllowed(
  ctx: MutationCtx | QueryCtx,
  args: {
    storageId: Id<"_storage">;
    allowedContentTypes: readonly string[];
    maxSizeBytes: number;
    label: string;
  },
): Promise<StorageMetadata> {
  const metadata = await ctx.db.system.get("_storage", args.storageId) as StorageMetadata | null;
  if (!metadata) {
    throw new ConvexError(`${args.label} was not found in storage.`);
  }

  if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > args.maxSizeBytes) {
    throw new ConvexError(`${args.label} exceeds the allowed file size.`);
  }

  const contentType = metadata.contentType?.toLowerCase();
  if (!contentType || !args.allowedContentTypes.includes(contentType)) {
    throw new ConvexError(`${args.label} must be an allowed file type.`);
  }

  return metadata;
}

/**
 * Shared image-batch validator — checks every storage id against a caller-supplied
 * mime/size allowlist in parallel. `undefined` is treated as "nothing to check"
 * (callers that require at least one image must enforce that separately, since
 * Convex validators can't express "min length 1" declaratively).
 */
export async function assertImagesAllowed(
  ctx: MutationCtx | QueryCtx,
  imageIds: Id<"_storage">[] | undefined,
  opts: { allowedContentTypes: readonly string[]; maxSizeBytes: number; label: string },
): Promise<void> {
  if (!imageIds) return;
  await Promise.all(
    imageIds.map((storageId) =>
      assertStoredFileAllowed(ctx, {
        storageId,
        allowedContentTypes: opts.allowedContentTypes,
        maxSizeBytes: opts.maxSizeBytes,
        label: opts.label,
      })
    )
  );
}

export async function assertVehicleImagesAllowed(
  ctx: MutationCtx | QueryCtx,
  imageIds: Id<"_storage">[] | undefined,
): Promise<void> {
  await assertImagesAllowed(ctx, imageIds, {
    allowedContentTypes: VEHICLE_IMAGE_CONTENT_TYPES,
    maxSizeBytes: 5 * 1024 * 1024,
    label: "Vehicle image",
  });
}

export const MARKETPLACE_LISTING_IMAGE_CONTENT_TYPES = VEHICLE_IMAGE_CONTENT_TYPES;

export async function assertMarketplaceListingImagesAllowed(
  ctx: MutationCtx | QueryCtx,
  imageIds: Id<"_storage">[] | undefined,
): Promise<void> {
  await assertImagesAllowed(ctx, imageIds, {
    allowedContentTypes: MARKETPLACE_LISTING_IMAGE_CONTENT_TYPES,
    maxSizeBytes: 5 * 1024 * 1024,
    label: "Listing image",
  });
}
