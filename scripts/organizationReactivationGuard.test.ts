/**
 * SCRUM-297 — structural ratchet: only one function may return an organization
 * to service, and it consults the irreversible-purge guard.
 *
 * ═══ WHY THE QUESTION CHANGED ═══
 *
 * The first version of the fix guarded `unsuspendOrg` and missed
 * `rejectDeletionRequest`, which clears `suspended` with exactly the same
 * effect — one had a guard, the other had a comment explaining why it did not
 * need one, and the comment was wrong. So this ratchet was written to ask "is
 * every reactivating write guarded?"
 *
 * That question was defeated five times, none of them requiring obfuscation:
 *
 *  1. the audit-payload exclusion matched the bare substring `after:`, which
 *     also occurs in prose, so a real write preceded by such a comment vanished;
 *  2. the same prose-token flaw survived in the GUARDS counter, so one ordinary
 *     comment mentioning `assertNoIrreversiblePurgeHistory(` hid an unguarded
 *     writer;
 *  3. the check compared FILE-WIDE TOTALS, so a handler calling the guard twice
 *     banked a credit that covered a completely separate unguarded handler;
 *  4. `suspended: undefined` was not matched at all — and it reactivates, since
 *     `requireTenantAuth` tests the field for TRUTHINESS, not for `=== true`;
 *  5. a guard call placed AFTER the write, or inside a branch that never runs,
 *     still counted as "this function calls the guard".
 *
 * 1-3 were text-matching faults and were fixed by parsing. 4 and 5 were not:
 * they are the question itself being hard. Answering 5 properly needs
 * control-flow dominance analysis, and 4 needs a type checker to resolve
 * arbitrary value expressions.
 *
 * So the question was replaced instead of answered again. `adminOrgs.ts` now
 * has exactly ONE function that clears suspension — `reactivateOrganization` —
 * with the guard fused into it on the line above the write. This file no longer
 * asks whether a write is guarded. It asks whether any OTHER code clears
 * `suspended` at all, which is a structural fact a parser settles outright.
 *
 * ⚠️ If this fails because you added a legitimate new reactivation path, the fix
 * is to call `reactivateOrganization` from it — not to add an exemption.
 *
 * ═══ WHAT THIS GUARANTEES, STATED HONESTLY ═══
 *
 * Any `ctx.db.patch`/`ctx.db.replace` payload that names `suspended` with any
 * value other than the literal `true`, anywhere in non-test `convex/` source
 * outside `reactivateOrganization`, fails this test. `false`, `undefined`, a
 * shorthand `{ suspended }`, and a variable are all caught, because the check is
 * on the PROPERTY NAME and it fails closed on any value it cannot prove is
 * `true`.
 *
 * The one known gap: a COMPUTED key — `{ [name]: false }` — is not resolved.
 * That needs a type checker evaluating the variable, not a parser. A
 * deliberately obfuscated writer still gets past. This is a detective control
 * against the accidental omission that has now happened twice here, not a proof
 * of absence.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CONVEX_DIR = path.join(__dirname, "..", "convex");
const GUARD_NAME = "assertNoIrreversiblePurgeHistory";
const AUTHORIZED_WRITER = "reactivateOrganization";

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

/** `ctx.db.patch(...)` / `ctx.db.replace(...)` — the writes that mutate an existing row. */
function isDbWrite(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text !== "patch" && callee.name.text !== "replace") return false;
  const target = callee.expression;
  return ts.isPropertyAccessExpression(target) && target.name.text === "db";
}

function namesSuspended(name: ts.PropertyName | ts.Identifier) {
  return (
    (ts.isIdentifier(name) && name.text === "suspended") ||
    (ts.isStringLiteral(name) && name.text === "suspended")
  );
}

/**
 * Does this write touch `suspended` as a DIRECT property, and can we prove the
 * value is `true`?
 *
 * Direct matters in both directions: `{ transitionLog: { suspended: false } }`
 * writes a log entry rather than reactivating, and the old text scan could not
 * tell those apart either way.
 *
 * FAILS CLOSED. Only a literal `true` counts as suspension. `false`,
 * `undefined`, a shorthand and any expression are all treated as potentially
 * clearing the field, because the alternative — assuming an unrecognised value
 * is harmless — is what let `suspended: undefined` through.
 */
