import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { z } from "zod";

export function classifyPair(fixed, bug) {
  if (fixed?.state !== "complete" || bug?.state !== "complete" ||
      fixed.tests <= 0 || fixed.tests !== bug.tests || fixed.findings.length > 0) return "unavailable";
  return bug.findings.length > 0 ? "caught" : "missed";
}

/** A different anomaly on a mutant is review work, not recall of the labelled finding. */
export function classifyExplorerPair(fixed, bug, expectedFingerprints) {
  const paired = classifyPair(fixed, bug);
  if (paired !== "caught") return paired;
  return bug.findings.some(finding => expectedFingerprints.some(expected => matchesFingerprint(finding, expected))) ? "caught" : "missed";
}

export function matchesFingerprint(actual, expected) {
  if (actual === expected) return true;
  const observed = actual.split(":");
  const target = expected.split(":");
  return target[0] === "swarm" && target.length === 4 && observed.length === 5 &&
    target.every((part, index) => part === observed[index]) && ["CASH", "FINANCED"].includes(observed[4]);
}

const assertionSchema = z.object({
  fullName: z.string(), status: z.enum(["passed", "failed", "pending", "skipped", "todo"]),
  failureMessages: z.array(z.string()),
});
const vitestSchema = z.object({
  numTotalTests: z.number().int().positive(), numPassedTests: z.number().int().nonnegative(),
  numFailedTests: z.number().int().nonnegative(), numPendingTests: z.number().int().nonnegative(),
  numTodoTests: z.number().int().nonnegative().optional(),
  numRuntimeErrorTestSuites: z.number().int().nonnegative().optional(),
  testResults: z.array(z.object({ status: z.string(), message: z.string().optional(), assertionResults: z.array(assertionSchema) })).min(1),
});

/** A non-zero process status alone is never a detection. Raw error text stays private. */
export function readVitestReport(input, exitCode) {
  const parsed = vitestSchema.safeParse(input);
  if (!parsed.success) return { state: "malformed", findings: [], tests: 0, reason: "INVALID_VITEST_REPORT" };
  const report = parsed.data;
  const assertions = report.testResults.flatMap(suite => suite.assertionResults);
  const findings = assertions.filter(test => test.status === "failed");
  const passed = assertions.filter(test => test.status === "passed").length;
  const unavailable = reason => ({ state: "unavailable", findings: [], tests: assertions.length, reason });
  if (exitCode === null || ![0, 1].includes(exitCode)) return unavailable("RUNNER_DID_NOT_COMPLETE");
  if (assertions.length !== report.numTotalTests || passed !== report.numPassedTests || findings.length !== report.numFailedTests) {
    return unavailable("INCONSISTENT_TEST_COUNTS");
  }
  if (report.numPendingTests || report.numTodoTests || report.numRuntimeErrorTestSuites ||
      assertions.some(test => !["passed", "failed"].includes(test.status))) return unavailable("TESTS_NOT_EXECUTED");
  if (report.testResults.some(suite => suite.message || suite.assertionResults.length === 0)) return unavailable("SUITE_ERROR");
  if ((exitCode === 0) !== (findings.length === 0)) return unavailable("EXIT_REPORT_MISMATCH");
  if (findings.some(test => test.failureMessages.length === 0 || test.failureMessages.some(message =>
    !/AssertionError|expected .* (?:to|not)|Assertion\.__VITEST_REJECTS__/s.test(message) || /timed? ?out|Cannot find|unhandled/i.test(message)))) {
    return unavailable("NON_ASSERTION_FAILURE");
  }
  return { state: "complete", tests: assertions.length, findings: findings.map(test => test.fullName) };
}

