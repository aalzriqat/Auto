// SCRUM-1005: runs the Bombadil signed-out explorer against a LOCAL build, one
// run per entry point, and writes a truthful verdict. There is no skip path:
// anything that stops an entry from really being explored is CANNOT_RUN and the
// process exits non-zero. The pure decision logic is in ./verdict.mjs, the trace
// readers in ./trace.mjs; `run` takes its side effects as `deps` so tests drive
// it in process. This is a library: no top-level side effect and no "am I the
// main module" test. The command line entry is ./runPublicSurface.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  countStates,
  offOriginStates,
  violatedNames,
  visitedPaths,
} from "./trace.mjs";
import {
  BINARIES,
  ENTRY_POINTS,
  MIN_STATES_PER_ENTRY,
  decideVerdict,
  perEntrySeconds,
  preflightRefusal,
  timeLimitSeconds,
} from "./verdict.mjs";

export * from "./trace.mjs";
export * from "./verdict.mjs";

/**
 * Child environment: no secrets; Chrome only needs the basic Linux environment
 * (same idea as AUTOFLOW_TRUSTED_EXPLORER in playwright.scenarios.config.ts).
 * @param {Record<string, string | undefined>} source
 */
export function scrubbedEnv(source = process.env) {
  const keep = ["PATH", "HOME", "LANG"];
  return Object.fromEntries(
    keep.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
  );
}

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export function parseArgs(argv, env = process.env) {
  const opts = {
    baseUrl: env.BOMBADIL_BASE_URL ?? "http://127.0.0.1:3000",
    timeLimit: env.BOMBADIL_TIME_LIMIT ?? "5m",
    outDir: env.BOMBADIL_OUT_DIR ?? DEFAULT_OUT_DIR,
    minStates: Number(env.BOMBADIL_MIN_STATES ?? MIN_STATES_PER_ENTRY),
    // Off by default: GitHub's ubuntu-latest Chrome has a working sandbox. A
    // root-user container needs it; opt in with BOMBADIL_NO_SANDBOX=1.
    noSandbox: env.BOMBADIL_NO_SANDBOX === "1",
    allowHost: undefined,
    bin: env.BOMBADIL_BIN,
  };
  // Every accepted flag is listed here. Nothing is forwarded to Bombadil, in
  // particular not --allow-url: its match patterns could widen the run onto
  // production from a loopback base URL.
  const flags = {
    "--base-url": "baseUrl",
    "--time-limit": "timeLimit",
    "--out-dir": "outDir",
    "--allow-host": "allowHost",
    "--bombadil-bin": "bin",
    "--min-states": "minStates",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}`);
    if (i + 1 >= argv.length) throw new Error(`missing value for ${argv[i]}`);
    const value = argv[i + 1];
    opts[key] = key === "minStates" ? Number(value) : value;
    i++;
  }
  return opts;
}

/** The real side effects; tests pass fakes with the same shape. */
export const realDeps = {
  spawn: (bin, args, options) => spawnSync(bin, args, options),
  fetchStatus: async (baseUrl) => {
    try {
      // redirect: "manual" (fetch standard): a 3xx is returned as it is, so a
      // redirected health answer is not 200 and the run is CANNOT_RUN.
      const res = await fetch(new URL("/api/health", baseUrl), {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      return res.status;
    } catch {
      return undefined;
    }
  },
  exists: (file) => existsSync(file),
  remove: (file) => rmSync(file, { force: true }),
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  write: (file, text) => writeFileSync(file, text),
  log: (line) => console.log(line),
};

const DEFAULT_OUT_DIR = "test-results/bombadil";

/** A CANNOT_RUN result whose only problem is `reason`. */
function cannotRun(reason) {
  return {
    verdict: "CANNOT_RUN",
    reason,
    violations: [],
    problems: [reason],
    entries: [],
  };
}

/** Why exploration cannot start even though the platform and host are fine. */
function startupProblem(deps, bin, timeLimit, totalSeconds) {
  if (!deps.exists(bin)) return `missing binary ${bin}`;
  if (Number.isNaN(totalSeconds)) return `bad time limit ${timeLimit}`;
  return undefined;
}

function exploreEntry(deps, ctx, entry, seconds) {
  const { bin, opts, root } = ctx;
  const trace = path.join(opts.outDir, `trace-${entry.slug}.bin`);
  const args = [
    "browser",
    "test",
    "--headless",
    ...(opts.noSandbox ? ["--no-sandbox"] : []),
    "--time-limit",
    `${seconds}s`,
    "--output-path",
    trace,
    "--output-path-overwrite",
    new URL(entry.path, opts.baseUrl).href,
    path.join(root, "bombadil/public-surface.spec.ts"),
  ];
  // A trace left by an earlier run must never be read as this run's.
  deps.remove(trace);
  const proc = deps.spawn(bin, args, {
    env: scrubbedEnv(ctx.env),
    encoding: "utf8",
    maxBuffer: 1 << 30,
    cwd: root,
  });
  const log = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
  deps.write(path.join(opts.outDir, `run-${entry.slug}.log`), log);
  let dump = "";
  let traceError;
  if (deps.exists(trace)) {
    const read = deps.spawn(bin, ["trace", trace, "--json"], {
      env: scrubbedEnv(ctx.env),
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
    dump = read.stdout ?? "";
    if (read.error || read.status !== 0) {
      traceError = read.error?.message ?? `trace dump exited ${read.status}`;
    }
  }
  const result = {
    slug: entry.slug,
    path: entry.path,
    exitCode: proc.status ?? undefined,
    spawnError: proc.error?.message,
    traceError,
    // On-origin parsed states only: what the minimum is compared with.
    states: countStates(dump, opts.baseUrl),
    // Parsed http(s) states on another origin. Reported, not judged: in CI
    // Clerk's dev-instance handshake may legitimately pass through a Clerk
    // domain, so the verdict does not depend on this number.
    offOriginStates: offOriginStates(dump, opts.baseUrl),
    paths: visitedPaths(dump, opts.baseUrl),
    violations: violatedNames(dump),
  };
  if (result.exitCode !== 0) {
    deps.log(log.split("\n").slice(-12).join("\n"));
  }
  deps.log(
    `  ${entry.slug}: exit ${result.exitCode}, ${result.states} states, off-origin ${result.offOriginStates}, paths ${result.paths.join(" ")}`,
  );
  return result;
}

/** Writes verdict.json and prints it; the exit code is 0 only for PASS. */
function finish(deps, outDir, result) {
  deps.mkdir(outDir);
  deps.write(
    path.join(outDir, "verdict.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  deps.log(`bombadil verdict: ${result.verdict} - ${result.reason}`);
  for (const name of result.violations) deps.log(`  violated: ${name}`);
  // Only a FAIL lists problems as extra detail; for CANNOT_RUN they are the reason.
  if (result.verdict === "FAIL") {
    for (const problem of result.problems) deps.log(`  also: ${problem}`);
  }
  return { result, exitCode: result.verdict === "PASS" ? 0 : 1 };
}

/**
 * The whole run. `input` is { argv, env, platform, arch, root }.
 * @returns {Promise<{ result: object, exitCode: number }>}
 */
export async function run(input, deps = realDeps) {
  const { argv, env, platform, arch, root } = input;
  let opts;
  try {
    opts = parseArgs(argv, env);
    new URL(opts.baseUrl); // throws on an unusable base URL
  } catch (error) {
    // A refusal is still a verdict: write it, never crash without one.
    const outDir = env.BOMBADIL_OUT_DIR ?? DEFAULT_OUT_DIR;
    return finish(deps, outDir, cannotRun(`bad arguments: ${error.message}`));
  }
  const binName = BINARIES[`${platform}-${arch}`];
  const bin =
    opts.bin ??
    (binName
      ? path.join(root, "node_modules/@antithesishq/bombadil/binaries", binName)
      : "");
  const facts = {
    platform,
    arch,
    hostname: new URL(opts.baseUrl).hostname,
    allowHost: opts.allowHost,
    minStates: opts.minStates,
  };

  // Refusals that need no network or process: platform and host.
  const refusal = preflightRefusal(facts);
  if (refusal) return finish(deps, opts.outDir, refusal);

  const health = await deps.fetchStatus(opts.baseUrl);
  const total = timeLimitSeconds(opts.timeLimit);
  const problem = startupProblem(deps, bin, opts.timeLimit, total);
  if (problem) return finish(deps, opts.outDir, cannotRun(problem));
  if (health !== 200) {
    const unhealthy = decideVerdict({ ...facts, healthStatus: health });
    return finish(deps, opts.outDir, unhealthy);
  }

  deps.mkdir(opts.outDir);
  const seconds = perEntrySeconds(total);
  deps.log(`bombadil: ${ENTRY_POINTS.length} entry points, ${seconds}s each`);
  const ctx = { bin, opts, root, env };
  const entries = ENTRY_POINTS.map((entry) =>
    exploreEntry(deps, ctx, entry, seconds),
  );
  const verdict = decideVerdict({ ...facts, healthStatus: health, entries });
  return finish(deps, opts.outDir, verdict);
}
