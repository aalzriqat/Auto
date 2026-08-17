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
 * The verdict logic lives in `releaseGuard.ts` so it can be tested directly.
 * This file is deliberately only the I/O around it.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  classifyMaterializationReport,
  decidePollOutcome,
  mergeVerdicts,
  parseConvexRunJson,
  pollIntervalMs,
  renderReleaseSummary,
  requireProductionDeployKey,
} from "./releaseGuard.ts";

const REPORT_FN = "adminSystem:materializationReportForRelease";
const START_FN = "migrations:startSocialConversationBackfills";

const PAGE_SIZE = 50;
/**
 * A cursor that stops advancing would otherwise page forever. The cap is far
 * above any real tenant count; it exists to turn a hang into a report.
 */
const MAX_PAGES = 500;

/**
 * A single CLI call that never returns would strand the whole run: `spawnSync`
 * blocks, so control never reaches the deadline check again and the informative
 * summary below never gets written. The only backstop would be the job-level
 * kill, which produces nothing anyone can act on.
 */
const CLI_TIMEOUT_MS = 5 * 60_000;

const TIMEOUT_MS = Number(process.env.ROLLOUT_TIMEOUT_MINUTES ?? 45) * 60_000;

const MODE = process.env.RELEASE_MODE ?? "deploy";
const SHA = process.env.RELEASE_SHA ?? "";
const MAIN_TIP = process.env.RELEASE_MAIN_TIP ?? "";
const DEPLOYMENT = process.env.RELEASE_DEPLOYMENT || null;

/**
 * The repository-local Convex CLI, addressed directly.
 *
 * Not `pnpm exec convex`, and not because `pnpm exec` would resolve the wrong
 * package — it resolves the right one. It is that reaching it through a bare
 * command name means resolving `pnpm` itself through `PATH`, and this script's
 * whole job is to report truthfully on what a credential just did to
 * production. `process.execPath` is the running interpreter's absolute path and
 * the entry below is inside this commit's own `node_modules`, so neither is
 * looked up anywhere.
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
    mode: MODE,
    sha: SHA,
    mainTipSha: MAIN_TIP,
    deployment: DEPLOYMENT,
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
 * deployment-scoped `CONVEX_DEPLOY_KEY` the deployment comes from the key and
 * the flag is ignored with a warning — the credential is the selector, which is
 * the property that makes a protected environment worth having.
 *
 * The flag is here for the misconfiguration case. A PROJECT-scoped key with no
 * selection resolves to a deployment within the project, and without `--prod`
 * that can be the dev one — which would have this script cheerfully verify a
 * successful rollout on a deployment that is not production. That is the exact
 * shape of the 2026-08-07 incident, so the flag is a fail-safe, not a selector.
 *
 * Codegen and typechecking are disabled: this step must observe the deployment,
 * never rewrite the tree it is observing from.
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
    // stderr, because that is where the CLI puts every diagnostic it emits.
    return {
      ok: false,
      reason: `convex ${args[0]} exited ${result.status}.\n${(result.stderr ?? "").trim()}`,
    };
  }
  return parseConvexRunJson(result.stdout ?? "");
}

/** Walks every page of the report and merges the per-page verdicts. */
function collectVerdict() {
  const verdicts = [];
  let cursor = null;

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

    verdicts.push(classifyMaterializationReport(value.page));

    if (value.isDone === true) return { ok: true, verdict: mergeVerdicts(verdicts) };

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

// Checked here rather than left to the CLI so the failure names the cause. An
// unconfigured production environment otherwise surfaces as an opaque Convex
// error several steps later, at the exact moment nobody wants a puzzle.
const keyCheck = requireProductionDeployKey(process.env.CONVEX_DEPLOY_KEY);
if (!keyCheck.ok) fail(keyCheck.reason);

if (!existsSync(CONVEX_CLI)) {
  fail(`The repository-local Convex CLI is missing at ${CONVEX_CLI}. Did the install step run?`);
}

// ─── 1. Start the backfills ─────────────────────────────────────────────────

console.log(`Starting Social Inbox conversation backfills…`);
const started = convex(["run", START_FN, "{}"]);
if (!started.ok) fail(started.reason);
console.log(`  fan-out: ${JSON.stringify(started.value)}`);

// ─── 2. Refuse to finish until every org is verifiably on the fast path ──────

const startedAt = Date.now();
console.log(`Verifying the rollout (deadline ${Math.round(TIMEOUT_MS / 60_000)} minutes)…`);

// The loop variable IS the end condition: every branch below either leaves it
// at "continue" or sets a terminal value.
while (lastOutcome === "continue") {
  const collected = collectVerdict();
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
  console.warn(`  ⚠ ${p.orgName} (${p.orgId}) ${p.platform ?? "—"} ${p.kind}: ${p.detail}`);
}

if (lastOutcome === "verified") {
  writeSummary(null);
  console.log(`\n✔ Every organization is reading the materialised path.\n`);
  process.exit(0);
}

for (const p of [...lastVerdict.problems, ...lastVerdict.inFlight]) {
  console.error(`  ${p.orgName} (${p.orgId}) ${p.platform ?? "—"} ${p.kind}: ${p.detail}`);
}

// ⚠️ Production IS deployed at this point. Saying so plainly is the whole job
// of this branch: the failure is a rollout that did not finish, not a deploy
// that did not happen, and the two want completely different next actions from
// whoever reads this.
fail(
  lastOutcome === "timedOut"
    ? `Production is DEPLOYED, but the rollout did not finish within the deadline. ` +
        `The organizations still in flight are listed above — a follow-up run resumes safely, ` +
        `since the backfills skip organizations already proven complete.`
    : `Production is DEPLOYED, but the rollout is INCOMPLETE. Do not record SCRUM-21 as closed.`
);
