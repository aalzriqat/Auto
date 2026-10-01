// @vitest-environment node
//
// Behavioural harness for .github/workflows/sonar-pr-report.yml (SCRUM-494).
//
// The text pins in prWorkflowSecretBoundary.test.ts cannot tell a working gate
// from a mutated one (`|| true`, a dropped wait, a reordered post). This suite
// extracts the real `run:` scripts of the `report` and `Publish trusted Sonar
// verdict` steps, executes them with bash against stub `curl` / `git` / `node`
// (helper only) / `jq` / `sleep` binaries placed first on PATH, and asserts on
// what was actually requested and posted.
//
// `jq` is stubbed with a tiny evaluator for exactly the filters the scripts use
// so results do not depend on the host having jq; an unsupported filter fails
// loudly (exit 3) so editing a filter forces a matching shim update.
//
// SONAR_PR_WORKFLOW_FILE points the harness at another copy of the workflow
// (used to prove failing-first against an older revision and to run mutations).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type Step = { id?: string; name?: string; run?: string; with?: Record<string, unknown>; uses?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const workflowPath = process.env.SONAR_PR_WORKFLOW_FILE
  ? path.resolve(process.env.SONAR_PR_WORKFLOW_FILE)
  : path.resolve(process.cwd(), ".github/workflows/sonar-pr-report.yml");
const workflow = parseYaml(readFileSync(workflowPath, "utf8")) as Workflow;
function requireStep(job: string, label: string, pick: (s: Step) => boolean): Step {
  const step = workflow.jobs[job].steps.find(pick);
  if (!step) throw new Error(`workflow step not found: ${label}`);
  return step;
}
const reportStep = requireStep("scan-report", "report", (s) => s.id === "report");
const verdictStep = requireStep("verdict", "Publish trusted Sonar verdict", (s) => s.name === "Publish trusted Sonar verdict");
const scanStep = requireStep("scan-report", "SonarSource/sonarqube-scan-action", (s) => String(s.uses ?? "").startsWith("SonarSource/sonarqube-scan-action"));
const sanitizeStep = requireStep("scan-report", "Sanitize scanner inputs", (s) => s.name === "Sanitize scanner inputs");
const sanitizeScript = String(sanitizeStep.run ?? "").replace(/\r/g, "");
const reportScript = String(reportStep.run ?? "").replace(/\r/g, "");
const verdictScript = String(verdictStep.run ?? "").replace(/\r/g, "");

function findBash(): string | null {
  const candidates = [process.env.BASH_FOR_TESTS, "C:\\Program Files\\Git\\bin\\bash.exe", "bash"].filter(Boolean) as string[];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return c;
  }
  return null;
}
const bash = findBash();

const fwd = (p: string) => p.replace(/\\/g, "/");
// Git Bash rewrites the inherited (Windows-form) PATH itself, so the stub dir is
// prepended from inside bash in POSIX form: "C:/x" -> "/c/x".
const posixPath = (p: string) => fwd(p).replace(/^([A-Za-z]):/, (_m, d: string) => "/" + d.toLowerCase());
const PREPEND_STUBS = 'PATH="$1:$PATH"; shift; exec bash --noprofile --norc -eo pipefail "$@"';

