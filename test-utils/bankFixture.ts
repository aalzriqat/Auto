import type { TestConvex } from "convex-test";
import type { Id } from "../convex/_generated/dataModel";
import type schema from "../convex/schema";

/**
 * SCRUM-54: one eligible (active, live) bank for `orgId`, for tests whose subject is not the
 * bank but whose payment now has to name one. Created on first use, reused after.
 */
export async function seedBank(
  t: Pick<TestConvex<typeof schema>, "run">,
  orgId: Id<"organizations">,
  currency = "JOD"
): Promise<Id<"bankAccounts">> {
  return await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("bankAccounts")
      .withIndex("by_org_active_currency", (q) => q.eq("orgId", orgId).eq("isActive", true).eq("currency", currency))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .first();
    if (existing) return existing._id;
    const createdBy = (await ctx.db.query("users").first())!._id;
    const now = Date.now();
    return await ctx.db.insert("bankAccounts", {
      orgId, name: "Operating bank", currency, openingBalanceMinor: 0, openingBalanceDate: now,
      isActive: true, isReconciliationTarget: false, createdBy, createdAt: now, updatedAt: now,
    });
  });
}
