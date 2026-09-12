/**
 * Zero-state verification of a Convex deployment — the pure decisions.
 *
 * The launch of the fresh production deployment (SCRUM-231 / SCRUM-313 B4) has
 * one checkpoint that no existing tool answers: AFTER the code and schema are
 * pushed and BEFORE any organization, chart, period or financial write, is the
 * deployment empty — every table, every component, the file store — and is it
 * the deployment we meant, and not a promoted E2E preview?
 *
 * Everything here is a pure function of CLI output, so the fail-closed rules
 * are testable without a deployment. `verifyZeroState.mjs` is the thin shell
 * that runs the CLI and feeds this.
 *
 * ## The rules, and the trap each one closes
 *
 * · **Only LISTED tables are read.** `convex data <table>` on a table that does
 *   not exist prints exactly what an empty table prints ("There are no
 *   documents in this table."), verified on a real preview. A hand-picked
 *   table list would therefore certify a misspelled table as empty. The scope
 *   is the deployment's own table listing plus each mounted component's
 *   listing — dynamic, never a literal list.
 * · **Unreadable is not zero.** A non-zero exit, or output that is neither
 *   the empty-table sentence nor a document table, is UNREADABLE and fails the
 *   verdict. A denied read must not pass as an empty one. (The CLI prints the
 *   empty-table sentence on STDERR and documents on STDOUT — verified on a
 *   real preview — so both streams are classified and neither is echoed.)
 * · **Post-deploy, missing expected metadata is a failure.** The deployed
 *   schema's tables must all be listed and functions must exist; zero
 *   functions after a push means the push did not land, not that the data is
 *   clean. Pre-deploy, the same absence is INFRASTRUCTURE evidence only and is
 *   labelled as such — it says nothing about a schema that is not there yet.
 * · **Identity is read back three ways** where available: the credential's
 *   own `prod:<name>|` prefix, the deployment URL the function metadata
 *   reports, and the name the deployment answers for itself. Any disagreement
 *   with the expected name fails.
 * · **The E2E marker is read in three states, and only one of them passes.**
 *   `AUTOFLOW_DEPLOYMENT_CLASS=preview` is what every preview carries and what
 *   the E2E bootstrap requires; production and dev carry NO value. The read is
 *   PRESENT (a value came back — fails, whatever the value), VERIFIED_ABSENT
 *   (the CLI's own not-found sentence, which also names the deployment it
 *   looked at — the only pass), or UNREADABLE (non-zero exit, timeout, silence,
 *   any other shape — fails). `convex env get` exits 0 for a missing variable,
 *   so exit status alone cannot tell absence from anything (verified on a real
 *   deployment, 2026-09-12); a failed read must never pass as an absent marker.
 *   The `e2ePreviewBootstrap` table is covered by the table walk.
 * · **Scheduled functions are informational.** Crons are scheduled the moment
 *   code is deployed, so `_scheduled_functions` is non-empty on a correctly
 *   deployed empty deployment. It is reported, never counted as data.
 * · **Two operational tables are declared, and EVERY row in them is
 *   validated — a table name is not provenance.** On the disposable control
 *   (`fantastic-blackbird-16`, 2026-09-12) the crons had written
 *   `cronHeartbeats` and `webhookLogs` rows within seconds of the push. But
 *   `webhookLogs` is also where Clerk, WhatsApp, Resend, the payment provider
 *   and the social OAuth callbacks are logged, so a row there is only harmless
 *   if it is provably a cron self-report. When one of the two tables holds
 *   rows, every row is read back (bounded, JSON lines) and checked against the
 *   narrow shape its cron writer produces: the exact key set, the job name or
 *   source the crons use, and none of the fields a provider delivery carries
 *   (`eventId`, payload hashes/previews, receive counts). One rejected row,
 *   an unparseable line, a read that exceeds the bound, or a read that fails
 *   fails the verdict. The Instagram token-refresh cron logs under the same
 *   `source` as Instagram provider traffic, so that one is admitted only by
 *   its exact empty-deployment summary. The table list and the provenance
 *   declarations are pinned by tests so neither can quietly grow. A pass means
 *   business, component and storage state is empty and the diagnostics were
 *   VERIFIED and disclosed by provenance and count — not that every table is
 *   literally empty.
 *
 * Nothing here remediates. A failed verdict is a stop, not a reset.
 */

