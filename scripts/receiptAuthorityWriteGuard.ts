/**
 * SCRUM-238 (SCRUM-218-E) — structural guard for writes to declared authority
 * tables, recognised by DECLARATION PROVENANCE.
 *
 * ## Why this file exists at all
 *
 * SCRUM-218's closure `6d2fb9e9e` promised repository-structural enforcement
 * for unauthorized `insert`/`patch`/`replace`/`delete` writes to receipt
 * authority, and review (`SCRUM-218 c17516`) proved a source-text analyzer
 * could not express the delete case:
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
 * so the table is recoverable — but only from a real `ts.Program` and
 * `TypeChecker`. This is that work. It does not modify, replace or subsume
 * `scripts/commitmentWriteGuard.ts` or `scripts/tenantWriteGuard.ts`.
 *
 * ## ⚠️ THIS IS THE THIRD RECOGNITION ARCHITECTURE. THE FIRST TWO FAILED.
 *
 * Both earlier versions asked a question about the LOCAL TYPE SHAPE of the
 * receiver, and both were defeated — in opposite directions — because under
 * TypeScript's structural typing, shape does not determine identity:
 *
 * - "the receiver exposes all four write methods" was defeated by
 *   `Pick<Writer, "delete">`, a delete-only view and a `Writer | DeleteOnly`
 *   union. FALSE NEGATIVES.
 * - "the member's signature handles an `Id`" was defeated by
 *   `const w: WeakDelete = ctx.db` — plain widening, no cast, no diagnostic —
 *   and by a member behind an index signature. FALSE NEGATIVES.
 * - the same rule reported `new Set<Id<"receiptMovements">>().delete(id)` as an
 *   unauthorized authority write, because `Set<T>.delete(value: T)` is a member
 *   named `delete` whose parameter carries the brand. A FALSE POSITIVE.
 *
 * A brand can be ERASED by an ordinary assignment TypeScript accepts silently,
 * and CARRIED by something that is not a database at all. Eleven zero-site
 * spellings were reproduced across three review rounds and the convergence
 * breaker fired twice. Owner ruling `SCRUM-238 c17726` authorized one
 * architecture reset, which is this file.
 *
 * ## What it asks instead: WHERE IS THIS DECLARED?
 *
 * Recognition is grounded in declaration sites, which a repository author
 * cannot imitate. Writer recognition and table resolution are separate proofs
 * and are never combined again.
 *
 * **Proof 1 — is this call a Convex database write?** Two positive answers:
 *
 * - **P1, member provenance.** `checker.getResolvedSignature(call)` resolves to
 *   a declaration inside the `convex` package. That is what a Convex write IS,
 *   and it survives every narrowing, alias and structural view, because
 *   narrowing does not move a declaration. It is also what catches the eleven
 *   writes in `convex/aggregates.ts` and `convex/utils/materialization.ts`
 *   whose helper parameters are spelled
 *   `ctx: { db: GenericDatabaseWriter<DataModel> }` — real writes with no
 *   `ctx.db` root anywhere in the function.
 * - **P2, root provenance.** The receiver is `ctx.db` / `ctx.storage` whose
 *   PROPERTY SYMBOL is declared in the `convex` package, or a `const` alias of
 *   one.
 *
 * **The quiet exits, all three positive:**
 *
 * - a statically known member name that is not one of the four;
 * - a numeric, bigint or symbol index, which cannot name one of the four;
 * - a resolved signature declared in a TypeScript standard library
 *   (`lib.*.d.ts`). That is what clears `Set<Id<T>>.delete`, `Map.delete` and
 *   the 79 `String.replace` calls in the analysed set — positively, by where
 *   `Set.prototype.delete` is declared, not by inspecting its signature.
 *
 * **Proof 2 — which table.** Only once a call is a proven Convex write:
 * `insert` from its first argument's string-literal type, falling back to the
 * call's own `Promise<Id<T>>`; `patch`/`replace`/`delete` from the
 * `__tableName` brand carried by whichever ARGUMENT has one — by brand rather
 * than by a fixed argument position, which also resolves Convex's table-scoped
 * `db.table(name)` writer, whose `insert(value)` names no table at all and is
 * recovered from its `Promise<GenericId<T>>` return type instead.
 *
 * ## ⚠️ WHAT LETS A REPOSITORY-DECLARED METHOD BE CLEARED
 *
 * A method declared OUTSIDE the convex package is cleared at the call, and two
 * independent things have to hold before that is safe.
 *
 * **1. The erasure report.** A conversion of a root-derived value into a type
 * the convex package does not declare is reported where it happens:
 *
 * ```ts
 * const w: WeakDelete = ctx.db;   // reported HERE, at the widening
 * await w.delete(id);             // the call itself is not recognisable
 * ```
 *
 * **2. Suspicion at the call, from the member AND from the arguments.**
 *
 * ⚠️ THE FIRST DRAFT CLAIMED (1) ALONE WAS SUFFICIENT, AND THAT WAS FALSE.
 * Root tracking follows `const` alias chains; it does not follow an array
 * element, an object property, an inferred return or a `let`. I reproduced all
 * four laundering the same writer into `{ delete(id: string) }` and producing
 * **zero sites** — no violation, not even unproven — with the justification for
 * clearing sitting in this header the whole time.
 *
 * What the analyzer could always see is the CALL: `w.delete(movementId)` hands
 * a branded Convex `Id` to something named `delete`. So a repository-declared
 * member is cleared only when neither its signature nor any argument involves a
 * Convex id. That is not proof of a write, so such a call is UNPROVEN rather
 * than a violation — but it is never silence.
 *
 * The two are deliberately not the same test. (1) fires on the conversion even
 * when no write follows; (2) fires on the call even when the conversion was
 * invisible.
 *
 * Two non-invoking uses of a root are cleared positively, because neither can
 * reach a member: the right operand of `in` (`"insert" in ctx.db`, which occurs
 * in `convex/utils/tenancy.ts`) and `typeof`.
 *
 * A write method taken as a VALUE — a rename or computed destructure, an
 * assignment destructure, `.call`, `.bind`, a higher-order helper,
 * `Reflect.get` — has no member access at its eventual call site. Following it
 * needs dataflow this guard does not do, so the ESCAPE itself is reported.
 *
 * ## ⚠️ IT IS FAIL-CLOSED, AND THERE IS DELIBERATELY NO ALLOWLIST
 *
 * A site whose table cannot be proven is UNPROVEN and fails the guard. It is
 * not skipped and not counted as safe.
 *
 * That policy was MEASURED before it was chosen. At `bf5769ed1` the analysed
 * set is 228 non-generated, non-test modules. Of the 853 calls named one of the
 * four, 842 have a root receiver and 11 do not but still resolve into the
 * convex package; 79 further calls resolve into a TypeScript lib and are
 * cleared; ZERO resolve into repository code, another package, or nowhere. All
 * 853 resolve to a concrete table, and no root use is an erasure. So
 * fail-closed costs nothing today, and a NEW unresolvable form fails CI rather
 * than quietly shrinking the analysed surface.
 *
 * Five of the 63 deletes are `ctx.storage.delete(id)`. Storage is not a table
 * write, but its id IS an `Id<"_storage">`, so the same rule resolves it and it
 * is reported rather than special-cased. Pinned by a test.
 *
 * ## ⚠️ RECORDED SCOPE BOUNDARIES — read these before quoting a green run
 *
 * 1. Test files, `convex/_generated` and `test-utils` are NOT analysed. A test
 *    that inserts an authority row directly is fixture setup, not a production
 *    authority violation. Everything else the program contains IS analysed,
 *    including `lib/` and `packages/`.
 * 2. This is REPOSITORY/TOOLING enforcement. It is not a database capability,
 *    it grants nothing at runtime, and it cannot stop a write that reaches the
 *    database by any path other than a call in analysed source — a registered
 *    generic posting entrypoint is a different control and belongs to
 *    SCRUM-249; runtime row identity belongs to SCRUM-250.
 * 3. It is not flow-sensitive and makes no reachability claim. A write inside
 *    dead code is still a write.
 * 4. Root tracking follows `const` alias chains, NOT arbitrary dataflow — not
 *    an array element, an object property, an inferred return or a `let`. A
 *    writer laundered through one of those is not reported at a conversion; it
 *    is caught at the call by argument suspicion instead, as UNPROVEN. This is
 *    a stated limit of the erasure report, not a claim that it is complete.
 * 5. `ctx.db.replace` has ZERO call sites in the backend at `bf5769ed1`. Its
 *    detection is proven by fixture programs only. Stated separately because it
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
  | "reflective-write-member-access"
  /** A root-derived writer was converted to a type the convex package does not declare. */
  | "writer-provenance-erased"
  /** The call names a write, and nothing positively identifies what it is. */
  | "writer-provenance-not-established";

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
/**
 * Real `convex` package declarations are shared across fixture programs.
 *
 * ⚠️ NOT AN OPTIMIZATION ONLY. Every fixture program must see the SAME
 * `convex/server` declaration files as the real backend does, or declaration
 * provenance would be answering a different question in each half of the suite
 * — which is exactly the fixture/real asymmetry a previous mutation battery
 * caught and this design must not reintroduce.
 */
