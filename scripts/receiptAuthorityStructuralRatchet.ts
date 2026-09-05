/**
 * SCRUM-238 — RECEIPT AUTHORITY STRUCTURAL RATCHET.
 *
 * ⚠️ READ THIS BEFORE TRUSTING ANYTHING THIS FILE PRINTS.
 *
 * This is an ACCIDENTAL-REGRESSION / CONVENTION GUARD.
 *
 * It is **NOT** an adversarial security proof, and it is **NOT** proof that
 * every possible TypeScript write to these tables has been identified. A
 * determined author can write a database write this file cannot see, and
 * nothing here would notice. That is a designed-in limit, not an oversight.
 *
 * ## Why the limit is designed in
 *
 * Three previous versions of this ticket tried to answer "is this call a
 * database write, and to which table?" by asking the TypeScript type checker.
 * All three were defeated, and the third was defeated in a way that ended the
 * approach: TABLE RESOLUTION ITSELF IS UNSOUND. A Convex document id is a
 * branded string, so the only static evidence of a write's target is a type —
 * and a type is an assertion by the author, not an observation of behaviour:
 *
 *     ctx.db.delete(movementId as unknown as Id<"vehicles">);
 *     // a type-directed analyzer resolves "vehicles", calls it unrelated,
 *     // and PASSES — while the emitted JavaScript still deletes the movement.
 *
 * That is a confident WRONG ANSWER rather than a refusal, which is worse than
 * a missed detection: a reviewer reading a green run cannot tell the two apart.
 * Generic boundaries, value carriers (a pass-through function, a getter, a
 * `Proxy`, `Object.assign`) and runtime method shadowing defeat the writer half
 * the same way. Owner ruling `SCRUM-238 c17733` retired that design; PR #279
 * and commit `7d644f40a` are preserved as its failed-review evidence.
 *
 * So this file asks only questions that can be decided **from source syntax and
 * fixed manifests**, with NO type inference anywhere. Every check below reads an
 * identifier, a string literal, or the shape of a call — things an author cannot
 * quietly re-type. The properties are weaker. They are also true.
 *
 * The real runtime guarantee for the customer-merge seam belongs to SCRUM-250,
 * and destructive lifecycle SEQUENCING belongs to SCRUM-231. Neither is
 * implemented here, and this file must never be read as standing in for either.
 *
 * ## The invariants, mapped to owner ruling c17733
 *
 *   ruling 1 -> R1  the three tables are ABSENT from the merge rewrite registry
 *   ruling 1 -> R2  the three tables are PRESENT in the sealed classification
 *   ruling 2 -> R3  every rewrite-registry label is coupled to its finder's query
 *   ruling 3 -> R4  the three tables are ABSENT from ADMIN_TABLES
 *   ruling 4 -> R5  the three tables are PRESENT in both destructive manifests
 *   ruling 5 -> R6  literal authority inserts occur ONLY in the owner module
 *   ruling 6 -> `formatRatchetReport` names each result individually and prints
 *               an explicit limits block; totality phrasing is banned and the
 *               ban is enforced by a test.
 *
 * ## The ratchet, and why some invariants are INACTIVE on `main`
 *
 * The three tables do not exist on `origin/main` — they arrive with SCRUM-218-C
 * (PR #280, unmerged). R2 and R5 have no subject until then.
 *
 * An INACTIVE verdict is the failure mode this whole programme has been fighting:
 * a quiet exit that reads like a pass. So inactivity is **proved, not assumed**.
 * The guard parses `convex/schema.ts`, enumerates every `defineTable` property
 * name, and reports the count it inspected. If the schema declares the tables,
 * R2 and R5 activate automatically and the build fails until the manifests name
 * them.
 *
 * INACTIVE is reserved for a surface PROVED ABSENT. "The subject does not exist
 * yet" and "I could not tell" are different claims, so if `schema.ts` cannot be
 * parsed, or is only PARTIALLY declared (one or two of the three), R0 fails AND
 * R2/R5 themselves report VIOLATED — never INACTIVE. Undecided is a violation
 * here exactly as it is for every always-active invariant.
 *
 * The same rule governs the manifest readers: an entry whose keys cannot all be
 * read is unparsable, not skipped. Skipping it would let a manifest that was
 * never fully read stand as proof that a table is absent from it.
 *
 * ## What was already enforced before this file existed
 *
 * `scripts/orgDeletionCoverage.test.ts` already forces any NEW `orgId` table to
 * be either deleted with the org or written into `KNOWN_UNCOVERED_PRE_EXISTING`.
 * R5 is narrower and stricter for these three specifically: it forbids that
 * escape hatch, and it additionally requires the FINANCIAL RESET manifest, which
 * that test does not check against the schema at all.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The fixed literal oracle. Exactly three names, hardcoded on purpose: this
 * file must not derive its own subject from the code it is checking, or an edit
 * that removes a table from the schema would also remove it from the guard.
 */
export const AUTHORITY_TABLES = [
  "receiptMovements",
  "receiptRetainedPositions",
  "receiptApplications",
] as const;

export type AuthorityTable = (typeof AUTHORITY_TABLES)[number];

/** The single module permitted to create receipt authority rows by literal. */
export const AUTHORITY_OWNER_MODULE = "convex/accounting/receiptMovement.ts";

