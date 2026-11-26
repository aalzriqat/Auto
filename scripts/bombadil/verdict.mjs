// SCRUM-1005: pure decision logic of the Bombadil runner (no I/O, unit-tested).

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

// Signed-out entry points, each explored by its own run with its own trace.
// The origin may carry a path; the boundary is still the whole origin
// (`bombadil browser test --help`), so each run starts there and may wander.
export const ENTRY_POINTS = [
  { slug: "home", path: "/" },
  // "/marketplace" itself has no page (404, see bombadil/README.md); /marketplace/cars is
  // the public marketplace entry.
  { slug: "marketplace", path: "/marketplace/cars" },
  { slug: "contact", path: "/contact" },
  { slug: "privacy", path: "/privacy" },
  { slug: "terms", path: "/terms" },
];

// A run that explored fewer states than this did not really explore its entry
// point: the page never rendered, the browser died, or only `back` was left.
// A healthy 20s run reached 100+ states in calibration, so 10 is a floor for
// "something happened", not a coverage claim.
export const MIN_STATES_PER_ENTRY = 10;

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

/** Total limit such as "5m", "90s", "1h" in seconds, or NaN. */
export function timeLimitSeconds(text) {
  const match = /^(\d+)([smh])$/.exec(String(text).trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * { s: 1, m: 60, h: 3600 }[match[2]];
}

/** The total split evenly across the entry points, never below 10 seconds. */
export function perEntrySeconds(
  totalSeconds,
  entryCount = ENTRY_POINTS.length,
) {
  return Math.max(10, Math.floor(totalSeconds / entryCount));
}

/** Why one entry run did not count as a clean exploration, or null. */
function entryProblem(entry, minStates) {
  if (entry.spawnError) return `binary could not start: ${entry.spawnError}`;
  if (entry.exitCode !== 0 && entry.exitCode !== 2) {
    return `Bombadil exited with code ${entry.exitCode}`;
  }
  if (entry.states < minStates) {
    return `only ${entry.states} states explored, fewer than the required ${minStates}`;
  }
  return null;
}

/**
 * Pure verdict over the preflight facts and the per-entry results
 * ({ slug, exitCode, spawnError, states, paths, violations }).
 * FAIL wins over CANNOT_RUN; the CANNOT_RUN detail is still listed.
 * PASS needs EVERY entry to exit 0 with enough states.
 */
export function decideVerdict(input) {
  const { platform, arch, hostname, allowHost, healthStatus } = input;
  const minStates = input.minStates ?? MIN_STATES_PER_ENTRY;
  const entries = (input.entries ?? []).map((e) => ({
    ...e,
    violations: e.violations ?? [],
  }));
  const cannot = (reason, problems = [reason]) => ({
    verdict: "CANNOT_RUN",
    reason,
    violations: [],
    problems,
    entries,
  });
  // NaN (from Number("abc")) makes `states < minStates` false for every entry, so
  // a starved run would pass: refuse anything that is not a whole number >= 1.
  if (!Number.isInteger(minStates) || minStates < 1) {
    return cannot(`bad minimum states: ${String(minStates)}`);
  }
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
  if (entries.length === 0) return cannot("no entry point was explored");

  const problems = entries
    .map((e) => [e, entryProblem(e, minStates)])
    .filter(([, problem]) => problem !== null)
    .map(([e, problem]) => `${e.slug}: ${problem}`);
  // A trace that recorded a violation counts even when the run then ended with a
  // different exit code (for example "no actions available" on an error page).
  const violating = entries.filter(
    (e) => e.exitCode === 2 || e.violations.length > 0,
  );
  const violations = violating.flatMap((e) =>
    e.violations.map((name) => `${e.slug}: ${name}`),
  );
  if (violating.length > 0) {
    return {
      verdict: "FAIL",
      reason: "Bombadil reported property violations",
      violations,
      problems,
      entries,
    };
  }
  if (problems.length > 0) return cannot(problems.join("; "), problems);
  const total = entries.reduce((sum, e) => sum + e.states, 0);
  return {
    verdict: "PASS",
    reason: `${entries.length} entry points, ${total} states, no violations`,
    violations: [],
    problems: [],
    entries,
  };
}
