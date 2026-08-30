/**
 * SCRUM-208 c15814 — DRIVE AUTHORITY SETTLEMENT THROUGH ITS REAL DOOR.
 *
 * Settlement no longer happens inside the accounting drain. Each freed source
 * episode becomes a durable `commitmentAuthorityWork` row and is settled by
 * `internal.accountingOutbox.performAuthoritySettlement` — a registered
 * mutation of its own, so that an unexpected throw rolls its whole transaction
 * back instead of committing a half-restoration.
 *
 * ⚠️ THESE HELPERS CALL THE REAL MUTATION. They construct fixture rows the way
 * a test constructs any fixture, but they never re-implement the settlement
 * itself — otherwise the suite would be testing a copy of the logic rather than
 * the code that runs in production.
 *
 * ⚠️ AND THEY DO NOT CATCH. A throw from settlement is now a CONTRACT, not an
 * accident: it is what proves the rollback boundary exists. A helper that
 * swallowed it would hide exactly the property these tests are here to check.
 */
import { internal } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";

/** The exact source episode shape `completeDeferredReversal` frees. */
export type SettleSource = {
  kind: "DIRECT" | "SLICE";
  depositId: Id<"deposits">;
  vehicleId: Id<"vehicles">;
  saleId: Id<"sales">;
  holdId?: Id<"depositVehicleHolds">;
};

/**
 * Create the accounting row that owns a set of authority work items.
 *
 * A REVERSE row in its POSTED terminal state — the accounting is already final
 * by the time any authority work runs, which is the whole separation.
 */
export async function seedAuthorityEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  idempotencyKey = `reversed_test_${String(orgId)}`
): Promise<Id<"pendingAccountingEvents">> {
  return await t.run(async (ctx: any) =>
    ctx.db.insert("pendingAccountingEvents", {
      orgId,
      kind: "REVERSE" as const,
      status: "POSTED" as const,
      idempotencyKey,
      accountingDate: Date.now(),
      actorId,
      attempts: 1,
      sourceType: "depositApplications",
      sourceId: "test",
      createdAt: Date.now(),
      resolvedAt: Date.now(),
    })
  );
}

/** Record one durable work item per source, exactly as the drain would. */
export async function seedAuthorityWork(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">,
  pendingEventId: Id<"pendingAccountingEvents">,
  sources: SettleSource[]
): Promise<Id<"commitmentAuthorityWork">[]> {
  return await t.run(async (ctx: any) => {
    const event = await ctx.db.get(pendingEventId);
    const ids: Id<"commitmentAuthorityWork">[] = [];
    for (const s of sources) {
      ids.push(
        await ctx.db.insert("commitmentAuthorityWork", {
          orgId,
          workKey: `${event.idempotencyKey}:${s.kind}:${String(s.holdId ?? s.depositId)}`,
          status: "PENDING" as const,
          sourceKind: s.kind,
          depositId: s.depositId,
          vehicleId: s.vehicleId,
          saleId: s.saleId,
          ...(s.holdId ? { holdId: s.holdId } : {}),
          pendingEventId,
          attempts: 0,
          createdAt: Date.now(),
        })
      );
    }
    return ids;
  });
}

/**
 * Settle every work item through the real registered mutation, in order, and
 * return the accounting row's DERIVED summary outcome.
 *
 * ⚠️ Rejects if any settlement throws — deliberately. That is the rollback
 * contract, and a test asserting it should use `.rejects` and then check that
 * nothing was written.
 */
export async function settleThroughWorkers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  workIds: Id<"commitmentAuthorityWork">[],
  pendingEventId: Id<"pendingAccountingEvents">
): Promise<{ outcome: string; detail?: string } | null> {
  for (const workId of workIds) {
    await t.mutation(internal.accountingOutbox.performAuthoritySettlement, { workId });
  }
  return await t.run(async (ctx: any) => {
    const event = await ctx.db.get(pendingEventId);
    if (!event?.authorityOutcome) return null;
    return {
      outcome: event.authorityOutcome,
      ...(event.authorityOutcomeDetail !== undefined
        ? { detail: event.authorityOutcomeDetail }
        : {}),
    };
  });
}

/**
 * The whole path in one call, for tests that only care about the answer:
 * seed the accounting row, record the work, settle it through the real worker.
 */
export async function settleSources(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  orgId: Id<"organizations">,
  actorId: Id<"users">,
  sources: SettleSource[],
  idempotencyKey?: string
): Promise<{ outcome: string; detail?: string } | null> {
  const eventId = await seedAuthorityEvent(t, orgId, actorId, idempotencyKey);
  const workIds = await seedAuthorityWork(t, orgId, eventId, sources);
  return await settleThroughWorkers(t, workIds, eventId);
}
