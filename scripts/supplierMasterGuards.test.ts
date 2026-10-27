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
 * aliased `db` all resolve the same way. `.bind`, `.call` and `.apply` on a database method are refused
 * ("db-indirect-call"). A callee that does not resolve at all (an `any` receiver) is treated as a database
 * call if its name is a database method name; `Map.get(supplierId)` is not a database call.
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
 * GENERIC TABLE ACCESS. A database call whose table is typed as every table (`Id<TableNames>`,
 * `<T extends TableNames>`) names no table. It is refused ("generic-table-access", so a helper like
 * `patchRow<T extends TableNames>` is caught in its body) unless it sits in one of the exact functions
 * in GENERIC_ALLOWANCES, with the methods listed there. Each adminData handler must call
 * `assertAdminTable` as a straight-line statement before the database call; the purge runner is
 * private and has one caller, passing `step.table`; two read-only helpers may use `get`. A test fails if
 * an allowance matches no real call.
 *
 * WHAT IS PROVEN, AND WHAT IS NOT.
 *  Proven, for the code under convex/ that this program resolves (not test files): every
 *  `db` call whose table is statically knowable as a supplier table, by literal, by `Id` type or by
 *  type-parameter constraint, is inside a function with a `RegistryLock` parameter and does not delete;
 *  every call to a lock-taking function passes a lock that type-checks and is not cast into place.
 *  NOT proven, so do not read this as a sealed boundary:
 *   - a database call whose table type is `string`, `any` or otherwise erased (a helper taking
 *     `table: string` and an `any` receiver, `(ctx.db as any).table("suppliers")`) shows no table;
 *   - a READ of a supplier row through a generic read-only helper (`requireOwnedRow`, `makeDocCache`) is
 *     not tracked: those helpers are exempt as `get`-only, and their callers are not scanned for tables;
 *   - for adminData, the allowlist's content and the guard's position are checked, but not that
 *     `assertAdminTable` throws on a table outside it; "dominates" is straight-line statements only;
 *   - a lock reached through an indirect call (a callback or object member bound to a lock-taking
 *     function, an `any`-typed callee) is not followed;
 *   - code outside convex/ (scripts, the Convex dashboard, `npx convex run` of a function that is
 *     not in this tree) is not scanned;
 *   - it does NOT prove concurrent writers conflict. `convex-test` serializes everything, so that
 *     is argued from the documented OCC read set (https://docs.convex.dev/database/advanced/occ)
 *     and is not demonstrated here.
 *
 * The scanner is itself tested against synthetic bad sources, so "no violations found" cannot
 * mean "the scanner looks at nothing". The synthetic sources are compiled in the same program as
 * the real tree, as virtual files beside the real ones, so they get real types.
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
const GENERIC_ALLOWANCES: readonly GenericAllowance[] = [
  { file: "convex/adminData.ts", fn: "adminListByOrg", methods: ["query"], guard: ADMIN_GUARD, reason: "Data Browser list" },
  { file: "convex/adminData.ts", fn: "adminGetRecord", methods: ["get"], guard: ADMIN_GUARD, reason: "Data Browser read" },
  { file: "convex/adminData.ts", fn: "adminUpdateRecord", methods: ["get", "patch"], guard: ADMIN_GUARD, reason: "Data Browser edit" },
  { file: "convex/adminData.ts", fn: "adminRestoreRecords", methods: ["get", "patch"], guard: ADMIN_GUARD, reason: "Data Browser restore" },
  { file: "convex/adminData.ts", fn: "adminHardDelete", methods: ["get", "delete"], guard: ADMIN_GUARD, reason: "Data Browser delete" },
  { file: "convex/adminOrgs.ts", fn: "deleteRowsByOrgBatch", methods: ["query", "delete"], reason: "organization purge step runner" },
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

function isCallTo(expression: ts.Expression | undefined, name: string): boolean {
  if (!expression) return false;
  const bare = skipAwait(expression);
  return ts.isCallExpression(bare) && ts.isIdentifier(bare.expression) && bare.expression.text === name;
}

/**
 * True when some function enclosing `node` has, directly in its body block (not inside an `if`, a loop or
 * a callback), a statement that calls `guard` and ends before `node` starts. Straight-line code, so the
 * guard runs, or throws, before `node`.
 */
function guardDominates(node: ts.Node, guard: string, sourceFile: ts.SourceFile): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const body = (current as ts.FunctionLikeDeclaration).body;
    if (!body || !ts.isBlock(body)) continue;
    for (const statement of body.statements) {
      if (statement.end > node.getStart(sourceFile)) break;
      if (ts.isExpressionStatement(statement) && isCallTo(statement.expression, guard)) return true;
      if (
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((declaration) => isCallTo(declaration.initializer, guard))
      ) {
        return true;
      }
    }
  }
  return false;
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
  private databaseMethodOf(signature: ts.Signature | undefined): string | undefined {
    const declaration = signature?.declaration;
    if (!declaration || !CONVEX_PACKAGE.test(declaration.getSourceFile().fileName.replaceAll("\\", "/"))) return undefined;
    const owner = declaration.parent;
    if (!ts.isInterfaceDeclaration(owner) || !CONVEX_DB_INTERFACES.has(owner.name.text)) return undefined;
    const name = ts.isMethodSignature(declaration) ? declaration.name : undefined;
    return name && ts.isIdentifier(name) && DB_METHODS.has(name.text) ? name.text : undefined;
  }

  /** `db.patch.bind(db)`, `.call(...)` and `.apply(...)` on a database method: the call is made through a wrapper. */
  private isIndirectDatabaseCall(call: ts.CallExpression): boolean {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !["bind", "call", "apply"].includes(callee.name.text)) return false;
    const target = this.checker.getTypeAtLocation(callee.expression);
    return target.getCallSignatures().some((signature) => this.databaseMethodOf(signature) !== undefined);
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
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (node.type.getText(sourceFile) === "RegistryLock" && !mintsLock(node)) flag("forged-lock", node);
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
    return entry.guard === undefined || guardDominates(node, entry.guard, sourceFile) ? entry : undefined;
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

function scanSnippet(snippet: Snippet): Scan {
  const { scanner, program, snippets } = getScanner();
  const index = snippets.indexOf(snippet);
  if (index < 0) throw new Error("snippet is not part of the program");
  const sourceFile = program.getSourceFile(virtualSnippetPath(index));
  if (!sourceFile) throw new Error("virtual snippet file missing from the program");
  return scanner.scan(sourceFile, snippet.file);
}

function scanReal(source: { relPath: string; absPath: string }, usedAllowances: Set<string>): Scan {
  const { scanner, program } = getScanner();
  const sourceFile = program.getSourceFile(source.absPath);
  if (!sourceFile) throw new Error(`${source.relPath} is not in the program`);
  return scanner.scan(sourceFile, source.relPath, usedAllowances);
}

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
  {
    // An allowed generic function, with its guard as a straight-line statement before the call.
    file: "convex/adminData.ts",
    source: `export async function adminUpdateRecord(ctx: MutationCtx, id: Id<TableNames>, name: string) {
      const { table } = assertAdminTable(name);
      return await ctx.db.get(id);
    }`,
  },
  {
    file: "convex/adminData.ts",
    source: `export const adminHardDelete = async (ctx: MutationCtx, id: Id<TableNames>, name: string) => {
      assertAdminTable(name);
      for (const n of [1]) { await ctx.db.delete(id); }
    };`,
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
