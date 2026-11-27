/**
 * SCRUM-1025: decides what the unit workflow runs for a pull request.
 *
 *   docs-only  every changed file is documentation no test reads. Nothing to
 *              test; the coverage report is re-used from the base commit.
 *   impacted   the tests Vitest's own `related` mechanism ties to the change,
 *              plus the always-run set (every backend test and every gate
 *              test, as classified by scripts/skillEnforcement/policy.mjs) and
 *              the tests behind the coverage-threshold files.
 *   full       everything. This is the answer to ANY doubt: a non-PR event,
 *              an unknown or shared-infrastructure path, a deleted source file,
 *              an unreadable change list, a selection error, an empty answer.
 *
 * Vitest documents `related` as following static imports only: a dynamic
 * `import(path)` is not seen. The fallbacks below are how each blind spot
 * degrades to full (see the table in the design note):
 *   dynamic import / import.meta.glob   convex-test loads `convex/**` through
 *                                       import.meta.glob, so every backend
 *                                       test is always-run, and convex/schema*,
 *                                       convex/_generated and test-utils are full.
 *   non-import dependencies             fs reads of docs, JSON, configs and
 *                                       scripts: only allow-listed paths that
 *                                       no test names may skip tests; every
 *                                       other non-source path is full.
 */
import { classifyPaths } from "../skillEnforcement/policy.mjs";

/** @typedef {{ status?: string, path: string }} ChangedFile  git name-status letter and path */
/** @typedef {{ mode: "full" | "docs-only" | "impacted", reason: string, files?: string[], baseRunId?: string | null, baseSha?: string }} Decision */

/**
 * Documentation no test reads (pinned by scripts/ci/unitTestSelection.test.ts).
 * A path under one of these is docs-only only if it ALSO has a documentation
 * extension: `docs/testing/x.test.ts` is a test and `docs/agents/helper.ts` is
 * source, wherever they sit. preflight.mjs `isDocsPath` was considered and not
 * reused: it admits any Markdown file anywhere and denies only JS/TS/JSON under
 * docs/, so `docs/x.py` or `docs/x.sh` would pass; this gate allow-lists instead.
 */
export const DOCS_ONLY_PREFIXES = ["docs/audit-tasks/", "docs/agents/", "docs/testing/"];
const DOC_EXTENSION = /\.(?:md|mdx|txt|png|jpe?g|gif|svg|webp|pdf)$/i;
const DOCS_ONLY_PATTERNS = [
  /^docs\/[^/]+\.md$/, // top-level planning documents
  /^(?:00|01)-[^/]+\.md$/,
  /^phase-\d\d-[^/]+\.md$/,
  /^Prompt\.md$/,
];

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isDocsOnlyPath(p) {
  return DOC_EXTENSION.test(p) && (DOCS_ONLY_PREFIXES.some((x) => p.startsWith(x)) || DOCS_ONLY_PATTERNS.some((r) => r.test(p)));
}

// Source trees whose changes Vitest's import graph can follow. Default deny:
// a path outside this list (and outside the docs allow-list) runs everything.
const IMPACT_ELIGIBLE = /^(?:app|components|lib|hooks|convex)\//;
const NEVER_IMPACTED = [
  /^convex\/schema[/.]/,
  /^convex\/_generated\//,
  /^convex\/tsconfig/,
  /^convex\/.*\.json$/,
  /^convex\/.*\.md$/,
];
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.(?:ts|tsx)$/;

/** @param {string} p */
function isEligible(p) {
  return IMPACT_ELIGIBLE.test(p) && !NEVER_IMPACTED.some((r) => r.test(p)) && SOURCE_EXTENSION.test(p);
}

/**
 * @param {string} reason
 * @returns {Decision}
 */
/** Locale-independent UTF-16 code-unit order, so the selection is identical on every runner. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const full = (reason) => ({ mode: "full", reason });

/**
 * @param {{ event: string | undefined, changed: ChangedFile[] | null | undefined, baseCoverageAvailable: boolean }} input
 * @returns {Decision}
 */
