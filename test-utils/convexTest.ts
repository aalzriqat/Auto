import { convexTest, type TestConvex } from "convex-test";
import type { SchemaDefinition, GenericSchema } from "convex/server";
// Relative rather than the package specifier: the package's `exports` map
// does not expose `src/`, but convex-test needs the component's schema module.
import aggregateComponentSchema from "../node_modules/@convex-dev/aggregate/src/component/schema";
import rateLimiterComponentSchema from "../node_modules/@convex-dev/rate-limiter/src/component/schema";
import workpoolComponentSchema from "../node_modules/@convex-dev/workpool/src/component/schema";
import batchWorkerComponentSchema from "../node_modules/@convex-dev/batch-worker/src/component/schema";
import { aggregateTriggers } from "../convex/aggregates";
import type { api as ApiRef } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type schema from "../convex/schema";

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

const WORKPOOL_MODULES = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts");
const BATCH_WORKER_MODULES = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts");

/**
 * Opt-in registration for the `weeklyReportWorkpool` component
 * (convex/marketplaceReports.ts). Opt-in for the same reason as the rate
 * limiter: only code that enqueues weekly-report work reaches it.
 *
 * Mirrors what the package's own `@convex-dev/workpool/test` `register` does —
 * the component, plus the batch-worker it runs its main loop on, nested under
 * `<name>/batchWorker` — but through the schema/module-glob route used for the
 * other components in this file. The package's `test.ts` is not imported
 * because it carries a `/// <reference types="vite/client" />` and imports its
 * transitive `@convex-dev/batch-worker/test`, neither of which this project's
 * type program can resolve (`@convex-dev/batch-worker` is a direct devDependency
 * here so the path below exists under pnpm's strict layout).
 */
export function registerWeeklyReportWorkpool(t: {
  registerComponent: TestConvex<SchemaDefinition<GenericSchema, boolean>>["registerComponent"];
}): void {
  t.registerComponent("weeklyReportWorkpool", workpoolComponentSchema, WORKPOOL_MODULES);
  t.registerComponent("weeklyReportWorkpool/batchWorker", batchWorkerComponentSchema, BATCH_WORKER_MODULES);
}

/** Every aggregate mounted in `convex/convex.config.ts`. Keep in step with it. */
const AGGREGATE_COMPONENTS = [
  "vehiclesByOrg",
  "vehicleQualityByOrg",
  "customersByOrg",
  "leadsByOrg",
  "membershipsByOrg",
  "instagramEventsByOrg",
  "facebookEventsByOrg",
  "socialContactsByOrg",
  "bankControlByDate",
  "bankAttributionByDate",
] as const;

/**
 * SCRUM-85 (owner ruling SCRUM-760 c23812, ruling 9): an organization's currency
 * is never defaulted, so a money path refuses an organization whose settings
 * hold none. Production organizations get theirs from onboarding. A fixture
 * that creates a bare `organizations` row is a dealership that has not finished
 * onboarding, which is not the subject of most suites.
 *
 * So, as onboarding does, every `organizations` row a test inserts through
 * `t.run` is given an explicit, stored `orgSettings` row (JOD, the pilot
 * dealership's currency, with the symbol and payment types the old implicit
 * default carried). It is a real row the code under test reads, not a bypass:
 * nothing in `convex/` consults the harness. A test that inserts its own
 * `orgSettings` row for that organization replaces the seeded one instead of
 * adding a second, so `.unique()` reads stay valid and its values win.
 * `storedOrgCurrency: false` switches the seed off.
 */
function seedStoredOrgCurrency<Ctx extends { db: object }>(ctx: Ctx, seeded: Set<string>): Ctx {
  type Db = {
    insert: (table: string, doc: Record<string, unknown>) => Promise<string>;
    delete: (id: string) => Promise<void>;
    query: (table: string) => {
      withIndex: (
        name: string,
        range: (q: { eq: (field: string, value: unknown) => unknown }) => unknown,
      ) => { unique: () => Promise<{ _id: string } | null> };
    };
  };
  const target = ctx.db as Db;
  const db = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop !== "insert") {
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === "function" ? value.bind(obj) : value;
      }
      return async (table: string, doc: Record<string, unknown>) => {
        if (table === "orgSettings" && typeof doc.orgId === "string" && seeded.has(doc.orgId)) {
          const orgId = doc.orgId;
          const harnessRow = await obj
            .query("orgSettings")
            .withIndex("by_org", (q) => q.eq("orgId", orgId))
            .unique();
          if (harnessRow) await obj.delete(harnessRow._id);
          seeded.delete(orgId);
        }
        const id = await obj.insert(table, doc);
        if (table === "organizations") {
          await obj.insert("orgSettings", {
            orgId: id,
            currency: "JOD",
            currencySymbol: "د.أ",
            enabledPaymentTypes: ["CASH", "INSTALLMENT"],
          });
          seeded.add(id);
        }
        return id;
      };
    },
  });
  return new Proxy(ctx, {
    get(obj, prop, receiver) {
      return prop === "db" ? db : Reflect.get(obj, prop, receiver);
    },
  });
}

