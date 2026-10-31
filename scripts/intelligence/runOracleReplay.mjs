import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { blobAt, classifyExplorerPair, classifyPair, gitRead, linkReplayDependencies, matchesFingerprint, prepareReplay, readVitestReport, summarizeReplay } from "./oracleReplay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const corpus = JSON.parse(readFileSync(path.join(ROOT, "scripts/intelligence/oracleReplayCorpus.json"), "utf8"));
const CORPUS_DIGEST = createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
const CONTROLLER_SHA = gitRead(ROOT, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const HARNESS_DIGEST = createHash("sha256").update([
  "scripts/intelligence/oracleReplay.mjs", "scripts/intelligence/runOracleReplay.mjs",
  "scripts/intelligence/runOracleBrowserReplay.mjs", "scripts/intelligence/oracleReplay.test.ts",
  "scripts/intelligence/oracleReplaySwarm.spec.ts",
  "scripts/intelligence/convexCredentialBoundary.test.ts",
  ".github/workflows/oracle-catch-rate.yml",
  ".github/workflows/trusted-oracle-catch-rate.yml",
].map(name => readFileSync(path.join(ROOT, name), "utf8")).join("\n")).digest("hex");
const unavailable = reason => ({ state: "unavailable", tests: 0, findings: [], reason });
const observationSchema = z.object({
  state: z.enum(["complete", "malformed", "unavailable"]), tests: z.number().int().nonnegative(),
  findings: z.array(z.string()), durationMs: z.number().nonnegative().optional(), missions: z.number().int().nonnegative().optional(),
  reason: z.string().regex(/^[A-Z0-9_]+$/).optional(),
  alertGroups: z.array(z.object({ fingerprints: z.array(z.string()).min(1) })).optional(),
}).superRefine((observation, context) => {
  if (!observation.alertGroups) return;
  const grouped = new Set(observation.alertGroups.flatMap(group => group.fingerprints));
  const findings = new Set(observation.findings);
  if (grouped.size !== findings.size || [...grouped].some(finding => !findings.has(finding))) {
    context.addIssue({ code: "custom", message: "Alert groups do not cover the observed findings" });
  }
});
const pairSchema = z.object({ fixed: observationSchema, bug: observationSchema });
const entryEvidenceSchema = z.object({
  replayElapsedMs: z.number().nonnegative().optional(),
  reproduction: z.object({ status: z.enum(["reproduced", "unavailable"]), reason: z.string().regex(/^[A-Z0-9_]+$/).optional(), fixed: observationSchema.optional(), bug: observationSchema.optional() }),
  observations: z.object({ baseline: pairSchema, explorer: pairSchema }),
});
const publicEnvironment = () => Object.fromEntries([
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "CI",
].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

function runNode(args, cwd, env, timeout = 60_000) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd, env, timeout, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(path.join(cwd, "replay-private.log"), (result.stdout ?? "") + (result.stderr ?? ""));
  // Never publish raw child output: historical backend errors can contain tenant data.
  return { exitCode: result.status, durationMs: Date.now() - started };
}

function readJson(filename) {
  try { return JSON.parse(readFileSync(filename, "utf8")); }
  catch { return undefined; }
}

/** Dependency link is removed explicitly before recursive scratch cleanup (Windows junction safety). */
function withDependencies(directory, run) {
  const cleanup = linkReplayDependencies(directory, ROOT);
  try { return run(); }
  finally { cleanup(); }
}

function runLocalSuite(directory, names) {
  if (names.length === 0 || names.some(name => !existsSync(path.join(directory, name)))) return unavailable("MISSING_PRE_FINDING_SUITE");
  const config = path.join(directory, "replay.config.mjs");
  const output = path.join(directory, "result.json");
  writeFileSync(config, `export default ${JSON.stringify({
    root: directory,
    resolve: { alias: { "@": directory, "@autoflow/shared": path.join(directory, "packages/shared/src") } },
    test: { environment: "jsdom", setupFiles: existsSync(path.join(directory, "vitest.setup.ts")) ? ["./vitest.setup.ts"] : [],
      include: names, maxWorkers: 1, fileParallelism: false, testTimeout: 15_000,
      env: { NODE_ENV: "test", CLERK_JWT_ISSUER_DOMAIN: "https://test.clerk.accounts.dev", NEXT_PUBLIC_APP_URL: "http://localhost:3000" } },
  })};\n`);
  return withDependencies(directory, () => {
    const result = runNode([path.join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", config,
      "--maxWorkers=1", "--reporter=json", `--outputFile=${output}`, ...names], directory, publicEnvironment());
    return { ...readVitestReport(readJson(output), result.exitCode), durationMs: result.durationMs };
  });
}

function witnessPair(prepared, entry) {
  // Post-finding tests are sealed reproduction witnesses. Run AFTER the detector and
  // never copy them to a browser process or include their result in detector recall.
  for (const directory of [prepared.fixed, prepared.bug]) {
    for (const name of [...entry.witnessTests, ...(entry.witnessSupport ?? [])]) {
      const contents = blobAt(ROOT, entry.fix, name);
      if (!contents) return { status: "unavailable", reason: "MISSING_WITNESS" };
      mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      writeFileSync(path.join(directory, name), contents);
    }
  }
  const fixed = runLocalSuite(prepared.fixed, entry.witnessTests);
  const bug = runLocalSuite(prepared.bug, entry.witnessTests);
  return { status: classifyPair(fixed, bug) === "caught" ? "reproduced" : "unavailable", fixed, bug };
}

export async function replayEntry(entry, { browser = false, witness = true } = {}) {
  const started = Date.now();
  const scratch = mkdtempSync(path.join(tmpdir(), "autoflow-oracle-"));
  let baseline = { fixed: unavailable("NOT_RUN"), bug: unavailable("NOT_RUN") };
  let explorer = { fixed: unavailable("BROWSER_PREVIEW_REQUIRED"), bug: unavailable("BROWSER_PREVIEW_REQUIRED") };
  let reproduction = { status: "unavailable", reason: "NOT_RUN" };
  try {
    const prepared = prepareReplay({ repository: ROOT, scratch, entry });
    baseline = { fixed: runLocalSuite(prepared.fixed, entry.baselineTests), bug: runLocalSuite(prepared.bug, entry.baselineTests) };
    if (browser) {
      const { runBrowserPair } = await import("./runOracleBrowserReplay.mjs");
      // The driver receives no finding, ruling, severity, regression path, or fix identity.
      explorer = await runBrowserPair({ fixed: prepared.fixed, bug: prepared.bug, root: ROOT });
    }
    if (witness) reproduction = witnessPair(prepared, entry);
  } catch {
    // A fixed vocabulary keeps Git diagnostics, source snippets and backend failures private.
    explorer = { fixed: unavailable("REPLAY_PREPARATION_OR_EXECUTION_FAILED"), bug: unavailable("REPLAY_PREPARATION_OR_EXECUTION_FAILED") };
  } finally {
    const resolved = path.resolve(scratch);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("autoflow-oracle-")) {
      throw new Error("Scratch cleanup boundary refused");
    }
    const danglingDependencies = ["control", "subject"].some(name => existsSync(path.join(resolved, entry.id, name, "node_modules")));
    if (danglingDependencies || process.env.ORACLE_REPLAY_KEEP_SCRATCH === "1") console.log(`Private replay scratch retained: ${resolved}`);
    else rmSync(resolved, { recursive: true, force: true });
  }
  const reproduced = reproduction.status === "reproduced";
  return {
    controllerSha: CONTROLLER_SHA, corpusSha256: CORPUS_DIGEST, harnessSha256: HARNESS_DIGEST,
    id: entry.id, severity: entry.severity, finding: entry.finding, ruling: entry.ruling, fix: entry.fix, parent: entry.parent,
    baseline: reproduced ? classifyPair(baseline.fixed, baseline.bug) : "unavailable",
    explorer: reproduced ? classifyExplorerPair(explorer.fixed, explorer.bug, entry.expectedFingerprints) : "unavailable",
    reproduction, observations: { baseline, explorer },
    replayElapsedMs: Date.now() - started,
  };
}

