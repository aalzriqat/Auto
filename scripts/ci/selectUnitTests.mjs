/**
 * SCRUM-1025 CLI for the Tests workflow's `unit-plan` job.
 *
 *   node scripts/ci/selectUnitTests.mjs --event <name> --out <selection.json>
 *
 * Writes the decision (mode full | docs-only | impacted, a reason, and for
 * impacted the test files) to --out and to $GITHUB_OUTPUT. It exits 0 with
 * mode=full on every error: an undecidable change is the full suite, never a
 * skip. Selection uses Vitest's own `related` machinery through its Node API
 * (`getRelevantTestSpecifications`), not a home-made import graph.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyPaths } from "../skillEnforcement/policy.mjs";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { collectTestFiles } from "./testCensus.mjs";
import { buildSelection, classifyChange, parseNameStatus, parseTrackedCoverageFiles } from "./unitTestSelection.mjs";

const AUTHORITY_TEST = "convex/unifiedDealFeeAuthority.test.ts";

/** @typedef {import("./unitTestSelection.mjs").Decision} Decision */
/** @typedef {{ id: number, head_sha: string, head_branch: string, conclusion: string }} WorkflowRun */
/** @typedef {{ name: string, expired: boolean }} RunArtifact */
/** @typedef {{ workflow_runs?: WorkflowRun[], artifacts?: RunArtifact[] }} GhResponse */
/** @typedef {(args: string[]) => GhResponse | Promise<GhResponse>} GhFn  GitHub REST GET (path in args[0]) as parsed JSON */
/** @typedef {(input: { related: string[], candidates: string[] }) => string[]} ProbeFn */

/**
 * The newest successful push run of the Tests workflow on `sha` that still has
 * an unexpired `coverage-report` artifact, or null. `gh(args)` returns parsed JSON.
 */
/**
 * @param {{ repo: string, sha: string, gh: GhFn }} input
 * @returns {Promise<string | null>}
 */
export async function findBaseCoverageRun({ repo, sha, gh }) {
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const runs = await gh([
    `repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&event=push&status=success&per_page=5`,
  ]);
  for (const run of runs?.workflow_runs ?? []) {
    if (run.head_sha !== sha || run.head_branch !== "main" || run.conclusion !== "success") continue;
    const artifacts = await gh([`repos/${repo}/actions/runs/${run.id}/artifacts?name=coverage-report&per_page=5`]);
    const live = (artifacts?.artifacts ?? []).some((a) => a.name === "coverage-report" && a.expired === false);
    if (live) return String(run.id);
  }
  return null;
}

async function listRelatedWithVitest(root, files, candidates = []) {
  const { createVitest } = await import("vitest/node");
  const ctx = await createVitest("test", {
    root,
    watch: false,
    reporters: [],
    passWithNoTests: true,
    coverage: { enabled: false },
    related: files.map((file) => path.resolve(root, file)),
  });
  try {
    const specs = await ctx.getRelevantTestSpecifications(candidates);
    return specs.map((spec) => path.relative(root, spec.moduleId).split(path.sep).join("/"));
  } finally {
    await ctx.close();
  }
}

// Vitest's `related` builds each candidate's whole import graph in memory. A few
// suites (a component test that loads the real backend through convex-test's
// import.meta.glob, scripts that walk the TypeScript compiler) pull in thousands
// of modules and exhaust the heap (measured locally: >6 GB), so candidates are
// probed in chunks in child processes with a bounded heap and time. A chunk that
// fails is bisected; a single suite that still fails is INCLUDED in the
// selection, i.e. it runs. Running extra tests is the only direction a failure
// may move.
const PROBE_HEAP_MB = 3072;
const PROBE_TIMEOUT_MS = 120_000;

function probeInChild({ related, candidates }) {
  const out = execFileSync(
    process.execPath,
    [`--max-old-space-size=${PROBE_HEAP_MB}`, fileURLToPath(import.meta.url), "--probe"],
    {
      input: JSON.stringify({ related, candidates }),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  const hits = JSON.parse(out);
  if (!Array.isArray(hits)) throw new Error("probe did not return an array");
  return hits;
}

/**
 * @param {{ related: string[], candidates: string[], chunkSize?: number, probe?: ProbeFn }} input
 * @returns {string[]}
 */
export function listRelatedChunked({ related, candidates, chunkSize = 40, probe = probeInChild }) {
  const hits = new Set();
  const visit = (chunk) => {
    try {
      for (const hit of probe({ related, candidates: chunk })) hits.add(hit);
    } catch {
      if (chunk.length === 1) hits.add(chunk[0]);
      else {
        const middle = Math.ceil(chunk.length / 2);
        visit(chunk.slice(0, middle));
        visit(chunk.slice(middle));
      }
    }
  };
  for (let offset = 0; offset < candidates.length; offset += chunkSize) visit(candidates.slice(offset, offset + chunkSize));
  return [...hits];
}

async function probeMain() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { related, candidates } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify(await listRelatedWithVitest(process.cwd(), related, candidates)));
  process.exit(0);
}

