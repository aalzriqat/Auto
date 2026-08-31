/**
 * SCRUM-208 — static guard for writes to commitment liveness fields made
 * outside the writer choke.
 *
 * ## The shape
 *
 * A module that is not the deposit or commitment authority reaches in and
 * patches a liveness flag directly — `ctx.db.patch(reservation.depositId,
 * { holdActive: false })` from `vehicles.ts`, which is what three live sites
 * did until this guard was written. Nothing else in the toolchain can see it:
 * it typechecks, it lints, and it is individually correct at each site. What
 * it is not is *cascaded*, and a stale `holdActive: true` leaves a vehicle
 * STUCK OPEN with nobody holding it and no operator door able to release it.
 *
 * ## Why it is not a copy of `tenantWriteGuard`
 *
 * That guard records a deliberate blind spot: *"only `patch`/`delete`/`replace`
 * are analysed. `ctx.db.insert` is not"* — which is why the `test_drives.create`
 * salesperson leak was invisible to it for as long as it existed.
 *
 * For this defect class an insert-blind guard would be worthless, because
 * **liveness is born at insert**: `depositVehicleHolds` rows are inserted
 * `active: true`, deposits are created `holdActive: true`, and reservations
 * are inserted ACTIVE. A patch-only guard would miss every birth of a live
 * hold and still report green. So `insert` is analysed here, by table name as
 * well as by field.
 *
 * ## What it claims, precisely
 *
 * - It flags `ctx.db.insert` / `patch` / `replace` whose object literal names
 *   a guarded field, and inserts into a guarded table, in any convex module
 *   outside `CHOKE_MODULES`.
 * - It does NOT resolve types. A `patch` whose object names no guarded field
 *   is invisible to it — see the recorded blind spot below.
 * - It is not flow-sensitive and makes no claim about reachability.
 *
 * ## ⚠️ RECORDED BLIND SPOT
 *
 * `depositVehicleHolds.active` and `deposits.status` cannot be distinguished
 * from any other table's `active`/`status` in a `patch`, because the target
 * table is only known from the id's type and this is a source-text analyzer.
 * Inserts into those tables ARE caught (the table name is a literal); patches
 * are caught only when the same object also names a guarded field.
 *
 * Recording it rather than papering over it, for the same reason
 * `tenantWriteGuard` records its own: a green result that means "nothing
 * examined" is indistinguishable from "nothing wrong".
 *
 * ## ⚠️ SECOND RECORDED BLIND SPOT — string literals are NOT blanked
 *
 * Comments are blanked before analysis; string literals deliberately are not,
 * because the table name in `insert("commitmentRoots", …)` IS a string literal
 * and blanking strings would disable table detection entirely. A string whose
 * CONTENTS spell out a guarded write therefore reports a false positive.
 *
 * That direction is the safe one — it fails loud and a human deletes the
 * offending prose — and it is why the rule is documented in comments, which
 * are blanked, rather than in string constants.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * The canonical version this guard certifies, restated rather than imported.
 *
 * A static-analysis script should not pull convex runtime modules into its own
 * module graph. The duplication is pinned instead: `commitmentWriteGuard.test.ts`
 * asserts this equals the real `COMMITMENT_AUTHORITY_V1`, so drift fails CI.
 */
const CANONICAL_AUTHORITY_VERSION = 1;

