/**
 * SCRUM-868 S1 structural guards for the supplier master.
 *
 * What these prove, and what they do not:
 *  - Every write to `suppliers` and `supplierAliases` sits inside a function that was handed a
 *    `RegistryLock`, which only `withRegistryLock` can mint. The registry document's
 *    version is then read and bumped by every supplier write (test 6).
 *  - Nothing deletes a supplier (I1), nothing outside the supplier modules reads or writes the
 *    new tables, and the supplier modules use no `filter` and no unbounded `collect` (Convex
 *    guidelines).
 *  - The master carries identity only (I12): no money field.
 *  - The three tables are registered with the organization purge and kept out of the financial
 *    reset.
 *
 * HOW THE TABLE IS FOUND. The scan is type-aware: one `ts.createProgram` over the convex project
 * (convex/tsconfig.json) gives a type checker. A call is a database call because the checker resolves it
 * to an insert/patch/replace/delete/get/query method declared in a Convex database interface
 * (`GenericDatabaseWriter` and friends, node_modules/convex/dist/esm-types/server/database.d.ts), not
 * because of how it is written: `ctx.db["patch"](...)`, `const { patch } = ctx.db; patch(...)` and an
 * aliased `db` all resolve the same way. A callee that does not resolve at all (an `any` receiver) is treated
 * as a database call if its name is a database method name; `Map.get(supplierId)` is not a database call.
 * The table is the string literal first argument, or else it is read from the checker type of the first
 * argument: an `Id<"suppliers">` (the legacy `db.patch(id, ...)` / `db.replace(id, row)` form), a
 * table-name union, or a type parameter, through its base constraint (`<T extends "suppliers" | "x">`).
 *
 * HOW A LOCK IS CHECKED. Any call to a function that has a `RegistryLock` parameter must pass, for
 * that parameter, an argument whose static type is assignable to `RegistryLock`, that is not
 * `any`/`unknown`/`never`, and that is not a type assertion (`as any`, `as unknown as never`,
 * `<RegistryLock>`), and the call must not use a spread. A suppressed type error
 * (`@ts-expect-error`) still fails, because the argument type is checked, not the diagnostics.
 * `as RegistryLock` is refused anywhere outside `withRegistryLock`.
 *
 * THE DATABASE MUST NOT LEAVE ITS TYPE (SCRUM-871 L5). Every rule above recognises a database call by the Convex
 * declaration the checker resolves it to. A rewrap that drops that declaration hides the call. Two rules close
 * the ways found so far:
 *  - "db-indirect-call" (wrappers): a database method reached through `.bind`/`.call`/`.apply`, `Reflect.*` or
 *    `Function.prototype.*`, found by the lib declaration the call resolves to (`isIndirectDatabaseCall`), also
 *    when the database is only an element of the argument array (`Reflect.apply(f, undefined, [ctx.db, ...])`).
 *  - "db-indirect-call" (escape, `escapesDatabaseType`): a database value, one of its methods, or any HOLDER that carries one (a
 *    `ctx` through `db`, `{ inner: ctx }`, `{ database: ctx.db }`, an array or tuple of them, at any depth), handed to a position
 *    whose DECLARED type does not keep the Convex declaration: a parameter, an annotated variable, a parameter or property
 *    initializer, an `as` target, an `any[]` element, a returned value, `{ db }` into a declared property, a spread into a parameter
 *    or an array. The position is read at the end of the chain of parentheses, `!`, `satisfies`, `await`, conditional branches,
 *    `??` / `||` and the right of `&&` the name sits in (`valueSite`), because the checker types the destination, not the wrapper.
 *    After the hand-over the checker sees a structural or `any` type, not the Convex interface, which is how
 *    `const p: (id: Id<"suppliers">, v: {}) => Promise<void> = (ctx.db.patch)`, `invoke(ctx.db.patch, ...)`, `use(ctx.db)` with
 *    a structural parameter and `(ctx.db as any).patch` would otherwise vanish.
 *    ONE VERDICT decides every hand-over (`keepsConvex`), for a database and for a holder alike (the position a value lands in
 *    is resolved beside it, with the exceptions named below): the value keeps its Convex
 *    declaration only if EVERY member of the destination does, null/undefined/void/optional aside. A holder is compared
 *    property by property with the destination's property of the same name (an index signature stands in for a missing one),
 *    asking the same question of each property, each member of a union property, and each element and rest position of an
 *    array or tuple. Functions are compared through their call signatures: each destination input flows into the
 *    supplied callback's parameter, so the same verdict runs in reverse, including holders and rest positions.
 *    Arrow/function expressions, method-bearing object literals and named callbacks are judged. Callback parameters
 *    may discard an argument; overload pairs are conservative. Return types and getter results remain NOT proven.
 *    `QueryCtx["db"] | undefined` and `{ db?: QueryCtx["db"] }` are fine; `QueryCtx["db"] | Patcher`,
 *    `Pick<QueryCtx["db"], "get"> | Patcher`, `{ db?: Patcher }`, `{ db: Patcher | null }` and `{ inner: { db: Patcher } }` are not,
 *    because narrowing them reaches the foreign member. A destination whose database-method members ALL resolve into Convex,
 *    such as `Pick<QueryCtx["db"], "get">`, is a Convex type. `any`, an unconstrained type parameter, `unknown`, `object`, `{}`
 *    and a nesting (holders, constraints, elements) deeper than MAX_HOLDER_DEPTH are unknowable and FAIL CLOSED. A constrained type parameter is judged by
 *    its constraint. One exemption, for a database found in a holder's property: a destination object that has properties but
 *    no get/query/insert/patch/replace/delete member (`{ db: { normalizeId(...) } }`, convex/adminData.ts#assertIdBelongsToTable)
 *    cannot read or write and keeps nothing foreign.
 *    A spread is placed by its EXPANDED position, not by the index of its node: a fixed-length tuple contributes its length, an
 *    array spread or a tuple with optional/rest elements makes every later position (a rest parameter included) a possible
 *    destination, narrowed to those the element is assignable to (`isTypeAssignableTo`). A tuple-typed rest parameter is read
 *    position by position. Plain arguments after a spread use the same expanded position. A callee of type `any` takes anything.
 *    A position with no declared type keeps the value's own type and is not an escape. An unannotated destructuring
 *    VARIABLE is exempt when its initializer is the carrying value (`const { reader } = request`). The exemption does
 *    not cover parameter defaults, which may be contextually typed by a foreign signature, or a database inside a
 *    literal initializer (`const [db, n] = [ctx.db, 1]`, `const { db } = { db: ctx.db }` may fail closed). Other pattern
 *    positions (destructuring assignment, `for...of`, `catch`) use the checker's synthesized type and may fail closed.
 *    A `satisfies` constraint is not storage: its operand keeps its type, but a destination beyond it is still judged
 *    (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator).
 *    `console.log(ctx)` and loggers taking `unknown[]`/`any[]` fail closed with `db-indirect-call` too.
 *    One exemption: the KEY argument of a
 *    `WeakMap`/`WeakSet` method (the database as a key, as convex/utils/depositCancellationPending.ts does), found by the lib
 *    declaration; a database stored as a value is not exempt. The real-tree test requires zero violations and fails
 *    when any allowance stops matching a real call.
 *
 * CASTS OF A SUPPLIER ID (SCRUM-871 L6). `supplierId as any`, `as unknown as Id<"vehicles">`, `<any>supplierId`,
 * `"suppliers" as any` and `ids as unknown as Id<"vehicles">[]` hide the table from every rule above: after the cast
 * the checker sees `any` or another table. So a type assertion (`AsExpression`, or the angle-bracket `TypeAssertion`;
 * `satisfies` is a different node, keeps the operand's type, and is not flagged; `as const` retypes nothing and is
 * skipped) whose OPERAND is typed as a master table ("supplier-id-cast") is refused anywhere under convex/ except the
 * two supplier modules, which own the tables and whose writes the lock rules already cover. The operand counts when
 * its type names a master table through `Id<...>`, a union, an array or tuple element, or the table-name literal, so
 * the every-table `Id<TableNames>` counts too: it can be a supplier id. The single exception is the purge runner
 * (PURGE_RUNNER, adminOrgs.ts#deleteRowsByOrgBatch), which narrows `row._id` to the id of ONE non-master table, and only
 * where a `table === "<that table>"` check decides the branch: the then-branch of an `if`, or the right operand of an
 * `&&` with the check on the left (`isCheckedPurgeNarrowing`). The cast must sit in the runner's own body, not in a
 * function or arrow nested in it, and the `table` compared must be the runner's own parameter, resolved by the
 * checker to its declaration and not matched by spelling. A cast there to `any`, to a master table, to a table the
 * check does not name, or outside the checked branch is refused. Nowhere else is exempt, including the adminData handlers.
 *
 * THE TABLE A GUARD VETS (SCRUM-871 L7), BY DATA FLOW. A guard that dominates the call is not enough:
 * `assertAdminTable("vehicles")` followed by an id normalized against the caller's table vets one table and touches
 * another. Comparing the two expressions as text is not enough either, because the value can change in between
 * (`args.table = other`, a reassigned parameter or `let`, `Object.assign(args, ...)`) or the same text can mean a
 * different variable (a computed key `args[key]` with `key` shadowed). So the rule does not compare expressions. The
 * call's table must be the guard's OWN OUTPUT: `const { table } = assertAdminTable(x)`, a `const` object-pattern binding
 * of the property `table` (no rest, no default) from a dominating guard call, found through the checker's symbol for
 * the identifier and not its spelling (`isGuardTable`). Nothing can reassign a `const`, and `assertAdminTable` returns the
 * entry whose `.table === x`, so the value is exactly the table the guard checked. The call's table is its own table
 * argument (`db.query(t)`, `db.get(t, id)`), or the table its id was normalized against: `ctx.db.normalizeId(t, raw)` or
 * `assertIdBelongsToTable(ctx, t, raw)`, directly or through a `const` (a `let` or a parameter is not a proof;
 * `tableOfId`, four hops at most). `assertAdminTable` and `assertIdBelongsToTable` are trusted only as top-level function
 * declarations of the file under scan, never a nested function or an import that shadows the name
 * (`isFileLevelFunction`). A call with no such proof fails ("generic-table-access").
 *
 * GENERIC TABLE ACCESS. A database call whose table is typed as every table (`Id<TableNames>`,
 * `<T extends TableNames>`) names no table. It is refused ("generic-table-access", so a helper like
 * `patchRow<T extends TableNames>` is caught in its body) unless it sits in one of the exact functions
 * in GENERIC_ALLOWANCES, with the methods listed there. Each adminData handler must call
 * `assertAdminTable` as a straight-line statement before the database call and read the table from its result;
 * the purge runner is private and has one caller, passing `step.table`; two read-only helpers may use `get`.
 * A test fails if an allowance matches no real call.
 *
 * WHAT IS PROVEN, AND WHAT IS NOT.
 *  Proven, for the code under convex/ that this program resolves (not test files), and only this:
 *   - every `db` call that the checker resolves into Convex and whose table is statically knowable as a supplier table,
 *     by literal, by `Id` type or by type-parameter constraint, is inside a function with a `RegistryLock` parameter and does not delete;
 *   - every call to a lock-taking function passes a lock that type-checks and is not cast into place;
 *   - in the adminData handlers a generic call's table is the guard's `const` output.
 *  The rules for the database leaving its type and for casts are TRIPWIRES for the shapes they name, not proofs that
 *  no database value or supplier id is retyped: see the list below.
 *  NOT proven. This is a best-effort tripwire for an honest mistake, NOT a sealed boundary and not a defence
 *  against someone writing code to evade it. Known unproven routes (no exhaustive absence claim about the tree):
 *   - the database retyped where the checker does not look. `escapesDatabaseType` reads the declared type at the
 *     positions and wrappers listed above and nothing else: a route through another construct (a comma expression, a
 *     `yield`, a class-field default, a destructuring default, an object spread `{ ...ctx }`, a `for...of` over databases,
 *     the holder stored inside a `Map`, `Set` or `Promise` and read back) is not seen. A database value that is ALREADY `any` or
 *     structurally typed before it reaches a rule (it came out of `Reflect.get(ctx, "db")`, an `any`-returning helper such as
 *     `getDb(ctx): any`, pass-through like `identity<T>(ctx.db)`) is not seen, and neither is the use of a database method
 *     through `Object.getOwnPropertyDescriptor(ctx.db, ...)` once its result is untyped. Ordinary helper functions that take
 *     `ctx` or `db` with a Convex type are fine and are followed. A user-written `invoke(fn, ...)` is caught only because its
 *     parameters are not Convex types. Also not handled: a CAST to a Convex type that lands in a foreign destination
 *     (`ctx.db as QueryCtx["db"]` into a structural parameter, or one more cast on top of it, is read at the first cast, whose
 *     target is Convex, not at the destination behind it; so is a ctx cast to its own type); a CONSTRAINED generic
 *     (`use<D extends Patcher>(db: D)` called with `ctx.db`: the call site sees the inferred Convex type, and the foreign
 *     constraint is visible only inside the callee); and an `Object.assign({}, ctx.db, extra)` or `ctx.db & Extra`
 *     intersection holder;
 *   - M1 residue: function return types (`use(() => ctx.db)` into `() => Patcher`), thunks stored in holder
 *     properties, and getter return signatures are not independently compared covariantly. A literal getter can
 *     still be caught by the holder's property comparison. The input checks do cover the
 *     callback-receives-ctx pattern used by commitments.ts makeSourceLive, accountingOutbox.ts makeSourceLive and
 *     aggregates.ts#createSocialBulkMutation. Callable objects' attached properties are not followed. Type cycles
 *     and recursive generic parameter declarations stop carrier discovery on re-entry; a deeper instantiation
 *     may therefore go unseen. Construct signatures are not callback inputs and are not compared here;
 *   - a CONTEXTUALLY TYPED PARAMETER DEFAULT is not covered in every pattern position. The whole initializer
 *     (`async ({ db } = ctx) => ...`) is judged now; a default INSIDE a binding element (`async ({ db = ctx.db } = {})`
 *     under `(c?: { db?: Patcher }) => Promise<void>`) has no value position in this scan and can still erase the type;
 *   - the holder comparison pairs properties BY NAME with the destination. A destination with no property of that name has
 *     nothing to compare (`use(ctx)` into `{ other: number }` passes), a holder inside a type ARGUMENT (`Map<string, QueryCtx>`,
 *     `Promise<QueryCtx>`) is not a property and is not followed, and the exemption for a methodless `db` destination
 *     (`{ normalizeId }`) trusts that such an object cannot reach the writer. After a variable-length spread the landing
 *     positions are narrowed with `isTypeAssignableTo`, so a position the element is not assignable to is not asked;
 *   - an id retyped without a type assertion on a master-table type: widened to `string` first (`const raw: string =
 *     supplierId; raw as Id<"vehicles">`), passed through a generic `retype<T>(x): T`, a function that returns `any`,
 *     a JSON round trip, `Object.assign`, a spread into an `any` object; and a cast of a supplier ROW (`Doc<"suppliers">`),
 *     which carries the id in `_id` but is not itself typed as one. These look the same as the legitimate
 *     string-to-Id casts other modules will need, so the scan does not refuse them;
 *   - a database call whose table type is `string`, `any` or otherwise erased (a helper taking
 *     `table: string` and an `any` receiver, `(ctx.db as any).table("suppliers")`) shows no table;
 *   - a READ of a supplier row through a generic read-only helper (`requireOwnedRow`, `makeDocCache`) is
 *     not tracked: those helpers are exempt as `get`-only, and their callers are not scanned for tables;
 *   - for adminData, the allowlist's content and the guard's position are checked, but not that
 *     `assertAdminTable` throws on a table outside it; "dominates" is straight-line statements only;
 *   - for the table a guard vets: `assertAdminTable` and `assertIdBelongsToTable` are trusted by name (as file-level
 *     functions), with a test that the second one's body normalizes against its second parameter. In the purge runner
 *     the `table` parameter of the `table === "<target>"` check is not proven unassigned between the check and the cast,
 *     and the check proves `table`, not that the `row` being cast was read from that table;
 *   - a lock reached through an indirect call (a callback or object member bound to a lock-taking
 *     function, an `any`-typed callee) is not followed;
 *   - code outside convex/ (scripts, the Convex dashboard, `npx convex run` of a function that is
 *     not in this tree) is not scanned;
 *   - it does NOT prove concurrent writers conflict. `convex-test` serializes everything, so that
 *     is argued from the documented OCC read set (https://docs.convex.dev/database/advanced/occ)
 *     and is not demonstrated here.
 *
 * COMPILER API USED. `getResolvedSignature`, `getTypeAtLocation`, `getSymbolAtLocation` and `getBaseConstraintOfType`
 * are the checker calls the TypeScript Compiler API guide documents or that sit beside them
 * (https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API). The calls added for SCRUM-871 are not in that
 * guide and were checked against the installed node_modules/typescript/lib/typescript.d.ts (6.0.3):
 * `TypeChecker.getContextualType`, `getTypeFromTypeNode`, `isArrayType`/`isTupleType`/`getTypeArguments`, `isTypeAssignableTo`, `Type.isUnion` and its `.types`,
 * `Type.getNumberIndexType`/`getStringIndexType`, `Type.getProperty`/`getProperties`/`getConstructSignatures`, `TupleType.elementFlags` with `ts.ElementFlags`,
 * `ts.TypeFlags` (`Void`, `Unknown`, `NonPrimitive`), `getTypeOfSymbol`, `getAnyType`, `ts.findAncestor`, `ts.getPreEmitDiagnostics`,
 * `ts.isConstTypeReference` and `ts.getCombinedNodeFlags` with `ts.NodeFlags.Const`.
 *
 * The scanner is itself tested against synthetic bad sources, so "no violations found" cannot
 * mean "the scanner looks at nothing". The synthetic sources are compiled in the same program as
 * the real tree, as virtual files beside the real ones, so they get real types. A probe marked `typed` must also
 * compile with zero TypeScript errors, so a miss is the scanner's and not a broken fixture.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import { ORGANIZATION_DELETION_STEPS } from "../convex/adminOrgs";
import { CHILD_TABLES_FOR_TEST, RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";

const ROOT = path.resolve(__dirname, "..");
const SUPPLIER_TABLES = ["suppliers", "supplierAliases"] as const;
const REGISTRY_TABLE = "supplierRegistryState";
const ALL_TABLES: readonly string[] = [...SUPPLIER_TABLES, REGISTRY_TABLE];
const SUPPLIER_MODULES = new Set(["convex/suppliers.ts", "convex/utils/supplierRegistry.ts"]);
const LOCK_MODULE = "convex/utils/supplierRegistry.ts";
const WRITE_METHODS = new Set(["insert", "patch", "replace"]);
/** Per-test timeout for the whole-tree scan; see the comment on the lock-coverage test. */
const SCAN_TIMEOUT_MS = 75_000;

