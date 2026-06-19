import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";
import { writeAuditLog } from "./utils/auditLog";

/**
 * Called by every admin mutation (org/user/data) to record who did what.
 * Not exported as a Convex function — plain helper invoked from within
 * other mutations' handlers, sharing their transaction.
 */
export const logAdminAction = writeAuditLog;

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
