import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";
import { changedFilesSince, collectScenarioExecutions, evaluate, loadRecords, parseScenarioRecords, PLAYWRIGHT_REQUIRED_REPORTS, readPlaywrightReports, runVitest, selectForPr, staticExecutionCensus, summarise } from "./prRunner.mjs";
import { createLocalScenarioEvidence, finishPrScenarioEvidence, preserveScenarioObligations, readLocalScenarioEvidence, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { createGitHubReceiptTransport, hostedReplayCandidate, readProtectedReplayDiff, readPublishedLocalScenarios } from "./trustedBrowserSource.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readGit = (checkout, args, options = {}) => execFileSync(resolveTrustedGitExecutable(), args, {
  cwd: checkout, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options,
});

// The aggregator reads candidate definitions as Git objects. Candidate hooks,
// scripts, filesystem links and tests never run in the base checkout.
export function readScenarioRegistry(checkout, sha) {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/u.test(sha)) throw new Error("SCENARIO_GIT_REVISION_INVALID");
  const tree = readGit(checkout, ["ls-tree", "-rz", sha, "--", "regression/scenarios/"], { encoding: "utf8" });
  const blobs = tree.split("\0").filter(entry => entry.endsWith(".scenario.json")).map(entry => {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(regression\/scenarios\/.+)$/u.exec(entry);
    if (!match) throw new Error("SCENARIO_OBJECT_INVALID");
    return { hash: match[1], file: match[2] };
  });
  if (!blobs.length || blobs.length > 10_000) throw new Error("SCENARIO_OBJECT_COUNT_INVALID");
  const batch = readGit(checkout, ["cat-file", "--batch"], { input: blobs.map(({ hash }) => hash).join("\n") + "\n" });
  let offset = 0;
  const entries = blobs.map(({ hash, file }) => {
    const end = batch.indexOf(10, offset);
    if (end < offset || end - offset > 100) throw new Error("SCENARIO_OBJECT_INVALID");
    const match = /^([a-f0-9]{40}) blob ([1-9][0-9]{0,5})$/u.exec(batch.toString("ascii", offset, end));
    if (!match || match[1] !== hash) throw new Error("SCENARIO_OBJECT_INVALID");
    const last = end + 1 + Number(match[2]);
    if (batch[last] !== 10) throw new Error("SCENARIO_OBJECT_INVALID");
    offset = last + 1;
    return { file, read: () => batch.toString("utf8", end + 1, last) };
  });
  if (offset !== batch.length) throw new Error("SCENARIO_OBJECT_INVALID");
  const registry = parseScenarioRecords(entries);
  if (registry.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  return registry.records;
}

function writeOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function protectedRulings(checkout, baseSha) {
  const snapshot = JSON.parse(readGit(checkout, ["cat-file", "blob", `${baseSha}:regression/rulings.json`], { encoding: "utf8" }));
  if (!Array.isArray(snapshot)) throw new Error("SCENARIO_RULINGS_INVALID");
  return snapshot;
}

function assertLocalContext(candidate) {
  const parents = readGit(root, ["show", "-s", "--format=%H %P", "HEAD"], { encoding: "utf8" }).trim();
  if (parents !== `${candidate.testedSha} ${candidate.baseSha} ${candidate.headSha}`) throw new Error("SCENARIO_LOCAL_CONTEXT_INVALID");
}

function runLocal(candidate) {
  assertLocalContext(candidate);
  const paths = PLAYWRIGHT_REQUIRED_REPORTS.pr.map(configName =>
    ({ configName, file: path.join(root, "regression-reports", `${configName}.json`) }));
  const { reports, problems } = readPlaywrightReports(paths);
  const changed = changedFilesSince(root, candidate.baseSha);
  const registry = loadRecords(root);
  if (registry.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  preserveScenarioObligations({ baseRecords: readScenarioRegistry(root, candidate.baseSha), candidateRecords: registry.records,
    selection: selectForPr(registry.records, changed), changed, protectedRulings: protectedRulings(root, candidate.baseSha) });
  let elapsedMs = 0;
  const execution = collectScenarioExecutions({
    root, changedFiles: changed, playwrightReports: reports, reportProblems: problems,
    requirePrReports: true,
    execute: (checkout, files, config) => {
      const started = performance.now();
      const result = runVitest(checkout, files, config);
      elapsedMs = Math.round(performance.now() - started);
      return result;
    },
  });
  try {
    const raw = createLocalScenarioEvidence(candidate, execution);
    const digest = scenarioEvidenceDigest(raw);
    const local = readLocalScenarioEvidence(raw, digest, candidate, execution.selection);
    writeFileSync(path.join(root, "regression-reports", "scenario-evidence-1.json"), raw, { flag: "wx" });
    writeOutput("evidence_digest", digest);
    console.log(JSON.stringify({ workers: 1, vitestElapsedMs: elapsedMs, backend: local.backend.length, browser: local.browser.length }));
  } catch (error) {
    const { selection, verdicts, issues, browserVerdicts } = execution;
    console.log(JSON.stringify(summarise(selection, verdicts, issues, browserVerdicts), null, 2));
    throw error;
  }
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

export function aggregateScenarioEvidence({ checkout, candidate, localRaw, localDigest, browserRaw }) {
  const changed = readProtectedReplayDiff(checkout, candidate);
  const candidateRecords = readScenarioRegistry(checkout, candidate.testedSha);
  const selection = selectForPr(candidateRecords, changed);
  const base = loadRecords(checkout);
  if (base.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  const protectedSelection = preserveScenarioObligations({ baseRecords: base.records, candidateRecords, selection, changed,
    protectedRulings: protectedRulings(checkout, candidate.baseSha) });
  return finishPrScenarioEvidence({ candidate, selection, protectedSelection, localRaw, localDigest, browserRaw });
}

function aggregate(candidate) {
  const transport = createGitHubReceiptTransport({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
  const live = transport.api(`/git/ref/pull/${candidate.prNumber}/merge`);
  if (live?.object?.sha !== candidate.testedSha) throw new Error("SCENARIO_AGGREGATION_CONTEXT_STALE");
  const localRaw = readPublishedLocalScenarios({ candidate, ...transport,
    artifactId: Number(process.env.LOCAL_ARTIFACT_ID), digest: process.env.LOCAL_ARTIFACT_DIGEST });
  reportAggregate(root, candidate, localRaw);
}

function reportAggregate(checkout, candidate, localRaw) {
  const summary = aggregateScenarioEvidence({ checkout, candidate, localRaw, localDigest: process.env.LOCAL_EVIDENCE_DIGEST,
    browserRaw: process.env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.verdict !== "PASS") process.exitCode = 1;
}

function shadowAggregate(candidate) {
  const checkout = path.join(process.env.GITHUB_WORKSPACE, "trusted");
  const evidence = path.join(process.env.RUNNER_TEMP, "scenario-shadow", "scenario-evidence-1.json");
  if (statSync(evidence).size > 1024 * 1024) throw new Error("LOCAL_SCENARIO_EVIDENCE_INVALID");
  reportAggregate(checkout, candidate, readFileSync(evidence, "utf8"));
}

function main() {
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
  } else if (mode === "shadow" && workerArgument === undefined) {
    shadowAggregate(candidate);
  } else {
    throw new Error("SCENARIO_MODE_INVALID");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "SCENARIO_CERTIFICATION_UNAVAILABLE";
    console.error(code);
    process.exitCode = 1;
  }
}