const sharedLibrarySources = new Map<string, ts.SourceFile | undefined>();

export function createVirtualAnalyzerProgram(
  files: Readonly<Record<string, string>>,
  repoRoot: string = process.cwd()
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
    if (!sharedLibrarySources.has(fileName)) {
      sharedLibrarySources.set(
        fileName,
        baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)
      );
    }
    return sharedLibrarySources.get(fileName);
  };
  host.fileExists = (fileName) => fileName in files || baseFileExists(fileName);
  host.readFile = (fileName) => files[fileName] ?? baseReadFile(fileName);
  host.useCaseSensitiveFileNames = () => true;
  host.getCanonicalFileName = (fileName) => fileName;

  // ⚠️ ONLY A VIRTUAL FILE'S OWN RELATIVE IMPORTS ARE RESOLVED VIRTUALLY.
  //
  // An earlier version intercepted every module literal in the program, which
  // included `export * from "./database.js"` INSIDE `convex/server/index.d.ts`.
  // That re-export silently resolved to nothing, so `GenericDatabaseWriter`
  // appeared not to exist and every fixture failed to typecheck — a resolver
  // bug that looks exactly like a missing package.
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: baseFileExists,
    readFile: baseReadFile,
    directoryExists: host.directoryExists?.bind(host),
    getDirectories: host.getDirectories?.bind(host),
    realpath: host.realpath?.bind(host),
    getCurrentDirectory: () => repoRoot,
  };

  host.resolveModuleNameLiterals = (literals, containingFile) => {
    const virtualContainer = containingFile in files;
    return literals.map((literal) => {
      const request = literal.text;
      if (virtualContainer && request.startsWith(".")) {
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
      }
      // A fixture has no location on disk, so package requests are resolved as
      // if made from the repository root — which is where `node_modules` is.
      const anchor = virtualContainer ? path.join(repoRoot, "__fixture__.ts") : containingFile;
      return {
        resolvedModule: ts.resolveModuleName(request, anchor, options, resolutionHost)
          .resolvedModule,
      };
    });
  };

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
/* ------------------------------------------------------------------------- *
 * Provenance — the only thing this analyzer trusts
 * ------------------------------------------------------------------------- */

