import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { postAccountingEvent } from "../convex/accounting/postingEngine";
import { getOrgCurrency } from "../convex/accounting/workflowHooks";
import { toMinorUnits } from "../convex/utils/money";

/**
 * Posts the GL event a legacy `transactions` row used to receive from
 * `accountingMigration.migrateUnpostedTransactions`.
 *
 * That writer is retired (SCRUM-234) and can no longer post anything. The
 * suites that call this helper — Phase 17 parallel reporting / sign-off, and
 * Phase 18 balance snapshots — never had the migration as their subject; they
 * used it to put a `sourceType: "transactions"` event into the books so that
 * cutover reporting and snapshot behavior had something to read. This helper
 * does exactly that, through the same posting engine every domain event uses,
 * with the same source identity and idempotency key the retired writer built.
 *
 * It is deliberately test-only and lives outside `convex/`, so it adds no
 * production surface: retiring the mutation must not reintroduce the same
 * writer under another name.
 *
 * Only the two categories those suites actually seed are supported. It throws
 * on anything else rather than silently posting nothing, so a future test that
 * seeds a third category fails loudly instead of asserting against an empty GL.
 */
export async function postLegacyTransactionEvent(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    transactionId: Id<"transactions">;
    actorId: Id<"users">;
  },
): Promise<void> {
  const tx = await ctx.db.get(args.transactionId);
  if (!tx) throw new Error(`Legacy transaction ${args.transactionId} not found.`);
  if (tx.orgId !== args.orgId) throw new Error("Legacy transaction belongs to another organization.");

  const currency = await getOrgCurrency(ctx, args.orgId);
  const amountMinor = toMinorUnits(tx.amount, currency);
  const sourceId = tx._id.toString();

  const payload: Record<string, unknown> = {
    amountMinor,
    currency,
    legacyTransactionId: sourceId,
  };

  let eventType: "EXPENSE_POSTED" | "COLLECTION_PAYMENT";
  if (tx.category === "EXPENSE") {
    eventType = "EXPENSE_POSTED";
    payload.expenseId = tx.expenseId?.toString() ?? sourceId;
  } else if (tx.category === "COLLECTION_PAYMENT") {
    eventType = "COLLECTION_PAYMENT";
    payload.paymentId = sourceId;
    payload.paymentMethod = "CASH";
  } else {
    throw new Error(
      `postLegacyTransactionEvent does not seed category "${tx.category}". ` +
        "Add it deliberately rather than letting the test assert against an empty GL.",
    );
  }

  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "transactions",
    sourceId,
    eventVersion: 1,
    accountingDate: tx.date,
    occurredAt: tx.date,
    currency,
    idempotencyKey: `migrate_${tx._id}`,
    payload,
    actorId: args.actorId,
  });
}
