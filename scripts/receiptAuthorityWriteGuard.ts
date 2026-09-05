/**
 * SCRUM-238 (SCRUM-218-E) — TYPE-AWARE structural guard for direct writes to
 * declared authority tables.
 *
 * ## Why this file exists at all
 *
 * SCRUM-218's final closure `6d2fb9e9e` promised repository-structural
 * enforcement for unauthorized `insert`/`patch`/`replace`/`delete` writes to
 * receipt authority, and independent review (`SCRUM-218 c17516`) proved the
 * proposed source-text analyzer could not express the delete case:
 *
 * ```ts
 * ctx.db.delete(id);   // contains no table name, anywhere, in any spelling
 * ```
 *
 * The table is not in the text. It is in the TYPE of `id`. Convex defines
 *
 * ```ts
 * type Id<TableName extends string> = string & { __tableName: TableName };
 * ```
 *
 * so the target table is recoverable — but only from a real `ts.Program` and
 * `TypeChecker`, never from a regex and never from a bare `ts.createSourceFile`
 * syntax tree.
 *
 * `scripts/commitmentWriteGuard.ts` says this in its own header, about itself:
 *
 * > "A SOUND version of this check needs the target table resolved from the
 * > id's `Id<Table>` type, which needs a TypeScript program rather than a
 * > source-text pass. That is real work and it is not this file."
 *
 * This is that work. It does not modify, replace or subsume that guard or
 * `scripts/tenantWriteGuard.ts`; all three answer different questions and all
 * three keep their own suites.
 *
 * ## What this analyzer claims, precisely
 *
 * For every call in the analysed source set whose receiver's TYPE is a Convex
 * database writer and whose method is `insert`/`patch`/`replace`/`delete`, it
 * resolves the target table:
 *
 * - `insert`  — from the first argument's static string-literal type. That
 *               covers a plain literal, a `const`-bound name, and a union of
 *               literals; it does NOT cover a value whose type widens to
 *               `string` (a template with a substitution, a runtime-computed
 *               name), which is reported as UNPROVEN.
 * - `patch` / `replace` / `delete` — from the `__tableName` brand carried by
 *               the first argument's type. Because that is a property of the
 *               type rather than of the spelling, it resolves through
 *               intermediate bindings, aliases, helper return values,
 *               `Doc<T>["_id"]`, and unions of ids.
 *
 * The operation itself is resolved the same way. A bracket call —
 * `ctx.db["delete"](id)` — is legal TypeScript, compiles identically, and is
 * invisible to any analyzer that only reads property accesses; it is read here
 * from the bracket's type, so a `const` binding resolves as well as a literal.
 * A bracket that does not name exactly one method is UNPROVEN, because on a
 * database writer an unreadable method name may be any of the four.
 *
 * It then classifies each resolved site against the declaration below:
 * a write to a declared authority table from any module other than that
 * table's declared owner is a VIOLATION.
 *
 * ## ⚠️ IT IS FAIL-CLOSED, AND THERE IS DELIBERATELY NO ALLOWLIST
 *
 * A site whose table cannot be proven is reported as UNPROVEN and fails the
 * guard. It is not skipped, and it is not silently counted as safe.
 *
 * That policy was MEASURED before it was chosen, not assumed affordable. At
 * `bf5769ed1` the backend contains 848 database write sites across 218
 * non-generated non-test modules (patch 499, insert 291, delete 58,
 * replace 0), and every single one resolves to a concrete table. Zero
 * unproven, zero `any`/`unknown` receivers. So fail-closed costs nothing today
 * and a NEW unresolvable form fails CI rather than quietly shrinking the
 * analysed surface.
 *
 * No burn-down allowlist is provided on purpose. A green result from this file
 * is an AUTHORIZATION, and an allowlist is the mechanism by which such a
 * result stops meaning anything. If a genuinely dynamic write is ever needed,
 * that is a deliberate amendment to this guard with its own review — not an
 * entry someone adds to make a build pass.
 *
 * ## ⚠️ RECORDED SCOPE BOUNDARIES — read these before quoting a green run
 *
 * 1. `**\/*.test.ts` and `convex/_generated/**` are NOT analysed, matching both
 *    existing write guards. A test that inserts an authority row directly is
 *    fixture setup, not a production authority violation.
 * 2. This is REPOSITORY/TOOLING enforcement. It is not a database capability,
 *    it grants nothing at runtime, and it cannot stop a write that reaches the
 *    database by any path other than a `ctx.db.*` call in analysed source —
 *    a registered generic posting entrypoint, for instance, is a different
 *    control and belongs to SCRUM-249.
 * 3. It is not flow-sensitive and makes no reachability claim. A write inside
 *    dead code is still a write.
 * 4. `ctx.db.replace` has ZERO call sites in the backend at `bf5769ed1`. Its
 *    detection is proven by fixture programs only. That is stated rather than
 *    folded into a single "all four operations covered" sentence, because it
 *    is a real difference in the evidence.
 */
