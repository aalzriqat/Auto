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
 * ⚠️ IT LOOKS FOR CANDIDATES AND REFUSES WHAT IT CANNOT CLEAR. It does not look
 * for writes and skip what it fails to recognise. That inversion is the whole
 * lesson of two review rounds: the previous design had MANY quiet exits —
 * receiver not structurally a writer, escape not a known write method,
 * destructuring key not an identifier, no member access at all — and every hole
 * found in those rounds was one of them. Eleven distinct spellings produced no
 * site whatsoever, each with zero compiler diagnostics.
 *
 * **There is now exactly one quiet exit: a member name POSITIVELY PROVEN not to
 * be one of the four.** A statically known name that is not `insert`, `patch`,
 * `replace` or `delete`; or a numeric, bigint or symbol index, which cannot name
 * one of them. Everything else becomes a site, and every uncertainty in a site
 * becomes UNPROVEN.
 *
 * **A database write member is recognised by its SIGNATURE, not by its object.**
 * The question is asked of the member — is it one of the four names, and does
 * its signature actually handle a Convex `Id`, in a parameter or as what it
 * returns? That is what a Convex write *is*. It survives every narrowing, so
 * `Pick<Writer, "delete">` from a capability helper, a delete-only view, and each
 * constituent of a `Writer | DeleteOnly` union are all caught — none of which
 * the old "does the receiver expose all four methods" test could see. It also
 * keeps `Map.delete(key: string)` and a cache out for a reason rather than by
 * luck: they name one of the four but never touch an `Id`.
 *
 * The table is then resolved:
 *
 * - `insert` — from the first argument's static string-literal type (a plain
 *              literal, a `const`-bound name, or a union of literals), falling
 *              back to the call's own `Promise<Id<T>>` return type, which is how
 *              a table-scoped writer's `insert(value)` names its table.
 * - `patch` / `replace` / `delete` — from the `__tableName` brand carried by
 *              whichever ARGUMENT has one. By brand, not by position: Convex
 *              also ships table-name-first overloads, and assuming argument 0
 *              reported every one of them as unprovable.
 *
 * The operation is resolved the same way. `ctx.db["delete"](id)` is legal
 * TypeScript that compiles identically and is invisible to any analyzer reading
 * only property accesses; the bracket is read from its type, so a `const`
 * binding resolves as well as a literal. A bracket naming more than one method
 * is UNPROVEN.
 *
 * An unreadable RECEIVER — `(ctx.db as any).delete(id)` — is UNPROVEN, never
 * dropped. And a write method taken as a VALUE (a rename or computed
 * destructure, an assignment destructure, `.call`, `.bind`, a higher-order
 * helper, `Reflect.get`) has no member access at its eventual call site at all;
 * following it needs dataflow this guard does not do, so the ESCAPE itself is
 * reported. The reference is where the proof stops, and stopping is refused.
 *
 * It then classifies each resolved site against the declaration below: a write
 * to a declared authority table from any module other than that table's owner
 * is a VIOLATION, unless a narrow lifecycle exception names that module, that
 * operation, and resolves to that exact table.
 *
 * ## ⚠️ IT IS FAIL-CLOSED, AND THERE IS DELIBERATELY NO ALLOWLIST
 *
 * A site whose table cannot be proven is reported as UNPROVEN and fails the
 * guard. It is not skipped, and it is not silently counted as safe.
 *
 * That policy was MEASURED before it was chosen, not assumed affordable. At
 * `bf5769ed1` the analysed set is 228 non-generated, non-test modules holding
 * 853 write sites (patch 499, insert 291, delete 63, replace 0), and every
 * single one resolves to a concrete table: zero unproven, zero unreadable
 * receivers, zero escaping method references, zero reflective retrievals. So
 * fail-closed costs nothing today and a NEW unresolvable form fails CI rather
 * than quietly shrinking the analysed surface.
 *
 * Five of those 63 deletes are `ctx.storage.delete(id)`. Storage is not a table
 * write, but its id IS an `Id<"_storage">`, so the same rule resolves it and it
 * is reported rather than special-cased. Pinned by a test, because a surprise in
 * a coverage number should be read, not absorbed.
 *
 * No burn-down allowlist is provided on purpose. A green result from this file
 * is an AUTHORIZATION, and an allowlist is the mechanism by which such a
 * result stops meaning anything. If a genuinely dynamic write is ever needed,
 * that is a deliberate amendment to this guard with its own review — not an
 * entry someone adds to make a build pass.
 *
 * ## ⚠️ RECORDED SCOPE BOUNDARIES — read these before quoting a green run
 *
 * 1. `**\/*.test.ts`, `convex/_generated/**` and `test-utils/**` are NOT
 *    analysed. A test that inserts an authority row directly is fixture setup,
 *    not a production authority violation, and `test-utils/**` is the harness
 *    that does it — verified, not assumed, to be imported by no non-test module
 *    under `convex/`. Everything else the program contains IS analysed,
 *    including `lib/**` and `packages/**`: the earlier `convex/`-only filter
 *    made a write in a shared helper invisible, which was a hole rather than a
 *    boundary.
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
 * A module granted ONE named operation on ONE authority table, and nothing else.
 *
 * The owner ruling (`SCRUM-238 c17710`) grants exactly two: `orgFinancialReset`
 * and `adminOrgs` may DELETE. Neither may insert, patch or replace, and no
 * other module — `customers.ts` explicitly included — gets any exception.
 */
