import { v, ConvexError } from "convex/values";
import { internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import schema from "./schema";
import type { Doc, Id, TableNames } from "./_generated/dataModel";

/**
 * SCRUM-231 — the clean-slate cutover zero state.
 *
 * ## Why this exists beside `orgFinancialReset`
 *
 * `resetOrgFinancialData` clears the money tables an operator asked for. It was
 * never a launch gate, and it does not reach two things the clean-slate cutover
 * must prove are gone:
 *
 * - `commandIdempotency`, the command/replay authority. `runWithIdempotency`
 *   returns `existing.result` verbatim for a COMPLETED row without
 *   dereferencing anything, so a surviving row replays a stale success after
 *   the rows it named are deleted — returning document ids that no longer
 *   resolve, with no error at the boundary.
 * - `employeeAdvances` / `employeeAdvanceRecoveries`, the provenance side of
 *   the same coin (SCRUM-291 F-1).
 *
 * Verified on the merged main this was written against: neither string appears
 * anywhere in `orgFinancialReset.ts`, and `hardDeleteOrg` reaches the command
 * log but not the advances.
 *
 * ## Why the scope is DERIVED, not written down
 *
 * The org-deletion allowlist has already been wrong once in a way nothing
 * caught: three financing tables shipped invisible to `hardDeleteOrg`, which
 * reported success anyway. `scripts/orgDeletionCoverage.test.ts` exists because
 * of that, and its `KNOWN_UNCOVERED_PRE_EXISTING` list records 37 org-scoped
 * tables a "successful" purge still leaves behind today.
 *
 * A launch-blocking zero-state proof must not rest on a list with that history,
 * so the scope here is derived from `schema.tables` at run time. Every table
 * carrying an `orgId` is in scope automatically; one added to the schema
 * tomorrow is covered without anyone remembering to type its name.
 *
 * The only exceptions are the rows that must OUTLIVE the reset, each with its
 * reason. Anything else surviving is a failure, not a decision.
 *
 * ## Why this uses an index and the older reset does not
 *
 * `resetOrgFinancialData` matches rows with `.filter`, and says why: its tables
 * "differ in which indexes they carry, and a wrong index name would fail loudly
 * mid-run after earlier tables had already been deleted".
 *
 * That reasoning does not survive measurement. Every one of the **140**
 * org-scoped tables in the schema carries an index whose first field is
 * `orgId`, so the index name never has to be guessed — it is read off the table
 * definition. This module therefore uses `withIndex` throughout and never
 * scans, and a table that somehow lacks such an index is reported as
 * UNVERIFIABLE rather than skipped (see below), which is the one behaviour a
 * scan-based check cannot offer.
 *
 * The index lookup uses Convex's `" indexes"()` accessor, which the platform
 * documents as experimental and intended for "dynamically deciding which index
 * to use for a query" — precisely this. If it ever changes shape, the
 * derivation fails loudly at typecheck or in the rehearsal rather than silently
 * returning an empty scope.
 */

/**
 * Org-scoped tables that must survive the cutover, with the reason each must.
 *
 * Deliberately tiny, and mirrored on `orgDeletionCoverage.test.ts`'s
 * `RETAINED_BY_DESIGN`: an exception list is the mechanism that failed before,
 * so entries are added one at a time and each justifies itself.
 */
export const CUTOVER_RETAINED_BY_DESIGN: Record<string, string> = {
  // The platform's own deletion trail. Erasing it would destroy the record that
  // the cutover happened — the one row that must outlive the data it describes.
  adminAuditLog: "platform audit trail; the record that the cutover happened",
  // The deletion driver's own state row. `runDeletionRequestBatch` patches it on
  // every tick, so removing it mid-run stops the chain with no reschedule, no
  // FAILED status and no audit.
  organizationDeletionRequests: "the deletion driver's own state row",
};

/**
 * Command/replay authority, deleted LAST and on purpose.
 *
 * ⚠️ THE ORDERING RUNS OPPOSITE TO `ORGANIZATION_DELETION_STEPS`, WHERE
 * `commandIdempotency` IS STEP 0. That order is wrong for a cutover, and the
 * difference is not cosmetic:
 *
 * - Command log cleared FIRST, financial rows still live → an in-flight retry
 *   finds no completed row, RE-EXECUTES, and books a second economic effect
 *   against state that is still there. That is SCRUM-291's F-1, reproduced with
 *   a control: recoveredMinor 40000 → 80000, two recoveries, two
 *   EMPLOYEE_ADVANCE_RECOVERED events.
 * - Financial rows cleared FIRST, command log still live → a retry replays a
 *   stale success and returns ids that no longer resolve. Wrong, but inert: it
 *   writes nothing.
 *
 * Between a path that double-books money and a path that returns a dangling id,
 * the cutover takes the inert one — then deletes the command log too, so
 * neither survives the boundary. The proof asserts BOTH reach zero.
 */
export const COMMAND_AUTHORITY_TABLES = ["commandIdempotency"] as const;

/**
 * Rows removed per INVOCATION, across every table together.
 *
 * ⚠️ THIS IS A GLOBAL BUDGET, NOT A PER-TABLE ONE, AND THE DIFFERENCE IS A
 * RUNTIME LIMIT. `orgFinancialReset` budgets per table — it says so itself:
 * "the batch limit applies to each table separately". Over its ~40 tables that
 * is already up to 20,000 writes in one mutation; over the 138 tables this
 * module derives it would be up to 69,000. A Convex mutation is a transaction
 * with bounded reads and writes, and a reset that only discovers the bound on a
 * realistically populated tenant discovers it mid-cutover, at the worst
 * possible moment.
 *
 * So one budget is spent across the whole walk. Reads are bounded by the same
 * number: each table is read `budgetLeft + 1` deep and the walk stops the
 * moment the budget is gone, so total documents read is at most
 * `budget + tablesVisited`.
 *
 * (The pre-existing per-table budgeting in `orgFinancialReset` is NOT changed
 * here — it is a separate defect on a separate path, recorded rather than
 * folded into this lane.)
 */
const CUTOVER_DELETE_BUDGET = 500;

type IndexDefinition = { indexDescriptor: string; fields: string[] };

/**
 * The name of an index on `table` whose FIRST field is `orgId`, or null.
 *
 * First field specifically: Convex index prefixes are ordered, so an index
 * that merely mentions `orgId` in a later position cannot answer "rows for this
 * org" on its own.
 */
export function orgIndexFor(table: string): string | null {
  const definition = (schema.tables as Record<string, unknown>)[table] as
    | { [k: string]: unknown }
    | undefined;
  if (!definition) return null;
  const accessor = definition[" indexes"];
  if (typeof accessor !== "function") return null;
  const indexes = (accessor as () => IndexDefinition[]).call(definition);
  return indexes.find((index) => index.fields[0] === "orgId")?.indexDescriptor ?? null;
}

/**
 * Reads up to `limit` of an org's rows from a table named at run time.
 *
 * ⚠️ THE CAST IS THE POINT, AND IT IS CONFINED TO THIS FUNCTION. Passing a
 * `string` table name collapses Convex's per-table index union to the two
 * indexes every table shares (`by_id`, `by_creation_time`), so the compiler
 * cannot see `by_org` on a table it cannot name. The runtime call is sound —
 * `indexName` was read off that table's own definition by `orgIndexFor`, and
 * its first field is `orgId` — but the type system has no way to know that.
 *
 * Kept as one narrow, documented helper rather than a cast at each call site,
 * so there is exactly one place where the checking stops and one place to fix
 * if Convex ever types this properly.
 */
async function takeOrgRows(
  db: {
    query: (table: TableNames) => unknown;
  },
  table: string,
  indexName: string,
  orgId: Id<"organizations">,
  limit: number
): Promise<Doc<TableNames>[]> {
  const query = db.query(table as TableNames) as unknown as {
    withIndex: (
      index: string,
      range: (q: {
        eq: (field: string, value: Id<"organizations">) => unknown;
      }) => unknown
    ) => { take: (n: number) => Promise<Doc<TableNames>[]> };
  };
  return await query.withIndex(indexName, (q) => q.eq("orgId", orgId)).take(limit);
}

/**
 * Every table in the schema that carries a direct `orgId`.
 *
 * Same derivation `scripts/orgDeletionCoverage.test.ts` uses, deliberately: if
 * the two ever disagree about what "org-scoped" means that is a defect in
 * itself, and the rehearsal asserts they agree.
 */
export function orgScopedTableNames(): string[] {
  const tables = schema.tables as Record<
    string,
    { validator: { fields?: Record<string, unknown> } }
  >;
  return Object.entries(tables)
    .filter(([, table]) => Object.hasOwn(table.validator.fields ?? {}, "orgId"))
    .map(([name]) => name)
    .sort();
}

/**
 * The tables the cutover must drive to zero, command authority LAST.
 *
 * Exported so the rehearsal can assert the ordering property directly rather
 * than infer it from a passing run.
 */
export function cutoverResetOrder(): string[] {
  const command = new Set<string>(COMMAND_AUTHORITY_TABLES);
  const inScope = orgScopedTableNames().filter(
    (table) => !Object.hasOwn(CUTOVER_RETAINED_BY_DESIGN, table)
  );
  return [
    ...inScope.filter((table) => !command.has(table)),
    ...inScope.filter((table) => command.has(table)),
  ];
}

/**
 * Resolves the `orgId`-first index for every table in `tables`.
 *
 * Pure and total: it never reads the database, so it can run before a
 * destructive walk begins rather than discovering a gap partway through one.
 */
export function resolveCutoverIndexes(tables: string[]): {
  resolved: Map<string, string>;
  unverifiable: string[];
} {
  const resolved = new Map<string, string>();
  const unverifiable: string[] = [];
  for (const table of tables) {
    const indexName = orgIndexFor(table);
    if (indexName) resolved.set(table, indexName);
    else unverifiable.push(table);
  }
  return { resolved, unverifiable };
}

/**
 * THE PREFLIGHT. Refuses the whole reset unless every in-scope table can be
 * read by an `orgId`-first index.
 *
 * ⚠️ THIS RUNS BEFORE THE FIRST DELETE, AND THAT ORDERING IS THE SAFETY
 * PROPERTY. The previous shape collected unverifiable tables *while deleting*
 * and reported them in the return value. That is a partially committed reset
 * wearing a report: by the time the operator reads "unverifiable: [x]", rows in
 * every table before `x` are already gone, and the tables after it were never
 * even looked at. A destructive command that cannot see its whole subject must
 * not perform any of it.
 *
 * Throwing is what makes it atomic. In Convex an UNCAUGHT exception rolls the
 * transaction back — a caught one commits — so this must stay uncaught, and no
 * caller may wrap the reset in a `try`/`catch` that swallows it.
 */
export function assertCutoverScopeVerifiable(tables: string[]): Map<string, string> {
  const { resolved, unverifiable } = resolveCutoverIndexes(tables);
  if (unverifiable.length > 0) {
    throw new ConvexError(
      "Refusing to run the cutover reset: " +
        `${unverifiable.length} in-scope table(s) cannot be read by an orgId-first index ` +
        `(${unverifiable.join(", ")}). A reset that cannot see part of its scope would ` +
        "leave that part behind while reporting success. Nothing was deleted."
    );
  }
  return resolved;
}

/**
 * Proves — or refuses to prove — that an organization holds no state in any
 * org-scoped table.
 *
 * This is the SCRUM-231 evidence-floor item 10 gate, and it answers by COUNTING
 * ROWS. That is why it may be cited where `hardDeleteOrg` COMPLETED and
 * `resetOrgFinancialData` completed may not: both report success today while
 * leaving the employee advances behind.
 *
 * ⚠️ `unverifiable` IS A FAILURE, NOT A FOOTNOTE. A table with no `orgId`-first
 * index cannot be checked without a scan, and a check that silently skips what
 * it cannot read is indistinguishable from one that found nothing. `zero` is
 * false whenever anything is unverifiable, so an enumeration gap fails closed
 * instead of reading as a clean bill of health.
 *
 * Returns every table that still holds rows, so a failure names what survived
 * rather than only that something did.
 */
export const verifyOrgZeroState = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args
  ): Promise<{
    zero: boolean;
    tablesChecked: number;
    residual: Record<string, number>;
    unverifiable: string[];
    retainedByDesign: string[];
  }> => {
    const residual: Record<string, number> = {};
    const unverifiable: string[] = [];
    const inScope = orgScopedTableNames().filter(
      (table) => !Object.hasOwn(CUTOVER_RETAINED_BY_DESIGN, table)
    );

    for (const table of inScope) {
      const indexName = orgIndexFor(table);
      if (!indexName) {
        unverifiable.push(table);
        continue;
      }
      // `take(1)` rather than `collect()`: the question is only "is anything
      // left", and a zero-state check must not itself blow a read limit on a
      // table the reset failed to clear.
      const rows = await takeOrgRows(ctx.db, table, indexName, args.orgId, 1);
      if (rows.length > 0) residual[table] = rows.length;
    }

    return {
      zero: Object.keys(residual).length === 0 && unverifiable.length === 0,
      tablesChecked: inScope.length - unverifiable.length,
      residual,
      unverifiable,
      retainedByDesign: Object.keys(CUTOVER_RETAINED_BY_DESIGN).sort(),
    };
  },
});