interface Violation {
  rule: string;
  line: number;
  text: string;
}
interface Scan {
  violations: Violation[];
  supplierWrites: number;
}

const SCHEMA_TABLES = Object.keys(schema.tables);

/**
 * The exact functions allowed a database call whose table is typed as every table (or as a union that
 * includes a supplier table). Not whole modules: a supplier write added anywhere else in these files is
 * flagged. Each entry names the methods it may use and, where there is one, the guard that must run
 * first. The guard is checked as a straight-line statement at the top of an enclosing function, before the
 * database call (so it dominates it); the "generic functions" test proves each entry still matches code.
 *  - adminData.ts handlers (the cross-org Data Browser): `assertAdminTable` refuses any table not in its
 *    ADMIN_TABLES allowlist, which names none of the supplier tables (asserted below).
 *  - adminOrgs.ts `deleteRowsByOrgBatch` (the organization purge): called once, with `step.table` from
 *    ORGANIZATION_DELETION_STEPS (asserted below). That is the one sanctioned delete of supplier data,
 *    together with the organization it belongs to.
 *  - tenancy.ts `requireOwnedRow` and sales.ts `makeDocCache`: generic read-only helpers (`get`), which cannot
 *    write. A READ of a supplier row through such a helper is not tracked by this scan (see the header).
 */
interface GenericAllowance {
  file: string;
  fn: string;
  methods: readonly string[];
  guard?: string;
  /** Also allow a table typed as a PARTIAL union that includes a supplier table (the constraint of a generic read helper). */
  allowPartial?: boolean;
  reason: string;
}
const ADMIN_GUARD = "assertAdminTable";
/** The organization purge step runner: the one function that may narrow the every-table id (see `isCheckedPurgeNarrowing`). */
const PURGE_RUNNER = { file: "convex/adminOrgs.ts", fn: "deleteRowsByOrgBatch" } as const;
/**
 * adminData's id proof: `assertIdBelongsToTable(ctx, table, rawId)` returns `ctx.db.normalizeId(table, rawId)`
 * or throws, so its second argument is the table the id belongs to. A test reads the helper's body to hold
 * it to that.
 */
const ID_PROOF_HELPER = "assertIdBelongsToTable";
/** Declarations in the TypeScript lib files, in these containers, call a function through a wrapper. */
const REFLECTION_OWNERS = new Set(["Reflect", "Function", "CallableFunction", "NewableFunction"]);
/** Lib containers whose methods only compare a database handle by identity. */
const WEAK_KEY_OWNERS = new Set(["WeakMap", "WeakSet"]);
const TYPESCRIPT_LIB = /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/;
const GENERIC_ALLOWANCES: readonly GenericAllowance[] = [
  { file: "convex/adminData.ts", fn: "adminListByOrg", methods: ["query"], guard: ADMIN_GUARD, reason: "Data Browser list" },
  { file: "convex/adminData.ts", fn: "adminGetRecord", methods: ["get"], guard: ADMIN_GUARD, reason: "Data Browser read" },
  { file: "convex/adminData.ts", fn: "adminUpdateRecord", methods: ["get", "patch"], guard: ADMIN_GUARD, reason: "Data Browser edit" },
  { file: "convex/adminData.ts", fn: "adminRestoreRecords", methods: ["get", "patch"], guard: ADMIN_GUARD, reason: "Data Browser restore" },
  { file: "convex/adminData.ts", fn: "adminHardDelete", methods: ["get", "delete"], guard: ADMIN_GUARD, reason: "Data Browser delete" },
  { ...PURGE_RUNNER, methods: ["query", "delete"], reason: "organization purge step runner" },
  { file: "convex/utils/tenancy.ts", fn: "requireOwnedRow", methods: ["get"], allowPartial: true, reason: "generic read-only ownership check" },
  { file: "convex/sales.ts", fn: "makeDocCache", methods: ["get"], reason: "generic read-only document cache" },
];

const DB_METHODS = new Set(["insert", "patch", "replace", "delete", "get", "query"]);
const CONVEX_PACKAGE = /[\\/]node_modules[\\/]convex[\\/]/;
/** The Convex interfaces whose methods are database calls (node_modules/convex/dist/esm-types/server/database.d.ts). */
const CONVEX_DB_INTERFACES = new Set([
  "BaseDatabaseReader",
  "GenericDatabaseReader",
  "GenericDatabaseWriter",
  "BaseTableReader",
  "BaseTableWriter",
]);

interface LockParameter {
  index: number;
  typeNode: ts.TypeNode;
}

interface TableFacts {
  tables: string[];
  /** True when the type carries no table information at all (any, unknown, an erased type). */
  unresolved: boolean;
}

/** Table names carried by a type: a string literal, a union, `Id<"table">`, or a type parameter's constraint. */
function tablesOfType(checker: ts.TypeChecker, type: ts.Type, at: ts.Node, out: TableFacts, depth = 0): void {
  if (depth > 8) {
    out.unresolved = true;
    return;
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    out.unresolved = true;
    return;
  }
  if (type.isUnion()) {
    for (const part of type.types) tablesOfType(checker, part, at, out, depth + 1);
    return;
  }
  // `Id<"suppliers">[]`, `readonly Id<...>[]` and tuples carry their elements' tables. TS Compiler API: TypeChecker.isArrayType / isTupleType / getTypeArguments.
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const element of checker.getTypeArguments(type as ts.TypeReference)) tablesOfType(checker, element, at, out, depth + 1);
    return;
  }
  if (type.isStringLiteral()) {
    out.tables.push(type.value);
    return;
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    // `T extends TableNames` or `T extends "suppliers" | "vehicles"`: the table is whatever the constraint allows.
    const constraint = checker.getBaseConstraintOfType(type);
    if (constraint === undefined || constraint === type) out.unresolved = true;
    else tablesOfType(checker, constraint, at, out, depth + 1);
    return;
  }
  // GenericId<T> is `string & { __tableName: T }`; the property carries the table-name type.
  const tableName = checker.getPropertyOfType(type, "__tableName");
  if (tableName) tablesOfType(checker, checker.getTypeOfSymbolAtLocation(tableName, at), at, out, depth + 1);
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function chainHasQuery(expression: ts.Expression): boolean {
  let current: ts.Expression = expression;
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "query") return true;
        current = callee.expression;
        continue;
      }
      return false;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return false;
  }
}

function holdsRegistryLock(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      const hasLockParameter = current.parameters.some(
        (parameter) => parameter.type !== undefined && parameter.type.getText() === "RegistryLock",
      );
      if (hasLockParameter) return true;
    }
  }
  return false;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    ) {
      return current.name.text;
    }
  }
  return undefined;
}

/** The name of the top-level declaration containing `node`: a function, or `export const name = ...`. */
function topLevelName(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current?.parent; current = current.parent) {
    if (!ts.isSourceFile(current.parent)) continue;
    if (ts.isFunctionDeclaration(current)) return current.name?.text;
    if (ts.isVariableStatement(current)) {
      const declaration = current.declarationList.declarations[0];
      return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
    }
    return undefined;
  }
  return undefined;
}

function skipParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function skipAwait(node: ts.Expression): ts.Expression {
  let current = skipParentheses(node);
  while (ts.isAwaitExpression(current)) current = skipParentheses(current.expression);
  return current;
}

/** The call to `name(...)` that `expression` is (after parentheses and `await`), or undefined. */
function callTo(expression: ts.Expression | undefined, name: string): ts.CallExpression | undefined {
  if (!expression) return undefined;
  const bare = skipAwait(expression);
  return ts.isCallExpression(bare) && ts.isIdentifier(bare.expression) && bare.expression.text === name ? bare : undefined;
}

/**
 * Every call to `guard` that sits, directly in the body block of a function enclosing `node` (not inside an
 * `if`, a loop or a callback), as a statement or a declaration's initializer that ends before `node` starts.
 * Straight-line code, so each of these runs, or throws, before `node`.
 */
function dominatingGuardCalls(node: ts.Node, guard: string, sourceFile: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const start = node.getStart(sourceFile);
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const body = (current as ts.FunctionLikeDeclaration).body;
    if (!body || !ts.isBlock(body)) continue;
    for (const statement of body.statements) {
      if (statement.end > start) break;
      const initializers = ts.isExpressionStatement(statement)
        ? [statement.expression]
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.map((declaration) => declaration.initializer)
          : [];
      for (const initializer of initializers) {
        const call = callTo(initializer, guard);
        if (call) found.push(call);
      }
    }
  }
  return found;
}

/** Parentheses, `await`, `as`, `<T>x`, `satisfies` and `!` change a value's type, never which value an expression names. */
function skipWrappers(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Expressions that can carry a database or receive one through a callback signature. */
type ValueCandidate = ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression | ts.ArrowFunction | ts.FunctionExpression | ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;

function isValueCandidate(node: ts.Node): node is ValueCandidate {
  return ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node);
}

/** `null`, `undefined` and `void` are not a place a database can be put: a destination ignores them (an optional or nullable member). */
const NULLISH_FLAGS = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void;
/** A holder inside a holder is followed this deep (`{ a: { b: { db } } }`); beyond it the hand-over fails closed. */
const MAX_HOLDER_DEPTH = 6;

/** One element of a spread array or tuple: the exact position it holds in the tuple, if known, else the earliest it can. */
interface SpreadItem {
  type: ts.Type;
  offset: number | undefined;
  lowerBound: number;
}

/** Where the next element of an argument list or array literal sits: exact, or only a lower bound after a variable-length spread. */
interface Cursor {
  position: number;
  exact: boolean;
}

/** The declared types of the positions of an argument list or array literal. */
interface PositionSource {
  at: (position: number) => ts.Type[];
  from: (position: number) => ts.Type[];
}

/** The elements of an argument list or array literal, in order. */
function listOf(node: ts.Node): readonly ts.Expression[] {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return node.arguments ?? [];
  return ts.isArrayLiteralExpression(node) ? node.elements : [];
}
/**
 * The outermost expression a value passes through unchanged on its way to wherever it is used: through parentheses,
 * `!`, `satisfies`, the branches of `c ? a : b`, either side of `??` and `||`, and the right of `&&`. The declared
 * type that matters is the one at the end of this chain, not the one beside the name.
 */
function valueSite(node: ts.Expression): ts.Expression {
  let site = node;
  for (;;) {
    const parent = site.parent;
    const passesThrough =
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      (ts.isConditionalExpression(parent) && parent.condition !== site) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === site)));
    if (!passesThrough) return site;
    site = parent as ts.Expression;
  }
}

/**
 * Does `site` hand its value to a declared type: an argument (or a spread into the argument list), a variable,
 * parameter or property initializer, an array element, a property value (also the shorthand `{ db }`), the right of
 * `=`, a returned value, an arrow body or the operand of `as` / `<T>`?
 */
function isValuePosition(site: ts.Expression): boolean {
  const parent = site.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== site) ||
    ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.initializer === site) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === site) ||
    (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === site) ||
    (ts.isArrowFunction(parent) && parent.body === site) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent)
  );
}

function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/** The method name of a callee written `x.name`, `x["name"]` or a bare identifier. */
function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee)) return stringLiteralValue(callee.argumentExpression);
  if (ts.isIdentifier(callee)) return callee.text;
  return undefined;
}

/** The function-like declaration a symbol stands for: a function, a method or `const f = () => {}`. */
function functionLikeOf(declaration: ts.Declaration): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionLike(declaration)) return declaration;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ) {
    return declaration.initializer;
  }
  return undefined;
}

/**
 * One scan context: a type checker over a program, and a cache of which functions take a lock.
 * The caller owns the program (see `getScanner`).
 */
class Scanner {
  private readonly lockParameters = new Map<ts.Symbol, LockParameter[]>();

  constructor(private readonly checker: ts.TypeChecker) {}
  private readonly databaseTypes = new Map<ts.Type, boolean>();
  private readonly databaseCarriers = new Map<ts.Type, boolean>();
  // Recursive generic signatures can produce fresh instantiated types forever. Re-entering the same
  // parameter declaration is the signature equivalent of the type-cycle check in databaseCarriers.
  private readonly activeDatabaseParameters = new Set<ts.Declaration>();

  private tablesOfExpression(expression: ts.Expression): TableFacts {
    const literal = stringLiteralValue(expression);
    if (literal !== undefined) return { tables: [literal], unresolved: false };
    const facts: TableFacts = { tables: [], unresolved: false };
    tablesOfType(this.checker, this.checker.getTypeAtLocation(expression), expression, facts);
    return facts;
  }

  /**
   * The Convex database method a resolved signature declares, or undefined. The checker answers this,
   * not the syntax: `ctx.db["patch"](...)`, `const { patch } = ctx.db; patch(...)` and an aliased `db` all
   * resolve to the same declaration in the `GenericDatabaseWriter` interface.
   */
  private databaseMemberOf(signature: ts.Signature | undefined): string | undefined {
    const declaration = signature?.declaration;
    if (!declaration || !CONVEX_PACKAGE.test(declaration.getSourceFile().fileName.replaceAll("\\", "/"))) return undefined;
    const owner = declaration.parent;
    if (!ts.isInterfaceDeclaration(owner) || !CONVEX_DB_INTERFACES.has(owner.name.text)) return undefined;
    const name = ts.isMethodSignature(declaration) ? declaration.name : undefined;
    return name && ts.isIdentifier(name) ? name.text : undefined;
  }

  private databaseMethodOf(signature: ts.Signature | undefined): string | undefined {
    const member = this.databaseMemberOf(signature);
    return member !== undefined && DB_METHODS.has(member) ? member : undefined;
  }

  /** Is the type a Convex database reader/writer, or one of its methods? Read through the checker, so an alias counts. */
  private isDatabaseType(type: ts.Type): boolean {
    // Types are interned by the checker, so the same few hundred recur across the tree: answer each once.
    const known = this.databaseTypes.get(type);
    if (known !== undefined) return known;
    const answer = this.computeIsDatabaseType(type);
    this.databaseTypes.set(type, answer);
    return answer;
  }

