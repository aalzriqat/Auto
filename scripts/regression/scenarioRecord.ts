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
import ts from "typescript";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";

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
  candidateReason?: string;
  candidateIssue?: string;
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
const ID_TOKEN = /^(?:[a-z0-9]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|user_[A-Za-z0-9]{6,}|org_[A-Za-z0-9]{6,})$/;
const ISO_TS = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}.*$/;
// Epoch-style per-run suffix only (10+ digits): cheque/invoice numbers and amounts stay significant.
const RUN_SUFFIX = /(?<=[A-Za-z])-\d{10,}$/;
// A leading zero ("000123") is an identifier, not an amount: it must not collapse into 123.
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function normaliseValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (ID_TOKEN.test(value)) return "<id>";
    // Keep the DATE (a period boundary matters); drop only the time of day.
    if (ISO_TS.test(value)) return value.replace(ISO_TS, "$1T<time>");
    // "12000" and 12000 are the same input.
    if (NUMERIC.test(value)) return Number(value);
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
    normaliseValue({
      domain: record.domain,
      steps: record.steps,
      // Assertion order is not part of the scenario.
      expected: [...record.expected]
        .map((e) => normaliseValue(e))
        .sort((a, b) => {
          const x = JSON.stringify(a);
          const y = JSON.stringify(b);
          return x < y ? -1 : x > y ? 1 : 0; // code-point order: locale-independent
        }),
    }),
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