/**
 * Drives one organization toward the clean-slate zero state, one bounded
 * invocation at a time.
 *
 * `dryRun` defaults to **true**, matching `resetOrgFinancialData`: the natural
 * first invocation counts, and the destructive form has to be typed on purpose.
 *
 * ⚠️ THIS DOES NOT AUTHORIZE ITSELF. It is an `internalMutation` with no client
 * surface, and SCRUM-231's authorization boundary is explicit that the
 * destructive reset and the production deployment require a separate owner
 * go-live authorization.
 *
 * ## The invocation contract
 *
 * Each call spends ONE global budget across the whole table order, then stops.
 * `nextCursor` is the table to resume at, or `null` when the walk reached the
 * end within budget. The operator repeats the call, passing the cursor back,
 * until `nextCursor` is `null` — then proves the result with
 * `verifyOrgZeroState`.
 *
 * ⚠️ `nextCursor === null` IS NOT THE PROOF OF ZERO, and neither is any other
 * field returned here. The reset's own report is exactly the kind of evidence
 * SCRUM-231 refuses: `hardDeleteOrg` reports COMPLETED and
 * `resetOrgFinancialData` reports completed while both leave the employee
 * advances behind. Only the row count from `verifyOrgZeroState` settles it.
 *
 * The cursor is an optimisation, never a correctness dependency: resuming at
 * the start is always safe, just slower, so a lost cursor costs a re-walk of
 * already-empty tables and nothing else.
 *
 * ⚠️ A DRY RUN DOES NOT CONVERGE BY REPETITION, and is not meant to. It deletes
 * nothing, so the rows it counted are still there on the next call and the
 * cursor returns to the same place forever. A dry run answers "what would ONE
 * destructive invocation do, and would it fit in one budget" — it is a bound
 * check, not a rehearsal of the whole walk.
 */
