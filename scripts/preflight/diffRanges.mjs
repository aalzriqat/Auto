/**
 * The new-side line ranges of each file in a `git diff -U0` text, used to keep sonar-lint to the lines a change added or modified
 * (Sonar's gate judges new code only). Format: https://git-scm.com/docs/diff-format. A file that is not in the result (new and
 * untracked) is judged on every line, and so is a file whose header cannot be read: the conservative direction.
 *
 * The text is parsed as the format defines it, not by looking for lines that resemble headers: `diff --git` starts a file, `+++`
 * counts as that file's header only on the line right after its `---`, and after an `@@ -a,b +c,d @@` header exactly b removed and
 * d added lines (plus `\ No newline` markers) are hunk body, whatever they say. Source text such as `++ b/x`, which a diff renders
 * as `+++ b/x`, can therefore never be read as a header.
 */

/** @typedef {Array<[number, number]>} LineRanges */
/** @typedef {{ ranges: Map<string, LineRanges>, current: LineRanges | undefined, afterOld: boolean, oldLeft: number, newLeft: number }} State */

/**
 * Git config pinned for the diff, so a user's own settings cannot change what is parsed: no quoting of non-ASCII paths, and the
 * standard a/ b/ prefixes. https://git-scm.com/docs/git-diff (diff.noprefix, diff.mnemonicPrefix), git-config (core.quotePath).
 * @param {string} mergeBase @param {string[]} files
 */
export function newCodeDiffArgs(mergeBase, files) {
  return [
    "-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false",
    "diff", "--no-color", "-U0", "--no-renames", mergeBase, "--", ...files,
  ];
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** @param {string | undefined} n a hunk count; omitted means 1 */
const countOf = (n) => (n === undefined ? 1 : Number(n));

/**
 * One hunk body line: a removed line, an added line, or a "\ No newline at end of file" marker. Anything else means the hunk is
 * over, so the line is read as a header.
 * @param {State} s @param {string} line @returns {boolean} true when the line was body
 */
function consumeBody(s, line) {
  if (line.startsWith("\\")) return true;
  if (line.startsWith("-") && s.oldLeft > 0) {
    s.oldLeft--;
    return true;
  }
  if (line.startsWith("+") && s.newLeft > 0) {
    s.newLeft--;
    return true;
  }
  s.oldLeft = 0;
  s.newLeft = 0;
  return false;
}

/** @param {string} line a `+++ ` header line @returns {string | undefined} the repository path, or undefined for /dev/null or an unreadable name */
function newSidePath(line) {
  // Git appends a tab after a path that contains a space; a tab inside a name would be quoted, so the first tab ends the name.
  const name = line.slice(4).split("\t")[0] ?? "";
  return name.startsWith("b/") ? name.slice(2) : undefined;
}

/** @param {State} s @param {string} line */
function headerLine(s, line) {
  const afterOld = s.afterOld;
  s.afterOld = line.startsWith("--- ");
  if (line.startsWith("diff --git ")) {
    s.current = undefined;
    return;
  }
  if (afterOld && line.startsWith("+++ ")) {
    const target = newSidePath(line);
    s.current = target === undefined ? undefined : [];
    if (target !== undefined && s.current) s.ranges.set(target, s.current);
    return;
  }
  const hunk = HUNK.exec(line);
  if (!hunk) return;
  s.oldLeft = countOf(hunk[1]);
  s.newLeft = countOf(hunk[3]);
  if (s.current && s.newLeft > 0) s.current.push([Number(hunk[2]), Number(hunk[2]) + s.newLeft - 1]);
}

/** @param {string} diffText @returns {Map<string, LineRanges>} */
export function changedLineRanges(diffText) {
  /** @type {State} */
  const s = { ranges: new Map(), current: undefined, afterOld: false, oldLeft: 0, newLeft: 0 };
  for (const line of diffText.split(/\r?\n/)) {
    if ((s.oldLeft > 0 || s.newLeft > 0) && consumeBody(s, line)) continue;
    headerLine(s, line);
  }
  return s.ranges;
}
