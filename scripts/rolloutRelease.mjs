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
  decidePollOutcome,
  mergeVerdicts,
  parseConvexRunJson,
  pollIntervalMs,
  renderReleaseSummary,
  requireBoundProductionKey,
} from "./releaseGuard.ts";

const REPORT_FN = "adminSystem:materializationReportForRelease";
const START_FN = "migrations:startSocialConversationBackfills";

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
    return { ok: false, reason: `Could not run the Convex CLI: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `convex ${args[0]} exited ${result.status}.\n${(result.stderr ?? "").trim()}`,
    };
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

    if (value.isDone === true) return { ok: true, verdict: mergeVerdicts(verdicts), orgs };

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

// ─── 2. Start the backfills ─────────────────────────────────────────────────

console.log(`Starting Social Inbox conversation backfills…`);
const started = convex(["run", START_FN, "{}"]);
if (!started.ok) fail(started.reason);
console.log(`  fan-out: ${JSON.stringify(started.value)}`);

// ─── 3. Refuse to finish until every org is verifiably on the fast path ──────

const startedAt = Date.now();
console.log(`Verifying the rollout (deadline ${Math.round(TIMEOUT_MS / 60_000)} minutes)…`);

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
