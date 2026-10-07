/**
 * Regression-library scenario records and their truthfulness validators
 * (SCRUM-761 S1, implements SCRUM-760 R1/R2/R4).
 *
 * A scenario is a plain-JSON record under `regression/scenarios/`. This module
 * only DEFINES and VALIDATES the library; it runs no scenario. Two rules shape
 * it:
 *
 *   - A scenario that cannot be tied to its executable check, or whose owner
 *     ruling has moved, is a FAILURE here, never a warning (R4).
 *   - `regression/rulings.json` is public: ruling comment id, digest and date
 *     only. Ruling text and customer data never enter the repo (owner ruling
 *     2026-10-07, SCRUM-761).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const SCENARIO_DOMAINS = ["money", "permission", "tenancy", "screen"] as const;
export const SCENARIO_LEVELS = ["backend", "cloud", "browser"] as const;
export const SCENARIO_STATUSES = ["candidate", "active", "retired"] as const;
export const SCENARIO_HUNTERS = ["scripted", "audit", "explorer"] as const;

export type ScenarioDomain = (typeof SCENARIO_DOMAINS)[number];
export type ScenarioLevel = (typeof SCENARIO_LEVELS)[number];
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

export interface ScenarioStep {
  actor: { role: string; org: string };
  /** Public API function name, or UI route + control. */
  action: string;
  input: Record<string, unknown>;
}

export interface ScenarioExpectation {
  /** Economic state / permission outcome / UI state. Never a bare HTTP status. */
  observable: string;
  value: unknown;
}

export interface RulingRef {
  /** e.g. "SCRUM-407#c21031" */
  id: string;
  digest: string;
}

export interface ScenarioRecord {
  id: string;
  fingerprint: string;
  domain: ScenarioDomain;
  level: ScenarioLevel;
  status: ScenarioStatus;
  source: { hunter: (typeof SCENARIO_HUNTERS)[number]; runId: string; firstSeen: string };
  steps: ScenarioStep[];
  expected: ScenarioExpectation[];
  rulings: RulingRef[];
  /** Executable check for backend/cloud scenarios. Browser records ARE the test. */
  impl?: { file: string; testName: string };
  /** SCRUM-486 certification-matrix row, for money scenarios. */
  matrixRow?: string;
  bugRef?: { key: string; failingFirst: string };
  retiredReason?: string;
  retiredByRuling?: string;
  invariantIds?: string[];
  sourceGlobs?: string[];
}

export interface RulingSnapshotEntry {
  id: string;
  digest: string;
  date: string;
}