/**
 * Fixture modules exempt from R6, enumerated one by one.
 *
 * Ruling c17733 permits "separately and explicitly ruled fixture/test
 * exclusions". This is that list, and it is a LIST rather than a `*.test.ts`
 * wildcard so a production module can never be exempted by being renamed.
 * Excluded sites are still counted and PRINTED by the report, so the exemption
 * is visible rather than invisible.
 */
export const AUTHORITY_INSERT_FIXTURE_EXCLUSIONS: readonly string[] = [
  "convex/accountingReceiptMovement.test.ts",
];

export const MERGE_HELPERS_MODULE = "convex/utils/mergeHelpers.ts";
export const SCHEMA_MODULE = "convex/schema.ts";
export const ADMIN_DATA_MODULE = "convex/adminData.ts";
export const ORG_FINANCIAL_RESET_MODULE = "convex/orgFinancialReset.ts";
export const ADMIN_ORGS_MODULE = "convex/adminOrgs.ts";

export const REWRITE_REGISTRY = "CUSTOMER_REFERENCING_TABLES";
export const SEALED_CLASSIFICATION = "CUSTOMER_NON_REASSIGNABLE_TABLES";
export const ADMIN_TABLE_MANIFEST = "ADMIN_TABLES";
export const RESET_MANIFEST = "RESET_TABLES";
export const DELETION_MANIFEST = "ORGANIZATION_DELETION_STEPS";

/* ------------------------------------------------------------------ *
 * Source access
 * ------------------------------------------------------------------ */

/**
 * Where the guard reads source from.
 *
 * Injectable so a test can run the REAL repository source with one surgical
 * edit, rather than against a hand-written look-alike. A look-alike fixture is
 * worthless here: it proves the guard can read a file someone wrote to be read.
 */
export interface SourceProvider {
  describe(): string;
  read(relativePath: string): string | null;
  /** Every `.ts`/`.tsx` module under `convex/`, excluding `_generated`. */
  listConvexModules(): string[];
}

export function fileSystemSource(repoRoot: string): SourceProvider {
  return {
    describe: () => repoRoot,
    read(relativePath) {
      const absolute = path.join(repoRoot, relativePath);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
      return fs.readFileSync(absolute, "utf8");
    },
    listConvexModules() {
      const convexRoot = path.join(repoRoot, "convex");
      if (!fs.existsSync(convexRoot)) return [];
      const out: string[] = [];
      const walk = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "_generated" || entry.name === "node_modules") continue;
            walk(absolute);
            continue;
          }
          if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
          out.push(path.relative(repoRoot, absolute).split(path.sep).join("/"));
        }
      };
      walk(convexRoot);
      return out.sort();
    },
  };
}

/**
 * The real source with named files replaced (or, with `null`, deleted).
 *
 * This is how every failing-first control in the suite is built: take the
 * production file, change one thing, and prove the verdict flips.
 */
