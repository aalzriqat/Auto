import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

// SCRUM-795 / SCRUM-800: the dedicated GL-register replay lane (trusted-main-replay-e2e.yml) must PROVE the
// replay ran. A skipped test makes Playwright exit 0, so this reads the JSON report and fails unless the replay
// test itself finished "passed" (never skipped, flaky or retried) and nothing else in the run failed.
//
// The summary it prints is counts only. It never prints test titles other than the two fixed ones below, error
// text, URLs, deployment names or organization data: the repository is public and so are its logs.

export const REPLAY_SUITE_TITLE = "accounting register: a posted journal";
export const REPLAY_SPEC_TITLE = "shows its accounting date, period and balanced debit/credit totals";
// Identity of the run the report must describe: the replay's own file, run under the chromium project. The auth
// setup file is the chromium project's dependency, so it is the only other file allowed in the report.
export const REPLAY_SPEC_FILE = "accounting.spec.ts";
export const REPLAY_SETUP_FILE = "auth.setup.ts";
export const REPLAY_PROJECT = "chromium";

function* walkSpecs(suite, path = []) {
  const here = suite.title ? [...path, suite.title] : path;
  for (const spec of suite.specs ?? []) yield { spec, path: here };
  for (const child of suite.suites ?? []) yield* walkSpecs(child, here);
}

/** Returns { ok, problems, counts }. Pure: no I/O, and nothing from the report beyond numbers is returned. */
export function evaluateReplayReport(report) {
  const problems = [];
  const counts = { expected: 0, unexpected: 0, flaky: 0, skipped: 0, replayTests: 0, replayPassed: 0 };
  if (!report || typeof report !== "object" || !Array.isArray(report.suites)) {
    return { ok: false, problems: ["the Playwright JSON report is missing or unreadable"], counts };
  }
  // Fail closed on a report whose shape or identity is not the expected one.
  if (!Array.isArray(report.errors)) {
    problems.push("the report has no top-level errors list");
  } else if (report.errors.length !== 0) {
    problems.push(`the run reported ${report.errors.length} top-level error(s)`);
  }
  const projects = report.config?.projects;
  if (!Array.isArray(projects) || !projects.some((project) => project?.name === REPLAY_PROJECT)) {
    problems.push(`the report's config does not name the ${REPLAY_PROJECT} project`);
  }
  const files = report.suites.map((suite) => suite?.file);
  if (!files.includes(REPLAY_SPEC_FILE)) problems.push(`the report does not contain ${REPLAY_SPEC_FILE}`);
  if (files.some((file) => file !== REPLAY_SPEC_FILE && file !== REPLAY_SETUP_FILE)) {
    problems.push("the report contains a test file other than the replay spec and its auth setup");
  }
  for (const suite of report.suites) {
    for (const { spec, path } of walkSpecs(suite)) {
      const isReplay =
        suite.file === REPLAY_SPEC_FILE && path.includes(REPLAY_SUITE_TITLE) && spec.title === REPLAY_SPEC_TITLE;
      for (const test of spec.tests ?? []) {
        const status = test.status;
        if (status === "expected" || status === "unexpected" || status === "flaky" || status === "skipped") {
          counts[status] += 1;
        }
        if (isReplay) {
          counts.replayTests += 1;
          const results = test.results ?? [];
          const last = results[results.length - 1];
          if (
            status === "expected" &&
            spec.ok === true &&
            results.length === 1 &&
            last?.status === "passed" &&
            test.projectName === REPLAY_PROJECT
          ) {
            counts.replayPassed += 1;
          }
        }
      }
    }
  }
  if (counts.replayTests !== 1) {
    problems.push(`expected exactly one replay test in the report, found ${counts.replayTests}`);
  }
  if (counts.replayPassed !== 1) {
    problems.push("the replay test did not finish as a single passing attempt (it was skipped, failed, flaky or retried)");
  }
  // The lane's spec has no legitimate skip: the approve-door "NOT RUN" is an annotation on a passing test, not a
  // skip. So a skip anywhere in the report (a renamed replay, a new test.skip) fails the lane. There is no
  // allow-list today; add one here BY TITLE, with the reason, if a skip ever becomes legitimate.
  if (counts.skipped !== 0) problems.push(`${counts.skipped} test(s) were skipped`);
  if (counts.unexpected !== 0) problems.push(`${counts.unexpected} test(s) failed`);
  if (counts.flaky !== 0) problems.push(`${counts.flaky} test(s) were flaky`);
  return { ok: problems.length === 0, problems, counts };
}

export function renderSummary({ ok, problems, counts }) {
  const lines = [
    "### Replay lane",
    "",
    `Verdict: ${ok ? "replay ran and passed" : "FAILED"}`,
    "",
    "| Count | Value |",
    "| --- | --- |",
    `| replay tests found | ${counts.replayTests} |`,
    `| replay tests passed | ${counts.replayPassed} |`,
    `| passed | ${counts.expected} |`,
    `| failed | ${counts.unexpected} |`,
    `| flaky | ${counts.flaky} |`,
    `| skipped | ${counts.skipped} |`,
  ];
  if (!ok) lines.push("", ...problems.map((p) => `- ${p}`));
  return lines.join("\n") + "\n";
}

export function main(argv = process.argv.slice(2), env = process.env, write = console.log) {
  const file = argv[0];
  let report = null;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    report = null;
  }
  const verdict = evaluateReplayReport(report);
  const summary = renderSummary(verdict);
  write(summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  // Optional second argument: a file for the same counts-only summary (the workflow uploads it as an artifact).
  if (argv[1]) writeFileSync(argv[1], summary);
  if (!verdict.ok) write("::error::The replay lane did not prove that the GL register replay ran.");
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