export interface LifecycleException {
  /** Repository-relative POSIX path, compared exactly. */
  readonly module: string;
  readonly operations: readonly DbWriteMethod[];
}

/**
 * One authority table, the single module allowed to write it, and the narrow
 * lifecycle exceptions to that rule.
 *
 * `ownerModule` is a repository-relative POSIX path, compared exactly. A path
 * is used rather than a basename because two modules in different directories
 * may legitimately share a name, and "the owner" must be one file.
 */
export interface AuthorityDeclaration {
  readonly table: string;
  readonly ownerModule: string;
  readonly lifecycleExceptions?: readonly LifecycleException[];
}

/** SCRUM-218-C's declared owner of receipt/retained-position authority. */
const RECEIPT_AUTHORITY_OWNER = "convex/accounting/receiptMovement.ts";

/**
 * ⚠️ EXACT-TABLE DELETE, AND NOTHING ELSE.
 *
 * Org reset and org hard-delete legitimately remove rows during a lifecycle
 * sweep. They may not create, patch or replace one, so a receipt movement can
 * never be edited from outside its owner — only destroyed with its org.
 */
const LIFECYCLE_DELETE_ONLY: readonly LifecycleException[] = [
  { module: "convex/orgFinancialReset.ts", operations: ["delete"] },
  { module: "convex/adminOrgs.ts", operations: ["delete"] },
];

/**
 * ⚠️ THE TABLES ARE THE OWNER'S, NOT MINE, AND THEY DO NOT EXIST HERE YET.
 *
 * Fixed by owner ruling `SCRUM-238 c17710`. SCRUM-218-C creates these three
 * tables and `convex/accounting/receiptMovement.ts`; none of them exists on
 * this tooling-only branch, and 218-C production code is deliberately NOT
 * copied into this pull request.
 *
 * So the declaration is REAL but not yet RESOLVABLE here, and that distinction
 * is reported rather than left to be misread — `describeBinding` returns
 * `PENDING_218C_INTEGRATION` while the owner module is absent from the analysed
 * program. A green run of this guard on this branch therefore proves the
 * mechanism and proves every database write in the repository has a provable
 * target table. It does NOT prove receipt authority is enforced, because the
 * tables it names are not here to be written.
 *
 * Binding is verified in a temporary integration worktree against the corrected
 * 218-C successor, per the same ruling.
 */
export const RECEIPT_AUTHORITY_DECLARATION: readonly AuthorityDeclaration[] = [
  {
    table: "receiptMovements",
    ownerModule: RECEIPT_AUTHORITY_OWNER,
    lifecycleExceptions: LIFECYCLE_DELETE_ONLY,
  },
  {
    table: "receiptRetainedPositions",
    ownerModule: RECEIPT_AUTHORITY_OWNER,
    lifecycleExceptions: LIFECYCLE_DELETE_ONLY,
  },
  {
    table: "receiptApplications",
    ownerModule: RECEIPT_AUTHORITY_OWNER,
    lifecycleExceptions: LIFECYCLE_DELETE_ONLY,
  },
];

export type BindingStatus = "BOUND" | "PENDING_218C_INTEGRATION" | "NOTHING_DECLARED";

