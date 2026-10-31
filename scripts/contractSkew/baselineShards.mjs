/**
 * The needs-evidence baseline, stored as one shard per baselined client source file (SCRUM-873).
 *
 * WHY SHARDS. The baseline was one 13,895-line JSON file that nearly every money pull request edited. The
 * certificate-carry check (scripts/skillEnforcement/checkPrSkillEvidence.mjs) refuses whenever main touched a file the
 * pull request also touched, so the carry almost never applied and every update-from-main cost a full re-review. A
 * shard holds the entries of exactly one client file, so a pull request that changes client file X touches only shard X,
 * and main touches that shard only when another pull request also changed X: a genuine overlap.
 *
 * LAYOUT.  `scripts/contractSkew/needs-evidence-baseline/<name>.json`, one file per client file, where
 *
 *   - `<name>` is `encodeFilePath(file)` + ".json" (injective, all lower case, see below);
 *   - the document is `{ "version": 1, "file": "<client file>", "entries": [ ... ] }`;
 *   - every entry's own `file` equals the shard's `file`;
 *   - entries are sorted by `compareEntries` and written as 2-space JSON, so regenerating a shard from the same
 *     entries is byte-identical;
 *   - an explicitly empty baseline is the single file `~empty.json`; an empty directory is NOT an empty baseline
 *     (git cannot store one, and "0 entries" is also what a wrongly pointed path looks like).
 *
 * WHY THE NAME IS ENCODED. Windows and macOS file systems are case-insensitive by default, so `A.tsx` and `a.tsx` would
 * name one file; and `/`, `(`, `[` are unsafe or awkward in names. The encoding keeps `[a-z0-9._-]` as they are,
 * writes `/` as `+`, an upper-case letter as `=` plus its lower-case form, and every other UTF-8 byte as `~` plus two
 * lower-case hex digits (so a literal `+`, `=` or `~` is `~2b`, `~3d`, `~7e`). The output never contains an upper-case
 * letter, so two different client paths can never differ only by case, and it can be decoded again, so two different
 * paths can never share a name. `app/(dashboard)/dashboard/page.tsx` becomes
 * `app+~28dashboard~29+dashboard+page.tsx.json`; `components/applications/cockpit/DealCockpit.tsx` becomes
 * `components+applications+cockpit+=deal=cockpit.tsx.json`.
 *
 * FAIL CLOSED. `loadShardedBaseline` refuses (never skips) a malformed shard, a duplicate entry across shards, an entry
 * in a shard that is not its file's, a stray or unknown file, a shard whose name is not the encoding of the file it
 * declares, a shard that is not in canonical form, an absent directory and an empty one.
 *
 * ⚠️ The monitor never writes the baseline. `writeShardedBaseline` is for the author tools (relocate, renew, shard).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compareCodeUnits } from "./compareCodeUnits.mjs";
import { resolveInside, serializeBaseline } from "./baselineFile.mjs";

export const BASELINE_DIRECTORY = "scripts/contractSkew/needs-evidence-baseline";
/** The single-file layout used before SCRUM-873. Read only from git history; nothing writes it any more. */
export const LEGACY_BASELINE_FILE = "scripts/contractSkew/needs-evidence-baseline.json";
export const SHARD_VERSION = 1;
export const EMPTY_MARKER_NAME = "~empty.json";
/** NTFS and most file systems cap one name at 255 characters; stay well inside it. */
export const MAX_SHARD_NAME_LENGTH = 200;

/** Fields that identify a finding, in key order. See baseline.mjs for why `cause` and `fingerprint` are not among them. */
export const IDENTITY_FIELDS = ["surface", "file", "callSiteId", "functionId", "contractPath", "kind"];

/** @param {Record<string, unknown>} entry */
export const identityOf = (entry) => IDENTITY_FIELDS.map((f) => String(entry[f])).join("\u0001");

const describeIdentity = (entry) =>
  `${entry.surface}:${entry.file} ${entry.callSiteId} ${entry.functionId} ${entry.contractPath} [${entry.kind}]`;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SHARD_NAME = /^[a-z0-9._+=~-]+\.json$/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Injective, case-insensitive-safe encoding of a repository-relative client path. See the header.
 * @param {string} file
 * @returns {string}
 */
