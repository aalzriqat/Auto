import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import {
  mutation as rawMutation,
  internalMutation as rawInternalMutation,
} from "./_generated/server";
import { aggregateTriggers, createSocialBulkMutation } from "./aggregates";

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
 * `deferredThreadTriggers`. Measured on the merge path: 400 recomputes for 200
 * repointed events before, 2 after.
 *
 * ## The builder owns the settlement. Callers cannot forget it.
 *
 * This used to hand the obligation to the handler — collect each touched
 * thread, call `syncDeferredSocialThreads` before returning — and enforce it
 * with a build-time guard that read the source. That guard failed OPEN six
 * times in the same shape, each time on a different spelling, and the seventh
 * finding ended the approach on principle rather than on detail: a static check
 * can prove the calls EXIST beneath a mutation and cannot prove they EXECUTE.
 * A handler that hides them in a closure it never invokes satisfies every
 * syntactic rule while settling nothing.
 *
 * So the obligation is now discharged here:
 *
 *   1. `input` creates a per-invocation tracker and puts it on the ctx BEFORE
 *      wrapping the DB, so the deferred triggers can record into it.
 *   2. Those triggers record the threads each write touched, old side and new,
 *      and skip the recompute — which is the whole point of this builder.
 *   3. `onSuccess` runs after the handler returns and recomputes each distinct
 *      thread exactly once.
 *
 * There is no settlement API left for a caller to forget, so there is nothing
 * for a guard to police. That is why `deferredThreadSync.test.ts` is gone
 * rather than hardened again.
 *
 * ⚠️ The tracker lives in `prepareDeferredThreadMutation`'s closure, NOT at
 * module scope and NOT on the handler's context. A module-level "current
 * tracker" is the obvious shortcut and breaks when two mutations interleave;
 * exposing it to the handler is worse, because `customFnBuilder` merges
 * everything returned under `ctx` into the handler's context, so a handler
 * could `.clear()` the map and leave finalisation synchronising nothing. Only
 * the wrapped `db` crosses that boundary.
 *
 * ⚠️ FAIL-CLOSED, in both directions. `customFnBuilder` awaits `onSuccess`
 * inside the mutation's own transaction, so a throw during finalisation rolls
 * back every event write with it. And the deferred triggers now THROW when no
 * tracker is present rather than skipping the recompute — committing a write
 * while its conversation summary goes stale is the exact failure this mechanism
 * exists to prevent, so a missing tracker refuses the write instead.
 */
export const socialBulkMutation = createSocialBulkMutation(rawMutation);