const browserObservationSchema = z.object({
  cross: z.array(z.object({ verdict: z.object({ result: z.enum(["AGREE", "DISAGREE", "UNREADABLE"]), fact: z.string() }) })).min(1),
  explorer: z.object({ steps: z.number().int().positive(), visited: z.array(z.string()).min(1), findings: z.array(z.object({ check: z.string() })) }),
  forms: z.object({ summary: z.object({ attempts: z.number().int().positive(), inconclusive: z.number().int().nonnegative() }),
    records: z.array(z.object({ verdict: z.object({ kind: z.enum(["finding", "advisory", "ok", "inconclusive"]), check: z.string() }) })).min(1) }),
  swarm: z.object({ harnessErrorCount: z.number().int().nonnegative(), results: z.array(z.object({
    missionId: z.string(), outcome: z.enum(["PASS", "CONFIRMED_BREACH", "HARNESS_ERROR"]),
    evidence: z.object({ oracle: z.object({ passed: z.boolean() }) }),
  })).min(1) }),
  manifest: z.object({ workers: z.array(z.object({ missions: z.array(z.object({ id: z.string(), invariantIds: z.array(z.string()).min(1) })).min(1) })).length(1) }),
  invocations: z.array(z.object({ missionId: z.string(), name: z.string().regex(/^[A-Za-z0-9_/]+:[A-Za-z0-9_]+$/), financingType: z.enum(["CASH", "FINANCED"]).optional() })).min(1),
});
const browserReportSchema = z.object({ stats: z.object({
  expected: z.number().int().nonnegative(), unexpected: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
}) });

export function readBrowserReport(input, observations, exitCode) {
  const parsed = browserReportSchema.safeParse(input);
  const evidence = browserObservationSchema.safeParse(observations);
  const unavailable = reason => ({ state: "unavailable", findings: [], tests: 0, reason });
  if (!parsed.success || !evidence.success) return unavailable("MISSING_OR_MALFORMED_BROWSER_EVIDENCE");
  const { stats } = parsed.data;
  const { cross, explorer, forms, swarm, manifest, invocations } = evidence.data;
  const crossFailure = cross.some(row => row.verdict.result === "DISAGREE");
  const swarmFailure = swarm.results.some(row => row.outcome === "CONFIRMED_BREACH");
  const missions = manifest.workers[0].missions;
  if (swarm.harnessErrorCount || swarm.results.some(row => row.outcome === "HARNESS_ERROR" || (row.outcome === "PASS") !== row.evidence.oracle.passed) ||
      new Set(swarm.results.map(row => row.missionId)).size !== missions.length || swarm.results.length !== missions.length ||
      swarm.results.some(row => !missions.some(mission => mission.id === row.missionId))) return unavailable("INCOMPLETE_SWARM_RUN");
  if (exitCode === null || ![0, 1].includes(exitCode) || stats.expected + stats.unexpected !== 7 || stats.skipped || stats.flaky ||
      stats.unexpected !== Number(crossFailure) + Number(swarmFailure) || (exitCode === 0) !== (stats.unexpected === 0) ||
      forms.summary.inconclusive || forms.summary.attempts !== forms.records.length ||
      cross.some(row => row.verdict.result === "UNREADABLE") || forms.records.some(row => ["inconclusive"].includes(row.verdict.kind) || row.verdict.check === "setup")) {
    return unavailable("INCOMPLETE_BROWSER_RUN");
  }
  const screenFindings = [
    ...cross.filter(row => row.verdict.result === "DISAGREE").map(row => `cross-screen:${row.verdict.fact}`),
    ...explorer.findings.filter(row => row.check !== "jev-opinion").map(row => `explorer:${row.check}`),
    ...forms.records.filter(row => row.verdict.kind === "finding").map(row => `form:${row.verdict.check}`),
  ];
  const swarmGroups = swarm.results.filter(row => row.outcome === "CONFIRMED_BREACH").map(row => {
    const mission = missions.find(candidate => candidate.id === row.missionId);
    const fingerprints = mission.invariantIds.flatMap(id => invocations
        .filter(call => call.missionId === row.missionId)
        .map(call => `swarm:${id}:${call.name}${call.financingType ? ":" + call.financingType : ""}`));
    return { fingerprints: [...new Set(fingerprints.length ? fingerprints : mission.invariantIds.map(id => `swarm:${id}`))] };
  });
  const alertGroups = [
    ...[...new Set(screenFindings)].map(fingerprint => ({ fingerprints: [fingerprint] })),
    ...swarmGroups,
  ];
  const findings = [...new Set(alertGroups.flatMap(group => group.fingerprints))];
  if ((exitCode !== 0 || stats.unexpected) && findings.length === 0) return unavailable("BROWSER_FAILURE_WITHOUT_DETERMINISTIC_FINDING");
  return { state: "complete", findings, alertGroups, tests: stats.expected + stats.unexpected, missions: missions.length };
}

