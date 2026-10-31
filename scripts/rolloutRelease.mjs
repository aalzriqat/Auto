#!/usr/bin/env node
/**
 * Starts the Social Inbox conversation backfills and refuses to finish until
 * every organization is provably on the materialised path.
 *
 * This runs in the SAME workflow job as the deploy, immediately after it, and
 * that is a correctness requirement rather than convenience. Between the code
 * landing and the backfills completing, database I/O goes UP, not down: the
 * conversation trigger adds a read and a row write per inbound webhook while
 * the legacy full-scan reader is still the one serving every inbox. Splitting
 * deploy and backfill into two manually resumed sessions leaves production in
 * that state for however long the gap lasts.
 *
 * ⚠️ Everything this prints is PUBLIC — the repository is public, so its
 * Actions logs and job summaries are too. Organizations appear as opaque
 * hashes and backend error text never leaves the Convex logs.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  assertDeploymentIdentity,
  captureRunBaseline,
  classifyMaterializationReport,
  decideEmptyRollout,
  decidePollOutcome,
  describeConvexFailure,
  forLog,
  mergeVerdicts,
  parseConvexRunJson,
  pollIntervalMs,
  bankRebuildStopMessage,
  bankRefusalMessage,
  rebuildBankBalances,
  recoverSupplierVatHolds,
  renderBankRebuildSummary,
  renderSupplierIdentitySummary,
  renderReleaseSummary,
  repairAndVerifySupplierIdentity,
  requireBoundProductionKey,
  supplierIdentityRefusalMessage,
} from "./releaseGuard.ts";

const REPORT_FN = "adminSystem:materializationReportForRelease";
const START_FN = "migrations:startSocialConversationBackfills";
const BANK_BACKFILL_FN = "bankBalanceBackfill:runPage";
const SUPPLIER_VAT_HOLD_FN = "accountingOutbox:recoverPeriodHeldSupplierVat";
/** SCRUM-868 P3: bind P2-era supplier rows to their vehicle's frozen supplier, then count what is left. */
const SUPPLIER_IDENTITY_REPAIR_FN = "supplierIdentityRepair:repairPage";
const SUPPLIER_IDENTITY_COUNT_FN = "supplierIdentityRepair:countPage";
/** The backend clamps a page to 100 rows; each row reads a bounded number of documents. */
const SUPPLIER_IDENTITY_PAGE_SIZE = 100;
/** 100 rows per page, so this bounds one organization and row kind at 1,000,000 rows. */
const MAX_SUPPLIER_IDENTITY_PAGES_PER_PHASE = 10_000;
/** At most two parked rows per page, with a durable completion marker. */
const MAX_SUPPLIER_VAT_HOLD_PAGES = 10_000;
/** 16 journal lines per page, so this bounds one org at 160,000 bank lines. */
const MAX_BANK_PAGES_PER_ORG = 10_000;

const PAGE_SIZE = 50;
/** A cursor that stops advancing would otherwise page forever. */
const MAX_PAGES = 500;
/**
 * A single CLI call that never returns would strand the whole run: `spawnSync`
 * blocks, so control never reaches the deadline check again and the
 * informative summary below never gets written.
 */
const CLI_TIMEOUT_MS = 5 * 60_000;

const TIMEOUT_MS = Number(process.env.ROLLOUT_TIMEOUT_MINUTES ?? 45) * 60_000;
const SHA = process.env.RELEASE_SHA ?? "";
const EXPECTED_DEPLOYMENT = (process.env.CONVEX_PROD_DEPLOYMENT ?? "").trim();

/**
 * The repository-local Convex CLI, addressed directly.
 *
 * Not `pnpm exec convex`, and not because that would resolve the wrong package
 * — it resolves the right one. It is that reaching it through a bare command
 * name means resolving `pnpm` itself through `PATH`, and this script's whole
 * job is to report truthfully on what a credential just did to production.
 */
const CONVEX_CLI = path.join(process.cwd(), "node_modules", "convex", "bin", "main.js");

let lastVerdict = null;
let lastOutcome = "continue";
let bankSummary = null;
let supplierVatSummary = null;
let supplierIdentitySummary = null;

