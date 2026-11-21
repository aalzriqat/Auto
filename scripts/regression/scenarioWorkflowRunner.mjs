import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { changedFilesSince, codeUnitCompare, collectScenarioExecutions, evaluate, loadRecords, PLAYWRIGHT_REQUIRED_REPORTS, readPlaywrightReports, runVitest, selectForPr, staticExecutionCensus, summarise } from "./prRunner.mjs";
import { createLocalScenarioEvidence, preserveScenarioObligations, readLocalScenarioEvidence, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { aggregateScenarioEvidence, assertLocalScenarioContext, readProtectedScenarioRulings, readScenarioRegistry, verifyPublishedScenarioEvidence } from "./scenarioRegistrySource.mjs";
import { createGitHubReceiptTransport, hostedReplayCandidate } from "./trustedBrowserSource.mjs";

function runLocal({ root, env, log }, candidate) {
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
    appendFileSync(env.GITHUB_OUTPUT, `evidence_digest=${digest}\n`);
    log(JSON.stringify({ workers: 1, vitestElapsedMs: elapsedMs, backend: local.backend.length, browser: local.browser.length }));
    return 0;
  } catch (error) {
    const { selection, verdicts, issues, browserVerdicts } = execution;
    log(JSON.stringify(summarise(selection, verdicts, issues, browserVerdicts), null, 2));
    throw error;
  }
}

function benchmarkVitest({ root, log }, candidate, workers) {
  assertLocalScenarioContext(root, candidate);
  if (process.platform === "win32" && workers !== 1) throw new Error("VITEST_BENCHMARK_REQUIRES_LINUX");
  const { records, problems } = loadRecords(root);
  if (problems.length > 0) throw new Error("SCENARIO_REGISTRY_INVALID");
  const selection = selectForPr(records, changedFilesSince(root, candidate.baseSha));
  const files = [...new Set(selection.run.map(record => record.impl?.file))];
  if (!files.length || !files.every(file => typeof file === "string" && file.length > 0 && !file.startsWith("-"))) {
    throw new Error("SCENARIO_BENCHMARK_UNAVAILABLE");
  }
  files.sort(codeUnitCompare);
  const started = performance.now();
  const { report, exitCode } = runVitest(root, files, undefined, workers);
  const elapsedMs = Math.round(performance.now() - started);
  const verdicts = evaluate(selection.run, report, root);
  const evidence = JSON.stringify({ candidate, verdicts });
  log(JSON.stringify({ workers, elapsedMs, selected: verdicts.length,
    passed: verdicts.filter(({ code }) => code === "PASS").length, verdictDigest: scenarioEvidenceDigest(evidence) }));
  if (!report || exitCode !== 0 || verdicts.some(({ code }) => code !== "PASS")) throw new Error("SCENARIO_BENCHMARK_FAILED");
  return 0;
}

function benchmarkStatic({ root, log }, candidate, configName) {
  assertLocalScenarioContext(root, candidate);
  const file = path.join(root, "regression-reports", `${configName}.json`);
  const { reports, problems } = readPlaywrightReports([{ file, configName }]);
  if (problems.length || reports.length !== 1) throw new Error("PLAYWRIGHT_STATIC_REPORT_INVALID");
  const rows = staticExecutionCensus(root, reports[0]);
  log(JSON.stringify({ staticConfig: configName, passed: rows.length, verdictDigest: scenarioEvidenceDigest(JSON.stringify(rows)) }));
  return 0;
}

function printAggregate(summary, log) {
  log(JSON.stringify(summary, null, 2));
  return summary.verdict === "PASS" ? 0 : 1;
}

function aggregate({ root, env, log }, candidate) {
  const transport = createGitHubReceiptTransport({ repository: env.GITHUB_REPOSITORY, token: env.GH_TOKEN });
  const summary = verifyPublishedScenarioEvidence({ checkout: root, candidate, transport,
    artifactId: Number(env.LOCAL_ARTIFACT_ID), archiveDigest: env.LOCAL_ARTIFACT_DIGEST,
    localDigest: env.LOCAL_EVIDENCE_DIGEST, browserRaw: env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS });
  return printAggregate(summary, log);
}

function shadowAggregate({ env, log }, candidate) {
  const checkout = path.join(env.GITHUB_WORKSPACE, "trusted");
  const file = path.join(env.RUNNER_TEMP, "scenario-shadow", "scenario-evidence-1.json");
  if (statSync(file).size > 1024 * 1024) throw new Error("LOCAL_SCENARIO_EVIDENCE_INVALID");
  const summary = aggregateScenarioEvidence({ checkout, candidate, localRaw: readFileSync(file, "utf8"),
    localDigest: env.LOCAL_EVIDENCE_DIGEST, browserRaw: env.AUTOFLOW_VERIFIED_BROWSER_REPLAYS });
  return printAggregate(summary, log);
}

const certificateModes = Object.freeze({ local: runLocal, aggregate, shadow: shadowAggregate });

export function runScenarioWorkflow({ root, args, env, log = console.log, error = console.error }) {
  try {
    const candidate = hostedReplayCandidate(env, env.BASE_SHA);
    if (!candidate) throw new Error("SCENARIO_CONTEXT_INVALID");
    const host = { root, env, log };
    const [mode, argument, ...rest] = args;
    if (rest.length) throw new Error("SCENARIO_MODE_INVALID");
    if (argument === undefined && Object.hasOwn(certificateModes, mode)) return certificateModes[mode](host, candidate);
    if (mode === "benchmark" && ["1", "2", "4"].includes(argument)) return benchmarkVitest(host, candidate, Number(argument));
    if (mode === "static-census" && PLAYWRIGHT_REQUIRED_REPORTS.pr.includes(argument)) return benchmarkStatic(host, candidate, argument);
    throw new Error("SCENARIO_MODE_INVALID");
  } catch (failure) {
    const code = failure instanceof Error && /^[A-Z_]{1,80}$/u.test(failure.message) ? failure.message : "SCENARIO_CERTIFICATION_UNAVAILABLE";
    error(code);
    return 1;
  }
}
