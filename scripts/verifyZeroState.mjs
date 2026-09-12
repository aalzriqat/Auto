/**
 * Zero-state verification of a Convex deployment — the shell around
 * `zeroState.ts`. READ-ONLY COMMANDS, WRITE-CAPABLE CREDENTIAL.
 *
 * Runs table listings, limit-one reads, function metadata and one environment
 * read against ONE named deployment, and decides whether it holds no data
 * (`post-deploy`) or nothing at all (`pre-deploy`). It never writes, never
 * pushes, never bootstraps and never remediates: a failed verdict is a stop.
 *
 * Two ways in, decided by the environment:
 *   · CI (the protected release job): `CONVEX_DEPLOY_KEY` holds the deployment
 *     key; the key must address `CONVEX_PROD_DEPLOYMENT`, and the CLI is run
 *     with `--prod` so the key, not a flag, selects the deployment. The key is
 *     a full-capability credential whatever its name says — the read-only
 *     property is this script's behaviour, not the key's scope.
 *   · Manual (an operator's workstation with a Convex account login): no key,
 *     `--deployment <name>` selects the target. Used at the launch boundary and
 *     for the empty/non-empty controls on disposable previews.
 *
 * Nothing secret reaches stdout, the step summary or a file: the key is never
 * printed, table reads are classified (EMPTY / NONEMPTY / UNREADABLE) and only
 * table names and counts are reported. No artifact is written.
 *
 * Usage:
 *   node scripts/verifyZeroState.mjs --phase post-deploy [--deployment <name>] [--release-sha <sha>]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { forLog, parseDeployKeyTarget, requireBoundProductionKey } from "./releaseGuard.ts";
import {
  classifyTableRead,
  componentNames,
  decideZeroState,
  parseFunctionSpec,
  parseTableList,
  renderZeroStateSummary,
  schemaTableNames,
} from "./zeroState.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONVEX_CLI = path.join(ROOT, "node_modules", "convex", "bin", "main.js");
const CLI_TIMEOUT_MS = 2 * 60 * 1000;

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

const phase = arg("--phase");
if (phase !== "pre-deploy" && phase !== "post-deploy") fail("--phase must be pre-deploy or post-deploy.");
const releaseSha = arg("--release-sha", process.env.RELEASE_SHA ?? null);

// ─── Which deployment, and by what authority ────────────────────────────────
const rawKey = process.env.CONVEX_DEPLOY_KEY;
const keyTarget = parseDeployKeyTarget(rawKey);
let expectedDeployment;
let authMode;
let selector;
if (keyTarget.kind !== "missing") {
  // The protected CI path. The key must name the expected deployment; the
  // deployment is then selected by the key alone.
  expectedDeployment = (process.env.CONVEX_PROD_DEPLOYMENT ?? "").trim();
  const bound = requireBoundProductionKey(rawKey, expectedDeployment, "observer key");
  if (!bound.ok) fail(bound.reason);
  authMode = "deploy-key";
  selector = ["--prod"];
} else {
  expectedDeployment = (arg("--deployment") ?? process.env.CONVEX_PROD_DEPLOYMENT ?? "").trim();
  if (expectedDeployment === "") fail("Name the deployment: --deployment <name> (no CONVEX_DEPLOY_KEY is set).");
  if (!/^[a-z0-9-]+$/.test(expectedDeployment)) fail(`Unrecognised deployment name ${forLog(expectedDeployment)}.`);
  authMode = "account-login";
  selector = ["--deployment", expectedDeployment];
}
if (!existsSync(CONVEX_CLI)) fail(`The repository-local Convex CLI is missing at ${CONVEX_CLI}.`);

console.log(`Zero-state verification: ${expectedDeployment} · ${phase} · ${authMode}`);
console.log(`READ-ONLY COMMANDS / WRITE-CAPABLE CREDENTIAL — only listings, limit-one reads, function metadata and one env read are issued.`);

// ─── The CLI, read-only ─────────────────────────────────────────────────────
/** Runs the CLI and returns both streams and the status; neither stream is ever printed (they may carry data). */
function convex(args) {
  const result = spawnSync(process.execPath, [CONVEX_CLI, ...args, ...selector], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: CLI_TIMEOUT_MS,
  });
  if (result.error) return { stdout: "", stderr: "", status: null };
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