const CTX_SKIP = /\b(?:ctx|context|t)\.skip\s*\(/;
// Conservative, file-wide: any skip/conditional/todo/fails marker anywhere in the check file fails the record.
const ANY_SKIP = /\b(?:it|test|describe|suite)(?:\.\w+)*\.(?:skip|skipIf|runIf|todo|fails|fixme)\b|\bx(?:it|describe)\(|\{\s*(?:skip|todo|fails|fixme)\s*:\s*(?!false\b)/;
// What a configured runner actually collects: root vitest includes **/*.test.ts(x); the browser
// replays live under playwright/ as *.spec.ts. Anything else exists but is never run.
// Playwright testDirs: tests (PR-cadence config) and scenarios (the manual scenarios config); fixtures/visual are not replays.
const RUNNER_FILE = /(?:^playwright\/(?:tests|scenarios)\/(?:.*\/)?[^/]+\.spec\.ts$)|(?:\.test\.tsx?$)/;
// Mirrors vitest.config.ts `exclude`: those trees are never collected by the root run.
// Receiver-agnostic skip/expected-fail calls, `{ skip }` option keys (quoted, shorthand, any position), `.only`.
// Static analysis is best-effort: indirection (options in a variable) can still beat it; the S3 runner census is the binding proof.
const SKIP_CALL = /\.\s*(?:skip|fixme|fail|fails|todo|skipIf|runIf|only)\s*\(|\bskip\s*\(/;
const SKIP_OPTION = /[{,]\s*["']?(?:skip|todo|fails|fail|fixme)["']?\s*(?::\s*(?!false\b)|[,}])/;
const PLAYWRIGHT_SPEC = /^playwright\/(?:tests|scenarios)\/(?:.*\/)?[^/]+\.spec\.ts$/;
const NOT_RUN_DIRS = /^(?:apps|packages|\.next|out|build)\/|(?:^|\/)(?:node_modules|\.claude)\//;
const MATRIX_ROW = /^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+|\b00|\b0)\d[\d\s-]{7,}\d/;
const MAX_TEXT = 300;
const MAX_PATH = 200;
const TOKEN_PATH = /^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/;
const KEY_TOKEN = /^[A-Za-z_][\w.:-]{0,59}$/;
const IMPL_PATH = /^[\w./-]{1,200}$/;
const VALUE_TOKEN = /^[\w.:+\/@#-]{1,60}$/;
const SCRUM_KEY = /^SCRUM-\d+$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const INVARIANT_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const GLOB = /^[\w./*{}\[\],-]{1,120}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const RECORD_KEYS = new Set([
  "id", "fingerprint", "domain", "level", "status", "source", "steps", "expected", "rulings",
  "impl", "matrixRow", "bugRef", "candidateReason", "candidateIssue", "retiredReason",
  "retiredByRuling", "invariantIds", "sourceGlobs",
]);
const STEP_KEYS = new Set(["actor", "action", "input"]);
const ACTOR_KEYS = new Set(["role", "org"]);
const RULING_REF_KEYS = new Set(["id", "digest"]);
const EXPECTED_KEYS = new Set(["observable", "value"]);
const SOURCE_KEYS = new Set(["hunter", "runId", "firstSeen"]);
const IMPL_KEYS = new Set(["file", "testName"]);
const BUGREF_KEYS = new Set(["key", "failingFirst"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function unknownKeys(value: unknown, allowed: Set<string>): string[] {
  return isObject(value) ? Object.keys(value).filter((k) => !allowed.has(k)) : [];
}

function* keysIn(value: unknown): Generator<string> {
  if (Array.isArray(value)) for (const v of value) yield* keysIn(v);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) { yield k; yield* keysIn(v); }
}

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v);
  else if (isObject(value)) for (const v of Object.values(value)) yield* stringsIn(v);
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".mjs") || file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Shape problems only; returns an empty list when the record is safe to hand to
 * the semantic rules. Never throws on a malformed record.
 */
function schemaProblems(r: unknown): string[] {
  if (!isObject(r)) return ["record must be an object"];
  const out: string[] = [];
  if (typeof r.id !== "string" || !SLUG.test(r.id)) out.push("id must be a lowercase slug");
  if (!SCENARIO_DOMAINS.includes(r.domain as ScenarioDomain)) out.push(`domain must be one of ${SCENARIO_DOMAINS.join("|")}`);
  if (!SCENARIO_LEVELS.includes(r.level as ScenarioLevel)) out.push(`level must be one of ${SCENARIO_LEVELS.join("|")}`);
  if (!SCENARIO_STATUSES.includes(r.status as ScenarioStatus)) out.push(`status must be one of ${SCENARIO_STATUSES.join("|")}`);
  if (!isObject(r.source) || !(SCENARIO_HUNTERS as readonly string[]).includes(String(r.source.hunter))) {
    out.push("source.hunter must be scripted|audit|explorer");
  }
  if (!Array.isArray(r.steps) || r.steps.length === 0) out.push("steps must be a non-empty array");
  else {
    for (const s of r.steps) {
      if (!isObject(s) || !isObject(s.actor) || !isText(s.actor.role) || !isText(s.actor.org) || !isText(s.action) || !isObject(s.input)) {
        out.push("every step needs actor{role,org}, action and input");
        break;
      }
    }
  }
  if (!Array.isArray(r.expected) || r.expected.length === 0) out.push("expected must be a non-empty array");
  else {
    for (const e of r.expected) {
      if (!isObject(e) || !isText(e.observable) || !("value" in e)) {
        out.push("every expectation needs a non-empty observable and a value");
        break;
      }
    }
  }
  if (!Array.isArray(r.rulings) || r.rulings.length === 0) {
    out.push("a scenario must cite the owner ruling or business rule it checks (R4)");
  } else if (r.rulings.some((x) => !isObject(x) || !isText(x.id) || !isText(x.digest))) {
    out.push("every ruling ref needs id and digest");
  }
  // Closed schema: the public repo must not collect free-form notes (ruling text, customer data).
  const extra = [
    ...unknownKeys(r, RECORD_KEYS),
    ...(Array.isArray(r.steps) ? r.steps.flatMap((s) => unknownKeys(s, STEP_KEYS)) : []),
    ...(Array.isArray(r.expected) ? r.expected.flatMap((e) => unknownKeys(e, EXPECTED_KEYS)) : []),
    ...(Array.isArray(r.steps) ? r.steps.flatMap((s) => unknownKeys(isObject(s) ? s.actor : undefined, ACTOR_KEYS)) : []),
    ...(Array.isArray(r.rulings) ? r.rulings.flatMap((x) => unknownKeys(x, RULING_REF_KEYS)) : []),
    ...unknownKeys(r.source, SOURCE_KEYS),
    ...unknownKeys(r.impl, IMPL_KEYS),
    ...unknownKeys(r.bugRef, BUGREF_KEYS),
  ];
  if (extra.length > 0) out.push(`unknown field(s) ${[...new Set(extra)].join(", ")}: records are a closed schema (no free-form notes)`);
  // Closed VALUE formats for every metadata field a public record carries.
  if (Array.isArray(r.rulings) && r.rulings.some((x) => isObject(x) && (!RULING_ID.test(String(x.id)) || !SHA256.test(String(x.digest))))) {
    out.push("ruling refs must be {id: SCRUM-n#cN, digest: sha256 hex}");
  }
  if (Array.isArray(r.steps) && r.steps.some((s) => isObject(s) && isObject(s.actor) && (!TOKEN.test(String(s.actor.role)) || !TOKEN.test(String(s.actor.org))))) {
    out.push("actor role/org must be short identifier tokens");
  }
  if (isObject(r.source) && (typeof r.source.runId !== "string" || !TOKEN.test(r.source.runId) || typeof r.source.firstSeen !== "string" || !DATE.test(r.source.firstSeen))) {
    out.push("source.runId must be an identifier token and source.firstSeen a YYYY-MM-DD date");
  }
  if (r.invariantIds !== undefined && (!Array.isArray(r.invariantIds) || r.invariantIds.some((v) => !INVARIANT_ID.test(String(v))))) {
    out.push("invariantIds must be invariant ids such as ECON-1");
  }
  if (r.sourceGlobs !== undefined && (!Array.isArray(r.sourceGlobs) || r.sourceGlobs.some((v) => !GLOB.test(String(v))))) {
    out.push("sourceGlobs must be path globs without spaces");
  }
  // Metadata formats hold whatever the status: a malformed value must not wait for a status flip to be seen.
  if (r.matrixRow !== undefined && (typeof r.matrixRow !== "string" || !MATRIX_ROW.test(r.matrixRow))) out.push("matrixRow has an invalid format");
  if (r.candidateIssue !== undefined && (typeof r.candidateIssue !== "string" || !SCRUM_KEY.test(r.candidateIssue))) out.push("candidateIssue must be a SCRUM key");
  if (r.retiredByRuling !== undefined && (typeof r.retiredByRuling !== "string" || !RULING_ID.test(r.retiredByRuling))) out.push("retiredByRuling must look like SCRUM-123#c4567");
  if (isObject(r.impl) && ((r.impl.file !== undefined && (typeof r.impl.file !== "string" || r.impl.file.length > MAX_PATH)) || (r.impl.testName !== undefined && (typeof r.impl.testName !== "string" || r.impl.testName.length > MAX_TEXT)))) {
    out.push(`impl.file is capped at ${MAX_PATH} and impl.testName at ${MAX_TEXT} characters`);
  }
  if (isObject(r.impl) && typeof r.impl.file === "string" && !IMPL_PATH.test(r.impl.file)) out.push("impl.file must be a plain repo path");
  for (const text of [r.retiredReason, r.candidateReason]) {
    if (text !== undefined && typeof text !== "string") out.push("reasons must be text");
    if (typeof text === "string" && text.length > MAX_TEXT) out.push(`reason text is capped at ${MAX_TEXT} characters`);
  }
  // Public repository: names, actions and observables are tokens, and any string inside input/value is a
  // short space-free token. Prose cannot ride in a step. (Not a guarantee a token is not a name: a human
  // reviews the PR; see regression/README.md.)
  if (Array.isArray(r.steps) && r.steps.some((s) => isObject(s) && (!TOKEN_PATH.test(String(s.action)) || [...stringsIn(s.input)].some((v) => !VALUE_TOKEN.test(v)) || [...keysIn(s.input)].some((k) => !KEY_TOKEN.test(k))))) {
    out.push("step action must be a dotted token (deals.approve) and input strings short space-free tokens; no prose");
  }
  if (Array.isArray(r.expected) && r.expected.some((e) => isObject(e) && (!TOKEN_PATH.test(String(e.observable)) || [...stringsIn(e.value)].some((v) => !VALUE_TOKEN.test(v)) || [...keysIn(e.value)].some((k) => !KEY_TOKEN.test(k))))) {
    out.push("expected observable must be a dotted token (deal.status) and value strings short space-free tokens; no prose");
  }
  // Heuristic only (not a guarantee): obvious emails / phone numbers in any text field.
  for (const s of stringsIn([r.steps, r.expected, r.retiredReason, r.candidateReason, isObject(r.impl) ? r.impl.testName : undefined])) {
    if (EMAIL.test(s) || PHONE.test(s)) {
      out.push("a text value looks like an email address or phone number; the repository is public");
      break;
    }
  }
  return out;
}

export function validateLibrary(
  records: ScenarioRecord[],
  { rulings, repoRoot }: ValidateLibraryOptions,
): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const rulingById = new Map(rulings.filter(isObject).map((r) => [r.id, r]));
  const ids = new Set<string>();
  const fingerprints = new Map<string, string>();
  const bindings = new Map<string, string>();

  for (const r of records) {
    const label = isObject(r) && typeof r.id === "string" ? r.id : "<no id>";
    const add = (rule: string, message: string) => problems.push({ scenario: label, rule, message });

    const shape = schemaProblems(r);
    for (const message of shape) add("schema", message);
    if (shape.length > 0) continue;
    if (ids.has(r.id)) add("schema", "duplicate scenario id");
    ids.add(r.id);

    // R1 de-duplication: stored fingerprint must be the real one, and unique.
    const actual = scenarioFingerprint(r);
    if (r.fingerprint !== actual) add("fingerprint", `stored fingerprint does not match the record (expected ${actual})`);
    const clash = fingerprints.get(actual);
    if (clash !== undefined) add("duplicate", `same fingerprint as ${clash}; merge the explorer path into one record`);
    else fingerprints.set(actual, r.id);

    // A bare HTTP status is not an economic observable.
    for (const e of r.expected) {
      if (/^(?:(?:response|res|http)[._ ]?)?status(?:[._ ]?code)?$|^http(?:\s*\d{3})?$/i.test(String(e.observable).trim())) {
        add("expected", "expected observable is a bare HTTP status; assert the stored state instead");
      }
    }

    // R4 ruling drift: every cited ruling must exist in the snapshot at the digest recorded.
    for (const ref of r.rulings) {
      const snap = rulingById.get(ref.id);
      if (!snap) add("ruling", `ruling ${ref.id} is not in regression/rulings.json`);
      else if (snap.digest !== ref.digest) {
        add("ruling-drift", `ruling ${ref.id} changed since this scenario was written; update the scenario in the same change`);
      }
    }

    if (r.bugRef) {
      if (!COMMIT_SHA.test(r.bugRef.failingFirst ?? "")) add("bug", "bugRef.failingFirst must be the 40-char sha where the test was red");
      if (!/^SCRUM-\d+$/.test(r.bugRef.key ?? "")) add("bug", "bugRef.key must be a SCRUM key");
    }

    if (r.status === "retired") {
      if (!r.retiredReason?.trim()) add("retired", "a retired scenario needs retiredReason (R4: never left red and ignored)");
      if (!r.retiredByRuling || !RULING_ID.test(r.retiredByRuling)) add("retired", "a retired scenario needs retiredByRuling");
      else if (!rulingById.has(r.retiredByRuling)) add("retired", `retiredByRuling ${r.retiredByRuling} is not in regression/rulings.json`);
      continue;
    }

    if (r.status === "candidate") {
      // Demoting a red scenario to candidate must not be a free way to turn the library green.
      if (!r.candidateReason?.trim()) add("candidate", "a candidate needs candidateReason");
      if (!r.candidateIssue || !/^SCRUM-\d+$/.test(r.candidateIssue)) add("candidate", "a candidate needs candidateIssue (the SCRUM key tracking its promotion)");
      continue; // reported and counted, not yet executable
    }

    // active: every level, browser replays included, must name the check that runs it.
    if (r.level === "cloud") add("level", "no cloud runner exists yet (SCRUM-762): park it as a candidate with that issue instead of counting it active");
    if (r.level === "browser" && r.domain !== "screen") add("level", "only screen scenarios convert to a browser replay (R2)");
    if (!r.impl?.file || !r.impl?.testName?.trim()) {
      add("impl", "an active scenario must name its executable check (impl.file + impl.testName)");
    } else {
      const abs = path.resolve(repoRoot, r.impl.file.replace(/\\/g, "/"));
      // Classify the NORMALISED repo-relative path: "scripts/../apps/x.test.ts" is apps/.
      const rel = path.relative(path.resolve(repoRoot), abs).replace(/\\/g, "/");
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) add("impl", "impl.file must stay inside the repository");
      else if (!RUNNER_FILE.test(rel) || NOT_RUN_DIRS.test(rel) || PLAYWRIGHT_SPEC.test(rel) !== (r.level === "browser")) {
        add("impl", `impl.file ${rel} is not a test/spec file a runner executes`);
      } else if (!existsSync(abs)) add("impl", `impl.file ${rel} does not exist: cannot-run is a failure`);
      else {
        const text = readFileSync(abs, "utf8");
        // Same AST rules as the invariant proof markers: exactly one ACTIVE it/test whose title
        // names the scenario; skip/skipIf/runIf/todo/only/fails or a skipped parent describe all fail.
        // Playwright groups with test.describe(...); the shared AST helper only knows describe(...).
        const forHelper = text.replace(/\b(?:test|it)\.describe(?:\.(?:serial|parallel))?(?=\s*\()/g, "describe");
        // Exactly one active, NON-parameterized registration: test.each([]) names a case that never runs.
        const bindKey = `${rel}::${r.impl.testName}`;
        const sharedWith = bindings.get(bindKey);
        if (sharedWith !== undefined) add("impl", `same impl.file + testName as ${sharedWith}: one check cannot stand for two scenarios`);
        else bindings.set(bindKey, r.id);
        const named = listActiveTestRegistrations(forHelper, scriptKindFor(rel)).filter((t) => t.title.includes(r.impl!.testName));
        if (named.length !== 1 || named[0].parameterized || CTX_SKIP.test(text) || ANY_SKIP.test(text) || SKIP_CALL.test(text) || SKIP_OPTION.test(text)) {
          add("skip", `${rel} has no single active test named "${r.impl.testName}" (skipped, conditional, duplicated or absent): a skip is a failure in the library (R4)`);
        }
      }
    }
    if (r.domain !== "screen" && !r.matrixRow) {
      add("matrix", `an active ${r.domain} scenario needs a SCRUM-486 matrixRow (R2)`);
    }
  }
  return problems;
}
/**
 * Diff rule between the merge-base library and the head library (wired into a PR
 * job in S3): an active scenario may only leave `active` by being retired with
 * a reason and a ruling. Demoting it to candidate, or deleting its record, would
 * turn a red library green without anyone ruling on it (R4).
 */
export function validateTransitions(base: ScenarioRecord[], head: ScenarioRecord[]): LibraryProblem[] {
  const problems: LibraryProblem[] = [];
  const headById = new Map(head.filter(isObject).map((r) => [r.id, r]));
  for (const before of base) {
    if (!isObject(before) || before.status !== "active") continue;
    const after = headById.get(before.id);
    if (after === undefined) {
      problems.push({ scenario: before.id, rule: "transition", message: "an active scenario was deleted; retire it with a reason and a ruling instead" });
    } else if (after.status === "candidate") {
      problems.push({ scenario: before.id, rule: "transition", message: "an active scenario was demoted to candidate; only retirement (reason + ruling) may remove it from execution" });
    }
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

function collectScenarioFiles(dir: string, stray: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectScenarioFiles(full, stray));
    else if (name.endsWith(".scenario.json")) out.push(full);
    else if (name !== ".gitkeep") stray.push(full);
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
  const stray: string[] = [];
  const files = collectScenarioFiles(path.join(repoRoot, "regression", "scenarios"), stray);
  for (const file of stray) {
    problems.push({ scenario: path.relative(repoRoot, file), rule: "schema", message: "not a *.scenario.json file: it would be neither validated nor run" });
  }
  for (const file of files) {
    try {
      records.push(JSON.parse(readFileSync(file, "utf8")) as ScenarioRecord);
    } catch {
      problems.push({ scenario: path.relative(repoRoot, file), rule: "schema", message: "not valid JSON" });
    }
  }
  return { records, rulings, problems };
}
