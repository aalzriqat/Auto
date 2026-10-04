#!/usr/bin/env node
/**
 * Contract-skew detector — the entry point a schedule calls with nobody watching.
 *
 * SCRUM-177 was a merged frontend served against a backend that had never been
 * deployed, for 33.5 hours, and nothing noticed. A control that only runs when
 * a person remembers to run it would not have caught it either, so this exists
 * to be invoked by a cron (`contract-skew.yml`, production mode) rather than by
 * a human. Release mode exists and is tested, but NO workflow invokes it yet -
 * it is a check to run by hand against a candidate spec, not an active gate.
 *
 * Two modes, because two different questions are being asked:
 *
 *   production  — does the code on `main` match the backend users are served
 *                 by RIGHT NOW? A mismatch is an incident that already exists.
 *   release     — would shipping this candidate introduce one? A mismatch is a
 *                 decision still available to us.
 *
 * Exit codes are deliberately distinct, and UNAVAILABLE is not success:
 *   0  PASS         proven compatible: every call accounted for, no unproven
 *                   path, empty baseline. Scope: Convex ARGUMENT CONTRACTS only.
 *   0  UNKNOWN      no proven break among the accounted calls, and every
 *                   unproven path is in the reviewed baseline. Never a PASS.
 *   1  TOOLING FAILURE  the control did not complete. Node's DEFAULT for an
 *                       uncaught throw. NOT a verdict about the backend, and
 *                       the uncaught-throw boundary below turns most of these
 *                       into 3 - so 1 means the process died before even
 *                       that boundary could run. Do NOT deploy on it.
 *   2  usage error
 *   3  UNAVAILABLE  no authoritative evidence could be obtained — a DELIBERATE
 *                   classification, reached through the error boundary
 *   4  BLOCKED      release-mode: an UNKNOWN intersects a path this release changes
 *   5  STANDING DEFECT  the client disagrees with a backend that is ALREADY
 *                       deployed — a real product bug, but deploying fixes
 *                       nothing, so it must not fire the skew alarm
 *   6  COVERAGE GAP     a client file that calls Convex was never scanned, so
 *                       the control cannot answer for it at all
 *   7  PRODUCTION SKEW  proven break against the DEPLOYED backend. The ONLY
 *                       code that may carry a deploy instruction — and only
 *                       when the spec was FETCHED. A `--spec` file is not known
 *                       to be production: same code, "CONTRACT SKEW against the
 *                       supplied spec", no deploy instruction (skewWording.mjs).
 *   8  RELEASE BREAK    release-mode: shipping this candidate WOULD introduce a
 *                       skew. A decision still available to us — deploying the
 *                       backend is not the remedy, so it is not code 7.
 *   9  COVERAGE INCOMPLETE  a call site could not be accounted for: unresolved
 *                       by the extractor, unresolved/unaccounted by the
 *                       independent census, or NO call sites discovered at all.
 *   10 EVIDENCE DRIFT   the unproven paths differ from the reviewed baseline
 *                       (new, removed, duplicated, expired, malformed, absent,
 *                       or the contract under an entry changed). Not a skew.
 *                       Blocks in release mode too (D-26): the UNKNOWN wording
 *                       rests on that baseline.
 *
 * Precedence when several causes are present: 7 > 4 > 9 > 10 > 0 (plus 5/6/8 as
 * documented). The exit code names the most actionable cause; stderr and the JSON
 * report's `causes` list EVERY cause present.
 *
 * ⚠️ WHY PROVEN SKEW IS NOT EXIT 1, AND WHY THAT MATTERS MORE THAN IT LOOKS.
 *
 * It used to be. Node exits 1 for ANY uncaught throw, so a bad `typescript`
 * install, a syntax error in a transitively imported module, an OOM — anything
 * that died before a boundary existed — produced exit 1, and the workflow
 * rendered exit 1 as "PRODUCTION SKEW — Deploy the Convex backend at this
 * commit." A broken toolchain told an operator to change production.
 *
 * A boundary was written twice for that, and both times it fixed the INSTANCES
 * rather than the CLASS: an import-time throw still escaped, because ESM
 * evaluates every import before any statement in the importing module, so
 * handlers registered in this file cannot cover this file's own imports.
 * Reproduced at `clientPaths.mjs`: exit 1, rendered as a deploy order.
 *
 * The fix is to stop the DEFAULT code carrying a verdict at all. Nothing can
 * accidentally exit 7 — it is reached only where this control has proven skew
 * against a spec it actually read. Anything that dies before that point lands
 * on 1, which now says "the control failed, do not deploy on this result".
 * This also covers the failures no `try/catch` can reach, including ones that
 * kill the process before any JavaScript runs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createClientProgram, extractClientCalls } from "./clientPaths.mjs";
import { runCensus } from "./census.mjs";
import { evaluateBaseline, loadBaseline, unprovenFrom } from "./baseline.mjs";
import { specProblems } from "./specIndex.mjs";
import { skewSummary, SUPPLIED_FILE_RUNG } from "./skewWording.mjs";
import { compareContracts, blockersForRelease, classifyRelease } from "./compare.mjs";
import { CLIENT_SURFACES, listSurfaceFiles, unscannedConvexClients } from "./clientFiles.mjs";
import { fetchDeployedSpec, isDeploymentName, readSpecFile, redact } from "./fetchSpec.mjs";
import { changedContractPaths, summarizeChanges } from "./specDiff.mjs";
import { classifyBreaking, alertsFor } from "./classify.mjs";

const DEFAULT_BASELINE = fileURLToPath(new URL("./needs-evidence-baseline.json", import.meta.url));

const EXIT = {
  OK: 0,
  // ⚠️ NOT A VERDICT. Node's default for an uncaught throw lands here, so this
  // code must never mean "the backend is behind". See the header.
  TOOLING_FAILURE: 1,
  USAGE: 2,
  UNAVAILABLE: 3,
  BLOCKED: 4,
  STANDING_DEFECT: 5,
  COVERAGE_GAP: 6,
  // ⚠️ THE ONLY CODE THAT MAY CARRY A DEPLOY INSTRUCTION. Deliberate, and
  // unreachable by accident: nothing defaults to 7.
  PRODUCTION_SKEW: 7,
  // Release-mode proven break. Deploying the backend is not the remedy here,
  // so this is deliberately NOT 7 and carries no deploy instruction.
  RELEASE_BREAK: 8,
  // A call site the control could not account for (unresolved, unaccounted, or
  // none discovered at all). Not a skew and not a pass.
  COVERAGE_INCOMPLETE: 9,
  // The unproven paths differ from the reviewed baseline. Not a skew.
  EVIDENCE_DRIFT: 10,
};

/**
 * ⚠️ AN EXCEPTION MEANS "THE CONTROL COULD NOT LOOK", NEVER "SKEW PROVEN".
 *
 * Every verdict below is reached deliberately, through a `process.exit` with a
 * chosen code.
 *
 * ⚠️ HISTORICAL — THIS IS WHY THE BOUNDARY EXISTS, NOT WHAT THE CODES MEAN NOW.
 * Node's default for an UNCAUGHT throw is exit 1, and 1 USED TO BE the code
 * that meant proven skew, which `contract-skew.yml` rendered as "PRODUCTION
 * SKEW — Deploy the Convex backend at this commit." So any unhandled defect
 * anywhere in this run told a responder to deploy, for what was actually a
 * tooling failure — expensively wrong: it sends somebody to change production
 * in response to a bug in this script.
 *
 * ⚠️ CURRENT — that coupling is GONE. Proven production skew is exit 7, the
 * only code carrying a deploy instruction, and exit 1 now means the control did
 * not complete and must not be deployed on. See the exit-code contract at the
 * top of this file. This boundary is still load-bearing: it is what turns a
 * throw into a DELIBERATE `UNAVAILABLE` (3) rather than leaving it on the raw
 * default, so the run says "I could not look" instead of "I did not finish".
 *
 * ⚠️ AND THIS IS THE SECOND TIME. `readValidatedSpec` below was written to
 * fix exactly this for the two spec reads — it fixed the INSTANCES, not the
 * CLASS. The very next thing that same commit did was add a throw for an
 * unreadable tsconfig, reached through an unguarded `extractClientCalls`, and
 * the defect came straight back somewhere else. A boundary is the only form of
 * the fix that also covers the throw nobody has written yet.
 *
 * ⚠️ AND THE FIRST VERSION OF THIS COMMENT OVERCLAIMED. It said "nothing that
 * could legitimately prove skew arrives here", which was false: `emit` ran
 * BEFORE the exit carrying the verdict, so an unwritable `--json` path turned a
 * proven skew into UNAVAILABLE. A reviewer disproved it and it was reproduced
 * on the real pipeline. `emit` is now best-effort, and after it the only
 * remaining work is console writes and `process.exit`.
 *
 * The honest claim is therefore narrower, and stated as a property to PRESERVE
 * rather than one that holds by luck: every verdict is decided before anything
 * that can fail is attempted, so a throw reaching this handler means the
 * control did not finish — not that it finished and found nothing. Anything
 * added between a decided verdict and its `process.exit` must not be able to
 * throw, or this handler will silently downgrade a real answer again.
 */
