import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { auditLog } from "./financialAudit";
import { getOrgCurrency } from "./accounting/workflowHooks";
import {
  scaleForCurrency,
  supportedCurrencyScale,
  toMinorUnits,
  toMinorSameCurrencyOrUndefined,
  assertFiniteNumber,
} from "./utils/money";
import {
  DEAL_COMMISSION_LINES_PILOT_DISABLED,
  MAX_DEAL_COMMISSION_LINES,
  MAX_DEAL_COMMISSION_NOTE_LENGTH,
  sumCommissionMinor,
} from "./utils/dealCommissionLines";

const kindValidator = v.union(v.literal("SALE"), v.literal("PURCHASE"), v.literal("EXECUTION"));

async function loadSale(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<Doc<"sales">> {
  const sale = await ctx.db.get(saleId);
  if (!sale || sale.isDeleted || sale.orgId !== orgId) {
    throw new ConvexError("Sale not found.");
  }
  return sale;
}

async function employeeName(ctx: QueryCtx, userId: Id<"users">): Promise<string> {
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? "";
}

async function activeLines(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<Doc<"dealCommissionLines">[]> {
  // Bounded: add refuses past MAX_DEAL_COMMISSION_LINES active lines, and a
  // removed line is kept, so the read allows for them without an unbounded scan.
  const rows = await ctx.db
    .query("dealCommissionLines")
    .withIndex("by_org_sale", (q) => q.eq("orgId", orgId).eq("saleId", saleId))
    .take(MAX_DEAL_COMMISSION_LINES * 5);
  return rows.filter((row) => row.removedAt === undefined);
}

/**
 * The commissions of one deal: the salesperson's commission (still held on the
 * sale row) plus every registered line, in minor units of the deal's currency.
 *
 * `totalMinor` is null when a figure cannot be read; `salePending` is true when
 * the salesperson's commission has not been decided yet. That is UNKNOWN, not
 * zero, so the screen can say the total is still incomplete.
 */
export const forSale = query({
  args: { orgId: v.id("organizations"), saleId: v.id("sales") },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_COMMISSIONS]);
    const sale = await loadSale(ctx, args.orgId, args.saleId);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const lines = await activeLines(ctx, args.orgId, args.saleId);

    const out = [];
    for (const line of lines) {
      out.push({
        id: line._id,
        kind: line.kind,
        employeeId: line.employeeId,
        employeeName: await employeeName(ctx, line.employeeId),
        amountMinor: line.amountMinor,
        currency: line.currency,
        note: line.note ?? null,
      });
    }

    const saleCommissionMinor =
      sale.commissionAmount == null
        ? null
        : (toMinorSameCurrencyOrUndefined(sale.commissionAmount, currency, currency) ?? null);
    const salePending = sale.commissionAmount == null;
    const sameCurrency = out.every((line) => line.currency === currency);
    const linesTotal = sameCurrency ? sumCommissionMinor(out) : null;
    const counted = sale.status !== "CANCELLED";
    let totalMinor: number | null = 0;
    if (counted) {
      if (linesTotal === null || (!salePending && saleCommissionMinor === null)) totalMinor = null;
      else {
        totalMinor = linesTotal + (saleCommissionMinor ?? 0);
        if (!Number.isSafeInteger(totalMinor)) totalMinor = null;
      }
    }

    return {
      currency,
      saleStatus: sale.status,
      salesperson: {
        employeeId: sale.salespersonId,
        employeeName: await employeeName(ctx, sale.salespersonId),
        amountMinor: saleCommissionMinor,
      },
      salePending,
      lines: out,
      totalMinor,
      canManage: isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.MANAGE_COMMISSIONS),
      writesEnabled: !DEAL_COMMISSION_LINES_PILOT_DISABLED,
    };
  },
});

