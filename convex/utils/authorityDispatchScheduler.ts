import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/**
 * SCRUM-208 — the eager authority dispatch, behind a plain-function seam.
 *
 * ⚠️ THIS EXISTS SO A TEST CAN MAKE THE SCHEDULER REJECT, AND FOR NOTHING ELSE.
 * (Authorized by c15892's test-seam ruling.) The failure it exists to reproduce
 * is a transport rejection AFTER the accounting row has already gone terminal
 * `POSTED` — which used to downgrade completed accounting through
 * `markEntryFailed`'s stale snapshot, and which no production input can provoke
 * on demand.
 *
 * ⚠️ THE PRODUCTION BEHAVIOUR IS PERMANENTLY BOUND TO THE REAL SCHEDULER.
 * There is no flag, no argument and no persisted state that changes it: this
 * module has exactly one implementation, and a test substitutes the whole
 * module (`vi.mock`) rather than toggling anything at runtime. Nothing
 * caller-controlled can reach it, and no registered mutation exposes it.
 *
 * ⚠️ SCHEDULED, NOT CALLED — the point of the original design and unchanged
 * here. A scheduled mutation runs in its own transaction, outside `drainEntries`
 * and outside its per-row catch. Calling `dispatchAuthorityWorkItem` inline
 * would rebuild the very defect the durable work item exists to prevent.
 *
 * ⚠️ AND IT IS A LATENCY OPTIMISATION, NOT THE RETRY MECHANISM. Retry liveness
 * comes from `dispatchDueAuthorityWork` reading `nextActionAt`, so an
 * organization that never drains again still settles. If this rejects, the work
 * row is already durable and the cron will find it; completed accounting must
 * stay completed regardless.
 */
export async function scheduleAuthorityDispatch(
  ctx: MutationCtx,
  workId: Id<"commitmentAuthorityWork">
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.accountingOutbox.dispatchAuthorityWorkItem, {
    workId,
  });
}
