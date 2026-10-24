import { createOpeningSettlementReader } from "./utils/openingSettlementBasis";
import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { openingCommissionRemainingAsOf } from "./utils/openingCommissionBasis";

/** Separate opening debt projection: never fabricate a sale or expose sale edit/payment actions. */
export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_COMMISSIONS]);
    const canViewAll = isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.MANAGE_COMMISSIONS);
    const rows = await (canViewAll ? ctx.db.query("openingCommissionLiabilities").withIndex("by_org", q => q.eq("orgId", args.orgId)) :
      ctx.db.query("openingCommissionLiabilities").withIndex("by_org_user", q => q.eq("orgId", args.orgId).eq("userId", user._id))).take(101);
    if (rows.length > 100) throw new ConvexError("Opening commissions require a finance review because the complete source is unavailable.");
    const reader = createOpeningSettlementReader(ctx, args.orgId);
    return Promise.all(rows.map(async (row) => {
      const basis = await openingCommissionRemainingAsOf(ctx, args.orgId, row._id, Date.now(), reader);
      const employee = await ctx.db.get(row.userId);
      const membership = await ctx.db.query("memberships").withIndex("by_org_user", q => q.eq("orgId", args.orgId).eq("userId", row.userId)).unique();
      return { _id: row._id, source: "OPENING" as const, employeeName: employee?.name ?? employee?.email ?? "Former employee",
        currency: row.currency, amountMinor: basis.kind === "AVAILABLE" ? row.amountMinor : null,
        remainingMinor: basis.kind === "AVAILABLE" ? basis.remainingMinor : null,
        notYetEffective: basis.kind === "AVAILABLE" && basis.basisDate > Date.now(),
        sourceStatus: basis.kind, sourceUnavailableReason: basis.kind === "UNAVAILABLE" ? basis.reason : null,
        payrollAvailable: basis.kind === "AVAILABLE" && basis.remainingMinor > 0 && row.paidMinor === 0 && !!employee && !!membership && !membership.offboardingStatus,
      };
    }));
  },
});
