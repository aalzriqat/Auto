import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import {
  mutation as rawMutation,
  internalMutation as rawInternalMutation,
} from "./_generated/server";
import { aggregateTriggers, deferredThreadTriggers } from "./aggregates";

/**
 * Mutation builders whose `ctx.db` keeps the aggregate component in step with
 * the tables it counts.
 *
 * Every Convex module that defines a mutation must import `mutation` /
 * `internalMutation` from here rather than from `./_generated/server`. A
 * mutation built from the raw builder still *writes* fine — it just skips the
 * trigger, so the counts drift silently and nothing fails at the time of the
 * bad write. That is precisely the failure mode a guard has to make impossible
 * rather than merely discouraged, so `aggregateWiring.test.ts` fails the build
 * on any raw import outside this file.
 *
 * `query` and `internalQuery` are unaffected — they cannot write — and are
 * still imported from `./_generated/server` as before.
 */
export const mutation = customMutation(rawMutation, customCtx(aggregateTriggers.wrapDB));
export const internalMutation = customMutation(
  rawInternalMutation,
  customCtx(aggregateTriggers.wrapDB)
);

/**
 * Builder for the two mutations that patch many of one customer's social events
 * in a loop: `customers.mergeCustomers` and `socialInbox.setConversationVehicle`.
 *
 * Everything `mutation` maintains is still maintained here *except* the
 * per-write conversation recompute, which is what makes those loops O(N²) — see
 * `deferredThreadTriggers`. The trade is that the handler owes the recompute
 * itself: collect each touched thread with `collectSocialThread` and call
 * `syncDeferredSocialThreads` before returning.
 *
 * Deliberately narrow rather than a `{ skipSync: true }` argument on the normal
 * builder. A flag is one keystroke for a future caller to add to a mutation
 * that then silently commits stale conversation rows; a separate builder makes
 * the obligation visible at the definition, and
 * `convex/deferredThreadSync.test.ts` fails the build if a module takes this
 * builder without calling the sync.
 */
export const socialBulkMutation = customMutation(
  rawMutation,
  customCtx(deferredThreadTriggers.wrapDB)
);