const CURL_STUB = String.raw`
const fs = require("fs"), path = require("path");
const sc = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8"));
const dir = path.dirname(process.env.STUB_SCENARIO);
const args = process.argv.slice(2);
let method = "GET", url = null, get = false, body = null; const q = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-X") method = args[++i];
  else if (a === "-H" || a === "--header" || a === "--retry") i++;
  else if (a === "--data" || a === "--data-binary") { let v = args[++i]; if (v.startsWith("@")) v = fs.readFileSync(v.slice(1), "utf8"); body = v; }
  else if (a === "--data-urlencode") { const [k, ...r] = args[++i].split("="); q.push(k + "=" + encodeURIComponent(r.join("="))); }
  else if (a === "--get") get = true;
  else if (a.startsWith("-")) { /* flag without value */ }
  else url = a;
}
const full = url + (q.length ? "?" + q.join("&") : "");
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: "curl", method, url: full, body }) + "\n");
const route = sc.routes.find((r) => (r.method || "GET") === method && full.includes(r.match));
if (!route) { process.stderr.write("UNROUTED " + method + " " + full + "\n"); process.exit(22); }
const cf = path.join(dir, "counters.json");
const counters = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, "utf8")) : {};
const key = route.method + " " + route.match;
const n = counters[key] || 0; counters[key] = n + 1; fs.writeFileSync(cf, JSON.stringify(counters));
const seq = route.seq || [route.body === undefined ? "" : route.body];
const item = seq[Math.min(n, seq.length - 1)];
if (item && item.fail) process.exit(22);
process.stdout.write(typeof item === "string" ? item : JSON.stringify(item));
`;

const GIT_STUB = String.raw`
const fs = require("fs");
const sc = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8")).git || {};
let args = process.argv.slice(2);
if (args[0] === "-C") args = args.slice(2);
const joined = args.join(" ");
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: "git", args: joined }) + "\n");
if (args[0] === "fetch") {
  if ((sc.fetchFail || []).some((s) => joined.includes(s))) { process.stderr.write("fatal: stub fetch failure\n"); process.exit(128); }
  process.exit(0);
}
if (args[0] === "rev-parse") {
  const ref = args[args.length - 1];
  const hit = Object.keys(sc.revParse || {}).find((k) => ref.includes(k));
  if (!hit) { process.stderr.write("fatal: unknown ref\n"); process.exit(128); }
  process.stdout.write(sc.revParse[hit] + "\n"); process.exit(0);
}
process.stderr.write("git stub: unsupported " + joined + "\n"); process.exit(3);
`;

const JQ_STUB = String.raw`
const fs = require("fs");
const args = process.argv.slice(2);
let slurpRaw = false, filter = null; const vars = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-r") continue;
  if (a === "-Rs") slurpRaw = true;
  else if (a === "--arg") { vars[args[i + 1]] = args[i + 2]; i += 2; }
  else if (filter === null) filter = a;
}
const input = fs.readFileSync(0, "utf8");
const out = (v) => process.stdout.write(String(v) + "\n");
const unsupported = () => { process.stderr.write("jq stub: unsupported filter: " + filter + "\n"); process.exit(3); };
if (slurpRaw) { if (!filter.includes("{body: .}")) unsupported(); process.stdout.write(JSON.stringify({ body: input })); process.exit(0); }
let data; try { data = JSON.parse(input); } catch { process.stderr.write("jq stub: invalid json\n"); process.exit(2); }
if (filter.includes("contains($marker)")) {
  const hit = (Array.isArray(data) ? data : []).find((c) => String(c.body || "").includes(vars.marker));
  if (hit) out(hit.id); process.exit(0);
}
if (filter.includes('select(.status == "ERROR")')) {
  for (const c of (data.projectStatus && data.projectStatus.conditions) || []) if (c.status === "ERROR")
    out("- " + c.metricKey + ": actual " + (c.actualValue ?? "n/a") + ", threshold " + (c.errorThreshold ?? "n/a") + ", comparator " + (c.comparator ?? "n/a"));
  process.exit(0);
}
if (filter.trim() === ".total // (.issues | length)") { out(data.total ?? (data.issues || []).length); process.exit(0); }
const m = filter.trim().match(/^\.([A-Za-z_]+(?:\.[A-Za-z_]+)*)(?: \/\/ (empty|"([^"]*)"))?$/);
if (!m) unsupported();
let v = data; for (const k of m[1].split(".")) v = v == null ? undefined : v[k];
if (v === undefined || v === null || v === false) {
  if (m[2] === "empty") process.exit(0);
  out(m[3] !== undefined ? m[3] : "null"); process.exit(0);
}
out(typeof v === "object" ? JSON.stringify(v) : v);
`;