export const addLine = mutation({
  args: {
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    kind: kindValidator,
    employeeId: v.id("users"),
    /** Major units of the organization's currency, as typed on the screen. */
    amount: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);
      if (DEAL_COMMISSION_LINES_PILOT_DISABLED) {
        throwAppError(
          AppErrorCode.DEAL_COMMISSION_LINES_DISABLED,
          "Adding commission lines to a deal is not available during the pilot. Nothing has been changed."
        );
      }

      assertFiniteNumber(args.amount, "commission amount");
      const currency = await getOrgCurrency(ctx, args.orgId);
      if (supportedCurrencyScale(currency) === null) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "The organization currency is not supported for commissions.");
      }
      const amountMinor = toMinorUnits(args.amount, currency);
      // More decimals than the currency holds would be silently rounded into a
      // different amount than the one typed.
      const scale = scaleForCurrency(currency);
      if (Math.abs(args.amount * Math.pow(10, scale) - amountMinor) > 1e-6) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, `A commission amount can have at most ${scale} decimals.`);
      }
      if (amountMinor <= 0) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "A commission line must be greater than zero.");
      }

      const note = args.note?.trim() || undefined;
      if (note && note.length > MAX_DEAL_COMMISSION_NOTE_LENGTH) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "The commission note is too long.");
      }

      const sale = await loadSale(ctx, args.orgId, args.saleId);
      if (sale.status === "CANCELLED") {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "A cancelled sale cannot be given a commission.");
      }

      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.employeeId))
        .unique();
      if (!membership || membership.offboardingStatus) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "The employee is not an active member of this organization.");
      }

      const existing = await activeLines(ctx, args.orgId, args.saleId);
      if (existing.length >= MAX_DEAL_COMMISSION_LINES) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "This deal has the maximum number of commission lines.");
      }
      if (existing.some((line) => line.kind === args.kind && line.employeeId === args.employeeId)) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This employee already has a commission of that type on this deal. Remove it first to change the amount."
        );
      }

      const lineId = await ctx.db.insert("dealCommissionLines", {
        orgId: args.orgId,
        saleId: args.saleId,
        kind: args.kind,
        employeeId: args.employeeId,
        amountMinor,
        currency,
        ...(note ? { note } : {}),
        createdBy: user._id,
      });
      await auditLog(ctx, {
        orgId: args.orgId,
        actorId: user._id,
        actionType: "ADD_DEAL_COMMISSION_LINE",
        resourceType: "dealCommissionLines",
        resourceId: lineId,
        description: `Registered ${args.kind} commission of ${amountMinor} (minor, ${currency}) on sale ${args.saleId}`,
        before: null,
        after: { saleId: args.saleId, kind: args.kind, employeeId: args.employeeId, amountMinor, currency },
      });
      return lineId;
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("dealCommissions.addLine failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});

export const removeLine = mutation({
  args: { orgId: v.id("organizations"), lineId: v.id("dealCommissionLines") },
  handler: async (ctx, args) => {
    try {
      const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_COMMISSIONS]);
      if (DEAL_COMMISSION_LINES_PILOT_DISABLED) {
        throwAppError(
          AppErrorCode.DEAL_COMMISSION_LINES_DISABLED,
          "Adding commission lines to a deal is not available during the pilot. Nothing has been changed."
        );
      }
      const line = await ctx.db.get(args.lineId);
      if (!line || line.orgId !== args.orgId || line.removedAt !== undefined) {
        throw new ConvexError("Commission line not found.");
      }
      await ctx.db.patch(args.lineId, { removedAt: Date.now(), removedBy: user._id });
      await auditLog(ctx, {
        orgId: args.orgId,
        actorId: user._id,
        actionType: "REMOVE_DEAL_COMMISSION_LINE",
        resourceType: "dealCommissionLines",
        resourceId: args.lineId,
        description: `Removed ${line.kind} commission of ${line.amountMinor} (minor, ${line.currency}) from sale ${line.saleId}`,
        before: { saleId: line.saleId, kind: line.kind, employeeId: line.employeeId, amountMinor: line.amountMinor },
        after: null,
      });
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.error("dealCommissions.removeLine failed", error);
      throw new ConvexError("An unexpected error occurred. Please try again later.");
    }
  },
});
