// Repository policy documents and the pinned trust anchor for their first use.
export const SCHEMA_VERSION = 1;
export const CONFIG_PATH = "quality/guardrails/config.json";
export const BASELINE_PATH = "quality/guardrails/baseline.json";

/**
 * The owner-approved policy (SCRUM-418) that the FIRST guardrail PR is
 * held to. On bootstrap the target has no config yet, so the PR's own config is
 * the only candidate; it may be tighter than this, never looser.
 *
 * These values deliberately duplicate config.json: this copy is the bootstrap
 * trust anchor, so the first PR cannot loosen its own policy.
 */
export const BOOTSTRAP_POLICY = Object.freeze({
  maxLines: 600,
  productionRoots: ["app/", "apps/", "components/", "convex/", "dealer-worker/src/", "hooks/", "lib/", "packages/"],
  extensions: [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"],
});

/** Code-unit order — never localeCompare, whose result depends on ICU/locale. */
export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function normalizeRepoPath(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Repository paths must be non-empty strings.");
  }
  let normalized = input.replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    segments.some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`Repository path is not canonical and relative: ${input}`);
  }
  return normalized;
}

// ---------------------------------------------------------------- documents

const CONFIG_KEYS = [
  "schemaVersion",
  "maxLines",
  "productionRoots",
  "extensions",
  "exemptions",
  "generated",
  "migrations",
  "countPinSkips",
  "sourceLineExceptions",
];
// Older target configs can omit rules introduced after their revision.
export const JUSTIFIED_LISTS = ["exemptions", "generated", "migrations", "countPinSkips"];

export function assertKeys(doc, allowed, label) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${label}: must be a JSON object.`);
  }
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unknown key "${key}".`);
  }
  for (const key of allowed) {
    if (!(key in doc)) throw new Error(`${label}: missing key "${key}".`);
  }
}

function assertStringList(list, label) {
  if (!Array.isArray(list) || list.some((v) => typeof v !== "string" || !v)) {
    throw new Error(`${label}: must be an array of non-empty strings.`);
  }
  if (new Set(list).size !== list.length) throw new Error(`${label}: duplicate entries.`);
}

function assertJustifiedList(list, label) {
  if (!Array.isArray(list)) throw new Error(`${label}: must be an array.`);
  const seen = new Set();
  for (const entry of list) {
    assertKeys(entry, ["path", "reason"], `${label} entry`);
    const entryPath = normalizeRepoPath(entry.path);
    if (entryPath !== entry.path) {
      throw new Error(`${label}: "${entry.path}" is not canonical.`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
      throw new Error(`${label}: "${entry.path}" needs a one-line justification.`);
    }
    if (seen.has(entry.path)) throw new Error(`${label}: duplicate "${entry.path}".`);
    seen.add(entry.path);
  }
}

/** Parse and strictly validate config.json. Every list entry needs a reason. */
export function parseConfig(text, label) {
  const doc = JSON.parse(text);
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    if (!("countPinSkips" in doc)) doc.countPinSkips = [];
    if (!("sourceLineExceptions" in doc)) doc.sourceLineExceptions = [];
  }
  assertKeys(doc, CONFIG_KEYS, label);
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  if (!Number.isInteger(doc.maxLines) || doc.maxLines < 1) {
    throw new Error(`${label}: maxLines must be a positive integer.`);
  }
  assertStringList(doc.productionRoots, `${label}.productionRoots`);
  assertStringList(doc.extensions, `${label}.extensions`);
  for (const root of doc.productionRoots) {
    if (!root.endsWith("/")) throw new Error(`${label}: root "${root}" must end with "/".`);
  }
  for (const listName of [...JUSTIFIED_LISTS, "sourceLineExceptions"]) {
    assertJustifiedList(doc[listName], `${label}.${listName}`);
  }
  return doc;
}