export interface BindingReport {
  readonly status: BindingStatus;
  readonly declaredTables: readonly string[];
  /** Declared owner modules that ARE in the analysed program. */
  readonly ownerModulesPresent: readonly string[];
  /** Declared owner modules that are NOT — the reason binding is pending. */
  readonly ownerModulesMissing: readonly string[];
  /** Declared tables that some analysed module actually writes. */
  readonly declaredTablesWritten: readonly string[];
}

/**
 * Is the declaration actually pointed at anything in THIS program?
 *
 * ⚠️ THIS EXISTS SO A GREEN RUN CANNOT BE QUOTED AS ENFORCEMENT. A declaration
 * naming modules and tables that are absent produces no violations for the same
 * reason an empty declaration does — nothing to match — and the two are
 * indistinguishable from the exit code alone. This says which one it is.
 */
export function describeBinding(
  analyzer: AnalyzerProgram,
  declaration: readonly AuthorityDeclaration[] = RECEIPT_AUTHORITY_DECLARATION,
  sites?: readonly DbWriteSite[]
): BindingReport {
  const analysed = new Set(analyzer.analysed.map(([, name]) => name));
  const owners = [...new Set(declaration.map((entry) => entry.ownerModule))].sort(compareStrings);
  const present = owners.filter((module) => analysed.has(module));
  const missing = owners.filter((module) => !analysed.has(module));

  const declaredTables = declaration.map((entry) => entry.table).sort(compareStrings);
  const written = new Set<string>();
  for (const site of sites ?? collectDbWriteSites(analyzer)) {
    if (site.resolution.kind !== "RESOLVED") continue;
    for (const table of site.resolution.tables) {
      if (declaredTables.includes(table)) written.add(table);
    }
  }

  const status: BindingStatus =
    declaration.length === 0
      ? "NOTHING_DECLARED"
      : missing.length > 0
        ? "PENDING_218C_INTEGRATION"
        : "BOUND";

  return {
    status,
    declaredTables,
    ownerModulesPresent: present,
    ownerModulesMissing: missing,
    declaredTablesWritten: [...written].sort(compareStrings),
  };
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
  | "write-method-not-statically-known"
  /** The RECEIVER's type is `any`/`unknown`, so it cannot be cleared. */
  | "receiver-type-not-statically-known"
  /** A write method was taken as a VALUE; its eventual call site is unknown. */
  | "write-method-reference-escapes"
  /** `Reflect.get(writer, …)` — retrieval this analyzer cannot follow. */
  | "reflective-write-member-access";

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
  const root = path.resolve(repoRoot) + path.sep;
  const nodeModules = `${path.sep}node_modules${path.sep}`;

  const analysed: (readonly [ts.SourceFile, string])[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const absolute = path.resolve(sf.fileName);
    // ⚠️ EVERY REPOSITORY FILE IN THE PROGRAM, NOT ONLY `convex/`.
    //
    // This filter used to require the `convex/` prefix, and that was a hole
    // rather than a scope choice: a helper in `lib/` taking a `MutationCtx` and
    // calling `ctx.db.delete(id)` is compiled into this very program,
    // typechecks with zero diagnostics, and was invisible to the guard. Not a
    // hypothetical refactor either — ten `lib/` and `packages/shared` modules
    // are already imported by `convex/` today. None contains a database write
    // at this head, which is exactly why widening is free to do now.
    if (!absolute.startsWith(root) || absolute.includes(nodeModules)) continue;
    const name = path.relative(repoRoot, absolute).split(path.sep).join("/");
    if (name.includes("/_generated/")) continue;
    if (name.endsWith(".test.ts")) continue;
    // `test-utils/**` is test infrastructure — `convex/tsconfig.json` pulls it
    // in so the harness is typechecked, and it seeds rows the way a fixture
    // does. Verified rather than assumed: no non-test module under `convex/`
    // imports it. Named here so the exclusion is a decision, not an accident.
    if (name.startsWith("test-utils/")) continue;
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
 * Convex's `Id<T>` is `string & { __tableName: T }`. This property IS the brand.
 */
const TABLE_BRAND = "__tableName";

function isAnyOrUnknown(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Unknown) !== 0;
}

function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  const object = type as ts.ObjectType;
  if ((object.objectFlags & ts.ObjectFlags.Reference) === 0) return [];
  return checker.getTypeArguments(object as ts.TypeReference);
}

