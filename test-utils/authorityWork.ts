/**
 * SCRUM-208 c15825 — DRIVE AUTHORITY SETTLEMENT THROUGH ITS REAL DOORS.
 *
 * Settlement does not happen inside the accounting drain. Each freed source
 * episode becomes a durable `commitmentAuthorityWork` row, is CLAIMED by
 * `internal.accountingOutbox.dispatchAuthorityWorkItem` — which mints one
 * immutable attempt and one scheduled execution — and is settled by
 * `internal.accountingOutbox.performAuthoritySettlement`, a registered mutation
 * of its own, so that an unexpected throw rolls its whole transaction back
 * instead of committing a half-restoration.
 *
 * ⚠️ THESE HELPERS CALL THE REAL MUTATIONS, INCLUDING THE DISPATCHER. An
 * earlier version fabricated the settlement's identity by calling the worker
 * with a bare `workId`. That worked only because the worker had no execution
 * identity to validate — which was the defect. The attempt id and generation a
 * test settles with are now the ones the production dispatcher actually issued.
 *
 * ⚠️ AND THEY DO NOT CATCH. A throw from settlement is a CONTRACT, not an
 * accident: it is what proves the rollback boundary exists. A helper that
 * swallowed it would hide exactly the property these tests are here to check.
 *
 * ⚠️ THE HARNESS CANNOT AUTHORIZE CONCURRENCY. `convex-test` serializes and has
 * no OCC, so nothing here proves that two dispatchers racing in production
 * yield one attempt. It proves the state machine's LOGIC — a second dispatch
 * against a claimed row is a no-op — and the isolated Convex E2-R proves the
 * rest. Do not read a green run here as evidence of exclusion under contention.
 */
import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import { Id } from "../convex/_generated/dataModel";

/**
 * ⚠️ TIMER FUNCTIONS ONLY — NOT `Date`. `convex-test` runs a scheduled function
 * off a real `setTimeout`, and its pump only reaches timers that were faked
 * BEFORE the scheduling mutation ran. Freezing `Date` as well would pin
 * `Date.now()` and move every seeded row out of the window its due-time gate is
 * compared against.
 */
const TIMER_FNS = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;

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

/**
 * Record one durable work item per source, exactly as `recordAuthorityWork`
 * would — READY, due now, no executions spent, no attempt claimed.
 *
 * ⚠️ MORE THAN ONE SOURCE UNDER ONE EVENT IS A HARNESS-ONLY TOPOLOGY, and must
 * never be presented as production evidence (SCRUM-208 c15825).
 * `completeDeferredReversal` returns AT MOST ONE source per accounting event —
 * the SLICE branch returns immediately, the DIRECT branch pushes one — so no
 * production reversal mints siblings. Use `seedAuthorityEvent` twice for
 * isolation tests; pass several sources here only to exercise the worst-of
 * summary as the forward guard it is.
 */
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
          status: "READY" as const,
          sourceKind: s.kind,
          depositId: s.depositId,
          vehicleId: s.vehicleId,
          saleId: s.saleId,
          ...(s.holdId ? { holdId: s.holdId } : {}),
          pendingEventId,
          executions: 0,
          generation: 0,
          nextActionAt: Date.now(),
          createdAt: Date.now(),
        })
      );
    }
    return ids;
  });
}

/**
 * Claim one work item through the real dispatcher and return the exact
 * execution identity it issued.
 *
 * Returns `null` when the dispatcher declined — the row was not READY, not due,
 * or its execution budget was spent. That is a result, not a failure.
 */
export async function dispatchWork(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  workId: Id<"commitmentAuthorityWork">
): Promise<{ attemptId: Id<"commitmentAuthorityAttempt">; generation: number } | null> {
  const result = await t.mutation(internal.accountingOutbox.dispatchAuthorityWorkItem, {
    workId,
  });
  if (!result?.dispatched) return null;
  return { attemptId: result.attemptId, generation: result.generation };
}

/**
 * Settle every work item through the real doors, in order, and return the
 * accounting row's DERIVED summary outcome.
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
    const claim = await dispatchWork(t, workId);
    if (!claim) continue;
    // The dispatcher already scheduled this exact execution. Calling it here
    // with the identity it issued runs the same mutation the scheduler would,
    // and lets a throw propagate to the assertion instead of being absorbed
    // into a scheduled-function record.
    await t.mutation(internal.accountingOutbox.performAuthoritySettlement, {
      workId,
      attemptId: claim.attemptId,
      generation: claim.generation,
    });
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
 * seed the accounting row, record the work, settle it through the real doors.
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

/**
 * Dispatch one work item and let the SCHEDULER run the settlement it queued,
 * exactly as production does.
 *
 * ⚠️ USE THIS WHENEVER THE EXECUTION IS EXPECTED TO FAIL. `settleThroughWorkers`
 * calls Tx C directly so a throw can reach an assertion — but a direct call
 * leaves the queued job untouched, so the `_scheduled_functions` document stays
 * `pending` and the observer has nothing real to read. Here the settlement
 * genuinely runs and genuinely fails, which is the only way to exercise the
 * observer against a state Convex itself produced rather than one a test
 * fabricated.
 *
 * ⚠️ THE HARNESS STILL CANNOT AUTHORIZE THIS. `convex-test` models the
 * scheduler's state machine; it does not model contention, retries under load,
 * or the real service's timing. The isolated Convex E2-R owns that.
 */
export async function settleViaScheduler(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  workId: Id<"commitmentAuthorityWork">
): Promise<void> {
  vi.useFakeTimers({ toFake: [...TIMER_FNS] });
  try {
    await t.mutation(internal.accountingOutbox.dispatchAuthorityWorkItem, { workId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.useRealTimers();
  }
}

/** The durable work row, for assertions about execution state. */
export async function readWork(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  workId: Id<"commitmentAuthorityWork">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return await t.run(async (ctx: any) => ctx.db.get(workId));
}

/** Every attempt ever minted for one work item, oldest generation first. */
export async function readAttempts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  workId: Id<"commitmentAuthorityWork">
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db.query("commitmentAuthorityAttempt").collect();
    return rows
      .filter((r: any) => String(r.workId) === String(workId))
      .sort((a: any, b: any) => a.generation - b.generation);
  });
}
