#!/usr/bin/env node
/**
 * Decides whether a commit is allowed to reach production — before any
 * production credential exists in the run.
 *
 * Two properties of WHERE this executes matter more than anything it does:
 *
 * 1. **It runs in a job with no `environment:`**, so the protected
 *    environment's secrets are not merely unused here, they are unavailable. A
 *    verification step that could reach the credential it is gating would be
 *    theatre.
 *
 * 2. **It runs `main`'s copy of this file.** The workflow checks out
 *    `github.ref` (pinned to `main`) rather than the SHA being deployed, so a
 *    commit cannot ship its own approval. That is also why every fact below is
 *    read from the GitHub API rather than a local clone: this job never checks
 *    out, builds, installs or executes anything from the commit it is judging.
 */
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import {
  decideCommitAuthority,
  evaluateRequiredChecks,
  forLog,
  isFullSha,
  isSafeApiPath,
  parseReleaseInputs,
} from "./releaseGuard.ts";

const REPO = process.env.GITHUB_REPOSITORY ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const REF = process.env.GITHUB_REF ?? "";

function refuse(reason) {
  console.error(`\n✖ REFUSED: ${reason}\n`);
  summary(`## ❌ Release refused\n\n${reason}\n`);
  process.exit(1);
}

function summary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) appendFileSync(path, `${text}\n`);
}

function emit(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${name}=${value}\n`);
}

/** Builds one path segment; a no-op on the 40-hex values that reach it. */
const seg = (value) => encodeURIComponent(String(value));

async function api(path) {
  if (!isSafeApiPath(path)) {
    refuse(`Refusing to request a GitHub path that is not a plain resource path: ${forLog(path)}.`);
  }
  const response = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "autoflow-release-guard",
    },
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

// ─── The workflow definition itself must come from main ─────────────────────

// `workflow_dispatch` runs whatever definition exists on the ref the operator
// picked, so without this a branch could carry a workflow that skips every
// check below. ⚠️ Stated honestly: this is a guard, not the boundary. The
// binding control is the `production` environment's required reviewer.
if (REF !== "refs/heads/main") {
  refuse(
    `This workflow must be run from main; it was dispatched from ${forLog(REF)}. ` +
      `Running it from a branch would let that branch supply its own verification logic.`
  );
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

const parsed = parseReleaseInputs({
  sha: process.env.RELEASE_INPUT_SHA,
  confirm: process.env.RELEASE_INPUT_CONFIRM,
});
if (!parsed.ok) refuse(parsed.reason);

// ─── Facts, each from the canonical repository rather than a clone ──────────

const tip = await api(`/commits/main`);
if (tip.status !== 200) refuse(`Could not read main's tip commit (HTTP ${tip.status}).`);
const mainTipSha = String(tip.body.sha ?? "").toLowerCase();

// Proven to be 40 hex characters HERE, before it is interpolated into a URL
// path below — not merely before it is compared.
if (!isFullSha(mainTipSha)) {
  refuse(`GitHub returned an unusable tip commit for main: ${forLog(mainTipSha)}.`);
}

const commit = await api(`/commits/${seg(parsed.sha)}`);
const commitExists = commit.status === 200;

// `compare/base...head` reports `behind` when head is contained in base and
// `identical` when they are the same commit. Asked of GitHub rather than of a
// local checkout, because a clone's idea of `main` is only as good as its
// remote configuration.
let isAncestorOfMain = false;
if (commitExists) {
  if (parsed.sha === mainTipSha) {
    isAncestorOfMain = true;
  } else {
    const compare = await api(`/compare/${seg(mainTipSha)}...${seg(parsed.sha)}`);
    if (compare.status !== 200) refuse(`Could not compare against main (HTTP ${compare.status}).`);
    isAncestorOfMain = compare.body.status === "behind" || compare.body.status === "identical";
  }
}

const authority = decideCommitAuthority({
  sha: parsed.sha,
  mainTipSha,
  commitExists,
  isAncestorOfMain,
});
if (!authority.ok) refuse(authority.reason);

// ─── CI must be green AT THIS EXACT COMMIT ──────────────────────────────────

// ⚠️ Both surfaces, because they are different APIs and a check living in one
// is invisible to the other. Actions jobs are check-runs; app integrations like
// SonarCloud and Vercel report commit statuses. Reading only one is
// indistinguishable from "everything passed".
const [checkRuns, statuses] = await Promise.all([
  api(`/commits/${seg(authority.sha)}/check-runs`),
  api(`/commits/${seg(authority.sha)}/status`),
]);
if (checkRuns.status !== 200) refuse(`Could not read check runs for this commit (HTTP ${checkRuns.status}).`);
if (statuses.status !== 200) refuse(`Could not read commit statuses (HTTP ${statuses.status}).`);

const results = [
  ...(checkRuns.body.check_runs ?? []).map((run) => ({
    name: run.name,
    conclusion: run.status === "completed" ? run.conclusion : `still ${run.status}`,
  })),
  ...(statuses.body.statuses ?? []).map((s) => ({
    name: s.context,
    conclusion: s.state === "success" ? "success" : s.state,
  })),
];

const policy = JSON.parse(readFileSync(new URL("../.github/release-waivers.json", import.meta.url), "utf8"));
const checks = evaluateRequiredChecks({
  required: policy.required,
  results,
  waivers: policy.waivers,
  now: new Date(),
});

if (!checks.ok) {
  refuse(
    `CI is not green at ${authority.sha}:\n` +
      checks.failures.map((f) => `  · ${f}`).join("\n") +
      `\n\nAncestry proves a commit was merged, not that the merge was healthy.`
  );
}

// ─── Record the review state this commit arrived with ───────────────────────

// Recorded, not enforced. Branch protection is what requires review, and it
// enforces it at merge time; re-deriving that here would be inferring
// enforcement from observation.
const pulls = await api(`/commits/${seg(authority.sha)}/pulls`);
const describePull = (pr) => `#${pr.number} (${pr.merged_at ? "merged" : pr.state})`;
const provenance =
  pulls.status === 200 && Array.isArray(pulls.body) && pulls.body.length > 0
    ? pulls.body.map(describePull).join(", ")
    : "_no associated pull request_";

emit("sha", authority.sha);
emit("main_tip", mainTipSha);

summary(
  [
    `## ✅ Deploy authorised`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Commit | \`${authority.sha}\` |`,
    `| main tip | \`${mainTipSha}\` |`,
    `| Required checks passed | ${checks.passed.length} |`,
    `| Provenance | ${provenance} |`,
    "",
    ...(checks.waived.length > 0
      ? [
          `### ⚠️ WAIVED — not passing`,
          "",
          "| Check | Issue | Expires | Why |",
          "| --- | --- | --- | --- |",
          ...checks.waived.map((w) => `| \`${w.context}\` | ${w.issue} | ${w.expires} | ${w.reason} |`),
          "",
          "_These are recorded as WAIVED. They must never be reported as passing._",
          "",
        ]
      : []),
    `_Nothing has been deployed yet. The production credential is only reachable after a human approves the \`production\` environment for this run._`,
  ].join("\n")
);

console.log(`✔ Deploy authorised: ${forLog(authority.sha)}`);
console.log(`  required passed: ${checks.passed.length}, waived: ${checks.waived.length}`);