export interface LibraryProblem {
  scenario: string;
  rule: string;
  message: string;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{2,80}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RULING_ID = /^SCRUM-\d+#c\d+$/;
const ID_TOKEN = /^(?:[a-z0-9]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const RUN_SUFFIX = /-\d{6,}$/;

function normaliseValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (ID_TOKEN.test(value)) return "<id>";
    if (ISO_TS.test(value)) return "<ts>";
    return value.replace(RUN_SUFFIX, "");
  }
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normaliseValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * sha256 over (domain, steps, expected) with ids, timestamps and per-run
 * suffixes normalised away. Two explorer paths that reduce to the same tuple are
 * one scenario (R1 de-duplication). Inputs that differ in a way that matters
 * (amounts, roles, methods) stay different.
 */
export function scenarioFingerprint(
  record: Pick<ScenarioRecord, "domain" | "steps" | "expected">,
): string {
  const canonical = JSON.stringify(
    normaliseValue({ domain: record.domain, steps: record.steps, expected: record.expected }),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function digestRulingText(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

export function validateRulingSnapshot(snapshot: unknown): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const add = (scenario: string, message: string) =>
    problems.push({ scenario, rule: "ruling-snapshot", message });
  if (!Array.isArray(snapshot)) return [{ scenario: "rulings.json", rule: "ruling-snapshot", message: "must be an array" }];
  const seen = new Set<string>();
  for (const entry of snapshot as Record<string, unknown>[]) {
    const id = String(entry?.id);
    if (typeof entry?.id !== "string" || !RULING_ID.test(entry.id)) add(id, "id must look like SCRUM-123#c4567");
    if (seen.has(id)) add(id, "duplicate ruling id");
    seen.add(id);
    if (typeof entry?.digest !== "string" || !SHA256.test(entry.digest)) add(id, "digest must be a sha256 hex string");
    if (typeof entry?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) add(id, "date must be YYYY-MM-DD");
    // Public repository: ids, digests and dates only.
    const extra = Object.keys(entry ?? {}).filter((k) => !["id", "digest", "date"].includes(k));
    if (extra.length > 0) add(id, `forbidden field(s) ${extra.join(", ")}: the snapshot is ids, digests and dates only`);
  }
  return problems;
}

export interface ValidateLibraryOptions {
  rulings: RulingSnapshotEntry[];
  /** Repo root used to resolve `impl.file`. */
  repoRoot: string;
}

const SKIP_MARKER = /\b(?:it|test|describe)\.(?:skip|fixme|todo)\b|\bxit\(|\bxdescribe\(/;

export function validateLibrary(
  records: ScenarioRecord[],
  { rulings, repoRoot }: ValidateLibraryOptions,
): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const rulingById = new Map(rulings.map((r) => [r.id, r]));
  const ids = new Set<string>();
  const fingerprints = new Map<string, string>();

  for (const r of records) {
    const add = (rule: string, message: string) => problems.push({ scenario: r.id ?? "<no id>", rule, message });

    if (typeof r.id !== "string" || !SLUG.test(r.id)) add("schema", "id must be a lowercase slug");
    if (ids.has(r.id)) add("schema", "duplicate scenario id");
    ids.add(r.id);
    if (!SCENARIO_DOMAINS.includes(r.domain)) add("schema", `domain must be one of ${SCENARIO_DOMAINS.join("|")}`);
    if (!SCENARIO_LEVELS.includes(r.level)) add("schema", `level must be one of ${SCENARIO_LEVELS.join("|")}`);
    if (!SCENARIO_STATUSES.includes(r.status)) add("schema", `status must be one of ${SCENARIO_STATUSES.join("|")}`);
    if (!SCENARIO_HUNTERS.includes(r.source?.hunter)) add("schema", "source.hunter must be scripted|audit|explorer");
    if (!Array.isArray(r.steps) || r.steps.length === 0) add("schema", "steps must be a non-empty array");
    if (!Array.isArray(r.expected) || r.expected.length === 0) add("schema", "expected must be a non-empty array");
    if (!Array.isArray(r.rulings) || r.rulings.length === 0) {
      add("ruling", "a scenario must cite the owner ruling or business rule it checks (R4)");
    }
    if (problems.some((p) => p.scenario === r.id && p.rule === "schema")) continue;

    // R1 de-duplication: stored fingerprint must be the real one, and unique.
    const actual = scenarioFingerprint(r);
    if (r.fingerprint !== actual) add("fingerprint", `stored fingerprint does not match the record (expected ${actual})`);
    const clash = fingerprints.get(actual);
    if (clash !== undefined) add("duplicate", `same fingerprint as ${clash}; merge the explorer path into one record`);
    else fingerprints.set(actual, r.id);

    // A bare HTTP status is not an economic observable.
    for (const e of r.expected) {
      if (/^(?:http\s*)?(?:status)(?:\s*code)?$|^http$/i.test(String(e.observable).trim())) {
        add("expected", "expected observable is a bare HTTP status; assert the stored state instead");
      }
    }

    // R4 ruling drift: every cited ruling must exist in the snapshot at the digest recorded.
    for (const ref of r.rulings ?? []) {
      const snap = rulingById.get(ref.id);
      if (!snap) add("ruling", `ruling ${ref.id} is not in regression/rulings.json`);
      else if (snap.digest !== ref.digest) {
        add("ruling-drift", `ruling ${ref.id} changed since this scenario was written; update the scenario in the same change`);
      }
    }

    if (r.status === "retired") {
      if (!r.retiredReason?.trim()) add("retired", "a retired scenario needs retiredReason (R4: never left red and ignored)");
      if (!r.retiredByRuling || !RULING_ID.test(r.retiredByRuling)) add("retired", "a retired scenario needs retiredByRuling");
      continue;
    }

    if (r.bugRef) {
      if (!COMMIT_SHA.test(r.bugRef.failingFirst ?? "")) add("bug", "bugRef.failingFirst must be the 40-char sha where the test was red");
      if (!/^SCRUM-\d+$/.test(r.bugRef.key ?? "")) add("bug", "bugRef.key must be a SCRUM key");
    }

    if (r.status !== "active") continue; // candidate: counted and reported, not yet executable

    if (r.level === "browser") {
      if (r.domain !== "screen") add("level", "only screen scenarios convert to a browser replay (R2)");
    } else {
      if (!r.impl?.file || !r.impl?.testName) {
        add("impl", "an active backend/cloud scenario must name its executable check (impl.file + impl.testName)");
      } else {
        const abs = path.join(repoRoot, r.impl.file);
        if (!existsSync(abs)) add("impl", `impl.file ${r.impl.file} does not exist: cannot-run is a failure`);
        else {
          const text = readFileSync(abs, "utf8");
          if (!text.includes(r.impl.testName)) add("impl", `impl.testName not found in ${r.impl.file}`);
          if (SKIP_MARKER.test(text)) add("skip", `${r.impl.file} contains a skipped/fixme/todo test: a skip is a failure in the library (R4)`);
        }
      }
    }
    if (r.domain === "money" && !r.matrixRow) add("matrix", "an active money scenario needs a SCRUM-486 matrixRow (R2)");
  }
  return problems;
}

export interface LibraryReport {
  total: number;
  byDomainLevelStatus: Record<string, number>;
  candidatesPending: number;
}

/** Counts by (domain, level, status) - never a bare "N passed" (R4 coverage honesty). */
export function summariseLibrary(records: ScenarioRecord[]): LibraryReport {
  const by: Record<string, number> = {};
  for (const r of records) {
    const key = `${r.domain}/${r.level}/${r.status}`;
    by[key] = (by[key] ?? 0) + 1;
  }
  return {
    total: records.length,
    byDomainLevelStatus: by,
    candidatesPending: records.filter((r) => r.status === "candidate").length,
  };
}

function collectScenarioFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectScenarioFiles(full));
    else if (name.endsWith(".scenario.json")) out.push(full);
  }
  return out.sort();
}

export function loadLibrary(repoRoot: string): {
  records: ScenarioRecord[];
  rulings: RulingSnapshotEntry[];
  problems: LibraryProblem[];
} {
  const problems: LibraryProblem[] = [];
  const rulingsPath = path.join(repoRoot, "regression", "rulings.json");
  let rulings: RulingSnapshotEntry[] = [];
  if (!existsSync(rulingsPath)) {
    problems.push({ scenario: "rulings.json", rule: "ruling-snapshot", message: "regression/rulings.json is missing" });
  } else {
    const parsed: unknown = JSON.parse(readFileSync(rulingsPath, "utf8"));
    problems.push(...validateRulingSnapshot(parsed));
    if (Array.isArray(parsed)) rulings = parsed as RulingSnapshotEntry[];
  }
  const records: ScenarioRecord[] = [];
  for (const file of collectScenarioFiles(path.join(repoRoot, "regression", "scenarios"))) {
    try {
      records.push(JSON.parse(readFileSync(file, "utf8")) as ScenarioRecord);
    } catch {
      problems.push({ scenario: path.relative(repoRoot, file), rule: "schema", message: "not valid JSON" });
    }
  }
  return { records, rulings, problems };
}