/** Labels join completed observations here, never in the process driving the application. */
export function summarizeReplay(entries) {
  const high = entries.filter(entry => ["CRITICAL", "HIGH"].includes(entry.severity));
  const recall = track => high.length ? high.filter(entry => entry[track] === "caught").length / high.length : null;
  const unavailable = entries.filter(entry => [entry.baseline, entry.explorer].includes("unavailable")).map(entry => entry.id);
  const misses = entries.filter(entry => entry.explorer === "missed").map(entry => entry.id);
  return {
    cases: entries.length, highCritical: high.length,
    baselineRecall: recall("baseline"), explorerRecall: recall("explorer"),
    combinedRecall: high.length ? high.filter(entry => entry.baseline === "caught" || entry.explorer === "caught").length / high.length : null,
    incrementalCatches: entries.filter(entry => entry.baseline === "missed" && entry.explorer === "caught").map(entry => entry.id),
    misses, unavailable,
    gate: entries.length > 0 && unavailable.length === 0 && misses.length === 0 ? "PASS" : "FAIL",
    // Precision is filled only from completed paired controls, not inferred from recall.
    precision: null,
  };
}

export function gitRead(repository, args, options = {}) {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: repository, windowsHide: true, timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...options });
}

function safePath(name) {
  if (typeof name !== "string" || !name || name.startsWith("-") || name.includes("\\") ||
      name.split("/").some(part => !part || part === "." || part === "..") || path.isAbsolute(name)) {
    throw new Error("Unsafe corpus path");
  }
}

export function blobAt(repository, revision, name) {
  safePath(name);
  try { return gitRead(repository, ["show", `${revision}:${name}`]); }
  catch { return undefined; }
}

/** Keep the historical workspace package local while reusing only installed third-party dependencies. */
export function linkReplayDependencies(directory, controllerRoot) {
  const target = path.join(directory, "node_modules");
  mkdirSync(target);
  const links = [];
  const link = (source, destination) => {
    symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
    links.push(destination);
  };
  for (const entry of readdirSync(path.join(controllerRoot, "node_modules"), { withFileTypes: true })) {
    if (entry.name === "@autoflow") continue;
    // Metadata files are not needed by module resolution, and junctions address directories.
    if (entry.isDirectory() || entry.isSymbolicLink()) link(path.join(controllerRoot, "node_modules", entry.name), path.join(target, entry.name));
  }
  const shared = path.join(directory, "packages/shared");
  if (existsSync(shared)) {
    mkdirSync(path.join(target, "@autoflow"));
    link(shared, path.join(target, "@autoflow/shared"));
  }
  return () => {
    for (const filename of links.reverse()) unlinkSync(filename);
    rmSync(target, { recursive: true, force: true });
  };
}

/** Remove comments and test descriptions as syntax, not substring replacement in source. */
export function blindSource(source, filename) {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if (sf.parseDiagnostics.length) throw new Error("Historical TypeScript is unparseable");
  let ordinal = 0;
  const transform = context => root => {
    const visit = node => {
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
          /^(?:test|it|describe)(?:\.|\(|$)/.test(node.expression.getText(sf))) {
        return ts.factory.updateCallExpression(node, node.expression, node.typeArguments,
          [ts.factory.createStringLiteral(`case-${++ordinal}`), ...node.arguments.slice(1)].map(arg => ts.visitNode(arg, visit)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit);
  };
  const transformed = ts.transform(sf, [transform]);
  try { return ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]); }
  finally { transformed.dispose(); }
}

function sanitizeTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Historical symlink refused");
    if (entry.isDirectory()) sanitizeTree(filename);
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      // JS uses its own parser; TSX is explicit because JSX syntax changes parsing.
      writeFileSync(filename, blindSource(readFileSync(filename, "utf8"), filename));
    }
  }
}

