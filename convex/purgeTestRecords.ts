/**
 * SCRUM-1023 Phase 1: the READ-ONLY dry run of the one-time test-record purge.
 *
 * `previewPurge` writes nothing. It returns the exact manifest (ids per table,
 * per-account net, owner-approved exceptions itemized, snapshot adjustments,
 * surviving references, closed-period hits, totals) the owner approves BEFORE
 * any erase exists. It is an internalQuery: not callable from a client, and it
 * must be run by the operator against the named organization only.
 *
 * There is deliberately NO mutation in this file (Phase 2 is a separate,
 * separately reviewed change that can only act on a manifest this query
 * returned `ok: true` for).
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { buildPurgeManifest, type PurgeManifest } from "./utils/purgeManifest";

const approvedExceptionValidator = v.object({
  rootId: v.string(),
  accountDeltas: v.array(
    v.object({
      accountId: v.string(),
      currency: v.string(),
      bankAccountId: v.optional(v.string()),
      netMinor: v.number(),
    }),
  ),
});

export type PreviewPurgeResult =
  | { success: true; manifest: PurgeManifest }
  | { success: false; error: string };

export const previewPurge = internalQuery({
  args: {
    orgId: v.id("organizations"),
    saleIds: v.array(v.string()),
    applicationIds: v.array(v.string()),
    expenseIds: v.array(v.string()),
    transferEventIds: v.array(v.string()),
    approvedExceptions: v.array(approvedExceptionValidator),
  },
  // The manifest is a large nested report typed by `PurgeManifest`; v.any() here is
  // deliberate, the success/failure envelope is what the validator pins.
  returns: v.union(
    v.object({ success: v.literal(true), manifest: v.any() }),
    v.object({ success: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args): Promise<PreviewPurgeResult> => {
    try {
      const manifest = await buildPurgeManifest(
        ctx,
        args.orgId,
        {
          saleIds: args.saleIds,
          applicationIds: args.applicationIds,
          expenseIds: args.expenseIds,
          transferEventIds: args.transferEventIds,
        },
        args.approvedExceptions,
      );
      return { success: true, manifest };
    } catch (error) {
      console.error(error);
      return { success: false, error: "An unexpected error occurred. Please try again later." };
    }
  },
});
