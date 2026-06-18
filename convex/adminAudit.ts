import { paginationOptsValidator } from "convex/server";
import { MutationCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireSuperAdmin } from "./utils/tenancy";

/**
 * Called by every admin mutation (org/user/data) to record who did what.
 * Not exported as a Convex function — plain helper invoked from within
 * other mutations' handlers, sharing their transaction.
 */
export async function logAdminAction(
  ctx: MutationCtx,
  actor: Doc<"users">,
  params: {
    action: string;
    targetTable?: string;
    targetId?: string;
    orgId?: Id<"organizations">;
    before?: unknown;
    after?: unknown;
  }
) {
  await ctx.db.insert("adminAuditLog", {
    actorUserId: actor._id,
    actorEmail: actor.email,
    action: params.action,
    targetTable: params.targetTable,
    targetId: params.targetId,
    orgId: params.orgId,
    before: params.before,
    after: params.after,
    createdAt: Date.now(),
  });
}

export const listAuditLog = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await ctx.db
      .query("adminAuditLog")
      .withIndex("by_createdAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