  private computeIsDatabaseType(type: ts.Type): boolean {
    if (type.isUnion()) return type.types.some((part) => this.isDatabaseType(part));
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = this.checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint !== type && this.isDatabaseType(constraint);
    }
    // The name test is a set lookup, so it runs before the signature scan.
    const name = (type.getSymbol() ?? type.aliasSymbol)?.name;
    if (name !== undefined && CONVEX_DB_INTERFACES.has(name)) return true;
    if (type.getCallSignatures().some((signature) => this.databaseMethodOf(signature) !== undefined)) return true;
    return this.isConvexView(type);
  }

  /**
   * An object type whose database-method members (`get`, `patch`, ...) all resolve into the Convex interfaces, like
   * `Pick<QueryCtx["db"], "get">`: calls through it still resolve to the Convex declaration, so it is a database.
   * One member that does not (`{ patch(id: string, value: object): Promise<void> }`) makes it a foreign shape.
   */
  private isConvexView(type: ts.Type): boolean {
    if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) return false;
    let seen = false;
    for (const name of DB_METHODS) {
      const member = type.getProperty(name);
      if (!member) continue;
      seen = true;
      const signatures = this.checker.getTypeOfSymbol(member).getCallSignatures();
      if (signatures.length === 0 || !signatures.every((signature) => this.databaseMethodOf(signature) !== undefined)) return false;
    }
    return seen;
  }

  /** The members of `type` named like a database method. TS Compiler API: Type.getProperty, TypeChecker.getTypeOfSymbol. */
  private databaseMethodMembers(type: ts.Type): ts.Symbol[] {
    return [...DB_METHODS].flatMap((name) => type.getProperty(name) ?? []);
  }

  private isDatabaseValue(expression: ts.Expression): boolean {
    return this.isDatabaseType(this.checker.getTypeAtLocation(expression));
  }

  /** The type of the property `name` of `type`, or undefined when it has none (the shorthand `{ db }` reads the literal's declared property). */
  private propertyTypeOf(type: ts.Type, name: string): ts.Type | undefined {
    const property = type.getProperty(name);
    return property ? this.checker.getTypeOfSymbol(property) : undefined;
  }

  /**
   * Can a value of `type` hand out a Convex database? It is one (a union is one when a member is), or an array or tuple
   * with an element that can, or an object with a property that can: a `ctx` through `db`, `{ inner: ctx }` and
   * `{ database: ctx.db }` through their property, at any depth. Answered once per type; a type that mentions itself
   * counts for nothing the second time round. Function parameters also carry incoming databases; recursive generic
   * parameter declarations stop on re-entry. Returns and callable objects' attached properties are not followed.
   * TS Compiler API: Type.getProperties / getCallSignatures, Signature.getParameters, TypeChecker.getTypeOfSymbol.
   */
  private carriesDatabase(type: ts.Type): boolean {
    const known = this.databaseCarriers.get(type);
    if (known !== undefined) return known;
    this.databaseCarriers.set(type, false);
    const answer = this.computeCarriesDatabase(type);
    this.databaseCarriers.set(type, answer);
    return answer;
  }

  private computeCarriesDatabase(type: ts.Type): boolean {
    if (this.isDatabaseType(type)) return true;
    if (type.isUnion()) return type.types.some((part) => this.carriesDatabase(part));
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      return this.checker.getTypeArguments(type as ts.TypeReference).some((item) => this.carriesDatabase(item));
    }
    if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection()) return false;
    const signatures = type.getCallSignatures();
    if (signatures.length > 0) return signatures.some((signature) => signature.getParameters().some((parameter) => {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (declaration && this.activeDatabaseParameters.has(declaration)) return false;
      if (declaration) this.activeDatabaseParameters.add(declaration);
      try {
        return this.carriesDatabase(this.checker.getTypeOfSymbol(parameter));
      } finally {
        if (declaration) this.activeDatabaseParameters.delete(declaration);
      }
    }));
    return type.getProperties().some((property) => this.carriesDatabase(this.checker.getTypeOfSymbol(property)));
  }

  /** The constraint of a type parameter, or undefined when it has none a destination could be judged by (unconstrained, `any`, `unknown`): then it fails closed. */
  private usableConstraint(type: ts.Type): ts.Type | undefined {
    const constraint = this.checker.getBaseConstraintOfType(type);
    return constraint !== undefined && constraint !== type && !(constraint.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ? constraint : undefined;
  }

  /** The members of a destination (or of a value) that can take part: a union split up, `null`, `undefined` and `void` dropped. */
  private destinationMembers(destination: ts.Type): ts.Type[] {
    const parts = destination.isUnion() ? destination.types : [destination];
    return parts.filter((part) => !(part.flags & NULLISH_FLAGS));
  }

  /** No property, signature or index at all: `unknown`, `object`, `{}`. Nothing can be compared with it, so a database handed to it is lost. */
  private isOpaque(type: ts.Type): boolean {
    if (type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return true;
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      type.getProperties().length === 0 &&
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0 &&
      type.getStringIndexType() === undefined &&
      type.getNumberIndexType() === undefined
    );
  }

  /**
   * THE ONE RULE for a database that is handed on. A Convex mutation-capable value (a database, a method of one, a `ctx`
   * or any holder that carries one, an array or tuple of them) keeps its Convex declaration in `destination` only when
   * EVERY member of the destination does, null, undefined and void aside, and the same is asked again of each property of a
   * holder destination, each member of a union property, and each element and rest position of an array or tuple. The
   * direct hand-over (`use(ctx.db)`) and the container hand-over (`use(ctx)`, `use({ inner: ctx })`) both end here.
   *  - a database needs a destination member that is a Convex database or a view whose database methods all resolve into
   *    Convex (`Pick<QueryCtx["db"], "get">`); `QueryCtx["db"] | undefined` is fine, `QueryCtx["db"] | Patcher` is not,
   *    because narrowing it reaches the foreign member;
   *  - a holder is compared property by property with the property of the same name in the destination (an index signature
   *    stands in for a missing name); a destination with no such property has nothing to call it by and passes. One
   *    exemption, for a database found in a holder's property: a destination object that has properties but no
   *    get/query/insert/patch/replace/delete member (`{ normalizeId }`, convex/adminData.ts#assertIdBelongsToTable) cannot
   *    read or write, so it keeps nothing foreign;
   *  - `any`, an unconstrained type parameter, and (for anything but a database-free value) `unknown`, `object` and `{}`
   *    are unknowable and fail closed: the value is treated as lost. A constrained type parameter is judged by its constraint;
   *  - a holder chain deeper than MAX_HOLDER_DEPTH fails closed.
   * TS Compiler API: Type.isUnion / .types, TypeChecker.getBaseConstraintOfType, Type.getProperty, Type.getStringIndexType.
   */
  private keepsConvex(value: ts.Type, destination: ts.Type, inHolder = false, depth = 0): boolean {
    if (depth > MAX_HOLDER_DEPTH) return false;
    const parts = this.destinationMembers(value);
    if (parts.length === 0) return true;
    const members = this.destinationMembers(destination);
    if (members.length === 0) return !this.carriesDatabase(value);
    return members.every((member) => parts.every((part) => this.partKeepsConvex(part, member, inHolder, depth)));
  }

  private partKeepsConvex(part: ts.Type, member: ts.Type, inHolder: boolean, depth: number): boolean {
    if (!this.carriesDatabase(part) && !this.carriesDatabase(member)) return true;
    if (member.flags & ts.TypeFlags.Any) return false;
    if (member.flags & ts.TypeFlags.TypeParameter) {
      const constraint = this.usableConstraint(member);
      return constraint !== undefined && this.keepsConvex(part, constraint, inHolder, depth + 1);
    }
    if (this.isDatabaseType(part)) {
      return this.isDatabaseType(member) || (inHolder && this.isMethodlessObject(member));
    }
    if (this.isOpaque(member)) return false;
    if (!this.parametersKeepConvex(part, member, depth)) return false;
    if (this.checker.isArrayType(part) || this.checker.isTupleType(part)) return this.elementsKeepConvex(part, member, inHolder, depth);
    return part.getProperties().every((property) => {
      const carried = this.checker.getTypeOfSymbol(property);
      const counterpart = member.getProperty(property.name);
      const declared = counterpart ? this.checker.getTypeOfSymbol(counterpart) : member.getStringIndexType();
      return declared === undefined || this.keepsConvex(carried, declared, true, depth + 1);
    });
  }

  /**
   * A callback receives the destination signature's inputs: compare them in the reverse direction with the same
   * verdict used for ordinary hand-overs. An omitted callback parameter discards the input. Rest parameters use
   * the same expanded positions as calls. Overload pairs are checked conservatively; returns are not followed.
   * TypeScript's function compatibility permits a structural parameter here; assignability alone is insufficient.
   * https://www.typescriptlang.org/docs/handbook/type-compatibility.html#comparing-two-functions
   */
  private parametersKeepConvex(value: ts.Type, destination: ts.Type, depth: number): boolean {
    return destination.getCallSignatures().every((incoming) => value.getCallSignatures().every((callback) => {
      const receiver = this.signaturePositions(callback);
      return incoming.getParameters().every((parameter, index) => {
        const type = this.checker.getTypeOfSymbol(parameter);
        const declaration = parameter.valueDeclaration;
        const rest = declaration !== undefined && ts.isParameter(declaration) && !!declaration.dotDotDotToken;
        const items = rest ? this.spreadItems(type) : [{ type, offset: 0, lowerBound: 0 }];
        return items.every((item) => {
          const landing = item.offset === undefined ? this.assignableTo(item.type, receiver.from(index + item.lowerBound)) : receiver.at(index + item.offset);
          return landing.every((declared) => this.keepsConvex(item.type, declared, false, depth + 1));
        });
      });
    }));
  }

  /** An object with at least one property and no database method among them: it cannot read or write, whatever else it offers. */
  private isMethodlessObject(type: ts.Type): boolean {
    return (
      (type.flags & ts.TypeFlags.Object) !== 0 &&
      type.getProperties().length > 0 &&
      type.getCallSignatures().length === 0 &&
      this.databaseMethodMembers(type).length === 0
    );
  }

  /** Each element of an array or tuple that carries a database, against the position(s) of `member` it lands in. */
  private elementsKeepConvex(part: ts.Type, member: ts.Type, inHolder: boolean, depth: number): boolean {
    return this.spreadItems(part).every((item) => {
      const landing = item.offset === undefined ? this.assignableTo(item.type, this.positionTypes(member, item.lowerBound, true)) : this.positionTypes(member, item.offset, false);
      return landing.every((declared) => this.keepsConvex(item.type, declared, inHolder, depth + 1));
    });
  }

  /**
   * The elements of an array or tuple, each with the position it holds: an exact `offset` for a tuple element before any
   * rest or variadic element, otherwise only the `lowerBound` (an array element can sit anywhere from 0). TS Compiler
   * API: TypeChecker.isTupleType / isArrayType / getTypeArguments, TupleType.elementFlags, ElementFlags.
   */
  private spreadItems(type: ts.Type): SpreadItem[] {
    if (this.checker.isTupleType(type)) {
      const flags = (type as ts.TupleTypeReference).target.elementFlags;
      const rest = flags.findIndex((flag) => flag & ts.ElementFlags.Variable);
      return this.checker.getTypeArguments(type as ts.TypeReference).map((item, index) => ({
        type: item,
        offset: rest >= 0 && index >= rest ? undefined : index,
        lowerBound: rest >= 0 ? Math.min(index, rest) : index,
      }));
    }
    if (this.checker.isArrayType(type)) return this.checker.getTypeArguments(type as ts.TypeReference).map((item) => ({ type: item, offset: undefined, lowerBound: 0 }));
    return [{ type, offset: undefined, lowerBound: 0 }];
  }

  /**
   * Of the positions a value MIGHT land in (after a variable-length spread, or in a rest tuple), only those it can be assigned
   * to are real: a database cannot land in a `number`. TS Compiler API: TypeChecker.isTypeAssignableTo (public since 5.4).
   */
  private assignableTo(value: ts.Type, candidates: readonly ts.Type[]): ts.Type[] {
    const kept = candidates.filter((candidate) => this.checker.isTypeAssignableTo(value, candidate));
    return kept.length > 0 ? kept : [...candidates]; // a comparison the checker cannot make is not a reason to drop the position: fail closed
  }

  /**
   * The types position `offset` of `container` can hold: an element of a tuple (a rest or trailing element when the
   * position is at or past the rest element), of an array, or the number index of anything else. With `onward`, every
   * position from `offset` on. `any` and an unconstrained type parameter are returned as themselves, which `keepsConvex` refuses.
   */
  private positionTypes(container: ts.Type, offset: number, onward: boolean): ts.Type[] {
    return this.destinationMembers(container).flatMap((member) => {
      if (member.flags & ts.TypeFlags.Any) return [member];
      if (member.flags & ts.TypeFlags.TypeParameter) {
        const constraint = this.usableConstraint(member);
        return constraint !== undefined ? this.positionTypes(constraint, offset, onward) : [member];
      }
      if (this.checker.isTupleType(member)) {
        const flags = (member as ts.TupleTypeReference).target.elementFlags;
        const rest = flags.findIndex((flag) => flag & ts.ElementFlags.Variable);
        const items = this.checker.getTypeArguments(member as ts.TypeReference);
        const reaches = (index: number): boolean => {
          if (rest < 0) return onward ? index >= offset : index === offset;
          if (onward) return index >= Math.min(offset, rest);
          return offset < rest ? index === offset : index >= rest;
        };
        return items.filter((_item, index) => reaches(index));
      }
      if (this.checker.isArrayType(member)) return [...this.checker.getTypeArguments(member as ts.TypeReference)];
      const indexed = member.getNumberIndexType();
      return indexed ? [indexed] : [];
    });
  }

  /**
   * A database value, one of its methods, or a holder that carries one, handed to a position whose DECLARED type does
   * not keep the Convex declaration (`keepsConvex`): a parameter, an annotated variable, an `as` target, an element of an
   * `any[]`. From there on the checker no longer resolves calls into the Convex interface, which is how every later rule recognises a
   * database call (`const p: (id: Id<"suppliers">, v: {}) => Promise<void> = ctx.db.patch`, `use(ctx.db)` with a
   * structural parameter, `invoke(ctx.db.patch, ...)`, `(ctx.db as any).patch`, `use(ctx)` with a structural
   * `{ db: { patch(...) } }`). The position is the end of the chain of parentheses, `!`, `satisfies`, `await`, conditional
   * branches and `??` / `||` the name sits in (`valueSite`). A position with no declared type keeps the value's own
   * type, so it is not an escape. TS Compiler API: TypeChecker.getContextualType, getResolvedSignature.
   */
  private escapesDatabaseType(node: ValueCandidate): boolean {
    const site = valueSite(node);
    if (!isValuePosition(site)) return false;
    const type = this.checker.getTypeAtLocation(node);
    // `use(...dbs)`: what flows is each element of the spread array or tuple.
    const spread = ts.isSpreadElement(site.parent) ? site.parent : undefined;
    const items = spread ? this.spreadItems(type) : [{ type, offset: undefined, lowerBound: 0 }];
    // A WeakMap/WeakSet KEY (argument 0) is only ever compared by identity: it cannot be read back or called
    // (convex/utils/depositCancellationPending.ts). A database stored as a VALUE can be read back, so it is not exempt.
    const parent = site.parent;
    if (ts.isCallExpression(parent) && parent.arguments[0] === site && this.libContainerOf(parent, WEAK_KEY_OWNERS) !== undefined) return false;
    if (!spread) return this.destinationTypes(site).some((declared) => !this.keepsConvex(type, declared));
    const source = this.positionSource(spread.parent);
    if (!source) return false;
    const cursor = this.cursorBefore(listOf(spread.parent), spread);
    return items.some((item) => {
      const exact = item.offset !== undefined && cursor.exact;
      const landing = exact ? source.at(cursor.position + (item.offset ?? 0)) : this.assignableTo(item.type, source.from(cursor.position + item.lowerBound));
      return landing.some((declared) => !this.keepsConvex(item.type, declared));
    });
  }

  /**
   * Where the argument or element `target` of a list starts: the number of positions before it, exact while every earlier
   * element is a plain one or a fixed-length tuple spread, otherwise only a lower bound (an array spread, or a tuple with
   * optional or rest elements, can be any length). This is the EXPANDED position, not the index of the node in the list.
   */
  private cursorBefore(elements: readonly ts.Expression[], target: ts.Expression): Cursor {
    let cursor: Cursor = { position: 0, exact: true };
    for (const element of elements) {
      if (element === target) break;
      if (!ts.isSpreadElement(element)) {
        cursor = { position: cursor.position + 1, exact: cursor.exact };
        continue;
      }
      const type = this.checker.getTypeAtLocation(element.expression);
      if (this.checker.isTupleType(type)) {
        const flags = (type as ts.TupleTypeReference).target.elementFlags;
        const required = flags.filter((flag) => flag & ts.ElementFlags.Required).length;
        cursor = { position: cursor.position + required, exact: cursor.exact && flags.every((flag) => flag & ts.ElementFlags.Required) };
      } else {
        cursor = { position: cursor.position, exact: false };
      }
    }
    return cursor;
  }

  /**
   * The declared types a plain (non-spread) value at `site` flows into. The contextual type of the site, or for an element
   * of an array literal the array's declared element type (e.g. `ArrayLike<any>`), or for the shorthand `{ db }` the
   * property of the object literal's contextual type; after a spread in the same list, the type at the expanded position.
   */
  private destinationTypes(site: ts.Expression): ts.Type[] {
    const parent = site.parent;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isArrayLiteralExpression(parent)) {
      const elements = listOf(parent);
      const before = elements.slice(0, elements.indexOf(site));
      if (before.some((element) => ts.isSpreadElement(element))) {
        const source = this.positionSource(parent);
        if (!source) return [];
        const cursor = this.cursorBefore(elements, site);
        return cursor.exact ? source.at(cursor.position) : source.from(cursor.position);
      }
    }
    // `const { a, b } = request` has no declared type: the checker types the pattern from the initializer, it does not constrain it.
    if (ts.isVariableDeclaration(parent) && parent.initializer === site && (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name)) && parent.type === undefined) return [];
    if (this.isSatisfiesOperand(site)) return [];
    if (ts.isShorthandPropertyAssignment(parent)) {
      const literal = this.checker.getContextualType(parent.parent);
      const declared = literal && this.propertyTypeOf(literal, parent.name.text);
      return declared ? [declared] : [];
    }
    const declared = this.checker.getContextualType(site);
    if (declared !== undefined) return [declared];
    return ts.isArrayLiteralExpression(parent) ? this.arrayElementDestination(parent) : [];
  }

  /**
   * A satisfies constraint checks an operand but is not its storage type. Suppress its inward contextual type;
   * the literal/function candidate at the outside still checks any actual destination beyond satisfies.
   * Stop at calls, assignments and other value boundaries so a nested hand-over is still judged.
   */
  private isSatisfiesOperand(site: ts.Expression): boolean {
    let current: ts.Node = site;
    while (current.parent) {
      const parent = current.parent;
      if (ts.isSatisfiesExpression(parent) && parent.expression === current) return true;
      if (ts.isPropertyAssignment(parent) && parent.initializer === current) current = parent.parent;
      else if (ts.isShorthandPropertyAssignment(parent) && parent.name === current) current = parent.parent;
      else if (ts.isArrayLiteralExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) current = parent;
      else return false;
    }
    return false;
  }

  /**
   * What the positions of an argument list or an array literal are declared to hold: the parameters of the resolved
   * signature (a tuple-typed rest parameter position by position, an array-typed one for every position from its start),
   * or the contextual array or tuple type of a literal. A callee of type `any` takes anything: unknowable, so `any`.
   */
  private positionSource(list: ts.Node): PositionSource | undefined {
    if (ts.isArrayLiteralExpression(list)) {
      const declared = this.checker.getContextualType(list);
      return declared === undefined ? undefined : { at: (position) => this.positionTypes(declared, position, false), from: (position) => this.positionTypes(declared, position, true) };
    }
    if (!ts.isCallExpression(list) && !ts.isNewExpression(list)) return undefined;
    if (this.checker.getTypeAtLocation(list.expression).flags & ts.TypeFlags.Any) {
      const anything = [this.checker.getAnyType()];
      return { at: () => anything, from: () => anything };
    }
    const signature = this.checker.getResolvedSignature(list);
    if (!signature) return undefined;
    return this.signaturePositions(signature);
  }

  /** One position model for call arguments and callback inputs, including array and tuple rest parameters. */
  private signaturePositions(signature: ts.Signature): PositionSource {
    const parameters = signature.getParameters();
    const last = parameters[parameters.length - 1];
    const hasRest = last !== undefined && !!last.valueDeclaration && ts.isParameter(last.valueDeclaration) && !!last.valueDeclaration.dotDotDotToken;
    const fixed = (hasRest ? parameters.slice(0, -1) : parameters).map((parameter) => this.checker.getTypeOfSymbol(parameter));
    const restType = hasRest ? this.checker.getTypeOfSymbol(last) : undefined;
    return {
      at: (position) => (position < fixed.length ? [fixed[position]] : restType ? this.positionTypes(restType, position - fixed.length, false) : []),
      from: (position) => [...fixed.slice(position), ...(restType ? this.positionTypes(restType, Math.max(0, position - fixed.length), true) : [])],
    };
  }

  /** An element of an array literal takes its type from the array's declared element type. */
  private arrayElementDestination(array: ts.ArrayLiteralExpression): ts.Type[] {
    const declared = this.checker.getContextualType(array);
    return declared === undefined ? [] : [declared.getNumberIndexType() ?? this.checker.getAnyType()];
  }

  /** The interface or namespace a TypeScript lib function is declared in (`Reflect`, `CallableFunction`, `WeakMap`), or undefined. */
  private libContainerOf(call: ts.CallExpression, owners: ReadonlySet<string>): string | undefined {
    const declaration = this.checker.getResolvedSignature(call)?.declaration;
    if (!declaration) return undefined;
    const owner = declaration.parent;
    const container = ts.isInterfaceDeclaration(owner) ? owner.name : ts.isModuleBlock(owner) ? owner.parent.name : undefined;
    // The owner name is the cheap test, so it runs before the path test (every call node comes through here).
    return container !== undefined &&
      ts.isIdentifier(container) &&
      owners.has(container.text) &&
      TYPESCRIPT_LIB.test(declaration.getSourceFile().fileName)
      ? container.text
      : undefined;
  }

  /**
   * A database method reached through a wrapper: `db.patch.bind(db)`, `.call(...)`, `.apply(...)`,
   * `Reflect.apply(db.patch, db, [...])`, `Reflect.get(db, "patch")`, `Function.prototype.call.call(db.patch, ...)`.
   * The wrapper is recognised by the lib declaration the checker resolves the call to, the database by the
   * type of the receiver or of any argument. (A database that is already `any` or structurally typed before it
   * gets here is the business of `escapesDatabaseType`, at the place it was retyped.)
   */
  private isIndirectDatabaseCall(call: ts.CallExpression): boolean {
    // A call of a TypeScript lib function that calls another one: `Reflect.*`, `Function.prototype.call/apply/bind`.
    if (this.libContainerOf(call, REFLECTION_OWNERS) === undefined) return false;
    const receiver = ts.isPropertyAccessExpression(call.expression) ? [call.expression.expression] : [];
    // `Reflect.apply(f, thisArg, [db, "patch"])`: the argument list is an array literal, so its elements are arguments too.
    const passed = call.arguments.flatMap((argument) => (ts.isArrayLiteralExpression(argument) ? [...argument.elements] : [argument]));
    return [...receiver, ...passed].some((expression) => this.isDatabaseValue(expression));
  }

  /**
   * Does the cast `node` retype a value that can be a supplier-master row's id (or the table's name)? The operand's
   * type names a master table: `Id<"suppliers">`, a union or array of one, the table-name literal, or `Id<TableNames>`.
   * `as const` retypes nothing and is skipped. The one exception is the purge runner's narrowing, see `isCheckedPurgeNarrowing`.
   */
  private castRetypesMasterId(node: ts.AsExpression | ts.TypeAssertion, relPath: string): boolean {
    if (ts.isConstTypeReference(node.type)) return false;
    const { tables } = this.tablesOfExpression(node.expression);
    if (!tables.some((table) => ALL_TABLES.includes(table))) return false;
    return !this.isCheckedPurgeNarrowing(node, tables, relPath);
  }

  /**
   * `row._id as Id<"payrollItems">` in `adminOrgs.ts#deleteRowsByOrgBatch`: the every-table id narrowed to the id
   * of ONE non-master table, with `table === "payrollItems"` (an `if` condition or an `&&` conjunct on the
   * function's own `table` parameter) deciding that branch. Nowhere else, and not to `any` or a master table. The cast
   * must sit in the runner's own body, not in a function or arrow nested in it, and the `table` compared must be the
   * runner's own parameter declaration (not another parameter that happens to be spelled `table`).
   */
  private isCheckedPurgeNarrowing(node: ts.AsExpression | ts.TypeAssertion, operandTables: readonly string[], relPath: string): boolean {
    if (relPath !== PURGE_RUNNER.file) return false;
    const runner = ts.findAncestor(node, ts.isFunctionLike);
    if (!runner || !ts.isFunctionDeclaration(runner) || runner.parent !== node.getSourceFile() || runner.name?.text !== PURGE_RUNNER.fn) return false;
    if (!SCHEMA_TABLES.every((table) => operandTables.includes(table))) return false;
    const target: TableFacts = { tables: [], unresolved: false };
    tablesOfType(this.checker, this.checker.getTypeFromTypeNode(node.type), node, target);
    if (target.unresolved || target.tables.length !== 1 || ALL_TABLES.includes(target.tables[0])) return false;
    return this.tableCheckDominates(node, target.tables[0], runner);
  }

  /** Is `expr` the check `table === "<target>"` (either order) on the parameter named `table` of `runner`? */
  private isTableCheck(expr: ts.Expression, target: string, runner: ts.FunctionDeclaration): boolean {
    const bare = skipParentheses(expr);
    if (!ts.isBinaryExpression(bare) || bare.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    const sides = [bare.left, bare.right];
    const name = sides.find((side): side is ts.Identifier => ts.isIdentifier(side));
    const literal = sides.map((side) => stringLiteralValue(side)).find((value) => value !== undefined);
    const declared = name && this.checker.getSymbolAtLocation(name)?.valueDeclaration;
    return literal === target && declared !== undefined && ts.isParameter(declared) && declared.parent === runner && name?.text === "table";
  }

  /**
   * Does a `table === "<target>"` check decide the branch `node` is in: the then-branch of an `if` whose condition has
   * it as a conjunct, or the right operand of an `&&` that has it as a conjunct on the left? Stops at a function boundary.
   */
  private tableCheckDominates(node: ts.Node, target: string, runner: ts.FunctionDeclaration): boolean {
    const conjuncts = (expr: ts.Expression): ts.Expression[] => {
      const bare = skipParentheses(expr);
      return ts.isBinaryExpression(bare) && bare.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ? [...conjuncts(bare.left), ...conjuncts(bare.right)]
        : [bare];
    };
    let child: ts.Node = node;
    for (let parent = node.parent; parent && !ts.isFunctionLike(parent); child = parent, parent = parent.parent) {
      const guarded =
        (ts.isIfStatement(parent) && child === parent.thenStatement && parent.expression) ||
        (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && child === parent.right && parent.left);
      if (guarded && conjuncts(guarded).some((conjunct) => this.isTableCheck(conjunct, target, runner))) return true;
    }
    return false;
  }

  /** `function name(...)` declared at the top level of the file under scan: not a nested shadow, not an import. */
  private isFileLevelFunction(callee: ts.Expression): boolean {
    const declared = this.checker.getSymbolAtLocation(callee)?.valueDeclaration;
    return declared !== undefined && ts.isFunctionDeclaration(declared) && declared.parent === callee.getSourceFile();
  }

  /**
   * Is `expression` the `table` field of a guard's own return value, `const { table } = guard(x)`, bound by a `const`
   * (so nothing can reassign it) from one of the dominating `guards`? The identifier is resolved by the checker to its
   * declaration, never by its text, so `args` can be mutated, reassigned or shadowed without changing the answer.
   */
  private isGuardTable(expression: ts.Expression, guards: readonly ts.CallExpression[]): boolean {
    const bare = skipWrappers(expression);
    if (!ts.isIdentifier(bare)) return false;
    const element = this.checker.getSymbolAtLocation(bare)?.valueDeclaration;
    if (!element || !ts.isBindingElement(element) || element.dotDotDotToken || element.initializer) return false;
    const pattern = element.parent;
    const variable = pattern.parent;
    const property = element.propertyName ?? element.name;
    if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(variable) || !isConstDeclaration(variable)) return false;
    if (!ts.isIdentifier(property) || property.text !== "table" || variable.initializer === undefined) return false;
    const initializer = skipAwait(variable.initializer);
    return ts.isCallExpression(initializer) && guards.includes(initializer);
  }

  /**
   * The table expression an id was normalized against: `ctx.db.normalizeId(<table>, raw)`, or the second argument
   * of the id-proof helper (a top-level function of this file), found directly or through a `const` the id was bound to.
   */
  private tableOfId(idExpression: ts.Expression, depth = 0): ts.Expression | undefined {
    const bare = skipWrappers(idExpression);
    if (ts.isCallExpression(bare)) {
      const proof = callTo(bare, ID_PROOF_HELPER);
      if (proof) return this.isFileLevelFunction(proof.expression) ? proof.arguments[1] : undefined;
      const isNormalizeId =
        ts.isPropertyAccessExpression(bare.expression) &&
        this.databaseMemberOf(this.checker.getResolvedSignature(bare)) === "normalizeId";
      return isNormalizeId ? bare.arguments[0] : undefined;
    }
    if (!ts.isIdentifier(bare) || depth >= 4) return undefined;
    const declaration = this.checker.getSymbolAtLocation(bare)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !isConstDeclaration(declaration)) return undefined;
    return this.tableOfId(declaration.initializer, depth + 1);
  }

  /**
   * Inside an allowed guarded handler the database call must read the table the guard vetted, as DATA FLOW: its
   * table (its own table argument for `query(t)` and the explicit-table `get(t, id)` forms, or the table its id was
   * normalized against) is the `table` the guard returned. No guard output, or an id with no proof, fails.
   */
  private guardVetsCallTable(call: ts.CallExpression, method: string, guards: readonly ts.CallExpression[]): boolean {
    const count = call.arguments.length;
    const hasTableArgument = method === "query" || ((method === "get" || method === "delete") && count === 2) || ((method === "patch" || method === "replace") && count === 3);
    const first = call.arguments[0];
    if (first === undefined) return false;
    const tableExpression = hasTableArgument ? first : this.tableOfId(first);
    return tableExpression !== undefined && this.isGuardTable(tableExpression, guards);
  }

  /** Declared `RegistryLock` parameters of `call`'s callee, with their positions; empty for any other callee. */
  private lockParametersOf(call: ts.CallExpression): LockParameter[] {
    const callee = call.expression;
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : undefined;
    if (!nameNode) return [];
    let symbol = this.checker.getSymbolAtLocation(nameNode);
    if (!symbol) return [];
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    const cached = this.lockParameters.get(symbol);
    if (cached) return cached;
    const found: LockParameter[] = [];
    for (const declaration of symbol.declarations ?? []) {
      functionLikeOf(declaration)?.parameters.forEach((parameter, index) => {
        if (parameter.type?.getText() === "RegistryLock") found.push({ index, typeNode: parameter.type });
      });
    }
    this.lockParameters.set(symbol, found);
    return found;
  }

  /** Is the argument for a `RegistryLock` parameter a real lock rather than one cast or typed into place? */
  private forgedLockArgument(call: ts.CallExpression, parameter: LockParameter): boolean {
    if (call.arguments.some((argument) => ts.isSpreadElement(argument))) return true;
    const argument = call.arguments[parameter.index];
    if (argument === undefined) return false;
    const bare = skipParentheses(argument);
    if (ts.isAsExpression(bare) || ts.isTypeAssertionExpression(bare)) return true;
    const type = this.checker.getTypeAtLocation(argument);
    // `never` is assignable to every type, so a lock laundered through `as never` must not pass either.
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return true;
    return !this.checker.isTypeAssignableTo(type, this.checker.getTypeFromTypeNode(parameter.typeNode));
  }

  scan(sourceFile: ts.SourceFile, relPath: string, used?: Set<string>): Scan {
    const inSupplierModule = SUPPLIER_MODULES.has(relPath);
    const violations: Violation[] = [];
    let supplierWrites = 0;
    const flag = (rule: string, node: ts.Node): void => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push({ rule, line: line + 1, text: node.getText(sourceFile).slice(0, 80) });
    };
    const mintsLock = (node: ts.Node): boolean =>
      relPath === LOCK_MODULE && enclosingFunctionName(node) === "withRegistryLock";

    const visit = (node: ts.Node): void => {
      if (isValueCandidate(node) && this.escapesDatabaseType(node)) flag("db-indirect-call", node);
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (node.type.getText(sourceFile) === "RegistryLock" && !mintsLock(node)) flag("forged-lock", node);
        // `satisfies` is a different node kind and keeps the operand's type, so it is not visited here.
        if (!inSupplierModule && this.castRetypesMasterId(node, relPath)) flag("supplier-id-cast", node);
      }
      if (ts.isCallExpression(node)) {
        if (!mintsLock(node)) {
          for (const parameter of this.lockParametersOf(node)) {
            if (this.forgedLockArgument(node, parameter)) flag("forged-lock", node);
          }
        }
        if (this.isIndirectDatabaseCall(node)) flag("db-indirect-call", node);
        this.scanCall(node, { used, relPath, sourceFile, inSupplierModule, flag, countSupplierWrite: () => (supplierWrites += 1) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { violations, supplierWrites };
  }

  private scanCall(node: ts.CallExpression, context: CallContext): void {
    const { relPath, sourceFile, inSupplierModule, flag } = context;
    const callee = node.expression;
    const first = node.arguments[0];
    // A call is a database call when the checker resolves it into a Convex database interface. A callee that
    // does not resolve at all (an `any` receiver) is treated as one if its name is a database method name.
    const resolved = this.checker.getResolvedSignature(node);
    const declared = this.databaseMethodOf(resolved);
    const written = calleeName(callee);
    const isDatabaseCall = declared !== undefined || (resolved?.declaration === undefined && written !== undefined && DB_METHODS.has(written));
    const method = declared ?? written;
    let facts: TableFacts = { tables: [], unresolved: true };
    // A literal table is trusted syntactically; a table given only by type counts for a database call.
    // `Map.get(supplierId)` and `Set.delete(supplierId)` are not database calls.
    if (method !== undefined && DB_METHODS.has(method) && first !== undefined) {
      if (stringLiteralValue(first) !== undefined || isDatabaseCall) facts = this.tablesOfExpression(first);
    }
    const generic = isDatabaseCall && SCHEMA_TABLES.every((table) => facts.tables.includes(table));
    const touchesNewTable = facts.tables.some((table) => ALL_TABLES.includes(table));

    // An allowed generic function may make this call: its name, the method, and its guard all match.
    // Anything else that touches a supplier table through a type is a violation, in the rule that fits.
    if (isDatabaseCall && method !== undefined && (generic || touchesNewTable)) {
      const allowance = this.allowedGenericCall(node, relPath, method, sourceFile);
      if (allowance && (generic || allowance.allowPartial)) {
        context.used?.add(`${allowance.file}#${allowance.fn}#${method}`);
        return;
      }
    }
    if (generic) {
      flag("generic-table-access", node);
      facts = { tables: [], unresolved: true };
    }
    const isSupplierTable = facts.tables.some((table) => (SUPPLIER_TABLES as readonly string[]).includes(table));
    const touches = facts.tables.some((table) => ALL_TABLES.includes(table));
    const noTable = facts.tables.length === 0;

    if (method === "delete" && (touches || inSupplierModule)) flag("delete", node);
    if (!inSupplierModule && touches && ["insert", "patch", "replace", "query", "get"].includes(method ?? "")) {
      flag("foreign-access", node);
    }
    if (inSupplierModule && method !== undefined && WRITE_METHODS.has(method)) {
      if (noTable) flag("untabled-write", node);
      if (facts.tables.includes(REGISTRY_TABLE) && relPath !== LOCK_MODULE) flag("registry-write-outside-lock-module", node);
    }
    if (isSupplierTable && method !== undefined && WRITE_METHODS.has(method)) {
      context.countSupplierWrite();
      if (!holdsRegistryLock(node)) flag("unlocked-write", node);
    }
    if (ts.isPropertyAccessExpression(callee)) {
      if (inSupplierModule && (method === "filter" || method === "collect") && chainHasQuery(callee.expression)) {
        flag(method === "filter" ? "filter" : "unbounded-collect", node);
      }
      // A sort with no compare function orders by UTF-16 code unit only by accident of the default
      // (Sonar typescript:S2871). The supplier modules say so with `codeUnitCompare`.
      if (inSupplierModule && method === "sort" && node.arguments.length === 0) flag("bare-sort", node);
    }
  }

  private allowedGenericCall(
    node: ts.CallExpression,
    relPath: string,
    method: string,
    sourceFile: ts.SourceFile,
  ): GenericAllowance | undefined {
    const fn = topLevelName(node);
    const entry = GENERIC_ALLOWANCES.find((allowance) => allowance.file === relPath && allowance.fn === fn);
    if (!entry || !entry.methods.includes(method)) return undefined;
    if (entry.guard === undefined) return entry;
    // Only a guard that is a top-level function of this file counts: a nested function of the same name is a shadow.
    const guards = dominatingGuardCalls(node, entry.guard, sourceFile).filter((call) => this.isFileLevelFunction(call.expression));
    return guards.length > 0 && this.guardVetsCallTable(node, method, guards) ? entry : undefined;
  }
}

interface CallContext {
  /** Allowances actually used, as `file#fn#method`; passed for the real tree so a stale entry can be caught. */
  used?: Set<string>;
  relPath: string;
  sourceFile: ts.SourceFile;
  inSupplierModule: boolean;
  flag: (rule: string, node: ts.Node) => void;
  countSupplierWrite: () => number;
}

function listConvexSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated" || entry.name === "node_modules") continue;
      listConvexSources(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const REAL_SOURCES = listConvexSources(path.join(ROOT, "convex")).map((file) => ({
  relPath: path.relative(ROOT, file).split(path.sep).join("/"),
  absPath: file.split(path.sep).join("/"),
}));

// ─── The program: the real convex tree plus the synthetic snippets as virtual files ───────────

/** Every synthetic snippet imports these, so the types a probe names (`Id`, `RegistryLock`) are the real ones. */
const SNIPPET_PRELUDE = [
  `import type { MutationCtx, QueryCtx } from "./_generated/server";`,
  `import type { Id, TableNames } from "./_generated/dataModel";`,
  `import type { RegistryLock } from "./utils/supplierRegistry";`,
  "",
].join("\n");

function virtualSnippetPath(index: number): string {
  return `${ROOT.split(path.sep).join("/")}/convex/__supplierGuardSnippet${index}.ts`;
}

interface Snippet {
  file: string;
  source: string;
  /**
   * Set on the probes added for a review finding: the snippet must compile with no TypeScript error. That is the
   * control that the scanner, and not a typo in the fixture, is what the probe is about.
   */
  typed?: true;
}

function buildScanner(snippets: readonly Snippet[]): { scanner: Scanner; program: ts.Program } {
  const configPath = path.join(ROOT, "convex", "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { noEmit: true },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error("convex/tsconfig.json did not parse");
  const virtualFiles = new Map<string, string>(
    snippets.map((snippet, index) => [virtualSnippetPath(index), SNIPPET_PRELUDE + snippet.source]),
  );
  const host = ts.createCompilerHost(parsed.options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (fileName) => virtualFiles.has(fileName) || fileExists.call(host, fileName);
  host.readFile = (fileName) => virtualFiles.get(fileName) ?? readFile.call(host, fileName);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const virtualText = virtualFiles.get(fileName);
    if (virtualText !== undefined) return ts.createSourceFile(fileName, virtualText, languageVersionOrOptions, true, ts.ScriptKind.TS);
    return getSourceFile.call(host, fileName, languageVersionOrOptions, onError, shouldCreate);
  };
  const program = ts.createProgram({
    rootNames: [...REAL_SOURCES.map((source) => source.absPath), ...virtualFiles.keys()],
    options: parsed.options,
    host,
  });
  return { scanner: new Scanner(program.getTypeChecker()), program };
}

let scannerState: { scanner: Scanner; program: ts.Program; snippets: readonly Snippet[] } | undefined;

/** Built once, on first use: the program is the expensive part. Snippet i is virtual file i. */
function getScanner(): { scanner: Scanner; program: ts.Program; snippets: readonly Snippet[] } {
  if (!scannerState) {
    const snippets: readonly Snippet[] = [...BAD_SNIPPETS, ...GOOD_SNIPPETS, ...ROUND6_PROBES];
    scannerState = { ...buildScanner(snippets), snippets };
  }
  return scannerState;
}

function snippetSourceFile(snippet: Snippet): ts.SourceFile {
  const { program, snippets } = getScanner();
  const index = snippets.indexOf(snippet);
  if (index < 0) throw new Error("snippet is not part of the program");
  const sourceFile = program.getSourceFile(virtualSnippetPath(index));
  if (!sourceFile) throw new Error("virtual snippet file missing from the program");
  return sourceFile;
}

function scanSnippet(snippet: Snippet): Scan {
  return getScanner().scanner.scan(snippetSourceFile(snippet), snippet.file);
}

/** TypeScript's own errors for a snippet: a probe marked `typed` must have none, syntax or type (TS Compiler API: ts.getPreEmitDiagnostics). */
function typeErrors(snippet: Snippet): string[] {
  return ts
    .getPreEmitDiagnostics(getScanner().program, snippetSourceFile(snippet))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

function scanReal(source: { relPath: string; absPath: string }, usedAllowances: Set<string>): Scan {
  const { scanner, program } = getScanner();
  const sourceFile = program.getSourceFile(source.absPath);
  if (!sourceFile) throw new Error(`${source.relPath} is not in the program`);
  return scanner.scan(sourceFile, source.relPath, usedAllowances);
}

/** The adminData guard and id-proof helper, declared so the checker resolves them in a snippet that does not import adminData. */
const ADMIN_STUBS = [
  `declare function assertAdminTable(table: string): { table: TableNames; index: string };`,
  `declare function assertIdBelongsToTable(ctx: MutationCtx, table: TableNames, rawId: string): Id<TableNames>;`,
].join("\n");

const BAD_SNIPPETS: Array<Snippet & { rule: string }> = [
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.patch("suppliers", id, { status: "INACTIVE" }); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.insert("supplierAliases", {}); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: unknown) { await ctx.db.insert("suppliers", {}); }`,
  },
  {
    rule: "untabled-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock) { await ctx.db.patch(id, { status: "INACTIVE" }); }`,
  },
  {
    rule: "delete",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock) { await ctx.db.delete("suppliers", id); }`,
  },
  {
    rule: "delete",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock) { await ctx.db.delete(id); }`,
  },
  {
    rule: "delete",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.delete("suppliers", id); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers").take(1); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.insert("supplierRegistryState", {}); }`,
  },
  {
    rule: "registry-write-outside-lock-module",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { await ctx.db.patch("supplierRegistryState", id, { version: 1 }); }`,
  },
  {
    rule: "filter",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers").filter((q) => q.eq(q.field("status"), "ACTIVE")).take(5); }`,
  },
  {
    rule: "unbounded-collect",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers").withIndex("by_org_and_status", (q) => q.eq("orgId", o)).collect(); }`,
  },
  {
    rule: "bare-sort",
    file: "convex/suppliers.ts",
    source: `export function f(ids: string[]) { return [...ids].sort(); }`,
  },
  {
    rule: "bare-sort",
    file: "convex/utils/supplierRegistry.ts",
    source: `export function f(ids: Set<string>) { return [...ids].sort(); }`,
  },
  {
    rule: "forged-lock",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx) { const lock = {} as RegistryLock; return lock; }`,
  },
  {
    rule: "forged-lock",
    file: "convex/utils/supplierRegistry.ts",
    source: `export async function notTheLock(ctx: MutationCtx) { return {} as RegistryLock; }`,
  },
  // PR 687 Seat 1, M1: the four probes the table-literal scanner could not see. Each one was shown
  // to pass the string-literal-only scanner (red), then to be caught by the type-aware scan.
  // Probe 1: legacy one-argument id form on a supplier id, in another module.
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId, { status: "INACTIVE" }); }`,
  },
  // Probe 2: the legacy replace(id, row) form on an alias id.
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, aliasId: Id<"supplierAliases">, row: never) { await ctx.db.replace(aliasId, row); }`,
  },
  // Probe 3: a variable table whose type includes a supplier table.
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, tableVar: "suppliers" | "vehicles") { await ctx.db.insert(tableVar, {} as never); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, tableVar: "suppliers" | "vehicles") { await ctx.db.insert(tableVar, {} as never); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId, { status: "INACTIVE" }); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { return await ctx.db.get(supplierId); }`,
  },
  {
    rule: "delete",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.delete(supplierId); }`,
  },
  // Round 2 (PR 687 Seat 2): database calls the syntactic `<expr>.patch(` match could not see, and
  // generic helpers that hide the table behind a type parameter. Each was zero violations before.
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db["patch"](supplierId, { status: "INACTIVE" }); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { const { patch } = ctx.db; await patch(supplierId, { status: "INACTIVE" }); }`,
  },
  {
    rule: "unlocked-write",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { const { patch } = ctx.db; await patch(supplierId, { status: "INACTIVE" }); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { const p = ctx.db.patch.bind(ctx.db); await p(supplierId, { status: "INACTIVE" }); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch.call(ctx.db, supplierId, { status: "INACTIVE" }); }`,
  },
  {
    rule: "generic-table-access",
    file: "convex/other.ts",
    source: `export async function patchRow<T extends TableNames>(ctx: MutationCtx, id: Id<T>, value: never) { await ctx.db.patch(id, value); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/other.ts",
    source: `export async function patchOwned<T extends "suppliers" | "vehicles">(ctx: MutationCtx, id: Id<T>, value: never) { await ctx.db.patch(id, value); }`,
  },
  // The exemption is per function, not per module. A generic call elsewhere in adminData/adminOrgs is refused,
  // and so is an allowlisted function that lacks its guard.
  {
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `export async function sneaky(ctx: MutationCtx, id: Id<TableNames>) { await ctx.db.delete(id); }`,
  },
  {
    rule: "generic-table-access",
    file: "convex/adminOrgs.ts",
    source: `export async function sneaky(ctx: MutationCtx, id: Id<TableNames>) { await ctx.db.delete(id); }`,
  },
  {
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `export async function adminUpdateRecord(ctx: MutationCtx, id: Id<TableNames>) { await ctx.db.patch(id, {} as never); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/adminData.ts",
    source: `export async function adminUpdateRecord(ctx: MutationCtx, id: Id<"suppliers">) { assertAdminTable("vehicles"); await ctx.db.patch(id, {} as never); }`,
  },
  {
    rule: "foreign-access",
    file: "convex/adminOrgs.ts",
    source: `export async function deleteRowsByOrgBatch(ctx: MutationCtx, id: Id<"suppliers">) { await ctx.db.patch(id, {} as never); }`,
  },
  // A table typed as every table names no table in particular. Outside the generic functions it is refused.
  {
    rule: "generic-table-access",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, id: Id<TableNames>) { await ctx.db.delete(id); }`,
  },
  {
    rule: "generic-table-access",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock, table: TableNames) { return ctx.db.query(table).take(1); }`,
  },
  // Probe 4: a lock forged with a cast other than "as RegistryLock", or typed any, or with the
  // type error suppressed, passed to a helper that takes a RegistryLock.
  {
    rule: "forged-lock",
    file: "convex/other.ts",
    source: `
      import { insertSupplier } from "./utils/supplierRegistry";
      export async function f(ctx: MutationCtx, row: never) { await insertSupplier(ctx, {} as any, row); }`,
  },
  {
    rule: "forged-lock",
    file: "convex/suppliers.ts",
    source: `
      import { insertSupplier } from "./utils/supplierRegistry";
      export async function f(ctx: MutationCtx, row: never) { await insertSupplier(ctx, {} as unknown as never, row); }`,
  },
  {
    rule: "forged-lock",
    file: "convex/other.ts",
    source: `
      import { patchSupplierAlias } from "./utils/supplierRegistry";
      export async function f(ctx: MutationCtx, anyLock: any, alias: never) { await patchSupplierAlias(ctx, anyLock, alias, {}); }`,
  },
  {
    rule: "forged-lock",
    file: "convex/other.ts",
    source: `
      import { insertSupplier } from "./utils/supplierRegistry";
      export async function f(ctx: MutationCtx, row: never) {
        // @ts-expect-error a plain object is not a RegistryLock
        await insertSupplier(ctx, {}, row);
      }`,
  },
  // SCRUM-871 L6: reflective calls that reach a database method without being `.bind`, `.call` or `.apply`
  // on it, and casts that retype a supplier id so the table is no longer visible. Each was zero violations
  // before the scan learned the rule (red-871.txt).
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await Reflect.apply(ctx.db.patch, ctx.db, [supplierId, { status: "INACTIVE" }]); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock, supplierId: Id<"suppliers">) { await Reflect.apply(ctx.db.patch, ctx.db, [supplierId, { status: "INACTIVE" }]); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { const fn = ctx.db.patch; await Reflect.apply(fn, ctx.db, [supplierId, {}]); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { const p = Reflect.get(ctx.db, "patch"); await p(supplierId, {}); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await Function.prototype.call.call(ctx.db.patch, ctx.db, supplierId, {}); }`,
  },
  {
    rule: "db-indirect-call",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await Function.prototype.apply.call(ctx.db.patch, ctx.db, [supplierId, {}]); }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId as any, { status: "INACTIVE" }); }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId as unknown as Id<"vehicles">, {}); }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(<any>supplierId, {}); }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, aliasId: Id<"supplierAliases">) { return await ctx.db.get(aliasId as Id<"vehicles">); }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, registryId: Id<"supplierRegistryState">) { await ctx.db.patch(registryId as never, {}); }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/adminData.ts",
    source: `export async function f(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId as any, {}); }`,
  },
  {
    // The every-table id can be a supplier id; only the exact allowance functions may cast it.
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, anyRow: Id<TableNames>) { await ctx.db.patch(anyRow as any, {}); }`,
  },
  {
    // Inside an allowance function the every-table id may be narrowed to one ordinary table, not to `any`.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    source: `export async function deleteRowsByOrgBatch(ctx: MutationCtx, rows: Array<{ _id: Id<TableNames> }>) { for (const row of rows) { await ctx.db.delete(row._id as any); } }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    source: `export async function deleteRowsByOrgBatch(ctx: MutationCtx, rows: Array<{ _id: Id<TableNames> }>) { for (const row of rows) { await ctx.db.delete(row._id as Id<"suppliers">); } }`,
  },
  {
    // Inside an allowance function, a cast of a value that is specifically a supplier id is still refused.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    source: `export async function deleteRowsByOrgBatch(ctx: MutationCtx, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId as any, {}); }`,
  },
  {
    // The same retyping with the table NAME: the literal's type is a supplier table until it is cast away.
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    source: `export async function f(ctx: QueryCtx) { return ctx.db.query("suppliers" as any).take(1); }`,
  },
  // SCRUM-871 L7: inside an allowed adminData handler the table the guard vets must be the table the id was
  // normalized against. Each of these has a guard call that dominates the database call and still must fail.
  {
    // A constant guard, and an id normalized against an unrelated table variable.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminUpdateRecord = async (ctx: MutationCtx, table: TableNames, raw: string) => {
        assertAdminTable("vehicles");
        const id = ctx.db.normalizeId(table, raw);
        if (!id) return;
        await ctx.db.patch(id, {} as never);
      };`,
  },
  {
    // No normalizeId at all: the id is whatever the caller passed.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminGetRecord = async (ctx: MutationCtx, args: { table: string }, id: Id<TableNames>) => {
        assertAdminTable(args.table);
        return await ctx.db.get(id);
      };`,
  },
  {
    // A constant guard and no id proof, with the destructured table never used.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminHardDelete = async (ctx: MutationCtx, id: Id<TableNames>) => {
        const { table } = assertAdminTable("vehicles");
        await ctx.db.delete(id);
      };`,
  },
  {
    // The helper form: the id is proved against a table that is not the one the guard vetted.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminUpdateRecord = async (ctx: MutationCtx, args: { table: string; id: string }, other: TableNames) => {
        const { table } = assertAdminTable(args.table);
        const id = assertIdBelongsToTable(ctx, other, args.id);
        await ctx.db.patch(id, {} as never);
      };`,
  },
  {
    // The restore loop form, normalizing against a different argument than the guard vetted.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminRestoreRecords = async (ctx: MutationCtx, args: { table: string; other: string; ids: string[] }) => {
        assertAdminTable(args.table);
        for (const rawId of args.ids) {
          const id = ctx.db.normalizeId(args.other as TableNames, rawId);
          if (!id) continue;
          await ctx.db.patch(id, {} as never);
        }
      };`,
  },
  {
    // The list form: the guard vets a constant, the query reads the caller's table.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminListByOrg = async (ctx: QueryCtx, args: { table: string }) => {
        assertAdminTable("vehicles");
        return ctx.db.query(args.table as TableNames).take(1);
      };`,
  },
  {
    // The destructured name is the index, not the table, so it is not the vetted expression.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminGetRecord = async (ctx: MutationCtx, args: { table: string }, raw: string) => {
        const { index: table } = assertAdminTable(args.table);
        const id = ctx.db.normalizeId(table as TableNames, raw);
        if (!id) return;
        return await ctx.db.get(id);
      };`,
  },
  {
    // A reassigned id is not the normalized id.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminHardDelete = async (ctx: MutationCtx, args: { table: string }, raw: string, forged: Id<TableNames>) => {
        assertAdminTable(args.table);
        let id = ctx.db.normalizeId(args.table as TableNames, raw);
        id = forged;
        await ctx.db.delete(id);
      };`,
  },
  // PR 689 round 2. Every probe below compiles with no TypeScript error (`typed`), and was zero violations
  // against 8e16ebe0. L7 is by data flow: the table a generic call uses must be `table` from
  // `const { table } = assertAdminTable(x)`, the guard's own return value, and the id must be bound to a const
  // from normalizeId / assertIdBelongsToTable of that table. Mutating `args`, reassigning, shadowing a key or
  // a helper then changes nothing the scan relies on.
  {
    // Seat 2 #1: the vetted value is mutated between the guard and the use.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { table: TableNames }, other: TableNames, raw: string) {
        assertAdminTable(args.table);
        args.table = other;
        const id = ctx.db.normalizeId(args.table, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // Seat 1 M2: the same through a second field of args.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { table: TableNames; other: TableNames }, raw: string) {
        assertAdminTable(args.table);
        args.table = args.other;
        const id = ctx.db.normalizeId(args.table, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // Seat 1 M2: a reassigned parameter.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, name: string, other: TableNames, raw: string) {
        assertAdminTable(name);
        name = other;
        const id = ctx.db.normalizeId(name as TableNames, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // Seat 1 M2: a reassigned let.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, name: string, other: TableNames, raw: string) {
        let t: string = name;
        assertAdminTable(t);
        t = other;
        const id = ctx.db.normalizeId(t as TableNames, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // Seat 1 M2: Object.assign mutates args through a call.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { table: TableNames }, other: TableNames, raw: string) {
        assertAdminTable(args.table);
        Object.assign(args, { table: other });
        const id = ctx.db.normalizeId(args.table, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // Seat 2 #2: a computed key shadowed in an inner block.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { safe: TableNames; evil: TableNames }, raw: string) {
        const key = "safe";
        assertAdminTable(args[key]);
        {
          const key = "evil";
          const id = ctx.db.normalizeId(args[key], raw);
          if (id) await ctx.db.delete(id);
        }
      }`,
  },
  {
    // The destructured table is a let, so it can be reassigned after the guard.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, name: string, other: TableNames, raw: string) {
        let { table } = assertAdminTable(name);
        table = other;
        const id = ctx.db.normalizeId(table, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // A bare guard and an identical expression: the old accepted shape, refused by design now.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { table: TableNames }, raw: string) {
        assertAdminTable(args.table);
        const id = ctx.db.normalizeId(args.table, raw);
        if (id) await ctx.db.delete(id);
      }`,
  },
  {
    // Seat 1 LOW: the helper is shadowed by a nested function that proves nothing.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { table: string; id: string }) {
        function assertIdBelongsToTable(_ctx: MutationCtx, _table: TableNames, rawId: string): Id<TableNames> { return rawId as Id<TableNames>; }
        const { table } = assertAdminTable(args.table);
        await ctx.db.delete(assertIdBelongsToTable(ctx, table, args.id));
      }`,
  },
  {
    // Seat 1 LOW: the guard is shadowed by a nested function that vets nothing.
    rule: "generic-table-access",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminHardDelete(ctx: MutationCtx, args: { table: string; id: string }) {
        function assertAdminTable(table: string): { table: TableNames; index: string } { return { table: table as TableNames, index: "" }; }
        const { table } = assertAdminTable(args.table);
        const id = ctx.db.normalizeId(table, args.id);
        if (id) await ctx.db.delete(id);
      }`,
  },
  // Seat 1 M1: a cast that retypes the every-table id skipped L7 by making the call non-generic. The cast
  // exemption is now only adminOrgs.ts#deleteRowsByOrgBatch, only to the one table that a dominating
  // `table === "<that table>"` check on the function's own `table` parameter names.
  {
    rule: "supplier-id-cast",
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export async function adminUpdateRecord(ctx: MutationCtx, args: { table: string; other: TableNames; id: string }) {
        assertAdminTable(args.table);
        const id = ctx.db.normalizeId(args.other, args.id);
        if (!id) return;
        await ctx.db.patch(id as Id<"vehicles">, {} as never);
      }`,
  },
  {
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, rows: Array<{ _id: Id<TableNames> }>) {
        for (const row of rows) { await ctx.db.patch(row._id as Id<"vehicles">, {} as never); }
      }`,
  },
  {
    // A check of a different table than the cast target.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, rows: Array<{ _id: Id<TableNames> }>) {
        for (const row of rows) { if (table === "payrollItems") await ctx.db.patch(row._id as Id<"vehicles">, {} as never); }
      }`,
  },
  {
    // The check holds in the else branch, not where the cast is.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, rows: Array<{ _id: Id<TableNames> }>) {
        for (const row of rows) { if (table === "vehicles") { await ctx.db.delete(row._id); } else { await ctx.db.patch(row._id as Id<"vehicles">, {} as never); } }
      }`,
  },
  {
    // The compared name is not the function's own table parameter.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, rows: Array<{ _id: Id<TableNames> }>, kind: string) {
        for (const row of rows) { if (kind === "vehicles") await ctx.db.patch(row._id as Id<"vehicles">, {} as never); }
      }`,
  },
  {
    // Array casts: the element type is a supplier id.
    rule: "supplier-id-cast",
    file: "convex/other.ts",
    typed: true,
    source: `export function f(ids: Id<"suppliers">[], readonlyIds: readonly Id<"supplierAliases">[]) { return [ids as unknown as Id<"vehicles">[], readonlyIds as unknown as string[]]; }`,
  },
  // Escapes of the database that no earlier rule saw. A database value (or one of its methods) that flows into a
  // position whose declared type is not itself a Convex database type is refused: the declared type is what the
  // checker would use to recognise the later call.
  {
    // Seat 2 #3: an ordinary annotation replaces the Convex signature.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) {
        const p: (id: Id<"suppliers">, value: {}) => Promise<void> = ctx.db.patch;
        await Reflect.apply(p, undefined, [id, {}]);
      }`,
  },
  {
    // Seat 1: a structurally typed assignment of ctx.db.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) {
        const w: { patch(id: Id<"suppliers">, value: {}): Promise<void> } = ctx.db;
        await w.patch(id, {});
      }`,
  },
  {
    // Seat 1: ctx.db passed to a structurally typed parameter.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      function use(db: { patch(id: Id<"suppliers">, value: {}): Promise<void> }, id: Id<"suppliers">) { return db.patch(id, {}); }
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await use(ctx.db, id); }`,
  },
  {
    // Seat 1: a user-written invoke helper.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      function invoke(fn: (...args: any[]) => unknown, ...args: unknown[]) { return fn(...args); }
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await invoke(ctx.db.patch, id, {}); }`,
  },
  {
    // Seat 1: a property descriptor read off the database.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await Object.getOwnPropertyDescriptor(ctx.db, "patch")!.value(id, {}); }`,
  },
  {
    // Seat 1: Reflect.get handed to Reflect.apply.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { const p = Reflect.apply(Reflect.get, undefined, [ctx.db, "patch"]); await p(id, {}); }`,
  },
  {
    // The database cast to any and called.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await (ctx.db as any).patch(id, {}); }`,
  },
  {
    // A database stored as a WeakMap VALUE can be read back, unlike a key, so the key exemption does not cover it.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `const memo = new WeakMap<object, any>();
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) { memo.set(memo, ctx.db); await memo.get(memo).patch(id, {}); }`,
  },
  // PR 689 round 3. The destination is read at the end of the chain of transparent wrappers, not beside the name.
  {
    // Seat 2 #1: a parenthesised method into a typed alias, then Reflect.apply.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) {
        const p: (id: Id<"suppliers">, value: {}) => Promise<void> = (ctx.db.patch);
        await Reflect.apply(p, undefined, [id, {}]);
      }`,
  },
  {
    // Seat 2 #1: the same with a non-null assertion.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      export async function f(ctx: MutationCtx, id: Id<"suppliers">) {
        const p: (id: Id<"suppliers">, value: {}) => Promise<void> = ctx.db.patch!;
        await Reflect.apply(p, undefined, [id, {}]);
      }`,
  },
  {
    // `satisfies` keeps the operand's type, so the destination is the variable's.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const w: Patcher = ctx.db satisfies unknown; return w; }`,
  },
  {
    // Seat 1 N-a: a parenthesised database.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const w: Patcher = (ctx.db); return w; }`,
  },
  {
    // Seat 1 N-a: both branches of a conditional.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx, flag: boolean) { const w: Patcher = flag ? ctx.db : ctx.db; return w; }`,
  },
  {
    // `??` hands its right side on.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx, maybe: Patcher | undefined) { const w: Patcher = maybe ?? ctx.db; return w; }`,
  },
  {
    // `||` hands either side on.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx, maybe: Patcher | undefined) { const w: Patcher = maybe || ctx.db; return w; }`,
  },
  {
    // Seat 1 N-a: the shorthand property `{ db }` into `{ db: Patcher }`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const db = ctx.db; const holder: { db: Patcher } = { db }; return holder; }`,
  },
  {
    // Seat 1 N-a: a default parameter value.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx, w: Patcher = ctx.db) { return w; }`,
  },
  {
    // Seat 1 N-a: a tuple spread into a parameter.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      declare function use(w: Patcher): void;
      export function f(ctx: MutationCtx) { const dbs: [typeof ctx.db] = [ctx.db]; use(...dbs); }`,
  },
  {
    // An array spread into an array literal that is declared as structural.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const dbs = [ctx.db]; const all: Patcher[] = [...dbs]; return all; }`,
  },
  {
    // Seat 1 N-b: the container, a ctx, handed to a structural parameter.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(c: { db: { patch(id: string, value: object): Promise<void> } }): void;
      export function f(ctx: MutationCtx) { use(ctx); }`,
  },
  {
    // Seat 1 N-b: destructured into an annotated structural type.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const { db }: { db: Patcher } = ctx; return db; }`,
  },
  {
    // The container into a parameter whose `db` is `any`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(c: { db: any }): void;
      export function f(ctx: MutationCtx) { use(ctx); }`,
  },
  {
    // The container cast to `any` and used.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await (ctx as any).db.patch(id, {}); }`,
  },
  {
    // The container held in an `any` variable.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { const c: any = ctx; await c.db.patch(id, {}); }`,
  },
  {
    // Seat 2 #2: a nested arrow with its own parameter spelled `table`, inside the purge runner.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, id: Id<TableNames>) {
        const run = async (table: string) => { if (table === "vehicles") { await ctx.db.delete(id as Id<"vehicles">); } };
        await run("vehicles");
      }`,
  },
  {
    // Seat 1 N-c: an immediately invoked arrow with its own `table`.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, id: Id<TableNames>) {
        await ((table: string) => table === "vehicles" && ctx.db.patch(id as Id<"vehicles">, {} as never))("vehicles");
      }`,
  },
  {
    // The runner's own check, but the cast sits in a function nested below it.
    rule: "supplier-id-cast",
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, id: Id<TableNames>) {
        if (table === "vehicles") {
          const run = async () => { await ctx.db.delete(id as Id<"vehicles">); };
          await run();
        }
      }`,
  },
  // PR 689 round 4. A union destination keeps the database only when every member does.
  {
    // Seat 2: a Convex view unioned with a foreign Patcher, narrowed with `in`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      type View = Pick<QueryCtx["db"], "get"> | Patcher;
      async function use(db: View, id: Id<"suppliers">) { if ("patch" in db) await db.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx.db, id); }`,
  },
  {
    // Seat 1: the Convex writer unioned with a fake that has its own discriminant.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Fake = { patch(id: string, value: object): Promise<void>; kind: "fake" };
      async function use(db: MutationCtx["db"] | Fake, id: string) { if ("kind" in db) await db.patch(id, {}); }
      export function f(ctx: MutationCtx, id: string) { return use(ctx.db, id); }`,
  },
  {
    // The same union reached through a variable annotation.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const w: QueryCtx["db"] | Patcher = ctx.db; return w; }`,
  },
  {
    // `await` hands its operand on: a database awaited into a structural holder.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export async function f(ctx: MutationCtx) { const w: Patcher = await ctx.db; return w; }`,
  },
  // PR 689 round 5. One rule: a database value reaches only destinations all of whose members (after dropping
  // null/undefined/void/optional) are Convex database types, at every property, union member, tuple and rest position.
  {
    // Seat 1 M1: a holder whose `db` is a Convex view unioned with a foreign Patcher.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(c: { db: Pick<QueryCtx["db"], "get"> | Patcher }, id: Id<"suppliers">) { const d = c.db; if ("patch" in d) await d.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx, id); }`,
  },
  {
    // Seat 1 M1: a holder whose `db` is the Convex reader unioned with a Patcher.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(c: { db: QueryCtx["db"] | Patcher }, id: Id<"suppliers">) { if ("patch" in c.db) await c.db.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx, id); }`,
  },
  {
    // Seat 1 M1, Seat 2 #2: an optional structural `db`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(c: { db?: Patcher }, id: Id<"suppliers">) { await c.db?.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx, id); }`,
  },
  {
    // Seat 1 M1, Seat 2 #2: a nullable structural `db`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(c: { db: Patcher | null }, id: Id<"suppliers">) { await c.db?.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx, id); }`,
  },
  {
    // Seat 2 #2: optional and nullable together.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(c: { db?: Patcher | null }, id: Id<"suppliers">) { await c.db?.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx, id); }`,
  },
  {
    // Class: the whole holder optional, a union property inside it.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(c: { db: QueryCtx["db"] | Patcher } | undefined, id: Id<"suppliers">) { if (c && "patch" in c.db) await c.db.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { return use(ctx, id); }`,
  },
  {
    // Class: a holder of a holder (depth 2), the value an object that carries a ctx.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(h: { inner: { db: Patcher } }, id: Id<"suppliers">) { await h.inner.db.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { const h = { inner: ctx }; return use(h, id); }`,
  },
  {
    // Class: depth 2 with an optional holder and a nullable property at the inner level.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(h: { inner?: { db: Patcher | undefined } }, id: Id<"suppliers">) { await h.inner?.db?.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { const h = { inner: ctx }; return use(h, id); }`,
  },
  {
    // Class: a holder under another name, reached through a variable.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(h: { database: Patcher }, id: Id<"suppliers">) { await h.database.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) { const h = { database: ctx.db }; return use(h, id); }`,
  },
  {
    // Class: an array of databases handed to an array destination that is foreign.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const dbs: MutationCtx["db"][] = [ctx.db]; const all: Patcher[] = dbs; return all; }`,
  },
  {
    // Seat 2 #1: two spreads before the database, the second tuple's element lands in the Patcher parameter.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(a: QueryCtx["db"], b: QueryCtx["db"], db: Patcher, id: Id<"suppliers">) { await db.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) {
        const a: [QueryCtx["db"], QueryCtx["db"]] = [ctx.db, ctx.db];
        const b: [MutationCtx["db"]] = [ctx.db];
        return use(...a, ...b, id);
      }`,
  },
  {
    // Seat 2 #1: a tuple rest element is compared with every parameter it can reach, not only the first.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      declare function use(n: number, first?: QueryCtx["db"], ...others: Patcher[]): void;
      export function f(ctx: MutationCtx) { const args: [number, ...MutationCtx["db"][]] = [1, ctx.db]; use(...args); }`,
  },
  {
    // Seat 1 L-a: an earlier spread's length shifts the position of the next one.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      async function use(n: number, a: QueryCtx["db"], w: Patcher, id: Id<"suppliers">) { await w.patch(id, {}); }
      export function f(ctx: MutationCtx, id: Id<"suppliers">) {
        const pre: [number, MutationCtx["db"]] = [1, ctx.db];
        const dbs: [MutationCtx["db"]] = [ctx.db];
        return use(...pre, ...dbs, id);
      }`,
  },
  {
    // Class: a plain argument after a spread lands at the expanded position, not at its node index.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      declare function use(a: QueryCtx["db"], b: QueryCtx["db"], w: Patcher): void;
      export function f(ctx: MutationCtx) { const two: [QueryCtx["db"], QueryCtx["db"]] = [ctx.db, ctx.db]; use(...two, ctx.db); }`,
  },
  {
    // Class: a spread after a variable-length array can land in the trailing Patcher of a leading-rest tuple.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      declare function use(...rest: [...number[], Patcher]): void;
      export function f(ctx: MutationCtx, nums: number[]) { const one: [MutationCtx["db"]] = [ctx.db]; use(...nums, ...one); }`,
  },
  {
    // Class: a variable-length array of databases before more arguments.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      declare function use(...rest: Patcher[]): void;
      export function f(ctx: MutationCtx) { const dbs: MutationCtx["db"][] = [ctx.db]; use(...dbs, ctx.db); }`,
  },
  {
    // Class: the database handed to a callee typed `any` (type unknowable: fail closed).
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export function f(ctx: MutationCtx, fn: any) { fn(ctx.db); }`,
  },
  {
    // Class: a holder handed to `unknown` (nothing to compare with: fail closed), and one handed to `{}`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(c: unknown): void;
      declare function other(c: {}): void;
      export function f(ctx: MutationCtx) { use(ctx); other(ctx); }`,
  },
  {
    // Class: an array of databases handed to `unknown`, and a holder inside an `object` property.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(c: { dbs: unknown }): void;
      export function f(ctx: MutationCtx) { const dbs: MutationCtx["db"][] = [ctx.db]; use({ dbs }); }`,
  },
  {
    // Class: a spread of databases into a callee typed `any`.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `export function f(ctx: MutationCtx, fn: any) { const dbs: MutationCtx["db"][] = [ctx.db]; fn(...dbs); }`,
  },
  {
    // Class: a spread of databases into a callee whose rest parameter is a union with a Patcher member.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      declare function use(...rest: (QueryCtx["db"] | Patcher)[]): void;
      export function f(ctx: MutationCtx) { const one: [MutationCtx["db"]] = [ctx.db]; use(...one); }`,
  },
  {
    // Class: a spread of databases into an array literal whose declared tuple has a foreign second position.
    rule: "db-indirect-call",
    file: "convex/other.ts",
    typed: true,
    source: `
      type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
      export function f(ctx: MutationCtx) { const one: [MutationCtx["db"]] = [ctx.db]; const out: [QueryCtx["db"], Patcher] = [ctx.db, ...one]; return out; }`,
  },];

