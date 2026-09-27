import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/**
 * Withdraws a deal's accounting classification when its basis changes.
 *
 * CLASSIFIED means somebody established the treatment against a specific set of
 * costs, custody balances and an invoice. Nothing re-checked it afterwards, so
 * adding an unquantified cost — or editing the invoice figure the treatment was
 * granted on — left a deal reading as settled while its own summary said
 * otherwise. This flag exists to be the gate a posting design reads; a gate
 * that silently stops representing its precondition is the whole hazard.
 *
 * Withdrawn with a row rather than silently: it is a human judgement, and
 * losing the fact that it was made and then invalidated is losing the audit.
 */
export async function invalidateClassification(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  actorId: Id<"users">,
  because: string
): Promise<void> {
  if (app.accountingClassification !== "CLASSIFIED") return;
  const now = Date.now();
  await ctx.db.insert("financeApplicationOverrides", {
    orgId: app.orgId,
    applicationId: app._id,
    field: "accountingClassification",
    previousValue: "CLASSIFIED",
    newValue: "PENDING_CLASSIFICATION",
    reason: because,
    changedBy: actorId,
    changedAt: now,
  });
  await ctx.db.patch(app._id, {
    accountingClassification: "PENDING_CLASSIFICATION",
    accountingClassifiedBy: undefined,
    accountingClassifiedAt: undefined,
    accountingClassificationNotes: undefined,
    updatedAt: now,
  });
}
