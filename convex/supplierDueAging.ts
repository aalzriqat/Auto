import { ConvexError, v } from "convex/values";
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
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

export const list = query({
  args: {
    orgId: v.id("organizations"),
    kind: v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY")),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
    /**
     * The caller's "now", in epoch milliseconds. A Convex query that read `Date.now()` itself would be
     * cached and not re-run when the clock passes midnight, so a screen left open would keep showing
     * yesterday's aging (https://docs.convex.dev/understanding/best-practices/). With the day as an
     * argument a new day is a new subscription. It is validated, not trusted: it must be a finite whole
     * number within a day of the server's clock.
     */
    nowMs: v.number(),
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
    if (!Number.isSafeInteger(args.nowMs) || Math.abs(args.nowMs - Date.now()) > MAX_CLOCK_SKEW_MS) {
      throw new ConvexError("nowMs must be a whole number of milliseconds within one day of the server clock.");
    }
    return await readObligationPage(ctx, {
      orgId: args.orgId,
      kind: args.kind,
      cursor: args.cursor ?? null,
      limit: args.limit ?? OBLIGATION_PAGE_DEFAULT,
      nowMs: args.nowMs,
    });
  },
});
