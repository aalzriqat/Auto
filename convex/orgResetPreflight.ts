import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { orgResetState } from "./utils/orgResetGeneration";

/** Bumped only if the answer's shape or meaning changes; the release script pins it. */
export const RESET_PREFLIGHT_PROTOCOL = "SCRUM-565/N9/v1";

/**
 * SCRUM-565 D-17 (N9) — how many organizations are mid financial reset, as a
 * bare count.
 *
 * Why it exists: the closed `resetOrgFinancialData` gate (PR #421) would strand
 * any org that is mid-reset when it deploys. The production release workflow
 * calls this BEFORE that deploy (`scripts/resetInProgressPreflight.mjs`) and
 * fails closed unless every page was read and the total is zero. It has to be
 * deployed ahead of #421 so the workflow has something to call.
 *
 * COUNTS ONLY. The release runs on a public repository, so the answer carries
 * no org id, name or generation — a tenant boundary, not a logging courtesy.
 * The rule is `orgResetState(...).inProgress`, never re-implemented here.
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
    scanned: v.number(),
    inProgress: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("organizations").paginate(args.paginationOpts);
    return {
      protocol: RESET_PREFLIGHT_PROTOCOL,
      scanned: page.page.length,
      inProgress: page.page.filter((org) => orgResetState(org).inProgress).length,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
