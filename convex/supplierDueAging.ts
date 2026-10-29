import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { OBLIGATION_PAGE_DEFAULT, readObligationPage } from "./utils/supplierObligationDue";

/**
 * SCRUM-869 S3a - supplier obligations with a server-derived, explained due date and Amman aging
 * (owner ruling SCRUM-869#c23883, OQ-1). One obligation family per call, one bounded page at a
 * time; `complete` is true only on the last page, so a caller can never mistake a page for the
 * whole book. Reads only and stores nothing.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    kind: v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY")),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    rows: v.array(
      v.object({
        kind: v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY")),
        id: v.string(),
        currency: v.string(),
        outstandingMinor: v.number(),
        disputedMinor: v.number(),
        dueAt: v.union(v.number(), v.null()),
        dueDate: v.union(v.string(), v.null()),
        rule: v.string(),
        explanation: v.string(),
        daysOverdue: v.union(v.number(), v.null()),
        bucket: v.string(),
      })
    ),
    totals: v.array(
      v.object({ currency: v.string(), bucket: v.string(), grossMinor: v.number(), disputedMinor: v.number() })
    ),
    complete: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    return await readObligationPage(ctx, {
      orgId: args.orgId,
      kind: args.kind,
      cursor: args.cursor ?? null,
      limit: args.limit ?? OBLIGATION_PAGE_DEFAULT,
      nowMs: Date.now(),
    });
  },
});