/**
 * Does this type carry the `Id` brand anywhere a signature could put it?
 *
 * Directly (`Id<"x">`), inside a union, or wrapped — `Promise<Id<"x">>` is how
 * `insert` returns one. Bounded depth, because a type graph can be cyclic.
 */
function carriesIdBrand(checker: ts.TypeChecker, type: ts.Type, depth = 0): boolean {
  if (depth > 3) return false;
  if (checker.getPropertyOfType(type, TABLE_BRAND) !== undefined) return true;
  if (type.isUnion() || type.isIntersection()) {
    return type.types.some((t) => carriesIdBrand(checker, t, depth + 1));
  }
  return typeArgumentsOf(checker, type).some((t) => carriesIdBrand(checker, t, depth + 1));
}

/**
 * Is `member` on `type` a DATABASE WRITE MEMBER?
 *
 * ⚠️ THIS REPLACED "does the receiver expose all four methods", AND THAT
 * REPLACEMENT IS THE POINT OF THIS ROUND.
 *
 * The all-four test was a property of the whole object, so every narrowing of
 * a writer escaped it: `Pick<Writer, "delete">` returned by a capability
 * helper, a delete-only view, and each constituent of a `Writer | DeleteOnly`
 * union all answered "not a writer" and their writes were dropped entirely —
 * eight such spellings were reproduced with zero compiler diagnostics.
 *
 * The question is asked of the MEMBER instead: is this one of the four names,
 * and does its signature actually handle a Convex `Id` — in a parameter, or as
 * what it returns? That is what a database write *is*. It survives every
 * narrowing, because narrowing does not change the member's signature.
 *
 * It also keeps the negatives out for a reason rather than by luck:
 * `Map.delete(key: string): boolean` and a cache's `delete(key: string)` name
 * one of the four but never touch an `Id`.
 *
 * ⚠️ The `…DatabaseWriter` symbol-name shortcut is GONE. It made the real
 * backend pass through a different code path from every fixture, so a break in
 * the shape test would have been invisible on real source while fixtures
 * caught it — the mutation battery showed exactly that asymmetry. One
 * mechanism now, exercised identically by both.
 */
function isDatabaseWriteMember(
  checker: ts.TypeChecker,
  type: ts.Type,
  member: DbWriteMethod
): boolean {
  const symbol = checker.getPropertyOfType(type, member);
  if (!symbol) return false;
  return checker
    .getTypeOfSymbol(symbol)
    .getCallSignatures()
    .some(
      (signature) =>
        signature
          .getParameters()
          .some((parameter) => carriesIdBrand(checker, checker.getTypeOfSymbol(parameter))) ||
        carriesIdBrand(checker, signature.getReturnType())
    );
}

/** Does this type expose ANY database write member? */
function hasAnyDatabaseWriteMember(checker: ts.TypeChecker, type: ts.Type): boolean {
  return DB_WRITE_METHODS.some((member) => isDatabaseWriteMember(checker, type, member));
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
 * The table(s) an `Id`-branded type can address.
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
    const brand = checker.getPropertyOfType(t, TABLE_BRAND);
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

/**
 * Can this index type be ruled out as a member name outright?
 *
 * A number, bigint or symbol index may well name a member — it just cannot name
 * one of the four. That is a POSITIVE proof of harmlessness, which is what the
 * invariant requires before anything exits quietly.
 */
function cannotNameAWriteMember(type: ts.Type): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  const notAName = ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike;
  return constituents.length > 0 && constituents.every((t) => (t.flags & notAName) !== 0);
}

type ResolvedWriteMethod =
  | { readonly kind: "WRITE"; readonly method: DbWriteMethod }
  | { readonly kind: "NOT_A_WRITE" }
  | { readonly kind: "UNKNOWN" };

