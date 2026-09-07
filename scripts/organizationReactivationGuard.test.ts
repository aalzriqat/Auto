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
 * TWO KNOWN GAPS, both named because the previous version of this paragraph
 * said "the one known gap" and that was already untrue when it was written:
 *
 *  1. A COMPUTED key — `{ [name]: false }` — is not resolved. That needs a type
 *     checker evaluating the variable, not a parser.
 *  2. A payload that never mentions `suspended` at all but carries a spread —
 *     `{ ...patch }` — could contain it. This is not flagged because it is
 *     indistinguishable from the generic patch shape used throughout `convex/`,
 *     and flagging it would fail on hundreds of unrelated writes.
 *
 * Both gaps share one root: this reads syntax, so a payload it cannot see reads
 * as a payload that is safe. That FAIL-OPEN polarity is closed separately, and
 * only where it matters — `findUninspectableOrgWrites` requires every patch in
 * the files that write organization rows to be an inline literal, so an
 * unreadable payload there is an offence rather than a silence. Outside those
 * files the gaps above remain, and closing them properly needs a type checker
 * resolving values and table identity, not a parser.
 *
 * A spread that shadows a CLAIMED exemption is closed rather than documented:
 * `{ suspended: true, ...o }` is treated as clearing, because a later spread
 * can override the literal. `{ ...o, suspended: true }` cannot be overridden
 * and stays exempt.
 *
 * A deliberately obfuscated writer still gets past. This is a detective control
 * against the accidental omission that has now happened twice here, not a proof
 * of absence.
 */
import { beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CONVEX_DIR = path.join(__dirname, "..", "convex");
const GUARD_NAME = "assertNoIrreversiblePurgeHistory";
const AUTHORIZED_WRITER = "reactivateOrganization";

/**
 * The files that write `organizations` rows. Inside these, a patch payload must
 * be an inline object literal so this detector can actually read it — see
 * `findUninspectableOrgWrites`.
 */
const ORG_LIFECYCLE_FILES = ["adminOrgs.ts", "organizations.ts"];

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
  // setParentNodes is deliberately FALSE. Building parent pointers for every
  // node is the expensive half of parsing, and the only thing that needed them
  // was "which function encloses this write" — now tracked with a stack during
  // the walk instead. This is what makes parsing all 218 files affordable.
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ false);
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

  let suspendedTrueAt = -1;

  for (const [index, property] of payload.properties.entries()) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (namesSuspended(property.name)) return true;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) continue;
    if (!namesSuspended(property.name)) continue;
    if (property.initializer.kind !== ts.SyntaxKind.TrueKeyword) return true;
    suspendedTrueAt = index;
  }

  // A spread AFTER `suspended: true` overrides it — `{ suspended: true, ...o }`
  // is `false` whenever `o.suspended` is. The exemption is only sound while
  // nothing can shadow it, so claiming it next to a later spread forfeits it.
  // A spread BEFORE it cannot win, so `{ ...defaults, suspended: true }` stays
  // exempt and legitimate code is not punished for ordering it that way.
  if (suspendedTrueAt !== -1) {
    return payload.properties
      .slice(suspendedTrueAt + 1)
      .some((property) => ts.isSpreadAssignment(property));
  }

  return false;
}

/**
 * Writes whose payload this detector CANNOT read, in the files that own
 * organization rows.
 *
 * `clearsSuspension` needs to see an inline object literal. Handed anything
 * else — `ctx.db.patch(orgId, patch)` with the payload built above, a spread of
 * a variable, a function call — it answers "no", which is the FAIL-OPEN
 * direction: an unreadable payload and a genuinely safe one produce the same
 * silence.
 *
 * That is the polarity error, not another shape to match. Rather than chase a
 * fifth syntactic form, this makes unreadability itself visible: inside the two
 * files that write organization rows, a patch payload must be inspectable. All
 * 13 such calls in those files are inline literals today, so the rule costs
 * nothing now and fails loudly the first time someone hides a payload behind a
 * variable there.
 *
 * Elsewhere in `convex/` the rule is NOT applied — `ctx.db.patch(id, updates)`
 * is the ordinary write shape across the codebase and flagging it would fail
 * hundreds of unrelated writes. A new file that starts writing organization
 * rows must be added to `ORG_LIFECYCLE_FILES`.
 *
 * ⚠️ AND THE BLAST-RADIUS ASSERTION DOES NOT RELIABLY SURFACE THAT — an earlier
 * version of this comment claimed it did. That assertion filters over files
 * where `findSuspensionClearingWrites` already found something, so a new file
 * writing organizations through an INDIRECT payload returns `[]`, never enters
 * the candidate list, and is invisible to the very check cited as the safety
 * net. It surfaces a new file only when that file clears suspension through an
 * inline literal. Adding a third writer file remains a human decision this
 * suite cannot force; discovering such files structurally (by their references
 * to `Id<"organizations">`) is recorded follow-up work.
 */