export function encodeFilePath(file) {
  if (typeof file !== "string" || file === "") throw new Error("a shard is named after a non-empty client file path");
  if (LONE_SURROGATE.test(file)) throw new Error(`client file ${JSON.stringify(file)} is not well-formed Unicode; refusing to name a shard after it`);
  let out = "";
  for (const char of file) {
    if (/^[a-z0-9._-]$/.test(char)) out += char;
    else if (char === "/") out += "+";
    // A-Z (0x41-0x5A) plus 0x20 is a-z. Not `toLowerCase()`: fetchSpec.test.ts allows exactly one case-folding site in
    // this folder (the path normalizer), and this is an encoding, not path normalization.
    else if (/^[A-Z]$/.test(char)) out += `=${String.fromCharCode(char.charCodeAt(0) + 0x20)}`;
    else for (const byte of new TextEncoder().encode(char)) out += `~${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/**
 * The shard file name for a client file.
 * @param {string} file
 * @returns {string}
 */
export function shardNameFor(file) {
  const name = `${encodeFilePath(file)}.json`;
  if (name.length > MAX_SHARD_NAME_LENGTH) {
    throw new Error(`the shard name for ${file} is ${name.length} characters, over the ${MAX_SHARD_NAME_LENGTH} limit; refusing`);
  }
  return name;
}

/**
 * Inverse of `shardNameFor`; `null` when `name` is not the encoding of any path.
 * @param {string} name
 * @returns {string | null}
 */
export function decodeShardName(name) {
  if (typeof name !== "string" || !SHARD_NAME.test(name)) return null;
  const body = name.slice(0, -".json".length);
  let text = "";
  /** @type {number[]} */
  let pending = [];
  const flush = () => {
    if (pending.length === 0) return true;
    try {
      text += strictUtf8.decode(Uint8Array.from(pending));
    } catch {
      return false;
    }
    pending = [];
    return true;
  };
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === "~") {
      const hex = body.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) return null;
      pending.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (!flush()) return null;
    if (char === "+") text += "/";
    else if (char === "=") {
      const letter = body[i + 1];
      if (letter === undefined || !/^[a-z]$/.test(letter)) return null;
      text += letter.toUpperCase();
      i += 1;
    } else text += char;
  }
  return flush() ? text : null;
}

/** @param {unknown} callSiteId */
const positionOf = (callSiteId) => {
  const match = /:(\d+):(\d+)$/.exec(String(callSiteId));
  return match ? [Number(match[1]), Number(match[2])] : [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
};

/**
 * Canonical order of the entries inside one shard: surface, then source position (numeric line, numeric column), then
 * the remaining identity fields. Total over entries with distinct identities.
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
export function compareEntries(a, b) {
  const [lineA, columnA] = positionOf(a.callSiteId);
  const [lineB, columnB] = positionOf(b.callSiteId);
  return compareCodeUnits(a.surface, b.surface) || lineA - lineB || columnA - columnB ||
    compareCodeUnits(a.callSiteId, b.callSiteId) || compareCodeUnits(a.functionId, b.functionId) ||
    compareCodeUnits(a.contractPath, b.contractPath) || compareCodeUnits(a.kind, b.kind);
}

/** Key-sorted JSON: two values are equal exactly when their canonical forms are the same string. @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    return `{${Object.keys(record).sort(compareCodeUnits).map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Entry-set equality, key for key and value for value: two lists are equal exactly when their entries have the same
 * identities and every entry's canonical JSON (keys sorted, all fields, including `renewal` prose) is the same. Order is
 * not compared; the list a shard set loads in is deterministic, not the old file's order.
 *
 * @param {Array<Record<string, any>>} before
 * @param {Array<Record<string, any>>} after
 * @returns {{ equal: boolean, before: number, after: number, onlyBefore: string[], onlyAfter: string[], different: string[], duplicates: string[] }}
 */
export function entrySetDifferences(before, after) {
  const index = (/** @type {Array<Record<string, any>>} */ entries, /** @type {string[]} */ duplicates) => {
    /** @type {Map<string, string>} */
    const map = new Map();
    for (const entry of entries) {
      const key = identityOf(entry);
      if (map.has(key)) duplicates.push(describeIdentity(entry));
      map.set(key, canonicalJson(entry));
    }
    return map;
  };
  /** @type {string[]} */
  const duplicates = [];
  const left = index(before, duplicates);
  const right = index(after, duplicates);
  const label = (/** @type {string} */ key) => describeIdentity(Object.fromEntries(IDENTITY_FIELDS.map((f, i) => [f, key.split("\u0001")[i]])));
  const onlyBefore = [...left.keys()].filter((k) => !right.has(k)).map(label);
  const onlyAfter = [...right.keys()].filter((k) => !left.has(k)).map(label);
  const different = [...left].filter(([k, v]) => right.has(k) && right.get(k) !== v).map(([k]) => label(k));
  const sameMultiset = canonicalJson(before.map(canonicalJson).sort(compareCodeUnits)) === canonicalJson(after.map(canonicalJson).sort(compareCodeUnits));
  return {
    equal: sameMultiset && !onlyBefore.length && !onlyAfter.length && !different.length && !duplicates.length,
    before: before.length, after: after.length, onlyBefore, onlyAfter, different, duplicates,
  };
}

/**
 * The text of one shard. `like` (the shard's current text, when it has one) decides the line endings, as for the old
 * single file: a Windows checkout with core.autocrlf=true holds it as CRLF.
 * @param {string} file
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} [like]
 */
export function serializeShard(file, entries, like = "") {
  return serializeBaseline({ version: SHARD_VERSION, file, entries: [...entries].sort(compareEntries) }, like);
}

/** The explicitly empty baseline. @param {string} [like] */
export function serializeEmptyMarker(like = "") {
  return serializeBaseline({ version: SHARD_VERSION, empty: true }, like);
}

/**
 * The whole baseline as the single-document text the old file held. The author tools were written against that
 * text; this is the seam that lets them keep their pure functions.
 * @param {Array<Record<string, unknown>>} entries
 */
export const documentTextOf = (entries) => serializeBaseline({ version: SHARD_VERSION, entries }, "");

/**
 * @param {string} name
 * @param {string} text
 * @returns {{ problems: string[], file?: string, entries: Array<Record<string, any>> }}
 */
function parseShard(name, text) {
  /** @type {string[]} */
  const problems = [];
  /** @type {any} */
  let document;
  try {
    document = JSON.parse(text.replace(/\r\n/g, "\n"));
  } catch (error) {
    return { problems: [`shard ${name} is not valid JSON (${String(/** @type {Error} */ (error)?.message ?? error)})`], entries: [] };
  }
  if (!isRecord(document)) return { problems: [`shard ${name} is not a JSON object`], entries: [] };
  const unknown = Object.keys(document).filter((k) => !["version", "file", "entries"].includes(k));
  if (unknown.length) problems.push(`shard ${name} has unknown key(s) ${unknown.join(", ")}`);
  if (document.version !== SHARD_VERSION) problems.push(`shard ${name} has version ${JSON.stringify(document.version)}, expected ${SHARD_VERSION}`);
  if (typeof document.file !== "string" || document.file.trim() === "") problems.push(`shard ${name} names no client file`);
  if (!Array.isArray(document.entries)) return { problems: [...problems, `shard ${name} has no \`entries\` array`], entries: [] };
  if (document.entries.length === 0) problems.push(`shard ${name} has no entries; delete a shard whose client file has no baselined calls`);
  const entries = [];
  document.entries.forEach((entry, index) => {
    if (!isRecord(entry)) problems.push(`shard ${name} entry #${index + 1} is not an object`);
    else if (typeof entry.file !== "string" || entry.file.trim() === "") problems.push(`shard ${name} entry #${index + 1} names no client file`);
    else entries.push(entry);
  });
  if (problems.length === 0) {
    // Canonical form: formatting and order. A hand edit that reformats or reorders a shard must be refused, or two
    // regenerations of the same entries could differ and the diff would carry noise a reviewer cannot judge.
    const canonical = serializeShard(document.file, document.entries, text);
    if (canonical !== text) problems.push(`shard ${name} is not in canonical form (2-space JSON, entries in canonical order, newline-terminated); regenerate it with the author tools`);
  }
  return { problems, file: typeof document.file === "string" ? document.file : undefined, entries };
}

/**
 * @typedef {{ ok: true, entries: Array<Record<string, any>>, files: Map<string, string> }
 *   | { ok: false, problem: string, problems: string[] }} ShardSet
 */

/**
 * Parse an in-memory shard set (name -> text). Pure: used for the working tree and for any git revision.
 * Every problem found is reported, not just the first.
 * @param {Map<string, string>} files
 * @returns {ShardSet}
 */
export function parseShardSet(files) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Array<Record<string, any>>} */
  const entries = [];
  /** @type {Map<string, string>} identity -> shard name */
  const seen = new Map();
  const names = [...files.keys()].sort(compareCodeUnits);
  const hasMarker = files.has(EMPTY_MARKER_NAME);
  if (names.length === 0) {
    return refuse(["the needs-evidence baseline directory holds no shards; an empty directory is not an empty baseline"]);
  }
  for (const name of names) {
    const text = /** @type {string} */ (files.get(name));
    if (name === EMPTY_MARKER_NAME) {
      if (text !== serializeEmptyMarker(text)) problems.push(`${name} is not the canonical empty-baseline marker`);
      else if (names.length > 1) problems.push(`${name} declares an empty baseline but shards are present; remove one or the other`);
      continue;
    }
    const decoded = decodeShardName(name);
    if (decoded === null || `${encodeFilePath(decoded)}.json` !== name) {
      problems.push(`stray or unknown file ${JSON.stringify(name)} in the baseline directory (a shard is named by its client file, see baselineShards.mjs)`);
      continue;
    }
    const shard = parseShard(name, text);
    problems.push(...shard.problems);
    if (shard.file !== undefined && shard.file !== decoded) {
      problems.push(`shard ${name} declares client file ${shard.file}, but its name is the encoding of ${decoded}`);
    }
    for (const entry of shard.entries) {
      if (entry.file !== decoded) {
        problems.push(`entry in the wrong shard: ${describeIdentity(entry)} belongs in ${shardNameSafe(entry.file)}, found in ${name}`);
      }
      const key = identityOf(entry);
      const first = seen.get(key);
      if (first !== undefined) problems.push(`duplicate baseline entry: ${describeIdentity(entry)} (in ${first} and ${name})`);
      else seen.set(key, name);
      entries.push(entry);
    }
  }
  if (hasMarker && names.length === 1 && problems.length === 0) return { ok: true, entries: [], files };
  return problems.length ? refuse(problems) : { ok: true, entries, files };
}

/** @param {unknown} file */
function shardNameSafe(file) {
  try {
    return shardNameFor(/** @type {string} */ (file));
  } catch {
    return "(no valid shard)";
  }
}

/** @param {string[]} problems @returns {{ ok: false, problem: string, problems: string[] }} */
function refuse(problems) {
  const shown = problems.slice(0, 20);
  const more = problems.length > shown.length ? `; ... ${problems.length - shown.length} more` : "";
  return { ok: false, problem: `the needs-evidence baseline is not trustworthy: ${shown.join("; ")}${more}`, problems };
}

/**
 * Read a shard directory into name -> text, refusing anything that is not a plain file.
 * @param {string} directory
 * @returns {{ ok: true, files: Map<string, string> } | { ok: false, problem: string }}
 */
export function readShardFiles(directory) {
  /** @type {fs.Dirent[]} */
  let dirents;
  try {
    dirents = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    if (code === "ENOENT") return { ok: false, problem: `the needs-evidence baseline ${directory} is absent; an absent baseline is not an empty one` };
    if (code === "ENOTDIR") {
      return { ok: false, problem: `the needs-evidence baseline ${directory} is a file, not a directory of shards; since SCRUM-873 the baseline is one shard per client file (see baselineShards.mjs)` };
    }
    return { ok: false, problem: `the needs-evidence baseline ${directory} could not be read (${String(/** @type {Error} */ (error)?.message ?? error)})` };
  }
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const dirent of dirents) {
    if (!dirent.isFile()) {
      return { ok: false, problem: `the needs-evidence baseline directory holds ${JSON.stringify(dirent.name)}, which is not a regular file (a stray directory or link); refusing` };
    }
    try {
      files.set(dirent.name, fs.readFileSync(path.join(directory, dirent.name), "utf8"));
    } catch (error) {
      return { ok: false, problem: `the needs-evidence baseline shard ${dirent.name} could not be read (${String(/** @type {Error} */ (error)?.message ?? error)})` };
    }
  }
  return { ok: true, files };
}

/**
 * Load the whole shard set into the entry list the single file used to hold.
 * @param {string} directory
 * @returns {ShardSet}
 */
export function loadShardedBaseline(directory) {
  const read = readShardFiles(directory);
  if (!read.ok) return { ok: false, problem: read.problem, problems: [read.problem] };
  return parseShardSet(read.files);
}

/**
 * Group entries into the shard set they belong to.
 * @param {Array<Record<string, any>>} entries
 * @param {Map<string, string>} existing  current texts, so a CRLF shard stays CRLF
 * @param {{ allowEmpty?: boolean }} [options]
 * @returns {Map<string, string>}
 */
export function buildShardFiles(entries, existing = new Map(), { allowEmpty = false } = {}) {
  /** @type {Map<string, { file: string, entries: Array<Record<string, any>> }>} */
  const groups = new Map();
  entries.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.file !== "string" || entry.file.trim() === "") {
      throw new Error(`baseline entry #${index + 1} names no client file; it cannot be placed in a shard`);
    }
    const name = shardNameFor(entry.file);
    const group = groups.get(name) ?? { file: entry.file, entries: [] };
    group.entries.push(entry);
    groups.set(name, group);
  });
  /** @type {Map<string, string>} */
  const files = new Map();
  if (groups.size === 0) {
    if (!allowEmpty) throw new Error("refusing to write an empty baseline; retiring all reviewed debt is a reviewed decision (pass allowEmpty)");
    files.set(EMPTY_MARKER_NAME, serializeEmptyMarker(existing.get(EMPTY_MARKER_NAME) ?? ""));
    return files;
  }
  for (const [name, group] of [...groups].sort((a, b) => compareCodeUnits(a[0], b[0]))) {
    files.set(name, serializeShard(group.file, group.entries, existing.get(name) ?? ""));
  }
  return files;
}