/**
 * Which of the four operations a member access names — including a bracket.
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
 * on a database writer, an unreadable member name may be any of the four.
 *
 * ⚠️ `NOT_A_WRITE` IS THE ONLY QUIET EXIT IN THIS ANALYZER. A statically known
 * name that is not one of the four is the single case that leaves without a
 * site. Every other uncertainty becomes UNPROVEN. That rule exists because the
 * previous design had many quiet exits and every hole found in two review
 * rounds was one of them.
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

  const indexType = checker.getTypeAtLocation(callee.argumentExpression);
  const names = stringLiteralsOf(indexType);
  if (!names) {
    // ⚠️ THE ONLY QUIET EXIT, IN ITS SECOND FORM. A numeric, bigint or symbol
    // index POSITIVELY cannot name `insert`/`patch`/`replace`/`delete`, so it
    // is proven harmless rather than merely unrecognised. Without this the
    // guard reported `convJson.data?.[0]` — an array index into parsed JSON —
    // as an unreadable write, which is the kind of false positive that makes a
    // fail-closed rule unaffordable and gets it deleted.
    return cannotNameAWriteMember(indexType) ? { kind: "NOT_A_WRITE" } : { kind: "UNKNOWN" };
  }
  const writes = names.filter((name) => (DB_WRITE_METHODS as readonly string[]).includes(name));
  if (writes.length === 0) return { kind: "NOT_A_WRITE" };
  return names.length === 1 ? { kind: "WRITE", method: writes[0] as DbWriteMethod } : { kind: "UNKNOWN" };
}

/**
 * What the receiver of a write-named access is, as far as the checker can tell.
 *
 * ⚠️ `UNREADABLE` IS THE WHOLE REASON THIS IS NOT A BOOLEAN. A receiver typed
 * `any` — `(ctx.db as any).delete(id)`, or `const writer: any = ctx.db` —
 * answers "is this a database writer?" with neither yes nor no, and a boolean
 * version read that as "no" and DROPPED the access. Nothing was reported at
 * all: not a violation, not even unproven. `as any` is the canonical escape
 * hatch in TypeScript, so it is precisely the spelling a guard whose green
 * result is an authorization must refuse rather than ignore.
 */
type ReceiverVerdict = "WRITER" | "NOT_A_WRITER" | "UNREADABLE";

function classifyReceiver(
  checker: ts.TypeChecker,
  receiver: ts.Expression,
  method: ResolvedWriteMethod
): ReceiverVerdict {
  const type = checker.getTypeAtLocation(receiver);
  if (isAnyOrUnknown(type)) return "UNREADABLE";
  const isWriter =
    method.kind === "WRITE"
      ? isDatabaseWriteMember(checker, type, method.method)
      : hasAnyDatabaseWriteMember(checker, type);
  return isWriter ? "WRITER" : "NOT_A_WRITER";
}

/**
 * The table(s) a resolved write addresses.
 *
 * ⚠️ THE ID IS FOUND BY ITS BRAND, NOT BY ITS POSITION. Convex ships two
 * writer shapes: the classic `delete(id)` and a table-first `delete(table, id)`
 * overload, and a table-scoped writer whose `insert(value)` names no table at
 * all. Hard-coding "argument 0 is the id" reported every table-first call as
 * unprovable — fail-closed, but noisy enough to redden an unrelated pull
 * request for using valid Convex syntax. Scanning for the branded argument
 * resolves all of them, and falls back to the call's own return type for the
 * scoped insert, whose `Promise<Id<T>>` carries the brand.
 */
function resolveTargetTables(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  method: DbWriteMethod
): TableResolution {
  if (method === "insert") {
    const first = call.arguments[0];
    if (first) {
      const fromArgument = tablesFromInsertArgument(checker, first);
      if (fromArgument.kind === "RESOLVED") return fromArgument;
    }
    const returned = tablesFromIdType(checker, unwrapAwaited(checker, checker.getTypeAtLocation(call)));
    if (returned.kind === "RESOLVED") return returned;
    return first
      ? { kind: "UNPROVEN", form: "insert-table-name-not-statically-known" }
      : { kind: "UNPROVEN", form: "no-argument" };
  }

  if (call.arguments.length === 0) return { kind: "UNPROVEN", form: "no-argument" };

  // ⚠️ EVERY ARGUMENT IS ASKED, AND THE ASKING IS THE FILTER.
  //
  // An earlier version pre-checked `carriesIdBrand` and only then called
  // `tablesFromIdType`, which duplicated the "no brand here" answer in two
  // places and left the one inside `tablesFromIdType` UNREACHABLE — a mutation
  // that deleted it killed nothing, which is how the dead branch was found.
  // Asking directly removes the duplicate and keeps the refusal live.
  let unreadableBrand: TableResolution | null = null;
  for (const argument of call.arguments) {
    const resolution = tablesFromIdType(checker, checker.getTypeAtLocation(argument));
    if (resolution.kind === "RESOLVED") return resolution;
    // This argument IS the id — it carries a brand — but the brand does not
    // name a table statically. That is a more specific answer than "no
    // argument carried a brand", so it wins if nothing later resolves.
    if (resolution.form === "id-table-brand-not-statically-known") unreadableBrand = resolution;
  }
  return unreadableBrand ?? { kind: "UNPROVEN", form: "id-type-carries-no-table-brand" };
}