type Call = { tool: string; method?: string; url?: string; body?: string | null; args?: string };
type Route = { method?: string; match: string; body?: unknown; seq?: unknown[] };

let stubDir = "";
let workRoot = "";

beforeAll(() => {
  if (!bash) return;
  stubDir = mkdtempSync(path.join(tmpdir(), "sonar-stubs-"));
  const sd = fwd(stubDir);
  const wrap = (name: string, js: string) => {
    writeFileSync(path.join(stubDir, name + ".js"), js);
    writeFileSync(path.join(stubDir, name), `#!/bin/bash\nexec "$REAL_NODE" "${sd}/${name}.js" "$@"\n`, { mode: 0o755 });
  };
  wrap("curl", CURL_STUB);
  wrap("git", GIT_STUB);
  wrap("jq", JQ_STUB);
  writeFileSync(path.join(stubDir, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  // node: only the merge-identity helper is stubbed; every other use (payload
  // building via `node -e`) is the real interpreter.
  writeFileSync(
    path.join(stubDir, "node"),
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    *mergeContentIdentity.mjs)
      printf '{"tool":"helper","args":"%s"}\\n' "$*" >> "$STUB_LOG"
      case "$STUB_SAME_MODE" in
        SAME) echo SAME ;;
        DIFFERENT) echo DIFFERENT ;;
        EMPTY) ;;
        FAIL) exit 1 ;;
        *) echo "bad STUB_SAME_MODE" >&2; exit 3 ;;
      esac
      exit 0 ;;
  esac
done
exec "$REAL_NODE" "$@"
`,
    { mode: 0o755 },
  );
  workRoot = mkdtempSync(path.join(tmpdir(), "sonar-run-"));
});

afterAll(() => {
  for (const d of [stubDir, workRoot]) if (d) rmSync(d, { recursive: true, force: true });
});

type RunResult = { status: number | null; stdout: string; stderr: string; githubOutput: string; calls: Call[] };

function runScript(
  script: string,
  opts: { env: Record<string, string>; routes?: Route[]; git?: Record<string, unknown>; same?: string; reportTask?: string | null; setup?: (dir: string, runnerTemp: string) => void },
): RunResult {
  const dir = mkdtempSync(path.join(workRoot, "case-"));
  const runnerTemp = path.join(dir, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  if (opts.reportTask != null) {
    mkdirSync(path.join(runnerTemp, "sonar-scannerwork"), { recursive: true });
    writeFileSync(path.join(runnerTemp, "sonar-scannerwork", "report-task.txt"), opts.reportTask);
  }
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "calls.jsonl");
  const ghOut = path.join(dir, "github_output");
  writeFileSync(scenario, JSON.stringify({ routes: opts.routes ?? [], git: opts.git ?? {} }));
  writeFileSync(log, "");
  writeFileSync(ghOut, "");
  opts.setup?.(dir, runnerTemp);
  writeFileSync(path.join(dir, "step.sh"), script);
  const env: NodeJS.ProcessEnv = { ...process.env };
  Object.assign(env, {
    REAL_NODE: fwd(process.execPath),
    STUB_SCENARIO: fwd(scenario),
    STUB_LOG: fwd(log),
    STUB_SAME_MODE: opts.same ?? "SAME",
    GITHUB_OUTPUT: fwd(ghOut),
    GITHUB_STEP_SUMMARY: fwd(path.join(dir, "summary.md")),
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_SERVER_URL: "https://github.test",
    GITHUB_REPOSITORY: "org/repo",
    GITHUB_RUN_ID: "42",
    RUNNER_TEMP: fwd(runnerTemp),
    ...opts.env,
  });
  const r = spawnSync(bash as string, ["--noprofile", "--norc", "-c", PREPEND_STUBS, "_", posixPath(stubDir), fwd(path.join(dir, "step.sh"))], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Call);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, githubOutput: readFileSync(ghOut, "utf8"), calls };
}

const PR = "7";
const HEAD = "a".repeat(40);
const TESTED = "b".repeat(40);
const REGEN = "c".repeat(40);
const OTHER = "d".repeat(40);
const CE = "CE_task-1";
const ANALYSIS = "AN_new-2";

const reportTaskTxt = (id: string) =>
  `organization=aalzriqat\nprojectKey=aalzriqat_Auto\nserverUrl=https://sonarcloud.io\nceTaskId=${id}\nceTaskUrl=https://sonarcloud.io/api/ce/task?id=${id}\n`;

