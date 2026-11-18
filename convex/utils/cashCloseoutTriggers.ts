import type { Triggers } from "convex-helpers/server/triggers";
import type { DataModel, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function registerCashCloseoutTriggers<Ctx extends MutationCtx>(triggers: Triggers<DataModel, Ctx>) {
  for (const table of ["financeDealFees", "financeDealCustody"] as const) {
    triggers.register(table, async (ctx, change) => {
      const { oldDoc, newDoc } = change;
      await invalidateCashNoCosts(ctx, oldDoc);
      if (oldDoc?.applicationId !== newDoc?.applicationId || oldDoc?.orgId !== newDoc?.orgId) {
        await invalidateCashNoCosts(ctx, newDoc);
      }
    });
  }
  triggers.register("financeDealCustodyEntries", async (ctx, { oldDoc, newDoc }) => {
    for (const entry of [oldDoc, newDoc]) {
      if (!entry) continue;
      const custody = await ctx.db.get(entry.custodyId);
      if (custody?.orgId === entry.orgId) await invalidateCashNoCosts(ctx, custody);
    }
  });
  triggers.register("financeApplications", async (ctx, { oldDoc, newDoc }) => {
    if (!oldDoc || !newDoc || !newDoc.cashNoCostCloseout) return;
    if (oldDoc.salespersonId !== newDoc.salespersonId ||
      oldDoc.plannedCustody?.userId !== newDoc.plannedCustody?.userId ||
      oldDoc.plannedCustody?.amountMinor !== newDoc.plannedCustody?.amountMinor ||
      oldDoc.plannedCustody?.plannedAt !== newDoc.plannedCustody?.plannedAt ||
      oldDoc.plannedCustody?.note !== newDoc.plannedCustody?.note ||
      oldDoc.supplierSettlementRoute !== newDoc.supplierSettlementRoute ||
      oldDoc.quoteId !== newDoc.quoteId ||
      oldDoc.companyId !== newDoc.companyId ||
      oldDoc.quoteModeAtSubmission !== newDoc.quoteModeAtSubmission ||
      (oldDoc.status !== "APPROVED" && newDoc.status === "APPROVED")) {
      await invalidateCashNoCosts(ctx, { applicationId: newDoc._id, orgId: newDoc.orgId });
    }
  });
}

/** Keep invalidation on the write boundary, including edits, reversals and deletes. */
async function invalidateCashNoCosts(
  ctx: MutationCtx,
  source: { applicationId: Id<"financeApplications">; orgId: Id<"organizations"> } | null,
) {
  if (!source) return;
  const app = await ctx.db.get(source.applicationId);
  const declaration = app?.cashNoCostCloseout;
  if (app?.orgId !== source.orgId || !declaration || declaration.invalidated) return;
  await ctx.db.patch(source.applicationId, {
    cashNoCostCloseout: { ...declaration, invalidated: true },
  });
}