/** Never checks out, resets, stashes, or mutates repository files or Git worktree metadata. */
export function prepareReplay({ repository, scratch, entry }) {
  if (!/^[0-9a-f]{40}$/.test(entry.fix) || !/^[0-9a-f]{40}$/.test(entry.parent)) throw new Error("Exact SHAs required");
  for (const name of [...entry.paths, ...entry.baselineTests]) safePath(name);
  if (!/^[a-z0-9-]+$/.test(entry.id)) throw new Error("Unsafe case id");
  const parents = gitRead(repository, ["show", "-s", "--format=%P", entry.fix], { encoding: "utf8" }).trim().split(" ");
  if (parents[0] !== entry.parent) throw new Error("Fix parent mismatch");
  const destination = path.resolve(scratch, entry.id);
  const relative = path.relative(path.resolve(repository), destination);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Scratch must be outside the source worktree");
  if (existsSync(destination)) throw new Error("Fresh scratch required");
  mkdirSync(destination, { recursive: true });
  const archive = path.join(destination, "snapshot.tar");
  const tree = gitRead(repository, ["ls-tree", "-r", entry.parent], { encoding: "utf8" });
  if (/(?:^|\n)(?:120000|160000) /.test(tree)) throw new Error("Historical links or submodules refused");
  gitRead(repository, ["archive", "--format=tar", `--output=${archive}`, entry.parent]);
  const fixed = path.join(destination, "control");
  const bug = path.join(destination, "subject");
  for (const directory of [fixed, bug]) {
    mkdirSync(directory);
    execFileSync("tar", ["-xf", archive, "-C", directory,
      "--exclude=.github", "--exclude=.claude", "--exclude=.agents", "--exclude=.codex", "--exclude=docs",
      "--exclude=regression", "--exclude=AGENTS.md", "--exclude=CLAUDE.md", "--exclude=*.test.*", "--exclude=*.spec.*"],
      { timeout: 30_000, windowsHide: true, stdio: "pipe" });
    for (const name of entry.paths) {
      if (/\.(test|spec)\./.test(name)) throw new Error("Tests cannot be a reverted production patch");
      const content = blobAt(repository, entry.fix, name);
      if (!content) throw new Error("Deleted production paths are not supported");
      mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      writeFileSync(path.join(directory, name), content);
    }
    for (const name of entry.baselineTests) {
      const content = blobAt(repository, entry.parent, name);
      if (!content) continue; // The runner records MISSING_PRE_FINDING_SUITE, never a pass.
      mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      writeFileSync(path.join(directory, name), content);
    }
  }
  const inverse = gitRead(repository, ["diff", "--binary", "--no-ext-diff", "--no-renames", entry.fix, entry.parent, "--", ...entry.paths]);
  if (inverse.length === 0) throw new Error("Empty inverse patch");
  writeFileSync(path.join(destination, "inverse.patch"), inverse);
  gitRead(bug, ["apply", "--check", "-"], { input: inverse });
  gitRead(bug, ["apply", "-"], { input: inverse });
  for (const name of entry.paths) {
    const expected = blobAt(repository, entry.parent, name);
    const actual = existsSync(path.join(bug, name)) ? readFileSync(path.join(bug, name)) : undefined;
    if (expected ? !actual?.equals(expected) : actual !== undefined) throw new Error("Inverse does not reproduce parent bytes");
  }
  for (const directory of [fixed, bug]) sanitizeTree(directory);
  return { fixed, bug };
}
