import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { isProtectedReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { changedFilesSince, collectScenarioExecutions, evaluate, loadRecords, PLAYWRIGHT_REQUIRED_REPORTS, readPlaywrightReports, runVitest, selectForPr, staticExecutionCensus } from "./prRunner.mjs";
import { createLocalScenarioEvidence, finishPrScenarioEvidence, readLocalScenarioEvidence, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { createGitHubReceiptTransport, hostedReplayCandidate, readProtectedReplayDiff, readPublishedLocalScenarios } from "./trustedBrowserSource.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readGit = (args, options = {}) => execFileSync(resolveTrustedGitExecutable(), args, {
  cwd: root, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options,
});

// The aggregator reads candidate definitions as Git objects. Candidate hooks,
// scripts, filesystem links and tests never run in the base checkout.
function readMergeRegistry(sha) {
  const tree = readGit(["ls-tree", "-rz", sha, "--", "regression/scenarios/"], { encoding: "utf8" });
  const hashes = tree.split("\0").filter(entry => entry.endsWith(".scenario.json")).map(entry => {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\tregression\/scenarios\//u.exec(entry);
    if (!match) throw new Error("SCENARIO_OBJECT_INVALID");
    return match[1];
  });
  if (!hashes.length || hashes.length > 10_000) throw new Error("SCENARIO_OBJECT_COUNT_INVALID");
  const batch = readGit(["cat-file", "--batch"], { input: hashes.join("\n") + "\n" });
  let offset = 0;
  const records = hashes.map(hash => {
    const end = batch.indexOf(10, offset);
    if (end < offset || end - offset > 100) throw new Error("SCENARIO_OBJECT_INVALID");
    const match = /^([a-f0-9]{40}) blob ([1-9][0-9]{0,5})$/u.exec(batch.toString("ascii", offset, end));
    if (!match || match[1] !== hash) throw new Error("SCENARIO_OBJECT_INVALID");
    const last = end + 1 + Number(match[2]);
    if (batch[last] !== 10) throw new Error("SCENARIO_OBJECT_INVALID");
    const record = JSON.parse(batch.toString("utf8", end + 1, last));
    offset = last + 1;
    return record;
  });
  if (offset !== batch.length) throw new Error("SCENARIO_OBJECT_INVALID");
  return records;
}

function writeOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function assertLocalContext(candidate) {
  const parents = readGit(["show", "-s", "--format=%H %P", "HEAD"], { encoding: "utf8" }).trim();
  if (parents !== `${candidate.testedSha} ${candidate.baseSha} ${candidate.headSha}`) throw new Error("SCENARIO_LOCAL_CONTEXT_INVALID");
}

function runLocal(candidate) {
  assertLocalContext(candidate);
  const paths = PLAYWRIGHT_REQUIRED_REPORTS.pr.map(configName =>
    ({ configName, file: path.join(root, "regression-reports", `${configName}.json`) }));
  const { reports, problems } = readPlaywrightReports(paths);
  let elapsedMs = 0;
  const execution = collectScenarioExecutions({
    root, changedFiles: changedFilesSince(root, candidate.baseSha), playwrightReports: reports, reportProblems: problems,
    requirePrReports: true,
    execute: (checkout, files, config) => {
      const started = performance.now();
      const result = runVitest(checkout, files, config);
      elapsedMs = Math.round(performance.now() - started);
      return result;
    },
  });
  const raw = createLocalScenarioEvidence(candidate, execution);
  const digest = scenarioEvidenceDigest(raw);
  const local = readLocalScenarioEvidence(raw, digest, candidate, execution.selection);
  writeFileSync(path.join(root, "regression-reports", "scenario-evidence-1.json"), raw, { flag: "wx" });
  writeOutput("evidence_digest", digest);
  console.log(JSON.stringify({ workers: 1, vitestElapsedMs: elapsedMs, backend: local.backend.length, browser: local.browser.length }));
}

