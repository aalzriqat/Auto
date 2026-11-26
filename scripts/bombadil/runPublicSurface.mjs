// SCRUM-1005: runs the Bombadil signed-out explorer against a LOCAL build and
// writes a truthful verdict. There is no skip path: anything that stops the
// exploration from really happening is CANNOT_RUN and exits non-zero.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
// Hard deny list: never explored, even with --allow-host.
export const PRODUCTION_HOST_SUFFIXES = [
  "autoflowdealer.com",
  "convex.cloud",
  "convex.site",
  "vercel.app",
];
// The npm package ships these three binaries only (bombadil 0.8.0, no Windows).
export const BINARIES = {
  "linux-x64": "bombadil-linux-x64",
  "linux-arm64": "bombadil-linux-arm64",
  "darwin-arm64": "bombadil-darwin-arm64",
};
export const DEFAULT_MIN_STATES = 20;

/** Why a host may not be explored, or null when it may. */
export function hostRefusal(hostname, allowHost) {
  const host = String(hostname).toLowerCase();
  const bare = host.replace(/^\[|\]$/g, "");
  const denied = PRODUCTION_HOST_SUFFIXES.some(
    (s) => bare === s || bare.endsWith("." + s),
  );
  if (denied) return `host ${host} is a production host and is never explored`;
  if (LOOPBACK_HOSTS.includes(host)) return null;
  if (allowHost && allowHost.toLowerCase() === host) return null;
  return `host ${host} is not loopback; pass --allow-host ${host} to name it explicitly`;
}

/**
 * Pure verdict. Inputs describe what happened; the first problem found wins.
 * PASS needs exit 0 AND enough explored states; exit 2 is a property violation.
 */
export function decideVerdict(input) {
  const cannot = (reason) => ({
    verdict: "CANNOT_RUN",
    reason,
    violations: [],
  });
  const { platform, arch, hostname, allowHost, healthStatus } = input;
  if (!BINARIES[`${platform}-${arch}`]) {
    return cannot(`no bundled Bombadil binary for ${platform}-${arch}`);
  }
  const refusal = hostRefusal(hostname, allowHost);
  if (refusal) return cannot(refusal);
  if (healthStatus !== 200) {
    return cannot(
      `GET /api/health returned ${healthStatus ?? "no response"}, not 200`,
    );
  }
  if (input.spawnError)
    return cannot(`binary could not start: ${input.spawnError}`);
  const { exitCode, stateCount = 0, minStates = DEFAULT_MIN_STATES } = input;
  if (exitCode === 2) {
    return {
      verdict: "FAIL",
      reason: "Bombadil reported property violations",
      violations: input.violations ?? [],
    };
  }
  if (exitCode !== 0) return cannot(`Bombadil exited with code ${exitCode}`);
  if (stateCount < minStates) {
    return cannot(
      `only ${stateCount} states explored, fewer than the required ${minStates}`,
    );
  }
  return {
    verdict: "PASS",
    reason: `${stateCount} states explored, no violations`,
    violations: [],
  };
}

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

export function parseArgs(argv, env = process.env) {
  const opts = {
    baseUrl: env.BOMBADIL_BASE_URL ?? "http://127.0.0.1:3000",
    timeLimit: env.BOMBADIL_TIME_LIMIT ?? "2m",
    outDir: env.BOMBADIL_OUT_DIR ?? "test-results/bombadil",
    minStates: Number(env.BOMBADIL_MIN_STATES ?? DEFAULT_MIN_STATES),
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

/** One JSON object per state from `bombadil trace --json`. */
export function countStates(jsonLines) {
  return jsonLines.split("\n").filter((l) => l.trim().startsWith("{")).length;
}

/** Names of violated properties, read defensively from the trace JSON. */
export function violatedNames(jsonLines) {
  const names = new Set();
  for (const line of jsonLines.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const state = JSON.parse(line);
      // Bombadil 0.8.0 nests them: {"index":N,"metadata":{"violations":[{"name":...}]}}.
      for (const v of state.metadata?.violations ?? state.violations ?? []) {
        names.add(String(v.name ?? v.property ?? JSON.stringify(v)));
      }
    } catch {
      // A non-JSON line is not a state.
    }
  }
  return [...names];
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
    exitCode: 0,
    stateCount: Infinity,
  });
  if (refusal.verdict !== "PASS") return finish(opts.outDir, refusal);

  const health = await healthStatus(opts.baseUrl);
  if (health !== 200 || !existsSync(bin)) {
    const spawnError = existsSync(bin) ? undefined : `missing binary ${bin}`;
    return finish(
      opts.outDir,
      decideVerdict({ ...facts, healthStatus: health, spawnError }),
    );
  }

  mkdirSync(opts.outDir, { recursive: true });
  const trace = path.join(opts.outDir, "trace.bin");
  const run = spawnSync(
    bin,
    [
      "browser",
      "test",
      "--headless",
      "--no-sandbox",
      "--time-limit",
      opts.timeLimit,
      "--output-path",
      trace,
      "--output-path-overwrite",
      ...opts.extra,
      opts.baseUrl,
      path.join(root, "bombadil/public-surface.spec.ts"),
    ],
    { env: scrubbedEnv(), stdio: "inherit", cwd: root },
  );

  let stateCount = 0;
  let violations = [];
  if (existsSync(trace)) {
    const dump = spawnSync(bin, ["trace", trace, "--json"], {
      env: scrubbedEnv(),
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
    stateCount = countStates(dump.stdout ?? "");
    violations = violatedNames(dump.stdout ?? "");
  }
  const result = decideVerdict({
    ...facts,
    healthStatus: health,
    spawnError: run.error?.message,
    exitCode: run.status ?? undefined,
    stateCount,
    violations,
  });
  return finish(opts.outDir, { ...result, states: stateCount });
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
