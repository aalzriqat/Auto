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
 *  - "db-indirect-call" (escape, `escapesDatabaseType`): a database value, or one of its methods, handed to a position
 *    whose DECLARED type is not a Convex database type: a parameter, an annotated variable, an `as` target, an
 *    `any[]` element, a returned value. After that the checker sees a structural or `any` type, not the Convex
 *    interface, which is how `const p: (id: Id<"suppliers">, v: {}) => Promise<void> = ctx.db.patch`,
 *    `invoke(ctx.db.patch, ...)`, `use(ctx.db)` with a structural parameter and `(ctx.db as any).patch` would
 *    otherwise vanish. A position with no declared type keeps the value's own type and is not an escape.
 *    One exemption: the KEY argument of a `WeakMap`/`WeakSet` method (the database as a key, as
 *    convex/utils/depositCancellationPending.ts does), found by the lib declaration; a database stored as a value is not exempt. Calls the real tree makes with
 *    `ctx.db` today all pass a Convex-typed parameter, so the real-tree scan stays at zero.
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
 * where a `table === "<that table>"` check on its own `table` parameter decides the branch: the then-branch of an `if`, or
 * the right operand of an `&&` with the check on the left (`isCheckedPurgeNarrowing`). A cast there to `any`, to a master
 * table, to a table the check does not name, or outside the checked branch is refused. Nowhere else is exempt,
 * including the adminData handlers.
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
 *  Proven, for the code under convex/ that this program resolves (not test files): every
 *  `db` call whose table is statically knowable as a supplier table, by literal, by `Id` type or by
 *  type-parameter constraint, is inside a function with a `RegistryLock` parameter and does not delete;
 *  every call to a lock-taking function passes a lock that type-checks and is not cast into place; in the
 *  adminData handlers a generic call's table is the guard's `const` output; and the database and its methods are
 *  not handed to a non-Convex declared type or a wrapper in the ways listed above.
 *  NOT proven. This is a best-effort tripwire for an honest mistake, NOT a sealed boundary and not a defence
 *  against someone writing code to evade it. Known ways past it, none of them used in the tree:
 *   - the database retyped where the checker does not look. `escapesDatabaseType` reads the declared type of a
 *     position; a database value that is ALREADY `any` or structurally typed before it reaches a rule (it came out of
 *     `Reflect.get(ctx, "db")`, a function that returns `any`, generic pass-through like `identity<T>(ctx.db)`) is
 *     not seen, and neither is the use of a database method through `Object.getOwnPropertyDescriptor(ctx.db, ...)`
 *     once its result is untyped. Ordinary helper functions that take `ctx` or `db` with a Convex type are fine and
 *     are followed. A user-written `invoke(fn, ...)` is caught only because its parameters are not Convex types;
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
 *     the `table` parameter of the `table === "<target>"` check is not proven unassigned between the check and the cast;
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
 * `TypeChecker.getContextualType`, `getTypeFromTypeNode`, `isArrayType`/`isTupleType`/`getTypeArguments`, `Type.getNumberIndexType`, `getAnyType`, `ts.getPreEmitDiagnostics`, `ts.isConstTypeReference` and `ts.getCombinedNodeFlags`
 * with `ts.NodeFlags.Const`.
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

/**
 * A name or member access that hands its value to a declared type: an argument, a variable initializer, an array
 * element, a property value, the right of `=`, a returned value, an arrow body or the operand of `as` / `<T>`.
 */
