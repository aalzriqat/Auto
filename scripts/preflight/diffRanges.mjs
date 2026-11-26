/**
 * The new-side line ranges of each file in a `git diff -U0` text, used to keep sonar-lint to the lines a change added or modified
 * (Sonar's gate judges new code only). Format: https://git-scm.com/docs/diff-format. A file that is not in the result (new and
 * untracked) is judged on every line.
 *
 * The invariant: the parser never guesses. Input it does not fully understand for a file (a context line, a hunk that ends before or
 * after its counts, a combined-diff `@@@` header, a `+++` with no `---` before it, a second header block for a path, an unreadable
 * path) removes that file's entry, so every line of the file is judged, and nothing after it can create or change an entry until the
 * next `diff --git` line. An empty range list therefore means one thing: git reported the file with zero new lines.
 *
 * What is understood: `diff --git` starts a file, `+++` is that file's header only on the line right after its `---`, and after an
 * `@@ -a,b +c,d @@` header exactly b removed and d added lines (plus `\ No newline` markers) are hunk body, whatever they say. Source text
 * such as `++ b/x`, which a diff renders as `+++ b/x`, is therefore body text and never a header.
 */

/** @typedef {Array<[number, number]>} LineRanges */
/** @typedef {{ ranges: Map<string, LineRanges>, seen: Set<string>, path: string | undefined, afterOld: boolean, poisoned: boolean, oldLeft: number, newLeft: number }} State */

/**
 * The git call that produces the text: config and options pinned so nothing a user or environment sets changes what is printed. No
 * quoting of non-ASCII paths, the standard a/ b/ prefixes, no external diff driver or textconv, and no inter-hunk context (with -U0,
 * diff.interHunkContext and GIT_DIFF_OPTS can otherwise add context lines). GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF are removed from the
 * environment by makeGit.
 * https://git-scm.com/docs/git-diff (diff.noprefix, diff.mnemonicPrefix, --no-ext-diff, --no-textconv, --inter-hunk-context,
 * GIT_DIFF_OPTS, GIT_EXTERNAL_DIFF), https://git-scm.com/docs/git-config (core.quotePath).
 * @param {string} mergeBase @param {string[]} files
 */
export function newCodeDiffArgs(mergeBase, files) {
  return [
    "-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
    "diff", "--no-color", "-U0", "--no-renames", "--no-ext-diff", "--no-textconv", "--inter-hunk-context=0", mergeBase, "--", ...files,
  ];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** @param {string | undefined} n a hunk count; omitted means 1 */
const countOf = (n) => (n === undefined ? 1 : Number(n));

/** The current file is not understood: drop its entry, and ignore everything until the next `diff --git`. @param {State} s */
function poison(s) {
  if (s.path !== undefined) s.ranges.delete(s.path);
  s.poisoned = true;
  s.oldLeft = 0;
  s.newLeft = 0;
}

/** @param {State} s @param {string} line a hunk body line (a hunk is open) */
function consumeBody(s, line) {
  if (line.startsWith("\\")) return;
  if (line.startsWith("-") && s.oldLeft > 0) s.oldLeft--;
  else if (line.startsWith("+") && s.newLeft > 0) s.newLeft--;
  else poison(s);
}

/** @param {string} line a `+++ ` header line @returns {string | undefined} the repository path, or undefined for /dev/null or an unreadable name */
function newSidePath(line) {
  // Git appends a tab after a path that contains a space; a tab inside a name would be quoted, so the first tab ends the name.
  const name = line.slice(4).split("\t")[0] ?? "";
  return name.startsWith("b/") ? name.slice(2) : undefined;
}

/** @param {State} s @param {string} line a `+++ ` line @param {boolean} afterOld the previous line was `--- ` */
function newSideHeader(s, line, afterOld) {
  const target = newSidePath(line);
  if (!afterOld || target === undefined || s.path !== undefined) return poison(s);
  s.path = target;
  // A second header block for a path already seen: neither block is trusted.
  if (s.seen.has(target)) return poison(s);
  s.seen.add(target);
}

/** The entry is created by the file's first hunk, so a file with zero new lines has [] and a file git said nothing about has none. @param {State} s @param {string} line an `@@` line */
function hunkHeader(s, line) {
  const hunk = HUNK.exec(line);
  if (!hunk || s.path === undefined) return poison(s);
  let own = s.ranges.get(s.path);
  if (!own) {
    own = [];
    s.ranges.set(s.path, own);
  }
  s.oldLeft = countOf(hunk[1]);
  s.newLeft = countOf(hunk[3]);
  if (s.newLeft > 0) own.push([Number(hunk[2]), Number(hunk[2]) + s.newLeft - 1]);
}

/** @param {State} s @param {string} line outside a hunk body, inside a file */
function fileLine(s, line) {
  const afterOld = s.afterOld;
  s.afterOld = line.startsWith("--- ");
  if (line.startsWith("+++ ")) return newSideHeader(s, line, afterOld);
  if (line.startsWith("@@")) return hunkHeader(s, line);
  // After the `+++` line only hunks, hunk bodies and `\` markers are understood; before it, git's extended header lines (index,
  // mode, new file ...) are skipped, since no range can be attached to them.
  if (s.path !== undefined && !line.startsWith("\\")) poison(s);
}

/** @param {State} s */
function startFile(s) {
  s.path = undefined;
  s.afterOld = false;
  s.poisoned = false;
  s.oldLeft = 0;
  s.newLeft = 0;
}

/** @param {string} diffText @returns {Map<string, LineRanges>} */
export function changedLineRanges(diffText) {
  /** @type {State} */
  const s = { ranges: new Map(), seen: new Set(), path: undefined, afterOld: false, poisoned: true, oldLeft: 0, newLeft: 0 };
  const lines = diffText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // A body line starts with + - space or \, so this is a new file; a hunk still open here was cut short.
      if (s.oldLeft > 0 || s.newLeft > 0) poison(s);
      startFile(s);
    } else if (s.oldLeft > 0 || s.newLeft > 0) consumeBody(s, line);
    else if (!s.poisoned) fileLine(s, line);
  }
  if (s.oldLeft > 0 || s.newLeft > 0) poison(s);
  return s.ranges;
}