/**
 * Tables the deployment writes about itself from the moment it is deployed.
 * Rows here are reported, never counted as data. Anything else with a row
 * fails the verdict.
 */
export const OPERATIONAL_DIAGNOSTIC_TABLES: ReadonlySet<string> = new Set(["cronHeartbeats", "webhookLogs"]);

/**
 * How many rows a declared diagnostic table may hold and still be validated.
 * More than this is not "a few minutes of cron noise on an empty deployment";
 * the checkpoint refuses rather than sample.
 */
export const DIAGNOSTIC_ROW_BOUND = 500;

/**
 * The only `cronHeartbeats` writers (`convex/crons.ts` triggerAlarms,
 * `convex/subscriptions.ts` reconcileExpiredSubscriptions), by job name.
 */
export const HEARTBEAT_JOB_NAMES: ReadonlySet<string> = new Set(["check-upcoming-tasks", "reconcile-expired-subscriptions"]);

/**
 * `webhookLogs.source` values written ONLY by cron self-reports through
 * `adminSystem.logWebhookEvent` (`convex/crons.ts`, `convex/marketplaceReports.ts`).
 * Every provider/tenant-driven source (clerk, whatsapp, resend, payment,
 * instagram*, facebook*, notification-*, support-inbox-notification,
 * upgrade-request, marketplace-whatsapp) is deliberately NOT here.
 */
export const CRON_SELF_REPORT_SOURCES: ReadonlySet<string> = new Set([
  "subscription-reminder",
  "social-auto-reply-retry",
  "fixed-asset-depreciation",
  "fi-commission-recognition",
  "prepaid-expense-amortization",
  "marketplace-weekly-report",
]);

/**
 * The Instagram token-refresh cron (`convex/crons.ts` triggerInstagramTokenRefresh)
 * logs under `source: "instagram"` — the same source as provider traffic — so
 * it is admitted only by the exact summary an EMPTY deployment produces.
 */
const INSTAGRAM_REFRESH_EMPTY_SUMMARY = /^Instagram token refresh cron: refreshed 0\/0 token\(s\) in this page\.$/;

const HEARTBEAT_KEYS = { required: ["_id", "_creationTime", "jobName", "ranAt", "success"], optional: ["detail"] } as const;
const SELF_REPORT_KEYS = { required: ["_id", "_creationTime", "createdAt", "source", "status", "summary"], optional: ["error"] } as const;

export type Refusal = { ok: false; reason: string };

export type TableReadOutcome = "EMPTY" | "NONEMPTY" | "UNREADABLE";

/** The outcome of validating every row of a declared diagnostic table. */
export interface DiagnosticValidation {
  state: "VERIFIED" | "REJECTED" | "UNREADABLE";
  rows: number;
  /** provenance label → row count, e.g. `heartbeat:check-upcoming-tasks`. Labels only, never values. */
  provenance: Record<string, number>;
  reasons: string[];
}

export interface TableRead {
  component: string | null;
  table: string;
  outcome: TableReadOutcome;
  /** Present only for a NONEMPTY root table in OPERATIONAL_DIAGNOSTIC_TABLES. */
  diagnostics?: DiagnosticValidation;
}

/** `convex env get <name>`, in the three states that matter. */
export type MarkerRead =
  | { state: "PRESENT"; value: string }
  | { state: "VERIFIED_ABSENT"; deployment: string; deploymentKind: string }
  | { state: "UNREADABLE"; reason: string };

export type ZeroStatePhase = "pre-deploy" | "post-deploy";

