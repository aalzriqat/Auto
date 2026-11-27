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

/** @typedef {{ status?: string, path: string, oldMode?: string, newMode?: string }} ChangedFile  git raw-diff status letter, path and the two file modes */
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
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
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
  // Printable ASCII only. `git diff -z` prints a path verbatim (no quoting), so a
  // name with a control, bidi or non-ASCII character is not judged here at all:
  // it is not documentation this gate knows, and the answer is full.
  return PRINTABLE_ASCII.test(p) && DOC_EXTENSION.test(p) && (DOCS_ONLY_PREFIXES.some((x) => p.startsWith(x)) || DOCS_ONLY_PATTERNS.some((r) => r.test(p)));
}

/**
 * @param {string} reason
 * @returns {Decision}
 */
const full = (reason) => ({ mode: "full", reason });

/**
 * The only modes a documentation file may have: a regular, non-executable file
 * (100644), with 000000 on the side that does not exist (before an add, after a
 * delete). A symlink (120000), a gitlink (160000), an executable (100755), a
 * mode change and any mode git may add later are not documentation.
 * @type {Record<string, [string, string]>}
 */
const REGULAR_MODES = { A: ["000000", "100644"], M: ["100644", "100644"], D: ["100644", "000000"] };

/**
 * @param {{ event: string | undefined, changed: ChangedFile[] | null | undefined, baseCoverageAvailable: boolean }} input
 * @returns {Decision}
 */
export function classifyChange({ event, changed, baseCoverageAvailable }) {
  if (event !== "pull_request") return full(`event '${String(event)}' always runs the full suite`);
  if (!Array.isArray(changed) || changed.length === 0) return full("changed-file list unavailable or empty");
  const entries = changed.map((c) => ({
    status: String(c?.status ?? ""),
    path: String(c?.path ?? ""),
    oldMode: String(c?.oldMode ?? ""),
    newMode: String(c?.newMode ?? ""),
  }));
  if (entries.some((e) => !e.path || !e.status || !e.oldMode || !e.newMode)) return full("changed-file list malformed");
  const odd = entries.find((e) => !/^[AMD]$/.test(e.status));
  if (odd) return full(`${odd.path} has status ${odd.status} (only added, modified and deleted files are understood)`);
  const irregular = entries.find((e) => REGULAR_MODES[e.status].join() !== [e.oldMode, e.newMode].join());
  if (irregular) {
    return full(`${irregular.path} has mode ${irregular.oldMode} -> ${irregular.newMode} (only regular 100644 files are documentation)`);
  }

  if (entries.every((e) => isDocsOnlyPath(e.path))) {
    return baseCoverageAvailable
      ? { mode: "docs-only", reason: "only documentation no test reads changed" }
      : full("docs-only change but no reusable base coverage report");
  }
  const outside = entries.find((e) => !isDocsOnlyPath(e.path));
  return full(`${outside?.path} is not documentation the tests are known not to read`);
}

const RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]{40,64} [0-9a-f]{40,64} ([A-Z])$/;

/**
 * Parses `git diff --raw -z --no-renames --no-abbrev`. Per the git-diff
 * documentation (raw output format), each record is
 * `:<srcmode> <dstmode> <srcsha> <dstsha> <status>` NUL `<path>` NUL, and `-z`
 * prints the path verbatim. A truncated, mis-shaped or rename/copy record (those
 * carry two paths and a score) is an error, which the caller turns into full.
 * @param {string} text
 * @returns {{ status: string, path: string, oldMode: string, newMode: string }[]}
 */
export function parseRawDiff(text) {
  const raw = String(text);
  if (raw === "") return [];
  if (!raw.endsWith("\0")) throw new Error("unparseable raw diff: output is truncated");
  const fields = raw.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) throw new Error("unparseable raw diff: a record has no path");
  /** @type {{ status: string, path: string, oldMode: string, newMode: string }[]} */
  const out = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = RAW_RECORD.exec(fields[index]);
    if (!match || fields[index + 1] === "") throw new Error(`unparseable raw diff record: ${JSON.stringify(fields[index].slice(0, 80))}`);
    out.push({ status: match[3], path: fields[index + 1], oldMode: match[1], newMode: match[2] });
  }
  return out;
}