const GOOD_SNIPPETS: Snippet[] = [
  {
    file: "convex/suppliers.ts",
    source: `
      async function insertSupplier(ctx: MutationCtx, lock: RegistryLock) { return ctx.db.insert("suppliers", {}); }
      export async function g(ctx: MutationCtx, lock: RegistryLock, ids: Id<"supplierAliases">[]) {
        await Promise.all(ids.map(async (id) => ctx.db.patch("supplierAliases", id, { status: "RETIRED" })));
        return [1, 2].filter((n) => n > 1);
      }`,
  },
  {
    file: "convex/utils/supplierRegistry.ts",
    source: `
      export async function withRegistryLock<T>(ctx: MutationCtx, fn: (lock: RegistryLock) => Promise<T>) {
        const lock = { __brand: "RegistryLock" } as RegistryLock;
        await ctx.db.patch("supplierRegistryState", id, { version: 1 });
        return fn(lock);
      }`,
  },
  { file: "convex/other.ts", source: `export const x = (ctx: QueryCtx) => ctx.db.query("vehicles").take(1);` },
  { file: "convex/suppliers.ts", source: `export const s = (ids: string[]) => [...ids].sort(codeUnitCompare);` },
  { file: "convex/other.ts", source: `export const s = (ids: string[]) => [...ids].sort();` },
  // Type-aware good cases: the same shapes as the probes, but legitimate.
  // The adminData handler shapes of the real tree. The guard's argument must be the table the id was
  // normalized against (SCRUM-871 L7), so these two replace the earlier good snippets that took a bare
  // `id: Id<TableNames>` parameter with no normalizeId: that shape is now the bad probe "no normalizeId".
  {
    // Destructured table from the guard, the id proved by the helper, then get, patch and delete.
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminUpdateRecord = async (ctx: MutationCtx, args: { table: string; id: string }) => {
        const { table } = assertAdminTable(args.table);
        const id = assertIdBelongsToTable(ctx, table, args.id);
        const before = await ctx.db.get(id);
        await ctx.db.patch(id, {} as never);
        return before;
      };`,
  },
  {
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminHardDelete = async (ctx: MutationCtx, args: { table: string; id: string }) => {
        const { table } = assertAdminTable(args.table);
        const id = assertIdBelongsToTable(ctx, table, args.id);
        await ctx.db.get(id);
        await ctx.db.delete(id);
      };`,
  },
  {
    // A cast of the every-table id inside an exact allowance function is a narrowing, not a laundering.
    file: "convex/adminOrgs.ts",
    source: `
      declare function use(id: Id<"payrollItems">): void;
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, rows: Array<{ _id: Id<TableNames> }>) {
        for (const row of rows) { if (table === "payrollItems") use(row._id as Id<"payrollItems">); await ctx.db.delete(row._id); }
      }`,
  },
  {
    // The helper call written inline as the argument.
    file: "convex/adminData.ts",
    source: `
      ${ADMIN_STUBS}
      export const adminGetRecord = async (ctx: MutationCtx, args: { table: string; id: string }) => {
        const { table } = assertAdminTable(args.table);
        return await ctx.db.get(assertIdBelongsToTable(ctx, table, args.id));
      };`,
  },
  {
    // The restore loop: the table is the guard's own output, normalizeId runs against it inside the loop.
    // Twin of the BAD probes that use `args.table` after a bare guard (round 2: mutation, shadowing).
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export const adminRestoreRecords = async (ctx: MutationCtx, args: { table: string; ids: string[] }) => {
        const { table } = assertAdminTable(args.table);
        for (const rawId of args.ids) {
          const id = ctx.db.normalizeId(table, rawId);
          if (!id) continue;
          await ctx.db.get(id);
          await ctx.db.patch(id, {} as never);
        }
      };`,
  },
  {
    // The list: the query reads the guard's own `table`.
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export const adminListByOrg = async (ctx: QueryCtx, args: { table: string }) => {
        const { table, index } = assertAdminTable(args.table);
        return ctx.db.query(table).withIndex(index as never).take(1);
      };`,
  },
  {
    // The guard's output through parentheses and `!` is still the guard's output.
    file: "convex/adminData.ts",
    typed: true,
    source: `
      ${ADMIN_STUBS}
      export const adminHardDelete = async (ctx: MutationCtx, name: string, raw: string) => {
        const { table } = assertAdminTable(name);
        const id = ctx.db.normalizeId((table!), raw);
        if (!id) return;
        await ctx.db.delete(id);
      };`,
  },
  {
    // The cast exemption, second real shape: the table check is a conjunct before the cast.
    file: "convex/adminOrgs.ts",
    typed: true,
    source: `
      declare function use(id: Id<"payrollItems">): Promise<boolean>;
      export async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames, rows: Array<{ _id: Id<TableNames> }>) {
        for (const row of rows) { if (table === "payrollItems" && !await use(row._id as Id<"payrollItems">)) break; await ctx.db.delete(row._id); }
      }`,
  },
  {
    // A database handle used as a WeakMap key can be neither read back nor called (convex/utils/depositCancellationPending.ts).
    file: "convex/other.ts",
    typed: true,
    source: `
      const memo = new WeakMap<object, number>();
      export function f(ctx: QueryCtx) { memo.set(ctx.db, 1); return memo.get(ctx.db); }`,
  },
  {
    // A database passed on typed as a Convex database stays a database.
    file: "convex/other.ts",
    typed: true,
    source: `
      import type { DatabaseReader } from "./_generated/server";
      declare function readOnly(db: DatabaseReader): void;
      export function f(ctx: QueryCtx) { readOnly(ctx.db); const db = ctx.db; return db.query("vehicles").take(1); }`,
  },
  // SCRUM-871 L6, the matching good cases.
  {
    // `satisfies` keeps the operand's type; it launders nothing.
    file: "convex/other.ts",
    source: `export function f(supplierId: Id<"suppliers">) { const same = supplierId satisfies Id<"suppliers">; return same; }`,
  },
  {
    // A cast of an id that is not a supplier table's.
    file: "convex/other.ts",
    source: `export function f(vehicleId: Id<"vehicles">) { return vehicleId as unknown as string; }`,
  },
  {
    // The supplier modules own the tables, so a cast inside them is read by the lock and untabled-write rules instead.
    file: "convex/suppliers.ts",
    source: `export function f(supplierId: Id<"suppliers">) { return supplierId as string; }`,
  },
  {
    // Reflect and Function.prototype on things that are not the database.
    file: "convex/other.ts",
    source: `export function f(values: number[]) { return Reflect.apply(Math.max, undefined, values) + Function.prototype.call.call(Math.min, undefined, 1, 2); }`,
  },
  {
    file: "convex/other.ts",
    source: `export function f(read: (n: number) => number) { const bound = read.bind(undefined); return bound(1) + Reflect.ownKeys({ a: 1 }).length; }`,
  },
  {
    file: "convex/adminOrgs.ts",
    source: `async function deleteRowsByOrgBatch(ctx: MutationCtx, table: TableNames) { return ctx.db.query(table).take(1); }`,
  },
  {
    file: "convex/utils/tenancy.ts",
    source: `export async function requireOwnedRow<T extends "suppliers" | "vehicles">(ctx: QueryCtx, id: Id<T>) { return await ctx.db.get(id); }`,
  },
  {
    file: "convex/suppliers.ts",
    source: `export async function f(ctx: MutationCtx, lock: RegistryLock, supplierId: Id<"suppliers">) { await ctx.db.patch(supplierId, { status: "INACTIVE" }); }`,
  },
  {
    file: "convex/other.ts",
    source: `export async function f(ctx: MutationCtx, vehicleId: Id<"vehicles">) { await ctx.db.patch(vehicleId, {}); return await ctx.db.get(vehicleId); }`,
  },
  {
    // Map and Set methods named get/delete take a supplier id without being database calls.
    file: "convex/other.ts",
    source: `export function f(byId: Map<Id<"suppliers">, number>, seen: Set<Id<"suppliers">>, id: Id<"suppliers">) { seen.delete(id); return byId.get(id); }`,
  },
  {
    file: "convex/other.ts",
    source: `
      import { withRegistryLock, insertSupplier } from "./utils/supplierRegistry";
      export async function f(ctx: MutationCtx, orgId: Id<"organizations">, row: never) {
        return withRegistryLock(ctx, orgId, async (lock) => insertSupplier(ctx, lock, row));
      }`,
  },
  // PR 689 round 3, the matching good cases.
  {
    // Seat 1 N-d, Seat 2: a Pick view keeps the Convex declaration of its method.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function read(db: Pick<QueryCtx["db"], "get">, id: Id<"vehicles">): unknown;
      export function f(ctx: QueryCtx, id: Id<"vehicles">) { return read(ctx.db, id); }`,
  },
  {
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function write(db: Pick<MutationCtx["db"], "patch">, id: Id<"vehicles">): unknown;
      export function f(ctx: MutationCtx, id: Id<"vehicles">) { return write(ctx.db, id); }`,
  },
  {
    // Parentheses, branches and defaults whose destination is a Convex database type.
    file: "convex/other.ts",
    typed: true,
    source: `
      export function f(ctx: QueryCtx, other: QueryCtx["db"], flag: boolean, w: QueryCtx["db"] = ctx.db) {
        const a: QueryCtx["db"] = (ctx.db);
        const b: QueryCtx["db"] = flag ? ctx.db : other;
        const c: QueryCtx["db"] = other ?? ctx.db;
        const d: QueryCtx["db"] = ctx.db!;
        return [a, b, c, d, w];
      }`,
  },
  {
    // Shorthand and spread whose destination is a Convex database type.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(w: QueryCtx["db"]): void;
      export function f(ctx: QueryCtx) {
        const db = ctx.db;
        const holder: { db: QueryCtx["db"] } = { db };
        const dbs: [typeof ctx.db] = [ctx.db];
        use(...dbs);
        return holder;
      }`,
  },
  {
    // The shape assertIdBelongsToTable has: a ctx whose db exposes only normalizeId.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function prove(ctx: { db: { normalizeId: (t: TableNames, id: string) => Id<TableNames> | null } }, id: string): void;
      export function f(ctx: MutationCtx, id: string) { prove(ctx, id); }`,
  },
  {
    // A ctx handed on typed as a Convex database holder.
    file: "convex/other.ts",
    typed: true,
    source: `
      import type { DatabaseReader } from "./_generated/server";
      declare function use(c: { db: DatabaseReader }): void;
      export function f(ctx: QueryCtx) { use(ctx); }`,
  },
  // PR 689 round 4, the matching good cases.
  {
    // A nullable database is still a database.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(db: QueryCtx["db"] | undefined): void;
      export function f(ctx: QueryCtx) { use(ctx.db); }`,
  },
  {
    // Every member of the union is a Convex database.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(db: MutationCtx["db"] | QueryCtx["db"]): void;
      export function f(ctx: MutationCtx) { use(ctx.db); }`,
  },
  {
    // A tuple spread pairs element i with parameter i: the number is not compared with the database parameter.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(db: QueryCtx["db"], n: number): void;
      export function f(ctx: QueryCtx) {
        const args: [QueryCtx["db"], number] = [ctx.db, 1];
        use(...args);
      }`,
  },
  // PR 689 round 5, the matching good cases.
  {
    // An optional Convex `db`, and a `db` that is Convex or nothing, on a holder.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(c: { db?: QueryCtx["db"] }): void;
      declare function other(c: { db: QueryCtx["db"] | MutationCtx["db"] | null | undefined } | undefined): void;
      export function f(ctx: MutationCtx) { use(ctx); other(ctx); }`,
  },
  {
    // `void` is nullish like `undefined`.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(db: QueryCtx["db"] | void): void;
      export function f(ctx: QueryCtx) { use(ctx.db); }`,
  },
  {
    // A holder of a holder, every level Convex.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(h: { inner?: { db: QueryCtx["db"] | undefined } }): void;
      export function f(ctx: QueryCtx) { const h = { inner: ctx }; use(h); }`,
  },
  {
    // Several spreads, every destination position is a Convex database.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(a: QueryCtx["db"], b: QueryCtx["db"], c: QueryCtx["db"], id: string): void;
      export function f(ctx: MutationCtx, id: string) {
        const a: [QueryCtx["db"], QueryCtx["db"]] = [ctx.db, ctx.db];
        const b: [MutationCtx["db"]] = [ctx.db];
        use(...a, ...b, id);
      }`,
  },
  {
    // A tuple rest element reaching a Convex first parameter and a Convex rest parameter.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(n: number, first?: QueryCtx["db"], ...others: QueryCtx["db"][]): void;
      export function f(ctx: MutationCtx) { const args: [number, ...MutationCtx["db"][]] = [1, ctx.db]; use(...args); }`,
  },
  {
    // Seat 2 LOW: a callee whose rest parameter is a tuple takes element i at position i.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(...args: [QueryCtx["db"], number]): void;
      export function f(ctx: QueryCtx) { const args: [QueryCtx["db"], number] = [ctx.db, 1]; use(...args); }`,
  },
  {
    // A plain Convex argument after a spread.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(a: QueryCtx["db"], b: QueryCtx["db"], w: QueryCtx["db"]): void;
      export function f(ctx: QueryCtx) { const two: [QueryCtx["db"], QueryCtx["db"]] = [ctx.db, ctx.db]; use(...two, ctx.db); }`,
  },
  {
    // A spread after a variable-length array, into a leading-rest tuple whose last element is Convex.
    file: "convex/other.ts",
    typed: true,
    source: `
      declare function use(...rest: [...number[], QueryCtx["db"]]): void;
      export function f(ctx: QueryCtx, nums: number[]) { const one: [QueryCtx["db"]] = [ctx.db]; use(...nums, ...one); }`,
  },
  {
    // Destructuring a holder without an annotation constrains nothing: the pattern is typed from the value.
    file: "convex/other.ts",
    typed: true,
    source: `
      export function f(ctx: MutationCtx, request: Readonly<{ reader: QueryCtx; dbs: [QueryCtx["db"]] }>) {
        const { db } = ctx;
        const { reader, dbs } = request;
        const [first] = dbs;
        return [db, reader, first];
      }`,
  },
  {
    // Arrays of databases into arrays of Convex databases.
    file: "convex/other.ts",
    typed: true,
    source: `
      export function f(ctx: MutationCtx) {
        const dbs: MutationCtx["db"][] = [ctx.db];
        const all: QueryCtx["db"][] = dbs;
        const ro: ReadonlyArray<QueryCtx["db"]> = dbs;
        return [all, ro];
      }`,
  },];