export type ZeroStateVerdict = "ZERO" | "ABSENT_INFRASTRUCTURE" | "FAIL";

const NO_TABLES = /^There are no tables in the .* deployment's database\.?$/;
const NO_DOCUMENTS = /^There are no documents in this table\.?$/;

/**
 * In deploy-key mode the CLI ignores the `--prod` selector the shell passes and
 * says so on stderr before EVERY command (convex 1.42.1 `cli/lib/api.ts`,
 * `logWarning` under `source === "deployKey"`). Production run 34705827721
 * (2026-09-12) failed as UNREADABLE on that one line; reproduced read-only on
 * `clever-mockingbird-719`. It is matched whole and verbatim — a prefix, a
 * suffix or the `--url`/`--admin-key` sibling sentence is still unknown output.
 */
export const CONVEX_DEPLOY_KEY_SELECTOR_NOTICE =
  "Ignoring `--prod`, `--preview-name`, or `--deployment-name` flags and using deployment from CONVEX_DEPLOY_KEY";

/** Lines either stream may carry that are not the command's output: Node's runtime warnings and the one pinned CLI notice. */
function isNoise(line: string): boolean {
  return line === "" || line.startsWith("(node:") || line.startsWith("(Use `node") || line === CONVEX_DEPLOY_KEY_SELECTOR_NOTICE;
}

const cleanLines = (text: string): string[] =>
  text.split(/\r?\n/).map((line) => line.trim()).filter((line) => !isNoise(line));

/** `convex data` with no table: the deployment's own table listing (names on stdout; the no-tables sentence on stderr). */
export function parseTableList(
  stdout: string,
  stderr: string,
  exitStatus: number | null
): { ok: true; tables: string[] } | Refusal {
  if (exitStatus !== 0) {
    return { ok: false, reason: `the table listing exited ${exitStatus}; an unreadable listing is not an empty one.` };
  }
  const lines = cleanLines(stdout);
  const notes = cleanLines(stderr);
  if (lines.length === 0 && notes.some((line) => NO_TABLES.test(line))) return { ok: true, tables: [] };
  if (lines.length === 0) {
    return { ok: false, reason: "the table listing printed nothing; refusing to read silence as an empty database." };
  }
  const bad = lines.find((line) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line));
  if (bad !== undefined) {
    return { ok: false, reason: `the table listing contained something that is not a table name (${bad.length} characters).` };
  }
  return { ok: true, tables: lines };
}

/**
 * `convex data <table> --limit 1`: empty, has documents, or could not be read.
 * Documents print as a table on stdout whose first column is `_id`; an empty
 * table prints nothing on stdout and the sentence on stderr.
 */
export function classifyTableRead(stdout: string, stderr: string, exitStatus: number | null): TableReadOutcome {
  if (exitStatus !== 0) return "UNREADABLE";
  const lines = cleanLines(stdout);
  const notes = cleanLines(stderr);
  if (lines.length === 0) {
    return notes.some((line) => NO_DOCUMENTS.test(line)) ? "EMPTY" : "UNREADABLE";
  }
  if (/^_id\b/.test(lines[0])) return "NONEMPTY";
  return "UNREADABLE";
}

const ENV_NOT_FOUND =
  /^[^A-Za-z]*Environment variable "([A-Za-z_][A-Za-z0-9_]*)" not found \(on ([a-z]+) deployment ([a-z0-9-]+)\)\.?$/;

/**
 * `convex env get <variable>`: PRESENT, VERIFIED_ABSENT or UNREADABLE.
 * Verified on a real deployment (2026-09-12): a set variable prints its value
 * on stdout and exits 0; a missing one prints
 * `✖ Environment variable "X" not found (on dev deployment <name>)` on STDERR
 * and ALSO exits 0; an unknown/denied deployment exits 1. Absence is accepted
 * only from that exact sentence, for that exact variable — and the sentence's
 * deployment name is returned so identity can be checked against it.
 */
