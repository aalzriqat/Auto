// SCRUM-426 (SCRUM-418 section 6) — repository-total ratchets.
//
// Guardrails 8, 10 and 11 count constructs in production files and fail a PR
// whose REPOSITORY TOTAL for a kind exceeds the target tree's total. Both trees
// are measured live by the same code over the same file scope, so nothing is
// stored in the PR that a PR could raise, and moving code between files changes
// no total. Guardrail 9 reports and never blocks (see ADVISORIES).
import { createHash } from "node:crypto";

import { countFunctions, extractFacts, resolvePublicFunctions } from "./convexFunctions.mjs";
import { countQueryReads, countTypeEscapes, parseSource } from "./astCounts.mjs";

/**
 * guardrail: SCRUM-418 section 6 number. prefix: the error code. convexOnly:
 * counted in convex/ files only. blocking: false = reported, never failed.
 */
export const KINDS = Object.freeze([
  { id: "any", guardrail: 8, prefix: "TYPE-ESCAPE-GROWN", blocking: true, convexOnly: false },
  { id: "as-unknown-as", guardrail: 8, prefix: "TYPE-ESCAPE-GROWN", blocking: true, convexOnly: false },
  { id: "ts-ignore", guardrail: 8, prefix: "TYPE-ESCAPE-GROWN", blocking: true, convexOnly: false },
  { id: "ts-expect-error", guardrail: 8, prefix: "TYPE-ESCAPE-GROWN", blocking: true, convexOnly: false },
  { id: "query-collect", guardrail: 10, prefix: "UNBOUNDED-READ-GROWN", blocking: true, convexOnly: true },
  { id: "query-filter", guardrail: 10, prefix: "UNBOUNDED-READ-GROWN", blocking: true, convexOnly: true },
  { id: "no-args-validator", guardrail: 11, prefix: "VALIDATOR-GAP-GROWN", blocking: true, convexOnly: true },
  { id: "no-returns-validator", guardrail: 11, prefix: "VALIDATOR-GAP-GROWN", blocking: true, convexOnly: true },
  // Advisory until the tenant builders exist: a blocking rule with no compliant
  // path would freeze every new public function.
  { id: "non-tenant-builder", guardrail: 9, prefix: "TENANT-BUILDER", blocking: false, convexOnly: true },
  // The guardrail-9 denominator, reported with it; never a failure on its own.
  { id: "public-functions", guardrail: 11, prefix: "INFO", blocking: false, convexOnly: true },
]);

const MAX_DELTA_LINES = 30;

/** The counts that depend on one file alone: type escapes, and bounded reads in convex/. */
export function analyzeFile(filePath, text) {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind.id, 0]));
  const sourceFile = parseSource(filePath, text);
  Object.assign(counts, countTypeEscapes(sourceFile));
  if (filePath.startsWith("convex/")) Object.assign(counts, countQueryReads(sourceFile));
  return counts;
}

/**
 * Per-kind counts for a set of production files, `path -> counts`; every kind is
 * present, zero when absent. Public functions are resolved across the whole set
 * (a custom builder defined in one module and used in another), so `scoped` is
 * the files to count and `context` is extra convex modules, outside the counted
 * scope, that are only consulted to resolve builders. `fileCache` keeps the
 * single-file counts of a file that two trees share.
 * @param {Map<string, string>} scoped path -> source text
 * @param {Map<string, string>} [context]
 * @param {Map<string, Record<string, number>>} [fileCache] keyed by path + text hash
 */
export function analyzeTree(scoped, context = new Map(), fileCache = new Map()) {
  const factsByPath = new Map();
  for (const [filePath, text] of [...context, ...scoped]) {
    if (filePath.startsWith("convex/")) factsByPath.set(filePath, extractFacts(filePath, text));
  }
  const functionsByPath = resolvePublicFunctions(factsByPath);
  const result = new Map();
  for (const [filePath, text] of scoped) {
    const key = `${filePath}\0${createHash("sha256").update(text).digest("hex")}`;
    let counts = fileCache.get(key);
    if (!counts) fileCache.set(key, (counts = analyzeFile(filePath, text)));
    const functions = functionsByPath.get(filePath) ?? [];
    result.set(filePath, { ...counts, ...countFunctions(functions), functions });
  }
  return result;
}

/** Per-kind counts for one file read alone (no other module is consulted for builders). */
export function analyzeSource(filePath, text) {
  return analyzeTree(new Map([[filePath, text]])).get(filePath);
}

