import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { isOpeningOffset } from "./utils/openingPrepaidAdjustment";
import { resolvePrepaidScheduleSource } from "./utils/openingPrepaidBasis";
import { openingJournalLines } from "./utils/openingVoidProof";
import { PERMISSIONS } from "./utils/permissions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";

export const basisReview = query({
  args: { orgId: v.id("organizations"), scheduleId: v.id("prepaidExpenseSchedules") },
  returns: v.union(v.null(), v.object({
    currency: v.string(), currentTotalMinor: v.number(), originalTotalMinor: v.number(),
    change: v.union(v.null(), v.object({
      version: v.number(), correctedTotalMinor: v.number(), reason: v.string(),
      reversalReason: v.optional(v.string()), offsetLabel: v.string(),
    })),
    action: v.union(v.literal("REQUEST"), v.literal("APPROVE"), v.literal("REQUEST_REVERSAL"),
      v.literal("APPROVE_REVERSAL"), v.literal("NONE")),
    offsets: v.array(v.object({ id: v.id("chartOfAccounts"), label: v.string() })),
  })),
  handler: async (ctx, args) => {
    try {
      const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_COST_PRICE]);
      const schedule = await requireOwnedRow(ctx, args.orgId, "prepaidExpenseSchedules", args.scheduleId);
      if (schedule.kind !== "OPENING" || membership.impersonationGrantId) return null;
      const source = await resolvePrepaidScheduleSource(ctx, args.orgId, schedule._id);
      if (source.kind !== "OPENING") return null;
      const common = { currency: schedule.currency, currentTotalMinor: schedule.totalMinor, originalTotalMinor: source.originalTotalMinor };
      const actionable = schedule.status === "ACTIVE" && schedule.recognizedMinor === 0 &&
        (schedule.monthsRecognized ?? 0) === 0 && !schedule.lastRecognizedYearMonth;
      const change = schedule.openingBasisChange;
      if (change) {
        const offset = await requireOwnedRow(ctx, args.orgId, "chartOfAccounts", change.offsetAccountId);
        const action = !actionable || change.reversal?.approval ? "NONE" as const
          : change.reversal ? (change.reversal.requestedBy === user._id ? "NONE" as const : "APPROVE_REVERSAL" as const)
          : change.approval ? "REQUEST_REVERSAL" as const
          : change.requestedBy === user._id ? "NONE" as const : "APPROVE" as const;
        return { ...common, action, offsets: [], change: {
          version: change.version, correctedTotalMinor: change.correctedTotalMinor, reason: change.reason,
          reversalReason: change.reversal?.reason, offsetLabel: `${offset.code} · ${offset.name}`,
        } };
      }
      const draft = await ctx.db.get(source.draftId);
      const original = await ctx.db.get(source.originalJournalId);
      const lines = draft && original ? await openingJournalLines(ctx, draft, original) : null;
      if (!lines) return null;
      if (!actionable) return { ...common, action: "NONE" as const, offsets: [], change: null };
      const creditAccounts = [...new Set(lines.filter(line => line.creditMinor > 0).map(line => line.accountId))];
      const accounts = await Promise.all(creditAccounts.map(id => ctx.db.get(id)));
      const offsets = accounts.flatMap(account => account && isOpeningOffset(account, schedule)
        ? [{ id: account._id, label: `${account.code} · ${account.name}` }] : []);
      return { ...common, action: offsets.length === 0 ? "NONE" as const : "REQUEST" as const, offsets, change: null };
    } catch (error) {
      if (!(error instanceof ConvexError)) console.error("Could not read opening prepaid basis review", error);
      return null;
    }
  },
});