// PR 689 round 6: parameters flow from the destination signature into the supplied callback.
// Named cases bind failing-first evidence to a finding; each must compile beside the real tree.
const ROUND6_PRELUDE = `
  type Patcher = { patch(id: Id<"suppliers">, value: {}): Promise<void> };
  async function withDb(ctx: MutationCtx, cb: (db: MutationCtx["db"]) => Promise<void>) { await cb(ctx.db); }
  async function withCtx(ctx: MutationCtx, cb: (ctx: MutationCtx) => Promise<void>) { await cb(ctx); }
`;
const ROUND6_PROBES: Array<Snippet & { name: string; bad: boolean }> = [
  {
    name: "M1 arrow callback receives a foreign database", bad: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await withDb(ctx, async (db: Patcher) => { await db.patch(id, {}); }); }`,
  },
  {
    name: "M1 named callback receives a foreign database", bad: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { async function markInactive(db: Patcher) { await db.patch(id, {}); } await withDb(ctx, markInactive); }`,
  },
  {
    name: "M1 callback receives a foreign ctx holder", bad: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await withCtx(ctx, async (inner: { db: Patcher }) => { await inner.db.patch(id, {}); }); }`,
  },
  {
    name: "M1 interface method receives a foreign database", bad: true,
    source: `interface Job { run(db: MutationCtx["db"]): Promise<void> } export async function f(ctx: MutationCtx, id: Id<"suppliers">) { const job: Job = { async run(db: Patcher) { await db.patch(id, {}); } }; await job.run(ctx.db); }`,
  },
  {
    name: "M1 holder callback uses the tree makeSourceLive shape", bad: true,
    source: `declare function use(options: { makeSourceLive?: (ctx: MutationCtx) => Promise<void> }): void; export function f(id: Id<"suppliers">) { use({ makeSourceLive: async (inner: { db: Patcher }) => { await inner.db.patch(id, {}); } }); }`,
  },
  {
    name: "M1 named holder callback remains foreign", bad: true,
    source: `declare function use(options: { nested: { run(ctx: MutationCtx): Promise<void> } }): void; export function f(id: Id<"suppliers">) { const job = { nested: { run: async (inner: { db: Patcher }) => { await inner.db.patch(id, {}); } } }; use(job); }`,
  },
  {
    name: "M1 callback rest tuple receives a foreign database", bad: true,
    source: `declare function use(cb: (n: number, db: MutationCtx["db"]) => Promise<void>): void; export function f(id: Id<"suppliers">) { use(async (...args: [number, Patcher]) => { await args[1].patch(id, {}); }); }`,
  },
  {
    name: "M1 callback array receives foreign ctx holders", bad: true,
    source: `declare function use(callbacks: ((ctx: MutationCtx) => Promise<void>)[]): void; export function f(id: Id<"suppliers">) { const callbacks = [async (inner: { db: Patcher }) => { await inner.db.patch(id, {}); }]; use(callbacks); }`,
  },
  {
    name: "exemption contextually typed destructured parameter default", bad: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { const run: (c?: { db: Patcher }) => Promise<void> = async ({ db } = ctx) => { await db.patch(id, {}); }; await run(); }`,
  },
  {
    name: "M1 Convex arrow callback", bad: false,
    source: `export async function f(ctx: MutationCtx) { await withDb(ctx, async (db: MutationCtx["db"]) => { await db.query("vehicles").take(1); }); }`,
  },
  {
    name: "M1 Convex named callback", bad: false,
    source: `async function read(db: QueryCtx["db"]) { await db.query("vehicles").take(1); } export async function f(ctx: MutationCtx) { await withDb(ctx, read); }`,
  },
  {
    name: "M1 Convex interface method", bad: false,
    source: `interface Job { run(db: MutationCtx["db"]): Promise<void> } export function f() { const job: Job = { async run(db: QueryCtx["db"]) { await db.query("vehicles").take(1); } }; return job; }`,
  },
  {
    name: "M1 contextually typed makeSourceLive callback", bad: false,
    source: `declare function use(options: { makeSourceLive?: (ctx: MutationCtx) => Promise<void> }): void; export function f() { use({ makeSourceLive: async (inner) => { await inner.db.query("vehicles").take(1); } }); }`,
  },
  {
    name: "M1 Convex nested holder callback", bad: false,
    source: `declare function use(options: { nested: { run(ctx: MutationCtx): Promise<void> } }): void; export function f() { const job = { nested: { run: async (inner: QueryCtx) => { await inner.db.query("vehicles").take(1); } } }; use(job); }`,
  },
  {
    name: "M1 Convex callback rest tuple", bad: false,
    source: `declare function use(cb: (n: number, db: MutationCtx["db"]) => Promise<void>): void; export function f() { use(async (...args: [number, QueryCtx["db"]]) => { await args[1].query("vehicles").take(1); }); }`,
  },
  {
    name: "M1 callback may discard database arguments", bad: false,
    source: `export async function f(ctx: MutationCtx) { await withDb(ctx, async () => {}); }`,
  },
  {
    name: "exemption Convex contextually typed parameter default", bad: false,
    source: `export async function f(ctx: MutationCtx) { const run: (c?: QueryCtx) => Promise<void> = async ({ db } = ctx) => { await db.query("vehicles").take(1); }; await run(); }`,
  },
  {
    name: "LOW satisfies retains the holder operand type", bad: false,
    source: `export function f(ctx: MutationCtx) { const h = { db: ctx.db } satisfies { db: Patcher }; return h; }`,
  },
  {
    name: "LOW satisfies shorthand retains the holder operand type", bad: false,
    source: `export function f(ctx: MutationCtx) { const db = ctx.db; const h = { db } satisfies { db: Patcher }; return h; }`,
  },
  {
    name: "LOW satisfies still judges a foreign destination outside its operand", bad: true,
    source: `declare function use(h: { db: Patcher }): void; export function f(ctx: MutationCtx) { use({ db: ctx.db } satisfies { db: Patcher }); }`,
  },
  {
    name: "LOW satisfies does not exempt an inner foreign call", bad: true,
    source: `declare function use(db: Patcher): void; export function f(ctx: MutationCtx) { const h = { result: use(ctx.db) } satisfies { result: void }; return h; }`,
  },
  {
    name: "M1 function expression callback receives a foreign database", bad: true,
    source: `export async function f(ctx: MutationCtx, id: Id<"suppliers">) { await withDb(ctx, async function(db: Patcher) { await db.patch(id, {}); }); }`,
  },
  {
    name: "M1 recursive generic callback types terminate without a database", bad: false,
    source: `type Recursive<T> = { run(cb: Recursive<T[]>): void }; export function f(value: Recursive<number>) { const copy: Recursive<number> = value; return copy; }`,
  },
  {
    name: "LOW console logger fails closed", bad: true,
    source: `export function f(ctx: MutationCtx) { console.log(ctx); }`,
  },
  {
    name: "LOW unknown array logger fails closed", bad: true,
    source: `declare function log(...values: unknown[]): void; export function f(ctx: MutationCtx) { log(ctx); }`,
  },
].map((probe) => ({ ...probe, file: "convex/other.ts", typed: true, source: ROUND6_PRELUDE + probe.source }));