export function convexTestWithComponents<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(
  schema: Schema,
  modules: Record<string, () => Promise<unknown>>,
  // Opt-in: `transactionLimits: true` makes convex-test ENFORCE the platform's
  // per-transaction ceilings (4,096 index ranges/gets, 32,000 documents, 16 MiB).
  // Default is off, exactly as before, so no existing suite changes behaviour.
  //
  // `storedOrgCurrency: false` opts out of the stored-currency seed described on
  // `seedStoredOrgCurrency` - for the suites whose subject IS an organization
  // that never chose a currency (SCRUM-85).
  options: { transactionLimits?: boolean; storedOrgCurrency?: boolean } = {},
): TestConvex<Schema> & { runUnwrapped: TestConvex<Schema>["run"] } {
  // convexTest's own generic widens `Schema` here; re-pinning it keeps the
  // concrete table/index types that every caller's `t.run(ctx => ...)` needs.
  const t = (
    options.transactionLimits
      ? convexTest({ schema, modules, transactionLimits: true })
      : convexTest(schema, modules)
  ) as unknown as TestConvex<Schema>;

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

  const seedCurrency = options.storedOrgCurrency !== false;
  const seededOrgs = new Set<string>();
  t.run = ((fn: (ctx: never) => unknown) =>
    rawRun(((ctx: never) => {
      const wrapped = aggregateTriggers.wrapDB(ctx as never) as unknown as { db: object };
      return fn((seedCurrency ? seedStoredOrgCurrency(wrapped, seededOrgs) : wrapped) as never);
    }) as never)) as typeof t.run;

  return t as TestConvex<Schema> & { runUnwrapped: TestConvex<Schema>["run"] };
}

/**
 * SCRUM-446: a financed deal that settles through the dealership cannot close
 * without cost evidence, configured company or not. This records the dealer's
 * "no closing costs" line at zero and reconciles it — the same evidence a
 * screen collects — so a fixture about something else can reach `finalizeDeal`.
 * Must run before the deal closes (closing refuses new costs).
 */
type AsIdentity = ReturnType<TestConvex<typeof schema>["withIdentity"]>;

export async function recordReconciledZeroCost(
  as: AsIdentity,
  api: typeof ApiRef,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">,
  /** Reconciling takes a different authority from recording; defaults to `as`. */
  asReconciler: AsIdentity = as
): Promise<void> {
  const feeId = await as.mutation(api.financeDealCosts.recordDealFee, {
    orgId,
    applicationId,
    feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false,
    actualAmountMinor: 0,
    description: "No closing costs.",
    expectedCurrency: "JOD",
    idempotencyKey: crypto.randomUUID(),
  });
  await asReconciler.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId, feeId, notes: "Nothing to match.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
}

/**
 * The actual a checker looking at this cost line would be pinning their
 * reconciliation to (`reconcileDealFee.expectedActualAmountMinor`, SCRUM-834).
 * Read from the row, so a test still exercises the pin against what is stored;
 * a line with no recorded actual throws here rather than pinning an invented 0.
 */
export async function recordedActualMinor(
  t: TestConvex<typeof schema>,
  feeId: Id<"financeDealFees">
): Promise<number> {
  const fee = await t.run((ctx) => ctx.db.get(feeId));
  if (fee?.actualAmountMinor === undefined) {
    throw new Error("recordedActualMinor: the cost line has no recorded actual to pin a reconciliation to.");
  }
  return fee.actualAmountMinor;
}

/**
 * `registerVehicleHandover`, driven the way a screen drives it.
 *
 * The mutation demands the economics stamp the caller's own deal payload
 * carried, so that a deal whose figures moved while the operator was reading
 * them cannot be sealed. Tests obtain it the same way — by querying — rather
 * than by rebuilding it from the row: a test that recomputed the stamp would
 * keep passing no matter what `dealCockpit` actually projected, which is
 * exactly how the previous guard's tests passed while it was bypassable.
 */
export async function registerHandover(
  as: {
    query: (ref: any, args: any) => Promise<any>;
    mutation: (ref: any, args: any) => Promise<any>;
  },
  api: any,
  orgId: unknown,
  applicationId: unknown,
  extra: Record<string, unknown> = {}
): Promise<number> {
  // `applications.handoverStamp`, not `dealCockpit` — the stamp query is
  // authorized on the permission to hand over, so this works for any caller
  // the mutation itself would accept. Reading it from `dealCockpit` made the
  // helper demand `view:sales` too, and a test proving `finalizeDeal` refuses
  // an under-permissioned caller then failed in the harness rather than at its
  // assertion.
  const economicsStamp = await as.query(api.applications.handoverStamp, {
    orgId,
    applicationId,
  });
  return as.mutation(api.applications.registerVehicleHandover, {
    orgId,
    applicationId,
    economicsStamp,
    ...extra,
  });
}
