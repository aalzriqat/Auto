import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition, GenericSchema } from "convex/server";
// Relative rather than the package specifier: the package's `exports` map
// does not expose `src/`, but convex-test needs the component's schema module.
import aggregateComponentSchema from "../node_modules/@convex-dev/aggregate/src/component/schema";
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

/** Every aggregate mounted in `convex/convex.config.ts`. Keep in step with it. */
const AGGREGATE_COMPONENTS = ["vehiclesByOrg"] as const;

export function convexTestWithComponents<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(
  schema: Schema,
  modules: Record<string, () => Promise<unknown>>,
): TestConvex<Schema> {
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
  t.run = ((fn: (ctx: never) => unknown) =>
    rawRun(((ctx: never) =>
      fn(aggregateTriggers.wrapDB(ctx as never) as never)) as never)) as typeof t.run;

  return t;
}
