// SCRUM-426 (SCRUM-418 step 1) — pure rules for the blocking size + import
// guardrails. No I/O lives here: the CLI in check.mjs reads git and disk and
// hands plain data to these functions, so the tests can drive every rule.
import path from "node:path";
import ts from "typescript";

export const SCHEMA_VERSION = 1;
export const CONFIG_PATH = "quality/guardrails/config.json";
export const BASELINE_PATH = "quality/guardrails/baseline.json";

/**
 * The owner-approved policy (SCRUM-418 c21105) that the FIRST guardrail PR is
 * held to. On bootstrap the target has no config yet, so the PR's own config is
 * the only candidate; it may be tighter than this, never looser.
 */
export const BOOTSTRAP_POLICY = Object.freeze({
  maxLines: 600,
  productionRoots: ["app/", "apps/", "components/", "convex/", "dealer-worker/src/", "hooks/", "lib/", "packages/"],
  extensions: [".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"],
});

/** Migration/seed modules whose names predate the `convex/migrate*` convention. */
export const LEGACY_MIGRATIONS = Object.freeze([
  "convex/accountingMigration.ts",
  "convex/migrations.ts",
  "convex/seedDocuments.ts",
]);

export const RULES = Object.freeze({
  componentsNoConvexUtils: "components-no-convex-utils",
  domainsNoDoor: "domains-no-door",
  policyNoGeneratedServer: "policy-no-generated-server",
  policyNoReact: "policy-no-react",
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
  "nonDoors",
];
const JUSTIFIED_LISTS = ["exemptions", "generated", "migrations", "nonDoors"];

function assertKeys(doc, allowed, label) {
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

/** Parse and strictly validate config.json. Every list entry needs a reason. */
export function parseConfig(text, label) {
  const doc = JSON.parse(text);
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
  for (const listName of JUSTIFIED_LISTS) {
    const list = doc[listName];
    if (!Array.isArray(list)) throw new Error(`${label}.${listName}: must be an array.`);
    const seen = new Set();
    for (const entry of list) {
      assertKeys(entry, ["path", "reason"], `${label}.${listName} entry`);
      const entryPath = normalizeRepoPath(entry.path);
      if (entryPath !== entry.path) {
        throw new Error(`${label}.${listName}: "${entry.path}" is not canonical.`);
      }
      if (typeof entry.reason !== "string" || entry.reason.trim().length < 10) {
        throw new Error(`${label}.${listName}: "${entry.path}" needs a one-line justification.`);
      }
      if (seen.has(entry.path)) throw new Error(`${label}.${listName}: duplicate "${entry.path}".`);
      seen.add(entry.path);
    }
  }
  return doc;
}

export function importKey(violation) {
  return `${violation.rule}|${violation.from}|${violation.to}`;
}

/** Parse and strictly validate baseline.json. */
export function parseBaseline(text, label) {
  const doc = JSON.parse(text);
  assertKeys(doc, ["schemaVersion", "sourceCommit", "sizeCeilings", "importGrandfather"], label);
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${label}: schemaVersion must be ${SCHEMA_VERSION}.`);
  }
  if (!/^[0-9a-f]{40}$/u.test(doc.sourceCommit)) {
    throw new Error(`${label}: sourceCommit must be a full 40-character SHA.`);
  }
  const ceilings = doc.sizeCeilings;
  if (!ceilings || typeof ceilings !== "object" || Array.isArray(ceilings)) {
    throw new Error(`${label}.sizeCeilings: must be an object.`);
  }
  for (const [filePath, ceiling] of Object.entries(ceilings)) {
    normalizeRepoPath(filePath);
    if (!Number.isInteger(ceiling) || ceiling < 1) {
      throw new Error(`${label}.sizeCeilings["${filePath}"]: must be a positive integer.`);
    }
  }
  if (!Array.isArray(doc.importGrandfather)) {
    throw new Error(`${label}.importGrandfather: must be an array.`);
  }
  const keys = new Set();
  for (const entry of doc.importGrandfather) {
    assertKeys(entry, ["rule", "from", "to"], `${label}.importGrandfather entry`);
    if (!Object.values(RULES).includes(entry.rule)) {
      throw new Error(`${label}.importGrandfather: unknown rule "${entry.rule}".`);
    }
    const key = importKey(entry);
    if (keys.has(key)) throw new Error(`${label}.importGrandfather: duplicate ${key}.`);
    keys.add(key);
  }
  return doc;
}

export function canonicalJson(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ---------------------------------------------------------- classification

const TEST_LIKE = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)__tests__\//u,
  /(?:^|\/)__mocks__\//u,
  /(?:^|\/)__fixtures__\//u,
  /(?:^|\/)fixtures\//u,
];
const GENERATED_DIR = "convex/_generated/";
const MIGRATION_FILE = /^convex\/migrate[^/]*\.[cm]?[jt]s$/u;
const TOP_LEVEL_CONVEX_MODULE = /^convex\/[^/]+\.[cm]?[jt]sx?$/u;

export function isTestLike(repoPath) {
  return TEST_LIKE.some((pattern) => pattern.test(repoPath));
}

/** Independent discovery: what the lists MUST contain, found from the tree. */
export function discoverGenerated(inventory) {
  return inventory.filter((p) => p.startsWith(GENERATED_DIR));
}

export function discoverMigrations(inventory) {
  return inventory.filter((p) => MIGRATION_FILE.test(p) && !isTestLike(p));
}

const listPathCache = new WeakMap();

/** The set of paths in one justified list, built once per parsed config. */
function listPaths(config, listName) {
  let lists = listPathCache.get(config);
  if (!lists) listPathCache.set(config, (lists = new Map()));
  let paths = lists.get(listName);
  if (!paths) lists.set(listName, (paths = new Set(config[listName].map((entry) => entry.path))));
  return paths;
}

/**
 * "Production file" = a source extension from config.extensions, under one of
 * config.productionRoots, and not a test/fixture, not generated (config list or
 * convex/_generated/), not a listed migration/seed and not a listed exemption.
 * Returns the reason when it is not production, so reports can say why.
 */
export function classify(repoPath, config) {
  if (!config.extensions.some((ext) => repoPath.endsWith(ext))) return "not-source";
  if (!config.productionRoots.some((root) => repoPath.startsWith(root))) return "out-of-scope";
  if (isTestLike(repoPath)) return "test";
  if (repoPath.startsWith(GENERATED_DIR) || listPaths(config, "generated").has(repoPath)) {
    return "generated";
  }
  if (listPaths(config, "migrations").has(repoPath)) return "migration";
  if (listPaths(config, "exemptions").has(repoPath)) return "exempt";
  return "production";
}

// ------------------------------------------------------------------ counting

export function countNonBlank(text) {
  let count = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") count += 1;
  return count;
}

/**
 * Formatter-consistent size: format in memory with the TRUSTED Prettier options
 * (read from the target branch), then count non-blank lines. A file Prettier
 * cannot parse is counted unformatted and flagged — still deterministic.
 */
export async function measureLines(repoPath, rawText, prettierOptions, prettier) {
  const text = rawText.replaceAll("\r\n", "\n");
  try {
    const formatted = await prettier.format(text, { ...prettierOptions, filepath: repoPath });
    return { lines: countNonBlank(formatted), formatted: true };
  } catch {
    return { lines: countNonBlank(text), formatted: false };
  }
}

// ------------------------------------------------------------------- imports

const SOURCE_SUFFIX = /\.(?:d\.ts|[cm]?[jt]sx?)$/u;

/** Resolve one specifier to a repo module id (no extension, no /index). */
export function resolveSpecifier(fromPath, specifier) {
  let target;
  if (specifier.startsWith("@/")) target = path.posix.normalize(specifier.slice(2));
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  } else {
    return { kind: "package", id: specifier };
  }
  if (target === ".." || target.startsWith("../")) return { kind: "package", id: specifier };
  // A path into node_modules is that package, however it is spelled.
  const inModules = /(?:^|\/)node_modules\/(.+)$/u.exec(target);
  if (inModules) return { kind: "package", id: inModules[1] };
  target = target.replace(SOURCE_SUFFIX, "").replace(/\/index$/u, "");
  return { kind: "repo", id: target };
}

/** Every static import/export-from, dynamic import() and require(), via TS. */
export function importSpecifiers(sourceText) {
  const info = ts.preProcessFile(sourceText, true, true);
  return info.importedFiles.map((file) => file.fileName);
}

function stripExt(repoPath) {
  return repoPath.replace(SOURCE_SUFFIX, "");
}

/** A door is a top-level Convex module (convex/<name>.ts) not listed in nonDoors. */
function isDoor(moduleId, config) {
  if (!/^convex\/[^/]+$/u.test(moduleId)) return false;
  return !config.nonDoors.some((entry) => stripExt(entry.path) === moduleId);
}

const DOMAIN_SCOPE = /^convex\/domains\//u;
const POLICY_SCOPE = /^convex\/domains\/(?:[^/]+\/)*policy\//u;
const REACT_PACKAGE = /^react(?:-dom)?(?:\/|$)/u;

export function inImportScope(repoPath) {
  return (repoPath.startsWith("components/") || DOMAIN_SCOPE.test(repoPath)) &&
    !isTestLike(repoPath);
}

/** Import-boundary violations for one production file. */
export function importViolations(fromPath, sourceText, config) {
  if (!inImportScope(fromPath)) return [];
  const found = new Map();
  const add = (rule, to) => {
    const violation = { rule, from: fromPath, to };
    found.set(importKey(violation), violation);
  };
  for (const specifier of importSpecifiers(sourceText)) {
    const target = resolveSpecifier(fromPath, specifier);
    const repoId = target.kind === "repo" ? target.id : null;
    if (fromPath.startsWith("components/") && repoId &&
      (repoId === "convex/utils" || repoId.startsWith("convex/utils/"))) {
      add(RULES.componentsNoConvexUtils, repoId);
    }
    if (DOMAIN_SCOPE.test(fromPath) && repoId && isDoor(repoId, config)) {
      add(RULES.domainsNoDoor, repoId);
    }
    if (POLICY_SCOPE.test(fromPath)) {
      if (repoId === "convex/_generated/server") add(RULES.policyNoGeneratedServer, repoId);
      if (target.kind === "package" && REACT_PACKAGE.test(target.id)) {
        add(RULES.policyNoReact, target.id);
      }
    }
  }
  return [...found.values()];
}

export function sortViolations(violations) {
  return [...violations].sort((a, b) => compareCodeUnits(importKey(a), importKey(b)));
}

// ---------------------------------------------------------------- evaluation

/**
 * The baseline a measured tree implies. With a trusted baseline, nothing new is
 * grandfathered and existing ceilings only fall.
 */
export function buildBaseline(sourceCommit, config, measured, trustedBaseline) {
  const sizeCeilings = {};
  for (const [filePath, lines] of [...measured.counts].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (classify(filePath, config) !== "production" || lines <= config.maxLines) continue;
    const was = trustedBaseline?.sizeCeilings[filePath];
    if (trustedBaseline && was === undefined) continue; // a new oversized file is not grandfathered
    sizeCeilings[filePath] = was === undefined ? lines : Math.min(was, lines);
  }
  const allowed = trustedBaseline ? new Set(trustedBaseline.importGrandfather.map(importKey)) : null;
  const importGrandfather = measured.violations
    .filter((v) => !allowed || allowed.has(importKey(v)))
    .map(({ rule, from, to }) => ({ rule, from, to }));
  return { schemaVersion: SCHEMA_VERSION, sourceCommit, sizeCeilings, importGrandfather };
}

/**
 * Decide pass/fail.
 *  trusted  — {config, baseline} from the TARGET branch: the only allowance.
 *  proposed — {config, baseline} from the PR tree: the next target, so it is
 *             checked for completeness against disk and may only tighten.
 *  measured — {inventory: string[], counts: Map, violations: [...]} of the PR tree,
 *             plus targetInventory (paths on the target) and unchangedFromTarget
 *             (files whose text equals the target's).
 *  bootstrapPolicy — the pinned first-PR policy (defaults to BOOTSTRAP_POLICY).
 */
export function evaluate({ trusted, proposed, measured, bootstrap, bootstrapPolicy = BOOTSTRAP_POLICY }) {
  const errors = [];
  const notices = [];
  const inventory = new Set(measured.inventory);
  const { counts } = measured;
  const tMax = trusted.config.maxLines;

  // 1. File size against the trusted allowance. A file the PR brings into scope
  //    (production only under the proposed config) is held to the same limit;
  //    it may carry a new ceiling only when it is unchanged from the target.
  const adopted = new Set();
  for (const [filePath, lines] of [...counts].sort(([a], [b]) => compareCodeUnits(a, b))) {
    const trustedProduction = classify(filePath, trusted.config) === "production";
    if (!trustedProduction && classify(filePath, proposed.config) !== "production") continue;
    const ceiling = trusted.baseline.sizeCeilings[filePath];
    if (ceiling !== undefined) {
      if (lines > ceiling) {
        errors.push(`SIZE-GROWN ${filePath}: ${lines} lines > grandfathered ceiling ${ceiling}`);
      } else if (lines < ceiling) {
        notices.push(`ceiling can ratchet down: ${filePath} ${ceiling} -> ${lines}`);
      }
    } else if (lines > tMax) {
      const adoptable = !trustedProduction &&
        measured.unchangedFromTarget?.has(filePath) === true &&
        proposed.baseline.sizeCeilings[filePath] === lines;
      if (adoptable) {
        adopted.add(filePath);
        notices.push(`SCOPE-ADOPTED ${filePath}: ${lines} lines, unchanged from the target`);
      } else {
        errors.push(`SIZE-NEW ${filePath}: ${lines} lines > limit ${tMax} (not grandfathered)`);
      }
    }
  }

  // 2. Import boundaries against the trusted grandfather list.
  const trustedImports = new Set(trusted.baseline.importGrandfather.map(importKey));
  const currentImports = new Set(measured.violations.map(importKey));
  for (const violation of sortViolations(measured.violations)) {
    if (!trustedImports.has(importKey(violation))) {
      errors.push(`IMPORT-NEW [${violation.rule}] ${violation.from} -> ${violation.to}`);
    }
  }

  // 3. Proposed config/baseline must be complete and current against disk.
  for (const listName of JUSTIFIED_LISTS) {
    for (const entry of proposed.config[listName]) {
      if (!inventory.has(entry.path)) {
        errors.push(`STALE-ENTRY ${listName}: "${entry.path}" no longer exists — remove it`);
      }
    }
  }
  const listed = (name) => listPaths(proposed.config, name);
  for (const file of discoverGenerated(measured.inventory)) {
    if (!listed("generated").has(file)) {
      errors.push(`UNLISTED-GENERATED ${file}: add it to config.generated with a reason`);
    }
  }
  for (const file of discoverMigrations(measured.inventory)) {
    if (!listed("migrations").has(file)) {
      errors.push(`UNLISTED-MIGRATION ${file}: add it to config.migrations with a reason`);
    }
  }
  // Reverse direction: every listed entry must be what independent discovery says it is.
  for (const entry of proposed.config.generated) {
    if (!entry.path.startsWith(GENERATED_DIR)) {
      errors.push(`UNDISCOVERED-GENERATED ${entry.path}: not under ${GENERATED_DIR}`);
    }
  }
  for (const entry of proposed.config.migrations) {
    const discovered = MIGRATION_FILE.test(entry.path) && !isTestLike(entry.path);
    if (!discovered && !LEGACY_MIGRATIONS.includes(entry.path)) {
      errors.push(`UNDISCOVERED-MIGRATION ${entry.path}: not a convex/migrate* file or a pinned legacy migration`);
    }
  }
  for (const entry of proposed.config.nonDoors) {
    if (!TOP_LEVEL_CONVEX_MODULE.test(entry.path)) {
      errors.push(`INVALID-NONDOOR ${entry.path}: only a top-level convex/<module> can be a door`);
    }
  }
  const pMax = proposed.config.maxLines;
  for (const [filePath, lines] of counts) {
    if (lines <= pMax || classify(filePath, proposed.config) !== "production") continue;
    const kept = proposed.baseline.sizeCeilings[filePath] !== undefined;
    if (!kept && trusted.baseline.sizeCeilings[filePath] !== undefined) {
      errors.push(`MISSING-CEILING ${filePath}: ${lines} lines > ${pMax}; keep its ceiling until it shrinks`);
    }
  }
  for (const [filePath, ceiling] of Object.entries(proposed.baseline.sizeCeilings)) {
    const lines = counts.get(filePath);
    if (lines === undefined || classify(filePath, proposed.config) !== "production") {
      errors.push(`STALE-CEILING ${filePath}: not a measured production file — remove it`);
    } else if (lines <= pMax) {
      errors.push(`STALE-CEILING ${filePath}: ${lines} lines is within ${pMax} — remove it`);
    } else if (lines > ceiling) {
      errors.push(`CEILING-BELOW-CURRENT ${filePath}: ceiling ${ceiling} < ${lines} lines`);
    }
  }
  for (const entry of proposed.baseline.importGrandfather) {
    if (!currentImports.has(importKey(entry))) {
      errors.push(`STALE-GRANDFATHER [${entry.rule}] ${entry.from} -> ${entry.to}: no longer violates — remove it`);
    }
  }

  // 4. The proposed documents become the next target: they may only tighten.
  //    On bootstrap there is no target config, so the pinned policy stands in.
  if (bootstrap) bootstrapChecks(proposed, measured, bootstrapPolicy, errors);
  else ratchetChecks(trusted, proposed, adopted, errors, notices);
  return { errors, notices };
}

function bootstrapChecks(proposed, measured, policy, errors) {
  const p = proposed.config;
  if (p.maxLines > policy.maxLines) {
    errors.push(`BOOTSTRAP-POLICY maxLines ${p.maxLines} > pinned ${policy.maxLines}`);
  }
  for (const key of ["productionRoots", "extensions"]) {
    for (const value of policy[key]) {
      if (!p[key].includes(value)) errors.push(`BOOTSTRAP-POLICY ${key}: "${value}" missing`);
    }
  }
  // The first PR may only exclude files that already existed on the target.
  for (const listName of JUSTIFIED_LISTS) {
    for (const entry of p[listName]) {
      if (!measured.targetInventory?.has(entry.path)) {
        errors.push(`BOOTSTRAP-NEW-ALLOWANCE ${listName}: "${entry.path}" does not exist on the target`);
      }
    }
  }
}

function ratchetChecks(trusted, proposed, adopted, errors, notices) {
  const t = trusted.config;
  const p = proposed.config;
  if (p.maxLines > t.maxLines) {
    errors.push(`RATCHET maxLines raised ${t.maxLines} -> ${p.maxLines}`);
  }
  for (const key of ["productionRoots", "extensions"]) {
    for (const value of t[key]) {
      if (!p[key].includes(value)) errors.push(`RATCHET ${key}: "${value}" removed from scope`);
    }
  }
  for (const [filePath, ceiling] of Object.entries(proposed.baseline.sizeCeilings)) {
    const was = trusted.baseline.sizeCeilings[filePath];
    if (was === undefined && !adopted.has(filePath)) {
      errors.push(`RATCHET new size ceiling for ${filePath} (ceilings only decrease)`);
    }
    else if (ceiling > was) errors.push(`RATCHET ceiling raised for ${filePath}: ${was} -> ${ceiling}`);
  }
  const trustedImports = new Set(trusted.baseline.importGrandfather.map(importKey));
  for (const entry of proposed.baseline.importGrandfather) {
    if (!trustedImports.has(importKey(entry))) {
      errors.push(`RATCHET new grandfathered import ${importKey(entry)}`);
    }
  }
  for (const listName of JUSTIFIED_LISTS) {
    const before = listPaths(t, listName);
    for (const entry of p[listName]) {
      if (!before.has(entry.path)) {
        notices.push(`ALLOWANCE-CHANGE ${listName} + "${entry.path}" — not effective until merged; needs review`);
      }
    }
  }
}