/**
 * ⚠️ THESE TWO PATTERNS ARE THE WHOLE RECOGNITION BASIS.
 *
 * A repository author can imitate any TYPE SHAPE — that is what structural
 * typing means, and it is what defeated both previous architectures in both
 * directions. What cannot be imitated is WHERE A DECLARATION LIVES. A method
 * declared in `node_modules/convex` is Convex's; one declared in
 * `node_modules/typescript/lib/lib.*.d.ts` is a JavaScript builtin. Neither
 * answer can be forged by writing a cleverly shaped interface in `convex/`.
 */
const CONVEX_PACKAGE_DECLARATION = /[\\/]node_modules[\\/]convex[\\/]/;
const TYPESCRIPT_LIB_DECLARATION =
  /[\\/]node_modules[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/;

function declaredIn(
  declarations: readonly ts.Declaration[] | undefined,
  where: RegExp
): boolean {
  return (declarations ?? []).some((declaration) =>
    where.test(declaration.getSourceFile().fileName)
  );
}

/**
 * Is this type one the `convex` package itself declares?
 *
 * ⚠️ THIS ONE PREDICATE DECIDES BOTH HALVES OF THE ANALYZER, which is why they
 * cannot drift apart. A call on a convex-declared type is recognised by P1; the
 * moment a root-derived value stops being described by a convex-declared type,
 * that conversion is reported. There is no gap between the two because the
 * boundary is the same question.
 *
 * The alias symbol is consulted as well as the type's own symbol, so
 * `type W = GenericDatabaseWriter<DataModel>` stays convex-declared while
 * `type W = Pick<GenericDatabaseWriter<DataModel>, "delete">` does not — a
 * `Pick` is a mapped type declared in `lib.es5.d.ts`, and narrowing a writer
 * down to one method is exactly the erasure worth reporting.
 *
 * A union must be convex-declared in EVERY constituent. `Writer | WeakDelete`
 * can hold either, so it does not preserve the proof.
 */
function isConvexDeclaredType(type: ts.Type, depth = 0): boolean {
  if (depth > 3) return false;
  if (type.isUnion() || type.isIntersection()) {
    return type.types.length > 0 && type.types.every((t) => isConvexDeclaredType(t, depth + 1));
  }
  // ⚠️ BOTH SYMBOLS ARE ASKED, NOT ONE IN PREFERENCE TO THE OTHER.
  // `type Writer = GenericDatabaseWriter<DataModel>` has a repository alias
  // symbol AND convex's interface symbol. An earlier draft consulted
  // `aliasSymbol ?? getSymbol()`, so the alias hid the interface and every
  // ordinary `f(ctx.db)` through such an alias was reported as an erasure.
  if (declaredIn(type.getSymbol()?.getDeclarations(), CONVEX_PACKAGE_DECLARATION)) return true;
  return declaredIn(type.aliasSymbol?.getDeclarations(), CONVEX_PACKAGE_DECLARATION);
}

/**
 * A CONVEX WRITER ROOT: `ctx.db` or `ctx.storage` whose property symbol is
 * declared inside the `convex` package.
 *
 * ⚠️ THE NAME CHECK IS A NARROWING, NOT THE PROOF — the proof is the
 * declaration site. It is safe to narrow to these two because roots exist only
 * to drive the ERASURE report: any call on any convex-declared writer member is
 * recognised by P1 regardless of which property it came from. So a Convex
 * context property this list does not know about cannot hide a write; it can
 * only fail to have its widening reported.
 */
function isConvexWriterRoot(checker: ts.TypeChecker, node: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(node)) return false;
  const name = node.name.text;
  if (name !== "db" && name !== "storage") return false;
  return declaredIn(
    checker.getSymbolAtLocation(node.name)?.getDeclarations(),
    CONVEX_PACKAGE_DECLARATION
  );
}

