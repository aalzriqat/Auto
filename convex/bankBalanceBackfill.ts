import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./functions";
import { onBankLineChange } from "./accounting/bankAggregateTriggers";
import { SYSTEM_KEYS } from "./utils/defaultChart";

const PAGE_SIZE = 16;

async function controlAccount(ctx: MutationCtx, orgId: Id<"organizations">) {
  const mappings = await ctx.db.query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.BANK_ACCOUNT))
    .take(51);
  if (mappings.length > 50) throw new Error("Bank control mapping is too large to backfill safely.");
  const active = mappings.filter((m) => m.active);
  if (active.length === 0) return null;
  return active.reduce((oldest, row) => row._creationTime < oldest._creationTime ? row : oldest);
}

/**
 * One paginated query per mutation. The live trigger and this backfill use the
 * same line marker, so concurrent writes and repeated pages cannot count twice.
 * A malformed historical line leaves readiness false and never manufactures a
 * physical-bank identity.
 */
export const runPage = internalMutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, { orgId }) => {
    const org = await ctx.db.get(orgId);
    if (!org) return { status: "UNAVAILABLE" as const };
    const resetGeneration = org.financialResetGeneration ?? 0;
    if ((org.financialResetCompletedGeneration ?? 0) !== resetGeneration) {
      return { status: "RESET_IN_PROGRESS" as const };
    }
    const mappingGeneration = org.bankAggregateMappingGeneration ?? 0;
    const mapped = await controlAccount(ctx, orgId);
    if (!mapped) return { status: "UNAVAILABLE" as const };

    let state = await ctx.db.query("bankBalanceAggregateStates")
      .withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
    if (state && (state.resetGeneration !== resetGeneration ||
        state.mappingGeneration !== mappingGeneration || state.controlAccountId !== mapped._id)) {
      await ctx.db.patch(state._id, {
        controlAccountId: mapped._id,
        resetGeneration,
        mappingGeneration,
        status: "BACKFILLING",
        cursor: undefined,
        grossAbsMinor: 0,
        updatedAt: Date.now(),
      });
      state = { ...state, controlAccountId: mapped._id, resetGeneration, mappingGeneration,
        status: "BACKFILLING", cursor: undefined, grossAbsMinor: 0 };
    }
    if (!state) {
      const id = await ctx.db.insert("bankBalanceAggregateStates", {
        orgId, controlAccountId: mapped._id, resetGeneration, mappingGeneration,
        status: "BACKFILLING", grossAbsMinor: 0, updatedAt: Date.now(),
      });
      state = await ctx.db.get(id) as Doc<"bankBalanceAggregateStates">;
    }
    if (state.status === "READY") return { status: "READY" as const };
    if (state.status === "BACKFILL_REQUIRED") {
      await ctx.db.patch(state._id, { status: "BACKFILLING", cursor: undefined, updatedAt: Date.now() });
      state = { ...state, status: "BACKFILLING", cursor: undefined };
    }

    const page = await ctx.db.query("journalLines")
      .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", mapped._id))
      .paginate({ cursor: state.cursor ?? null, numItems: PAGE_SIZE });
    for (const line of page.page) {
      try {
        await onBankLineChange(ctx, null, line, true);
      } catch (error) {
        console.error("Bank balance aggregate backfill refused historical line", { orgId, lineId: line._id, error });
        await ctx.db.patch(state._id, { status: "BACKFILL_REQUIRED", cursor: undefined, updatedAt: Date.now() });
        return { status: "INCONSISTENT_HISTORY" as const };
      }
    }
    await ctx.db.patch(state._id, {
      status: page.isDone ? "READY" : "BACKFILLING",
      cursor: page.isDone ? undefined : page.continueCursor,
      updatedAt: Date.now(),
    });
    return { status: page.isDone ? "READY" as const : "MORE" as const };
  },
});
