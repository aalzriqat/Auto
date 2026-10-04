/**
 * The reviewed-debt baseline for UNPROVEN paths (D-24 CS-2).
 *
 * ⚠️ A COUNT IS NOT A BASELINE. "86 unproven paths, as before" lets one path be
 * fixed while a different, worse one appears, and the number never moves. Debt
 * is therefore recorded PER FINDING, and anything that differs from the record
 * is DRIFT, whichever way it differs:
 *
 *   new         an unproven path nobody has reviewed;
 *   removed     a reviewed path that is no longer reported (the entry is stale,
 *               and a stale entry would silently pre-approve its return);
 *   changed     the same finding, but the backend contract at or above that
 *               path is not the one that was reviewed;
 *   expired     the review lapsed;
 *   malformed / duplicate   the file itself is not trustworthy.
 *
 * ⚠️ THE MONITOR NEVER WRITES THIS FILE. A control that rewrites its own
 * allow-list turns "the debt grew" into "the debt is whatever it is today". An
 * entry is added by a person, from an inspected report, with a rationale, an
 * issue and an expiry.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { indexAllNamed, normalizeIdentifier } from "./specIndex.mjs";
import { compareCodeUnits } from "./compareCodeUnits.mjs";

/**
 * Fields that identify a finding, in key order. `fingerprint` and `cause` are
 * deliberately NOT part of the identity: the cause text embeds the backend
 * validator's type, so including it would turn "the contract under this path
 * changed" into an unrelated removed+new pair and hide the real reason.
 */
const IDENTITY_FIELDS = ["surface", "file", "callSiteId", "functionId", "contractPath", "kind"];
const REQUIRED_TEXT = [...IDENTITY_FIELDS, "cause", "fingerprint", "rationale", "issue", "expires"];
const KINDS = new Set(["SHAPE_UNKNOWN", "TYPE_UNKNOWN"]);

/** @param {Record<string, unknown>} entry */
export const identityOf = (entry) => IDENTITY_FIELDS.map((f) => String(entry[f])).join("\u0001");

const describe = (entry) =>
  `${entry.surface}:${entry.file} ${entry.callSiteId} ${entry.functionId} ${entry.contractPath} [${entry.kind}]`;

/**
 * normalised identifier -> entry, over every named function, not just public
 * ones: a function turning internal must CHANGE the fingerprint rather than
 * vanish into the same hash as "absent". When two raw identifiers normalise to
 * the same id the later one wins.
 *
 * @param {{ functions?: Array<any> } | Array<any>} spec
 * @returns {Map<string, any>}
 */
function namedByNormalizedId(spec) {
  const named = new Map();
  for (const [id, entry] of indexAllNamed(spec)) named.set(normalizeIdentifier(id), entry);
  return named;
}

/**
 * A fingerprint of the backend validator that governs `contractPath`.
 *
 * ⚠️ It hashes the whole top-level ARGUMENT FIELD containing the path, not the
 * leaf. A change at the path, above it (the field turned optional, a union gained
 * a branch) or beside it inside that field must all invalidate the review —
 * hashing only the leaf would let an ancestor change through. It over-invalidates
 * on a sibling edit inside the same field, deliberately: the error direction is a
 * red run that asks for a re-review, never a silent pass.
 *
 * @param {{ functions?: Array<any> } | Array<any>} spec
 * @param {string} functionId  normalised, e.g. `vehicles:update`
 * @param {string} contractPath
 * @param {Map<string, any>} [named]  `namedByNormalizedId(spec)`, when the caller fingerprints many findings against one spec
 */
export function contractFingerprint(spec, functionId, contractPath, named = namedByNormalizedId(spec)) {
  const fn = named.get(functionId);
  const args = fn?.args;
  const top = /^[A-Za-z_$][\w$]*/.exec(contractPath)?.[0];
  const fields = args && typeof args === "object" && args.value && typeof args.value === "object" ? args.value : {};
  const arg = top && Object.hasOwn(fields, top) ? { field: top, validator: fields[top] } : { whole: args ?? null };
  // ⚠️ The function's KIND and VISIBILITY are part of the contract (CS2-2): a
  // query turned into a mutation, or a public function made internal, changes
  // what a reviewed finding was reviewed against.
  const scope = { ...arg, functionType: fn?.functionType ?? null, visibility: fn?.visibility?.kind ?? null };
  return crypto.createHash("sha256").update(stable(scope)).digest("hex").slice(0, 16);
}

/** Key-sorted JSON, so reordering a spec's keys is not a contract change. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareCodeUnits)
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The per-finding record of what the run found unproven, aggregated by identity.
 *
 * @param {Array<{identifier:string,path:string,severity:string,detail:string,file:string,line?:number,siteId?:string,surface?:string}>} needsEvidence
 * @param {{ functions?: Array<any> } | Array<any>} spec
 */