/**
 * SCRUM-208 — WHY THE WRITE ANALYZERS PARSE INSTEAD OF MATCHING TEXT.
 *
 * The regex versions of these two checks were forgeable in seven ordinary
 * TypeScript spellings, found by Codex xhigh, Sonnet MAX and my own probe and
 * reproduced with controls:
 *
 *   ctx.db.insert('organizations', …)      — invisible, only `"` was matched
 *   ctx.db.insert(`organizations`, …)      — invisible
 *   { ...(f ? { commitmentAuthorityVersion: 1 } : {}) }  — certified INITIALIZED
 *   { migrationHints: { commitmentAuthorityVersion } }   — certified INITIALIZED
 *   ctx.db.patch(o, { commitmentAuthorityVersion })      — invisible to the ratchet
 *   ctx.db.patch(o, { [k]: 0 })                          — invisible to the ratchet
 *   ctx.db.patch(o, { ...patch })                        — invisible to the ratchet
 *
 * A text scan cannot see nesting, conditionality or a binding, and every one of
 * those failures pointed the same way: toward a green result the code had not
 * earned. A green result here is an AUTHORIZATION, so the only acceptable
 * direction of error is refusal.
 *
 * ⚠️ WHAT THIS ACTUALLY COVERS — STATED HONESTLY, BECAUSE THE PREVIOUS VERSION
 * OF THIS COMMENT DID NOT.
 *
 * It claimed that anything unreadable "is reported, not skipped." That was
 * FALSE, and it was the worst defect in the round-5 repair: a confident wrong
 * comment on a check whose green result is an authorization is more dangerous
 * than the holes it was describing away. What is true:
 *
 * CERTIFICATION (`findOrganizationInsertSites`) is fail-closed. It must PROVE
 * the field is set to the canonical version, so it refuses a conditional
 * spread, a nested object, a shorthand binding, an unreadable literal, an
 * unresolved table name, a non-canonical value, and any later property or
 * spread that could override the match. If it cannot read it, it does not
 * certify it.
 *
 * THE RATCHET (`findUnchokedWrites`) is NOT fail-closed, and cannot be made so
 * here. It reads guarded field names at every depth of an INLINE literal —
 * including inside conditional spreads — and reports shorthand, computed keys
 * and unresolved table names. But a payload that is not an inline literal is
 * INVISIBLE to it:
 *
 *   ctx.db.patch(id, patch)          // a binding
 *   ctx.db.patch(id, makePatch())    // a call result
 *   ctx.db.patch(id, cond ? a : b)   // a conditional expression
 *
 * ⚠️ AND THAT IS A DELIBERATE, MEASURED CHOICE, NOT AN OVERSIGHT. Reporting
 * them would be sound, and it was measured: convex/ contains 53 such sites
 * today against a burn-down map of ~9 entries — roughly a sixfold expansion,
 * almost entirely with writes to tables that have no guarded fields at all. A
 * map whose majority is "unreadable but fine" is no longer a ratchet, and the
 * three sites in money files were each read by hand and write `status` /
 * `preHoldStatus`, not guarded fields.
 *
 * A SOUND version of this check needs the target table resolved from the id's
 * `Id<Table>` type, which needs a TypeScript program rather than a source-text
 * pass. That is real work and it is not this file. Until then: this catches
 * inline writes, and it does not catch indirect ones.
 */

/** A `ctx.db.insert|patch|replace(...)` call, with its arguments resolved. */
type DbWriteCall = {
  readonly method: "insert" | "patch" | "replace";
  /** For `insert`, the table name when it is a static literal. */
  readonly table: string | null;
  /** True when the first argument could not be read as a static literal. */
  readonly tableUnresolved: boolean;
  /** The written object literal, when this call's own argument is one. */
  readonly literal: ts.ObjectLiteralExpression | null;
  /**
   * The raw second argument, whatever its shape.
   *
   * ⚠️ NOT THE SAME AS `literal`, AND BOTH ARE NEEDED. Certification asks "is
   * this field provably set here", which only an object literal can answer, so
   * it reads `literal`. The ratchet asks "might a guarded field be written",
   * which must also see a variable, a call result or a conditional — so it
   * reads this.
   */
  readonly written: ts.Expression | null;
  /** Byte offset of the call, for locating its enclosing declaration. */
  readonly start: number;
};

