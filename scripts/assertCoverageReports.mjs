/**
 * The gate the `sonarcloud` job runs before it is allowed to scan.
 *
 * Two jobs in one entry point, deliberately: rebase the mobile report's paths
 * onto the repository root, THEN verify both reports are real evidence. They
 * were two workflow steps and the ordering between them was load-bearing but
 * only implied — verification has to happen after the rebase or every mobile
 * path fails to resolve, which reports as "151 missing files" and sends whoever
 * reads it looking for a deleted directory.
 *
 * Exits non-zero on any problem, and the calling step has no `continue-on-error`,
 * so a failure here stops the job before the scanner runs. That is intended: the
 * required Sonar context going ABSENT is the correct outcome when the evidence
 * could not be produced, and is far better than a vacuous green.
 *
 * `runCoverageGate` is separated from the process plumbing so it can be tested.
 * A CLI whose logic is only reachable by spawning it is a CLI nobody tests, and
 * this one guards a required check — see `assertCoverageReports.test.ts`.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { verifyReport } from "./verifyCoverageReports.mjs";
import { normalizeMobileCoverage } from "./normalizeMobileCoveragePaths.mjs";

export const DEFAULT_REPORTS = {
  convex: "coverage-sonar/lcov.info",
  mobile: "apps/mobile/coverage-sonar/lcov.info",
};

export function parseArgs(argv) {
  const args = { ...DEFAULT_REPORTS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--convex" && argv[i + 1]) args.convex = argv[i + 1];
    else if (argv[i] === "--mobile" && argv[i + 1]) args.mobile = argv[i + 1];
  }
  return args;
}

/**
 * Rebase, verify, and report. Returns `{ ok, lines, errors }` — the caller turns
 * that into an exit code and console output.
 *
 * `io` is injected so the tests exercise the real decisions against constructed
 * reports rather than the filesystem.
 */
export function runCoverageGate({ convex, mobile }, io) {
  const { read, write, exists, repoRoot } = io;
  const lines = [];
  const errors = [];

  if (exists(mobile)) {
    const result = normalizeMobileCoverage(read(mobile));
    if (result.errors.length > 0) {
      for (const error of result.errors.slice(0, 5)) errors.push(`${mobile}: ${error}`);
      if (result.errors.length > 5) {
        errors.push(`${mobile}: and ${result.errors.length - 5} more path problems`);
      }
    } else {
      write(mobile, result.text);
      lines.push(
        `${mobile}: rebased ${result.rewritten} source paths onto the repository root (${result.unchanged} already rebased)`
      );
    }
  }

  for (const file of [convex, mobile]) {
    const result = verifyReport(file, exists(file) ? read(file) : "", { repoRoot, exists });
    if (result.ok) {
      lines.push(
        `${file}: ${result.records} source records, ${result.measured} carrying executable-line data, all resolving to real files`
      );
    } else {
      errors.push(...result.problems);
    }
  }

  return { ok: errors.length === 0, lines, errors };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { ok, lines, errors } = runCoverageGate(args, {
    read: (file) => readFileSync(file, "utf8"),
    write: (file, text) => writeFileSync(file, text),
    exists: existsSync,
    repoRoot: process.cwd(),
  });

  for (const line of lines) console.log(line);
  for (const error of errors) console.error(`::error::${error}`);

  process.exit(ok ? 0 : 1);
}

// Only when run as a command. Without this, importing the module to test
// `runCoverageGate` would execute the gate and call process.exit on the test
// runner — which is exactly how a CLI ends up untested.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