export function overlaySource(
  base: SourceProvider,
  overrides: Readonly<Record<string, string | null>>
): SourceProvider {
  return {
    describe: () => `${base.describe()} + ${Object.keys(overrides).length} override(s)`,
    read(relativePath) {
      if (Object.hasOwn(overrides, relativePath)) return overrides[relativePath];
      return base.read(relativePath);
    },
    listConvexModules() {
      const listed = new Set(base.listConvexModules());
      for (const [file, content] of Object.entries(overrides)) {
        if (!file.startsWith("convex/")) continue;
        if (content === null) listed.delete(file);
        else listed.add(file);
      }
      return [...listed].sort();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Syntax helpers — no TypeChecker, no program, no type inference
 * ------------------------------------------------------------------ */

export function parseModule(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Strips `as const`, `satisfies`, `<T>x` and parentheses. Syntax only. */
export function unwrap(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    const kind = current.kind;
    if (
      kind === ts.SyntaxKind.AsExpression ||
      kind === ts.SyntaxKind.SatisfiesExpression ||
      kind === ts.SyntaxKind.TypeAssertionExpression
    ) {
      current = (current as ts.AsExpression).expression;
      continue;
    }
    if (kind === ts.SyntaxKind.ParenthesizedExpression) {
      current = (current as ts.ParenthesizedExpression).expression;
      continue;
    }
    return current;
  }
}

export function lineOf(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/** The initializer of the first `const NAME = ...` found, at any depth. */
export function variableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | null {
  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop() as ts.Node;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      return node.initializer;
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return null;
}

export type ManifestRead =
  | { kind: "ok"; values: string[] }
  | { kind: "missing"; reason: string }
  | { kind: "unparsable"; reason: string };

/** `const NAME = ["a", "b"] as const` -> `["a", "b"]`. */
export function stringArrayManifest(sourceFile: ts.SourceFile, name: string): ManifestRead {
  const initializer = variableInitializer(sourceFile, name);
  if (initializer === null) {
    return { kind: "missing", reason: `${name} is not declared in ${sourceFile.fileName}` };
  }
  const array = unwrap(initializer);
  if (!ts.isArrayLiteralExpression(array)) {
    return { kind: "unparsable", reason: `${name} is not an array literal` };
  }
  const values: string[] = [];
  for (const element of array.elements) {
    const value = unwrap(element);
    if (!ts.isStringLiteral(value)) {
      return {
        kind: "unparsable",
        reason: `${name} holds a non-literal element at line ${lineOf(element)}`,
      };
    }
    values.push(value.text);
  }
  return { kind: "ok", values };
}

/** `const NAME = [{ table: "a" }, ...]` -> `["a", ...]`, by the given property. */
export function objectArrayManifest(
  sourceFile: ts.SourceFile,
  name: string,
  property: string
): ManifestRead {
  const initializer = variableInitializer(sourceFile, name);
  if (initializer === null) {
    return { kind: "missing", reason: `${name} is not declared in ${sourceFile.fileName}` };
  }
  const array = unwrap(initializer);
  if (!ts.isArrayLiteralExpression(array)) {
    return { kind: "unparsable", reason: `${name} is not an array literal` };
  }
  const values: string[] = [];
  for (const element of array.elements) {
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) {
      return {
        kind: "unparsable",
        reason: `${name} holds a non-object entry at line ${lineOf(element)}`,
      };
    }
    // An entry may be SKIPPED only when every one of its keys is readable and
    // none of them is `property` — the deletion manifest legitimately holds
    // storage-aware steps that name no table, and those must keep parsing.
    //
    // But an entry carrying a key this grammar cannot read — a spread, or a
    // computed name — may be naming `property` invisibly, and a shorthand names
    // it with no literal value to read. Skipping either would turn a BLIND read
    // into a proof of absence, which is the exact failure this guard exists to
    // prevent: for R5 (presence) a dropped entry fails closed, but for R4
    // (absence) it fails OPEN and reports a manifest it never finished reading.
    const unreadableKey = object.properties.find(
      (member) =>
        !ts.isPropertyAssignment(member) ||
        !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    );
    if (unreadableKey !== undefined) {
      return {
        kind: "unparsable",
        reason:
          `${name} has an entry at line ${lineOf(object)} whose keys cannot all be read, ` +
          `so it cannot be proved not to name "${property}"`,
      };
    }

    const assignment = object.properties.find(
      (member): member is ts.PropertyAssignment =>
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === property
    );
    if (assignment === undefined) continue;
    const value = unwrap(assignment.initializer);
    if (!ts.isStringLiteral(value)) {
      return {
        kind: "unparsable",
        reason: `${name} has a non-literal "${property}" at line ${lineOf(assignment)}`,
      };
    }
    values.push(value.text);
  }
  return { kind: "ok", values };
}

export interface SchemaEnumeration {
  tables: string[];
  /**
   * Reasons this enumeration is INCOMPLETE.
   *
   * Non-empty means the ratchet trigger cannot be decided from source, and the
   * surface must be treated as UNREADABLE rather than as "the tables are
   * absent". Those two look identical from an empty result and mean opposite
   * things: one is a correct ABSENT, the other is a guard that has gone blind
   * and would leave R2 and R5 asleep forever while the tables really existed.
   */
  incomplete: string[];
}

/**
 * Every top-level table name in `defineSchema({ ... })`. Syntax only.
 *
 * Fails closed on anything it cannot enumerate: a spread, a computed key, or a
 * `defineSchema` handed something other than an inline object literal.
 */
export function schemaDeclaredTables(sourceFile: ts.SourceFile): SchemaEnumeration {
  const tables: string[] = [];
  const incomplete: string[] = [];
  let sawDefineSchema = false;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineSchema"
    ) {
      sawDefineSchema = true;
      const argument =
        node.arguments.length > 0 ? unwrap(node.arguments[0] as ts.Expression) : undefined;
      if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
        incomplete.push(
          `line ${lineOf(node)}: defineSchema(...) is not given an inline object literal, ` +
            "so its tables cannot be enumerated from source"
        );
      } else {
        for (const member of argument.properties) {
          if (
            ts.isPropertyAssignment(member) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
          ) {
            tables.push(member.name.text);
          } else if (ts.isShorthandPropertyAssignment(member)) {
            tables.push(member.name.text);
          } else if (ts.isSpreadAssignment(member)) {
            incomplete.push(
              `line ${lineOf(member)}: defineSchema spreads an expression, which hides an unknown set of tables`
            );
          } else {
            incomplete.push(
              `line ${lineOf(member)}: defineSchema has a member whose table name is not a literal`
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!sawDefineSchema) {
    incomplete.push(`no defineSchema(...) call found in ${sourceFile.fileName}`);
  }
  return { tables, incomplete };
}

/* ------------------------------------------------------------------ *
 * The rewrite registry and its finders (ruling 2)
 * ------------------------------------------------------------------ */

export interface RegistryEntry {
  /** The declared `table:` literal, or null when it is not a literal. */
  label: string | null;
  labelProblem: string | null;
  /** Table literals the finder's own `.query("...")` calls name. */
  queryLiterals: string[];
  /** Reasons the finder's table selection cannot be decided by this grammar. */
  problems: string[];
  line: number;
}

function isCtxDb(node: ts.Expression): boolean {
  const target = unwrap(node);
  return (
    ts.isPropertyAccessExpression(target) &&
    target.name.text === "db" &&
    ts.isIdentifier(unwrap(target.expression))
  );
}

/**
 * The finder grammar, deliberately simple and deliberately unforgiving.
 *
 * A finder proves its table only by naming it in a literal `.query("table")`.
 * Anything this grammar cannot decide — a computed query argument, a call to a
 * helper that could query anything, a bracketed member call, another `ctx.db`
 * method — is a PROBLEM, and a problem is a violation. It never receives an
 * inferred blessing, because inference is exactly what was retired.
 */
export function analyzeFinder(finder: ts.Node): Pick<RegistryEntry, "queryLiterals" | "problems"> {
  const queryLiterals: string[] = [];
  const problems: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "query") {
          const argument = node.arguments.length === 1 ? unwrap(node.arguments[0] as ts.Expression) : null;
          if (argument !== null && ts.isStringLiteral(argument)) {
            queryLiterals.push(argument.text);
          } else {
            problems.push(
              `line ${lineOf(node)}: .query(...) argument is not a single string literal`
            );
          }
        } else if (isCtxDb(callee.expression)) {
          problems.push(
            `line ${lineOf(node)}: reads ctx.db.${callee.name.text}(...), which names no table literal`
          );
        }
      } else if (ts.isIdentifier(callee)) {
        problems.push(
          `line ${lineOf(node)}: calls helper ${callee.text}(...), whose table selection is not visible here`
        );
      } else if (ts.isElementAccessExpression(callee)) {
        problems.push(`line ${lineOf(node)}: computed member call, which names no method literal`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(finder);

  return { queryLiterals, problems };
}

/** Reads `CUSTOMER_REFERENCING_TABLES` as label/finder pairs. Syntax only. */
export function readRewriteRegistry(
  sourceFile: ts.SourceFile
): { kind: "ok"; entries: RegistryEntry[] } | { kind: "missing"; reason: string } | { kind: "unparsable"; reason: string } {
  const initializer = variableInitializer(sourceFile, REWRITE_REGISTRY);
  if (initializer === null) {
    return { kind: "missing", reason: `${REWRITE_REGISTRY} is not declared in ${sourceFile.fileName}` };
  }
  const array = unwrap(initializer);
  if (!ts.isArrayLiteralExpression(array)) {
    return { kind: "unparsable", reason: `${REWRITE_REGISTRY} is not an array literal` };
  }

  const entries: RegistryEntry[] = [];
  for (const element of array.elements) {
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) {
      return {
        kind: "unparsable",
        reason: `${REWRITE_REGISTRY} holds a non-object entry at line ${lineOf(element)}`,
      };
    }
    const line = lineOf(object);

    const tableProperty = object.properties.find(
      (member): member is ts.PropertyAssignment =>
        ts.isPropertyAssignment(member) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === "table"
    );
    let label: string | null = null;
    let labelProblem: string | null = null;
    if (tableProperty === undefined) {
      labelProblem = "entry declares no `table` property";
    } else {
      const value = unwrap(tableProperty.initializer);
      if (ts.isStringLiteral(value)) label = value.text;
      else labelProblem = "`table` is not a string literal";
    }

    const findProperty = object.properties.find(
      (member) =>
        (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member)) &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === "find"
    );

    if (findProperty === undefined) {
      entries.push({
        label,
        labelProblem,
        queryLiterals: [],
        problems: ["entry declares no `find` function"],
        line,
      });
      continue;
    }

    const finderBody = ts.isPropertyAssignment(findProperty)
      ? findProperty.initializer
      : findProperty;
    const analysis = analyzeFinder(finderBody);
    entries.push({ label, labelProblem, ...analysis, line });
  }

  return { kind: "ok", entries };
}

/* ------------------------------------------------------------------ *
 * Literal authority creation (ruling 5)
 * ------------------------------------------------------------------ */

export interface AuthorityInsertSite {
  file: string;
  line: number;
  table: AuthorityTable;
}

/**
 * `<anything>.insert("receiptMovements", ...)`.
 *
 * Deliberately not restricted to a `ctx.db` receiver: a ratchet should notice
 * the literal wherever it is written. The literal is the whole evidence — this
 * function makes no claim about writes that do not name the table in source.
 */
const insertScanCache = new Map<string, AuthorityInsertSite[]>();

export function findAuthorityInserts(source: string, file: string): AuthorityInsertSite[] {
  // Pure function of (file, source), so its result is memoized on exactly those
  // two inputs. Every control in the test suite overlays one or two files and
  // re-runs the whole check; without this, each run re-parses all ~400 convex
  // modules, which is slow enough under CI coverage instrumentation to blow the
  // per-test timeout. The key is the FULL text, never a hash: a hash collision
  // would silently return another file's findings.
  const key = `${file} ${source}`;
  const cached = insertScanCache.get(key);
  if (cached !== undefined) return cached;
  // Bounded so a long-lived process cannot grow it without limit. Dropping
  // entries costs cache hits only, never correctness.
  if (insertScanCache.size > 5000) insertScanCache.clear();

  const sourceFile = parseModule(source, file);
  const sites: AuthorityInsertSite[] = [];
  const authority = new Set<string>(AUTHORITY_TABLES);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = unwrap(node.expression);
      const isInsert =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "insert") ||
        (ts.isElementAccessExpression(callee) &&
          callee.argumentExpression !== undefined &&
          ts.isStringLiteral(unwrap(callee.argumentExpression)) &&
          (unwrap(callee.argumentExpression) as ts.StringLiteral).text === "insert");
      if (isInsert) {
        const argument = unwrap(node.arguments[0] as ts.Expression);
        if (ts.isStringLiteral(argument) && authority.has(argument.text)) {
          sites.push({ file, line: lineOf(node), table: argument.text as AuthorityTable });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  insertScanCache.set(key, sites);
  return sites;
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

export type Verdict = "SATISFIED" | "VIOLATED" | "INACTIVE";

export interface InvariantResult {
  id: string;
  title: string;
  verdict: Verdict;
  /** Exactly which source this result was decided from. */
  subject: string;
  /** What a SATISFIED verdict means. Never a totality claim. */
  proved: string;
  violations: string[];
  /** Present only when INACTIVE: the enumeration that proves there is no subject. */
  inactiveBecause?: string;
}

export interface RatchetReport {
  root: string;
  authoritySurface: "PRESENT" | "ABSENT" | "PARTIAL" | "UNREADABLE";
  schemaTablesInspected: number;
  declaredAuthorityTables: string[];
  invariants: InvariantResult[];
  /** Fixture insert sites exempted by the explicit list, printed for visibility. */
  exemptedInsertSites: AuthorityInsertSite[];
  ok: boolean;
}

function satisfied(
  id: string,
  title: string,
  subject: string,
  proved: string
): InvariantResult {
  return { id, title, verdict: "SATISFIED", subject, proved, violations: [] };
}

function violated(
  id: string,
  title: string,
  subject: string,
  proved: string,
  violations: string[]
): InvariantResult {
  return { id, title, verdict: "VIOLATED", subject, proved, violations };
}

function inactive(
  id: string,
  title: string,
  subject: string,
  proved: string,
  because: string
): InvariantResult {
  return {
    id,
    title,
    verdict: "INACTIVE",
    subject,
    proved,
    violations: [],
    inactiveBecause: because,
  };
}

/**
 * A ratcheted invariant is DORMANT only when the surface is PROVED ABSENT.
 *
 * When the surface is PARTIAL or UNREADABLE the property is not dormant, it is
 * UNDECIDED — and printing "the subject does not exist yet" would claim more
 * than the enumeration established. Undecided is a violation here, exactly as
 * it is for every always-active invariant.
 */
function dormantOrUndecided(
  surface: RatchetReport["authoritySurface"],
  enumeration: string,
  id: string,
  title: string,
  subject: string,
  proved: string
): InvariantResult {
  if (surface === "ABSENT") return inactive(id, title, subject, proved, enumeration);
  return violated(id, title, subject, proved, [
    `cannot prove the property: the authority surface could not be decided (see R0) — ${enumeration}`,
  ]);
}

/** Turns a failed manifest read into a violation. A manifest we cannot read is
 * never a pass: absence of evidence is not evidence of absence. */
function manifestFailure(read: Exclude<ManifestRead, { kind: "ok" }>): string {
  return read.kind === "missing"
    ? `cannot prove the property: ${read.reason}`
    : `cannot prove the property: ${read.reason}`;
}

export function checkStructuralRatchet(source: SourceProvider): RatchetReport {
  const invariants: InvariantResult[] = [];
  const authority = [...AUTHORITY_TABLES];

  /* ---- the ratchet trigger: does the authority surface exist? ---- */
  const schemaText = source.read(SCHEMA_MODULE);
  let surface: RatchetReport["authoritySurface"] = "UNREADABLE";
  let schemaTables: string[] = [];
  let declared: string[] = [];
  let schemaProblems: string[] = [`${SCHEMA_MODULE} is unreadable`];
  if (schemaText !== null) {
    const enumeration = schemaDeclaredTables(parseModule(schemaText, SCHEMA_MODULE));
    schemaTables = enumeration.tables;
    schemaProblems = enumeration.incomplete;
    const known = new Set(schemaTables);
    declared = authority.filter((table) => known.has(table));
    // An enumeration we could not complete is UNREADABLE, never ABSENT. Both
    // produce an empty authority list; only one of them means the tables are
    // really not there.
    if (schemaProblems.length > 0 || schemaTables.length === 0) surface = "UNREADABLE";
    else if (declared.length === authority.length) surface = "PRESENT";
    else if (declared.length === 0) surface = "ABSENT";
    else surface = "PARTIAL";
  }

  const surfaceEnumeration =
    `${SCHEMA_MODULE} declares ${schemaTables.length} tables; ` +
    `${declared.length} of ${authority.length} authority tables present` +
    (declared.length > 0 ? ` (${declared.join(", ")})` : "");

  /* ---- R1: absent from the merge REWRITE registry (always active) ---- */
  const mergeText = source.read(MERGE_HELPERS_MODULE);
  const mergeFile = mergeText === null ? null : parseModule(mergeText, MERGE_HELPERS_MODULE);
  const registry = mergeFile === null ? null : readRewriteRegistry(mergeFile);

  if (registry === null || registry.kind !== "ok") {
    invariants.push(
      violated(
        "R1",
        "authority tables are absent from the customer-merge REWRITE registry",
        `${MERGE_HELPERS_MODULE} :: ${REWRITE_REGISTRY}`,
        "no rewrite-registry entry names an authority table",
        [
          registry === null
            ? `cannot prove the property: ${MERGE_HELPERS_MODULE} is unreadable`
            : `cannot prove the property: ${registry.reason}`,
        ]
      )
    );
  } else {
    const labels = registry.entries.map((entry) => entry.label).filter((l): l is string => l !== null);
    const offending = registry.entries.filter(
      (entry) => entry.label !== null && (authority as string[]).includes(entry.label)
    );
    const result =
      offending.length === 0
        ? satisfied(
            "R1",
            "authority tables are absent from the customer-merge REWRITE registry",
            `${MERGE_HELPERS_MODULE} :: ${REWRITE_REGISTRY}`,
            `none of the ${authority.length} authority tables appears among the ${labels.length} registry labels inspected`
          )
        : violated(
            "R1",
            "authority tables are absent from the customer-merge REWRITE registry",
            `${MERGE_HELPERS_MODULE} :: ${REWRITE_REGISTRY}`,
            `none of the ${authority.length} authority tables appears among the ${labels.length} registry labels inspected`,
            offending.map(
              (entry) =>
                `line ${entry.line}: "${entry.label}" is sealed financial authority — a merge must not rewrite its customerId`
            )
          );
    invariants.push(result);
  }

  /* ---- R2: present in the SEALED classification (ratcheted) ---- */
  if (surface === "PRESENT") {
    const sealed = mergeFile === null ? null : stringArrayManifest(mergeFile, SEALED_CLASSIFICATION);
    if (sealed === null || sealed.kind !== "ok") {
      invariants.push(
        violated(
          "R2",
          "authority tables are declared NON-REASSIGNABLE",
          `${MERGE_HELPERS_MODULE} :: ${SEALED_CLASSIFICATION}`,
          `all ${authority.length} authority tables appear in the sealed classification`,
          [
            sealed === null
              ? `cannot prove the property: ${MERGE_HELPERS_MODULE} is unreadable`
              : manifestFailure(sealed),
          ]
        )
      );
    } else {
      const listed = new Set(sealed.values);
      const missing = authority.filter((table) => !listed.has(table));
      invariants.push(
        missing.length === 0
          ? satisfied(
              "R2",
              "authority tables are declared NON-REASSIGNABLE",
              `${MERGE_HELPERS_MODULE} :: ${SEALED_CLASSIFICATION}`,
              `all ${authority.length} authority tables appear among the ${sealed.values.length} sealed entries`
            )
          : violated(
              "R2",
              "authority tables are declared NON-REASSIGNABLE",
              `${MERGE_HELPERS_MODULE} :: ${SEALED_CLASSIFICATION}`,
              `all ${authority.length} authority tables appear among the ${sealed.values.length} sealed entries`,
              missing.map((table) => `"${table}" is not classified as non-reassignable`)
            )
      );
    }
  } else {
    invariants.push(
      dormantOrUndecided(
        surface,
        surfaceEnumeration,
        "R2",
        "authority tables are declared NON-REASSIGNABLE",
        `${MERGE_HELPERS_MODULE} :: ${SEALED_CLASSIFICATION}`,
        `all ${authority.length} authority tables appear in the sealed classification`
      )
    );
  }

  /* ---- R3: registry label coupled to its finder's query (always active) ---- */
  if (registry === null || registry.kind !== "ok") {
    invariants.push(
      violated(
        "R3",
        "every rewrite-registry label matches the table its own finder queries",
        `${MERGE_HELPERS_MODULE} :: ${REWRITE_REGISTRY} finders`,
        "each entry's declared table literal equals the set of table literals its finder queries",
        [
          registry === null
            ? `cannot prove the property: ${MERGE_HELPERS_MODULE} is unreadable`
            : `cannot prove the property: ${registry.reason}`,
        ]
      )
    );
  } else {
    const violations: string[] = [];
    for (const entry of registry.entries) {
      if (entry.labelProblem !== null) {
        violations.push(`line ${entry.line}: ${entry.labelProblem}`);
        continue;
      }
      for (const problem of entry.problems) {
        violations.push(`"${entry.label}" ${problem}`);
      }
      if (entry.problems.length > 0) continue;
      const queried = [...new Set(entry.queryLiterals)].sort();
      if (queried.length === 0) {
        violations.push(
          `"${entry.label}" (line ${entry.line}): finder contains no literal .query("...") — its table is not provable from source`
        );
        continue;
      }
      const unexpected = queried.filter((table) => table !== entry.label);
      if (unexpected.length > 0) {
        violations.push(
          `"${entry.label}" (line ${entry.line}): finder also queries ${unexpected
            .map((t) => `"${t}"`)
            .join(", ")} — the label does not describe what the finder returns`
        );
      }
    }
    invariants.push(
      violations.length === 0
        ? satisfied(
            "R3",
            "every rewrite-registry label matches the table its own finder queries",
            `${MERGE_HELPERS_MODULE} :: ${REWRITE_REGISTRY} finders`,
            `all ${registry.entries.length} entries query exactly the one table they declare`
          )
        : violated(
            "R3",
            "every rewrite-registry label matches the table its own finder queries",
            `${MERGE_HELPERS_MODULE} :: ${REWRITE_REGISTRY} finders`,
            `all ${registry.entries.length} entries query exactly the one table they declare`,
            violations
          )
    );
  }

  /* ---- R4: absent from ADMIN_TABLES (always active) ---- */
  const adminText = source.read(ADMIN_DATA_MODULE);
  const adminRead =
    adminText === null
      ? null
      : objectArrayManifest(parseModule(adminText, ADMIN_DATA_MODULE), ADMIN_TABLE_MANIFEST, "table");
  if (adminRead === null || adminRead.kind !== "ok") {
    invariants.push(
      violated(
        "R4",
        "authority tables are absent from the raw admin data editor",
        `${ADMIN_DATA_MODULE} :: ${ADMIN_TABLE_MANIFEST}`,
        "no authority table is browsable or editable from the cross-tenant admin surface",
        [
          adminRead === null
            ? `cannot prove the property: ${ADMIN_DATA_MODULE} is unreadable`
            : manifestFailure(adminRead),
        ]
      )
    );
  } else {
    const listed = new Set(adminRead.values);
    const exposed = authority.filter((table) => listed.has(table));
    invariants.push(
      exposed.length === 0
        ? satisfied(
            "R4",
            "authority tables are absent from the raw admin data editor",
            `${ADMIN_DATA_MODULE} :: ${ADMIN_TABLE_MANIFEST}`,
            `none of the ${authority.length} authority tables appears among the ${adminRead.values.length} admin-browsable tables`
          )
        : violated(
            "R4",
            "authority tables are absent from the raw admin data editor",
            `${ADMIN_DATA_MODULE} :: ${ADMIN_TABLE_MANIFEST}`,
            `none of the ${authority.length} authority tables appears among the ${adminRead.values.length} admin-browsable tables`,
            exposed.map(
              (table) =>
                `"${table}" is exposed to the raw JSON record editor, which can patch and hard-delete any listed row`
            )
          )
    );
  }

  /* ---- R5: present in BOTH destructive lifecycle manifests (ratcheted) ---- */
  if (surface === "PRESENT") {
    const resetText = source.read(ORG_FINANCIAL_RESET_MODULE);
    const deletionText = source.read(ADMIN_ORGS_MODULE);
    const resetRead =
      resetText === null
        ? null
        : stringArrayManifest(parseModule(resetText, ORG_FINANCIAL_RESET_MODULE), RESET_MANIFEST);
    const deletionRead =
      deletionText === null
        ? null
        : objectArrayManifest(parseModule(deletionText, ADMIN_ORGS_MODULE), DELETION_MANIFEST, "table");

    const violations: string[] = [];
    let resetCount = 0;
    let deletionCount = 0;

    if (resetRead === null || resetRead.kind !== "ok") {
      violations.push(
        resetRead === null
          ? `cannot prove the property: ${ORG_FINANCIAL_RESET_MODULE} is unreadable`
          : manifestFailure(resetRead)
      );
    } else {
      resetCount = resetRead.values.length;
      const listed = new Set(resetRead.values);
      for (const table of authority.filter((t) => !listed.has(t))) {
        violations.push(
          `"${table}" is missing from ${RESET_MANIFEST} — a financial reset would strand live retained credit on an otherwise fresh ledger`
        );
      }
    }

    if (deletionRead === null || deletionRead.kind !== "ok") {
      violations.push(
        deletionRead === null
          ? `cannot prove the property: ${ADMIN_ORGS_MODULE} is unreadable`
          : manifestFailure(deletionRead)
      );
    } else {
      deletionCount = deletionRead.values.length;
      const listed = new Set(deletionRead.values);
      for (const table of authority.filter((t) => !listed.has(t))) {
        violations.push(
          `"${table}" is missing from ${DELETION_MANIFEST} — hardDeleteOrg would report success while this authority outlived its tenant`
        );
      }
    }

    const proved =
      `all ${authority.length} authority tables are NAMED in both destructive manifests ` +
      `(${resetCount} reset entries, ${deletionCount} deletion steps inspected)`;
    invariants.push(
      violations.length === 0
        ? satisfied(
            "R5",
            "authority tables are named in both destructive lifecycle manifests",
            `${ORG_FINANCIAL_RESET_MODULE} :: ${RESET_MANIFEST} + ${ADMIN_ORGS_MODULE} :: ${DELETION_MANIFEST}`,
            proved
          )
        : violated(
            "R5",
            "authority tables are named in both destructive lifecycle manifests",
            `${ORG_FINANCIAL_RESET_MODULE} :: ${RESET_MANIFEST} + ${ADMIN_ORGS_MODULE} :: ${DELETION_MANIFEST}`,
            proved,
            violations
          )
    );
  } else {
    invariants.push(
      dormantOrUndecided(
        surface,
        surfaceEnumeration,
        "R5",
        "authority tables are named in both destructive lifecycle manifests",
        `${ORG_FINANCIAL_RESET_MODULE} :: ${RESET_MANIFEST} + ${ADMIN_ORGS_MODULE} :: ${DELETION_MANIFEST}`,
        `all ${authority.length} authority tables are NAMED in both destructive manifests`
      )
    );
  }

  /* ---- R6: literal authority creation only in the owner module ---- */
  const exempt = new Set(AUTHORITY_INSERT_FIXTURE_EXCLUSIONS);
  const allSites: AuthorityInsertSite[] = [];
  for (const file of source.listConvexModules()) {
    const text = source.read(file);
    if (text === null) continue;
    allSites.push(...findAuthorityInserts(text, file));
  }
  const exemptedInsertSites = allSites.filter((site) => exempt.has(site.file));
  const consideredSites = allSites.filter((site) => !exempt.has(site.file));
  const strayInserts = consideredSites.filter((site) => site.file !== AUTHORITY_OWNER_MODULE);

  const r6Violations = strayInserts.map(
    (site) =>
      `${site.file}:${site.line} creates a "${site.table}" row by literal — only ${AUTHORITY_OWNER_MODULE} may mint receipt authority`
  );
  if (surface === "PRESENT" && source.read(AUTHORITY_OWNER_MODULE) === null) {
    r6Violations.push(
      `the authority surface exists in the schema but its declared owner module ${AUTHORITY_OWNER_MODULE} is absent`
    );
  }
  invariants.push(
    r6Violations.length === 0
      ? satisfied(
          "R6",
          "literal authority-table creation occurs only in the owner module",
          `every convex module (${source.listConvexModules().length} inspected)`,
          `all ${consideredSites.length} source sites that name an authority table in a literal insert are inside ${AUTHORITY_OWNER_MODULE}`
        )
      : violated(
          "R6",
          "literal authority-table creation occurs only in the owner module",
          `every convex module (${source.listConvexModules().length} inspected)`,
          `all ${consideredSites.length} source sites that name an authority table in a literal insert are inside ${AUTHORITY_OWNER_MODULE}`,
          r6Violations
        )
  );

  /* ---- a partially declared surface is a defect in itself ---- */
  if (surface === "PARTIAL" || surface === "UNREADABLE") {
    invariants.unshift(
      violated(
        "R0",
        "the authority surface is declared whole, or not at all",
        SCHEMA_MODULE,
        "convex/schema.ts declares either all three authority tables or none",
        surface === "UNREADABLE"
          ? schemaProblems.map(
              (problem) =>
                `cannot decide the ratchet trigger, so R2 and R5 cannot be trusted: ${problem}`
            )
          : [
              `only ${declared.length} of ${authority.length} authority tables are declared (${declared.join(", ")}) — every ratcheted invariant below is decided against a half-built surface`,
            ]
      )
    );
  }

  return {
    root: source.describe(),
    authoritySurface: surface,
    schemaTablesInspected: schemaTables.length,
    declaredAuthorityTables: declared,
    invariants,
    exemptedInsertSites,
    ok: invariants.every((invariant) => invariant.verdict !== "VIOLATED"),
  };
}

/**
 * Phrasings this guard must never produce.
 *
 * Ruling c17733 point 6: the output must name what it proved, individually, and
 * must never print or imply that all receipt authority writes are verified. A
 * test asserts that no report — passing or failing — contains any of these.
 */
export const FORBIDDEN_TOTALITY_PHRASES: readonly string[] = [
  "all receipt authority writes verified",
  "all authority writes verified",
  "all writes verified",
  "every write verified",
  "every database write",
  "no unauthorized writes",
  "authority writes are safe",
  "fully verified",
];

export function formatRatchetReport(report: RatchetReport): string {
  const lines: string[] = [];
  lines.push("SCRUM-238 receipt authority structural ratchet");
  lines.push(`  source          : ${report.root}`);
  lines.push(
    `  authority surface: ${report.authoritySurface} ` +
      `(${SCHEMA_MODULE} declares ${report.schemaTablesInspected} tables; ` +
      `${report.declaredAuthorityTables.length} of ${AUTHORITY_TABLES.length} authority tables)`
  );
  lines.push("");

  for (const invariant of report.invariants) {
    lines.push(`${invariant.id}  ${invariant.verdict}`);
    lines.push(`    property : ${invariant.title}`);
    lines.push(`    read from: ${invariant.subject}`);
    if (invariant.verdict === "SATISFIED") {
      lines.push(`    proved   : ${invariant.proved}`);
    } else if (invariant.verdict === "INACTIVE") {
      lines.push(`    would prove: ${invariant.proved}`);
      lines.push(`    inactive because: ${invariant.inactiveBecause ?? "unknown"}`);
    } else {
      lines.push(`    NOT proved: ${invariant.proved}`);
      for (const violation of invariant.violations) lines.push(`      - ${violation}`);
    }
    lines.push("");
  }

  if (report.exemptedInsertSites.length > 0) {
    lines.push("EXPLICITLY EXEMPTED FIXTURE SITES (R6) — listed so the exemption is visible:");
    for (const site of report.exemptedInsertSites) {
      lines.push(`  - ${site.file}:${site.line} inserts "${site.table}"`);
    }
    lines.push("");
  }

  lines.push("WHAT THIS DOES NOT PROVE");
  lines.push(
    "  - It is an accidental-regression and convention guard, NOT an adversarial"
  );
  lines.push("    security proof.");
  lines.push(
    "  - It does NOT establish that every TypeScript write to these tables has been"
  );
  lines.push(
    "    identified. It reads source syntax and fixed manifests only; a write whose"
  );
  lines.push(
    "    table is not named by a literal in source is invisible to it, by design."
  );
  lines.push(
    "  - R5 checks PRESENCE in the destructive manifests. It does NOT certify deletion"
  );
  lines.push("    sequencing, phase barriers or lifecycle correctness — SCRUM-231 owns those.");
  lines.push(
    "  - Runtime refusal on the customer-merge path — losing customer holding live"
  );
  lines.push(
    "    authority, and row identity matching its registry label — is SCRUM-250, and is"
  );
  lines.push("    not implemented or checked here.");
  lines.push(
    "  - An INACTIVE verdict means the subject does not exist yet, with the enumeration"
  );
  lines.push("    above showing why. It is not a pass.");
  lines.push("");
  lines.push(report.ok ? "RESULT: no violated invariant." : "RESULT: VIOLATED.");
  return lines.join("\n");
}

/** CLI: `tsx scripts/receiptAuthorityStructuralRatchet.ts [repoRoot]`. */
export function runCli(argv: readonly string[]): number {
  const root = argv[0] ?? process.cwd();
  const report = checkStructuralRatchet(fileSystemSource(root));
  process.stdout.write(`${formatRatchetReport(report)}\n`);
  return report.ok ? 0 : 1;
}