/** `(expr)` and `expr!` carry a value through unchanged. */
function unwrapTransparent(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * Is this expression a root, or a `const` alias chain ending at one?
 *
 * `const db = ctx.db; await db.delete(id)` is ordinary and must stay proven.
 * The chain is bounded and only follows `const` declarations with an
 * initializer: a `let` can be reassigned, so its later value is not this one.
 */
function isRootDerived(checker: ts.TypeChecker, node: ts.Node, depth = 0): boolean {
  if (depth > 4) return false;
  const expression = unwrapTransparent(node);
  if (isConvexWriterRoot(checker, expression)) return true;
  if (!ts.isIdentifier(expression)) return false;

  const declarations = checker.getSymbolAtLocation(expression)?.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    const list = declaration.parent;
    if (!ts.isVariableDeclarationList(list)) return false;
    if ((list.flags & ts.NodeFlags.Const) === 0) return false;
    return isRootDerived(checker, declaration.initializer, depth + 1);
  });
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
 * Is this CALL a Convex database write?
 *
 * ⚠️ THE FIRST QUESTION IS WHERE THE RESOLVED SIGNATURE IS DECLARED, NOT WHAT
 * THE RECEIVER LOOKS LIKE. `checker.getResolvedSignature` names the exact
 * overload TypeScript picked, and its declaration's file answers the question
 * positively in both directions:
 *
 * - declared in the `convex` package -> this IS a Convex write. Survives
 *   `Pick<Writer, "delete">`, a delete-only view, a union constituent, an index
 *   signature and a structurally-typed helper parameter, because none of them
 *   move the declaration.
 * - declared in a TypeScript standard library -> it is a builtin.
 *   `new Set<Id<"receiptMovements">>().delete(id)` clears HERE, positively,
 *   because `Set.prototype.delete` is declared in `lib.es2015.collection.d.ts`.
 *   The previous architecture reported that call as an authority VIOLATION.
 *
 * ⚠️ A METHOD DECLARED SOMEWHERE ELSE IS CLEARED, AND THAT IS ONLY SOUND
 * BECAUSE OF THE ERASURE REPORT. A repository-declared `delete(id)` can be a
 * real Convex writer only if a root was assigned into it, and that assignment
 * is a conversion out of a convex-declared type — which `recordErasure` refuses
 * at the conversion. Remove that report and this clearing becomes a hole; the
 * two are a pair and the mutation battery tests them as one.
 *
 * An unresolved signature is refused rather than cleared: it is the one answer
 * that is neither positive nor negative.
 */
