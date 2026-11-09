// SCRUM-426 (SCRUM-418 section 6) — guardrail 4: count pins become enumerated sets.
//
// A "count pin" is a test assertion that a collection has exactly N members for a
// literal N of COUNT_PIN_MIN or more: `expect(x.length).toBe(12)`,
// `expect(x).toHaveLength(12)`, `expect(s.size).toEqual(12)`,
// `expect(Object.keys(o).length).toBe(12)`. Every new member of a growing
// collection then forces an edit of the number, and the number is copied from
// the implementation, so it proves nothing. The fix is to compare the set with an
// independent discovery in both directions (see economicCommandCensus.test.ts).
//
// Same trust model as the repository-total ratchets (ratchets.mjs): both trees
// are measured live by the same code, nothing is stored in the PR that the PR
// could raise, and a file may only keep or lower its own count. The skip list is
// read from the TARGET config. Floors (`toBeGreaterThan`) are out of scope: they
// fail only on shrinkage and so cannot go stale as a collection grows.
import { createHash } from "node:crypto";

import ts from "typescript";

import { parseSource, skipWrappers } from "./astCounts.mjs";
import { compareCodeUnits, isTestLike } from "./rules.mjs";

export const COUNT_PIN_MIN = 10;
const MAX_DELTA_LINES = 30;
const VALUE_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);
const SIZE_PROPERTIES = new Set(["length", "size"]);
const PREFILTER = /\b(?:length|size|toHaveLength)\b/u;

/** The literal integer a node spells, or null. TypeScript's `text` is already normalised (`1_0`, `0xA`). */
function literalCount(node) {
  const inner = skipWrappers(node);
  if (!ts.isNumericLiteral(inner)) return null;
  const value = Number(inner.text);
  return Number.isInteger(value) ? value : null;
}

/** `expect(arg)` -> arg; anything else (including `expect(arg).not`) -> null. */
function expectArgument(node) {
  const inner = skipWrappers(node);
  if (!ts.isCallExpression(inner) || !ts.isIdentifier(inner.expression) || inner.expression.text !== "expect") return null;
  return inner.arguments[0] ?? null;
}

/**
 * Every literal count pin in one test file.
 * @returns {{ line: number, matcher: string, value: number }[]}
 */
export function findCountPins(filePath, text) {
  if (!PREFILTER.test(text)) return [];
  const sourceFile = parseSource(filePath, text);
  const pins = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const matcher = node.expression.name.text;
      const subject = expectArgument(node.expression.expression);
      const value = node.arguments.length === 1 ? literalCount(node.arguments[0]) : null;
      if (subject && value !== null && value >= COUNT_PIN_MIN) {
        const measured = skipWrappers(subject);
        const onSize = ts.isPropertyAccessExpression(measured) && SIZE_PROPERTIES.has(measured.name.text);
        if (matcher === "toHaveLength" || (VALUE_MATCHERS.has(matcher) && onSize)) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          pins.push({ line: line + 1, matcher, value });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return pins;
}

/** Test files the guardrail judges: any tree location, source extensions from the config. */
export function inCountPinScope(repoPath, extensions) {
  return isTestLike(repoPath) && extensions.some((ext) => repoPath.endsWith(ext));
}

/**
 * Pins per test file for one tree, `path -> pins[]`. `fileCache` (path + text
 * hash -> pins) means a file the two trees share is parsed once.
 * @param {Map<string, string>} files path -> source text
 */
export function analyzePins(files, fileCache = new Map()) {
  const result = new Map();
  for (const [filePath, text] of files) {
    const key = `${filePath}\0${createHash("sha256").update(text).digest("hex")}`;
    let pins = fileCache.get(key);
    if (!pins) fileCache.set(key, (pins = findCountPins(filePath, text)));
    if (pins.length > 0) result.set(filePath, pins);
  }
  return result;
}

/**
 * @param {{ pr: Map<string, object[]>, target: Map<string, object[]>, skips: Iterable<string> }} trees
 *   pins per file of the PR tree and the trusted target tree; `skips` are the
 *   skip-listed paths of the TARGET config. `renames` maps a renamed file's new path to
 *   its old path, whose target count it is compared with.
 */
export function compareCountPins({ pr, target, skips, renames = new Map() }) {
  const skipped = new Set(skips);
  const renamedTo = new Map([...renames].map(([to, from]) => [from, to]));
  const errors = [];
  const notices = [];
  const grown = [];
  for (const filePath of [...pr.keys()].sort(compareCodeUnits)) {
    if (skipped.has(filePath)) continue;
    const pins = pr.get(filePath);
    const was = target.get(renames.get(filePath) ?? filePath)?.length ?? 0;
    if (pins.length > was) grown.push({ filePath, pins, was });
  }
  for (const { filePath, pins, was } of grown) {
    const rows = pins.slice(0, MAX_DELTA_LINES).map((p) => `  line ${p.line}: ${p.matcher}(${p.value})`);
    errors.push(
      [
        `COUNT-PIN-GROWN ${filePath}: ${pins.length} > target ${was} (+${pins.length - was}); ` +
          "compare the set with an independent discovery in both directions instead of pinning its size",
        ...rows,
      ].join("\n"),
    );
  }
  for (const [filePath, was] of [...target].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const current = renamedTo.get(filePath) ?? filePath;
    if (skipped.has(filePath) || skipped.has(current)) continue;
    const now = pr.get(current)?.length ?? 0;
    if (now < was.length) notices.push(`count pins can tighten: ${current} ${was.length} -> ${now}`);
  }
  const total = (trees) => [...trees].reduce((sum, [p, pins]) => sum + (skipped.has(p) ? 0 : pins.length), 0);
  return { errors, notices, totals: { pr: total(pr), target: total(target) } };
}