/** `Promise<T>` -> `T`, once. Enough for a Convex write's return type. */
function unwrapAwaited(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  if (type.getSymbol()?.getName() !== "Promise") return type;
  return typeArgumentsOf(checker, type)[0] ?? type;
}

/** The method name a member access SPELLS, with no type information consulted. */
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

/** `Reflect.get(writer, "delete")` and friends — retrieval this cannot follow. */
const REFLECTIVE_RETRIEVERS = new Set(["get", "apply", "getOwnPropertyDescriptor"]);

/**
 * Every database write in the analysed set, with its target table resolved.
 *
 * The traversal is over the whole file, at every depth: a write nested inside
 * a callback, a conditional, a loop or a nested function is still a write.
 *
 * ⚠️ THE SHAPE OF THIS FUNCTION IS THE LESSON OF TWO REVIEW ROUNDS. It does not
 * look for writes and skip what it does not recognise; it looks for CANDIDATES
 * and refuses what it cannot clear. A candidate leaves without a site in one
 * case only — a statically known member name that is not one of the four.
 */
export function collectDbWriteSites(analyzer: AnalyzerProgram): DbWriteSite[] {
  const { checker } = analyzer;
  const sites: DbWriteSite[] = [];

  for (const [sourceFile, name] of analyzer.analysed) {
    const at = (node: ts.Node, method: DbWriteSite["method"], resolution: TableResolution): void => {
      sites.push({
        file: name,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        method,
        resolution,
        snippet: snippetOf(node),
      });
    };

    const methodLabel = (resolved: ResolvedWriteMethod): DbWriteSite["method"] =>
      resolved.kind === "WRITE" ? resolved.method : "unknown";

    // ⚠️ THE METHOD IS RESOLVED BEFORE THE RECEIVER, AND THAT ORDER MATTERS.
    // A statically known name that is not one of the four clears the access
    // whatever its receiver is — so `(anything as any)["get"](id)` stays out,
    // while `(ctx.db as any).delete(id)` cannot be cleared and is refused.
    const record = (call: ts.CallExpression): void => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;

      const resolved = resolveWriteMethod(checker, callee);
      if (resolved.kind === "NOT_A_WRITE") return;

      const receiver = classifyReceiver(checker, callee.expression, resolved);
      if (receiver === "NOT_A_WRITER") return;
      if (receiver === "UNREADABLE") {
        at(call, methodLabel(resolved), {
          kind: "UNPROVEN",
          form: "receiver-type-not-statically-known",
        });
        return;
      }

      at(
        call,
        methodLabel(resolved),
        resolved.kind === "UNKNOWN"
          ? { kind: "UNPROVEN", form: "write-method-not-statically-known" }
          : resolveTargetTables(checker, call, resolved.method)
      );
    };

    /**
     * ⚠️ A WRITE METHOD TAKEN AS A VALUE NEVER REACHES `record`.
     *
     * `const { delete: removeRow } = ctx.db; await removeRow(id)` calls an
     * IDENTIFIER, so there is no member access at the call site to detect —
     * and because `delete` is a reserved word, that rename-destructure is the
     * ordinary way to hold a reference to it. `ctx.db.delete.call(…)`,
     * `.bind(…)`, `Reflect.get(ctx.db, "delete")`, a computed binding key, an
     * assignment destructure and passing the method to a higher-order helper
     * all escape the same way, and all were reproduced producing zero sites.
     *
     * Following the value to its eventual call sites needs dataflow this guard
     * does not do. So the ESCAPE itself is reported: the reference is where the
     * proof stops, and stopping is refused rather than skipped.
     */
    const recordEscape = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node) return;
        const resolved = resolveWriteMethod(checker, node);
        if (resolved.kind === "NOT_A_WRITE") return;
        const receiver = classifyReceiver(checker, node.expression, resolved);
        if (receiver === "NOT_A_WRITER") return;
        at(node, methodLabel(resolved), {
          kind: "UNPROVEN",
          form:
            receiver === "UNREADABLE"
              ? "receiver-type-not-statically-known"
              : "write-method-reference-escapes",
        });
        return;
      }

      // `const { delete: rm } = ctx.db` and `const { [op]: rm } = ctx.db`
      if (ts.isObjectBindingPattern(node)) {
        recordDestructuredMembers(node, checker.getTypeAtLocation(node), (element) =>
          element.propertyName ?? element.name
        );
        return;
      }

      // `({ delete: rm } = ctx.db)` — an assignment target, not a declaration.
      if (
        ts.isObjectLiteralExpression(node) &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.left === node
      ) {
        const source = checker.getTypeAtLocation(node.parent.right);
        if (isAnyOrUnknown(source) || hasAnyDatabaseWriteMember(checker, source)) {
          for (const property of node.properties) {
            reportMemberKey(property, property.name);
          }
        }
      }
    };

    function recordDestructuredMembers(
      pattern: ts.ObjectBindingPattern,
      sourceType: ts.Type,
      keyOf: (element: ts.BindingElement) => ts.Node | undefined
    ): void {
      if (!isAnyOrUnknown(sourceType) && !hasAnyDatabaseWriteMember(checker, sourceType)) return;
      for (const element of pattern.elements) {
        reportMemberKey(element, keyOf(element));
      }
    }

    /** One destructured key: refuse it unless its name proves it harmless. */
    function reportMemberKey(node: ts.Node, key: ts.Node | undefined): void {
      const spelled =
        key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : null;
      if (spelled !== null && !(DB_WRITE_METHODS as readonly string[]).includes(spelled)) return;
      at(node, (spelled as DbWriteMethod | null) ?? "unknown", {
        kind: "UNPROVEN",
        form: "write-method-reference-escapes",
      });
    }

    /** `Reflect.get(ctx.db, "delete")` — a retrieval with no member access. */
    const recordReflection = (call: ts.CallExpression): void => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee)) return;
      if (!REFLECTIVE_RETRIEVERS.has(callee.name.text)) return;
      const target = call.arguments[0];
      if (!target) return;
      const type = checker.getTypeAtLocation(target);
      if (isAnyOrUnknown(type) || !hasAnyDatabaseWriteMember(checker, type)) return;
      at(call, "unknown", { kind: "UNPROVEN", form: "reflective-write-member-access" });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        record(node);
        recordReflection(node);
      } else {
        recordEscape(node);
      }
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
/**
 * Is this exact write permitted on this exact table?
 *
 * The owner module may do anything. Everyone else needs a lifecycle exception
 * naming their module AND this operation — and it must be an EXACT-TABLE write.
 *
 * ⚠️ A SITE THAT RESOLVES TO A SET OF TABLES IS NOT AN EXACT-TABLE WRITE, AND
 * THAT IS THE FAIL-CLOSED READING OF "exact-table DELETE-only". The generic
 * sweeps in `orgFinancialReset` and `adminOrgs` delete through an
 * `Id<TableNames>` that resolves to every table in the schema, so under this
 * reading their exception does not cover those sites and they are reported.
 * That is a real question for the owner at binding time, not a decision this
 * analyzer should take quietly — so it is fail-closed here, visible in the
 * suite, and a one-line change if ruled otherwise.
 */
function permits(
  entry: AuthorityDeclaration,
  site: DbWriteSite,
  resolvedTables: readonly string[]
): boolean {
  if (entry.ownerModule === site.file) return true;
  const exception = entry.lifecycleExceptions?.find((granted) => granted.module === site.file);
  if (!exception) return false;
  if (site.method === "unknown") return false;
  if (!exception.operations.includes(site.method)) return false;
  return resolvedTables.length === 1;
}

export function classifyWriteSite(
  site: DbWriteSite,
  declaration: readonly AuthorityDeclaration[]
): SiteVerdict {
  const resolution = site.resolution;
  if (resolution.kind === "UNPROVEN") return { verdict: "UNPROVEN", form: resolution.form };

  const matched = declaration.filter((entry) => resolution.tables.includes(entry.table));
  if (matched.length === 0) return { verdict: "UNRELATED" };

  const unauthorized = matched.filter((entry) => !permits(entry, site, resolution.tables));
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
  readonly binding: BindingReport;
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
    binding: describeBinding(analyzer, declaration, sites),
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
