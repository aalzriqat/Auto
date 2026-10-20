import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

// SCRUM-795: the real-backend approve-door proof in playwright/tests/accounting.spec.ts
// is registered only when E2E_SEED_LEGACY_MANUAL_JOURNAL === "1". A lane that is
// EXPECTED to prove it (trusted-main E2E) must not go green if the flag is dropped,
// because then the test is simply never registered. This reads the Playwright JSON
// report and fails unless exactly one test with the approve-door title exists and it
// passed (not skipped, not failed, not interrupted, not duplicated).
export const APPROVE_DOOR_TITLE =
  "approve of the seeded legacy draft is refused by the backend and the draft stays pending";

// The match is bound to the spec FILE, the describe block and the project, not the
// title alone, so a same-titled passing test elsewhere cannot satisfy the proof.
export const APPROVE_DOOR_FILE = "playwright/tests/accounting.spec.ts";
export const APPROVE_DOOR_DESCRIBE =
  "accounting workspace: legacy manual-journal draft (seeded lane only)";
export const APPROVE_DOOR_PROJECT = "chromium";

// Playwright reports spec.file relative to testDir ("./playwright/tests"); accept
// that or the repo-relative path. Nothing else (no suffix tricks like "x/accounting.spec.ts").
function isApproveDoorFile(file) {
  if (typeof file !== "string") return false;
  const f = file.replaceAll("\\", "/").replace(/^\.\//, "");
  return f === APPROVE_DOOR_FILE || f === APPROVE_DOOR_FILE.replace("playwright/tests/", "");
}

// `describes` is the chain of describe titles BELOW the root file suite. It must be
// exactly [APPROVE_DOOR_DESCRIBE]: no extra ancestors, no nesting of the same name.
function collectTests(suite, found, describes = []) {
  for (const spec of suite.specs ?? []) {
    if (
      spec.title === APPROVE_DOOR_TITLE &&
      describes.length === 1 &&
      describes[0] === APPROVE_DOOR_DESCRIBE &&
      isApproveDoorFile(spec.file ?? suite.file)
    ) {
      const tests = (spec.tests ?? []).filter((t) => t.projectName === APPROVE_DOOR_PROJECT);
      for (const t of tests) found.push(t);
    }
  }
  for (const child of suite.suites ?? []) collectTests(child, found, [...describes, child.title]);
}

/** Returns a list of error strings; empty means the approve door was proven. */
export function approveDoorErrors(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.suites)) {
    return ["Playwright JSON report is missing or malformed (no suites array)"];
  }
  const found = [];
  for (const suite of report.suites) collectTests(suite, found);
  if (found.length === 0) {
    return [
      `approve-door test "${APPROVE_DOOR_TITLE}" was not registered in ${APPROVE_DOOR_FILE} (describe and ${APPROVE_DOOR_PROJECT} project bound): E2E_SEED_LEGACY_MANUAL_JOURNAL was not "1" for the Playwright run, so the approve door went unproven`,
    ];
  }
  if (found.length > 1) {
    return [`approve-door test appears ${found.length} times; expected exactly one`];
  }
  const [test] = found;
  const results = test.results ?? [];
  const last = results[results.length - 1];
  // 'expected' = passed first time; 'flaky' = failed then passed on retry. Both end passed.
  if (test.status === "skipped" || last?.status === "skipped") {
    return ["approve-door test was skipped"];
  }
  if (!["expected", "flaky"].includes(test.status) || last?.status !== "passed") {
    // Fixed text only: report fields are untrusted and this reaches a public log.
    return ["approve-door test did not pass (see the uploaded Playwright report)"];
  }
  return [];
}

/** @param {string[]} argv @param {{ log: (m: string) => void, error: (m: string) => void }} [log] */
export function runCli(argv, log = console) {
  const file = argv[0];
  if (!file) {
    log.error("usage: node scripts/assertApproveDoorRan.mjs <playwright-json-report>");
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Fixed text only: a parse error can quote report content; the path is arg-supplied.
    log.error("::error::cannot read or parse the Playwright JSON report");
    return 1;
  }
  const errors = approveDoorErrors(report);
  for (const e of errors) log.error(`::error::${e}`);
  if (errors.length === 0) log.log("approve-door proof ran and passed (exactly one test)");
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