function benchmarkVitest(candidate, workers) {
  assertLocalContext(candidate);
  if (process.platform === "win32" && workers !== 1) throw new Error("VITEST_BENCHMARK_REQUIRES_LINUX");
  const { records, problems } = loadRecords(root);
  if (problems.length > 0) throw new Error("SCENARIO_REGISTRY_INVALID");
  const selection = selectForPr(records, changedFilesSince(root, candidate.baseSha));
  const files = [...new Set(selection.run.map(record => record.impl?.file))].sort();
  if (!files.length || !files.every(file => typeof file === "string" && file.length > 0 && !file.startsWith("-"))) {
    throw new Error("SCENARIO_BENCHMARK_UNAVAILABLE");
  }
  const started = performance.now();
  const { report, exitCode } = runVitest(root, files, undefined, workers);
  const elapsedMs = Math.round(performance.now() - started);
  const verdicts = evaluate(selection.run, report, root);
  const evidence = JSON.stringify({ candidate, verdicts });
  console.log(JSON.stringify({ workers, elapsedMs, selected: verdicts.length,
    passed: verdicts.filter(({ code }) => code === "PASS").length, verdictDigest: scenarioEvidenceDigest(evidence) }));
  if (!report || exitCode !== 0 || verdicts.some(({ code }) => code !== "PASS")) throw new Error("SCENARIO_BENCHMARK_FAILED");
}

function benchmarkStatic(candidate, configName) {
  assertLocalContext(candidate);
  const file = path.join(root, "regression-reports", `${configName}.json`);
  const { reports, problems } = readPlaywrightReports([{ file, configName }]);
  if (problems.length || reports.length !== 1) throw new Error("PLAYWRIGHT_STATIC_REPORT_INVALID");
  const rows = staticExecutionCensus(root, reports[0]);
  console.log(JSON.stringify({ staticConfig: configName, passed: rows.length, verdictDigest: scenarioEvidenceDigest(JSON.stringify(rows)) }));
}

function aggregate(candidate) {
  const changed = readProtectedReplayDiff(root, candidate);
  const selection = selectForPr(readMergeRegistry(candidate.testedSha), changed);
  const base = loadRecords(root);
  if (base.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  const protectedSelection = selectForPr(base.records, changed).browserSelected.filter(isProtectedReplayBinding);
  const transport = createGitHubReceiptTransport({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
  const live = transport.api(`/git/ref/pull/${candidate.prNumber}/merge`);
  if (live?.object?.sha !== candidate.testedSha) throw new Error("SCENARIO_AGGREGATION_CONTEXT_STALE");
  const localRaw = readPublishedLocalScenarios({ candidate, ...transport,
    artifactId: Number(process.env.LOCAL_ARTIFACT_ID), digest: process.env.LOCAL_ARTIFACT_DIGEST });
  const summary = finishPrScenarioEvidence({ candidate, selection, protectedSelection, localRaw,
    localDigest: process.env.LOCAL_EVIDENCE_DIGEST, browserRaw: process.env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.verdict !== "PASS") process.exitCode = 1;
}

try {
  const candidate = hostedReplayCandidate(process.env, process.env.BASE_SHA);
  if (!candidate) throw new Error("SCENARIO_CONTEXT_INVALID");
  const [mode, workerArgument, ...rest] = process.argv.slice(2);
  if (mode === "local" && workerArgument === undefined) {
    runLocal(candidate);
  } else if (mode === "benchmark" && rest.length === 0 && ["1", "2", "4"].includes(workerArgument)) {
    benchmarkVitest(candidate, Number(workerArgument));
  } else if (mode === "static-census" && rest.length === 0 && PLAYWRIGHT_REQUIRED_REPORTS.pr.includes(workerArgument)) {
    benchmarkStatic(candidate, workerArgument);
  } else if (mode === "aggregate" && workerArgument === undefined) {
    aggregate(candidate);
  } else {
    throw new Error("SCENARIO_MODE_INVALID");
  }
} catch (error) {
  const code = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "SCENARIO_CERTIFICATION_UNAVAILABLE";
  console.error(code);
  process.exitCode = 1;
}
