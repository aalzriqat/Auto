import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { FRESH_RESET_STARTS_BLOCKED, orgResetState } from "./utils/orgResetGeneration";

/** Bumped only if the answer's shape or meaning changes; the release script pins it. */
export const RESET_PREFLIGHT_PROTOCOL = "SCRUM-565/N9/v2";

/**
 * Refuses to hand back a page that Convex could not read completely.
 *
 * Convex's `PaginationResult.pageStatus` is `"SplitRecommended" | "SplitRequired"
 * | null` (node_modules/convex/dist/esm-types/server/pagination.d.ts).
 * `SplitRequired` means the page was cut short by a read limit and the rest of
 * that range is not in `page`, so counting it would under-report organizations
 * mid-reset. `SplitRecommended` means the page IS complete but was close to a
 * limit, so it is accepted. Exported so the decision is testable: convex-test
 * cannot produce a split page.
 */
export function assertPageComplete(pageStatus: "SplitRecommended" | "SplitRequired" | null | undefined): void {
  if (pageStatus === "SplitRequired") {
    throw new ConvexError(
      "The preflight page needs a split (SplitRequired): it was cut short by a read limit and would " +
        "under-count. Retry with a smaller page size."
    );
  }
}

/**
 * SCRUM-565 D-17 (N9) / D-19 — how many organizations are mid financial reset,
 * as a bare count, plus the live backend's attestation that no new reset can
 * start.
 *
 * Why it exists: the closed `resetOrgFinancialData` gate (PR #421) would strand
 * any org that is mid-reset when it deploys. The production release workflow
 * calls this BEFORE that deploy (`scripts/resetInProgressPreflight.mjs`) and
 * fails closed unless every page was read, the total is zero, and the backend
 * attests `freshStartsBlocked` — proof that the barrier is deployed, so the count
 * cannot be invalidated by an org entering "in progress" after its page was read.
 * It has to be deployed ahead of #421 so the workflow has something to call.
 *
 * COUNTS ONLY. The release runs on a public repository, so the answer carries
 * no org id, name or generation — a tenant boundary, not a logging courtesy.
 * The rule is `orgResetState(...).inProgress`, never re-implemented here.
 * `deploymentUrl` is the deployment's own cloud URL (not tenant data); the
 * script compares it with the deployment it meant to ask.
 *
 * Read-only, internal (the workflow's operator key reaches it; no client can),
 * and exactly ONE paginated read per call (Convex's runtime limit).
 *
 * KNOWN BLIND SPOT: a reset that started BEFORE SCRUM-563 shipped never stamped
 * the generation fields, so it reads as "not in progress" here. Tracked for S4.
 */
export const countOrgsWithResetInProgress = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    protocol: v.string(),
    freshStartsBlocked: v.boolean(),
    deploymentUrl: v.union(v.string(), v.null()),
    scanned: v.number(),
    inProgress: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("organizations").paginate(args.paginationOpts);
    assertPageComplete(page.pageStatus);
    return {
      protocol: RESET_PREFLIGHT_PROTOCOL,
      freshStartsBlocked: FRESH_RESET_STARTS_BLOCKED,
      deploymentUrl: process.env.CONVEX_CLOUD_URL ?? null,
      scanned: page.page.length,
      inProgress: page.page.filter((org) => orgResetState(org).inProgress).length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
