/**
 * The baseline as it stood at a git revision, in either layout.
 *
 * The renewal-evidence check compares today's baseline with the one at a REVIEWED revision (c82890bd, which holds the
 * single file) and at a pull request's base (which holds the single file until the sharding change merges, shards after
 * it). Reading both layouts here keeps that comparison working across the change; nothing writes the single file any more.
 */
import { resolveCommit, runGitText } from "./gitExecutable.mjs";
import { BASELINE_DIRECTORY, LEGACY_BASELINE_FILE, documentTextOf, parseShardSet } from "./baselineShards.mjs";

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * @param {string} git
 * @param {string} root
 * @param {string} revision
 * @returns {{ layout: "shards" | "legacy", commit: string, text: string, entries: Array<Record<string, any>> }}
 *   `text` is the single-document form the renewal functions parse
 */
export function baselineAtRevision(git, root, revision) {
  const commit = resolveCommit(git, revision, root);
  // https://git-scm.com/docs/git-ls-tree: -z NUL-terminates records "<mode> SP <type> SP <object> TAB <path>"; -r recurses.
  const listing = runGitText(git, ["ls-tree", "-r", "-z", commit, "--", `${BASELINE_DIRECTORY}/`], { cwd: root, maxBuffer: MAX_BUFFER });
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const record of listing.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type] = record.slice(0, tab).split(" ");
    const full = record.slice(tab + 1);
    const name = full.slice(BASELINE_DIRECTORY.length + 1);
    // A link or submodule is not a shard. Naming it with its path keeps the loader's "stray file" refusal.
    const text = type === "blob" && (mode === "100644" || mode === "100755")
      ? runGitText(git, ["show", `${commit}:${full}`], { cwd: root, maxBuffer: MAX_BUFFER })
      : `not a regular file (mode ${mode}, type ${type})`;
    files.set(name, text);
  }
  if (files.size > 0) {
    const parsed = parseShardSet(files);
    if (!parsed.ok) throw new Error(`the baseline shards at ${revision} are not trustworthy: ${parsed.problem}`);
    return { layout: "shards", commit, text: documentTextOf(parsed.entries), entries: parsed.entries };
  }
  /** @type {string} */
  let text;
  try {
    text = runGitText(git, ["show", `${commit}:${LEGACY_BASELINE_FILE}`], { cwd: root, maxBuffer: MAX_BUFFER });
  } catch (error) {
    throw new Error(`no needs-evidence baseline (shards or ${LEGACY_BASELINE_FILE}) at ${revision}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = JSON.parse(text);
  if (!document || !Array.isArray(document.entries)) throw new Error(`the baseline file at ${revision} has no entries array`);
  return { layout: "legacy", commit, text, entries: document.entries };
}