export function writeReplayReport(entries, directory, { browser = false } = {}) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const complete = corpus.cases.map(entry => {
    const supplied = byId.get(entry.id);
    const parsed = entryEvidenceSchema.safeParse(supplied);
    const identity = { id: entry.id, severity: entry.severity, finding: entry.finding, ruling: entry.ruling, fix: entry.fix, parent: entry.parent };
    if (!parsed.success) return { ...identity, baseline: "unavailable", explorer: "unavailable", reason: supplied ? "MALFORMED_CASE_EVIDENCE" : "MISSING_CASE_RESULT" };
    const { reproduction, observations } = parsed.data;
    const reproduced = reproduction.status === "reproduced" && classifyPair(reproduction.fixed, reproduction.bug) === "caught";
    return { ...identity, ...parsed.data,
      baseline: reproduced ? classifyPair(observations.baseline.fixed, observations.baseline.bug) : "unavailable",
      explorer: reproduced ? classifyExplorerPair(observations.explorer.fixed, observations.explorer.bug, entry.expectedFingerprints) : "unavailable" };
  });
  if (byId.size !== entries.length || entries.some(entry => !corpus.cases.some(item => item.id === entry.id))) throw new Error("Unexpected or duplicate case result");
  const metrics = summarizeReplay(complete);
  const pairs = complete.map(entry => entry.observations?.explorer).filter(Boolean);
  const groupsOf = observation => observation.alertGroups ?? observation.findings.map(fingerprint => ({ fingerprints: [fingerprint] }));
  const fixedFindings = pairs.filter(pair => pair.fixed.state === "complete").reduce((sum, pair) => sum + groupsOf(pair.fixed).length, 0);
  const truePositives = complete.filter(entry => entry.explorer === "caught").length;
  const completedControls = pairs.filter(pair => pair.fixed.state === "complete").length;
  const unadjudicatedMutantAlerts = complete.flatMap(entry => {
    const expected = corpus.cases.find(candidate => candidate.id === entry.id).expectedFingerprints;
    const observation = entry.observations?.explorer?.bug;
    if (!observation) return [];
    return groupsOf(observation).filter(group => !group.fingerprints.some(finding => expected.some(target => matchesFingerprint(finding, target))))
      .map(group => ({ caseId: entry.id, fingerprints: group.fingerprints }));
  });
  const payload = {
    version: 1, controllerSha: CONTROLLER_SHA,
    corpusSha256: CORPUS_DIGEST,
    harnessSha256: HARNESS_DIGEST, nodeVersion: process.version, platform: process.platform,
    mode: browser ? "browser-and-local" : "local-only", ...metrics,
    gate: browser ? metrics.gate : "FAIL",
    precision: completedControls === corpus.cases.length && unadjudicatedMutantAlerts.length === 0 &&
      truePositives + pairs.filter(pair => pair.fixed.state === "complete" && pair.fixed.findings.length > 0).length > 0
      ? truePositives / (truePositives + pairs.filter(pair => pair.fixed.state === "complete" && pair.fixed.findings.length > 0).length) : null,
    precisionUnit: "case-level target-family detections versus alerting fixed controls; unadjudicated mutant alerts withhold precision",
    unadjudicatedMutantAlerts,
    extraReviewAlerts: pairs.reduce((sum, pair) => sum + groupsOf(pair.fixed).length + groupsOf(pair.bug).length, 0),
    fixedControlAlerts: fixedFindings,
    extraTestLoad: pairs.reduce((sum, pair) => sum + (pair.fixed.tests ?? 0) + (pair.bug.tests ?? 0), 0),
    extraMissionLoad: pairs.reduce((sum, pair) => sum + (pair.fixed.missions ?? 0) + (pair.bug.missions ?? 0), 0),
    baselineMisses: complete.filter(entry => entry.baseline === "missed").map(entry => entry.id),
    witnessReportedTests: complete.reduce((sum, entry) => sum + (entry.reproduction?.fixed?.tests ?? 0) + (entry.reproduction?.bug?.tests ?? 0), 0),
    replayElapsedMs: complete.reduce((sum, entry) => sum + (entry.replayElapsedMs ?? 0), 0),
    durationMs: complete.reduce((sum, entry) => sum + Object.values(entry.observations ?? {}).reduce((n, pair) => n + (pair.fixed.durationMs ?? 0) + (pair.bug.durationMs ?? 0), 0), 0),
    cases: complete,
  };
  if (payload.precision === null) payload.gate = "FAIL";
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "oracle-replay.json"), JSON.stringify(payload, null, 2) + "\n");
  const percent = number => number === null ? "UNAVAILABLE" : `${(100 * number).toFixed(1)}%`;
  writeFileSync(path.join(directory, "oracle-replay.md"), [
    "# G6 historical oracle replay", "", `Gate: **${payload.gate}**. Mode: ${payload.mode}.`, "",
    `High/Critical denominator: ${metrics.highCritical}. Unavailable remains in the denominator.`,
    `Baseline recall: ${percent(metrics.baselineRecall)}. Explorer recall: ${percent(metrics.explorerRecall)}. Combined: ${percent(metrics.combinedRecall)}.`,
    `Precision: ${percent(payload.precision)}. Fixed-control alerts: ${fixedFindings}. Extra executed browser tests: ${payload.extraTestLoad}.`, "",
    "| Case | Known finding | Baseline | Explorer | Reproduced |", "| --- | --- | --- | --- | --- |",
    ...complete.map(entry => `| ${entry.id} | ${entry.finding} | ${entry.baseline} | ${entry.explorer} | ${entry.reproduction?.status ?? "unavailable"} |`), "",
    "## Misses to file", "", ...complete.filter(entry => entry.explorer === "missed").map(entry => `- ${entry.id}: ${entry.finding} (${entry.ruling})`),
    "", "## Deterministic baseline misses", "", ...complete.filter(entry => entry.baseline === "missed").map(entry => `- ${entry.id}: ${entry.finding} (${entry.ruling})`),
    "", "## Unavailable evidence", "", ...metrics.unavailable.map(id => `- ${id}: inspect the fixed-vocabulary reasons in oracle-replay.json.`),
    "", "This calibration cannot waive, remove or downgrade any existing test, hunter, review or release gate.", "",
  ].join("\n"));
  return payload;
}