function reportRun(o: {
  ce?: unknown[];
  newGate?: string;
  priorGate?: string;
  reportTask?: string | null;
  headNow?: string;
  same?: string;
}) {
  const routes: Route[] = [
    { match: `/pulls/${PR}`, body: { head: { sha: o.headNow ?? HEAD } } },
    { match: "/ce/task", seq: o.ce ?? [{ task: { status: "SUCCESS", analysisId: ANALYSIS } }] },
    { match: `qualitygates/project_status?analysisId=${ANALYSIS}`, body: { projectStatus: { status: o.newGate ?? "OK" } } },
    // The gate of the latest PROCESSED analysis for the PR: a prior, stale OK.
    { match: `qualitygates/project_status?projectKey=aalzriqat_Auto&pullRequest=${PR}`, body: { projectStatus: { status: o.priorGate ?? "OK" } } },
    { match: "issues/search", body: { total: 0, issues: [] } },
    { match: `/issues/${PR}/comments`, body: [] },
    { method: "POST", match: `/issues/${PR}/comments`, body: {} },
  ];
  return runScript(reportScript, {
    env: {
      SONAR_TOKEN: "t",
      GH_TOKEN: "g",
      REPOSITORY: "org/repo",
      PR_NUMBER: PR,
      HEAD_SHA: HEAD,
      PROJECT_KEY: "aalzriqat_Auto",
      COMMENT_MARKER: "<!-- autoflow-sonar-pr-report -->",
      TESTED_SHA: TESTED,
    },
    routes,
    git: { revParse: { "sonar-report-merge": TESTED } },
    same: o.same,
    reportTask: o.reportTask === undefined ? reportTaskTxt(CE) : o.reportTask,
  });
}

const posts = (r: RunResult, needle: string) => r.calls.filter((c) => c.tool === "curl" && c.method === "POST" && c.url?.includes(needle));
const gateOk = (r: RunResult) => /^gate_ok=true$/m.test(r.githubOutput);
const expectFailClosed = (r: RunResult) => {
  expect(gateOk(r)).toBe(false);
  expect(r.status).not.toBe(0);
};
const gateUrls = (r: RunResult) => r.calls.filter((c) => c.url?.includes("qualitygates/project_status")).map((c) => c.url);
const isSonarHost = (url?: string): boolean => {
  if (!url) return false;
  try {
    return new URL(url).hostname === "sonarcloud.io";
  } catch {
    return false;
  }
};