describe("supplier master source guards", () => {
  test.each(ROUND6_PROBES)("round 6: $name", (probe) => {
    expect(typeErrors(probe), "probe must compile before its verdict is evidence").toEqual([]);
    const violations = scanSnippet(probe).violations;
    if (probe.bad) expect(violations.map((violation) => violation.rule)).toContain("db-indirect-call");
    else expect(violations).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  test("lock coverage: the scanner rejects every synthetic bad source and accepts the good ones", () => {
    const missed: string[] = [];
    for (const bad of BAD_SNIPPETS) {
      const rules = scanSnippet(bad).violations.map((v) => v.rule);
      if (!rules.includes(bad.rule)) missed.push(`${bad.rule} in ${bad.file}: ${bad.source.trim().replace(/\s+/g, " ")}`);
    }
    expect(missed, "bad sources the scanner did not flag").toEqual([]);
    for (const good of GOOD_SNIPPETS) {
      expect(scanSnippet(good).violations, good.source).toEqual([]);
    }
  }, SCAN_TIMEOUT_MS);

  test("lock coverage: every probe added for a review finding is valid TypeScript, so the scanner is what it exercises", () => {
    const typed = [...BAD_SNIPPETS, ...GOOD_SNIPPETS].filter((snippet) => snippet.typed);
    expect(typed.length).toBeGreaterThan(20);
    for (const snippet of typed) expect(typeErrors(snippet), snippet.source).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  test("lock coverage: no insert, patch or replace on suppliers or supplierAliases happens outside a function holding a RegistryLock, and nothing deletes either table", () => {
    let supplierWrites = 0;
    const problems: string[] = [];
    const used = new Set<string>();
    for (const source of REAL_SOURCES) {
      let scan: Scan;
      try {
        scan = scanReal(source, used);
      } catch (error) {
        throw new Error(`Scanner failed in ${source.relPath}`, { cause: error });
      }
      supplierWrites += scan.supplierWrites;
      for (const v of scan.violations) problems.push(`${source.relPath}:${v.line} ${v.rule} ${v.text}`);
    }
    // The scan must have looked at the real writers: insert and patch on both tables.
    expect(supplierWrites).toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
    // Every allowance still matches real code: a stale entry (renamed function, removed call) fails here
    // instead of silently exempting nothing, or the wrong thing, later.
    const unused = GENERIC_ALLOWANCES.flatMap((entry) =>
      entry.methods.filter((method) => !used.has(`${entry.file}#${entry.fn}#${method}`)).map((method) => `${entry.file}#${entry.fn}#${method}`),
    );
    expect(unused, "allowances that matched no real call").toEqual([]);
    // The first test to run builds one TypeScript program over every non-test source under convex/
    // plus the synthetic snippets, so the type checker can read table and lock types. Measured on a
    // developer machine (SCRUM-868 PR 687, round 2): the whole file takes about 16 s (a second reviewer measured 15.8 s), almost all of it that
    // program build and the scan. CI runs it in a coverage batch with v8 instrumentation and several
    // workers (the earlier AST-only version overran vitest's default 5 s there: run 40525208382,
    // "Test timed out in 5000ms", 1.4 s uncovered). The timeout is about 4x the measured time, 75 s, which is also the ceiling we accept for this guard; a CI run that exceeds it should be investigated, not given a larger number. Tests
    // that need the program share it through getScanner(); each carries the explicit timeout, as in
    // the sibling AST guards (organizationReactivationGuard, orgFinancialResetReferenceCoverage).
  }, SCAN_TIMEOUT_MS);

  test("generic functions: the Data Browser allowlist names no supplier table, and the purge runner is driven only by its steps", () => {
    const { program } = getScanner();
    const sourceOf = (relPath: string): ts.SourceFile => {
      const real = REAL_SOURCES.find((s) => s.relPath === relPath);
      expect(real, relPath).toBeDefined();
      const file = program.getSourceFile(real!.absPath);
      expect(file, relPath).toBeDefined();
      return file!;
    };

    // adminData: the allowlist that assertAdminTable enforces holds none of the supplier tables.
    const allowlisted: string[] = [];
    let found = false;
    const readAllowlist = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "ADMIN_TABLES" && node.initializer) {
        found = true;
        const collect = (inner: ts.Node): void => {
          if (ts.isPropertyAssignment(inner) && ts.isIdentifier(inner.name) && inner.name.text === "table") {
            const value = stringLiteralValue(inner.initializer);
            if (value !== undefined) allowlisted.push(value);
          }
          ts.forEachChild(inner, collect);
        };
        collect(node.initializer);
      }
      ts.forEachChild(node, readAllowlist);
    };
    readAllowlist(sourceOf("convex/adminData.ts"));
    expect(found, "ADMIN_TABLES is declared in convex/adminData.ts").toBe(true);
    expect(allowlisted.length, "the allowlist was read").toBeGreaterThan(10);
    expect(allowlisted.filter((table) => ALL_TABLES.includes(table))).toEqual([]);

    // adminOrgs: the purge step runner is private and has exactly one caller, which passes `step.table`.
    const adminOrgs = sourceOf("convex/adminOrgs.ts");
    let declaredPrivate = false;
    const callers: string[] = [];
    const readRunner = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "deleteRowsByOrgBatch") {
        declaredPrivate = !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "deleteRowsByOrgBatch") {
        callers.push(node.arguments[1]?.getText(adminOrgs) ?? "");
      }
      ts.forEachChild(node, readRunner);
    };
    readRunner(adminOrgs);
    expect(declaredPrivate, "deleteRowsByOrgBatch is not exported").toBe(true);
    expect(callers).toEqual(["step.table"]);
    // adminData: the id-proof helper that the scan trusts by name normalizes against its second parameter.
    // The scan treats `assertIdBelongsToTable(ctx, t, raw)` as "raw was proved to belong to t".
    const adminData = sourceOf("convex/adminData.ts");
    let helper: ts.FunctionDeclaration | undefined;
    ts.forEachChild(adminData, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === ID_PROOF_HELPER) helper = node;
    });
    expect(helper, `${ID_PROOF_HELPER} is declared in convex/adminData.ts`).toBeDefined();
    const tableParameter = helper!.parameters[1]?.name;
    expect(tableParameter && ts.isIdentifier(tableParameter), "the helper's second parameter is the table").toBe(true);
    const normalizeArguments: string[] = [];
    const readHelper = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "normalizeId") {
        normalizeArguments.push(node.arguments[0]?.getText(adminData) ?? "");
      }
      ts.forEachChild(node, readHelper);
    };
    readHelper(helper!);
    expect(normalizeArguments).toEqual([tableParameter!.getText(adminData)]);
    // That the steps include all three supplier tables, children first, is the purge test below.
  }, SCAN_TIMEOUT_MS);

  test("the supplier modules exist and are the only sources that name the new tables in a database call", () => {
    for (const relPath of SUPPLIER_MODULES) expect(REAL_SOURCES.some((s) => s.relPath === relPath), relPath).toBe(true);
  });
});

