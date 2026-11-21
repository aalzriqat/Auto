import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFilesSince, collectScenarioExecutions, evaluate, loadRecords, PLAYWRIGHT_REQUIRED_REPORTS, readPlaywrightReports, runVitest, selectForPr, staticExecutionCensus, summarise } from "./prRunner.mjs";
import { createLocalScenarioEvidence, preserveScenarioObligations, readLocalScenarioEvidence, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { aggregateScenarioEvidence, assertLocalScenarioContext, readProtectedScenarioRulings, readScenarioRegistry, verifyPublishedScenarioEvidence } from "./scenarioRegistrySource.mjs";
import { createGitHubReceiptTransport, hostedReplayCandidate } from "./trustedBrowserSource.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function writeOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function runLocal(candidate) {
  assertLocalScenarioContext(root, candidate);
  const paths = PLAYWRIGHT_REQUIRED_REPORTS.pr.map(configName =>
    ({ configName, file: path.join(root, "regression-reports", `${configName}.json`) }));
  const { reports, problems } = readPlaywrightReports(paths);
  const changed = changedFilesSince(root, candidate.baseSha);
  const registry = loadRecords(root);
  if (registry.problems.length) throw new Error("SCENARIO_REGISTRY_INVALID");
  preserveScenarioObligations({ baseRecords: readScenarioRegistry(root, candidate.baseSha), candidateRecords: registry.records,
    selection: selectForPr(registry.records, changed), changed, protectedRulings: readProtectedScenarioRulings(root, candidate.baseSha) });
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
  assertLocalScenarioContext(root, candidate);
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
  assertLocalScenarioContext(root, candidate);
  const file = path.join(root, "regression-reports", `${configName}.json`);
  const { reports, problems } = readPlaywrightReports([{ file, configName }]);
  if (problems.length || reports.length !== 1) throw new Error("PLAYWRIGHT_STATIC_REPORT_INVALID");
  const rows = staticExecutionCensus(root, reports[0]);
  console.log(JSON.stringify({ staticConfig: configName, passed: rows.length, verdictDigest: scenarioEvidenceDigest(JSON.stringify(rows)) }));
}

function aggregate(candidate) {
  const transport = createGitHubReceiptTransport({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN });
  const summary = verifyPublishedScenarioEvidence({ checkout: root, candidate, transport,
    artifactId: Number(process.env.LOCAL_ARTIFACT_ID), archiveDigest: process.env.LOCAL_ARTIFACT_DIGEST,
    localDigest: process.env.LOCAL_EVIDENCE_DIGEST, browserRaw: process.env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS });
  printAggregate(summary);
}

function printAggregate(summary) {
  console.log(JSON.stringify(summary, null, 2));
  if (summary.verdict !== "PASS") process.exitCode = 1;
}

function shadowAggregate(candidate) {
  const checkout = path.join(process.env.GITHUB_WORKSPACE, "trusted");
  const evidence = path.join(process.env.RUNNER_TEMP, "scenario-shadow", "scenario-evidence-1.json");
  if (statSync(evidence).size > 1024 * 1024) throw new Error("LOCAL_SCENARIO_EVIDENCE_INVALID");
  const summary = aggregateScenarioEvidence({ checkout, candidate, localRaw: readFileSync(evidence, "utf8"),
    localDigest: process.env.LOCAL_EVIDENCE_DIGEST, browserRaw: process.env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS });
  printAggregate(summary);
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

try {
  main();
} catch (error) {
  const code = error instanceof Error && /^[A-Z_]{1,80}$/u.test(error.message) ? error.message : "SCENARIO_CERTIFICATION_UNAVAILABLE";
  console.error(code);
  process.exitCode = 1;
}