export function classifyChange({ event, changed, baseCoverageAvailable }) {
  if (event !== "pull_request") return full(`event '${String(event)}' always runs the full suite`);
  if (!Array.isArray(changed) || changed.length === 0) return full("changed-file list unavailable or empty");
  const entries = changed.map((c) => ({ status: String(c?.status ?? ""), path: String(c?.path ?? "") }));
  if (entries.some((e) => !e.path || !e.status)) return full("changed-file list malformed");
  const odd = entries.find((e) => !/^[AMD]$/.test(e.status));
  if (odd) return full(`${odd.path} has status ${odd.status} (only added, modified and deleted files are understood)`);

  if (entries.every((e) => isDocsOnlyPath(e.path))) {
    return baseCoverageAvailable
      ? { mode: "docs-only", reason: "only documentation no test reads changed" }
      : full("docs-only change but no reusable base coverage report");
  }
  const rest = entries.filter((e) => !isDocsOnlyPath(e.path));
  const blocker = rest.find((e) => !isEligible(e.path));
  if (blocker) return full(`${blocker.path} is shared infrastructure or outside the import-traceable source trees`);
  const lostSource = rest.find((e) => e.status === "D" && !TEST_FILE.test(e.path));
  if (lostSource) return full(`${lostSource.path} was deleted; the import graph cannot see what imported it`);
  return { mode: "impacted", reason: "source-only change inside import-traceable trees" };
}

/**
 * @param {string} text
 * @returns {{ status: string, path: string }[]}
 */
export function parseNameStatus(text) {
  /** @type {{ status: string, path: string }[]} */
  const out = [];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const match = /^([A-Z])\t(.+)$/.exec(line);
    if (!match) throw new Error(`unparseable name-status line: ${JSON.stringify(line.slice(0, 80))}`);
    out.push({ status: match[1], path: match[2] });
  }
  return out;
}

/** The files coverage.thresholds apply to, read from the repository config. */
/**
 * @param {string} configText
 * @returns {string[]}
 */
export function parseTrackedCoverageFiles(configText) {
  const block = /coverage:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/.exec(configText);
  const files = block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (files.length === 0) throw new Error("coverage.include not found in vitest.config.ts");
  return files;
}

/**
 * `listRelated(paths)` (sync or async) returns the test files Vitest ties to `paths`.
 * Any exception, an empty answer for a code change, or a test that is not in
 * the census degrades to the full suite.
 */
/**
 * @param {{ census: string[], changed: ChangedFile[], trackedCoverageFiles: string[], textReading?: string[], listRelated: (paths: string[]) => string[] | Promise<string[]> }} input
 * @returns {Promise<Decision>}
 */
export async function buildSelection({ census, changed, trackedCoverageFiles, textReading = [], listRelated }) {
  const known = new Set(census);
  const alwaysRun = census.filter((file) => {
    const c = classifyPaths([file]);
    return c.sensitive.length > 0 || c.gate.length > 0;
  });
  const live = changed.filter((c) => c.status !== "D").map((c) => c.path);
  const changedTests = live.filter((p) => TEST_FILE.test(p) && known.has(p));
  const changedSource = live.filter((p) => SOURCE_EXTENSION.test(p) && !TEST_FILE.test(p));
  let related;
  try {
    related = await listRelated([...new Set([...changedSource, ...trackedCoverageFiles])]);
    if (!Array.isArray(related)) throw new Error("related list is not an array");
  } catch (error) {
    return full(`selection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Canary: the threshold files are always in the query and their tests are
  // import-graph tests, so a working probe never answers with nothing. An empty
  // answer means the probe itself is broken, and then everything runs.
  if (related.length === 0) return full("the import-graph probe returned nothing, not even for the threshold files");
  const stranger = related.find((file) => !known.has(file));
  if (stranger) return full(`selection named ${stranger}, which is not in the test census`);
  const files = [...new Set([...alwaysRun, ...textReading, ...changedTests, ...related])].toSorted(byCodeUnit);
  return {
    mode: "impacted",
    reason: `${files.length} of ${census.length} test files`,
    files,
  };
}
