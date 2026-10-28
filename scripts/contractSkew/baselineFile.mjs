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
 * Replace `file` with `text` through a temporary file in the same directory, so a
 * failure never leaves a half-written baseline. Refuses if the file changed since
 * `expectedBefore` was read.
 *
 * @param {string} file
 * @param {string} text
 * @param {string} expectedBefore
 */
export function writeBaselineAtomically(file, text, expectedBefore) {
  if (fs.readFileSync(file, "utf8") !== expectedBefore) throw new Error("Baseline changed while checking; refusing write");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { flag: "wx", mode: fs.statSync(file).mode });
    fs.renameSync(temporary, file);
  } finally {
    // Created by this call; the original is never removed on failure.
    fs.rmSync(temporary, { force: true });
  }
}
