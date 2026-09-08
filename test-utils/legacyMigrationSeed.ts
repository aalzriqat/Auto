import type { MutationCtx } from "../convex/_generated/server";
import type { Id } from "../convex/_generated/dataModel";
import { postAccountingEvent } from "../convex/accounting/postingEngine";
import { getOrgCurrency } from "../convex/accounting/workflowHooks";
import { toMinorUnits } from "../convex/utils/money";

/**
 * The legacy source family, named once here so the restatement below and the
 * suites that read it back cannot drift apart.
 */
const LEGACY_SOURCE_TYPE = "transactions";

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

  // Post under the OWNING domain's source family, then rewrite the stored
  // provenance to the legacy one.
  //
  // SCRUM-234's engine boundary refuses `transactions` as a source family at
  // `postAccountingEvent`, so this helper can no longer ask production posting
  // code to mint one — and it should not be able to. What a pre-cutover
  // database actually contains is a HISTORICAL row whose provenance says
  // `transactions`, which is what the two suites that call this need to read
  // back. Constructing it as "post normally, then restate the provenance"
  // produces byte-identical journal effects to the retired writer while keeping
  // the forbidden family out of the production path entirely.
  //
  // The alternative — hand-inserting the event, journal, lines and snapshots —
  // was rejected: it would duplicate the posting engine inside a test helper,
  // and a fixture that drifts from the engine is worse than no fixture.
  const { eventId, journalEntryId } = await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: eventType === "EXPENSE_POSTED" ? "expenses" : "collectionPayments",
    sourceId,
    eventVersion: 1,
    accountingDate: tx.date,
    occurredAt: tx.date,
    currency,
    idempotencyKey: `migrate_${tx._id}`,
    payload,
    actorId: args.actorId,
  });

  if (!eventId) throw new Error("Seeding a legacy event produced no accounting event to restate.");
  await ctx.db.patch(eventId, { sourceType: LEGACY_SOURCE_TYPE });
  if (journalEntryId) await ctx.db.patch(journalEntryId, { sourceType: LEGACY_SOURCE_TYPE });
}