import path from "node:path";
import ts from "typescript";

/** The four Convex `DatabaseWriter` methods that mutate a table. */
export const DB_WRITE_METHODS = ["insert", "patch", "replace", "delete"] as const;
export type DbWriteMethod = (typeof DB_WRITE_METHODS)[number];

/**
 * One authority table and the single module allowed to write it.
 *
 * `ownerModule` is a repository-relative POSIX path, compared exactly. A path
 * is used rather than a basename because two modules in different directories
 * may legitimately share a name, and "the owner" must be one file.
 */
export interface AuthorityDeclaration {
  readonly table: string;
  readonly ownerModule: string;
}

/**
 * ⚠️ EMPTY, ON PURPOSE, AND NOT BECAUSE THE WORK IS UNFINISHED.
 *
 * The receipt/retained-position authority tables do not exist yet on ANY head,
 * including the certified `9ea7ea9e4`. SCRUM-218-C creates them, and its
 * SOL-GATE (`SCRUM-218 c17652`) is unruled at the time this guard was written.
 * Guessing `receiptMovements` here and then requiring 218-C to conform is
 * exactly the coupling the owner-proxy told this ticket not to create.
 *
 * So the MECHANISM ships proven and the DECLARATION ships unbound. Binding is
 * a one-entry edit to this array plus a full re-run of the suite.
 *
 * Until then `declarationStatus()` reports `PENDING_218C_TABLE_FREEZE` and
 * `auditAuthorityWrites` reports zero authority coverage. A green run of this
 * guard today proves that every database write in the backend has a provable
 * target table. It does NOT prove that receipt authority is enforced, because
 * nothing is declared yet, and this comment exists so that distinction cannot
 * be lost by someone reading only the exit code.
 */
export const RECEIPT_AUTHORITY_DECLARATION: readonly AuthorityDeclaration[] = [];

export type DeclarationStatus = "BOUND" | "PENDING_218C_TABLE_FREEZE";

/**
 * Derived, never stored. A stored status constant is a second source of truth
 * that can disagree with the array it describes, and this programme has
 * repeatedly shipped comments that outlived the belief behind them.
 */
export function declarationStatus(
  declaration: readonly AuthorityDeclaration[] = RECEIPT_AUTHORITY_DECLARATION
): DeclarationStatus {
  return declaration.length === 0 ? "PENDING_218C_TABLE_FREEZE" : "BOUND";
}

/** The named forms this analyzer refuses rather than pretends to understand. */
export type UnsupportedForm =
  /** The write call has no first argument at all (it would not compile). */
  | "no-argument"
  /** `insert(<expr>, …)` whose first argument's type is not a string literal. */
  | "insert-table-name-not-statically-known"
  /** `patch|replace|delete(<expr>)` whose type carries no `__tableName` brand. */
  | "id-type-carries-no-table-brand"
  /** The `__tableName` brand exists but is not a string-literal type. */
  | "id-table-brand-not-statically-known"
  /** `writer[<expr>](…)` where `<expr>` does not name one method statically. */
  | "write-method-not-statically-known";

export type TableResolution =
  | { readonly kind: "RESOLVED"; readonly tables: readonly string[] }
  | { readonly kind: "UNPROVEN"; readonly form: UnsupportedForm };

