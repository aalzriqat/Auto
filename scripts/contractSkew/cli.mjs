#!/usr/bin/env node
/**
 * Contract-skew detector — the entry point a schedule calls with nobody watching.
 *
 * SCRUM-177 was a merged frontend served against a backend that had never been
 * deployed, for 33.5 hours, and nothing noticed. A control that only runs when
 * a person remembers to run it would not have caught it either, so this exists
 * to be invoked by a cron and by a release gate rather than by a human.
 *
 * Two modes, because two different questions are being asked:
 *
 *   production  — does the code on `main` match the backend users are served
 *                 by RIGHT NOW? A mismatch is an incident that already exists.
 *   release     — would shipping this candidate introduce one? A mismatch is a
 *                 decision still available to us.
 *
 * Exit codes are deliberately distinct, and UNAVAILABLE is not success:
 *   0  PASS         proven compatible, complete coverage
 *   0  UNKNOWN      no proven break, but coverage is incomplete (warning only)
 *   1  FAIL         proven break — production skew
 *   2  usage error
 *   3  UNAVAILABLE  no authoritative evidence could be obtained
 *   4  BLOCKED      release-mode: an UNKNOWN intersects a path this release changes
 *   5  STANDING DEFECT  the client disagrees with a backend that is ALREADY
 *                       deployed — a real product bug, but deploying fixes
 *                       nothing, so it must not fire the skew alarm
 *   6  COVERAGE GAP     a client file that calls Convex was never scanned, so
 *                       the control cannot answer for it at all
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { extractClientCalls } from "./clientPaths.mjs";
import { compareContracts, blockersForRelease } from "./compare.mjs";
import { CLIENT_SURFACES, listSurfaceFiles, unscannedConvexClients } from "./clientFiles.mjs";
import { fetchDeployedSpec, readSpecFile, redact } from "./fetchSpec.mjs";
import { changedContractPaths, summarizeChanges } from "./specDiff.mjs";
import { classifyBreaking, alertsFor, releaseBlockingFindings } from "./classify.mjs";

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, UNAVAILABLE: 3, BLOCKED: 4, STANDING_DEFECT: 5, COVERAGE_GAP: 6 };

/**
 * @param {string} name
 * @param {string|boolean|undefined} [fallback]
 * @returns {string|boolean|undefined}  `true` for a bare flag, the value for
 *   `--name value`, the fallback when absent.
 */
function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

/** The string form of an argument, or undefined for a bare flag / absence. */
const strArg = (name) => {
  const value = arg(name);
  return typeof value === "string" ? value : undefined;
};

const mode = arg("mode", "production");
if (mode !== "production" && mode !== "release") {
  console.error(`unknown --mode ${mode}; expected "production" or "release"`);
  process.exit(EXIT.USAGE);
}

// ── 1. Authoritative deployed contract ───────────────────────────────────────
let deployed;
try {
  deployed = fetchDeployedSpec({
    specFile: strArg("spec"),
    expectedDeployment: strArg("expect-deployment") ?? process.env.CONVEX_PROD_DEPLOYMENT ?? undefined,
    allowWorkstation: arg("allow-workstation") === true,
  });
} catch (error) {
  // ⚠️ A deployment-identity refusal is UNAVAILABLE, never FAIL. Nothing has
  // been proven about skew — the control was pointed at the wrong backend, and
  // reporting that as a skew verdict would attach a confident answer to a
  // question that was never asked of production.
  deployed = {
    ok: false,
    unavailable: true,
    reason: String(/** @type {Error} */ (error)?.message ?? error),
    tried: [],
  };
}

if (!deployed.ok) {
  // ⚠️ Never PASS. A control that cannot see production has not checked it.
  //
  // ⚠️ Everything below is REDACTED first. This is the one branch that reports
  // text originating from the Convex CLI's stderr, and on a public repository
  // the scheduled job's log is public.
  console.log(
    redact(
      JSON.stringify(
        { verdict: "UNAVAILABLE", reason: deployed.reason, tried: deployed.tried },
        null,
        2
      )
    )
  );
  console.error(redact(`::warning::contract-skew UNAVAILABLE — ${deployed.reason}`));
  for (const line of deployed.tried) console.error(redact(`  - ${line}`));
  process.exit(EXIT.UNAVAILABLE);
}

// ── 2. What the client actually sends ────────────────────────────────────────
//
// One TypeScript program PER SURFACE. The web app and the mobile app are typed
// by different tsconfigs — the root config excludes `apps`, and mobile extends
// `expo/tsconfig.base` — so a single program would resolve one of them against
// the wrong lib and answer confidently from the wrong types.
const root = process.cwd();
const calls = [];
const unresolvedBinders = [];
const scannedFiles = [];
const surfaces = [];