function parseModule(source: string, file: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** `ctx.db.<method>` and nothing else — not `foo.db.insert`, not a rename. */
function ctxDbMethod(node: ts.CallExpression): DbWriteCall["method"] | null {
  const access = node.expression;
  if (!ts.isPropertyAccessExpression(access)) return null;
  const name = access.name.text;
  if (name !== "insert" && name !== "patch" && name !== "replace") return null;
  const db = access.expression;
  if (!ts.isPropertyAccessExpression(db) || db.name.text !== "db") return null;
  return ts.isIdentifier(db.expression) && db.expression.text === "ctx" ? name : null;
}

/** A string only when it is written as one. A binding is NOT a string. */
function staticStringOf(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function collectDbWrites(source: string, file: string): DbWriteCall[] {
  const out: DbWriteCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const method = ctxDbMethod(node);
      if (method) {
        const first = node.arguments[0];
        const table = method === "insert" ? staticStringOf(first) : null;
        // The written object is the 2nd argument for all three methods.
        const written = node.arguments[1];
        out.push({
          method,
          table,
          tableUnresolved: method === "insert" && table === null,
          literal: written && ts.isObjectLiteralExpression(written) ? written : null,
          written: written ?? null,
          start: node.getStart(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parseModule(source, file));
  return out;
}

/**
 * Is `field` set, at the literal's OWN top level, to something readable?
 *
 * UNCONDITIONAL — a plain `field: <value>` property on this literal.
 * ABSENT        — provably not written here, and every property was readable.
 * UNRESOLVED    — the literal is missing, or carries a spread, a computed key,
 *                 or a shorthand binding, so the answer cannot be proven.
 */
export type FieldVerdict = "UNCONDITIONAL" | "ABSENT" | "UNRESOLVED";

/**
 * Does this expression provably say V1, rather than merely say something?
 *
 * ⚠️ THE KEY BEING PRESENT WAS NEVER THE QUESTION. `commitmentAuthorityVersion: 0`
 * and `: undefined` both satisfied "the property exists" and both mint a LEGACY
 * dealership — the exact state the activation slice exists to end. Only the
 * literal `1` and the pinned constant count; every other expression, including
 * anything computed at runtime, is refused. Found by Codex xhigh against
 * 6e2dceb83.
 */
function isCanonicalVersionValue(value: ts.Expression, importsTheConstant: boolean): boolean {
  if (ts.isNumericLiteral(value)) return value.text === String(CANONICAL_AUTHORITY_VERSION);
  // ⚠️ THE SPELLING IS NOT THE BINDING. Accepting the identifier on its name
  // alone certified this, which mints a LEGACY dealership:
  //
  //   const COMMITMENT_AUTHORITY_V1 = 0;
  //   ctx.db.insert("organizations", { commitmentAuthorityVersion: COMMITMENT_AUTHORITY_V1 });
  //
  // So the name only counts when the file actually imports it from the kernel.
  // A file cannot both import that binding and redeclare it locally — TypeScript
  // rejects the redeclaration — so the import is proof the identifier resolves
  // to the real constant. Found by Codex xhigh against 02582f606; it was a hole
  // in my own previous round's value check.
  return importsTheConstant && ts.isIdentifier(value) && value.text === "COMMITMENT_AUTHORITY_V1";
}

/** Does this module import `COMMITMENT_AUTHORITY_V1` from the commitment kernel? */
function importsCanonicalVersionConstant(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    if (!stmt.moduleSpecifier.text.includes("commitmentKernel")) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      // `import { COMMITMENT_AUTHORITY_V1 }` — and not a rename, whose local
      // name would say nothing about what it is bound to.
      if (!el.propertyName && el.name.text === "COMMITMENT_AUTHORITY_V1") return true;
    }
  }
  return false;
}

export function topLevelFieldVerdict(
  literal: ts.ObjectLiteralExpression | null,
  field: string,
  /**
   * Optional proof that the VALUE is acceptable, not merely that the key is
   * present. Without it, `{ commitmentAuthorityVersion: 0 }` certified as
   * initialized — the key was there and nothing looked at what it said.
   */
  acceptsValue?: (value: ts.Expression) => boolean
): FieldVerdict {
  if (!literal) return "UNRESOLVED";

  // ⚠️ A FORWARD PASS, LAST-WINS — NOT AN EARLY RETURN ON THE FIRST MATCH.
  //
  // JS object literals resolve duplicate keys and spreads in source order, so
  // ANYTHING after the match can overwrite it:
  //
  //   { commitmentAuthorityVersion: 1, ...extra }   -> runtime value is extra's
  //   { commitmentAuthorityVersion: 1, …: 0 }       -> runtime value is 0
  //
  // The previous version returned UNCONDITIONAL the instant it saw the key and
  // never looked further, so both of those certified as initialized. Verified
  // against real runtime semantics, not reasoned: `{ver:1, ...{ver:0}}` is
  // `{ver:0}`. Found by Sonnet MAX against 6e2dceb83.
  //
  // Position matters in BOTH directions, which is why this is a running verdict
  // rather than a blanket "any spread refuses": `{ ...extra, ver: 1 }` really is
  // safe, because the explicit assignment comes last and wins.
  let verdict: FieldVerdict = "ABSENT";
  for (const prop of literal.properties) {
    // `...x` can carry the field, and overrides whatever preceded it.
    if (ts.isSpreadAssignment(prop)) {
      verdict = "UNRESOLVED";
      continue;
    }
    const name = prop.name;
    // A computed key might BE the field; it cannot be ruled in or out.
    if (!name || ts.isComputedPropertyName(name)) {
      verdict = "UNRESOLVED";
      continue;
    }
    const key =
      ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
        ? name.text
        : null;
    if (key === null) {
      verdict = "UNRESOLVED";
      continue;
    }
    if (key !== field) continue;

    // Named at top level. A shorthand's value is a binding, not a literal, so
    // it names the field without proving what it sets — refuse rather than
    // certify. `{ commitmentAuthorityVersion }` after `const … = 0` is exactly
    // the downgrade this must not wave through.
    verdict = ts.isPropertyAssignment(prop)
      ? !acceptsValue || acceptsValue(prop.initializer)
        ? "UNCONDITIONAL"
        : "UNRESOLVED"
      : "UNRESOLVED";
  }
  return verdict;
}

export interface UnchokedWrite {
  /** Path relative to the convex root, POSIX separators. */
  file: string;
  method: "insert" | "patch" | "replace";
  /** The guarded field written, or `insert:<table>` for a guarded insert. */
  field: string;
}

/**
 * Fields whose names are distinctive enough to identify their table from the
 * source text alone. A generic `active:` or `status:` is deliberately absent —
 * matching those would flag every unrelated table in the backend.
 */
export const GUARDED_FIELDS = [
  "holdActive",
  "usesVehicleHoldRows",
  "singleVehicleCommitmentClaimId",
  "currentCommitmentClaimId",
  "currentCommitmentClaims",
  "lineageRootId",
  "lineageGeneration",
  "restoredFromRootId",
  "commitmentAuthorityVersion",
] as const;

/** Tables whose every row is a commitment fact. Any insert is a liveness write. */
export const GUARDED_INSERT_TABLES = [
  "depositVehicleHolds",
  "commitmentRoots",
  "vehicleCommitmentClaims",
] as const;

/**
 * The modules allowed to write these fields.
 *
 * `commitments.ts` is already a single-module choke for roots and claims and
 * has never drifted — it is the model the deposit fields lack, not an
 * exception to the rule.
 */
export const CHOKE_MODULES = new Set([
  "commitments.ts",
  "utils/commitmentWriters.ts",
  "utils/commitmentKernel.ts",
  // The one writer of the maintained episode pointers.
  "utils/commitmentSources.ts",
]);

/**
 * Blanks out comments, preserving every byte offset and line break.
 *
 * ⚠️ WITHOUT THIS THE ANALYZERS READ PROSE AS CODE. A doc comment that
 * mentions `ctx.db.insert("commitmentRoots", …)` — as the one on `RootOpening`
 * legitimately does, explaining why a second insert is forbidden — was counted
 * as a real insert site. Documenting the rule would have broken the check that
 * enforces it.
 *
 * Replacement rather than deletion so every reported offset still lines up
 * with the original source, and quote-aware so a `//` inside a string literal
 * (a URL, a refusal message) is not mistaken for a comment.
 */
export function blankComments(source: string): string {
  const out = source.split("");
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") { out[i] = " "; i++; }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      if (i + 1 < source.length) out[i + 1] = " ";
      i += 2;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Reads a balanced `{...}` literal starting at `open`, or "" if unbalanced. */
function objectLiteral(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

/** Scans one module's source for writes outside the choke. */
export function findUnchokedWrites(rawSource: string, file: string): UnchokedWrite[] {
  if (CHOKE_MODULES.has(file)) return [];

  const found: UnchokedWrite[] = [];
  for (const call of collectDbWrites(rawSource, file)) {
    if (call.method === "insert") {
      // ⚠️ A TABLE NAME WE CANNOT READ IS NOT A TABLE WE CAN CLEAR. It could be
      // any guarded table, so it is reported rather than skipped.
      if (call.tableUnresolved) {
        found.push({ file, method: call.method, field: "insert:<unresolved>" });
        continue;
      }
      if (call.table && (GUARDED_INSERT_TABLES as readonly string[]).includes(call.table)) {
        found.push({ file, method: call.method, field: `insert:${call.table}` });
        continue;
      }
    }

    // ⚠️ THE RATCHET ASKS THE OPPOSITE QUESTION FROM THE CREATOR AUDIT, AND
    // THEREFORE SEARCHES DIFFERENTLY. `findOrganizationInsertSites` must prove
    // a field IS set, so only an unconditional top-level property counts and
    // every other shape is refused. This asks whether a guarded field MIGHT be
    // written, so it looks at every depth — including inside a conditional
    // spread, which is exactly how the two real sites are written:
    //
    //   ...(reinstateHold ? { holdActive: true } : {})       saleCancellation
    //   ...(closesTheRow ? { …, holdActive: false } : {})    depositHelpers
    //
    // Restricting this side to top-level properties silently DROPPED both, and
    // a guard that loses coverage is worse than one that is merely forgeable.
    // The burn-down map's exact comparison caught it, which is why it is exact.
    for (const field of namedFieldsAnywhere(call.written)) {
      if ((GUARDED_FIELDS as readonly string[]).includes(field)) {
        found.push({ file, method: call.method, field });
      }
    }

    // A computed key names nothing readable, so it cannot be cleared.
    if (call.written && hasComputedKey(call.written)) {
      found.push({ file, method: call.method, field: "write:<computed-key>" });
    }
  }
  return found;
}

/**
 * Every property name written anywhere inside an expression, at any depth,
 * including shorthand bindings and both branches of a conditional spread.
 *
 * ⚠️ SHORTHAND IS INCLUDED, AND THAT IS THE POINT.
 * `{ commitmentAuthorityVersion }` after `const commitmentAuthorityVersion = 0`
 * writes a guarded field while naming it only once; the text scan this replaced
 * looked for `field:` and so reported nothing. Codex xhigh's reproduction.
 */
function namedFieldsAnywhere(root: ts.Node | null): string[] {
  if (!root) return [];
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      const name = node.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) names.push(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

/** A `{ [expr]: v }` key anywhere inside the written expression. */
function hasComputedKey(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Every non-generated, non-test `.ts` module under `convexRoot`. */
export function convexSourceFiles(convexRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "_generated") walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(convexRoot);
  return out;
}

export function auditCommitmentWrites(convexRoot: string): UnchokedWrite[] {
  return convexSourceFiles(convexRoot).flatMap((file) =>
    findUnchokedWrites(
      fs.readFileSync(file, "utf8"),
      path.relative(convexRoot, file).split(path.sep).join("/")
    )
  );
}

export interface RootInsertSite {
  file: string;
  /** The function the insert is lexically inside. */
  enclosingFunction: string;
}

/**
 * SCRUM-208 — WHERE ROOTS ARE CREATED.
 *
 * ⚠️ THIS EXISTS BECAUSE THE FIELD GUARD ABOVE COULD NOT SEE THE DEFECT.
 * `CHOKE_MODULES` exempts `commitments.ts` wholesale, so a second — or third —
 * `ctx.db.insert("commitmentRoots", …)` inside that very file passes the field
 * guard automatically. That is not hypothetical: the first version of the
 * Phase-3 succession work added exactly such an insert in `openSuccessorRoot`,
 * and this analyzer was green throughout.
 *
 * Module-level exemption is the right granularity for "who may write this
 * field" and the WRONG granularity for "how many places may create a root".
 * The root-creation invariant (M1: one place decides, one place opens) needs a
 * check that counts SITES, and that deliberately ignores the choke list.
 */
export function findRootInsertSites(rawSource: string, file: string): RootInsertSite[] {
  // ⚠️ PARSED, NOT MATCHED — AND FOR A SHARPER REASON THAN ITS SIBLING.
  //
  // This was `/ctx\.db\.insert\(\s*"commitmentRoots"/`, double-quote only, with
  // no unresolved fallback at all. A second root opener written
  // `insert('commitmentRoots', …)` or with a template literal was completely
  // invisible — and because `commitments.ts` is choke-exempt, `findUnchokedWrites`
  // cannot see an extra insert placed there either. This audit is the ONLY
  // defence for "commitmentRoots has exactly one creation site", and changing a
  // quote character defeated it. Found independently by Codex xhigh and Sonnet
  // MAX against 6e2dceb83.
  //
  // An unreadable table name is audited as if it were `commitmentRoots`, for the
  // same reason as the organizations audit: it might be.
  const source = blankComments(rawSource);
  const sites: RootInsertSite[] = [];
  for (const call of collectDbWrites(rawSource, file)) {
    if (call.method !== "insert") continue;
    if (!call.tableUnresolved && call.table !== "commitmentRoots") continue;
    const before = source.slice(0, call.start);
    const declarations = [
      ...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\(/g),
    ];
    const last = declarations[declarations.length - 1];
    sites.push({
      file,
      enclosingFunction: last ? (last[1] ?? last[2]) : "<top level>",
    });
  }
  return sites;
}

/**
 * SCRUM-208 — WHO CAN ASK FOR A SUCCESSOR ROOT.
 *
 * ⚠️ A COMMENT IS NOT AN ENFORCEMENT BOUNDARY. A first correction moved
 * succession out of its own writer and into an optional `successorOf`
 * parameter on the EXPORTED `acquireVehicle`, documented as "only
 * `restoreCommitment` supplies this". Any backend caller could still have
 * passed a terminal root with unrelated evidence and reached successor
 * creation without ever going through the restoration resolver.
 *
 * Module privacy is the boundary. This check pins it: the successor opening
 * shape may only be constructed inside the unexported executor, and the
 * executor may not be exported.
 */
export interface SuccessorTopology {
  /**
   * Enclosing function of every `opening: { … }` argument construction — the
   * shape actually handed to the private `openRoot`.
   *
   * Deliberately NOT every `kind: "SUCCESSOR"` token: the discriminated-union
   * TYPE declaration and the executor's internal `target` descriptor both use
   * that literal without opening anything, and counting them would make the
   * check fire on declarations rather than on writes.
   */
  openingSites: string[];
  /** Names of any exported function taking a caller-supplied successor root. */
  exportedSuccessorParams: string[];
}

export function analyzeSuccessorTopology(rawSource: string): SuccessorTopology {
  const source = blankComments(rawSource);
  const openingSites: string[] = [];
  for (const m of source.matchAll(/opening:\s*\{/g)) {
    const before = source.slice(0, m.index!);
    const declarations = [
      ...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\(/g),
    ];
    const last = declarations[declarations.length - 1];
    openingSites.push(last ? (last[1] ?? last[2]) : "<top level>");
  }

  // ⚠️ PARSED, BECAUSE THE OLD PATTERN REQUIRED A PARTICULAR LAYOUT.
  //
  // It was `/export\s+(?:async\s+)?function\s+(\w+)\s*\(([\s\S]*?)\n\)/`, which
  // needs the closing paren on its own line — so it saw only the multi-line
  // declaration style the test itself happens to use. A single-line `export
  // function f(ctx, args: { successorOf?: … })` and an `export const f = async
  // (…) => …` were both MISSED, and this check is what stops a caller-supplied
  // successor root being reintroduced on an exported function. A guard that
  // depends on where somebody put a newline is not a guard. Found by Sonnet MAX
  // against 6e2dceb83.
  const exportedSuccessorParams: string[] = [];
  const isExported = (node: ts.Node): boolean =>
    (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword
    );
  const declaresSuccessorOf = (params: readonly ts.ParameterDeclaration[]): boolean => {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isPropertySignature(n) && n.name && ts.isIdentifier(n.name)) {
        if (n.name.text === "successorOf") {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    for (const p of params) visit(p);
    return found;
  };
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && isExported(node)) {
      if (declaresSuccessorOf(node.parameters)) exportedSuccessorParams.push(node.name.text);
    }
    // `export const f = (…) => …` and `export const f = function (…) {…}`
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (!init || !ts.isIdentifier(decl.name)) continue;
        if (!ts.isArrowFunction(init) && !ts.isFunctionExpression(init)) continue;
        if (declaresSuccessorOf(init.parameters)) exportedSuccessorParams.push(decl.name.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(parseModule(rawSource, "successorTopology.ts"));

  return { openingSites, exportedSuccessorParams };
}

export function auditRootInserts(convexRoot: string): RootInsertSite[] {
  return convexSourceFiles(convexRoot).flatMap((file) =>
    findRootInsertSites(
      fs.readFileSync(file, "utf8"),
      path.relative(convexRoot, file).split(path.sep).join("/")
    )
  );
}

export interface OrganizationInsertSite {
  file: string;
  /** The function the insert is lexically inside. */
  enclosingFunction: string;
  /** Whether the inserted literal initializes `commitmentAuthorityVersion`. */
  initializesAuthorityVersion: boolean;
}

/**
 * SCRUM-208 / SCRUM-201 — EVERY DEALERSHIP IS BORN ON A KNOWN AUTHORITY.
 *
 * ⚠️ THE FIELD GUARD ABOVE CANNOT ENFORCE THIS, AND THE REASON IS THE FAILURE
 * MODE ITSELF. `findUnchokedWrites` reports modules that WRITE a guarded
 * field. A second organization creator that simply OMITS
 * `commitmentAuthorityVersion` writes no guarded field at all — so it passes
 * the field guard, passes typecheck, passes lint, and silently mints LEGACY
 * dealerships that can never reach the canonical restoration lifecycle. Every
 * reversal such a tenant defers terminalizes
 * AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE forever — precisely the condition
 * the activation slice exists to end, silently reintroduced.
 *
 * "Who may write this field" and "does every creation site set it" are
 * different questions, and only the second has an ABSENCE for an answer. An
 * absence is invisible to a write-scanner, so this counts SITES — the same
 * reason `findRootInsertSites` exists alongside the field guard rather than
 * inside it.
 *
 * ⚠️ AN INDIRECT INSERT IS REPORTED AS NOT-INITIALIZING, DELIBERATELY.
 * `ctx.db.insert("organizations", orgDoc)` hands the analyzer no literal to
 * read. Searching forward for the next `{` would find an unrelated block and
 * could report a FALSE PASS, so the gap between the table name and the brace
 * must be a bare comma. Anything else fails loudly, and a human either inlines
 * the literal or records why it cannot be read. Failing closed is the only
 * safe direction for a check whose green result is an authorization.
 */
export function findOrganizationInsertSites(
  rawSource: string,
  file: string
): OrganizationInsertSite[] {
  const source = blankComments(rawSource);
  // Whether the canonical constant's NAME can be trusted in this file at all.
  const importsConstant = importsCanonicalVersionConstant(parseModule(rawSource, file));
  const sites: OrganizationInsertSite[] = [];
  for (const call of collectDbWrites(rawSource, file)) {
    if (call.method !== "insert") continue;
    // ⚠️ AN UNREADABLE TABLE NAME IS AUDITED AS IF IT WERE `organizations`.
    // It might be. Skipping it is the single-quote hole that made this scanner
    // forgeable; reporting it costs nothing (there are no dynamic inserts in
    // convex/ today) and refuses the future one.
    if (!call.tableUnresolved && call.table !== "organizations") continue;

    // ⚠️ TOP-LEVEL DECLARATIONS ONLY, ANCHORED TO COLUMN 0.
    //
    // Broader than the root scanner's pattern in one direction and narrower in
    // another. Broader because an organization is created inside a registered
    // `const create = mutation({ … })`, which neither `function f(` nor
    // `const f = (` matches. Narrower because an unanchored `const` pattern
    // reports the nearest LOCAL binding instead of the function: in the real
    // module the statement immediately above the insert is
    // `const user = await requireOrCreateAuthenticatedUser(ctx)`, so the site
    // would be named "user" — true of the source text and useless to a reader
    // trying to find the second creator.
    //
    // The root scanner is left byte-identical rather than generalised, because
    // its exact expected output is already a certified assertion.
    const declarations = [
      ...source
        .slice(0, call.start)
        .matchAll(
          /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm
        ),
    ];
    const last = declarations[declarations.length - 1];
    // ⚠️ ONLY AN UNCONDITIONAL TOP-LEVEL PROPERTY COUNTS AS INITIALIZED.
    // A conditional spread, a nested object, a shorthand binding and an
    // unreadable literal all resolve to NOT initialized — each of those was a
    // way to make this scanner certify a creator that mints LEGACY orgs.
    sites.push({
      file,
      enclosingFunction: last ? (last[1] ?? last[2]) : "<top level>",
      initializesAuthorityVersion:
        topLevelFieldVerdict(call.literal, "commitmentAuthorityVersion", (v) =>
          isCanonicalVersionValue(v, importsConstant)
        ) ===
        "UNCONDITIONAL",
    });
  }
  return sites;
}

export function auditOrganizationInserts(convexRoot: string): OrganizationInsertSite[] {
  return convexSourceFiles(convexRoot).flatMap((file) =>
    findOrganizationInsertSites(
      fs.readFileSync(file, "utf8"),
      path.relative(convexRoot, file).split(path.sep).join("/")
    )
  );
}

/** `file::field` counts, the stable shape the ratchet is pinned on. */
export function summarize(writes: UnchokedWrite[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of writes) {
    const key = `${w.file}::${w.field}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