export interface DbWriteSite {
  /** Repository-relative POSIX path (or the virtual file name in fixtures). */
  readonly file: string;
  /** 1-based line of the call. */
  readonly line: number;
  /**
   * `"unknown"` when the call is `writer[expr](…)` and `expr` is not a
   * statically known method name. Such a call may be any of the four writes,
   * so it is recorded rather than dropped.
   */
  readonly method: DbWriteMethod | "unknown";
  readonly resolution: TableResolution;
  /** Single-line, truncated call text, for the failure report only. */
  readonly snippet: string;
}

export type SiteVerdict =
  /** Resolved, and no resolved table is declared authority. */
  | { readonly verdict: "UNRELATED" }
  /** Resolved to a declared authority table, from that table's owner module. */
  | { readonly verdict: "AUTHORIZED"; readonly tables: readonly string[] }
  /** Resolved to a declared authority table, from any other module. */
  | { readonly verdict: "VIOLATION"; readonly tables: readonly string[] }
  /** Not resolved. Cannot be cleared, so it is refused. */
  | { readonly verdict: "UNPROVEN"; readonly form: UnsupportedForm };

export interface SiteFinding {
  readonly site: DbWriteSite;
  readonly verdict: SiteVerdict;
}

/** A parsed program plus the exact set of files this guard is responsible for. */
export interface AnalyzerProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** `[sourceFile, reportedName]` for every analysed file, in a stable order. */
  readonly analysed: readonly (readonly [ts.SourceFile, string])[];
}

/* ------------------------------------------------------------------------- *
 * Program construction
 * ------------------------------------------------------------------------- */

/**
 * The real backend, typechecked exactly the way `pnpm typecheck:convex` does.
 *
 * `convex/tsconfig.json` is used rather than a hand-rolled option set so the
 * guard cannot drift into resolving types under settings the repository does
 * not actually compile with.
 */
export function createConvexAnalyzerProgram(repoRoot: string): AnalyzerProgram {
  const configPath = path.join(repoRoot, "convex", "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`could not read ${configPath}`);

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const convexRoot = path.join(repoRoot, "convex");

  const analysed: (readonly [ts.SourceFile, string])[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const absolute = path.resolve(sf.fileName);
    if (!absolute.startsWith(path.resolve(convexRoot) + path.sep)) continue;
    const name = path.relative(repoRoot, absolute).split(path.sep).join("/");
    if (name.includes("/_generated/")) continue;
    if (name.endsWith(".test.ts")) continue;
    analysed.push([sf, name]);
  }
  analysed.sort((a, b) => compareStrings(a[1], b[1]));

  return { program, checker: program.getTypeChecker(), analysed };
}

/**
 * An in-memory program, used by the suite instead of fixture files on disk.
 *
 * Fixture files under `scripts/` would be indexed by Sonar as uncovered main
 * code (`sonar.coverage.exclusions` does not exclude `scripts/**`), linted,
 * and typechecked by the root `tsconfig.json` — three unrelated gates reacting
 * to source that exists only to be rejected by this guard. Holding them in
 * memory keeps the fixtures adversarial without paying any of that.
 *
 * Relative imports between virtual files resolve against the same map, so a
 * fixture can prove cross-module resolution (a helper in one file returning an
 * `Id` that another file deletes).
 */
export function createVirtualAnalyzerProgram(
  files: Readonly<Record<string, string>>
): AnalyzerProgram {
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  };

  const host = ts.createCompilerHost(options, true);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const virtual = files[fileName];
    if (virtual !== undefined) {
      return ts.createSourceFile(fileName, virtual, languageVersion, true, ts.ScriptKind.TS);
    }
    return baseGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) => fileName in files || baseFileExists(fileName);
  host.readFile = (fileName) => files[fileName] ?? baseReadFile(fileName);
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (fileName) => fileName;

  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map((literal) => {
      const request = literal.text;
      if (!request.startsWith(".")) return { resolvedModule: undefined };
      const base = path.posix.join(path.posix.dirname(containingFile), request);
      for (const candidate of [base, `${base}.ts`, base.replace(/\.js$/, ".ts")]) {
        if (candidate in files) {
          return {
            resolvedModule: {
              resolvedFileName: candidate,
              extension: ts.Extension.Ts,
              isExternalLibraryImport: false,
            },
          };
        }
      }
      return { resolvedModule: undefined };
    });

  const rootNames = Object.keys(files);
  const program = ts.createProgram({ rootNames, options, host });
  const analysed = rootNames
    .map((name) => [program.getSourceFile(name), name] as const)
    .filter((entry): entry is readonly [ts.SourceFile, string] => entry[0] !== undefined);

  return { program, checker: program.getTypeChecker(), analysed };
}