for (const surface of CLIENT_SURFACES) {
  const files = listSurfaceFiles(root, surface);
  if (files.length === 0) {
    surfaces.push({ name: surface.name, ships: surface.ships, filesScanned: 0, callSites: 0 });
    continue;
  }
  const extracted = extractClientCalls(files, surface.tsconfig);
  calls.push(...extracted.calls);
  unresolvedBinders.push(...extracted.unresolvedBinders);
  scannedFiles.push(...files);
  surfaces.push({
    name: surface.name,
    ships: surface.ships,
    filesScanned: files.length,
    callSites: extracted.calls.length,
  });
}

const result = compareContracts(calls, deployed.spec, unresolvedBinders);

// ⚠️ A client surface this control does not look at is a coverage gap, and a
// coverage gap must never read as PASS. Without this, the day the web client
// became fully proven the run would report PASS while dozens of mobile files
// talking to the same backend had never been examined once — "we missed a whole
// app" arriving as a green tick.
const unscanned = unscannedConvexClients(root, scannedFiles);
const unscannedFiles = unscanned.length;
const verdict = result.verdict === "PASS" && unscannedFiles > 0 ? "UNKNOWN" : result.verdict;
const coverageWarning = result.alert.coverageWarning || verdict !== result.verdict;

// ── 2b. Is an incompatibility a MISSING DEPLOY, or a client that is simply
//        wrong? Same symptom, opposite response. See classify.mjs.
const currentSpecPath =
  typeof arg("current") === "string"
    ? arg("current")
    : mode === "release" && typeof arg("candidate") === "string"
      ? arg("candidate")
      : undefined;
const deployedSha = strArg("deployed-sha");

/**
 * Whole-tree, because a shared validator can move a contract without its own
 * module moving.
 *
 * @param {string} sha
 * @returns {boolean|undefined} undefined when the question could not be asked.
 */
function backendUnchangedSince(sha) {
  try {
    execFileSync("git", ["diff", "--quiet", sha, "HEAD", "--", "convex"], { stdio: "ignore" });
    return true;
  } catch (error) {
    // `git diff --quiet` exits 1 for "there are differences" and >1 for a real
    // failure — an unknown commit, or a shallow clone that does not contain it.
    // Those are different answers and must not collapse into "changed".
    return /** @type {{status?: number}} */ (error)?.status === 1 ? false : undefined;
  }
}

const backendEvidence = { deployedSha };
if (currentSpecPath) {
  backendEvidence.changedPaths = changedContractPaths(
    deployed.spec,
    readSpecFile(currentSpecPath)
  );
} else if (deployedSha) {
  backendEvidence.backendIdenticalToDeployed = backendUnchangedSince(String(deployedSha));
}

const classification = classifyBreaking(result.breaking, backendEvidence);
const alert = alertsFor(
  classification,
  coverageWarning,
  result.needsEvidence?.length ?? 0,
  result.coverage.clientCallSitesUnresolved
);

const report = {
  mode,
  deployment: deployed.url,
  credentialRung: deployed.rung,
  verdict,
  alert,
  coverage: result.coverage,
  classification: {
    basis: classification.basis,
    revisionSkew: classification.revisionSkew.length,
    standingDefects: classification.standingDefects.length,
    unclassified: classification.unclassified.length,
  },
  scope: {
    surfaces,
    clientFilesScanned: scannedFiles.length,
    contractKinds: result.scope,
    unscannedConvexClients: unscanned,
  },
  breaking: classification.classified,
};

function emit(payload) {
  // Redacted on both sinks. The uploaded artifact is as public as the log on a
  // public repository, so treating the file as the safe copy would be wrong.
  const body = redact(JSON.stringify(payload, null, 2));
  const out = arg("json");
  if (typeof out === "string") fs.writeFileSync(out, body);
  console.log(body);
}

