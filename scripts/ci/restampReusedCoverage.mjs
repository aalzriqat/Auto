/**
 * SCRUM-1025: a documentation-only pull request has the same code as its base
 * commit, so the Sonar hand-off re-uses the base commit's `coverage-report`
 * (produced by a full push run of this workflow on that exact commit) instead
 * of re-running every test. The trusted Sonar PR workflow binds coverage to the
 * tested merge by `tested-merge-sha.txt`, so the re-used report is re-stamped
 * for THIS run's merge commit and labelled with where it came from.
 *
 *   node scripts/ci/restampReusedCoverage.mjs <coverage-dir> <base-sha> <base-run-id>
 *
 * Fails (exit 1) on a missing or empty lcov.info, or a malformed argument: a
 * report that cannot be shown to exist is never stamped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function buildProvenance({ env, lcov, baseSha, baseRunId }) {
  return {
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    event_name: env.GITHUB_EVENT_NAME,
    workflow: env.GITHUB_WORKFLOW,
    run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT,
    repository: env.GITHUB_REPOSITORY,
    lcovBytes: Buffer.byteLength(lcov),
    lcovSha256: createHash("sha256").update(lcov).digest("hex"),
    sfRecords: (lcov.match(/^SF:/gm) || []).length,
    daRecords: (lcov.match(/^DA:/gm) || []).length,
    reusedFromSha: baseSha,
    reusedFromRunId: baseRunId,
    timestamp: new Date().toISOString(),
  };
}

export function restamp({ dir, baseSha, baseRunId, env }) {
  if (!/^[0-9a-f]{40}$/.test(baseSha ?? "")) throw new Error("base sha must be a full 40-character SHA");
  if (!/^\d+$/.test(baseRunId ?? "")) throw new Error("base run id must be numeric");
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? "")) throw new Error("GITHUB_SHA must be a full 40-character SHA");
  const lcovPath = path.join(dir, "lcov.info");
  if (!existsSync(lcovPath) || statSync(lcovPath).size === 0) throw new Error("re-used coverage has no lcov.info content");
  const lcov = readFileSync(lcovPath, "utf8");
  if (!/^SF:/m.test(lcov)) throw new Error("re-used lcov.info has no source records");
  writeFileSync(path.join(dir, "tested-merge-sha.txt"), `${env.GITHUB_SHA}\n`);
  writeFileSync(
    path.join(dir, "coverage-provenance.json"),
    JSON.stringify(buildProvenance({ env, lcov, baseSha, baseRunId }), null, 2),
  );
}

/**
 * The command line: exit status 0 after re-stamping, 1 with a `::error::`
 * annotation when anything about the re-used report cannot be shown.
 * @param {string[]} argv  [coverage-dir, base-sha, base-run-id]
 * @param {Record<string, string | undefined>} env
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [out]
 * @returns {number}
 */
export function runCli(argv, env, out = console) {
  const [dir, baseSha, baseRunId] = argv;
  try {
    restamp({ dir, baseSha, baseRunId, env });
    out.log(`Re-used coverage from ${baseSha} (run ${baseRunId}) re-stamped for ${env.GITHUB_SHA}.`);
    return 0;
  } catch (error) {
    out.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2), process.env);
}