/* ------------------------------------------------------------------------- *
 * Detection
 * ------------------------------------------------------------------------- */

/**
 * Is this expression's type a Convex database WRITER?
 *
 * Two accepted proofs, deliberately:
 *
 * 1. the type's symbol is named `…DatabaseWriter` — the real
 *    `GenericDatabaseWriter<DataModel>` behind `ctx.db`; or
 * 2. it structurally exposes all four write methods.
 *
 * (2) is what makes the check independent of Convex's internal naming and lets
 * an in-memory fixture declare its own minimal writer interface. It also keeps
 * `Map.delete`, `Set.delete` and every `.insert`-named method on an unrelated
 * object out — none of them carry all four.
 *
 * A READER (`ctx.db` inside a query) has no `insert`/`patch`/`replace`/`delete`
 * and so is correctly invisible: a query cannot write.
 */
function isDatabaseWriterType(checker: ts.TypeChecker, type: ts.Type): boolean {
  const symbolName = type.getSymbol()?.getName() ?? "";
  if (symbolName.endsWith("DatabaseWriter")) return true;
  return DB_WRITE_METHODS.every((m) => checker.getPropertyOfType(type, m) !== undefined);
}

/**
 * Deterministic, locale-independent string ordering.
 *
 * ⚠️ DELIBERATELY NOT `localeCompare`, WHICH SONAR SUGGESTS. Every ordered
 * result this guard produces is compared against another ordered result — the
 * type-aware site set against the syntactic one, the pinned generic-writer map
 * against the measured one. `localeCompare` orders by the runner's ICU
 * collation, which can differ between a developer machine and a CI image, so a
 * guard that sorted that way could disagree with itself across environments.
 * Code-unit order is the same everywhere.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Every string-literal constituent of a type, or `null` if any is not one. */
function stringLiteralsOf(type: ts.Type): string[] | null {
  const out = new Set<string>();
  const visit = (t: ts.Type): boolean => {
    if (t.isUnion()) return t.types.every(visit);
    if (t.isStringLiteral()) {
      out.add(t.value);
      return true;
    }
    return false;
  };
  return visit(type) && out.size > 0 ? [...out].sort(compareStrings) : null;
}

/**
 * The table(s) an `Id`-typed expression can address.
 *
 * ⚠️ THIS IS THE WHOLE POINT OF THE TICKET. `ctx.db.delete(id)` names no
 * table; `Id<"x">` is `string & { __tableName: "x" }`, so the table is the
 * type of the `__tableName` property. Reading it off the TYPE rather than the
 * text is what makes an alias, a destructured binding, a helper return value,
 * a `Doc<T>["_id"]` and a union of ids all resolve identically.
 *
 * ⚠️ `getPropertyOfType` + `getTypeOfSymbol` RATHER THAN THE ONE-CALL
 * `getTypeOfPropertyOfType`. The single-call form exists at runtime and works,
 * but TypeScript 6.0.3 does not declare it on the public `TypeChecker` — it
 * only compiled here because the first draft was never typechecked, and `tsc`
 * caught it. A guard whose green result is an authorization must not rest on
 * an undeclared internal API that a compiler upgrade can remove.
 */
function tablesFromIdType(checker: ts.TypeChecker, type: ts.Type): TableResolution {
  const brands: ts.Type[] = [];
  const collectBrand = (t: ts.Type): boolean => {
    if (t.isUnion()) return t.types.every(collectBrand);
    const brand = checker.getPropertyOfType(t, "__tableName");
    if (!brand) return false;
    brands.push(checker.getTypeOfSymbol(brand));
    return true;
  };
  if (!collectBrand(type)) return { kind: "UNPROVEN", form: "id-type-carries-no-table-brand" };

  const tables = new Set<string>();
  for (const brand of brands) {
    const literals = stringLiteralsOf(brand);
    if (!literals) return { kind: "UNPROVEN", form: "id-table-brand-not-statically-known" };
    for (const literal of literals) tables.add(literal);
  }
  return { kind: "RESOLVED", tables: [...tables].sort(compareStrings) };
}