export function findUninspectableOrgWrites(source: string, fileName = "fixture.ts") {
  return findUninspectableOrgWritesIn(parse(source, fileName));
}

function findUninspectableOrgWritesIn(sourceFile: ts.SourceFile) {
  const lines: number[] = [];

  const visit = (node: ts.Node) => {
    if (isDbWrite(node)) {
      const payload = node.arguments[1];
      if (!payload || !ts.isObjectLiteralExpression(payload)) {
        lines.push(sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return lines;
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

export type SuspensionClearingWrite = { line: number; insideAuthorizedWriter: boolean };

/**
 * Every write that could return an organization to service, and whether it sits
 * inside the single function authorized to do so.
 */
export function findSuspensionClearingWrites(
  source: string,
  fileName = "fixture.ts"
): SuspensionClearingWrite[] {
  return findSuspensionClearingWritesIn(parse(source, fileName));
}

function findSuspensionClearingWritesIn(sourceFile: ts.SourceFile): SuspensionClearingWrite[] {
  const writes: SuspensionClearingWrite[] = [];
  // The names of the functions currently open around the node being visited.
  // A write at module scope sees an empty stack and is never authorized.
  const enclosing: string[] = [];

  const visit = (node: ts.Node) => {
    const opensFunction = isFunctionLike(node);
    if (opensFunction) {
      const name = (node as ts.FunctionDeclaration).name;
      enclosing.push(name && ts.isIdentifier(name) ? name.text : "<anonymous>");
    }

    if (isDbWrite(node) && clearsSuspension(node)) {
      writes.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        insideAuthorizedWriter: enclosing.includes(AUTHORIZED_WRITER),
      });
    }

    ts.forEachChild(node, visit);
    if (opensFunction) enclosing.pop();
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

/**
 * Read the tree once, not once per assertion.
 *
 * The first version of this parsed all 218 non-test files under `convex/` in
 * each of three tests — 654 parses — and timed out at vitest's 5s default on a
 * CI runner, taking the Sonar coverage job down with it. The tree is immutable
 * for the length of a run, so it is read once and cached.
 */
let cachedTree: { file: string; name: string; sourceFile: ts.SourceFile }[] | undefined;

/**
 * Parse the tree once, not once per assertion.
 *
 * The first version parsed all 218 non-test files under `convex/` in each of
 * three tests — 654 parses — and timed out at vitest's 5s default on a CI
 * runner, taking the Sonar coverage job down with it.
 *
 * ⚠️ THE OBVIOUS FIX WAS WRONG AND SHIPPED BRIEFLY. It gated parsing on
 * `source.includes("suspended")`, arguing that every writer form this detector
 * catches contains that substring. That claim is FALSE: `suspended` is a
 * valid TypeScript identifier that the parser resolves to `suspended` while the
 * raw text contains no such substring, so the filter skipped a write the parser
 * caught. Reproduced before removal — raw `.includes("suspended")` false, real
 * detector flagged it. That was a text-matching gate in front of a parser,
 * reintroducing the exact failure class this file was rewritten to escape,
 * inside the commit that claimed to be a pure speed fix.
 *
 * Caching the PARSED trees is what makes it fast without narrowing it: 218
 * parses once instead of 654, and the walks are cheap. No file is skipped.
 */
function buildTree() {
  return convexSourceFiles(CONVEX_DIR).map((file) => ({
    file,
    name: path.basename(file),
    sourceFile: parse(fs.readFileSync(file, "utf8"), file),
  }));
}

function convexTree() {
  if (!cachedTree) cachedTree = buildTree();
  return cachedTree;
}

describe("SCRUM-297 organization reactivation guard", () => {
  test("the scan actually reaches the source tree", () => {
    // A ratchet that enumerates nothing passes vacuously. Pin that it doesn't.
    const files = convexTree();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((entry) => entry.name === "adminOrgs.ts")).toBe(true);
    // Every file is parsed; nothing is filtered out before inspection.
    expect(files.every((entry) => entry.sourceFile !== undefined)).toBe(true);
  });

  test("inspecting the whole tree stays well inside the test timeout", () => {
    // ⚠️ THIS IS THE CONTROL FOR A REAL REGRESSION, not a micro-benchmark.
    //
    // The version that timed out in CI cost 654 parses. The fix for THAT
    // introduced a text pre-filter which silently skipped files, because the
    // pressure was speed and the cheapest relief was to inspect less. Caching
    // the parsed trees removes the pressure instead.
    //
    // No test can stop someone re-adding a filter to the loops below. This can
    // remove the reason to: if the whole tree is inspected in a fraction of the
    // budget, narrowing it buys nothing. If this ever fails, cache harder —
    // do not inspect fewer files.
    // ⚠️ MEASURES A COLD BUILD ON PURPOSE. The previous version called the
    // MEMOIZED tree and happened to run second, so it timed a warm cache and
    // reported 541ms while the test above it was timing out at 5088ms paying
    // the real cost. A budget test that runs after the budget is spent
    // measures nothing — it passed while the thing it guards failed.
    const started = Date.now();
    const fresh = buildTree();
    for (const entry of fresh) findSuspensionClearingWritesIn(entry.sourceFile);
    const elapsed = Date.now() - started;

    expect(fresh.length).toBe(convexSourceFiles(CONVEX_DIR).length);
    // Generous against a slow shared runner; the point is to catch a return to
    // the 5s cliff, not to police milliseconds.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);

  test("nothing outside reactivateOrganization clears an organization's suspension", () => {
    const offenders: string[] = [];

    for (const entry of convexTree()) {
      for (const write of findSuspensionClearingWritesIn(entry.sourceFile)) {
        if (write.insideAuthorizedWriter) continue;
        offenders.push(`${path.relative(CONVEX_DIR, entry.file).replace(/\\/g, "/")}:${write.line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("every organization write is inspectable, so the detector cannot fail open", () => {
    const offenders: string[] = [];

    for (const entry of convexTree()) {
      if (!ORG_LIFECYCLE_FILES.includes(entry.name)) continue;
      for (const line of findUninspectableOrgWritesIn(entry.sourceFile)) {
        offenders.push(`${entry.name}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the authorized writer exists, is unique, and consults the guard first", () => {
    const files = convexTree().filter(
      (entry) => findSuspensionClearingWritesIn(entry.sourceFile).length > 0
    );

    // Pins the blast radius: reactivation lives in one file, in one function.
    expect(files.map((entry) => path.relative(CONVEX_DIR, entry.file).replace(/\\/g, "/"))).toEqual([
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

    test("a spread AFTER suspended:true forfeits the exemption — it can shadow the literal", () => {
      const source = unauthorized("  await ctx.db.patch(a, { suspended: true, ...override });");
      expect(findSuspensionClearingWrites(source)).toEqual([{ line: 2, insideAuthorizedWriter: false }]);
    });

    test("a spread BEFORE suspended:true cannot shadow it and stays exempt", () => {
      const source = unauthorized("  await ctx.db.patch(a, { ...defaults, suspended: true });");
      expect(findSuspensionClearingWrites(source)).toEqual([]);
    });

    test("a payload hidden behind a variable is unreadable, and that is now visible", () => {
      const source = unauthorized(
        [
          "  const patch = { suspended: false };",
          "  await ctx.db.patch(orgId, patch);",
        ].join("\n")
      );

      // The suspension check cannot see it — that is the fail-open this closes.
      expect(findSuspensionClearingWrites(source)).toEqual([]);
      // In an org-lifecycle file, unreadability is itself the offence.
      expect(findUninspectableOrgWrites(source)).toEqual([3]);
    });

    test("an inline literal payload is inspectable and raises nothing", () => {
      const source = unauthorized("  await ctx.db.patch(orgId, { name: \"x\" });");
      expect(findUninspectableOrgWrites(source)).toEqual([]);
    });

    test("DOCUMENTED GAP: a bare spread naming no suspended key is not flagged", () => {
      // Accepted on purpose. `{ ...patch }` is the generic write shape used
      // across convex/, so flagging it would fail hundreds of unrelated writes.
      // Pinned here so the limitation is discoverable from the suite rather
      // than only from prose, which has already drifted once in this file.
      const source = unauthorized("  await ctx.db.patch(a, { ...override });");
      expect(findSuspensionClearingWrites(source)).toEqual([]);
    });

    test("an escape-obfuscated identifier is still caught — the parser resolves it", () => {
      // `\\u0073uspended` is a valid TypeScript identifier resolving to
      // `suspended`. A version of this file gated parsing on the raw text
      // containing "suspended" and skipped exactly this write while claiming to
      // remove no coverage. Nothing is text-gated now; this pins that.
      const source = unauthorized(
        "  await ctx.db.patch(orgId, { \\\\u0073uspended: false });"
      );

      expect(source.includes("suspended")).toBe(false);
      expect(findSuspensionClearingWrites(source)).toEqual([{ line: 2, insideAuthorizedWriter: false }]);
    });

    test("DOCUMENTED GAP: a computed key is not resolved", () => {
      // Needs a type checker evaluating `field`, not a parser.
      const source = unauthorized("  await ctx.db.patch(a, { [field]: false });");
      expect(findSuspensionClearingWrites(source)).toEqual([]);
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