describe.skipIf(!bash)("sonar-pr-report.yml `report` step behaviour", () => {
  it("extracts the report and verdict scripts", () => {
    expect(reportScript).toContain("gate_ok=true");
    expect(verdictScript).toContain("post_status");
  });

  it("scan writes its working directory outside the candidate tree at the path the report step reads", () => {
    const args = String(scanStep.with?.args ?? "");
    expect(args).toContain("-Dsonar.working.directory=${{ runner.temp }}/sonar-scannerwork");
    expect(reportScript).toContain("$RUNNER_TEMP/sonar-scannerwork/report-task.txt");
  });

  it("does NOT emit gate_ok when a prior analysis is OK but this run's analysis (CE task PENDING then SUCCESS) is ERROR", () => {
    const r = reportRun({
      ce: [{ task: { status: "PENDING" } }, { task: { status: "IN_PROGRESS" } }, { task: { status: "SUCCESS", analysisId: ANALYSIS } }],
      newGate: "ERROR",
      priorGate: "OK",
    });
    expectFailClosed(r);
    // The comment is still written before the gate verdict fails the step.
    expect(posts(r, `/issues/${PR}/comments`)).toHaveLength(1);
  });

  it("does NOT emit gate_ok while the CE task never finishes (bounded wait, fail closed)", { timeout: 60_000 }, () => {
    const r = reportRun({ ce: [{ task: { status: "PENDING" } }], priorGate: "OK" });
    expectFailClosed(r);
    expect(gateUrls(r).every((u) => !u?.includes("pullRequest="))).toBe(true);
  });

  it.each(["FAILED", "CANCELED"])("fails closed when the CE task is %s even if a prior analysis is OK", (status) => {
    const r = reportRun({ ce: [{ task: { status } }], priorGate: "OK" });
    expectFailClosed(r);
    expect(posts(r, `/issues/${PR}/comments`)).toHaveLength(0);
  });

  it("fails closed when the CE task succeeds without an analysisId", () => {
    const r = reportRun({ ce: [{ task: { status: "SUCCESS" } }], priorGate: "OK" });
    expectFailClosed(r);
  });

  it.each([
    ["absent report-task.txt", null],
    ["file without ceTaskId", "organization=aalzriqat\nprojectKey=aalzriqat_Auto\n"],
    ["empty ceTaskId", "ceTaskId=\n"],
    ["malformed ceTaskId", "ceTaskId=abc def;rm -rf\n"],
    ["ambiguous duplicate ceTaskId", "ceTaskId=one\nceTaskId=two\n"],
  ])("fails closed on %s", (_label, reportTask) => {
    const r = reportRun({ reportTask, priorGate: "OK" });
    expectFailClosed(r);
  });

  it("emits gate_ok=true only for the OK gate of this run's analysis, queried by analysisId", () => {
    const r = reportRun({ ce: [{ task: { status: "IN_PROGRESS" } }, { task: { status: "SUCCESS", analysisId: ANALYSIS } }], newGate: "OK" });
    expect(r.status).toBe(0);
    expect(gateOk(r)).toBe(true);
    expect(gateUrls(r)).toEqual([expect.stringContaining(`analysisId=${ANALYSIS}`)]);
    expect(posts(r, `/issues/${PR}/comments`)).toHaveLength(1);
  });

  it("stale head skips with exit 0, no gate_ok, and never touches Sonar", () => {
    const r = reportRun({ headNow: OTHER });
    expect(r.status).toBe(0);
    expect(gateOk(r)).toBe(false);
    expect(r.calls.some((c) => isSonarHost(c.url))).toBe(false);
  });

  it("stale merge skips the comment and gate_ok with exit 0 even when the gate is OK", () => {
    const r = reportRun({ same: "DIFFERENT" });
    expect(r.status).toBe(0);
    expect(gateOk(r)).toBe(false);
    expect(posts(r, `/issues/${PR}/comments`)).toHaveLength(0);
  });
});

function verdictRun(o: {
  gateOk?: string;
  scanResult?: string;
  current?: string;
  mergeFetchFails?: boolean;
  testedFetchFails?: boolean;
  same?: string;
}) {
  const fetchFail: string[] = [];
  if (o.mergeFetchFails) fetchFail.push("sonar-final-merge");
  if (o.testedFetchFails) fetchFail.push(`origin ${TESTED}`);
  return runScript(verdictScript, {
    env: {
      GH_TOKEN: "g",
      TESTED_SHA: TESTED,
      SCAN_RESULT: o.scanResult ?? "success",
      GATE_OK: o.gateOk ?? "true",
      PR_NUMBER: PR,
    },
    routes: [{ method: "POST", match: "/statuses/", body: {} }],
    git: { fetchFail, revParse: { "sonar-final-merge": o.current ?? TESTED } },
    same: o.same,
  });
}

