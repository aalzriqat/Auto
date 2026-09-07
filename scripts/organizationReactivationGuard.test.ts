/**
 * SCRUM-297 — structural ratchet: every writer that returns an organization to
 * service must consult the irreversible-purge guard.
 *
 * The first version of that fix guarded `unsuspendOrg` and missed
 * `rejectDeletionRequest`, which clears `suspended` with exactly the same
 * effect. Nothing in the toolchain could tell the two apart — one had a guard,
 * the other had a comment explaining why it did not need one, and the comment
 * was wrong.
 *
 * This is deliberately a SOURCE test rather than a behavioral one. A behavioral
 * test can only exercise the reactivation paths somebody already thought of;
 * the defect here was a path nobody enumerated.
 *
 * ⚠️ If this fails because you added a legitimate new reactivation path, the fix
 * is to call `assertNoIrreversiblePurgeHistory` in it — not to add it to an
 * exemption list.
 *
 * ═══ WHY THIS PARSES INSTEAD OF SCANNING TEXT ═══
 *
 * Two earlier versions of this file matched source text with regular
 * expressions, and BOTH were defeated by ordinary, unobfuscated code:
 *
 *  1. The audit-payload exclusion matched the bare substring `after:`, which
 *     also occurs in prose, so a real write preceded by such a comment counted
 *     as zero. Fixed by stripping comments and anchoring to `after: {`.
 *  2. That fix was applied to the writes counter only. The guards counter still
 *     read raw source, so a single ordinary comment MENTIONING
 *     `assertNoIrreversiblePurgeHistory(` anywhere in the file made an
 *     unguarded writer invisible. And because the check compared FILE-WIDE
 *     TOTALS, a handler that called the guard twice banked a spare credit that
 *     masked a completely separate, entirely unguarded handler.
 *
 * Three defects, one class: a token that means something to a human being read
 * as if it meant the same thing to a parser. Patching a third anchor would have
 * been the third repair of the same fault, so the text scan is gone. This walks
 * the TypeScript AST instead, where comments do not exist as nodes, nesting is
 * structural rather than positional, and "is this write guarded" is asked PER
 * ENCLOSING FUNCTION rather than by counting the file.
 *
 * ═══ WHAT THIS GUARANTEES, STATED HONESTLY ═══
 *
 * It flags a `ctx.db.patch(...)` or `ctx.db.replace(...)` whose object literal
 * assigns `suspended: false` as a direct property, when the enclosing function
 * does not call `assertNoIrreversiblePurgeHistory`. Comments, prose, nesting
 * depth and call counts elsewhere in the file cannot affect that answer.
 *
 * The one known gap, stated because a control that overclaims manufactures
 * confidence: a COMPUTED key — `{ [someVariable]: false }` — is not resolved.
 * Answering that needs a type checker resolving the variable's value, not a
 * parser. A deliberately obfuscated writer can still evade this. It is a
 * detective control against the accidental addition that has now happened
 * twice, not a proof of absence.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CONVEX_DIR = path.join(__dirname, "..", "convex");
const GUARD_NAME = "assertNoIrreversiblePurgeHistory";

/** Every non-test source file under convex/, recursively. */
function convexSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated") continue;
      out.push(...convexSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

function parse(source: string, fileName = "fixture.ts") {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
}

/** `ctx.db.patch(...)` / `ctx.db.replace(...)` — the two writes that can mutate an existing row. */
function isDbWrite(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "patch" && callee.name.text !== "replace") return false;
  const target = callee.expression;
  return ts.isPropertyAccessExpression(target) && target.name.text === "db";
}

/**
 * Does this write assign `suspended: false` as a DIRECT property of the patch
 * object? Direct is the point: `{ transitionLog: { suspended: false } }` writes
 * a log entry, not a reactivation, and the previous text scan could not tell
 * the difference in either direction.
 */
function clearsSuspension(call: ts.CallExpression) {
  const payload = call.arguments[1];
  if (!payload || !ts.isObjectLiteralExpression(payload)) return false;
  return payload.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name;
    const named =
      (ts.isIdentifier(name) && name.text === "suspended") ||
      (ts.isStringLiteral(name) && name.text === "suspended");
    return named && property.initializer.kind === ts.SyntaxKind.FalseKeyword;
  });
}

type FunctionLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The nearest enclosing function, or undefined for a write at module scope. */
function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function callsGuard(scope: ts.Node) {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GUARD_NAME) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scope, visit);
  return found;
}

export type ReactivatingWrite = { line: number; guarded: boolean };

/**
 * Every write that returns an organization to service, each answered
 * independently: is the function CONTAINING this write the one that consults
 * the guard? A guard call in some other function is not an answer about this
 * one — which is exactly what the file-wide count got wrong.
 */
