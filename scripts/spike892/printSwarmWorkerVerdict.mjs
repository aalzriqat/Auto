// SPIKE SCRUM-892 (never merged): reads the attack worker's own execution evidence
// (the `browser-swarm-execution.json` attachment of the Playwright JSON report) and
// prints how many missions the worker executed and what each one concluded.
//
// A worker that never reached its attack missions does NOT count: zero missions, a
// missing attachment, a harness error or a confirmed breach all fail this step
// (cannot-run = FAIL; nothing is skipped).
import { existsSync, readFileSync, appendFileSync } from "node:fs";

const reportPath = process.argv[2] ?? "playwright-json/results.json";
if (!existsSync(reportPath)) {
  console.error(`SPIKE worker verdict: FAIL - ${reportPath} does not exist; no mission was executed.`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));

const attachments = [];
const walk = (suites) => {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          for (const attachment of result.attachments ?? []) {
            attachments.push(attachment);
          }
        }
      }
    }
    walk(suite.suites);
  }
};
walk(report.suites);

const executionAttachment = attachments.find((a) => a.name === "browser-swarm-execution.json");
if (!executionAttachment) {
  console.error("SPIKE worker verdict: FAIL - no browser-swarm-execution.json attachment; the worker never reached its missions.");
  process.exit(1);
}
let raw;
if (typeof executionAttachment.body === "string") {
  raw = Buffer.from(executionAttachment.body, "base64").toString("utf8");
} else if (typeof executionAttachment.path === "string" && existsSync(executionAttachment.path)) {
  raw = readFileSync(executionAttachment.path, "utf8");
} else {
  console.error("SPIKE worker verdict: FAIL - the execution attachment has neither a body nor a readable path.");
  process.exit(1);
}
const execution = JSON.parse(raw);
const results = Array.isArray(execution.results) ? execution.results : [];
const tally = new Map();
for (const result of results) {
  tally.set(result.outcome, (tally.get(result.outcome) ?? 0) + 1);
  console.log(`SPIKE mission ${result.missionId}: ${result.outcome}`);
}
const outcomes = [...tally.entries()].map(([k, v]) => `${k}=${v}`).join(" ");
const line =
  `SPIKE worker verdict: worker=${execution.workerId} missions_executed=${results.length} ` +
  `${outcomes} confirmed_breaches=${execution.confirmedBreachCount} harness_errors=${execution.harnessErrorCount} ` +
  `passed=${execution.passed}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${line}**\n`);
}
if (results.length === 0 || execution.passed !== true) {
  console.error(`SPIKE worker verdict: FAIL - missions_executed=${results.length} passed=${execution.passed}.`);
  process.exit(1);
}
console.log(`SPIKE worker verdict: PASS - ${results.length} missions executed to a verdict.`);
