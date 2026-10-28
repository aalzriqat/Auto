/**
 * Reading and rewriting needs-evidence-baseline.json without disturbing it.
 *
 * Shared by the two author tools that edit the baseline (`renewBaselineReviewed`,
 * `relocateBaseline`) so both keep the diff limited to the fields they change:
 * 2-space JSON, key order as parsed, the file's existing line endings (a Windows
 * `core.autocrlf=true` checkout holds it as CRLF), and an atomic replace.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * @param {unknown} document
 * @param {string} like  the file's current text; its line endings are kept
 * @returns {string}
 */
export function serializeBaseline(document, like) {
  const text = JSON.stringify(document, null, 2) + "\n";
  return like.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Throws unless `text` is exactly what `serializeBaseline` would write for its own
 * content, i.e. a rewrite cannot reformat a line the caller did not change.
 *
 * @param {string} text
 * @returns {any} the parsed document
 */
export function parseCanonicalBaseline(text) {
  const document = JSON.parse(text.replace(/\r\n/g, "\n"));
  if (serializeBaseline(document, text) !== text) {
    throw new Error("the baseline is not in canonical 2-space JSON, so a rewrite would reformat it; refusing");
  }
  return document;
}

/**
 * @param {string} parent  absolute directory
 * @param {string} child   absolute path
 */
const isWithin = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

/**
 * Resolve a command-line path against `root` and refuse one that leaves it (path traversal, CWE-22; Sonar
 * jssecurity:S8707; OWASP "Path Traversal"). The check is the documented pattern: `path.resolve` to normalise
 * `..` segments and absolute inputs, then `path.relative` to prove containment. It is repeated on the real path
 * (`fs.realpathSync`) of whatever already exists, so a symlink or junction inside the root cannot point out of it.
 *
 * @param {string} root       the repository root (the directory the tool is run for)
 * @param {unknown} candidate the path as typed
 * @param {string} [role]     named in the refusal
 * @returns {string} an absolute path inside `root`
 */
export function resolveInside(root, candidate, role = "path") {
  if (typeof candidate !== "string" || candidate.trim() === "" || candidate.includes("\0")) {
    throw new Error(`${role} must be a non-empty path`);
  }
  const lexicalRoot = path.resolve(root);
  const resolved = path.resolve(lexicalRoot, candidate);
  if (!isWithin(lexicalRoot, resolved)) throw new Error(`${role} ${candidate} is outside the repository root ${lexicalRoot}; refusing`);
  const realRoot = fs.realpathSync(lexicalRoot);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error;
  }
  if (!isWithin(realRoot, real)) throw new Error(`${role} ${candidate} resolves outside the repository root ${lexicalRoot}; refusing`);
  return resolved;
}

/**
 * Replace `file` with `text` through a temporary file in the same directory, so a
 * failure never leaves a half-written baseline. Refuses if the file changed since
 * `expectedBefore` was read, or if `file` is outside `root`.
 *
 * @param {string} file
 * @param {string} text
 * @param {string} expectedBefore
 * @param {string} [root]  defaults to the working directory
 */
export function writeBaselineAtomically(file, text, expectedBefore, root = process.cwd()) {
  const target = resolveInside(root, file, "baseline");
  if (fs.readFileSync(target, "utf8") !== expectedBefore) throw new Error("Baseline changed while checking; refusing write");
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: fs.statSync(target).mode });
    fs.renameSync(temporary, target);
  } finally {
    // Created by this call; the original is never removed on failure.
    fs.rmSync(temporary, { force: true });
  }
}