const TESTED_FAILURE = [{ sha: TESTED, state: "failure", context: "autoflow/trusted-sonar-pr" }];

function statuses(r: RunResult): Array<{ sha: string; state: string; context: string }> {
  return posts(r, "/statuses/").map((c) => {
    const body = JSON.parse(String(c.body)) as { state: string; context: string };
    return { sha: String(c.url).split("/statuses/")[1], state: body.state, context: body.context };
  });
}

describe.skipIf(!bash)("sonar-pr-report.yml `Publish trusted Sonar verdict` step behaviour", () => {
  it("settles TESTED_SHA with failure, and posts nowhere else, when the merge-ref fetch fails", () => {
    const r = verdictRun({ mergeFetchFails: true });
    expect(statuses(r)).toEqual(TESTED_FAILURE);
    expect(r.status).not.toBe(0);
  });

  it("equal SHA + SAME + gate OK posts success to TESTED_SHA only and exits 0", () => {
    const r = verdictRun({});
    expect(statuses(r)).toEqual([{ sha: TESTED, state: "success", context: "autoflow/trusted-sonar-pr" }]);
    expect(r.status).toBe(0);
    // The helper still had to answer, even for byte-equal SHAs.
    expect(r.calls.some((c) => c.tool === "helper")).toBe(true);
  });

  it("regenerated content-identical merge posts success on both SHAs", () => {
    const r = verdictRun({ current: REGEN });
    expect(statuses(r).map((s) => `${s.sha}:${s.state}`).sort()).toEqual([`${REGEN}:success`, `${TESTED}:success`].sort());
    expect(r.status).toBe(0);
  });

  it("regenerated merge whose tested SHA cannot be fetched is stale: failure on TESTED_SHA only", () => {
    const r = verdictRun({ current: REGEN, testedFetchFails: true });
    expect(statuses(r)).toEqual(TESTED_FAILURE);
    expect(r.status).not.toBe(0);
  });

  it.each([
    ["EMPTY", "helper prints nothing", REGEN],
    ["DIFFERENT", "helper says DIFFERENT", REGEN],
    ["FAIL", "helper exits non-zero", REGEN],
    ["EMPTY", "byte-equal SHA but helper does not answer SAME", TESTED],
  ])("helper %s (%s) posts failure on TESTED_SHA only", (same, _label, current) => {
    const r = verdictRun({ current, same });
    expect(statuses(r)).toEqual(TESTED_FAILURE);
    expect(r.status).not.toBe(0);
  });

  it.each(["", "false"])("GATE_OK=%j yields failure even on a SAME merge", (gate) => {
    const r = verdictRun({ gateOk: gate });
    expect(statuses(r).find((s) => s.sha === TESTED)?.state).toBe("failure");
    expect(statuses(r).some((s) => s.state === "success")).toBe(false);
    expect(r.status).not.toBe(0);
  });

  it("failed scan job yields failure", () => {
    const r = verdictRun({ scanResult: "failure", gateOk: "" });
    expect(statuses(r)).toEqual(TESTED_FAILURE);
    expect(r.status).not.toBe(0);
  });
});

const VALIDATOR_PATH = path.resolve(process.cwd(), ".github/scripts/validateLcovSources.cjs");
const LCOV_OK = "TN:\nSF:convex/a.ts\nDA:1,1\nend_of_record\n";