function writeSummary(extra) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const verdict = lastVerdict ?? {
    ok: false,
    settled: false,
    orgCount: 0,
    completedOrgCount: 0,
    inFlight: [],
    problems: [],
    anomalies: [],
  };
  let body = renderReleaseSummary({
    sha: SHA,
    deployment: EXPECTED_DEPLOYMENT || "unknown",
    verdict,
    outcome: lastOutcome === "continue" ? "failed" : lastOutcome,
  });
  if (bankSummary) body += `\n### Bank balances\n\n${bankSummary}\n`;
  if (supplierVatSummary) body += `\n### Supplier VAT holds\n\n${supplierVatSummary}\n`;
  if (supplierIdentitySummary) body += `\n### Supplier identity\n\n${supplierIdentitySummary}\n`;
  if (extra) body += `\n### What stopped it\n\n\`\`\`\n${extra}\n\`\`\`\n`;
  appendFileSync(summaryPath, `${body}\n`);
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  writeSummary(message);
  process.exit(1);
}

/**
 * Invokes the Convex CLI.
 *
 * `--prod` is passed deliberately, and NOT because it is what selects the
 * target. Verified against the installed CLI (convex 1.42.1): with a
 * deployment-scoped key the deployment comes from the key and the flag is
 * ignored with a warning. It is here for the misconfiguration case — a
 * PROJECT-scoped key with no selection can resolve to the dev deployment, which
 * would have this script verify a rollout on a deployment that is not
 * production.
 *
 * Codegen and typechecking are disabled: this step must observe the deployment,
 * never rewrite the tree it observes from.
 */
function convex(args) {
  const result = spawnSync(
    process.execPath,
    [CONVEX_CLI, ...args, "--prod", "--typecheck", "disable", "--codegen", "disable"],
    {
      encoding: "utf8",
      shell: false,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: CLI_TIMEOUT_MS,
    }
  );

  if (result.error) {
    return { ok: false, reason: `Could not run the Convex CLI: ${forLog(result.error.message)}` };
  }
  if (result.status !== 0) {
    // ⚠️ Built by a helper that CANNOT be handed the CLI's output. `fail()`
    // writes this reason to the job log and the run summary, both public, and a
    // Convex error carries whatever the failing function was handling. An
    // earlier revision pasted the whole of stderr in here.
    return { ok: false, reason: describeConvexFailure(args[0], result.status) };
  }
  return parseConvexRunJson(result.stdout ?? "");
}

/**
 * Walks every page of the report.
 *
 * Returns the raw org pages as well as the verdict, because the caller needs
 * the pre-fan-out run identities and cannot recover them from a verdict.
 */