const git = (root, args) => execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * GitHub REST GET through `fetch`, authenticated with the job's token, so no
 * program is resolved through PATH (Sonar S4036). A non-2xx answer or a missing
 * token throws, and `decide` turns any throw into the full suite.
 * @type {GhFn}
 */
export async function ghJson([requestPath]) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is not set");
  const response = await fetch(`https://api.github.com/${requestPath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub GET ${requestPath.split("?")[0]} answered ${response.status}`);
  return response.json();
}

/**
 * @param {{ root: string, event: string | undefined, repo: string, gh?: GhFn, listRelated?: (files: string[]) => string[] | Promise<string[]> }} input
 * @returns {Promise<Decision>}
 */
export async function decide({ root, event, repo, gh = ghJson, listRelated }) {
  if (event !== "pull_request") return { mode: "full", reason: `event '${event}' always runs the full suite` };
  // The checkout is the PR merge commit: first parent = the base it was merged
  // into, second = the head. Anything else is not understood, so it is full.
  const parents = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
  if (parents.length !== 2) return { mode: "full", reason: "HEAD is not a two-parent merge commit" };
  const [baseSha] = parents;
  const changed = parseNameStatus(git(root, ["diff", "--name-status", "--no-renames", baseSha, "HEAD"]));

  let baseRunId = null;
  const first = classifyChange({ event, changed, baseCoverageAvailable: true });
  if (first.mode === "docs-only") {
    try {
      baseRunId = await findBaseCoverageRun({ repo, sha: baseSha, gh });
    } catch {
      baseRunId = null;
    }
    const final = classifyChange({ event, changed, baseCoverageAvailable: baseRunId !== null });
    return final.mode === "docs-only" ? { ...final, baseRunId, baseSha } : final;
  }
  if (first.mode !== "impacted") return first;

  const census = collectTestFiles(root).filter((file) => file !== AUTHORITY_TEST);
  const tracked = parseTrackedCoverageFiles(readFileSync(path.join(root, "vitest.config.ts"), "utf8"));
  // The always-run suites are already selected; only the rest need the graph.
  const alwaysRun = new Set(
    census.filter((file) => {
      const c = classifyPaths([file]);
      return c.sensitive.length > 0 || c.gate.length > 0;
    }),
  );
  const candidates = census.filter((file) => !alwaysRun.has(file));
  const related = listRelated ?? ((files) => listRelatedChunked({ related: files, candidates }));
  return buildSelection({ census, changed, trackedCoverageFiles: tracked, listRelated: related });
}

/**
 * Decide, write the decision to `--out` and to `$GITHUB_OUTPUT`. Never throws
 * for an undecidable change: that is mode=full.
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @param {string} cwd
 * @returns {Promise<Decision>}
 */
export async function main(args, env, cwd) {
  const arg = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const out = arg("--out");
  if (!out) throw new Error("--out is required");
  /** @type {Decision} */
  let decision;
  try {
    decision = await decide({ root: cwd, event: arg("--event"), repo: env.GITHUB_REPOSITORY ?? "" });
  } catch (error) {
    decision = { mode: "full", reason: `selection failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  writeFileSync(path.resolve(cwd, out), `${JSON.stringify(decision, null, 2)}\n`);
  const oneLine = String(decision.reason).replace(/[\r\n]+/g, " ").slice(0, 300);
  console.log(`unit test selection: mode=${decision.mode} (${oneLine})`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `mode=${decision.mode}\nreason=${oneLine}\nbase_run_id=${decision.baseRunId ?? ""}\nbase_sha=${decision.baseSha ?? ""}\n`,
    );
  }
  return decision;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--probe") await probeMain();
  else await main(process.argv.slice(2), process.env, process.cwd());
}