/**
 * The new-side line ranges of ONE file, read from a `git diff -U0` run for that file alone (Sonar's gate judges new code only, so
 * sonar-lint keeps findings on those lines). Format: https://git-scm.com/docs/diff-format.
 *
 * Design: a file's identity is the file we asked git about. Nothing the diff text says about paths ever keys a result, so no git
 * setting or environment can make one file's ranges be credited to another. The printed path is used only as a check: when it is not
 * exactly `b/<requested file>` the output is not understood. The result is a list of ranges, or `undefined` meaning "every line of
 * the file is judged". `undefined` is what every doubt turns into: no output (unchanged, untracked or ignored file), more than one
 * `diff --git` block, a deleted, symlinked or gitlinked file, a context line or a hunk whose length does not match its header, a
 * combined-diff header, a `+++` with no `---` before it, any unexpected line. An empty list therefore means one thing: git reported
 * the file with zero new lines.
 *
 * Known limits (not covered, see README): GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE in the environment point git at another
 * repository or index, and a clean filter or `.gitattributes` setting that changes the line count of what git diffs but not what
 * ESLint reads. Both would need a different design than reading the diff.
 */

/** @typedef {Array<[number, number]>} LineRanges */
/** @typedef {{ file: string, blocks: number, headerSeen: boolean, ranges: LineRanges | undefined, oldLeft: number, newLeft: number }} State */

/**
 * The git call for one file. Config and options are pinned so nothing a user or environment sets changes the diff's shape: no quoting
 * of non-ASCII paths, the standard a/ b/ prefixes (the explicit prefix options override diff.srcPrefix, diff.dstPrefix, diff.noprefix
 * and diff.mnemonicPrefix; defence in depth, since the parser does not trust the printed path anyway), literal pathspecs (a glob or
 * pathspec-magic character in a file name matches only that file), no renames, no external diff driver or textconv, and no
 * inter-hunk context (with -U0, diff.interHunkContext and GIT_DIFF_OPTS can otherwise add context lines; makeGit removes
 * GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF from the environment).
 * https://git-scm.com/docs/git-diff (--src-prefix, --dst-prefix, --no-ext-diff, --no-textconv, --inter-hunk-context, GIT_DIFF_OPTS,
 * GIT_EXTERNAL_DIFF), https://git-scm.com/docs/git-config (core.quotePath, diff.*), https://git-scm.com/docs/git (--literal-pathspecs).
 * @param {string} mergeBase @param {string} file
 */
export function newCodeDiffArgs(mergeBase, file) {
  return [
    "-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "--literal-pathspecs",
    "diff", "--no-color", "-U0", "--no-renames", "--no-ext-diff", "--no-textconv", "--inter-hunk-context=0",
    "--src-prefix=a/", "--dst-prefix=b/", mergeBase, "--", file,
  ];
}

/**
 * Git splits lines on LF only; ESLint also splits on a lone CR, U+2028 and U+2029 (its `lineBreakPattern`), so for such a file the
 * line numbers of the diff and of the findings differ.
 * @param {string} text
 */
export function hasEslintOnlyLineBreak(text) {
  return new RegExp(`\\r(?!\\n)|[${String.fromCharCode(0x2028, 0x2029)}]`).test(text);
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** Extended header lines that mean a symlink (120000) or a gitlink (160000): the diff's lines are not the file ESLint reads. */
const SPECIAL_MODE = /^(?:(?:old |new |deleted file |new file )?mode |index \S+ )(?:120000|160000)$/;
/** @param {string | undefined} n a hunk count; omitted means 1 */
const countOf = (n) => (n === undefined ? 1 : Number(n));

/** @param {State} s @param {string} line a hunk body line (a hunk is open) @returns {boolean} false when not understood */
function bodyLine(s, line) {
  if (line.startsWith("\\")) return true;
  if (line.startsWith("-") && s.oldLeft > 0) s.oldLeft--;
  else if (line.startsWith("+") && s.newLeft > 0) s.newLeft--;
  else return false;
  return true;
}

/** @param {State} s @param {string} line a `+++ ` line @param {boolean} afterOld the previous line was `--- ` */
function newSideHeader(s, line, afterOld) {
  if (!afterOld || s.headerSeen) return false;
  s.headerSeen = true;
  // Git appends a tab after a path that contains a space; the first tab ends the name. A check, never a key.
  return line.slice(4).split("\t")[0] === `b/${s.file}`;
}

/** The entry is created by the first hunk, so a file with zero new lines is [] and one git said nothing about has none. @param {State} s @param {string} line an `@@` line */
function hunkHeader(s, line) {
  const hunk = HUNK.exec(line);
  if (!hunk || !s.headerSeen) return false;
  s.ranges ??= [];
  s.oldLeft = countOf(hunk[1]);
  s.newLeft = countOf(hunk[3]);
  if (s.newLeft > 0) s.ranges.push([Number(hunk[2]), Number(hunk[2]) + s.newLeft - 1]);
  return true;
}

/** @param {State} s @param {string} line outside a hunk body @param {boolean} afterOld @returns {boolean} false when not understood */
function headerLine(s, line, afterOld) {
  if (line.startsWith("+++ ")) return newSideHeader(s, line, afterOld);
  if (line.startsWith("@@")) return hunkHeader(s, line);
  if (line.startsWith("--- ")) return !s.headerSeen && !afterOld;
  // After the `+++` line only hunks and `\` markers are understood; before it, git's extended header lines (index, mode, new file)
  // are skipped unless they say symlink or gitlink.
  if (s.headerSeen) return line.startsWith("\\");
  return !SPECIAL_MODE.test(line);
}

/** @param {State} s @param {string} line @param {boolean} afterOld @returns {boolean} false when not understood */
function lineOk(s, line, afterOld) {
  if (line.startsWith("diff --git ")) return ++s.blocks === 1;
  if (s.blocks === 0) return false;
  if (s.oldLeft > 0 || s.newLeft > 0) return bodyLine(s, line);
  return headerLine(s, line, afterOld);
}

/**
 * @param {string} diffText the output of `git diff` built by newCodeDiffArgs for `file`
 * @param {string} file the file that was asked about
 * @returns {LineRanges | undefined} the new-side ranges, or undefined: judge every line of the file
 */
export function newCodeLineRanges(diffText, file) {
  /** @type {State} */
  const s = { file, blocks: 0, headerSeen: false, ranges: undefined, oldLeft: 0, newLeft: 0 };
  const lines = diffText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let previous = "";
  for (const line of lines) {
    const afterOld = previous.startsWith("--- ");
    previous = line;
    if (!lineOk(s, line, afterOld)) return undefined;
  }
  if (s.oldLeft > 0 || s.newLeft > 0) return undefined;
  return s.headerSeen ? s.ranges : undefined;
}
