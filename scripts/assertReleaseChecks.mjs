#!/usr/bin/env node
/**
 * Re-derives the CI verdict at the exact commit, AFTER approval and
 * immediately before the deploy.
 *
 * ⚠️ This exists because approval is asynchronous. The `authorize` job proves
 * CI is green and then the run waits for a human — minutes, or hours. In that
 * window a check can be re-run and go red, a required workflow can be removed,
 * a waiver can expire at midnight. None of that moves `main`'s tip, so the
 * tip re-derivation next to it does not notice any of it, and the claim "CI is
 * green at that exact commit" quietly became a statement about authorisation
 * time being reported as though it were about deploy time.
 *
 * It runs from the CANDIDATE commit's checkout rather than main's, unlike the
 * authorize job — which is safe only because the step before this one has just
 * proven the candidate IS main's tip. That ordering is load-bearing: this
 * script must never run before the tip re-check.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import { describeCheck, evaluateRequiredChecks, forLog, isFullSha, isSafeApiPath } from "./releaseGuard.ts";
import { loadReleasePolicy, readCheckResults } from "./releaseChecks.mjs";

const REPO = process.env.GITHUB_REPOSITORY ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const SHA = (process.env.RELEASE_SHA ?? "").trim().toLowerCase();

function fail(reason) {
  console.error(`\n✖ REFUSED: ${reason}\n`);
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `## ❌ Release refused after approval\n\n${reason}\n\n`);
  process.exit(1);
}

if (!isFullSha(SHA)) fail(`RELEASE_SHA is not a full commit SHA (${forLog(SHA)}).`);

async function api(path, query) {
  if (!isSafeApiPath(path)) fail(`Refusing a GitHub path that is not a plain resource path: ${forLog(path)}.`);
  const url = new URL(`https://api.github.com/repos/${REPO}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "autoflow-release-guard",
    },
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

const observed = await readCheckResults(api, SHA);
if (!observed.ok) fail(observed.reason);

const policy = loadReleasePolicy();
const checks = evaluateRequiredChecks({
  required: policy.required,
  results: observed.results,
  waivers: policy.waivers,
  now: new Date(),
});

if (!checks.ok) {
  fail(
    `CI is no longer green at ${SHA}:\n` +
      checks.failures.map((f) => `  · ${f}`).join("\n") +
      `\n\nThis was green when the run was authorised. Something changed while it waited for approval.`
  );
}

console.log(`✔ CI still green at ${SHA} — ${checks.passed.length} required, ${checks.waived.length} waived.`);
for (const waiver of checks.waived) {
  console.log(`  WAIVED (not passing): ${describeCheck(waiver)} = ${waiver.observed} — ${waiver.issue}`);
}