/**
 * The table an `insert` addresses.
 *
 * The syntactic literal is preferred because it is exact and cheap; the TYPE
 * is the fallback, and it is strictly stronger — it resolves a `const`-bound
 * table name and a conditional union of names that no text scan can read. A
 * template literal WITH a substitution widens to `string` and is refused.
 */
function tablesFromInsertArgument(
  checker: ts.TypeChecker,
  argument: ts.Expression
): TableResolution {
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return { kind: "RESOLVED", tables: [argument.text] };
  }
  const literals = stringLiteralsOf(checker.getTypeAtLocation(argument));
  return literals
    ? { kind: "RESOLVED", tables: literals }
    : { kind: "UNPROVEN", form: "insert-table-name-not-statically-known" };
}

type ResolvedWriteMethod =
  | { readonly kind: "WRITE"; readonly method: DbWriteMethod }
  | { readonly kind: "NOT_A_WRITE" }
  | { readonly kind: "UNKNOWN" };

/**
 * Which of the four operations is being called — including through a bracket.
 *
 * ⚠️ `ctx.db["delete"](id)` IS A DELETE, AND A PROPERTY-ACCESS-ONLY ANALYZER
 * CANNOT SEE IT. That spelling is legal TypeScript, compiles identically, and
 * would have walked straight past the first version of this file. It is the
 * same class of hole as the single-quoted `insert('organizations', …)` that
 * defeated `commitmentWriteGuard`'s regex, one syntax node over.
 *
 * The bracket's contents are read from the TYPE, so a `const` binding resolves
 * as well as a literal. Anything that does not name exactly one method — a
 * conditional, a `string`-typed variable — is UNKNOWN and therefore refused:
 * on a database writer, an unreadable method name may be any of the four.
 */
function resolveWriteMethod(
  checker: ts.TypeChecker,
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression
): ResolvedWriteMethod {
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    return (DB_WRITE_METHODS as readonly string[]).includes(name)
      ? { kind: "WRITE", method: name as DbWriteMethod }
      : { kind: "NOT_A_WRITE" };
  }

  const names = stringLiteralsOf(checker.getTypeAtLocation(callee.argumentExpression));
  if (!names) return { kind: "UNKNOWN" };
  const writes = names.filter((name) => (DB_WRITE_METHODS as readonly string[]).includes(name));
  if (writes.length === 0) return { kind: "NOT_A_WRITE" };
  return names.length === 1 ? { kind: "WRITE", method: writes[0] as DbWriteMethod } : { kind: "UNKNOWN" };
}

/**
 * Is this call worth typing further — is its receiver a Convex database writer?
 *
 * The property-access pre-filter is a cost decision, not a correctness one: a
 * named property that is not one of the four cannot be a write, and typing
 * every `foo.bar()` in the backend is not free. A BRACKET access has no name in
 * the text, so it is always typed.
 */
function isWriterCallee(
  checker: ts.TypeChecker,
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression
): boolean {
  if (
    ts.isPropertyAccessExpression(callee) &&
    !(DB_WRITE_METHODS as readonly string[]).includes(callee.name.text)
  ) {
    return false;
  }
  return isDatabaseWriterType(checker, checker.getTypeAtLocation(callee.expression));
}

/** The table(s) a write addresses, or the named form that stops it resolving. */
function resolveTargetTables(
  checker: ts.TypeChecker,
  method: DbWriteMethod,
  argument: ts.Expression | undefined
): TableResolution {
  if (!argument) return { kind: "UNPROVEN", form: "no-argument" };
  if (method === "insert") return tablesFromInsertArgument(checker, argument);
  return tablesFromIdType(checker, checker.getTypeAtLocation(argument));
}