/** @param {Map<string, string>} a @param {Map<string, string>} b */
const sameFiles = (a, b) => a.size === b.size && [...a].every(([name, text]) => b.get(name) === text);

/**
 * Write `entries` back as shards: changed shards are replaced through a temporary file in the same directory, shards
 * with no entries left are removed, untouched shards are not rewritten. Refuses if the directory changed since
 * `before` was read, if the result would not load, or if `directory` is outside `root`.
 *
 * Each file is replaced atomically; the SET is not (a crash between two files leaves some shards new and some old,
 * every one individually valid). The author tools run against a working tree, where git is the safety net.
 *
 * @param {string} directory
 * @param {Array<Record<string, any>>} entries
 * @param {{ before: Map<string, string>, root?: string, allowEmpty?: boolean }} options
 * @returns {{ written: string[], removed: string[], unchanged: number }}
 */
export function writeShardedBaseline(directory, entries, { before, root = process.cwd(), allowEmpty = false }) {
  const target = resolveInside(root, directory, "baseline");
  /** @type {Map<string, string>} */
  let current = new Map();
  if (fs.existsSync(target)) {
    const read = readShardFiles(target);
    if (!read.ok) throw new Error(read.problem);
    current = read.files;
  }
  if (!sameFiles(current, before)) throw new Error("Baseline changed while checking; refusing write");
  const desired = buildShardFiles(entries, current, { allowEmpty });
  const parsed = parseShardSet(desired);
  if (!parsed.ok) throw new Error(`refusing to write a baseline that would not load: ${parsed.problem}`);
  fs.mkdirSync(target, { recursive: true });
  /** @type {string[]} */
  const written = [];
  let unchanged = 0;
  for (const [name, text] of desired) {
    if (current.get(name) === text) {
      unchanged++;
      continue;
    }
    replaceAtomically(path.join(target, name), text);
    written.push(name);
  }
  const removed = [...current.keys()].filter((name) => !desired.has(name));
  for (const name of removed) fs.rmSync(path.join(target, name));
  return { written, removed, unchanged };
}

/** @param {string} file @param {string} text */
function replaceAtomically(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const mode = fs.existsSync(file) ? fs.statSync(file).mode : 0o644;
    fs.writeFileSync(temporary, text, { flag: "wx", mode });
    fs.renameSync(temporary, file);
  } finally {
    // Created by this call; the original is never removed on failure.
    fs.rmSync(temporary, { force: true });
  }
}