describe("supplier master schema", () => {
  function fieldsOf(table: string): string[] {
    const definition = (schema.tables as unknown as Record<string, { validator: { fields: Record<string, unknown> } }>)[table];
    expect(definition, `${table} is defined`).toBeDefined();
    return Object.keys(definition.validator.fields).sort();
  }

  test("the master holds identity only: the field list is exact and no field is money (I12)", () => {
    expect(fieldsOf("suppliers")).toEqual(
      [
        "orgId", "displayName", "displayNameKey", "legalName", "status", "contact", "taxId", "taxIdKey", "taxJurisdiction",
        "sharedLegalIdentityOf", "sharedLegalIdentityReason", "version", "origin", "createdBy", "createdAt", "updatedBy",
        "updatedAt", "deactivatedBy", "deactivatedAt", "deactivatedReason",
      ].sort(),
    );
    expect(fieldsOf("supplierAliases")).toEqual(
      ["orgId", "supplierId", "alias", "aliasKey", "source", "status", "createdBy", "createdAt"].sort(),
    );
    expect(fieldsOf("supplierRegistryState")).toEqual(["orgId", "version"].sort());
    const money = /amount|balance|currency|price|cost|paid|due|credit|debit|total|fee|commission|payable|receivable|ledger|journal/i;
    for (const table of ALL_TABLES) {
      expect(fieldsOf(table).filter((field) => money.test(field)), table).toEqual([]);
    }
  });
});