/** The method name a callee SPELLS, with no type information consulted. */
function spelledMethodName(
  callee: ts.PropertyAccessExpression | ts.ElementAccessExpression
): string {
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isStringLiteralLike(callee.argumentExpression)
    ? callee.argumentExpression.text
    : "unknown";
}

function snippetOf(node: ts.Node): string {
  return node.getText().replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Every database write in the analysed set, with its target table resolved.
 *
 * The traversal is over the whole file, at every depth: a write nested inside
 * a callback, a conditional, a loop or a nested function is still a write.
 */
export function collectDbWriteSites(analyzer: AnalyzerProgram): DbWriteSite[] {
  const { checker } = analyzer;
  const sites: DbWriteSite[] = [];

  for (const [sourceFile, name] of analyzer.analysed) {
    const record = (call: ts.CallExpression): void => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;
      if (!isWriterCallee(checker, callee)) return;

      const resolved = resolveWriteMethod(checker, callee);
      if (resolved.kind === "NOT_A_WRITE") return;

      const at = (method: DbWriteSite["method"], resolution: TableResolution): DbWriteSite => ({
        file: name,
        line: sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1,
        method,
        resolution,
        snippet: snippetOf(call),
      });

      sites.push(
        resolved.kind === "UNKNOWN"
          ? at("unknown", { kind: "UNPROVEN", form: "write-method-not-statically-known" })
          : at(resolved.method, resolveTargetTables(checker, resolved.method, call.arguments[0]))
      );
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) record(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return sites;
}

/**
 * An INDEPENDENT, type-free detector of the same call sites.
 *
 * ⚠️ THIS IS A POSITIVE CONTROL, NOT A SECOND GUARD. A type-aware analyzer
 * fails in a uniquely quiet way: if receiver recognition breaks, it reports
 * zero sites, finds zero violations and exits green — indistinguishable from a
 * clean backend. Pinning a hard-coded site count would catch that but would
 * also fail on every unrelated pull request that adds a `ctx.db.patch`.
 *
 * So the suite instead asserts that this purely syntactic set and the
 * type-resolved set are IDENTICAL on the real backend. It is self-updating,
 * and it fails the moment the type-aware pass stops seeing source the plain
 * syntax tree can see.
 */
export function syntacticDbWriteCallSites(analyzer: AnalyzerProgram): string[] {
  const found: string[] = [];
  for (const [sourceFile, name] of analyzer.analysed) {
    const visit = (node: ts.Node): void => {
      const callee = ts.isCallExpression(node) ? node.expression : undefined;
      if (callee && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        // Bracket calls are read here too, so the two passes stay comparable:
        // a literal names its method, anything else is `unknown`.
        const method = spelledMethodName(callee);
        const receiver = callee.expression.getText().trim();
        const isWriteName =
          (DB_WRITE_METHODS as readonly string[]).includes(method) || method === "unknown";
        if (isWriteName && /(^|\.)db$/.test(receiver)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          found.push(`${name}:${line}:${method}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found.sort(compareStrings);
}

/* ------------------------------------------------------------------------- *
 * Classification
 * ------------------------------------------------------------------------- */

/**
 * ⚠️ A SITE THAT RESOLVES TO SEVERAL TABLES IS JUDGED ON THE WORST OF THEM.
 *
 * `Id<"a"> | Id<"b">` and a generic `Id<TableNames>` both resolve to a SET.
 * If any member is a declared authority table, this call can address authority
 * data, and a non-owner module holding it is a violation — the union is not a
 * reason to clear it.
 */
export function classifyWriteSite(
  site: DbWriteSite,
  declaration: readonly AuthorityDeclaration[]
): SiteVerdict {
  const resolution = site.resolution;
  if (resolution.kind === "UNPROVEN") return { verdict: "UNPROVEN", form: resolution.form };

  const matched = declaration.filter((entry) => resolution.tables.includes(entry.table));
  if (matched.length === 0) return { verdict: "UNRELATED" };

  const unauthorized = matched.filter((entry) => entry.ownerModule !== site.file);
  return unauthorized.length > 0
    ? { verdict: "VIOLATION", tables: unauthorized.map((entry) => entry.table).sort(compareStrings) }
    : { verdict: "AUTHORIZED", tables: matched.map((entry) => entry.table).sort(compareStrings) };
}

export interface AuthorityAuditCoverage {
  readonly modulesAnalysed: number;
  readonly writeSites: number;
  readonly byMethod: Readonly<Record<DbWriteMethod | "unknown", number>>;
  readonly resolvedSites: number;
  readonly unprovenSites: number;
  /** Sites whose id/table type resolved to more than one candidate table. */
  readonly multiTableSites: number;
}

export interface AuthorityAuditResult {
  readonly declarationStatus: DeclarationStatus;
  readonly declaredTables: number;
  readonly sites: readonly DbWriteSite[];
  readonly violations: readonly SiteFinding[];
  readonly authorized: readonly SiteFinding[];
  readonly unproven: readonly SiteFinding[];
  readonly coverage: AuthorityAuditCoverage;
}

export function auditAuthorityWrites(
  analyzer: AnalyzerProgram,
  declaration: readonly AuthorityDeclaration[] = RECEIPT_AUTHORITY_DECLARATION
): AuthorityAuditResult {
  const sites = collectDbWriteSites(analyzer);
  const violations: SiteFinding[] = [];
  const authorized: SiteFinding[] = [];
  const unproven: SiteFinding[] = [];

  const byMethod: Record<DbWriteMethod | "unknown", number> = {
    insert: 0,
    patch: 0,
    replace: 0,
    delete: 0,
    unknown: 0,
  };
  let resolvedSites = 0;
  let multiTableSites = 0;

  for (const site of sites) {
    byMethod[site.method] += 1;
    if (site.resolution.kind === "RESOLVED") {
      resolvedSites += 1;
      if (site.resolution.tables.length > 1) multiTableSites += 1;
    }
    const verdict = classifyWriteSite(site, declaration);
    if (verdict.verdict === "VIOLATION") violations.push({ site, verdict });
    else if (verdict.verdict === "AUTHORIZED") authorized.push({ site, verdict });
    else if (verdict.verdict === "UNPROVEN") unproven.push({ site, verdict });
  }

  return {
    declarationStatus: declarationStatus(declaration),
    declaredTables: declaration.length,
    sites,
    violations,
    authorized,
    unproven,
    coverage: {
      modulesAnalysed: analyzer.analysed.length,
      writeSites: sites.length,
      byMethod,
      resolvedSites,
      unprovenSites: unproven.length,
      multiTableSites,
    },
  };
}

/** Human-readable failure text. Empty string when the audit is clean. */
export function formatAuthorityAuditFailure(result: AuthorityAuditResult): string {
  const lines: string[] = [];

  if (result.violations.length > 0) {
    lines.push(
      `${result.violations.length} unauthorized write(s) to declared authority table(s):`
    );
    for (const { site, verdict } of result.violations) {
      const tables = verdict.verdict === "VIOLATION" ? verdict.tables.join(", ") : "";
      lines.push(`  ${site.file}:${site.line}  ${site.method} -> ${tables}   ${site.snippet}`);
    }
  }

  if (result.unproven.length > 0) {
    lines.push(
      `${result.unproven.length} write(s) whose target table cannot be proven. This guard is`,
      "fail-closed and has no allowlist: give the id/table a statically known type, or amend",
      "the guard deliberately."
    );
    for (const { site, verdict } of result.unproven) {
      const form = verdict.verdict === "UNPROVEN" ? verdict.form : "";
      lines.push(`  ${site.file}:${site.line}  ${site.method} [${form}]   ${site.snippet}`);
    }
  }

  return lines.join("\n");
}

/**
 * Convenience entry point for the suite and for any future CI wiring.
 *
 * Kept separate from `auditAuthorityWrites` so tests can build one program and
 * audit it many times with different declarations without paying for the
 * program twice — it takes roughly three seconds to build and eleven to scan.
 */
export function auditConvexAuthorityWrites(
  repoRoot: string,
  declaration: readonly AuthorityDeclaration[] = RECEIPT_AUTHORITY_DECLARATION
): AuthorityAuditResult {
  return auditAuthorityWrites(createConvexAnalyzerProgram(repoRoot), declaration);
}