export function classifyMarkerRead(
  stdout: string,
  stderr: string,
  exitStatus: number | null,
  variable = "AUTOFLOW_DEPLOYMENT_CLASS"
): MarkerRead {
  if (exitStatus !== 0) {
    return { state: "UNREADABLE", reason: `env get exited ${exitStatus === null ? "without a status (timed out or failed to start)" : exitStatus}` };
  }
  const lines = cleanLines(stdout);
  const notes = cleanLines(stderr);
  if (lines.length === 1 && notes.length === 0) return { state: "PRESENT", value: lines[0] };
  if (lines.length === 0 && notes.length === 1) {
    const match = ENV_NOT_FOUND.exec(notes[0]);
    if (match && match[1] === variable) return { state: "VERIFIED_ABSENT", deploymentKind: match[2], deployment: match[3] };
    return { state: "UNREADABLE", reason: "env get printed something other than the not-found sentence for this variable." };
  }
  if (lines.length === 0 && notes.length === 0) {
    return { state: "UNREADABLE", reason: "env get printed nothing; silence is not a verified absence." };
  }
  return { state: "UNREADABLE", reason: `env get printed an unexpected shape (${lines.length} stdout line(s), ${notes.length} stderr line(s)).` };
}

type Row = Record<string, unknown>;

function exactKeys(row: Row, keys: { required: readonly string[]; optional: readonly string[] }): string | null {
  for (const key of keys.required) if (!(key in row)) return `missing field ${key}`;
  for (const key of Object.keys(row)) {
    if (!keys.required.includes(key) && !keys.optional.includes(key)) return `unexpected field ${key}`;
  }
  return null;
}

/**
 * One row of a declared diagnostic table: is it provably a cron self-report?
 * Returns the provenance label, or the rule it broke. Never echoes values.
 */
export function validateDiagnosticRow(table: string, row: unknown): { ok: true; provenance: string } | { ok: false; reason: string } {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return { ok: false, reason: "not a document object" };
  const doc = row as Row;
  if (table === "cronHeartbeats") {
    const shape = exactKeys(doc, HEARTBEAT_KEYS);
    if (shape) return { ok: false, reason: shape };
    if (typeof doc.jobName !== "string" || !HEARTBEAT_JOB_NAMES.has(doc.jobName)) return { ok: false, reason: "jobName is not a declared heartbeat writer" };
    if (typeof doc.ranAt !== "number" || typeof doc.success !== "boolean") return { ok: false, reason: "ranAt/success are not the heartbeat types" };
    if ("detail" in doc && typeof doc.detail !== "string") return { ok: false, reason: "detail is not a string" };
    return { ok: true, provenance: `heartbeat:${doc.jobName}` };
  }
  if (table === "webhookLogs") {
    const shape = exactKeys(doc, SELF_REPORT_KEYS);
    if (shape) return { ok: false, reason: shape };
    if (typeof doc.source !== "string" || typeof doc.status !== "string" || typeof doc.summary !== "string" || typeof doc.createdAt !== "number") {
      return { ok: false, reason: "source/status/summary/createdAt are not the self-report types" };
    }
    if (doc.status !== "success" && doc.status !== "error") return { ok: false, reason: "status is an inbox lifecycle state, not a self-report outcome" };
    if ("error" in doc && typeof doc.error !== "string") return { ok: false, reason: "error is not a string" };
    if (CRON_SELF_REPORT_SOURCES.has(doc.source)) return { ok: true, provenance: `cron-report:${doc.source}` };
    if (doc.source === "instagram" && doc.status === "success" && INSTAGRAM_REFRESH_EMPTY_SUMMARY.test(doc.summary)) {
      return { ok: true, provenance: "cron-report:instagram-token-refresh(empty)" };
    }
    return { ok: false, reason: "source is not a cron self-report source" };
  }
  return { ok: false, reason: "table is not a declared diagnostic table" };
}

