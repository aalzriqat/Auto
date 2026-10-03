#!/usr/bin/env node
/**
 * SCRUM-565 D-17 (N9) — fails closed unless NO organization is mid financial
 * reset on the production deployment.
 *
 * Why: the closed `resetOrgFinancialData` gate (PR #421) would strand any org
 * that is mid-reset when it deploys. The release workflow runs this BEFORE that
 * deploy, against the query that is already live
 * (`orgResetPreflight:countOrgsWithResetInProgress`).
 *
 * NOT wired into any workflow by the PR that adds it; #421 wires the step.
 *
 * ⚠️ Everything printed is PUBLIC (public repository, public Actions logs).
 * Only totals are printed — never an org id, name or generation — and Convex
 * error text never leaves the Convex logs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  describeConvexFailure,
  forLog,
  parseConvexRunJson,
  requireBoundProductionKey,
} from "./releaseGuard.ts";

export const PREFLIGHT_FN = "orgResetPreflight:countOrgsWithResetInProgress";
export const PREFLIGHT_PROTOCOL = "SCRUM-565/N9/v1";
const PAGE_SIZE = 100;
/** A cursor that stops advancing would otherwise page forever. */
const MAX_PAGES = 1000;
/** One hung CLI call must not strand the run (spawnSync blocks). */
const CLI_TIMEOUT_MS = 5 * 60_000;

const isCount = (n) => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Walks every page through the injected `run(argsJson)` and decides.
 * `run` returns `{ ok: true, value }` or `{ ok: false, reason }`, like the
 * release scripts' CLI wrapper, so this is testable without spawning anything.
 */
export function runResetPreflight({ run, deployKey, expectedDeployment, pageSize = PAGE_SIZE, maxPages = MAX_PAGES }) {
  const keyCheck = requireBoundProductionKey(deployKey, expectedDeployment, "deploy key");
  if (!keyCheck.ok) return keyCheck;

  let cursor = null;
  let scanned = 0;
  let inProgress = 0;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const result = run(JSON.stringify({ paginationOpts: { numItems: pageSize, cursor } }));
    if (!result.ok) return result;

    const v = result.value;
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { ok: false, reason: "The preflight answer was not the expected shape." };
    }
    if (v.protocol !== PREFLIGHT_PROTOCOL) {
      return { ok: false, reason: "The preflight answer carried a missing or unexpected protocol marker." };
    }
    if (!isCount(v.scanned) || !isCount(v.inProgress) || v.inProgress > v.scanned) {
      return { ok: false, reason: "The preflight counts were not valid non-negative integers." };
    }
    if (typeof v.isDone !== "boolean") {
      return { ok: false, reason: "The preflight answer did not say whether the walk was done." };
    }
    scanned += v.scanned;
    inProgress += v.inProgress;

    if (v.isDone) {
      if (inProgress > 0) {
        return {
          ok: false,
          reason:
            `${inProgress} organization(s) are mid financial reset. Resolve case by case before ` +
            `deploying the SCRUM-565 gate — do not clear generation fields.`,
        };
      }
      return { ok: true, scanned, inProgress };
    }

    const next = v.continueCursor;
    if (typeof next !== "string" || next === "" || next === cursor) {
      return { ok: false, reason: "The preflight cursor stopped advancing; refusing to page forever." };
    }
    cursor = next;
  }

  return { ok: false, reason: `The preflight did not finish within ${maxPages} pages.` };
}

/** The repository-local Convex CLI, addressed directly (same reasoning as rolloutRelease.mjs). */
const CONVEX_CLI = path.join(process.cwd(), "node_modules", "convex", "bin", "main.js");

function convexRun(argsJson) {
  const result = spawnSync(
    process.execPath,
    [CONVEX_CLI, "run", PREFLIGHT_FN, argsJson, "--prod", "--typecheck", "disable", "--codegen", "disable"],
    { encoding: "utf8", shell: false, env: process.env, maxBuffer: 64 * 1024 * 1024, timeout: CLI_TIMEOUT_MS }
  );
  if (result.error) {
    return { ok: false, reason: `Could not run the Convex CLI: ${forLog(result.error.message)}` };
  }
  if (result.status !== 0) {
    // Built by a helper that cannot be handed the CLI's output: it is public.
    return { ok: false, reason: describeConvexFailure("run", result.status) };
  }
  return parseConvexRunJson(result.stdout ?? "");
}

export function main() {
  if (!existsSync(CONVEX_CLI)) {
    console.error(`\n✖ The repository-local Convex CLI is missing at ${CONVEX_CLI}. Did the install step run?\n`);
    return 1;
  }
  const outcome = runResetPreflight({
    run: convexRun,
    deployKey: process.env.CONVEX_DEPLOY_KEY,
    expectedDeployment: (process.env.CONVEX_PROD_DEPLOYMENT ?? "").trim(),
  });
  const rendered = renderOutcome(outcome);
  if (!outcome.ok) {
    console.error(rendered);
    return 1;
  }
  console.log(rendered);
  return 0;
}

/** The exact text `main()` prints (public logs): totals and fixed wording only. */
export function renderOutcome(outcome) {
  if (!outcome.ok) return `\n✖ ${outcome.reason}\n`;
  return `\n✔ No organization is mid financial reset (scanned ${outcome.scanned}, in progress ${outcome.inProgress}).\n`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