function unavailable(reason) {
  console.log(redact(JSON.stringify({ verdict: "UNAVAILABLE", reason }, null, 2)));
  console.error(redact(`::warning::contract-skew UNAVAILABLE — ${reason}`));
  process.exit(EXIT.UNAVAILABLE);
}

for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    unavailable(`the control could not complete (${event}): ${String(error?.stack ?? error)}`);
  });
}

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

// ⚠️ THE UNATTENDED MONITOR REQUIRES A DEPLOYMENT IDENTITY. ABSENCE OF
// CONFIGURATION MUST NEVER DISABLE A CONTROL.
//
// `contract-skew.yml` passes `CONVEX_PROD_DEPLOYMENT` so the fetcher can refuse
// a spec from any other deployment — a preview key silently addresses a preview
// backend, and a control that verified a deployment nobody is served by would
// report success with total confidence.
//
// The variable was defined only on the `production` environment, while this job
// runs in `contract-skew-prod-read`. An unset `${{ vars.X }}` expands to the
// EMPTY STRING, `??` does not skip `""`, and the check downstream was a
// truthiness test — so the guard was inert and nothing said so. The first
// unattended run would have passed, having verified nothing about WHICH
// backend it read, and no test or CI job could have caught it.
//
// So the requirement is asserted here, before any credential is touched, and
// the reason names the fix rather than the symptom.
const suppliedDeployment = strArg("expect-deployment") ?? process.env.CONVEX_PROD_DEPLOYMENT;
// An empty value is treated as ABSENT rather than as a request, so an ambient
// empty variable cannot break a local run — but absence is still refused below
// wherever the identity is required.
const expectedDeployment =
  typeof suppliedDeployment === "string" && suppliedDeployment.trim() !== ""
    ? suppliedDeployment
    : undefined;