/**
 * Does this member's signature handle a Convex `Id`?
 *
 * ⚠️ SUSPICION ONLY. THIS IS THE PREDICATE THAT FAILED AS A RECOGNITION RULE,
 * AND IT IS DELIBERATELY KEPT AWAY FROM THAT JOB. It may not clear anything and
 * it may not convict anything; its single use is to turn "declared somewhere I
 * do not recognise, and shaped like a writer" into UNPROVEN instead of silence.
 *
 * As a recognition rule it produced a FALSE POSITIVE on
 * `new Set<Id<"receiptMovements">>().delete(id)`, because `Set<T>.delete` is a
 * member named `delete` whose parameter carries the brand. That call never
 * reaches here: it is cleared earlier, positively, by the fact that
 * `Set.prototype.delete` is declared in a TypeScript standard library. Order is
 * what makes this safe, so do not reorder it above the declaration tests.
 */
function memberHandlesAConvexId(
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

type WriteCallProvenance =
  | { readonly kind: "CONVEX_WRITE" }
  | { readonly kind: "NOT_CONVEX" }
  | { readonly kind: "UNPROVEN"; readonly form: UnsupportedForm };

function classifyCallProvenance(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  receiver: ts.Expression,
  method: ResolvedWriteMethod
): WriteCallProvenance {
  const declarationFile = checker
    .getResolvedSignature(call)
    ?.declaration?.getSourceFile().fileName;

  if (declarationFile !== undefined) {
    if (CONVEX_PACKAGE_DECLARATION.test(declarationFile)) return { kind: "CONVEX_WRITE" };
    if (TYPESCRIPT_LIB_DECLARATION.test(declarationFile)) return { kind: "NOT_CONVEX" };
  }

  // P2. A root receiver proves the write even where the signature does not
  // resolve into the package — a table-scoped writer obtained from a helper,
  // for instance.
  if (isRootDerived(checker, receiver)) return { kind: "CONVEX_WRITE" };

  const receiverType = checker.getTypeAtLocation(receiver);

  // ⚠️ `(ctx.db as any).delete(id)` ANSWERS NEITHER YES NOR NO. `as any` is the
  // canonical TypeScript escape hatch, so it is precisely the spelling a guard
  // whose green result is an authorization must refuse rather than ignore.
  if (isAnyOrUnknown(receiverType)) {
    return { kind: "UNPROVEN", form: "receiver-type-not-statically-known" };
  }

  if (isConvexDeclaredType(receiverType)) return { kind: "CONVEX_WRITE" };

  // ⚠️ DECLARED SOMEWHERE THIS ANALYZER CANNOT VOUCH FOR. It is not Convex's
  // and it is not a builtin, so neither positive answer is available. A
  // `DeleteOnly` view handed in as a parameter with no root in sight lands
  // here: nothing proves it IS a writer, and nothing proves it is not. The
  // ruling is explicit that such a value "is not cleared", so it is refused —
  // as UNPROVEN, never as a violation, because suspicion is not proof.
  const memberLooksLikeAWrite =
    method.kind === "WRITE"
      ? memberHandlesAConvexId(checker, receiverType, method.method)
      : DB_WRITE_METHODS.some((name) => memberHandlesAConvexId(checker, receiverType, name));

  // ⚠️ THE ARGUMENTS ARE ASKED TOO, AND THAT IS WHAT CLOSES LAUNDERING.
  //
  // A writer widened to `{ delete(id: string) }` has a member signature that
  // mentions no `Id` at all, so the member test above clears it — and if the
  // widening happened through an array element, an object property, an inferred
  // return or a `let`, the conversion is not one this analyzer followed either.
  // I reproduced all four producing ZERO sites before this line existed.
  //
  // The call itself still gives it away: `w.delete(movementId)` hands a branded
  // Convex `Id` to something named `delete`. That is not proof of a write, so
  // it is UNPROVEN rather than a violation — but it is not silence.
  const argumentCarriesAConvexId = call.arguments.some((argument) =>
    carriesIdBrand(checker, checker.getTypeAtLocation(argument))
  );

  if (memberLooksLikeAWrite || argumentCarriesAConvexId) {
    return { kind: "UNPROVEN", form: "writer-provenance-not-established" };
  }

  if (declarationFile !== undefined) return { kind: "NOT_CONVEX" };
  return { kind: "UNPROVEN", form: "writer-provenance-not-established" };
}

/**
 * The table(s) a resolved write addresses.
 *
 * ⚠️ THE ID IS FOUND BY ITS BRAND, NOT BY ITS POSITION. Convex ships two writer
 * shapes: `GenericDatabaseWriter`, whose `delete(id)` takes the id first, and
 * `GenericDatabaseWriterWithTable`, whose `db.table(name)` yields a scoped
 * writer whose `insert(value)` names no table at all. Scanning for the branded
 * argument resolves both without assuming an argument position, and falls back
 * to the call's own return type for the scoped insert, whose
 * `Promise<GenericId<T>>` carries the brand.
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
 * Every Convex database write in the analysed set, with its table resolved,
 * plus every point at which a root-derived writer left this analyzer's reach.
 *
 * The traversal is over the whole file at every depth: a write nested inside a
 * callback, a conditional, a loop or a nested function is still a write.
 *
 * ⚠️ TWO REPORTS, ONE INVARIANT. Calls are recognised by declaration
 * provenance; conversions that destroy that provenance are refused where they
 * happen. Neither is complete alone, and the boundary between them is the same
 * predicate, so a value cannot slip between the two.
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

    /**
     * Is taking THIS member off THIS holder an escape worth refusing?
     *
     * ⚠️ THE MEMBER'S DECLARATION SITE IS THE TEST, exactly as it is for calls.
     * An earlier draft asked whether the HOLDER's type was convex-declared, and
     * that reported `args.patch` in `convex/adminData.ts` three times: a
     * mutation's `args` object is built from Convex's own validator generics,
     * so its type is convex-declared while its `patch` field is an ordinary
     * caller-supplied patch payload. Asking where the MEMBER is declared
     * separates the two without consulting any shape.
     *
     * A `null` member name means the key could not be read at all, which only
     * matters when the holder is itself suspect.
     */
    const escapeIsSuspect = (holder: ts.Expression, member: string | null): boolean => {
      const type = checker.getTypeAtLocation(holder);
      if (isAnyOrUnknown(type)) return true;
      if (isRootDerived(checker, holder)) return true;
      if (member === null) return false;
      return declaredIn(
        checker.getPropertyOfType(type, member)?.getDeclarations(),
        CONVEX_PACKAGE_DECLARATION
      );
    };

    // ⚠️ THE METHOD IS RESOLVED BEFORE THE PROVENANCE, AND THAT ORDER MATTERS.
    // A statically known name that is not one of the four clears the call
    // whatever its receiver is — so `(anything as any)["get"](id)` stays out,
    // while `(ctx.db as any).delete(id)` cannot be cleared and is refused.
    const record = (call: ts.CallExpression): void => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return;

      const resolved = resolveWriteMethod(checker, callee);
      if (resolved.kind === "NOT_A_WRITE") return;

      const provenance = classifyCallProvenance(checker, call, callee.expression, resolved);
      if (provenance.kind === "NOT_CONVEX") return;
      if (provenance.kind === "UNPROVEN") {
        at(call, methodLabel(resolved), { kind: "UNPROVEN", form: provenance.form });
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
     * ⚠️ THE CONVERSION IS THE FINDING, NOT THE CALL THAT FOLLOWS IT.
     *
     * ```ts
     * const w: WeakDelete = ctx.db;   // <- reported here
     * await w.delete(id);             // <- cleared, and correctly so
     * ```
     *
     * `WeakDelete` is repository-declared, so the later call is not recognisable
     * as Convex's by any honest test — that is exactly what defeated the
     * previous architecture, which tried to recognise the call and reported
     * nothing at all. Widening, a helper parameter, a return, a property store,
     * a cast and `as unknown as X` all pass through a position with a
     * contextual type, and every one of them is refused here when that type is
     * not Convex's own.
     *
     * Two uses are cleared positively because neither can reach a member: the
     * right operand of `in`, and `typeof`.
     */
    const recordErasure = (expression: ts.Expression): void => {
      const parent = expression.parent;

      // A member access is the call/escape path, not a conversion.
      if (
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === expression
      ) {
        return;
      }

      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        parent.right === expression
      ) {
        return;
      }
      if (ts.isTypeOfExpression(parent)) return;

      // ⚠️ DESTRUCTURING IS NOT A LOST BOUNDARY — IT IS A FOLLOWED ONE.
      // `recordEscape` inspects every binding element of `const { … } = ctx.db`
      // and refuses each key that is, or might be, one of the four. The proof
      // does not stop here, so reporting an erasure as well would be a second
      // finding for one construct and would redden `const { get } = ctx.db`.
      if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) return;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.right === expression &&
        ts.isObjectLiteralExpression(parent.left)
      ) {
        return;
      }

      // `(expr)` and `expr!` carry the value on; judge what encloses them.
      if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent)) {
        recordErasure(parent);
        return;
      }

      const asserted =
        (ts.isAsExpression(parent) ||
          ts.isSatisfiesExpression(parent) ||
          ts.isTypeAssertionExpression(parent)) &&
        parent.expression === expression
          ? checker.getTypeFromTypeNode(parent.type)
          : undefined;

      const target = asserted ?? checker.getContextualType(expression);
      if (target === undefined) return;
      if (isConvexDeclaredType(target)) return;

      at(expression, "unknown", { kind: "UNPROVEN", form: "writer-provenance-erased" });
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
     * does not do. So the ESCAPE itself is reported.
     */
    const recordEscape = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const parent = node.parent;
        if (ts.isCallExpression(parent) && parent.expression === node) return;
        const resolved = resolveWriteMethod(checker, node);
        if (resolved.kind === "NOT_A_WRITE") return;
        const spelled = resolved.kind === "WRITE" ? resolved.method : null;
        if (!escapeIsSuspect(node.expression, spelled)) return;
        const unreadable = isAnyOrUnknown(checker.getTypeAtLocation(node.expression));
        at(node, methodLabel(resolved), {
          kind: "UNPROVEN",
          form: unreadable
            ? "receiver-type-not-statically-known"
            : "write-method-reference-escapes",
        });
        return;
      }

      // `const { delete: rm } = ctx.db` and `const { [op]: rm } = ctx.db`
      if (ts.isObjectBindingPattern(node)) {
        const declaration = node.parent;
        const source =
          ts.isVariableDeclaration(declaration) && declaration.initializer
            ? declaration.initializer
            : undefined;
        for (const element of node.elements) {
          const key = element.propertyName ?? element.name;
          const spelled = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
          if (source && !escapeIsSuspect(source, spelled)) continue;
          reportMemberKey(element, key);
        }
        return;
      }

      // `({ delete: rm } = ctx.db)` — an assignment target, not a declaration.
      if (
        ts.isObjectLiteralExpression(node) &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.left === node
      ) {
        for (const property of node.properties) {
          const key = property.name;
          const spelled =
            key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : null;
          if (!escapeIsSuspect(node.parent.right, spelled)) continue;
          reportMemberKey(property, key);
        }
      }
    };

    /** One destructured key: refuse it unless its name proves it harmless. */
    function reportMemberKey(node: ts.Node, key: ts.Node | undefined): void {
      const spelled = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : null;
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
      // Deliberately NOT `couldHoldAWriter`: an `any` first argument is the
      // ordinary shape of `map.get(x)`, and an `any` that really holds a writer
      // was reported at the conversion that made it `any`.
      if (!isRootDerived(checker, target) && !isConvexDeclaredType(checker.getTypeAtLocation(target))) {
        return;
      }
      at(call, "unknown", { kind: "UNPROVEN", form: "reflective-write-member-access" });
    };

    // ⚠️ ROOT ALIASES ARE COLLECTED BY NAME FIRST, PURELY FOR COST. Asking
    // `isRootDerived` of every identifier in 228 modules resolves a symbol per
    // identifier; asking it only of names actually bound to a root in this file
    // is the same answer for a fraction of the work, because a same-named
    // unrelated binding is rejected by `isRootDerived` anyway.
    const aliasNames = new Set<string>();
    const collectAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name) &&
        isRootDerived(checker, node.initializer)
      ) {
        aliasNames.add(node.name.text);
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        record(node);
        recordReflection(node);
      } else {
        recordEscape(node);
      }

      if (isConvexWriterRoot(checker, node)) {
        recordErasure(node as ts.Expression);
      } else if (
        ts.isIdentifier(node) &&
        aliasNames.has(node.text) &&
        !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
        isRootDerived(checker, node)
      ) {
        recordErasure(node);
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
 * ⚠️ A SITE THAT RESOLVES TO SEVERAL TABLES IS JUDGED ON EACH OF THEM.
 *
 * `Id<"a"> | Id<"b">` and a generic `Id<TableNames>` both resolve to a SET. The
 * set is not a reason to clear the site, and it is not a reason to condemn it
 * wholesale either: each declared authority table in the set is authorized or
 * refused on its own.
 */
/**
 * Is this exact write permitted on this exact table?
 *
 * The owner module may do anything. Every other module needs a lifecycle
 * exception naming that module AND that operation, on THIS table's declaration.
 *
 * ⚠️ THE EFFECTIVE PERMISSION IS `table + module + operation`, RULED IN
 * `SCRUM-238 c17726`. An exception is attached to one authority declaration, so
 * it can never become a module-wide wildcard: `adminOrgs.ts` may DELETE through
 * a generic `Id<TableNames>` sweep because all three receipt declarations grant
 * it that, and a fourth declared table without its own grant makes the very
 * same sweep a violation for that table alone.
 *
 * ⚠️ THE PREVIOUS `resolvedTables.length === 1` CONDITION IS DELIBERATELY GONE.
 * It read "exact-table" as a property of the CALL rather than of the
 * permission, so a generic sweep matched no exception at all and the two
 * approved lifecycle modules were reported anyway — which made the granted
 * exception cover nothing, since those sweeps are the only non-owner writes to
 * these tables. Being fail-closed did not make it correct.
 */
function permits(entry: AuthorityDeclaration, site: DbWriteSite): boolean {
  if (entry.ownerModule === site.file) return true;
  const exception = entry.lifecycleExceptions?.find((granted) => granted.module === site.file);
  if (!exception) return false;
  // An unresolved operation could be any of the four, so no grant covers it.
  if (site.method === "unknown") return false;
  return exception.operations.includes(site.method);
}

export function classifyWriteSite(
  site: DbWriteSite,
  declaration: readonly AuthorityDeclaration[]
): SiteVerdict {
  const resolution = site.resolution;
  if (resolution.kind === "UNPROVEN") return { verdict: "UNPROVEN", form: resolution.form };

  const matched = declaration.filter((entry) => resolution.tables.includes(entry.table));
  if (matched.length === 0) return { verdict: "UNRELATED" };

  const unauthorized = matched.filter((entry) => !permits(entry, site));
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