// ── 3. Release mode adds the path-sensitive blocker ──────────────────────────
if (mode === "release") {
  const candidatePath = arg("candidate");
  if (typeof candidatePath !== "string") {
    console.error("--mode release requires --candidate <function-spec.json>");
    process.exit(EXIT.USAGE);
  }
  const candidate = readSpecFile(candidatePath);
  const changed = changedContractPaths(deployed.spec, candidate);

  // ⚠️ Only SKEW blocks a release. A standing defect is by definition not
  // introduced by this candidate — the current backend and the live backend
  // already agree about it — so blocking on it would stop every unrelated
  // release forever, which is the same "permanently red for something proven
  // not to be skew" failure, relocated from the monitor into the release gate.
  // It is still reported below; it just is not this release's fault.
  const releaseBreaking = releaseBlockingFindings(classification);
  const blockers = blockersForRelease({ ...result, breaking: releaseBreaking }, changed);

  report.changedPaths = changed.length;
  report.changedBreakdown = summarizeChanges(changed);
  report.blocked = blockers.blocked;
  report.intersectingUnknowns = blockers.intersectingUnknowns;
  report.unrelatedUnknowns = blockers.unrelatedUnknowns;

  emit(report);

  // Reported on every release outcome, blocked or not, so it can never be lost
  // behind a green tick.
  for (const f of classification.standingDefects) {
    console.error(
      `::warning file=${f.file},line=${f.line}::[STANDING DEFECT] ${f.identifier} ${f.path} — pre-existing, not introduced by this release, and deploying will not fix it`
    );
  }

  if (blockers.blocked) {
    for (const f of blockers.intersectingUnknowns) {
      console.error(
        `::error file=${f.file},line=${f.line}::${f.identifier} ${f.path} is unproven and this release changes that path`
      );
    }
    process.exit(releaseBreaking.length ? EXIT.FAIL : EXIT.BLOCKED);
  }
  // Unrelated unknowns are control health, not this release's problem.
  if (blockers.unrelatedUnknowns > 0) {
    console.error(
      `::warning::${blockers.unrelatedUnknowns} unproven path(s) elsewhere in the client — control coverage, not a skew`
    );
  }
  process.exit(EXIT.OK);
}

// ── 4. Production mode: severity separation ──────────────────────────────────
emit(report);

// Skew first, because it is the one that is an incident. A backend that is
// behind is fixable in minutes, and somebody has to be told now.
if (alert.productionSkew) {
  for (const f of [...classification.revisionSkew, ...classification.unclassified]) {
    console.error(
      `::error file=${f.file},line=${f.line}::[${f.classification}] ${f.identifier} ${f.path} — ${f.detail} [${f.dimension}]`
    );
  }
  console.error(
    `::error::PRODUCTION SKEW — ${classification.revisionSkew.length} proven, ` +
      `${classification.unclassified.length} unclassified. Deploy the Convex backend at this commit. ` +
      `Basis: ${classification.basis}`
  );
  process.exit(EXIT.FAIL);
}

// ⚠️ A standing defect is a real failure and is reported as one — never
// suppressed, allowlisted, or softened into UNKNOWN, because it is not
// uncertainty. It is a known bug. But it gets its OWN exit code, because
// deploying the backend fixes nothing here and reporting it as skew would leave
// the skew alarm permanently red for something proven not to be skew. An alarm
// that is always on is an alarm nobody reads.
if (alert.standingContractDefect) {
  for (const f of classification.standingDefects) {
    console.error(
      `::error file=${f.file},line=${f.line}::[STANDING DEFECT] ${f.identifier} ${f.path} — ${f.detail} [${f.dimension}]`
    );
  }
  console.error(
    `::error::STANDING CONTRACT DEFECT — ${classification.standingDefects.length} path(s). ` +
      `The current backend and the live backend already agree, so DEPLOYING WILL NOT FIX THIS. ` +
      `Basis: ${classification.basis}`
  );
  process.exit(EXIT.STANDING_DEFECT);
}
// ⚠️ A client FILE that was never scanned is not the same as an unproven path
// inside a file that was. For an unproven path the control saw the call and
// could not prove one leaf; for an unscanned file it never saw the call at all,
// so a genuine incompatibility there produces no finding, no BREAKING, and —
// before this branch existed — exit 0 with a warning. A green tick over a
// client nobody looked at is the same false assurance as UNAVAILABLE reporting
// success, and it is worse for being quiet about it.
//
// This costs nothing today: the derived scan currently returns an empty list.
// It exists so that the day someone adds a client surface, the control says so
// instead of passing.
if (unscannedFiles > 0) {
  for (const entry of unscanned) {
    console.error(
      `::error file=${entry.file}::calls Convex but is in no scanned client surface — this control cannot answer for it`
    );
  }
  console.error(
    `::error::COVERAGE GAP — ${unscannedFiles} client file(s) calling Convex were never scanned. Add them to CLIENT_SURFACES in scripts/contractSkew/clientFiles.mjs.`
  );
  process.exit(EXIT.COVERAGE_GAP);
}

if (alert.coverageWarning) {
  // ⚠️ Explicitly NOT an outage claim. This says the control cannot see
  // everything, which is a different sentence from "production is broken".
  console.error(
    `::warning::contract-skew coverage incomplete — ${result.coverage.clientCallSitesUnresolved} unresolved call site(s), ` +
      `${result.needsEvidence?.length ?? 0} unproven path(s). No skew detected.`
  );
}
process.exit(EXIT.OK);