/**
 * `convex data <table> --limit <bound + 1> --format jsonl` on a declared
 * diagnostic table that the limit-one read found NONEMPTY. Every line must be a
 * JSON document and every document must validate; more than `bound` rows, a
 * failed read, silence, or any unparseable line refuses. Values are never kept.
 */
export function validateDiagnosticRows(
  table: string,
  stdout: string,
  stderr: string,
  exitStatus: number | null,
  bound = DIAGNOSTIC_ROW_BOUND
): DiagnosticValidation {
  const unreadable = (reason: string): DiagnosticValidation => ({ state: "UNREADABLE", rows: 0, provenance: {}, reasons: [reason] });
  if (exitStatus !== 0) return unreadable(`the bounded read of ${table} exited ${exitStatus ?? "without a status"}.`);
  const lines = cleanLines(stdout);
  if (lines.length === 0) {
    return unreadable(`the bounded read of ${table} printed no documents although the limit-one read found some; refusing to reconcile silence.`);
  }
  if (lines.length > bound) {
    return { state: "REJECTED", rows: lines.length, provenance: {}, reasons: [`${table} holds more than ${bound} rows; that is not empty-deployment cron noise, and the checkpoint does not sample.`] };
  }
  if (cleanLines(stderr).length > 0) return unreadable(`the bounded read of ${table} wrote to stderr; refusing to trust a partial read.`);
  const provenance: Record<string, number> = {};
  const reasons: string[] = [];
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      reasons.push(`${table} row ${index + 1}: not a JSON document.`);
      return;
    }
    const verdict = validateDiagnosticRow(table, parsed);
    if (verdict.ok) provenance[verdict.provenance] = (provenance[verdict.provenance] ?? 0) + 1;
    else reasons.push(`${table} row ${index + 1}: ${verdict.reason}.`);
  });
  if (reasons.some((r) => r.endsWith("not a JSON document."))) return { state: "UNREADABLE", rows: lines.length, provenance, reasons };
  return { state: reasons.length === 0 ? "VERIFIED" : "REJECTED", rows: lines.length, provenance, reasons };
}