export function unprovenFrom(needsEvidence, spec) {
  /** @type {Map<string, Record<string, unknown>>} */
  const grouped = new Map();
  const named = namedByNormalizedId(spec);
  for (const f of needsEvidence) {
    const entry = {
      surface: f.surface ?? "unknown",
      file: f.file,
      callSiteId: f.siteId ?? `${f.file}:${f.line}`,
      functionId: f.identifier,
      contractPath: f.path,
      kind: f.severity,
      cause: f.detail,
      fingerprint: contractFingerprint(spec, f.identifier, f.path, named),
    };
    const key = identityOf(entry);
    const existing = grouped.get(key);
    if (existing) {
      existing.multiplicity = Number(existing.multiplicity) + 1;
      // Differing causes at one identity must not hide each other.
      if (!String(existing.cause).split(" || ").includes(entry.cause)) existing.cause = `${existing.cause} || ${entry.cause}`;
    }
    else grouped.set(key, { ...entry, multiplicity: 1 });
  }
  return [...grouped.values()];
}

/**
 * @param {string} file
 * @returns {{ok: true, entries: any[]} | {ok: false, problem: string}}
 */
export function loadBaseline(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code;
    return {
      ok: false,
      problem:
        code === "ENOENT"
          ? `the needs-evidence baseline ${file} is absent; an absent baseline is not an empty one`
          : `the needs-evidence baseline ${file} could not be read (${String(/** @type {Error} */ (error)?.message ?? error)})`,
    };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return { ok: false, problem: `the needs-evidence baseline ${file} has no \`entries\` array` };
    }
    return { ok: true, entries: parsed.entries };
  } catch (error) {
    return {
      ok: false,
      problem: `the needs-evidence baseline ${file} is not valid JSON (${String(/** @type {Error} */ (error)?.message ?? error)})`,
    };
  }
}

/**
 * @param {Array<Record<string, unknown>>} unproven  from unprovenFrom()
 * @param {ReturnType<typeof loadBaseline>} loaded
 * @param {Date} [now]
 * @returns {{ drift: boolean, problems: string[], matched: number }}
 */
export function evaluateBaseline(unproven, loaded, now = new Date()) {
  if (!loaded.ok) return { drift: true, problems: [loaded.problem], matched: 0 };
  const problems = [];
  const today = now.toISOString().slice(0, 10);

  /** @type {Map<string, Record<string, any>>} */
  const valid = new Map();
  loaded.entries.forEach((entry, index) => {
    const where = `entry #${index + 1}`;
    if (!entry || typeof entry !== "object") {
      problems.push(`malformed baseline ${where}: not an object`);
      return;
    }
    const bad = REQUIRED_TEXT.filter((f) => typeof entry[f] !== "string" || entry[f].trim() === "");
    if (bad.length) {
      problems.push(`malformed baseline ${where}: missing or empty ${bad.join(", ")}`);
      return;
    }
    if (!KINDS.has(entry.kind)) {
      problems.push(`malformed baseline ${where}: kind must be SHAPE_UNKNOWN or TYPE_UNKNOWN`);
      return;
    }
    if (!Number.isInteger(entry.multiplicity) || entry.multiplicity < 1) {
      problems.push(`malformed baseline ${where}: multiplicity must be a positive integer`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
      problems.push(`malformed baseline ${where}: expires must be YYYY-MM-DD`);
      return;
    }
    const key = identityOf(entry);
    if (valid.has(key)) {
      problems.push(`duplicate baseline entry: ${describe(entry)}`);
      return;
    }
    valid.set(key, entry);
  });

  const found = new Map(unproven.map((u) => [identityOf(u), u]));
  let matched = 0;

  for (const [key, entry] of valid) {
    if (entry.expires < today) {
      problems.push(`expired baseline entry (expired ${entry.expires}, ${entry.issue}): ${describe(entry)}`);
      continue;
    }
    const current = found.get(key);
    if (!current) {
      problems.push(`baseline entry is no longer reported (fixed, moved or removed) - delete it after review: ${describe(entry)}`);
      continue;
    }
    if (current.fingerprint !== entry.fingerprint || current.cause !== entry.cause) {
      problems.push(`contract changed under a baselined path - the review no longer applies: ${describe(entry)}`);
      continue;
    }
    if (current.multiplicity !== entry.multiplicity) {
      problems.push(
        `multiplicity changed (${entry.multiplicity} reviewed, ${current.multiplicity} now): ${describe(entry)}`
      );
      continue;
    }
    matched++;
  }
  for (const [key, current] of found) {
    if (!valid.has(key)) problems.push(`new unproven path with no baseline entry: ${describe(current)}`);
  }
  return { drift: problems.length > 0, problems, matched };
}
