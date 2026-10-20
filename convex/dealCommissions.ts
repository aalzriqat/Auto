import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireTenantAuth, requireOwnedRow } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { auditLog } from "./financialAudit";
import {
  getOrgCurrency,
  commissionAccountingDate,
  hookDealCommissionLineAccrued,
  hookDealCommissionLineReversed,
} from "./accounting/workflowHooks";
import { checkPostingAllowed } from "./accountingPeriods";
import { allLinesForSale, MAX_DEAL_COMMISSION_LINE_ROWS } from "./utils/dealCommissionLineReads";
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
  const sale = await requireOwnedRow(ctx, orgId, "sales", saleId, "Sale not found.");
  if (sale.isDeleted) throw new ConvexError("Sale not found.");
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
  const rows = await allLinesForSale(ctx, orgId, saleId);
  return rows.filter((row) => row.removedAt === undefined);
}

/**
 * One deal's commission total in minor units, from the salesperson's commission
 * (on the sale row) and its active lines.
 *
 * `totalMinor` is null when a figure cannot be read; `salePending` is true when
 * the salesperson's commission is undecided (UNKNOWN, never zero). A cancelled
 * sale owes nothing, so its total is zero.
 */
export function dealCommissionTotals(
  sale: Pick<Doc<"sales">, "status" | "commissionAmount">,
  lines: ReadonlyArray<Pick<Doc<"dealCommissionLines">, "amountMinor" | "currency">>,
  currency: string
): { totalMinor: number | null; salePending: boolean; saleCommissionMinor: number | null } {
  const salePending = sale.commissionAmount == null;
  const saleCommissionMinor = salePending
    ? null
    : (toMinorSameCurrencyOrUndefined(sale.commissionAmount as number, currency, currency) ?? null);
  const linesTotal = lines.every((line) => line.currency === currency) ? sumCommissionMinor(lines) : null;
  if (sale.status === "CANCELLED") return { totalMinor: 0, salePending, saleCommissionMinor };
  if (linesTotal === null || (!salePending && saleCommissionMinor === null)) {
    return { totalMinor: null, salePending, saleCommissionMinor };
  }
  const total = linesTotal + (saleCommissionMinor ?? 0);
  return { totalMinor: Number.isSafeInteger(total) ? total : null, salePending, saleCommissionMinor };
}

/**
 * Commission totals for many sales, for the reports. Display-only: nothing here
 * writes. One bounded index read per sale.
 */
export async function dealCommissionTotalsBySale(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  sales: ReadonlyArray<Doc<"sales">>,
  currency: string
): Promise<Map<Id<"sales">, ReturnType<typeof dealCommissionTotals>>> {
  const entries = await Promise.all(
    sales.map(async (sale) => {
      const lines = await activeLines(ctx, orgId, sale._id);
      return [sale._id, dealCommissionTotals(sale, lines, currency)] as const;
    })
  );
  return new Map(entries);
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

    const { totalMinor, salePending, saleCommissionMinor } = dealCommissionTotals(sale, out, currency);

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
      // Exact, not approximately exact: the typed figure must be precisely the
      // recorded one. More decimals than the currency holds (or a float that is
      // merely close to a valid amount) would otherwise be stored as a different
      // number than the one the manager typed.
      const scale = scaleForCurrency(currency);
      if (amountMinor / Math.pow(10, scale) !== args.amount) {
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
      if (sale.status !== "COMPLETED") {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "A commission can be registered once the sale is completed. A draft or cancelled sale has earned nothing yet."
        );
      }
      // The accrual is dated at the sale. A closed period would queue it, burn
      // every retry and dead-letter, so refuse before anything is written.
      const periodCheck = await checkPostingAllowed(ctx, args.orgId, sale.saleDate);
      if (!periodCheck.ok && !periodCheck.waiting) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This sale's accounting period is closed, so a commission entry for it could never post. Reopen the period before you add a commission."
        );
      }

      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.employeeId))
        .unique();
      if (!membership || membership.offboardingStatus) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "The employee is not an active member of this organization.");
      }

      // Removed rows are kept, so the sale's total row count is capped too:
      // every safety read below and in cancel/unwind then sees all of them.
      const allRows = await allLinesForSale(ctx, args.orgId, args.saleId);
      if (allRows.length >= MAX_DEAL_COMMISSION_LINE_ROWS) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This deal has too many commission entries in its history. Ask an administrator to review it."
        );
      }
      const existing = allRows.filter((row) => row.removedAt === undefined);
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
      await hookDealCommissionLineAccrued(ctx, {
        orgId: args.orgId,
        lineId,
        saleId: args.saleId,
        employeeId: args.employeeId,
        amountMinor,
        currency,
        actorId: user._id,
        occurredAt: await commissionAccountingDate(ctx, args.orgId, args.saleId, sale.saleDate),
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
          "Removing commission lines from a deal is not available during the pilot. Nothing has been changed."
        );
      }
      const line = await requireOwnedRow(ctx, args.orgId, "dealCommissionLines", args.lineId, "Commission line not found.");
      if (line.removedAt !== undefined) throw new ConvexError("Commission line not found.");
      if (line.paidAt !== undefined) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "This commission has already been paid through payroll, so it can no longer be removed."
        );
      }
      const now = Date.now();
      // The reversal is dated today; a closed current period could never take it.
      const todayCheck = await checkPostingAllowed(ctx, args.orgId, now);
      if (!todayCheck.ok && !todayCheck.waiting) {
        throwAppError(
          AppErrorCode.VALIDATION_FAILED,
          "Today's accounting period is closed, so the reversal could never post. Reopen it before you remove this commission."
        );
      }
      await hookDealCommissionLineReversed(ctx, {
        orgId: args.orgId,
        lineId: args.lineId,
        reason: "Commission line removed",
        actorId: user._id,
        reversalDate: now,
      });
      await ctx.db.patch(args.lineId, { removedAt: now, removedBy: user._id });
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
