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
 * · **The E2E marker fails it.** `AUTOFLOW_DEPLOYMENT_CLASS=preview` is what
 *   every preview carries and what the E2E bootstrap requires; production
 *   must not. The `e2ePreviewBootstrap` table is covered by the table walk.
 * · **Scheduled functions are informational.** Crons are scheduled the moment
 *   code is deployed, so `_scheduled_functions` is non-empty on a correctly
 *   deployed empty deployment. It is reported, never counted as data.
 * · **Two operational tables are declared, not waived.** On the disposable
 *   control (`fantastic-blackbird-16`, 2026-09-12) the crons had written
 *   `cronHeartbeats` and `webhookLogs` rows within seconds of the push —
 *   append-only diagnostics the deployment writes about itself
 *   (`convex/crons.ts`, `adminSystem.logWebhookEvent`), retention-pruned,
 *   carrying no tenant or financial data. They are the ONLY tables allowed to
 *   hold rows, they are named in the report when they do, and the list is
 *   pinned by a test so it cannot quietly grow.
 *
 * Nothing here remediates. A failed verdict is a stop, not a reset.
 */

/**
 * Tables the deployment writes about itself from the moment it is deployed.
 * Rows here are reported, never counted as data. Anything else with a row
 * fails the verdict.
 */
export const OPERATIONAL_DIAGNOSTIC_TABLES: ReadonlySet<string> = new Set(["cronHeartbeats", "webhookLogs"]);

export type Refusal = { ok: false; reason: string };

export type TableReadOutcome = "EMPTY" | "NONEMPTY" | "UNREADABLE";

export interface TableRead {
  component: string | null;
  table: string;
  outcome: TableReadOutcome;
}

export type ZeroStatePhase = "pre-deploy" | "post-deploy";

export type ZeroStateVerdict = "ZERO" | "ABSENT_INFRASTRUCTURE" | "FAIL";

const NO_TABLES = /^There are no tables in the .* deployment's database\.?$/;
const NO_DOCUMENTS = /^There are no documents in this table\.?$/;

/** Lines the CLI prints on stdout that are not table names. */
function isNoise(line: string): boolean {
  return line === "" || line.startsWith("(node:") || line.startsWith("(Use `node");
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
  /** `AUTOFLOW_DEPLOYMENT_CLASS` as the deployment currently carries it. */
  deploymentClass: string | null;
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
    /** Rows in the declared operational-diagnostic tables — reported, not counted as data. */
    operational: number;
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
  if (input.reportedUrl === null && input.reportedInstanceName === null && input.credentialDeployment === null) {
    reasons.push("no identity read-back succeeded; a deployment that will not say which one it is cannot be certified.");
  }

  // ── E2E marker ───────────────────────────────────────────────────────────
  if (input.deploymentClass === "preview") {
    reasons.push("the deployment declares AUTOFLOW_DEPLOYMENT_CLASS=preview — the E2E preview marker. Production must never be a promoted preview.");
  }

  const componentTables = input.components.reduce((sum, c) => sum + (c.tables?.length ?? 0), 0);
  const empty = input.reads.filter((r) => r.outcome === "EMPTY").length;
  const isOperational = (r: TableRead) => r.component === null && OPERATIONAL_DIAGNOSTIC_TABLES.has(r.table);
  const operational = input.reads.filter((r) => r.outcome === "NONEMPTY" && isOperational(r));
  const nonEmpty = input.reads.filter((r) => r.outcome === "NONEMPTY" && !isOperational(r));
  const unreadable = input.reads.filter((r) => r.outcome === "UNREADABLE");
  const counts = {
    functions: input.functionCount,
    listedTables: input.listedTables.length,
    schemaTables: input.schemaTables.length,
    componentTables,
    empty,
    nonEmpty: nonEmpty.length,
    operational: operational.length,
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
  if (operational.length > 0) {
    notes.push(
      `operational diagnostics hold rows written by the deployment's own crons since the push — ${operational
        .map((r) => r.table)
        .join(", ")} — declared in OPERATIONAL_DIAGNOSTIC_TABLES; reported, not counted as data.`
    );
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
      ? "Zero-state verified — the deployment holds no data"
      : report.verdict === "ABSENT_INFRASTRUCTURE"
        ? "Pre-deploy: no functions and no tables (infrastructure evidence only)"
        : "Zero-state NOT verified";
  const lines = [
    `## ${heading}`,
    "",
    `- Deployment: \`${input.expectedDeployment}\` (${input.phase}, ${input.authMode})`,
    `- Commit: \`${input.releaseSha ?? "n/a"}\``,
    `- Functions: ${report.counts.functions} · listed tables: ${report.counts.listedTables} · schema tables: ${report.counts.schemaTables} · component tables: ${report.counts.componentTables}`,
    `- Reads: ${report.counts.empty} empty · ${report.counts.nonEmpty} non-empty · ${report.counts.operational} operational-diagnostic · ${report.counts.unreadable} unreadable`,
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