describe("supplier master purge and reset registration", () => {
  function mentions(list: unknown, table: string): boolean {
    return JSON.stringify(list).includes(`"${table}"`);
  }

  test("all three tables are deleted with the organization, children before parents", () => {
    const steps = ORGANIZATION_DELETION_STEPS as unknown as Array<{ kind: string; table?: string; index?: string }>;
    const positions = new Map<string, number>();
    for (const table of ALL_TABLES) {
      const hits = steps.map((step, i) => ({ step, i })).filter(({ step }) => step.table === table);
      expect(hits, table).toHaveLength(1);
      expect(hits[0].step.kind, table).toBe("orgRows");
      expect(hits[0].step.index, table).toMatch(/^by_org/);
      positions.set(table, hits[0].i);
    }
    expect(positions.get("supplierAliases")!).toBeLessThan(positions.get("suppliers")!);
    expect(positions.get("suppliers")!).toBeLessThan(positions.get(REGISTRY_TABLE)!);
  });

  test("master data and the registry are retained across a financial reset", () => {
    for (const table of ALL_TABLES) {
      expect(mentions(RESET_TABLES_FOR_TEST, table), `${table} must not be reset`).toBe(false);
      expect(mentions(CHILD_TABLES_FOR_TEST, table), `${table} must not be a reset child table`).toBe(false);
    }
  });
});
