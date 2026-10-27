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
 * (convex/tsconfig.json) gives a type checker. For every `db.insert/patch/replace/delete/get/query`
 * call the table is the string literal first argument, or else it is read from the checker type of
 * the first argument: an `Id<"suppliers">` (the legacy `db.patch(id, ...)` / `db.replace(id, row)`
 * form), or a variable whose type is a table-name union that includes one of the three tables.
 * A call counts only if it resolves to a signature declared in the `convex` package, or does not
 * resolve at all (an `any` receiver); `Map.get(supplierId)` is not a database call.
 *
 * HOW A LOCK IS CHECKED. Any call to a function that has a `RegistryLock` parameter must pass, for
 * that parameter, an argument whose static type is assignable to `RegistryLock`, that is not
 * `any`/`unknown`, and that is not a type assertion (`as any`, `as unknown as never`,
 * `<RegistryLock>`), and the call must not use a spread. A suppressed type error
 * (`@ts-expect-error`) still fails, because the argument type is checked, not the diagnostics.
 * `as RegistryLock` and `as never` are refused anywhere outside `withRegistryLock`.
 *
 * WHAT IS PROVEN, AND WHAT IS NOT.
 *  Proven, for the code under convex/ that this program resolves (not test files): every
 *  `db` call whose table is statically knowable as a supplier table, by literal or by type, is
 *  inside a function with a `RegistryLock` parameter and does not delete; every call to a
 *  lock-taking function passes a lock that type-checks and is not cast into place.
 *  NOT proven, so do not read this as a sealed boundary:
 *   - a database call whose table type is `string`, `any` or otherwise erased (a helper taking
 *     `table: string` and an `any` receiver) shows no table to the scanner;
 *   - a call whose table is typed as EVERY table (`Id<TableNames>`) names no table. It is refused
 *     ("generic-table-access") except in convex/adminData.ts and convex/adminOrgs.ts, which are table-driven
 *     by design. For those two the proof is indirect: adminData's allowlist is read and shown to
 *     exclude the supplier tables, and the purge steps are asserted below. Whether adminData applies
 *     its allowlist before every call is not proven by this scan;
 *   - a lock reached through an indirect call (`fn.call`, a callback or object member bound to a
 *     lock-taking function, an `any`-typed callee) is not followed;
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
const SCAN_TIMEOUT_MS = 180_000;

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
 * The only modules allowed a database call whose table is typed as every table. Each is table-driven
 * by design and has its own guard, asserted in the "generic table modules" test:
 *  - convex/adminData.ts: the cross-org Data Browser. `assertAdminTable` refuses any table not in its
 *    ADMIN_TABLES allowlist, which names none of the supplier tables.
 *  - convex/adminOrgs.ts: the organization purge. It deletes every org row table by table, the supplier
 *    tables included, children before parents (ORGANIZATION_DELETION_STEPS). That is the one sanctioned
 *    delete of supplier data, together with the organization it belongs to.
 */
const GENERIC_TABLE_MODULES = new Map<string, string>([
  ["convex/adminData.ts", "table-driven admin editor behind an ADMIN_TABLES allowlist"],
  ["convex/adminOrgs.ts", "organization purge over ORGANIZATION_DELETION_STEPS"],
]);

const DB_METHODS = new Set(["insert", "patch", "replace", "delete", "get", "query"]);
const CONVEX_PACKAGE = /[\\/]node_modules[\\/]convex[\\/]/;

interface LockParameter {
  index: number;
  typeNode: ts.TypeNode;
}

interface TableFacts {
  tables: string[];
  /** True when the type carries no table information at all (any, unknown, an erased type). */
  unresolved: boolean;
}

/** Table names carried by a type: a string literal, a union of them, or `Id<"table">`. */
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

function skipParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
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

  /** A database call resolves into the convex package. An unresolved callee (any receiver) is assumed to be one. */
  private isDatabaseCall(call: ts.CallExpression): boolean {
    const declaration = this.checker.getResolvedSignature(call)?.declaration;
    if (!declaration) return true;
    return CONVEX_PACKAGE.test(declaration.getSourceFile().fileName.replaceAll("\\", "/"));
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
  scan(sourceFile: ts.SourceFile, relPath: string): Scan {
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
        if (ts.isPropertyAccessExpression(node.expression)) {
          this.scanMethodCall(node, node.expression, relPath, inSupplierModule, flag, () => {
            supplierWrites += 1;
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { violations, supplierWrites };
  }

  private scanMethodCall(
    node: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    relPath: string,
    inSupplierModule: boolean,
    flag: (rule: string, node: ts.Node) => void,
    countSupplierWrite: () => void,
  ): void {
    const method = callee.name.text;
    const first = node.arguments[0];
    let facts: TableFacts = { tables: [], unresolved: true };
    if (DB_METHODS.has(method) && first !== undefined) {
      const literal = stringLiteralValue(first);
      // A literal table is trusted syntactically. A table given only by type counts when the call
      // is a database call: `Map.get(supplierId)` and `Set.delete(supplierId)` are not.
      if (literal !== undefined || this.isDatabaseCall(node)) facts = this.tablesOfExpression(first);
    }
    // A table typed as every table (`Id<TableNames>`, `table: TableNames`) names no table in particular:
    // generic code. It may reach the supplier tables only in a module listed in GENERIC_TABLE_MODULES,
    // whose own guard is asserted by a separate test below. Anywhere else it is a violation.
    if (DB_METHODS.has(method) && SCHEMA_TABLES.every((table) => facts.tables.includes(table))) {
      if (!GENERIC_TABLE_MODULES.has(relPath)) flag("generic-table-access", node);
      facts = { tables: [], unresolved: true };
    }
    const touchesNewTable = facts.tables.some((table) => ALL_TABLES.includes(table));
    const isSupplierTable = facts.tables.some((table) => (SUPPLIER_TABLES as readonly string[]).includes(table));
    const noTable = facts.tables.length === 0;

    if (method === "delete" && (touchesNewTable || inSupplierModule)) flag("delete", node);
    if (!inSupplierModule && touchesNewTable && ["insert", "patch", "replace", "query", "get"].includes(method)) {
      flag("foreign-access", node);
    }
    if (inSupplierModule && WRITE_METHODS.has(method)) {
      if (noTable) flag("untabled-write", node);
      if (facts.tables.includes(REGISTRY_TABLE) && relPath !== LOCK_MODULE) flag("registry-write-outside-lock-module", node);
    }
    if (isSupplierTable && WRITE_METHODS.has(method)) {
      countSupplierWrite();
      if (!holdsRegistryLock(node)) flag("unlocked-write", node);
    }
    if (inSupplierModule && (method === "filter" || method === "collect") && chainHasQuery(callee.expression)) {
      flag(method === "filter" ? "filter" : "unbounded-collect", node);
    }
    // A sort with no compare function orders by UTF-16 code unit only by accident of the default
    // (Sonar typescript:S2871). The supplier modules say so with `codeUnitCompare`.
    if (inSupplierModule && method === "sort" && node.arguments.length === 0) flag("bare-sort", node);
  }
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

function scanReal(source: { relPath: string; absPath: string }): Scan {
  const { scanner, program } = getScanner();
  const sourceFile = program.getSourceFile(source.absPath);
  if (!sourceFile) throw new Error(`${source.relPath} is not in the program`);
  return scanner.scan(sourceFile, source.relPath);
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
  // A table typed as every table names no table in particular. Outside the two generic modules it is refused.
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
    file: "convex/adminData.ts",
    source: `export async function f(ctx: MutationCtx, id: Id<TableNames>) { return await ctx.db.get(id); }`,
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
    for (const source of REAL_SOURCES) {
      const scan = scanReal(source);
      supplierWrites += scan.supplierWrites;
      for (const v of scan.violations) problems.push(`${source.relPath}:${v.line} ${v.rule} ${v.text}`);
    }
    // The scan must have looked at the real writers: insert and patch on both tables.
    expect(supplierWrites).toBeGreaterThanOrEqual(4);
    expect(problems).toEqual([]);
    // The first test to run builds one TypeScript program over every non-test source under convex/
    // plus the synthetic snippets, so the type checker can read table and lock types. Measured on a
    // developer machine (SCRUM-868 PR 687): the whole file takes about 14 s, almost all of it that
    // program build and the scan. CI runs it in a coverage batch with v8 instrumentation and several
    // workers (the earlier AST-only version overran vitest's default 5 s there: run 40525208382,
    // "Test timed out in 5000ms", 1.4 s uncovered), so the timeout leaves roughly 12x headroom. Tests
    // that need the program share it through getScanner(); each carries the explicit timeout, as in
    // the sibling AST guards (organizationReactivationGuard, orgFinancialResetReferenceCoverage).
  }, SCAN_TIMEOUT_MS);

  test("generic table modules: the Data Browser allowlist names none of the supplier tables, and the purge lists all three", () => {
    const { program } = getScanner();
    const adminData = REAL_SOURCES.find((s) => s.relPath === "convex/adminData.ts");
    expect(adminData).toBeDefined();
    const sourceFile = program.getSourceFile(adminData!.absPath);
    expect(sourceFile).toBeDefined();
    const allowlisted: string[] = [];
    let found = false;
    const visit = (node: ts.Node): void => {
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
      ts.forEachChild(node, visit);
    };
    visit(sourceFile!);
    expect(found, "ADMIN_TABLES is declared in convex/adminData.ts").toBe(true);
    expect(allowlisted.length, "the allowlist was read").toBeGreaterThan(10);
    expect(allowlisted.filter((table) => ALL_TABLES.includes(table))).toEqual([]);
    // The purge side is asserted by "all three tables are deleted with the organization" below.
    expect([...GENERIC_TABLE_MODULES.keys()].sort()).toEqual(["convex/adminData.ts", "convex/adminOrgs.ts"]);
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