// `testedMergeFile`: undefined = write `tested`-independent default; null = file absent.
function sanitizeRun(o: { testedMergeFile?: string | null; same?: string; mergeFetchFails?: boolean }) {
  const coverageMerge = o.testedMergeFile === undefined ? TESTED : o.testedMergeFile;
  const fetchFail: string[] = [];
  if (o.mergeFetchFails) fetchFail.push(`origin ${REGEN}`);
  return runScript(sanitizeScript, {
    env: { TESTED_SHA: TESTED },
    git: { fetchFail },
    same: o.same,
    setup: (dir, runnerTemp) => {
      // The candidate merge checkout must contain the source LCOV_OK names: the trusted
      // validator refuses an SF record that is not an existing regular file there.
      mkdirSync(path.join(dir, "candidate", "convex"), { recursive: true });
      writeFileSync(path.join(dir, "candidate", "convex", "a.ts"), "export {};\n");
      // Real CI runs the validator from the trusted checkout; stage the real script there.
      mkdirSync(path.join(dir, "trusted", ".github", "scripts"), { recursive: true });
      copyFileSync(VALIDATOR_PATH, path.join(dir, "trusted", ".github", "scripts", "validateLcovSources.cjs"));
      writeFileSync(path.join(dir, "trusted", "sonar-project.properties"), "sonar.projectKey=x\n");
      const cov = path.join(runnerTemp, "sonar-coverage");
      mkdirSync(cov, { recursive: true });
      writeFileSync(path.join(cov, "lcov.info"), LCOV_OK);
      if (coverageMerge !== null) writeFileSync(path.join(cov, "tested-merge-sha.txt"), coverageMerge + "\n");
    },
  });
}

const expectRefused = (r: RunResult, message: RegExp) => {
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toMatch(message);
  // A refusal must stop before the scanner inputs are staged.
  expect(r.stdout + r.stderr).not.toMatch(/lcov.info exceeds/);
};

describe.skipIf(!bash)("sonar-pr-report.yml `Sanitize scanner inputs` coverage-merge refusal behaviour", () => {
  it("extracts the sanitize script", () => {
    expect(sanitizeScript).toContain("same_merge");
  });

  it("byte-equal SHAs + helper SAME proceeds and exits 0", () => {
    const r = sanitizeRun({ testedMergeFile: TESTED });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.tool === "helper")).toBe(true);
    expect(r.calls.some((c) => c.tool === "git" && c.args?.includes("fetch"))).toBe(false);
  });

  it("regenerated merge (different SHA, helper SAME) proceeds and exits 0 after fetching it", () => {
    const r = sanitizeRun({ testedMergeFile: REGEN });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.tool === "git" && c.args?.includes(`fetch --no-tags origin ${REGEN}`))).toBe(true);
    expect(r.stdout).toContain("content-identical");
  });

  it.each([
    ["DIFFERENT", REGEN],
    ["EMPTY", REGEN],
    ["FAIL", REGEN],
    ["DIFFERENT", TESTED],
    ["EMPTY", TESTED],
    ["FAIL", TESTED],
  ])("helper %s with coverage merge %s.. is refused (non-zero)", (same, merge) => {
    const r = sanitizeRun({ testedMergeFile: merge, same });
    expectRefused(r, /content differs from the analysed merge/);
    expect(r.calls.some((c) => c.tool === "helper")).toBe(true);
  });

  it("coverage merge that cannot be fetched is refused, even though the helper would say SAME", () => {
    const r = sanitizeRun({ testedMergeFile: REGEN, mergeFetchFails: true, same: "SAME" });
    expectRefused(r, /cannot be fetched from origin/);
    expect(r.calls.some((c) => c.tool === "helper")).toBe(false);
  });

  it.each([
    ["too short", "abc123"],
    ["non-hex 40 chars", "z".repeat(40)],
    ["injection attempt", "$(touch pwned)" + "a".repeat(30)],
    ["empty", ""],
  ])("malformed tested-merge-sha.txt (%s) is refused even though the helper would say SAME", (_label, content) => {
    const r = sanitizeRun({ testedMergeFile: content, same: "SAME" });
    expectRefused(r, /malformed tested merge/);
    expect(r.calls.some((c) => c.tool === "helper" || c.tool === "git")).toBe(false);
  });

  it("missing tested-merge-sha.txt is refused", () => {
    const r = sanitizeRun({ testedMergeFile: null, same: "SAME" });
    expectRefused(r, /does not name its tested merge/);
    expect(r.calls.some((c) => c.tool === "helper")).toBe(false);
  });
});