import { v } from "convex/values";
// The PRODUCTION builder: its ctx.db is wrapOwnNumberDB(ctx, aggregateTriggers), exactly what
// applyScrum987 receives. Test-only: lives outside convex/ so it is never deployed.
import { internalMutation } from "../convex/functions";
import { runScrum987 } from "../convex/scrum987CancelledDealReversal";

export const runWrapped = internalMutation({
  args: {
    actorId: v.id("users"),
    mode: v.union(v.literal("rehearse"), v.literal("apply")),
    orgId: v.string(),
    targets: v.any(),
    now: v.number(),
    expectedUtcMonth: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => await runScrum987(ctx, args),
});
