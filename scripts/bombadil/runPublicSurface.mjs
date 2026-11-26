// SCRUM-1005: runs the Bombadil signed-out explorer against a LOCAL build, one
// run per entry point, and writes a truthful verdict. There is no skip path:
// anything that stops an entry from really being explored is CANNOT_RUN and the
// process exits non-zero. The pure decision logic is in ./verdict.mjs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BINARIES,
  ENTRY_POINTS,
  MIN_STATES_PER_ENTRY,
  decideVerdict,
  perEntrySeconds,
  timeLimitSeconds,
} from "./verdict.mjs";

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
    outDir: env.BOMBADIL_OUT_DIR ?? "test-results/bombadil",
    minStates: Number(env.BOMBADIL_MIN_STATES ?? MIN_STATES_PER_ENTRY),
    // Off by default: GitHub's ubuntu-latest Chrome has a working sandbox. A
    // root-user container needs it; opt in with BOMBADIL_NO_SANDBOX=1.
    noSandbox: env.BOMBADIL_NO_SANDBOX === "1",
    allowHost: undefined,
    bin: env.BOMBADIL_BIN,
    extra: [],
  };
  const flags = {
    "--base-url": "baseUrl",
    "--time-limit": "timeLimit",
    "--out-dir": "outDir",
    "--allow-host": "allowHost",
    "--bombadil-bin": "bin",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (key) opts[key] = argv[++i];
    else if (argv[i] === "--min-states") opts.minStates = Number(argv[++i]);
    else if (argv[i] === "--allow-url")
      opts.extra.push("--allow-url", argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return opts;
}

async function healthStatus(baseUrl) {
  try {
    const res = await fetch(new URL("/api/health", baseUrl), {
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  } catch {
    return undefined;
  }
}

/** The JSON objects (one per state) from `bombadil trace --json` output. */
function parseStates(jsonLines) {
  const states = [];
  for (const line of jsonLines.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      states.push(JSON.parse(line));
    } catch {
      // A non-JSON line is not a state.
    }
  }
  return states;
}

export function countStates(jsonLines) {
  return jsonLines.split("\n").filter((l) => l.trim().startsWith("{")).length;
}

/** Names of violated properties. Bombadil 0.8.0 nests them under metadata.violations. */
export function violatedNames(jsonLines) {
  const names = new Set();
  for (const state of parseStates(jsonLines)) {
    for (const v of state.metadata?.violations ?? state.violations ?? []) {
      names.add(String(v.name ?? v.property ?? JSON.stringify(v)));
    }
  }
  return [...names];
}

/** Distinct pathnames the trace visited (metadata.state.url, query and hash dropped). */
export function visitedPaths(jsonLines) {
  const paths = new Set();
  for (const state of parseStates(jsonLines)) {
    try {
      const url = new URL(state.metadata.state.url);
      if (url.protocol === "http:" || url.protocol === "https:")
        paths.add(url.pathname);
    } catch {
      // chrome-error:// and missing urls are not pathnames of the app.
    }
  }
  return [...paths].sort();
}

function exploreEntry(bin, opts, root, entry, seconds) {
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
    ...opts.extra,
    new URL(entry.path, opts.baseUrl).href,
    path.join(root, "bombadil/public-surface.spec.ts"),
  ];
  const run = spawnSync(bin, args, {
    env: scrubbedEnv(),
    encoding: "utf8",
    maxBuffer: 1 << 30,
    cwd: root,
  });
  const log = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  writeFileSync(path.join(opts.outDir, `run-${entry.slug}.log`), log);
  let dump = "";
  if (existsSync(trace)) {
    dump =
      spawnSync(bin, ["trace", trace, "--json"], {
        env: scrubbedEnv(),
        encoding: "utf8",
        maxBuffer: 1 << 30,
      }).stdout ?? "";
  }
  const result = {
    slug: entry.slug,
    path: entry.path,
    exitCode: run.status ?? undefined,
    spawnError: run.error?.message,
    states: countStates(dump),
    paths: visitedPaths(dump),
    violations: violatedNames(dump),
  };
  if (result.exitCode !== 0) console.log(log.split("\n").slice(-12).join("\n"));
  console.log(
    `  ${entry.slug}: exit ${result.exitCode}, ${result.states} states, paths ${result.paths.join(" ")}`,
  );
  return result;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const url = new URL(opts.baseUrl);
  const { platform, arch } = process;
  const binName = BINARIES[`${platform}-${arch}`];
  const bin =
    opts.bin ??
    (binName
      ? path.join(root, "node_modules/@antithesishq/bombadil/binaries", binName)
      : "");
  const facts = {
    platform,
    arch,
    hostname: url.hostname,
    allowHost: opts.allowHost,
    minStates: opts.minStates,
  };

  // Refusals that need no network or process: platform and host.
  const refusal = decideVerdict({
    ...facts,
    healthStatus: 200,
    entries: [{ slug: "x", exitCode: 0, states: Infinity }],
  });
  if (refusal.verdict !== "PASS") return finish(opts.outDir, refusal);

  const health = await healthStatus(opts.baseUrl);
  const total = timeLimitSeconds(opts.timeLimit);
  if (health !== 200 || !existsSync(bin) || Number.isNaN(total)) {
    const reason = !existsSync(bin)
      ? `missing binary ${bin}`
      : Number.isNaN(total)
        ? `bad time limit ${opts.timeLimit}`
        : undefined;
    const result = decideVerdict({ ...facts, healthStatus: health });
    return finish(
      opts.outDir,
      reason ? { ...result, verdict: "CANNOT_RUN", reason } : result,
    );
  }

  mkdirSync(opts.outDir, { recursive: true });
  const seconds = perEntrySeconds(total);
  console.log(
    `bombadil: ${ENTRY_POINTS.length} entry points, ${seconds}s each`,
  );
  const entries = ENTRY_POINTS.map((entry) =>
    exploreEntry(bin, opts, root, entry, seconds),
  );
  return finish(
    opts.outDir,
    decideVerdict({ ...facts, healthStatus: health, entries }),
  );
}

/** Writes verdict.json, prints it and exits 0 only for PASS. */
function finish(outDir, result) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    path.join(outDir, "verdict.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(`bombadil verdict: ${result.verdict} - ${result.reason}`);
  for (const name of result.violations) console.log(`  violated: ${name}`);
  // Only a FAIL lists problems as extra detail; for CANNOT_RUN they are the reason.
  if (result.verdict === "FAIL") {
    for (const problem of result.problems) console.log(`  also: ${problem}`);
  }
  process.exit(result.verdict === "PASS" ? 0 : 1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