/** `convex function-spec`: how many functions, and which deployment says so. */
export function parseFunctionSpec(
  stdout: string,
  exitStatus: number | null
): { ok: true; functionCount: number; url: string | null } | Refusal {
  if (exitStatus !== 0) return { ok: false, reason: `function-spec exited ${exitStatus}.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, reason: "function-spec did not print JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { functions?: unknown }).functions)) {
    return { ok: false, reason: "function-spec JSON did not carry a functions array." };
  }
  const url = (parsed as { url?: unknown }).url;
  return {
    ok: true,
    functionCount: (parsed as { functions: unknown[] }).functions.length,
    url: typeof url === "string" ? url : null,
  };
}

/** The tables the repository's own schema declares — what a push must create. */
export function schemaTableNames(schemaSource: string): string[] {
  const names: string[] = [];
  for (const match of schemaSource.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*defineTable\(/gm)) {
    names.push(match[1]);
  }
  return names;
}

/** The components `convex.config.ts` mounts, by the name the CLI addresses them with. */
export function componentNames(configSource: string): string[] {
  const names: string[] = [];
  for (const match of configSource.matchAll(/app\.use\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*\{[^}]*?\bname:\s*"([^"]+)"[^}]*\})?\s*\)/g)) {
    names.push(match[2] ?? match[1]);
  }
  return names;
}

export function deploymentNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/i.exec(url.trim());
  return match ? match[1] : null;
}

export interface ZeroStateInput {
  phase: ZeroStatePhase;
  expectedDeployment: string;
  /** The deployment the credential addresses, when a credential is in use; null under account login. */
  credentialDeployment: string | null;
  /** From function-spec. */
  reportedUrl: string | null;
  /** What the deployment answers at /instance_name, when reachable. */
  reportedInstanceName: string | null;
  functionCount: number;
  /** `AUTOFLOW_DEPLOYMENT_CLASS`: PRESENT, VERIFIED_ABSENT or UNREADABLE — never inferred. */
  marker: MarkerRead;
  schemaTables: string[];
  listedTables: string[];
  /** Each mounted component's listing, or a refusal when it could not be read. */
  components: Array<{ name: string; tables: string[] | null }>;
  reads: TableRead[];
  storage: TableReadOutcome;
  scheduledFunctions: TableReadOutcome;
}

export interface ZeroStateReport {
  verdict: ZeroStateVerdict;
  reasons: string[];
  counts: {
    functions: number;
    listedTables: number;
    schemaTables: number;
    componentTables: number;
    empty: number;
    nonEmpty: number;
    /** Declared operational-diagnostic tables whose EVERY row was VERIFIED as a cron self-report — disclosed, not counted as data. */
    operational: number;
    /** Rows validated inside those tables. */
    diagnosticRows: number;
    unreadable: number;
  };
  notes: string[];
}

export function decideZeroState(input: ZeroStateInput): ZeroStateReport {
  const reasons: string[] = [];
  const notes: string[] = [];

  // ── identity ─────────────────────────────────────────────────────────────
  if (input.credentialDeployment !== null && input.credentialDeployment !== input.expectedDeployment) {
    reasons.push(`the credential addresses ${input.credentialDeployment}, not ${input.expectedDeployment}.`);
  }
  const urlName = deploymentNameFromUrl(input.reportedUrl);
  if (input.reportedUrl !== null && urlName !== input.expectedDeployment) {
    reasons.push(`function metadata was reported by ${urlName ?? "an unrecognised URL"}, not ${input.expectedDeployment}.`);
  }
  if (input.reportedInstanceName !== null && input.reportedInstanceName !== input.expectedDeployment) {
    reasons.push(`the deployment answers to ${input.reportedInstanceName}, not ${input.expectedDeployment}.`);
  }
  // The not-found sentence echoes the deployment the CLI resolved — checked for
  // disagreement, but it is the selector echoed back, not the deployment
  // answering for itself, so it never satisfies identity on its own.
  const marker = input.marker;
  if (marker.state === "VERIFIED_ABSENT" && marker.deployment !== input.expectedDeployment) {
    reasons.push(`the environment read answered for ${marker.deployment}, not ${input.expectedDeployment}.`);
  }
  if (input.reportedUrl === null && input.reportedInstanceName === null && input.credentialDeployment === null) {
    reasons.push("no identity read-back succeeded; a deployment that will not say which one it is cannot be certified.");
  }

  // ── E2E marker: PRESENT fails, UNREADABLE fails, only VERIFIED_ABSENT passes ──
  if (input.marker.state === "PRESENT") {
    reasons.push(
      input.marker.value === "preview"
        ? "the deployment declares AUTOFLOW_DEPLOYMENT_CLASS=preview — the E2E preview marker. Production must never be a promoted preview."
        : "the deployment declares AUTOFLOW_DEPLOYMENT_CLASS with an unexpected value (not shown); production and dev carry none, so this is not the configuration a fresh target should have."
    );
  } else if (input.marker.state === "UNREADABLE") {
    reasons.push(`the AUTOFLOW_DEPLOYMENT_CLASS marker could not be read (${input.marker.reason}); a failed read is not a verified absence.`);
  }

  const componentTables = input.components.reduce((sum, c) => sum + (c.tables?.length ?? 0), 0);
  const empty = input.reads.filter((r) => r.outcome === "EMPTY").length;
  const isDeclared = (r: TableRead) => r.component === null && OPERATIONAL_DIAGNOSTIC_TABLES.has(r.table);
  const declaredNonEmpty = input.reads.filter((r) => r.outcome === "NONEMPTY" && isDeclared(r));
  const operational = declaredNonEmpty.filter((r) => r.diagnostics?.state === "VERIFIED");
  const unverifiedDiagnostics = declaredNonEmpty.filter((r) => r.diagnostics?.state !== "VERIFIED");
  const nonEmpty = input.reads.filter((r) => r.outcome === "NONEMPTY" && !isDeclared(r));
  const unreadable = input.reads.filter((r) => r.outcome === "UNREADABLE");
  const counts = {
    functions: input.functionCount,
    listedTables: input.listedTables.length,
    schemaTables: input.schemaTables.length,
    componentTables,
    empty,
    nonEmpty: nonEmpty.length + unverifiedDiagnostics.length,
    operational: operational.length,
    diagnosticRows: operational.reduce((sum, r) => sum + (r.diagnostics?.rows ?? 0), 0),
    unreadable: unreadable.length,
  };

  // ── pre-deploy: absence is infrastructure evidence only ──────────────────
  if (input.phase === "pre-deploy") {
    if (input.functionCount !== 0) reasons.push(`${input.functionCount} functions are already deployed; this is not an untouched deployment.`);
    if (input.listedTables.length !== 0) reasons.push(`${input.listedTables.length} tables already exist; this is not an untouched deployment.`);
    if (input.storage === "NONEMPTY") reasons.push("the file store already holds files.");
    if (input.storage === "UNREADABLE") reasons.push("the file store could not be read; unreadable is not empty.");
    notes.push(
      "PRE-DEPLOY: verified absence of functions and tables is INFRASTRUCTURE evidence only. It says nothing about the schema, which is not deployed yet; the post-deploy verdict is the launch checkpoint."
    );
    return { verdict: reasons.length === 0 ? "ABSENT_INFRASTRUCTURE" : "FAIL", reasons, counts, notes };
  }

  // ── post-deploy: expected metadata must exist, and every table must be empty ──
  if (input.functionCount === 0) {
    reasons.push("no functions are deployed; the push has not landed, and an unpushed deployment is not a verified-empty one.");
  }
  if (input.schemaTables.length === 0) {
    reasons.push("the repository schema declares no tables; the expected scope could not be derived.");
  }
  const listed = new Set(input.listedTables);
  const missing = input.schemaTables.filter((table) => !listed.has(table));
  if (missing.length > 0) {
    reasons.push(`${missing.length} table(s) the deployed schema declares are not listed by the deployment (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}); missing metadata is a failure, not a zero-row pass.`);
  }
  const readTables = new Set(input.reads.filter((r) => r.component === null).map((r) => r.table));
  const unread = input.listedTables.filter((table) => !readTables.has(table));
  if (unread.length > 0) {
    reasons.push(`${unread.length} listed table(s) were never read (${unread.slice(0, 5).join(", ")}${unread.length > 5 ? ", …" : ""}).`);
  }
  for (const component of input.components) {
    if (component.tables === null) {
      reasons.push(`component ${component.name}'s table listing could not be read; unreadable is not empty.`);
      continue;
    }
    const readInComponent = new Set(input.reads.filter((r) => r.component === component.name).map((r) => r.table));
    const unreadInComponent = component.tables.filter((table) => !readInComponent.has(table));
    if (unreadInComponent.length > 0) {
      reasons.push(`component ${component.name}: ${unreadInComponent.length} table(s) were never read.`);
    }
  }
  if (nonEmpty.length > 0) {
    reasons.push(
      `${nonEmpty.length} table(s) hold documents: ${nonEmpty
        .slice(0, 8)
        .map((r) => (r.component ? `${r.component}/${r.table}` : r.table))
        .join(", ")}${nonEmpty.length > 8 ? ", …" : ""}.`
    );
  }
  if (unreadable.length > 0) {
    reasons.push(
      `${unreadable.length} table(s) could not be read: ${unreadable
        .slice(0, 8)
        .map((r) => (r.component ? `${r.component}/${r.table}` : r.table))
        .join(", ")}${unreadable.length > 8 ? ", …" : ""}. Unreadable is not zero.`
    );
  }
  if (input.storage === "NONEMPTY") reasons.push("the file store (_storage) holds files.");
  if (input.storage === "UNREADABLE") reasons.push("the file store (_storage) could not be read; unreadable is not empty.");
  if (!listed.has("e2ePreviewBootstrap") && input.schemaTables.includes("e2ePreviewBootstrap")) {
    reasons.push("the e2ePreviewBootstrap table is not listed, so the absence of an E2E marker row could not be verified.");
  }
  for (const read of unverifiedDiagnostics) {
    const d = read.diagnostics;
    reasons.push(
      d === undefined
        ? `${read.table} holds documents and its rows were never validated; a declared diagnostic table is exempt only row by row.`
        : `${read.table} holds ${d.rows} row(s) that were NOT verified as cron diagnostics (${d.state}): ${d.reasons.slice(0, 4).join(" ")}${d.reasons.length > 4 ? ` (+${d.reasons.length - 4} more)` : ""}`
    );
  }
  for (const read of operational) {
    const d = read.diagnostics!;
    const byProvenance = Object.entries(d.provenance)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, n]) => `${label} ×${n}`)
      .join(", ");
    notes.push(`${read.table}: ${d.rows} row(s) VERIFIED as cron self-reports — ${byProvenance}; disclosed, not counted as data.`);
  }
  notes.push(
    input.scheduledFunctions === "NONEMPTY"
      ? "_scheduled_functions holds entries — expected after any deploy (crons are scheduled with the code); informational, not counted as data."
      : input.scheduledFunctions === "EMPTY"
        ? "_scheduled_functions is empty."
        : "_scheduled_functions could not be read; informational only."
  );
  notes.push(
    "READ-ONLY COMMANDS / WRITE-CAPABLE CREDENTIAL: the commands issued were data listings, limit-one reads, function metadata and one environment read. Convex deploy keys carry full capability regardless of their label; read-only was the behaviour of this script, not an enforcement of the credential."
  );

  return { verdict: reasons.length === 0 ? "ZERO" : "FAIL", reasons, counts, notes };
}

