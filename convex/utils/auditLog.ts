import { MutationCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

/**
 * Raw insert into adminAuditLog, with no dependency on tenancy.ts. Exists
 * so both convex/adminAudit.ts (logAdminAction) and convex/utils/tenancy.ts
 * (impersonated-write logging) can write audit rows without a circular
 * import between the two.
 */
export async function writeAuditLog(
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
