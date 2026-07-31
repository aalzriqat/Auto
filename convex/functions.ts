import { customCtx, customMutation } from "convex-helpers/server/customFunctions";
import {
  mutation as rawMutation,
  internalMutation as rawInternalMutation,
} from "./_generated/server";
import { aggregateTriggers } from "./aggregates";

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
