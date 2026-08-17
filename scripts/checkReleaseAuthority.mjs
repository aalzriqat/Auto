#!/usr/bin/env node
/**
 * Decides whether a commit is allowed to reach production — before any
 * production credential exists in the run.
 *
 * Two properties of WHERE this executes matter more than anything it does:
 *
 * 1. **It runs in a job with no `environment:`**, so the protected environment's
 *    secrets are not merely unused here, they are unavailable. A verification
 *    step that could reach the credential it is gating would be theatre.
 *
 * 2. **It runs `main`'s copy of this file, never the candidate commit's.** The
 *    workflow checks out `github.ref` (pinned to `main`) rather than the SHA
 *    being deployed, so a commit cannot ship its own approval. That is also why
 *    every fact below is read from the GitHub API rather than a local clone:
 *    the verification job never checks out, builds, installs or executes
 *    anything from the commit it is judging.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import { decideCommitAuthority, forLog, isFullSha, isSafeApiPath, parseReleaseInputs } from "./releaseGuard.ts";

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

/**
 * Builds one path segment.
 *
 * The values reaching this are already proven to be 40 hex characters, so the
 * encoding is a no-op on every input that gets here — it is applied anyway
 * because "a validator somewhere else already guaranteed the shape" is an
 * argument that stops being true the first time someone adds a call site, and
 * because escaping at the point of construction is simply how a URL should be
 * built from a variable.
 */
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
// binding control is the `production` environment's required reviewer, because
// a modified workflow still cannot obtain the credential without a human
// approving that specific run.
if (REF !== "refs/heads/main") {
  refuse(
    `This workflow must be run from main; it was dispatched from ${JSON.stringify(REF)}. ` +
      `Running it from a branch would let that branch supply its own verification logic.`
  );
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

const parsed = parseReleaseInputs({
  sha: process.env.RELEASE_INPUT_SHA,
  confirm: process.env.RELEASE_INPUT_CONFIRM,
  mode: process.env.RELEASE_INPUT_MODE,
});
if (!parsed.ok) refuse(parsed.reason);

// ─── Facts, each from the canonical repository rather than a clone ──────────

const tip = await api(`/commits/main`);
if (tip.status !== 200) refuse(`Could not read main's tip commit (HTTP ${tip.status}).`);
const mainTipSha = String(tip.body.sha ?? "").toLowerCase();

// Proven to be 40 hex characters HERE, before it is interpolated into a URL
// path below — not merely before it is compared. `parsed.sha` already carries
// that proof from `parseReleaseInputs`. With both established, every path
// segment this script builds is a fixed-shape identifier and there is nothing
// left for a traversal or a query string to hide in.
if (!isFullSha(mainTipSha)) {
  refuse(`GitHub returned an unusable tip commit for main: ${forLog(mainTipSha)}.`);
}

const commit = await api(`/commits/${seg(parsed.sha)}`);
const commitExists = commit.status === 200;

// `compare/base...head` reports `behind` when head is contained in base and
// `identical` when they are the same commit — which is precisely "is this an
// ancestor of main". Asked of GitHub rather than of a local checkout because
// a clone's idea of `main` is only as good as its remote configuration.
let isAncestorOfMain = false;
if (commitExists) {
  if (parsed.sha === mainTipSha) {
    isAncestorOfMain = true;
  } else {
    const compare = await api(`/compare/${seg(mainTipSha)}...${seg(parsed.sha)}`);
    if (compare.status !== 200) refuse(`Could not compare ${parsed.sha} against main (HTTP ${compare.status}).`);
    isAncestorOfMain = compare.body.status === "behind" || compare.body.status === "identical";
  }
}

const authority = decideCommitAuthority({
  mode: parsed.mode,
  sha: parsed.sha,
  mainTipSha,
  commitExists,
  isAncestorOfMain,
});
if (!authority.ok) refuse(authority.reason);

// ─── Record the review state this commit arrived with ───────────────────────

// Recorded, not enforced. Branch protection is what requires review, and it
// enforces it at merge time; re-deriving that here would be inferring
// enforcement from observation. What this adds is provenance in the run log —
// which PR this commit came from, so the deploy is traceable without anyone
// having to reconstruct it later.
const pulls = await api(`/commits/${seg(parsed.sha)}/pulls`);
const describePull = (pr) => {
  const state = pr.merged_at ? `merged ${pr.merged_at}` : pr.state;
  return `#${pr.number} ${forLog(String(pr.title ?? ""), 80)} (${state})`;
};
const provenance =
  pulls.status === 200 && Array.isArray(pulls.body) && pulls.body.length > 0
    ? pulls.body.map(describePull).join(", ")
    : "_no associated pull request_";

emit("sha", authority.sha);
emit("mode", authority.mode);
emit("main_tip", mainTipSha);

const heading = authority.mode === "rollback" ? "Rollback authorised" : "Deploy authorised";
summary(
  [
    `## ✅ ${heading}`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Mode | \`${authority.mode}\` |`,
    `| Commit | \`${authority.sha}\` |`,
    `| main tip | \`${mainTipSha}\` |`,
    `| Contained in main | yes |`,
    `| Provenance | ${provenance} |`,
    "",
    authority.mode === "rollback"
      ? `> Rolling **back** to a commit that is contained in main. It was reviewed; it is simply older.`
      : `> Deploying main's current tip.`,
    "",
    `_Nothing has been deployed yet. The production credential is only reachable after a human approves the \`production\` environment for this run._`,
  ].join("\n")
);

console.log(`✔ ${heading}: ${forLog(authority.sha)} (main tip ${forLog(mainTipSha)})`);
