// SPIKE SCRUM-892 (never merged): prints the rehearsal's own pass banner from the
// evidence file and refuses anything but "every required case passed".
// Zero cases, a skipped/unproven case, or a count different from the required
// case set is a failure (cannot-run = FAIL).
import { readFileSync } from "node:fs";
import { bannerForSummary } from "../accountingPreviewRehearsal.mjs";
import { REQUIRED_REHEARSAL_CASE_IDS } from "../accountingRehearsalCases.mjs";

const [file] = process.argv.slice(2);
const evidence = JSON.parse(readFileSync(file, "utf8"));
const summary = evidence.summary;
const banner = bannerForSummary(summary).trim();
console.log(banner);
const required = REQUIRED_REHEARSAL_CASE_IDS.length;
const expected = `REHEARSAL PASSED: ${required} of ${required} cases.`;
if (required === 0 || banner !== expected || summary.total !== required || summary.passed !== required) {
  console.error(`Expected exactly "${expected}" but the evidence says ${summary.passed} of ${summary.total}.`);
  process.exit(1);
}
console.log(`Case-count assertion held: ${banner}`);