/** Repository total per kind from a Map(path -> counts). */
export function totalsOf(perFile) {
  const totals = Object.fromEntries(KINDS.map((kind) => [kind.id, 0]));
  for (const counts of perFile.values()) for (const kind of KINDS) totals[kind.id] += counts[kind.id] ?? 0;
  return totals;
}

function deltaLines(kindId, pr, target) {
  const rows = [];
  for (const [filePath, counts] of pr) {
    const before = target.get(filePath)?.[kindId] ?? 0;
    const after = counts[kindId] ?? 0;
    if (after > before) rows.push({ filePath, before, after });
  }
  rows.sort((a, b) => b.after - b.before - (a.after - a.before) || (a.filePath < b.filePath ? -1 : 1));
  const lines = rows.slice(0, MAX_DELTA_LINES).map((r) => `  ${r.filePath}: ${r.before} -> ${r.after}`);
  if (rows.length > MAX_DELTA_LINES) lines.push(`  ... and ${rows.length - MAX_DELTA_LINES} more files`);
  return lines;
}

/** Public functions by key across a tree: key -> {hasArgs, hasReturns}. */
function functionsByKey(perFile) {
  const byKey = new Map();
  for (const counts of perFile.values()) for (const fn of counts.functions ?? []) byKey.set(fn.key, fn);
  return byKey;
}

const missing = (fn) => [fn.hasArgs ? "" : "args", fn.hasReturns ? "" : "returns"].filter(Boolean).join(", ");

/**
 * Guardrail 11 per function. The repository totals stay the limit for old debt;
 * on top of them, a public function whose key does not exist on the target must
 * declare both `args` and `returns`, and an existing function may not lose a
 * validator it had. Without this, a PR can add one unvalidated function while
 * fixing another and leave every total unchanged.
 */
function functionValidatorErrors(pr, target) {
  const before = functionsByKey(target);
  const added = [];
  const lost = [];
  for (const fn of [...functionsByKey(pr).values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const was = before.get(fn.key);
    if (!was) {
      if (!fn.hasArgs || !fn.hasReturns) added.push(`  ${fn.key}: missing ${missing(fn)}`);
    } else {
      const dropped = missing({ hasArgs: !was.hasArgs || fn.hasArgs, hasReturns: !was.hasReturns || fn.hasReturns });
      if (dropped) lost.push(`  ${fn.key}: lost ${dropped}`);
    }
  }
  const errors = [];
  const cap = (rows) => (rows.length > MAX_DELTA_LINES ? [...rows.slice(0, MAX_DELTA_LINES), `  ... and ${rows.length - MAX_DELTA_LINES} more`] : rows);
  if (added.length > 0) {
    errors.push([`VALIDATOR-GAP-NEW-FUNCTION: ${added.length} public function(s) new on the target must declare both args and returns`, ...cap(added)].join("\n"));
  }
  if (lost.length > 0) {
    errors.push([`VALIDATOR-REMOVED: ${lost.length} existing public function(s) lost a validator they had on the target`, ...cap(lost)].join("\n"));
  }
  return errors;
}

/**
 * @param {{ pr: Map<string, Record<string, number>>, target: Map<string, Record<string, number>> }} trees
 *   per-file counts of the PR tree and of the trusted target tree
 */
export function compareRatchets({ pr, target }) {
  const totals = { pr: totalsOf(pr), target: totalsOf(target) };
  const errors = [];
  const notices = [];
  const advisories = [];
  for (const kind of KINDS) {
    const now = totals.pr[kind.id];
    const was = totals.target[kind.id];
    if (!kind.blocking) {
      if (kind.guardrail === 9) {
        // `public-functions` is the denominator: every public function, actions included
        // (they are exempt, so they are in the denominator and never in the numerator).
        const publicNow = totals.pr["public-functions"];
        const publicWas = totals.target["public-functions"];
        advisories.push(
          `ADVISORY guardrail-9 ${kind.id}: ${now} of ${publicNow} public functions are queries/mutations not built with ` +
            `orgQuery/orgMutation (target ${was} of ${publicWas}); actions are exempt; not blocking: it becomes blocking ` +
            "when the tenant builders land (SCRUM-418 section 4)",
        );
      }
      continue;
    }
    if (now > was) {
      errors.push([`${kind.prefix} ${kind.id}: ${now} > target ${was} (+${now - was})`, ...deltaLines(kind.id, pr, target)].join("\n"));
    } else if (now < was) {
      notices.push(`ratchet can tighten: ${kind.id} ${was} -> ${now}`);
    }
  }
  errors.push(...functionValidatorErrors(pr, target));
  return { errors, notices, advisories, totals };
}