// A supplied spec file is evidence handed in by the caller and a workstation run
// is a human reproducing a result locally; neither is the unattended monitor.
const requiresDeploymentIdentity =
  mode === "production" && !strArg("spec") && arg("allow-workstation") !== true;

if (requiresDeploymentIdentity && !isDeploymentName(expectedDeployment)) {
  unavailable(
    `the production monitor requires the identity of the deployment it must verify. ` +
      `Set CONVEX_PROD_DEPLOYMENT (or pass --expect-deployment) to that deployment's name. ` +
      `Received ${suppliedDeployment === undefined ? "no value" : JSON.stringify(suppliedDeployment)}.`
  );
}

// ── 1. Authoritative deployed contract ───────────────────────────────────────
let deployed;
try {
  deployed = fetchDeployedSpec({
    specFile: strArg("spec"),
    expectedDeployment,
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

// ⚠️ A SPEC THIS CONTROL CANNOT READ IS NOT EVIDENCE, IN ANY ROLE. See
// specProblems(). One validator for every spec this run touches (deployed,
// current, candidate): before batch 3 only the deployed one was checked, so a
// malformed --current or --candidate was trusted — it classified breaks and
// decided what a release "changed" while nothing had looked at it.
function requireUsableSpec(role, spec, origin) {
  const issues = specProblems(spec);
  if (issues.length) {
    unavailable(
      `the ${role} function spec${origin ? ` (${origin})` : ""} is not in the shape this control understands (${issues.length} problem(s)): ${issues.slice(0, 5).join("; ")}`
    );
  }
  return spec;
}
requireUsableSpec("deployed", deployed.spec, strArg("spec"));

/**
 * ⚠️ AN UNREADABLE SPEC IS UNAVAILABLE, NEVER FAIL.
 *
 * `readSpecFile` throws for a missing file, a path outside the bounded roots,
 * and invalid JSON. Uncaught, the exception escapes and Node exits 1 — which
 * this CLI once defined as a PROVEN production skew. This reader names WHICH
 * role failed and which file it was — a message worth having when a scheduled
 * run reports UNAVAILABLE at 04:00 and nobody is watching — and then runs the
 * same structural validation as the deployed spec. The boundary at the top of
 * this file is the floor, not the replacement.
 *
 * @param {string} role  "current" | "candidate"
 * @param {string} specPath
 */
function readValidatedSpec(role, specPath) {
  let spec;
  try {
    spec = readSpecFile(specPath);
  } catch (error) {
    const detail = String(/** @type {Error} */ (error)?.message ?? error);
    unavailable(`could not read the ${role} spec at ${specPath}: ${detail}`);
  }
  return requireUsableSpec(role, spec, specPath);
}

// Every non-deployed spec is read ONCE, validated, and before the (slow) client
// scan so a bad one costs nothing. `--current` evidence defaults to the candidate
// in release mode, so the candidate is never read a second time.
const candidatePathArg = arg("candidate");
if (mode === "release" && typeof candidatePathArg !== "string") {
  console.error("--mode release requires --candidate <function-spec.json>");
  process.exit(EXIT.USAGE);
}
const candidateSpec =
  mode === "release" && typeof candidatePathArg === "string"
    ? readValidatedSpec("candidate", candidatePathArg)
    : undefined;
const currentSpec =
  typeof arg("current") === "string"
    ? readValidatedSpec("current", String(arg("current")))
    : candidateSpec;

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
const census = { candidates: 0, TRANSMISSION: 0, NON_TRANSMISSION: 0, UNRESOLVED: 0, UNACCOUNTED: 0 };
/** @type {Array<{surface:string,siteId:string,file:string,line:number,disposition:string,reason:string}>} */
const censusGaps = [];
/** @type {Array<{surface:string,siteId:string,kind:string}>} */
const censusOrphans = [];
const blindSurfaces = [];

for (const surface of CLIENT_SURFACES) {
  const files = listSurfaceFiles(root, surface);
  if (files.length === 0) {
    surfaces.push({ name: surface.name, ships: surface.ships, filesScanned: 0, callSites: 0 });
    continue;
  }
  // One program per surface, shared by the extractor and the independent census
  // so they look at exactly the same types.
  const program = createClientProgram(files, surface.tsconfig);
  const extracted = extractClientCalls(files, surface.tsconfig, { program });
  calls.push(...extracted.calls.map((c) => ({ ...c, surface: surface.name })));
  unresolvedBinders.push(...extracted.unresolvedBinders);
  scannedFiles.push(...files);

  const surfaceCensus = runCensus({ program, files, extraction: extracted });
  census.candidates += surfaceCensus.totals.candidates;
  for (const key of ["TRANSMISSION", "NON_TRANSMISSION", "UNRESOLVED", "UNACCOUNTED"]) {
    census[key] += surfaceCensus.totals[key];
  }
  for (const c of [...surfaceCensus.unresolved, ...surfaceCensus.unaccounted]) {
    censusGaps.push({ surface: surface.name, siteId: c.siteId, file: c.file, line: c.line, disposition: c.disposition, reason: c.reason });
  }
  for (const o of surfaceCensus.orphans) censusOrphans.push({ surface: surface.name, siteId: o.siteId, kind: o.kind });
  if (surfaceCensus.blind) blindSurfaces.push(surface.name);

  surfaces.push({
    name: surface.name,
    ships: surface.ships,
    filesScanned: files.length,
    callSites: extracted.calls.length,
  });
}

const result = compareContracts(calls, deployed.spec, unresolvedBinders);
// ⚠️ R1: in release mode the SAME calls are compared against the candidate too.
// What a release introduces is what the candidate breaks, not what is live.
const candidateResult = candidateSpec ? compareContracts(calls, candidateSpec) : undefined;
const unproven = unprovenFrom(result.needsEvidence, deployed.spec);

// ⚠️ THE MONITOR READS THIS FILE AND NEVER WRITES IT. See baseline.mjs.
const baselinePath = strArg("baseline") ?? DEFAULT_BASELINE;
const baselineState = evaluateBaseline(unproven, loadBaseline(baselinePath));

// Why this run cannot claim to have accounted for every call.
const coverageProblems = [];
if (calls.length + unresolvedBinders.length === 0) {
  coverageProblems.push("no Convex call sites were discovered, so nothing was checked - a scan that found nothing proves nothing");
}
if (result.coverage.clientCallSitesUnresolved > 0) {
  coverageProblems.push(`${result.coverage.clientCallSitesUnresolved} call site(s) the extractor could not resolve`);
}
// ⚠️ A call into a validator this control cannot compare (`args: null`, a
// `v.record()`, an empty union) is a gap in what was PROVEN, not an unproven
// value: unwaivable, so it lives here and never in the baseline. Deduped across
// the two specs by site, because the same call can hit it on both.
const validatorGaps = (() => {
  const seen = new Set();
  const out = [];
  for (const g of /** @type {any[]} */ ([...result.gaps, ...(candidateResult?.gaps ?? [])])) {
    const key = JSON.stringify([g.surface ?? "", g.file, g.line, g.identifier, g.path, g.detail]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
})();
if (validatorGaps.length) {
  coverageProblems.push(`${validatorGaps.length} call(s) into a validator this control cannot compare (no argument validator, v.record(), empty v.union())`);
}
if (censusGaps.length) {
  coverageProblems.push(`${censusGaps.length} census candidate(s) unresolved or unaccounted for`);
}
if (censusOrphans.length) {
  coverageProblems.push(`${censusOrphans.length} extractor record(s) the independent census does not recognise`);
}
if (blindSurfaces.length) {
  coverageProblems.push(
    `the independent census resolved no symbol into the installed convex package on: ${blindSurfaces.join(", ")} (is convex installed?)`
  );
}
const coverageIncomplete = coverageProblems.length > 0;

function reportCoverageIncomplete(prefix) {
  for (const s of result.coverage.unresolvedSites) {
    console.error(`::error file=${s.file},line=${s.line}::${s.identifier} - ${s.reason}`);
  }
  for (const g of validatorGaps) {
    console.error(`::error file=${g.file},line=${g.line}::[coverage gap] ${g.identifier} ${g.path} — ${g.detail}`);
  }
  for (const g of censusGaps) {
    console.error(`::error file=${g.file},line=${g.line}::[census ${g.disposition}] ${g.reason}`);
  }
  for (const o of censusOrphans) console.error(`::error::[census orphan] ${o.siteId} ${o.kind}`);
  console.error(`::error::${prefix}COVERAGE INCOMPLETE - ${coverageProblems.join("; ")}.`);
}

function reportCoverageGap(prefix) {
  for (const entry of unscanned) {
    console.error(
      `::error file=${entry.file}::calls Convex but is in no scanned client surface — this control cannot answer for it`
    );
  }
  console.error(
    `::error::${prefix}COVERAGE GAP — ${unscannedFiles} client file(s) calling Convex were never scanned. Add them to CLIENT_SURFACES in scripts/contractSkew/clientFiles.mjs.`
  );
}

function reportEvidenceDrift(prefix) {
  for (const problem of baselineState.problems) console.error(`::error::[evidence drift] ${problem}`);
  console.error(
    `::error::${prefix}EVIDENCE DRIFT - ${baselineState.problems.length} difference(s) between the unproven paths found and ${baselinePath}. ` +
      `Not a skew; a person must review the report and update the baseline.`
  );
}

/**
 * ⚠️ THE EXIT CODE NAMES THE MOST ACTIONABLE CAUSE; IT MUST NOT HIDE THE REST
 * (D-26). Precedence is 7 > 4 > 9 > 10 > 0, so a run with a proven break AND an
 * unresolved call site exits 7. An operator who fixes the break and re-runs would
 * then meet the coverage gap for the first time, so every other cause present is
 * listed here, in the same run, labelled ALSO PRESENT.
 *
 * SCRUM-178 v2 batch 3 (R3, Opus L-c): `ordered` is the ONE list of causes — the
 * exit code, the stderr report and the JSON `causes` object are all read from it
 * and nothing else. It is ROLE-AWARE: a cause carries an `exit` per mode, and a
 * cause with no exit in this mode (a standing defect or a deployed skew during a
 * release, a release break during the monitor) can never be the primary, but is
 * still reported when present. The primary is the first present cause that HAS an
 * exit in this mode; EVERY other present cause is reported as ALSO PRESENT —
 * including a standing defect, which used to be silent behind a skew.
 *
 * Returns, without exiting, when no cause with an exit is present (after
 * reporting the exit-less ones that are, so they cannot be lost behind a green
 * tick).
 *
 * @param {Cause[]} ordered
 * @param {string} [prefix]  prepended to the primary cause's summary line
 */
function exitOnFirstCause(ordered, prefix = "") {
  const modeKey = mode === "release" ? "release" : "production";
  const primary = ordered.find((cause) => cause.present && cause.exit[modeKey] !== undefined);
  if (!primary) {
    for (const cause of ordered) if (cause.present) cause.report("ALSO PRESENT: ");
    return;
  }
  primary.report(prefix);
  for (const cause of ordered) {
    if (cause !== primary && cause.present) cause.report("ALSO PRESENT: ");
  }
  process.exit(primary.exit[modeKey]);
}

/**
 * @typedef {{ id: string, key: string, value: unknown, present: boolean,
 *             exit: { production?: number, release?: number },
 *             report: (prefix: string) => void }} Cause
 */

// ⚠️ A client surface this control does not look at is a coverage gap, and a
// coverage gap must never read as PASS. Without this, the day the web client
// became fully proven the run would report PASS while dozens of mobile files
// talking to the same backend had never been examined once — "we missed a whole
// app" arriving as a green tick.
const unscanned = unscannedConvexClients(root, scannedFiles);
const unscannedFiles = unscanned.length;
// PASS is only the gap-free, empty-baseline case, and only about Convex argument
// contracts: anything less than complete accounting is UNKNOWN.
const verdict =
  result.verdict === "PASS" && (unscannedFiles > 0 || coverageIncomplete || baselineState.matched > 0)
    ? "UNKNOWN"
    : result.verdict;
const coverageWarning = result.alert.coverageWarning || verdict !== result.verdict;

// ── 2b. Is an incompatibility a MISSING DEPLOY, or a client that is simply
//        wrong? Same symptom, opposite response. See classify.mjs.
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
if (currentSpec) {
  backendEvidence.changedPaths = changedContractPaths(deployed.spec, currentSpec);
} else if (deployedSha) {
  backendEvidence.backendIdenticalToDeployed = backendUnchangedSince(String(deployedSha));
}

const classification = classifyBreaking(result.breaking, backendEvidence);
const alert = alertsFor(
  classification,
  coverageWarning,
  result.needsEvidence?.length ?? 0,
  result.coverage.clientCallSitesUnresolved,
  deployed.rung === SUPPLIED_FILE_RUNG ? "CONTRACT SKEW" : "PRODUCTION SKEW"
);

// ── 2c. Release facts (R1). Same calls, both specs.
/** @param {any[]} list */
const dedupeFindings = (list) => {
  const seen = new Set();
  return list.filter((f) => {
    const key = JSON.stringify([f.surface ?? "", f.file, f.line, f.identifier, f.path, f.dimension, f.severity]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
const changedByCandidate = candidateSpec ? changedContractPaths(deployed.spec, candidateSpec) : [];
const releaseFacts =
  candidateResult ? classifyRelease(result, candidateResult, changedByCandidate) : undefined;
// An unproven path or a coverage gap blocks only where the candidate changes
// something. The unknowns are the UNION of what each spec leaves unproven.
const releaseBlockers = candidateResult
  ? blockersForRelease(
      {
        breaking: [],
        needsEvidence: dedupeFindings([...result.needsEvidence, ...candidateResult.needsEvidence]),
        gaps: validatorGaps,
      },
      changedByCandidate
    )
  : undefined;
const skewCount = classification.revisionSkew.length + classification.unclassified.length;

/** @param {string} prefix */
function reportProvenBreaks(prefix) {
  if (mode === "release") {
    // The deployed backend currently refuses these calls. That is information
    // for a RELEASE, not a verdict on it: a candidate that fixes one is good news
    // and one it still breaks is reported as a RELEASE BREAK.
    console.error(
      `::notice::${prefix}DEPLOYED BACKEND CURRENTLY REFUSES ${skewCount} call path(s) the candidate changes; ` +
        `${releaseFacts?.fixedByCandidate.length ?? 0} of them are FIXED BY THIS CANDIDATE and are not release breaks.`
    );
    return;
  }
  for (const f of [...classification.revisionSkew, ...classification.unclassified]) {
    console.error(
      `::error file=${f.file},line=${f.line}::[${f.classification}] ${f.identifier} ${f.path} — ${f.detail} [${f.dimension}]`
    );
  }
  // The wording claims only what the spec's origin proves (see skewWording.mjs).
  const suppliedSpec = strArg("spec");
  console.error(
    `::error::${prefix}${skewSummary({
      rung: String(deployed.rung),
      specSource: [suppliedSpec, deployed.url].filter(Boolean).join(", "),
      proven: classification.revisionSkew.length,
      unclassified: classification.unclassified.length,
      basis: classification.basis ?? "none",
    })}`
  );
}

/** @param {string} prefix */
function reportStandingDefects(prefix) {
  // An error in the monitor, where it is the exit; a warning in a release, where
  // it is real and un-suppressed but not introduced by this candidate.
  const level = mode === "release" ? "warning" : "error";
  for (const f of classification.standingDefects) {
    console.error(
      `::${level} file=${f.file},line=${f.line}::[STANDING DEFECT] ${f.identifier} ${f.path} — ${f.detail} [${f.dimension}]`
    );
  }
  console.error(
    `::${level}::${prefix}STANDING CONTRACT DEFECT — ${classification.standingDefects.length} path(s). ` +
      `The current backend and the live backend already agree, so DEPLOYING WILL NOT FIX THIS` +
      (mode === "release" ? ", and this candidate does not introduce it. " : ". ") +
      `Basis: ${classification.basis}`
  );
}

/** @param {string} prefix */
function reportReleaseBreaks(prefix) {
  for (const f of releaseFacts?.releaseBreaks ?? []) {
    console.error(
      `::error file=${f.file},line=${f.line}::[RELEASE BREAK] ${f.identifier} ${f.path} — ${f.detail} [${f.dimension}]`
    );
  }
  console.error(
    `::error::${prefix}RELEASE BREAK - ${releaseFacts?.releaseBreaks.length ?? 0} call(s) this candidate would introduce or leave broken on a path it changes. ` +
      `Deploying the backend is not the remedy; change the candidate or the client.`
  );
}

/** @param {string} prefix */
function reportReleaseBlockers(prefix) {
  for (const f of releaseBlockers?.intersectingUnknowns ?? []) {
    console.error(
      `::error file=${f.file},line=${f.line}::${f.identifier} ${f.path} is unproven and this release changes that path`
    );
  }
  for (const g of releaseBlockers?.intersectingGaps ?? []) {
    console.error(
      `::error file=${g.file},line=${g.line}::${g.identifier} ${g.path} cannot be compared (${g.detail}) and this release changes it`
    );
  }
  console.error(
    `::error::${prefix}BLOCKED - ${(releaseBlockers?.intersectingUnknowns.length ?? 0) + (releaseBlockers?.intersectingGaps.length ?? 0)} unproven path(s) or coverage gap(s) intersect a contract path this release changes.`
  );
}

/**
 * Every cause a run can have, in ONE precedence order. `key` / `value` are what
 * the JSON report's `causes` records, `present` decides the exit, `exit` says
 * which exit code the cause carries in which MODE (no entry = it can never be
 * the primary there, but is still reported), and `report` prints it. The exit
 * code, the stderr and the JSON are all read from this list (R3).
 */
/** @type {Cause[]} */
const causes = [
  { id: "deployedSkew", key: "provenBreaks", value: skewCount, present: alert.productionSkew, exit: { production: EXIT.PRODUCTION_SKEW }, report: reportProvenBreaks },
  // ⚠️ A standing defect is a real failure and is reported as one — never
  // suppressed, allowlisted, or softened into UNKNOWN, because it is not
  // uncertainty. It is a known bug. But it gets its OWN exit code, because
  // deploying the backend fixes nothing here and reporting it as skew would leave
  // the skew alarm permanently red for something proven not to be skew. An alarm
  // that is always on is an alarm nobody reads.
  { id: "standing", key: "standingDefects", value: classification.standingDefects.length, present: classification.standingDefects.length > 0, exit: { production: EXIT.STANDING_DEFECT }, report: reportStandingDefects },
  // Release-only causes: what THIS candidate would introduce or leave broken
  // (R1), then what it changes that cannot be proven. Never present in the monitor.
  { id: "releaseBreak", key: "releaseBreaks", value: releaseFacts?.releaseBreaks.length ?? 0, present: (releaseFacts?.releaseBreaks.length ?? 0) > 0, exit: { release: EXIT.RELEASE_BREAK }, report: reportReleaseBreaks },
  { id: "releaseBlocker", key: "releaseBlockers", value: (releaseBlockers?.intersectingUnknowns.length ?? 0) + (releaseBlockers?.intersectingGaps.length ?? 0), present: Boolean(releaseBlockers?.blocked), exit: { release: EXIT.BLOCKED }, report: reportReleaseBlockers },
  // ⚠️ A client FILE that was never scanned is not the same as an unproven path
  // inside a file that was. For an unproven path the control saw the call and
  // could not prove one leaf; for an unscanned file it never saw the call at all,
  // so a genuine incompatibility there produces no finding, no BREAKING, and —
  // before this cause existed — exit 0 with a warning. A green tick over a
  // client nobody looked at is the same false assurance as UNAVAILABLE reporting
  // success, and it is worse for being quiet about it.
  { id: "coverageGap", key: "unscannedClientFiles", value: unscannedFiles, present: unscannedFiles > 0, exit: { production: EXIT.COVERAGE_GAP, release: EXIT.COVERAGE_GAP }, report: reportCoverageGap },
  // ⚠️ A call the control could not ACCOUNT FOR is not a call it found compatible.
  // Exit 9, not 0: with an incomplete census, "no break found" only describes the
  // calls that happened to be seen. Zero discovered calls lands here too.
  { id: "coverageIncomplete", key: "coverageIncomplete", value: coverageProblems, present: coverageIncomplete, exit: { production: EXIT.COVERAGE_INCOMPLETE, release: EXIT.COVERAGE_INCOMPLETE }, report: reportCoverageIncomplete },
  // The reviewed debt no longer matches what the run found.
  { id: "drift", key: "evidenceDrift", value: baselineState.drift ? baselineState.problems : [], present: baselineState.drift, exit: { production: EXIT.EVIDENCE_DRIFT, release: EXIT.EVIDENCE_DRIFT }, report: reportEvidenceDrift },
];

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
  unproven,
  baseline: { path: baselinePath, matched: baselineState.matched, drift: baselineState.problems },
  // Every cause present in this run, whatever single exit code the precedence
  // picks (D-26).
  causes: Object.fromEntries(causes.map((cause) => [cause.key, cause.value])),
  census: {
    totals: census,
    unresolved: censusGaps,
    orphans: censusOrphans,
    blindSurfaces,
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
  if (typeof out === "string") {
    // ⚠️ WRITING THE REPORT IS BEST-EFFORT AND MUST NEVER REPLACE A VERDICT.
    //
    // `emit` runs BEFORE the exit that carries the verdict. An unguarded write
    // therefore let an I/O failure decide the exit code: with the boundary
    // above, a genuine production skew came out as UNAVAILABLE (3) instead of
    // the skew verdict, and the workflow then told the responder to check
    // credentials when the truth was "deploy the backend". Reproduced on the
    // real pipeline — the same run exited with its skew code without `--json`,
    // and 3 with `--json` pointed at an unwritable path.
    //
    // ⚠️ The reproduction above predates the exit-code decoupling, when proven
    // skew was exit 1. The verdict it must not replace is now exit 7; the
    // property is unchanged, and `specDiff.test.ts` pins it at the current code.
    //
    // The artifact is a convenience; the verdict is the product. A failure to
    // save the convenience is worth a warning and nothing more.
    try {
      fs.writeFileSync(out, body);
    } catch (error) {
      const detail = String(/** @type {Error} */ (error)?.message ?? error);
      console.error(redact(`::warning::contract-skew could not write the report to ${out}: ${detail}`));
    }
  }
  console.log(body);
}

// ── 3. Release mode adds the path-sensitive blocker ──────────────────────────
if (mode === "release") {
  // ⚠️ SCRUM-178 v2 batch 3 (R1, D-24). The candidate was read and validated ONCE
  // (readValidatedSpec above) and the SAME calls were compared against it. A
  // release break is a break the CANDIDATE would introduce, or leave broken on a
  // path it changes; a break the deployed backend already has, on a path the
  // candidate leaves alone, is standing (not this release's fault), and one only
  // the deployed backend has is FIXED by this candidate. Only skew-vs-deployed
  // used to be consulted, which called a fix a break and a break a pass.
  const releaseBlocked = releaseBlockers;
  const blockers = /** @type {NonNullable<typeof releaseBlocked>} */ (releaseBlocked);
  const changed = changedByCandidate;
  const facts = /** @type {NonNullable<typeof releaseFacts>} */ (releaseFacts);

  report.changedPaths = changed.length;
  report.changedBreakdown = summarizeChanges(changed);
  report.blocked = blockers.blocked;
  report.intersectingUnknowns = blockers.intersectingUnknowns;
  report.intersectingGaps = blockers.intersectingGaps;
  report.unrelatedUnknowns = blockers.unrelatedUnknowns;
  report.release = {
    breaks: facts.releaseBreaks.length,
    standingAgainstBoth: facts.standingAgainstBoth.length,
    fixedByCandidate: facts.fixedByCandidate.length,
  };

  emit(report);

  for (const f of facts.fixedByCandidate) {
    console.error(
      `::notice file=${f.file},line=${f.line}::FIXED BY THIS CANDIDATE: ${f.identifier} ${f.path} is refused by the deployed backend but accepted by the candidate`
    );
  }

  for (const f of facts.standingAgainstBoth) {
    console.error(
      `::warning file=${f.file},line=${f.line}::[STANDING] ${f.identifier} ${f.path} is refused by BOTH the deployed backend and the candidate on a path this release does not change; not introduced by this release`
    );
  }

  // Unrelated unknowns are control health, not this release's problem. They are
  // only mentioned when the release is not blocked outright.
  if (!blockers.blocked && blockers.unrelatedUnknowns > 0) {
    console.error(
      `::warning::${blockers.unrelatedUnknowns} unproven path(s) elsewhere in the client — control coverage, not a skew`
    );
  }

  // A release is held by the blockers first (a proven break, or an unproven path
  // it changes), then by the same three causes that hold the monitor:
  //
  // ⚠️ A COVERAGE GAP BLOCKS A RELEASE TOO, AND IT USED TO ONLY BLOCK THE
  // MONITOR. Release mode reached the OK exit FIRST, so a release could go green
  // while a client surface calling Convex was never analysed at all — not "we
  // looked and found nothing", but "we never looked". That is the same false
  // assurance this control exists to remove, and it is worse in the release gate
  // than in the monitor: the monitor reports an incident that already exists, the
  // gate decides whether to create one. (Latent today because the derived scan
  // returns an empty list; stated rather than left to fall through.)
  //
  // An accounting gap blocks for the same reason: "we could not see every call"
  // is not "this release is compatible".
  //
  // ⚠️ BASELINE DRIFT BLOCKS A RELEASE TOO (D-26, CS2-3). It used to be a
  // warning that exited 0, on the reasoning that unrelated reviewed debt moving
  // should not stop an unrelated release. But a baseline that is ABSENT,
  // malformed, expired or no longer matching the contract under it means the
  // "reviewed debt" the UNKNOWN wording rests on is not what was reviewed — so
  // exit 0 here would be a green tick over evidence nobody checked. D-24 ruled
  // drift its own non-zero exit with no release carve-out. What an unrelated
  // unknown cannot do is block by itself: that stays exit 4, and only when it
  // overlaps a path THIS release changes.
  exitOnFirstCause(causes, "RELEASE ");

  // The same honest sentence as production mode: a release that clears with
  // reviewed debt remaining is UNKNOWN about that debt, never a PASS.
  if (unproven.length > 0 || verdict !== "PASS") {
    console.error(
      `No proven skew in accounted Convex argument calls; verdict UNKNOWN: ${unproven.length} reviewed paths remain unverified.`
    );
  }
  process.exit(EXIT.OK);
}

// ── 4. Production mode: severity separation ──────────────────────────────────
emit(report);

// Skew first, because it is the one that is an incident. A backend that is
// behind is fixable in minutes, and somebody has to be told now. Then, in the
// order of `causes`: standing defect, coverage gap, coverage incomplete, drift.
exitOnFirstCause(causes);

if (unproven.length > 0 || verdict !== "PASS") {
  // ⚠️ Explicitly NOT an outage claim and NOT a PASS: no break was proven among
  // the calls accounted for, and the reviewed paths remain unverified.
  console.error(
    `No proven skew in accounted Convex argument calls; verdict UNKNOWN: ${unproven.length} reviewed paths remain unverified.`
  );
  process.exit(EXIT.OK);
}

console.error(
  `No skew detected in Convex argument contracts: ${result.coverage.clientCallSitesResolved} call site(s) proven, none unaccounted for. ` +
    `HTTP action bodies and deferred server-side calls are out of scope.`
);
process.exit(EXIT.OK);
