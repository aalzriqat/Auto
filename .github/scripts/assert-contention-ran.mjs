#!/usr/bin/env node
/**
 * SCRUM-195 — did the commitment races actually execute?
 *
 * The contention suite is the only runtime evidence that the commitment
 * authority holds under real concurrency; `convex-test` serialises and cannot
 * ask the question at all. So the one outcome that must never be possible is a
 * run that *looks* like the question was answered when it was never asked.
 *
 * That is not hypothetical. The races live in the `chromium` project, which
 * declares `dependencies: ["setup"]`. If `auth.setup.ts` fails or skips —
 * an unprovisioned Clerk identity, an empty preview database, a rotated key —
 * Playwright skips every dependent test. The races then contribute nothing at
 * all to the report, which is indistinguishable from contributing five passes
 * unless something reads the report and says so.
 *
 * This is that something. It converts three quiet outcomes into loud ones:
 *
 *   - no report at all      → the suite never ran
 *   - file not collected    → a config/filter change silently dropped it
 *   - any test skipped      → the gate was unavailable, not satisfied
 *
 * It deliberately does NOT re-judge pass/fail; Playwright's exit code already
 * does that. The single exception is `flaky`: a safety invariant that only held
 * on the retry has not been demonstrated to hold, and Playwright exits 0 on
 * flaky. For a race about double-booking inventory, "it passed the second time"
 * is not evidence — it is the thing worth looking at.
 */

import { readFileSync } from "node:fs";

const REPORT = "playwright-report/results.json";
const SPEC = "commitment-contention.spec.ts";

function fail(message) {
  console.error(`\n✖ CONTENTION EVIDENCE MISSING\n\n${message}\n`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT, "utf8"));
} catch (error) {
  fail(
    `Could not read ${REPORT} (${error.code ?? error.message}).\n` +
      `Playwright produced no machine-readable report, which means the suite\n` +
      `did not run to completion. The commitment races are UNAVAILABLE for this\n` +
      `commit — not passing. Check whether an earlier step failed or was skipped.`,
  );
}

/** Walk the suite tree; `specs` can be nested arbitrarily deep. */
function collectSpecs(node, out = []) {
  for (const spec of node.specs ?? []) out.push(spec);
  for (const child of node.suites ?? []) collectSpecs(child, out);
  return out;
}

const specs = collectSpecs({ suites: report.suites ?? [] }).filter((spec) =>
  (spec.file ?? "").endsWith(SPEC),
);

if (specs.length === 0) {
  const collected = new Set(
    collectSpecs({ suites: report.suites ?? [] }).map((s) => s.file),
  );
  fail(
    `${SPEC} contributed no tests to this run.\n\n` +
      `Files that did report: ${[...collected].join(", ") || "(none)"}\n\n` +
      `Either the spec was not collected, or every test in it was dropped\n` +
      `before execution. Either way nothing was proved about concurrency.`,
  );
}

const outcomes = specs.flatMap((spec) =>
  (spec.tests ?? []).map((t) => ({ title: spec.title, status: t.status })),
);

const skipped = outcomes.filter((o) => o.status === "skipped");
const flaky = outcomes.filter((o) => o.status === "flaky");

for (const { title, status } of outcomes) {
  console.log(`  ${status === "expected" ? "✓" : "•"} [${status}] ${title}`);
}

if (skipped.length > 0) {
  fail(
    `${skipped.length} of ${outcomes.length} commitment races were SKIPPED:\n` +
      skipped.map((o) => `  - ${o.title}`).join("\n") +
      `\n\nA skipped race is an unavailable gate, never a passing one. The most\n` +
      `likely cause is that the \`setup\` project this suite depends on failed,\n` +
      `so nothing in \`chromium\` ran.`,
  );
}

if (flaky.length > 0) {
  fail(
    `${flaky.length} of ${outcomes.length} commitment races only passed on RETRY:\n` +
      flaky.map((o) => `  - ${o.title}`).join("\n") +
      `\n\nThese assert that a car cannot be double-booked. An invariant that\n` +
      `held only the second time has not been shown to hold; Playwright exits 0\n` +
      `on flaky, so this is asserted here instead.`,
  );
}

console.log(
  `\n✓ ${outcomes.length} commitment races executed and reported a result.`,
);