function clearsSuspension(call: ts.CallExpression) {
  const payload = call.arguments[1];
  if (!payload || !ts.isObjectLiteralExpression(payload)) return false;

  return payload.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return namesSuspended(property.name);
    if (!ts.isPropertyAssignment(property)) return false;
    if (!namesSuspended(property.name)) return false;
    return property.initializer.kind !== ts.SyntaxKind.TrueKeyword;
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

/** Names of every enclosing function, so a nested helper cannot masquerade as the writer. */
function enclosingFunctionNames(node: ts.Node): string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (isFunctionLike(current)) {
      const name = (current as ts.FunctionDeclaration).name;
      names.push(name && ts.isIdentifier(name) ? name.text : "<anonymous>");
    }
    current = current.parent;
  }
  return names;
}

export type SuspensionClearingWrite = { line: number; insideAuthorizedWriter: boolean };

/**
 * Every write that could return an organization to service, and whether it sits
 * inside the single function authorized to do so.
 */
export function findSuspensionClearingWrites(
  source: string,
  fileName = "fixture.ts"
): SuspensionClearingWrite[] {
  const sourceFile = parse(source, fileName);
  const writes: SuspensionClearingWrite[] = [];

  const visit = (node: ts.Node) => {
    if (isDbWrite(node) && clearsSuspension(node)) {
      writes.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        insideAuthorizedWriter: enclosingFunctionNames(node).includes(AUTHORIZED_WRITER),
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return writes;
}

/**
 * Inside the authorized writer, is the guard called BEFORE the write?
 *
 * This is the one place the ordering question survives, and it is answerable
 * here precisely because the function is four lines long and straight-line —
 * the reason for fusing them. Returns null when the writer is absent.
 */
export function guardPrecedesWriteInAuthorizedWriter(source: string, fileName = "fixture.ts") {
  const sourceFile = parse(source, fileName);
  let writer: FunctionLike | undefined;

  const findWriter = (node: ts.Node) => {
    if (writer) return;
    if (
      isFunctionLike(node) &&
      (node as ts.FunctionDeclaration).name &&
      ts.isIdentifier((node as ts.FunctionDeclaration).name!) &&
      ((node as ts.FunctionDeclaration).name as ts.Identifier).text === AUTHORIZED_WRITER
    ) {
      writer = node;
      return;
    }
    ts.forEachChild(node, findWriter);
  };
  ts.forEachChild(sourceFile, findWriter);
  if (!writer) return null;

  let guardAt = -1;
  let writeAt = -1;
  const visit = (node: ts.Node) => {
    if (
      guardAt === -1 &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === GUARD_NAME
    ) {
      guardAt = node.getStart(sourceFile);
    }
    if (writeAt === -1 && isDbWrite(node) && clearsSuspension(node)) {
      writeAt = node.getStart(sourceFile);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(writer, visit);

  return guardAt !== -1 && writeAt !== -1 && guardAt < writeAt;
}

describe("SCRUM-297 organization reactivation guard", () => {
  test("the scan actually reaches the source tree", () => {
    // A ratchet that enumerates nothing passes vacuously. Pin that it doesn't.
    const files = convexSourceFiles(CONVEX_DIR);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((file) => file.endsWith("adminOrgs.ts"))).toBe(true);
  });

  test("nothing outside reactivateOrganization clears an organization's suspension", () => {
    const offenders: string[] = [];

    for (const file of convexSourceFiles(CONVEX_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      for (const write of findSuspensionClearingWrites(source, file)) {
        if (write.insideAuthorizedWriter) continue;
        offenders.push(`${path.relative(CONVEX_DIR, file).replace(/\\/g, "/")}:${write.line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the authorized writer exists, is unique, and consults the guard first", () => {
    const files = convexSourceFiles(CONVEX_DIR).filter(
      (file) => findSuspensionClearingWrites(fs.readFileSync(file, "utf8"), file).length > 0
    );

    // Pins the blast radius: reactivation lives in one file, in one function.
    expect(files.map((file) => path.relative(CONVEX_DIR, file).replace(/\\/g, "/"))).toEqual([
      "adminOrgs.ts",
    ]);

    const source = fs.readFileSync(path.join(CONVEX_DIR, "adminOrgs.ts"), "utf8");
    expect(findSuspensionClearingWrites(source, "adminOrgs.ts")).toHaveLength(1);
    expect(guardPrecedesWriteInAuthorizedWriter(source, "adminOrgs.ts")).toBe(true);
  });

  /**
   * Meta-tests for the detector itself.
   *
   * Every case below is a real evasion that some previous version of this file
   * failed to catch — found by an adversarial reviewer, by a cross-family
   * reviewer, and by CodeRabbit, on three separate commits. None involves
   * obfuscation; they are shapes ordinary code takes.
   */
  describe("the detector itself", () => {
    const unauthorized = (body: string) => `async function somewhereElse() {\n${body}\n}`;

    test("suspended: false outside the authorized writer is an offender", () => {
      const source = unauthorized("  await ctx.db.patch(a, { suspended: false });");
      expect(findSuspensionClearingWrites(source)).toEqual([{ line: 2, insideAuthorizedWriter: false }]);
    });

    test("suspended: undefined is caught — the field is read for TRUTHINESS", () => {
      const source = unauthorized("  await ctx.db.patch(a, { suspended: undefined });");
      expect(findSuspensionClearingWrites(source)).toEqual([{ line: 2, insideAuthorizedWriter: false }]);
    });

    test("a shorthand { suspended } is caught", () => {
      const source = unauthorized("  const suspended = false;\n  await ctx.db.patch(a, { suspended });");
      expect(findSuspensionClearingWrites(source)).toEqual([{ line: 3, insideAuthorizedWriter: false }]);
    });

    test("a variable value is caught, because it cannot be proven to be true", () => {
      const source = unauthorized("  await ctx.db.patch(a, { suspended: nextValue });");
      expect(findSuspensionClearingWrites(source)).toEqual([{ line: 2, insideAuthorizedWriter: false }]);
    });

    test("suspending is allowed anywhere — only clearing is restricted", () => {
      const source = unauthorized("  await ctx.db.patch(a, { suspended: true, suspendedAt: now });");
      expect(findSuspensionClearingWrites(source)).toEqual([]);
    });

    test("a nested after:{ in the same patch literal cannot hide the write", () => {
      const source = unauthorized(
        '  await ctx.db.patch(a, {\n    transitionLog: { after: { status: "x" } },\n    suspended: false,\n  });'
      );
      expect(findSuspensionClearingWrites(source)).toHaveLength(1);
    });

    test("a prose mention of the guard's name does not authorize anything", () => {
      const source = `// see ${GUARD_NAME}( in unsuspendOrg\n` + unauthorized("  await ctx.db.patch(a, { suspended: false });");
      expect(findSuspensionClearingWrites(source)[0].insideAuthorizedWriter).toBe(false);
    });

    test("a guard call in the same function no longer authorizes the write", () => {
      // The old question. A function may call the guard and still be the wrong
      // place to clear suspension — that is the whole point of centralizing.
      const source = unauthorized(
        `  await ${GUARD_NAME}(ctx, org);\n  await ctx.db.patch(a, { suspended: false });`
      );
      expect(findSuspensionClearingWrites(source)[0].insideAuthorizedWriter).toBe(false);
    });

    test("the audit payload that only REPORTS the change is not a write", () => {
      const source = unauthorized("  await logAdminAction(ctx, admin, { after: { suspended: false } });");
      expect(findSuspensionClearingWrites(source)).toEqual([]);
    });

    test("a nested suspended:false that is not a direct patch property is not a write", () => {
      const source = unauthorized("  await ctx.db.patch(a, { snapshot: { suspended: false } });");
      expect(findSuspensionClearingWrites(source)).toEqual([]);
    });

    test("a guard placed AFTER the write inside the authorized writer fails the ordering check", () => {
      const source = [
        `async function ${AUTHORIZED_WRITER}(ctx, org) {`,
        "  await ctx.db.patch(org._id, { suspended: false });",
        `  await ${GUARD_NAME}(ctx, org);`,
        "}",
      ].join("\n");

      expect(guardPrecedesWriteInAuthorizedWriter(source)).toBe(false);
    });

    test("the ordering check reports null rather than passing when the writer is absent", () => {
      expect(guardPrecedesWriteInAuthorizedWriter("const x = 1;")).toBeNull();
    });
  });
});