function isValuePosition(node: ts.Node): node is ts.Expression {
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const parent = node.parent;
  return (
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== node) ||
    (ts.isVariableDeclaration(parent) && parent.initializer === node) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === node) ||
    (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) ||
    (ts.isArrowFunction(parent) && parent.body === node) ||
    ts.isArrayLiteralExpression(parent) ||
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
    return type.getCallSignatures().some((signature) => this.databaseMethodOf(signature) !== undefined);
  }

  private isDatabaseValue(expression: ts.Expression): boolean {
    return this.isDatabaseType(this.checker.getTypeAtLocation(expression));
  }

  /**
   * A database value, or one of its methods, handed to a position whose DECLARED type is not itself a Convex
   * database type: a parameter, an annotated variable, an `as` target, an element of an `any[]`. From there on
   * the checker no longer resolves calls into the Convex interface, which is how every later rule recognises a
   * database call (`const p: (id: Id<"suppliers">, v: {}) => Promise<void> = ctx.db.patch`, `use(ctx.db)` with a
   * structural parameter, `invoke(ctx.db.patch, ...)`, `(ctx.db as any).patch`). A position with no declared type
   * keeps the value's own type, so it is not an escape. TS Compiler API: TypeChecker.getContextualType.
   */
  private escapesDatabaseType(expression: ts.Expression): boolean {
    if (!this.isDatabaseValue(expression)) return false;
    // A WeakMap/WeakSet KEY (argument 0) is only ever compared by identity: it cannot be read back or called
    // (convex/utils/depositCancellationPending.ts). A database stored as a VALUE can be read back, so it is not exempt.
    const parent = expression.parent;
    if (ts.isCallExpression(parent) && parent.arguments[0] === expression && this.libContainerOf(parent, WEAK_KEY_OWNERS) !== undefined) return false;
    let declared = this.checker.getContextualType(expression);
    if (declared === undefined && ts.isArrayLiteralExpression(parent)) {
      // An element of an array literal takes its type from the array's declared element type, e.g. `ArrayLike<any>`.
      const array = this.checker.getContextualType(parent);
      if (array === undefined) return false;
      declared = array.getNumberIndexType() ?? this.checker.getAnyType();
    }
    return declared !== undefined && !this.isDatabaseType(declared);
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
   * function's own `table` parameter) deciding that branch. Nowhere else, and not to `any` or a master table.
   */
  private isCheckedPurgeNarrowing(node: ts.AsExpression | ts.TypeAssertion, operandTables: readonly string[], relPath: string): boolean {
    if (relPath !== PURGE_RUNNER.file || topLevelName(node) !== PURGE_RUNNER.fn) return false;
    if (!SCHEMA_TABLES.every((table) => operandTables.includes(table))) return false;
    const target: TableFacts = { tables: [], unresolved: false };
    tablesOfType(this.checker, this.checker.getTypeFromTypeNode(node.type), node, target);
    if (target.unresolved || target.tables.length !== 1 || ALL_TABLES.includes(target.tables[0])) return false;
    return this.tableCheckDominates(node, target.tables[0]);
  }

  /** Is `expr` the check `table === "<target>"` (either order) on a parameter named `table`? */
  private isTableCheck(expr: ts.Expression, target: string): boolean {
    const bare = skipParentheses(expr);
    if (!ts.isBinaryExpression(bare) || bare.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    const sides = [bare.left, bare.right];
    const name = sides.find((side): side is ts.Identifier => ts.isIdentifier(side));
    const literal = sides.map((side) => stringLiteralValue(side)).find((value) => value !== undefined);
    const declared = name && this.checker.getSymbolAtLocation(name)?.valueDeclaration;
    return literal === target && declared !== undefined && ts.isParameter(declared) && name?.text === "table";
  }

  /**
   * Does a `table === "<target>"` check decide the branch `node` is in: the then-branch of an `if` whose condition has
   * it as a conjunct, or the right operand of an `&&` that has it as a conjunct on the left? Stops at a function boundary.
   */
  private tableCheckDominates(node: ts.Node, target: string): boolean {
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
      if (guarded && conjuncts(guarded).some((conjunct) => this.isTableCheck(conjunct, target))) return true;
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
      if (isValuePosition(node) && this.escapesDatabaseType(node)) flag("db-indirect-call", node);
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
    const snippets: readonly Snippet[] = [...BAD_SNIPPETS, ...GOOD_SNIPPETS];
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
];

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
];

describe("supplier master source guards", () => {
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
      const scan = scanReal(source, used);
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
