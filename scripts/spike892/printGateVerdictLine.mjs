// SPIKE SCRUM-892 (never merged): prints the one-line verdict the real PR gate would
// publish for the counted full authenticated suite, WITHOUT publishing anything.
//
// It calls the same prE2eVerdict the real `finish` mode calls, with the same
// evidence file (g5/evidence.json, written by `trustedPrE2eGateCli.mjs evidence`),
// and fails unless that verdict is `success`. It reads no GitHub API and writes no
// check run or commit status.
import { readFileSync } from "node:fs";
import { prE2eVerdict } from "../intelligence/trustedPrE2eGate.mjs";

const evidence = JSON.parse(readFileSync("g5/evidence.json", "utf8"));
const verdict = prE2eVerdict({
  plan: { inScope: true },
  fresh: true,
  sameRepository: true,
  result: "success",
  evidence,
  headSha: process.env.HEAD_SHA,
  testedSha: process.env.TESTED_SHA,
  controllerSha: process.env.GITHUB_WORKFLOW_SHA,
});
console.log(`SPIKE gate verdict (${verdict.conclusion}): ${verdict.reason}`);
console.log(
  `SPIKE gate counts: total=${evidence.total} passed=${evidence.passed} skipped=${evidence.skipped} flaky=${evidence.flaky} definitions=${evidence.executedDefinitions.length}`,
);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**${verdict.reason}**\n`);
}
if (verdict.conclusion !== "success") {
  process.exit(1);
}
