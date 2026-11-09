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

const MARKER_PREFILTER = "guardrail-4-fixture";
const MARKER_COMMENT = /^\/\/\s*guardrail-4-fixture(?![\w-])(.*)$/u;

/**
 * Every `// guardrail-4-fixture: <reason>` line comment in a parsed file. Found
 * through the token trivia, so the text inside a string or template is not a marker.
 * @returns {{ line: number, reason: string }[]}
 */
function findMarkers(sourceFile, text) {
  const seen = new Set();
  const markers = [];
  const take = (ranges) => {
    for (const range of ranges ?? []) {
      if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia || seen.has(range.pos)) continue;
      seen.add(range.pos);
      const match = MARKER_COMMENT.exec(text.slice(range.pos, range.end).trimEnd());
      if (!match) continue;
      const afterColon = match[1].trim().startsWith(":") ? match[1].trim().slice(1).trim() : "";
      markers.push({ line: sourceFile.getLineAndCharacterOfPosition(range.pos).line + 1, reason: afterColon });
    }
  };
  const visit = (node) => {
    take(ts.getLeadingCommentRanges(text, node.pos));
    take(ts.getTrailingCommentRanges(text, node.end));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  take(ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.pos));
  return markers.sort((a, b) => a.line - b.line);
}

/** Every literal count pin in one parsed file, exempt or not. */
function collectPins(sourceFile) {
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

/**
 * Pair each marker that has a reason with the one pin it exempts: a pin on the
 * marker's own line first, then a pin on the next line. A marker without a
 * reason exempts nothing (it is reported by markerProblems).
 */
function pairMarkers(pins, markers) {
  const exempt = new Set();
  const unused = [];
  for (const marker of markers) {
    if (marker.reason === "") continue;
    const hit = [marker.line, marker.line + 1]
      .map((line) => pins.find((pin) => pin.line === line && !exempt.has(pin)))
      .find(Boolean);
    if (hit) exempt.add(hit);
    else unused.push(marker);
  }
  return { exempt, unused };
}

/**
 * Every literal count pin in one test file that no marker exempts.
 * @returns {{ line: number, matcher: string, value: number }[]}
 */
export function findCountPins(filePath, text) {
  if (!PREFILTER.test(text)) return [];
  const sourceFile = parseSource(filePath, text);
  const pins = collectPins(sourceFile);
  if (!text.includes(MARKER_PREFILTER)) return pins;
  const { exempt } = pairMarkers(pins, findMarkers(sourceFile, text));
  return pins.filter((pin) => !exempt.has(pin));
}

/**
 * Marker misuse in one file, like ESLint's required directive description and its
 * unused-directive report: a marker with no reason, and a reasoned marker that
 * exempts no flagged assertion on its line or the next.
 * @returns {{ code: "COUNT-PIN-MARKER-NO-REASON" | "COUNT-PIN-MARKER-UNUSED", line: number }[]}
 */
export function markerProblems(filePath, text) {
  if (!text.includes(MARKER_PREFILTER)) return [];
  const sourceFile = parseSource(filePath, text);
  const markers = findMarkers(sourceFile, text);
  const problems = markers
    .filter((marker) => marker.reason === "")
    .map((marker) => ({ code: "COUNT-PIN-MARKER-NO-REASON", line: marker.line }));
  const { unused } = pairMarkers(collectPins(sourceFile), markers);
  for (const marker of unused) problems.push({ code: "COUNT-PIN-MARKER-UNUSED", line: marker.line });
  return problems.sort((a, b) => a.line - b.line);
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
    if (!pins) {
      pins = findCountPins(filePath, text);
      fileCache.set(key, pins);
    }
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
          "convert the pin to set equality in both directions, or mark it `// guardrail-4-fixture: <reason>` if it is a fixture count",
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