export const resetOrgToZeroState = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
    resumeFrom: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    orgName: string | null;
    perTable: Record<string, number>;
    deleted: number;
    budget: number;
    tablesVisited: number;
    nextCursor: string | null;
  }> => {
    const dryRun = args.dryRun ?? true;

    // ── Preflight. Every refusal in this block happens before the first
    // delete, so a refused reset is a reset that did nothing at all.

    // A budget that is not a positive whole number is a mistyped destructive
    // command, and silently reinterpreting it would hide the mistake. Asking
    // for MORE than the ceiling is different — that is the tool's own bound,
    // not the operator's error — so it clamps down.
    if (
      args.batchSize !== undefined &&
      (!Number.isInteger(args.batchSize) || args.batchSize < 1)
    ) {
      throw new ConvexError(
        "Refusing to run the cutover reset: batchSize must be a positive whole number. " +
          "Nothing was deleted."
      );
    }
    const budget = Math.min(args.batchSize ?? CUTOVER_DELETE_BUDGET, CUTOVER_DELETE_BUDGET);

    const org = await ctx.db.get(args.orgId);
    if (!org) {
      // Thrown, not returned: a reset aimed at an org that does not exist is a
      // mistargeted reset, and the safest response to a mistargeted destructive
      // command is to do nothing at all.
      throw new ConvexError(
        "Refusing to run the cutover reset: no organization with that id exists."
      );
    }

    const order = cutoverResetOrder();
    const indexes = assertCutoverScopeVerifiable(order);

    let startAt = 0;
    if (args.resumeFrom !== undefined) {
      startAt = order.indexOf(args.resumeFrom);
      if (startAt < 0) {
        // A cursor naming a table that is no longer in scope would silently
        // restart the walk or skip it entirely depending on how it was
        // handled. Refuse instead — the operator can resume from the start.
        throw new ConvexError(
          `Refusing to run the cutover reset: resumeFrom "${args.resumeFrom}" is not in the ` +
            "reset scope. Nothing was deleted."
        );
      }
    }

    // ── Bounded walk. From here on, writes happen.

    const perTable: Record<string, number> = {};
    let deleted = 0;
    let tablesVisited = 0;
    let nextCursor: string | null = null;

    for (let i = startAt; i < order.length; i++) {
      const table = order[i];
      const budgetLeft = budget - deleted;
      if (budgetLeft <= 0) {
        nextCursor = table;
        break;
      }
      tablesVisited++;

      // One past the remaining budget, so a table that still holds rows after
      // this pass is detected without reading the whole table.
      const rows = await takeOrgRows(
        ctx.db,
        table,
        indexes.get(table)!,
        args.orgId,
        budgetLeft + 1
      );
      const batch = rows.slice(0, budgetLeft);
      if (batch.length > 0) perTable[table] = batch.length;
      deleted += batch.length;

      if (!dryRun) {
        for (const row of batch) {
          await ctx.db.delete(row._id);
        }
      }

      if (rows.length > budgetLeft) {
        // This table still has rows, so the next invocation resumes HERE, not
        // at the table after it.
        nextCursor = table;
        break;
      }
    }

    return {
      dryRun,
      orgName: org.name ?? null,
      perTable,
      deleted,
      budget,
      tablesVisited,
      nextCursor,
    };
  },
});