export function findReactivatingWrites(source: string, fileName = "fixture.ts"): ReactivatingWrite[] {
  const sourceFile = parse(source, fileName);
  const writes: ReactivatingWrite[] = [];

  const visit = (node: ts.Node) => {
    if (isDbWrite(node) && clearsSuspension(node)) {
      const scope = enclosingFunction(node);
      writes.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        // A write at module scope has no function to guard it, so it is never guarded.
        guarded: scope ? callsGuard(scope) : false,
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return writes;
}

describe("SCRUM-297 organization reactivation guard", () => {
  test("the scan actually reaches the source tree", () => {
    // A ratchet that enumerates nothing passes vacuously. Pin that it doesn't.
    const files = convexSourceFiles(CONVEX_DIR);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith("adminOrgs.ts"))).toBe(true);
  });

  test("every write that reactivates an organization is guarded in its own function", () => {
    const offenders: string[] = [];

    for (const file of convexSourceFiles(CONVEX_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      for (const write of findReactivatingWrites(source, file)) {
        if (write.guarded) continue;
        offenders.push(`${path.relative(CONVEX_DIR, file).replace(/\\/g, "/")}:${write.line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the reactivating writes are where we think they are", () => {
    // Pins the blast radius itself. If reactivation spreads to a new file, this
    // fails even when that file happens to guard itself correctly — a new
    // reactivation surface is a decision worth making on purpose.
    const files = convexSourceFiles(CONVEX_DIR)
      .filter((file) => findReactivatingWrites(fs.readFileSync(file, "utf8"), file).length > 0)
      .map((file) => path.relative(CONVEX_DIR, file).replace(/\\/g, "/"))
      .sort();

    expect(files).toEqual(["adminOrgs.ts"]);
  });

  /**
   * Meta-tests for the detector itself.
   *
   * A ratchet nobody tests is a ratchet nobody knows is broken. Every case
   * below is a real defect that a previous version of this file failed to
   * catch — the first found by an adversarial reviewer, the rest by a reviewer
   * and CodeRabbit independently on the same commit. None of them involves
   * obfuscation; they are all shapes ordinary code takes.
   */
  describe("the detector itself", () => {
    test("finds both real writers in the production file, both guarded", () => {
      const file = path.join(CONVEX_DIR, "adminOrgs.ts");
      const writes = findReactivatingWrites(fs.readFileSync(file, "utf8"), file);

      expect(writes).toHaveLength(2);
      expect(writes.every((write) => write.guarded)).toBe(true);
    });

    test("MECHANISM A: a nested after:{ in the same patch literal cannot hide the write", () => {
      const source = [
        "async function reopen() {",
        "  await ctx.db.patch(args.orgId, {",
        '    transitionLog: { after: { status: "active" } },',
        "    suspended: false,",
        "  });",
        "}",
      ].join("\n");

      const writes = findReactivatingWrites(source);
      expect(writes).toHaveLength(1);
      expect(writes[0].guarded).toBe(false);
    });

    test("MECHANISM B: a prose mention of the guard's name does not count as calling it", () => {
      const source = [
        `// see ${GUARD_NAME}( in unsuspendOrg for the rationale`,
        "async function reopen() {",
        "  await ctx.db.patch(args.orgId, { suspended: false });",
        "}",
      ].join("\n");

      expect(findReactivatingWrites(source)).toEqual([{ line: 3, guarded: false }]);
    });

    test("MECHANISM C: one function's spare guard call cannot cover another function's write", () => {
      const source = [
        "async function guardedTwice() {",
        `  await ${GUARD_NAME}(ctx, org);`,
        `  await ${GUARD_NAME}(ctx, org);`,
        "  await ctx.db.patch(a, { suspended: false });",
        "}",
        "async function notGuardedAtAll() {",
        "  await ctx.db.patch(a, { suspended: false });",
        "}",
      ].join("\n");

      const writes = findReactivatingWrites(source);
      expect(writes).toHaveLength(2);
      expect(writes.map((write) => write.guarded)).toEqual([true, false]);
    });

    test("a block comment describing an audit payload is not a write", () => {
      const source = [
        "/**",
        " * Mirrors the shape logged as after: { suspended: false }.",
        " */",
        "async function noop() { return 1; }",
      ].join("\n");

      expect(findReactivatingWrites(source)).toEqual([]);
    });

    test("the audit payload that only REPORTS the change is still not a write", () => {
      const source = [
        "async function log() {",
        "  await logAdminAction(ctx, admin, { after: { suspended: false } });",
        "}",
      ].join("\n");

      expect(findReactivatingWrites(source)).toEqual([]);
    });

    test("a nested suspended:false that is not a direct patch property is not a reactivation", () => {
      const source = [
        "async function record() {",
        "  await ctx.db.patch(a, { snapshot: { suspended: false } });",
        "}",
      ].join("\n");

      expect(findReactivatingWrites(source)).toEqual([]);
    });

    test("a write at module scope has no function to guard it and is an offender", () => {
      const source = "await ctx.db.patch(a, { suspended: false });";

      expect(findReactivatingWrites(source)).toEqual([{ line: 1, guarded: false }]);
    });
  });
});