/** Markdown for `$GITHUB_STEP_SUMMARY`; carries names and counts, never documents. */
export function renderZeroStateSummary(input: {
  report: ZeroStateReport;
  phase: ZeroStatePhase;
  expectedDeployment: string;
  releaseSha: string | null;
  authMode: "deploy-key" | "account-login";
}): string {
  const { report } = input;
  const heading =
    report.verdict === "ZERO"
      ? "Zero-state verified — no business, component or storage data; verified cron diagnostics disclosed below"
      : report.verdict === "ABSENT_INFRASTRUCTURE"
        ? "Pre-deploy: no functions and no tables (infrastructure evidence only)"
        : "Zero-state NOT verified";
  const lines = [
    `## ${heading}`,
    "",
    `- Deployment: \`${input.expectedDeployment}\` (${input.phase}, ${input.authMode})`,
    `- Commit: \`${input.releaseSha ?? "n/a"}\``,
    `- Functions: ${report.counts.functions} · listed tables: ${report.counts.listedTables} · schema tables: ${report.counts.schemaTables} · component tables: ${report.counts.componentTables}`,
    `- Reads: ${report.counts.empty} empty · ${report.counts.nonEmpty} non-empty · ${report.counts.operational} operational-diagnostic (${report.counts.diagnosticRows} row(s) verified) · ${report.counts.unreadable} unreadable`,
    "",
  ];
  if (report.reasons.length > 0) {
    lines.push("### Why it failed", "", ...report.reasons.map((r) => `- ${r}`), "");
  }
  lines.push("### Notes", "", ...report.notes.map((n) => `- ${n}`), "");
  lines.push(
    "This is a ONE-TIME LAUNCH CHECKPOINT for a fresh deployment. It is not a release gate for an established dealership, whose data is supposed to exist. A failed verdict is a stop — nothing here resets, imports or retries."
  );
  return lines.join("\n");
}