function collectReport(baseline) {
  const verdicts = [];
  const orgs = [];
  let cursor = null;
  let identityChecked = false;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const result = convex([
      "run",
      REPORT_FN,
      JSON.stringify({ paginationOpts: { cursor, numItems: PAGE_SIZE } }),
    ]);
    if (!result.ok) return result;

    const value = result.value;
    if (typeof value !== "object" || value === null || !Array.isArray(value.page)) {
      return { ok: false, reason: `The materialisation report was not the expected shape.` };
    }

    // ⚠️ Checked on every walk, not once at startup. The deployment that
    // answers is the only thing that can prove which deployment is being
    // verified, and a credential can be the wrong credential.
    if (!identityChecked) {
      const identity = assertDeploymentIdentity(value.deploymentUrl, EXPECTED_DEPLOYMENT);
      if (!identity.ok) return identity;
      identityChecked = true;
    }

    orgs.push(...value.page);
    verdicts.push(classifyMaterializationReport(value.page, baseline));

    if (value.isDone === true) {
      // `complete` and `identityVerified` are stated, not implied, because the
      // empty-deployment decision below consumes them as evidence.
      return { ok: true, verdict: mergeVerdicts(verdicts), orgs, complete: true, identityVerified: identityChecked };
    }

    const next = value.continueCursor;
    if (typeof next !== "string" || next === cursor) {
      return { ok: false, reason: `The report's cursor stopped advancing; refusing to page forever.` };
    }
    cursor = next;
  }

  return { ok: false, reason: `The report did not finish within ${MAX_PAGES} pages.` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 0. Refuse before doing anything if the environment is not configured ────

// Only the OPERATOR key is present in this step — the deploy key is deliberately
// not in scope here, so this cannot deploy anything even if it wanted to. Both
// keys are checked against each other earlier, in the step that holds both.
const keyCheck = requireBoundProductionKey(
  process.env.CONVEX_DEPLOY_KEY,
  EXPECTED_DEPLOYMENT,
  "operator key"
);
if (!keyCheck.ok) fail(keyCheck.reason);

if (!existsSync(CONVEX_CLI)) {
  fail(`The repository-local Convex CLI is missing at ${CONVEX_CLI}. Did the install step run?`);
}

// ─── 1. Learn what was already broken BEFORE asking for a redrive ───────────

// Without this, a pre-existing failure and a failure caused by this rollout are
// indistinguishable — and they want opposite responses.
console.log(`Reading the current materialisation state…`);
const before = collectReport(undefined);
if (!before.ok) fail(before.reason);
const baseline = captureRunBaseline(before.orgs);
console.log(`  baseline captured for ${before.orgs.length} organizations`);

// SCRUM-782: run the one-time migration after identity verification, including
// on an empty deployment. Like the bank rebuild, the backend owns its cursor
// and each call commits one page. READY means reclassification is complete;
// scheduled claims still use the ordinary outbox worker/refusal retry budget.
// One deadline covers this phase, the bank rebuild and Inbox verification.
const rolloutStartedAt = Date.now();
lastVerdict = before.verdict;
console.log(`Reclassifying legacy supplier VAT holds…`);
const supplierVat = recoverSupplierVatHolds({
  runPage: () => convex(["run", SUPPLIER_VAT_HOLD_FN, "{}"]),
  now: Date.now,
  startedAt: rolloutStartedAt,
  timeoutMs: TIMEOUT_MS,
  maxPages: MAX_SUPPLIER_VAT_HOLD_PAGES,
});
if (!supplierVat.ok) fail(supplierVat.reason);
supplierVatSummary = `${supplierVat.reclassified} legacy holds released for worker review in ${supplierVat.pages} page call(s). This does not certify settlement repair.`;
console.log(`  ${supplierVatSummary}`);

// ─── 1b. A deployment with NO organizations has nothing to roll out ─────────

// A fresh production deployment (SCRUM-231's clean slate) holds no
// organizations, so the ordinary verdict — which demands at least one on the
// materialised path — could never verify it, and this step would poll to the
// deadline and paint a red run over a backend that deployed correctly. Read-
// only: the report is walked a second time and both walks must agree it is
// empty; the fan-out is not started, so nothing is scheduled on an empty
// deployment for no reason. Anything short of that evidence — a walk that
// stopped early, an unverified identity, a problem, or an organization that
// appeared between the two walks — refuses the run rather than guessing; a
// re-run then takes whichever path the deployment actually warrants.
if (before.verdict.orgCount === 0) {
  console.log(`  no organizations on this deployment; confirming with a second walk before concluding…`);
  const confirmation = collectReport(undefined);
  if (!confirmation.ok) fail(confirmation.reason);
  const empty = decideEmptyRollout({
    baseline: { complete: before.complete, identityVerified: before.identityVerified, verdict: before.verdict },
    confirmation: { complete: confirmation.complete, identityVerified: confirmation.identityVerified, verdict: confirmation.verdict },
    fanOut: null,
  });
  if (!empty.ok) fail(empty.reason);
  lastVerdict = confirmation.verdict;
  lastOutcome = empty.outcome;
  writeSummary(null);
  console.log(
    `\n✔ ${EXPECTED_DEPLOYMENT} holds no organizations: nothing to materialise. ` +
      `This verifies the Social Inbox rollout only, not Accounting bootstrap or readiness.\n`
  );
  process.exit(0);
}

// ─── 2. Start the backfills ─────────────────────────────────────────────────

console.log(`Starting Social Inbox conversation backfills…`);
const started = convex(["run", START_FN, "{}"]);
if (!started.ok) fail(started.reason);
console.log(`  fan-out: ${JSON.stringify(started.value)}`);

// ─── 2b. Rebuild every organization's bank balance aggregates ───────────────

// SCRUM-54: bank balances read from per-org aggregate trees, and a state built
// for an older layout is withheld, so until this finishes every bank balance in
// that org reads as unavailable. Synchronous, page by page, through the same
// operator key; `runPage` is idempotent and returns READY at once for an org
// already rebuilt, so a re-run resumes rather than restarts. It runs while the
// Social Inbox fan-out proceeds in the background.
console.log(`Rebuilding bank balance aggregates…`);
// ONE deadline covers this phase and the verification below, so the two can
// never add up past the job's own timeout and kill it before the summary.
// Until verification runs, the summary shows the pre-rollout report rather
// than an empty "0/0" that reads as if the Social Inbox had been checked.
lastVerdict = before.verdict;
const bank = rebuildBankBalances({
  orgs: before.orgs,
  runPage: (orgId) => convex(["run", BANK_BACKFILL_FN, JSON.stringify({ orgId })]),
  now: Date.now,
  startedAt: rolloutStartedAt,
  timeoutMs: TIMEOUT_MS,
  maxPages: MAX_BANK_PAGES_PER_ORG,
  log: (level, line) => (level === "error" ? console.error(line) : console.log(line)),
});
bankSummary = renderBankRebuildSummary(bank);
console.log(`  ${bankSummary}`);
// Hard stops: the shared deadline and the page cap end the whole phase.
const bankStop = bankRebuildStopMessage(bank, MAX_BANK_PAGES_PER_ORG);
if (bankStop) fail(bankStop);

// ─── 2c. Give P2-era supplier rows their supplier id, then count what is left ─

// SCRUM-868 P3: every settlement door refuses a supplier row with no supplier
// id, and sale completion on main before this release wrote such rows. The
// repair binds a row ONLY to its vehicle's frozen supplier link and only when
// the stored name agrees; the check then re-counts from the data. A failed or
// unreadable call ends the run here (fail closed). Leftover rows are reported
// below, after the Social Inbox verification, so that verification still runs.
// Counts and opaque org refs only: this output is public.
console.log(`Binding supplier rows to their supplier identity…`);
lastVerdict = before.verdict;
const supplierIdentity = repairAndVerifySupplierIdentity({
  orgs: before.orgs,
  repair: (args) => convex(["run", SUPPLIER_IDENTITY_REPAIR_FN, JSON.stringify(args)]),
  count: (args) => convex(["run", SUPPLIER_IDENTITY_COUNT_FN, JSON.stringify(args)]),
  now: Date.now,
  startedAt: rolloutStartedAt,
  timeoutMs: TIMEOUT_MS,
  maxPagesPerPhase: MAX_SUPPLIER_IDENTITY_PAGES_PER_PHASE,
  pageSize: SUPPLIER_IDENTITY_PAGE_SIZE,
});
supplierIdentitySummary = renderSupplierIdentitySummary(supplierIdentity);
console.log(`  ${supplierIdentitySummary}`);
if (!supplierIdentity.ok) fail(supplierIdentity.reason);

// ─── 3. Refuse to finish until every org is verifiably on the fast path ──────

const startedAt = rolloutStartedAt;
console.log(`Verifying the rollout (deadline ${Math.round(TIMEOUT_MS / 60_000)} minutes from the rebuild's start)…`);

// The loop variable IS the end condition: every branch below either leaves it
// at "continue" or sets a terminal value.
while (lastOutcome === "continue") {
  const collected = collectReport(baseline);
  if (!collected.ok) fail(collected.reason);

  lastVerdict = collected.verdict;
  const elapsedMs = Date.now() - startedAt;
  lastOutcome = decidePollOutcome({ verdict: lastVerdict, elapsedMs, timeoutMs: TIMEOUT_MS });

  console.log(
    `  ${lastVerdict.completedOrgCount}/${lastVerdict.orgCount} organizations materialised · ` +
      `${lastVerdict.inFlight.length} in flight · ${lastVerdict.problems.length} problems · ` +
      `${lastVerdict.anomalies.length} anomalies · ${lastOutcome}`
  );

  if (lastOutcome === "continue") await sleep(pollIntervalMs(elapsedMs));
}

for (const p of lastVerdict.anomalies) {
  console.warn(`  ⚠ ${p.org} ${p.platform ?? "—"} ${p.kind}: ${p.detail}`);
}

const bankRefusal = lastOutcome === "verified" ? bankRefusalMessage(bank) : null;
if (bankRefusal) {
  // The heading must not read "verified" on a run that fails.
  lastOutcome = "failed";
  fail(bankRefusal);
}

const supplierIdentityRefusal = lastOutcome === "verified" ? supplierIdentityRefusalMessage(supplierIdentity) : null;
if (supplierIdentityRefusal) {
  lastOutcome = "failed";
  fail(supplierIdentityRefusal);
}

if (lastOutcome === "verified") {
  writeSummary(null);
  console.log(`\n✔ Every organization is reading the materialised path on ${EXPECTED_DEPLOYMENT}.\n`);
  process.exit(0);
}

for (const p of [...lastVerdict.problems, ...lastVerdict.inFlight]) {
  console.error(`  ${p.org} ${p.platform ?? "—"} ${p.kind}: ${p.detail}`);
}

// ⚠️ Production IS deployed at this point. Saying so plainly is the whole job
// of this branch: the failure is a rollout that did not finish, not a deploy
// that did not happen, and the two want completely different next actions.
fail(
  lastOutcome === "timedOut"
    ? `Production is DEPLOYED, but the rollout did not finish within the deadline. A follow-up ` +
        `run resumes safely, since the backfills skip organizations already proven complete.`
    : `Production is DEPLOYED, but the rollout is INCOMPLETE. Do not record SCRUM-21 as closed.`
);
