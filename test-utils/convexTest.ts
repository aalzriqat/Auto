import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition, GenericSchema } from "convex/server";
// Relative rather than the package specifier: the package's `exports` map
// does not expose `src/`, but convex-test needs the component's schema module.
import aggregateComponentSchema from "../node_modules/@convex-dev/aggregate/src/component/schema";
import rateLimiterComponentSchema from "../node_modules/@convex-dev/rate-limiter/src/component/schema";
import { aggregateTriggers } from "../convex/aggregates";

/**
 * `convexTest`, with every mounted component registered and `t.run` wired to
 * the same aggregate triggers production writes go through.
 *
 * Two things make this necessary, and both fail in ways that look like the
 * test's own bug rather than missing setup:
 *
 * 1. Components are opt-in per instance. convex-test throws
 *    `Component "x" is not registered` the moment a trigger reaches into one,
 *    and the aggregate triggers fire on ordinary writes — so *every* test that
 *    touches a counted table needs the registration.
 *
 * 2. `t.run` hands out a raw `ctx.db` that fires no triggers. A test that seeds
 *    or edits a counted row through it leaves the B-tree describing a table
 *    state that no longer exists, and the next real mutation on that row throws
 *    on a stale key. Wrapping `run` means seeding in a test behaves exactly like
 *    a write in production, so tests cannot manufacture a divergence that the
 *    application itself cannot produce.
 *
 * Lives outside `convex/` deliberately: anything under that directory is
 * bundled and deployed, and test scaffolding has no business shipping to
 * production.
 */
const COMPONENT_MODULES = import.meta.glob(
  "../node_modules/@convex-dev/aggregate/src/component/**/*.ts",
);

const RATE_LIMITER_MODULES = import.meta.glob(
  "../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts",
);

/**
 * Opt-in registration for the `rateLimiter` component (convex/rateLimit.ts).
 *
 * Deliberately NOT folded into `convexTestWithComponents` the way the
 * aggregates are. Aggregates fire from triggers on ordinary writes, so every
 * test needs them; the rate limiter is only reached by code that calls
 * `rateLimiter.limit`, and today most suites either never get there or stub the
 * module out with `vi.mock("./rateLimit", ...)`. Registering it for all ~114
 * callers would change what those suites execute — scheduled sender actions
 * that currently abort at `Component "rateLimiter" is not registered` would
 * suddenly run on to their real network calls. Opting in keeps that blast
 * radius at the one test that actually wants to assert on rate-limit
 * behaviour.
 */
export function registerRateLimiter(t: {
  registerComponent: TestConvex<SchemaDefinition<GenericSchema, boolean>>["registerComponent"];
}): void {
  t.registerComponent("rateLimiter", rateLimiterComponentSchema, RATE_LIMITER_MODULES);
}

/** Every aggregate mounted in `convex/convex.config.ts`. Keep in step with it. */
const AGGREGATE_COMPONENTS = [
  "vehiclesByOrg",
  "vehicleQualityByOrg",
  "customersByOrg",
  "leadsByOrg",
  "membershipsByOrg",
] as const;

export function convexTestWithComponents<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(
  schema: Schema,
  modules: Record<string, () => Promise<unknown>>,
): TestConvex<Schema> & { runUnwrapped: TestConvex<Schema>["run"] } {
  // convexTest's own generic widens `Schema` here; re-pinning it keeps the
  // concrete table/index types that every caller's `t.run(ctx => ...)` needs.
  const t = convexTest(schema, modules) as unknown as TestConvex<Schema>;

  for (const name of AGGREGATE_COMPONENTS) {
    t.registerComponent(name, aggregateComponentSchema, COMPONENT_MODULES);
  }

  // `wrapDB` is typed against the app's concrete DataModel while `t.run`'s ctx
  // is generic over whatever schema was passed, so the two cannot be reconciled
  // without pinning this helper to one schema. The cast is confined to this
  // line; everything either side of it stays fully typed.
  const rawRun = t.run.bind(t);

  // Escape hatch: writes that deliberately skip the triggers, so a test can
  // construct the one state the application cannot — a row present in the table
  // but absent from the B-tree. That is exactly the pre-backfill state
  // `idempotentTrigger` exists to survive, and without this it is unreachable
  // from a harness where every write maintains the tree.
  (t as unknown as { runUnwrapped: typeof t.run }).runUnwrapped = rawRun;

  t.run = ((fn: (ctx: never) => unknown) =>
    rawRun(((ctx: never) =>
      fn(aggregateTriggers.wrapDB(ctx as never) as never)) as never)) as typeof t.run;

  return t as TestConvex<Schema> & { runUnwrapped: TestConvex<Schema>["run"] };
}