async function main() {
  const args = process.argv.slice(2);
  const caseIndex = args.indexOf("--case");
  const selected = caseIndex < 0 ? corpus.cases : corpus.cases.filter(entry => entry.id === args[caseIndex + 1]);
  if (!selected.length) throw new Error("Unknown corpus id");
  const outIndex = args.indexOf("--out");
  const output = path.resolve(outIndex < 0 ? "artifacts/oracle-replay" : args[outIndex + 1]);
  const browser = args.includes("--browser");
  const aggregateIndex = args.indexOf("--aggregate");
  const entries = [];
  if (aggregateIndex >= 0) {
    const directory = path.resolve(args[aggregateIndex + 1]);
    for (const name of readdirSync(directory)) {
      const report = readJson(path.join(directory, name, "entry.json"));
      const expected = report && corpus.cases.find(entry => entry.id === report.id);
      if (expected && report.controllerSha === CONTROLLER_SHA && report.corpusSha256 === CORPUS_DIGEST && report.harnessSha256 === HARNESS_DIGEST &&
          report.fix === expected.fix && report.parent === expected.parent && report.severity === expected.severity &&
          ["caught", "missed", "unavailable"].includes(report.baseline) && ["caught", "missed", "unavailable"].includes(report.explorer)) entries.push(report);
    }
  } else {
    for (const entry of selected) {
      const result = await replayEntry(entry, { browser });
      entries.push(result);
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, "entry.json"), JSON.stringify(result, null, 2) + "\n");
      console.log(`${entry.id}: baseline=${result.baseline} explorer=${result.explorer} witness=${result.reproduction.status}`);
    }
  }
  const report = writeReplayReport(entries, output, { browser });
  console.log(`G6 ${report.gate}: ${report.cases.length} cases, ${report.unavailable.length} unavailable`);
  process.exitCode = caseIndex >= 0
    ? entries.length === 1 && entries[0].baseline !== "unavailable" && entries[0].explorer === "caught" ? 0 : 1
    : report.gate === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Oracle replay failed; no gate verdict available."); process.exitCode = 1; });
}
