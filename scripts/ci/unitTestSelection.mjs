/**
 * SCRUM-1025: decides what the unit workflow runs for a pull request. Two
 * answers only.
 *
 *   docs-only  every changed file is documentation no test reads. Nothing to
 *              test; the coverage report is re-used from the base commit.
 *   full       everything. This is the answer to ANY doubt: a non-PR event, a
 *              path the allow-list does not name, a file status other than
 *              added/modified/deleted, an unreadable or empty change list, no
 *              reusable base coverage.
 */

/** @typedef {{ status?: string, path: string }} ChangedFile  git name-status letter and path */
/** @typedef {{ mode: "full" | "docs-only", reason: string, baseRunId?: string | null, baseSha?: string }} Decision */

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

/**
 * @param {string} reason
 * @returns {Decision}
 */
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
  const outside = entries.find((e) => !isDocsOnlyPath(e.path));
  return full(`${outside?.path} is not documentation the tests are known not to read`);
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