/** One limit-one read, classified; the documents themselves are never kept. */
function readTable(table, component) {
  const r = convex(["data", table, "--limit", "1", ...(component ? ["--component", component] : [])]);
  return classifyTableRead(r.stdout, r.stderr, r.status);
}

// 1. Function metadata — count, and the URL the deployment reports for itself.
const specRaw = convex(["function-spec"]);
const spec = parseFunctionSpec(specRaw.stdout, specRaw.status);
if (!spec.ok) fail(`Function metadata could not be read: ${spec.reason}`);

// 2. The deployment's own name, from its public /instance_name endpoint.
let reportedInstanceName = null;
try {
  const res = await fetch(`https://${expectedDeployment}.convex.cloud/instance_name`);
  if (res.ok) {
    const text = (await res.text()).trim();
    if (/^[a-z0-9-]+$/.test(text)) reportedInstanceName = text;
  }
} catch {
  reportedInstanceName = null;
}

// 3. The E2E marker declaration, as the deployment currently carries it.
const envRaw = convex(["env", "get", "AUTOFLOW_DEPLOYMENT_CLASS"]);
const deploymentClass =
  envRaw.status === 0
    ? envRaw.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("(")).at(-1) ?? null
    : null;

// 4. The scope: the deployment's own listing, each mounted component's listing,
//    and the tables the repository schema declares.
const listRaw = convex(["data"]);
const listing = parseTableList(listRaw.stdout, listRaw.stderr, listRaw.status);
if (!listing.ok) fail(`The table listing could not be read: ${listing.reason}`);
const schemaTables = schemaTableNames(readFileSync(path.join(ROOT, "convex", "schema.ts"), "utf8"));
const mounted = componentNames(readFileSync(path.join(ROOT, "convex", "convex.config.ts"), "utf8"));

const components = [];
const reads = [];
if (phase === "post-deploy") {
  for (const table of listing.tables) {
    reads.push({ component: null, table, outcome: readTable(table, null) });
  }
  for (const name of mounted) {
    const raw = convex(["data", "--component", name]);
    const parsed = parseTableList(raw.stdout, raw.stderr, raw.status);
    if (!parsed.ok) {
      components.push({ name, tables: null });
      continue;
    }
    components.push({ name, tables: parsed.tables });
    for (const table of parsed.tables) {
      reads.push({ component: name, table, outcome: readTable(table, name) });
    }
  }
}
const storage = readTable("_storage", null);
const scheduledFunctions = readTable("_scheduled_functions", null);

// ─── Decide, report, stop ───────────────────────────────────────────────────
const report = decideZeroState({
  phase,
  expectedDeployment,
  credentialDeployment: keyTarget.kind === "missing" ? null : keyTarget.deployment,
  reportedUrl: spec.url,
  reportedInstanceName,
  functionCount: spec.functionCount,
  deploymentClass,
  schemaTables,
  listedTables: listing.tables,
  components,
  reads,
  storage,
  scheduledFunctions,
});

const summary = renderZeroStateSummary({ report, phase, expectedDeployment, releaseSha, authMode });
console.log(`\n${summary}\n`);
for (const read of reads) {
  if (read.outcome !== "EMPTY") console.log(`  ${read.outcome}: ${read.component ? `${read.component}/` : ""}${read.table}`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

if (report.verdict === "FAIL") fail(`Zero-state NOT verified on ${expectedDeployment}. Nothing has been changed; do not proceed to bootstrap.`);
console.log(`✔ ${report.verdict} on ${expectedDeployment}`);
