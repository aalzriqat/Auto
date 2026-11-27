/** SCRUM-742 tripwire, split out of economicCommandCensus.test.ts under the file-size ratchet (SCRUM-961 follow-up). */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");
const REAL_TREE_BUDGET_MS = 120_000;

describe("SCRUM-742 tripwire — call shapes the census cannot see must not appear in convex/", () => {
  // The census builds edges with a regex over comment-stripped text. Two call
  // shapes produce NO edge (see the KNOWN GAP tests above): (a) a generic call
  // with parentheses in its type argument; (b) ANY call or `hook*` reference on a
  // top-level `function` declaration line (parameter default or one-line body).
  // They are unreachable from any money path today; this keeps that true.
  // Measured 2026-10-06 over 262 non-test sources: (a) zero; (b) zero beyond
  // `Date.now()` (which can neither reach a sink nor hide a call to one).
  // Function REFERENCES (`ctx.runMutation(internal.…)`, scheduler) are modelled
  // since SCRUM-743 (blind spot 7). Still UNGUARDED by this tripwire, SCRUM-742:
  // httpAction route handlers, namespace/default imports, star exports, local export lists, and function
  // values passed uncalled, and function references held in a variable.
  // ~80% of the 262 non-test convex sources measured 2026-10-06.
  const FILE_FLOOR = 210;
  // COUPLING: this must match the analyzer's unexported `walk` in
  // scripts/economicCommandCensus.ts (every `.ts` under convex/, skipping
  // `_generated` and `*.test.ts`). It is duplicated rather than imported because
  // exporting `walk` would be an executable change to the analyzer; the file-count
  // floor below catches a narrowed copy.
  const walkSources = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "_generated") walkSources(p, out);
      } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
    }
    return out;
  };

  test("SCRUM-742 tripwire: no uncovered census call shape exists in convex/ sources", () => {
    const offenders: string[] = [];
    const files = walkSources(CONVEX_ROOT);
    // Floor: a walker narrowed by mistake must not pass this test vacuously.
    expect(files.length, "tripwire scanned suspiciously few convex sources").toBeGreaterThanOrEqual(FILE_FLOOR);
    for (const file of files) {
      const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const at = (n: ts.Node) =>
        `${path.relative(CONVEX_ROOT, file).replace(/\\/g, "/")}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
      const startLine = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      // Top-level `function` declarations are exactly what the analyzer's DECL
      // matches as a `function` line, and the whole line is unread for edges.
      const unreadFunctionLines = sf.statements.filter(ts.isFunctionDeclaration);
      for (const decl of unreadFunctionLines) {
        const declLine = startLine(decl);
        const scanLine = (m: ts.Node): void => {
          if (startLine(m) === declLine) {
            if (ts.isCallExpression(m) && m.expression.getText(sf) !== "Date.now") {
              offenders.push(`(b) call ${m.expression.getText(sf)} on a function declaration line at ${at(m)}`);
            } else if (ts.isIdentifier(m) && m !== decl.name && /^hook[A-Z]/.test(m.text)) {
              // (the declared name itself is the symbol, not a reference to one)
              offenders.push(`(b) ${m.text} on a function declaration line at ${at(m)}`);
            }
          }
          ts.forEachChild(m, scanLine);
        };
        scanLine(decl);
      }
      const visit = (n: ts.Node): void => {
        // (a) a generic call whose type argument contains parentheses.
        if (ts.isCallExpression(n) && n.typeArguments?.some((t) => t.getText(sf).includes("("))) {
          offenders.push(`(a) generic type argument with parentheses at ${at(n)}`);
        }
        // (b') a parameter default containing a call other than `Date.now`, on any
        // function form not already covered by the top-level declaration scan.
        if (
          (ts.isFunctionDeclaration(n) && !unreadFunctionLines.includes(n)) ||
          ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)
        ) {
          for (const p of n.parameters) {
            if (!p.initializer) continue;
            const scan = (m: ts.Node): void => {
              if (ts.isCallExpression(m) && m.expression.getText(sf) !== "Date.now") {
                offenders.push(`(b') parameter default calling ${m.expression.getText(sf)} at ${at(m)}`);
              }
              ts.forEachChild(m, scan);
            };
            scan(p.initializer);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(
      offenders,
      "uncovered census call shape — see SCRUM-742; run a manual census check or land SCRUM-742",
    ).toEqual([]);
  }, REAL_TREE_BUDGET_MS);
});
