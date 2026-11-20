import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function readActiveApplicationDocuments(
  ctx: QueryCtx,
  application: Pick<Doc<"financeApplications">, "_id" | "orgId">,
) {
  const rows = await ctx.db.query("applicationDocuments")
    .withIndex("by_application", (q) => q.eq("applicationId", application._id))
    .collect();
  return rows.filter((row) => row.orgId === application.orgId && row.supersededAt === undefined);
}
