/**
 * JSON text and path-containment helpers for the needs-evidence baseline.
 *
 * `serializeBaseline` / `parseCanonicalBaseline` fix the text form (2-space JSON, key order as parsed, the
 * file's existing line endings: a Windows `core.autocrlf=true` checkout holds it as CRLF) so an author tool's
 * diff is limited to the fields it changes. The files are written by `baselineShards.mjs`, the one writer.
 */
import fs from "node:fs";
import path from "node:path";

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
