#!/usr/bin/env node
/**
 * The only supported way to deploy this project to production Convex.
 *
 * Run it as `pnpm deploy:prod`. The dev counterpart is `pnpm dev:push`, and the
 * two are named so that neither can be mistaken for the other at a glance —
 * that confusion is what the 2026-08-07 incident ran on.
 *
 * What this adds over `npx convex deploy`:
 *
 *   1. Refuses `-y`/`--yes`. Convex already prints the production deployment and
 *      asks before writing; `-y` silences that, and silencing it is what turned
 *      a question into an incident. The prompt is the last line of defence and
 *      you have to answer it yourself.
 *   2. Refuses untracked files under `convex/`. That directory is bundled from
 *      disk, so an untracked scratch module deploys exactly like committed code
 *      while being invisible to every diff, review and CI check.
 *   3. Refuses a dirty tree and unmerged commits.
 *   4. Resolves and prints the real target first via `convex deploy --dry-run`,
 *      so the deployment name is on screen before anything is pushed.
 *
 * It deliberately does NOT take a `--force`. Every check here has a cheap,
 * honest resolution — commit the file, merge the branch, drop the flag — and an
 * override on a guard like this is a way to disarm it by habit.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  describeTargetSelection,
  evaluateProdDeploy,
  parsePorcelain,
} from "./deployGuard.ts";

const argv = process.argv.slice(2);
const allowBehind = argv.includes("--allow-behind");
const forwardedArgs = argv.filter((a) => a !== "--allow-behind");

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Like `git`, but only strips the trailing newline.
 *
 * `--porcelain=v1` encodes staged-vs-unstaged in the first two columns, so a
 * merely-modified file is " M path" with a **leading space**. Trimming the whole
 * output eats that space on the first line and every subsequent `slice(3)` then
 * cuts one character into the path — which reported "ackage.json" for
 * "package.json". Formats with significant leading whitespace do not survive a
 * convenience trim.
 */
function gitRaw(args) {
  return execFileSync("git", args, { encoding: "utf8" }).replace(/\r?\n$/, "");
}

function collectSnapshot() {
  // Fetch first: every staleness judgement below is worthless against a stale
  // remote ref, and "is this merged?" is precisely such a judgement.
  execFileSync("git", ["fetch", "origin", "--quiet"], { stdio: "inherit" });

  const { trackedChanges, untrackedPaths } = parsePorcelain(
    gitRaw(["status", "--porcelain=v1"])
  );

  const headSha = git(["rev-parse", "HEAD"]);
  const originMainSha = git(["rev-parse", "origin/main"]);

  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", headSha, "origin/main"],
    { stdio: "ignore" }
  );

  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    headSha,
    originMainSha,
    headIsAncestorOfOriginMain: ancestor.status === 0,
    trackedChanges,
    untrackedPaths,
    forwardedArgs,
    env: {
      CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
      CONVEX_DEPLOY_KEY: process.env.CONVEX_DEPLOY_KEY,
    },
  };
}

const snapshot = collectSnapshot();
const { ok, checks, failures } = evaluateProdDeploy(snapshot, { allowBehind });

console.log("\nProduction deploy preconditions\n");
for (const check of checks) {
  console.log(`  ${check.ok ? "ok  " : "FAIL"}  ${check.id}: ${check.detail}`);
}
console.log(`\n${describeTargetSelection(snapshot.env)}\n`);

if (!ok) {
  console.error(
    `Refusing to deploy: ${failures.length} precondition(s) failed. Nothing was pushed.\n`
  );
  process.exit(1);
}

// Resolve and show the actual target before pushing anything. `--dry-run` runs
// the real resolution the deploy would use and stops short of writing, so this
// is the target, not an inference about it.
console.log("Resolving the target deployment (dry run, nothing is pushed)…\n");
const dryRun = spawnSync(
  "npx",
  ["convex", "deploy", "--dry-run", ...forwardedArgs],
  { stdio: "inherit", shell: process.platform === "win32" }
);
if (dryRun.status !== 0) {
  console.error("\nDry run failed. Not deploying.\n");
  process.exit(dryRun.status ?? 1);
}

console.log(
  "\nThe deployment named above is the one that will be written.\n" +
    "Convex will now ask you to confirm it. Read the deployment name in that prompt.\n"
);

const deploy = spawnSync("npx", ["convex", "deploy", ...forwardedArgs], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(deploy.status ?? 1);
