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
 *   1  TOOLING FAILURE  the control did not complete. Node's DEFAULT for an
 *                       uncaught throw, so this is the code you get when
 *                       nothing classified anything. NOT a verdict about the
 *                       backend — do NOT deploy on it.
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
 *                       code that may carry a deploy instruction.
 *   8  RELEASE BREAK    release-mode: shipping this candidate WOULD introduce a
 *                       skew. A decision still available to us — deploying the
 *                       backend is not the remedy, so it is not code 7.
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
import { execFileSync } from "node:child_process";
import { extractClientCalls } from "./clientPaths.mjs";
import { compareContracts, blockersForRelease } from "./compare.mjs";
import { CLIENT_SURFACES, listSurfaceFiles, unscannedConvexClients } from "./clientFiles.mjs";
import { fetchDeployedSpec, isDeploymentName, readSpecFile, redact } from "./fetchSpec.mjs";
import { changedContractPaths, summarizeChanges } from "./specDiff.mjs";
import { classifyBreaking, alertsFor, releaseBlockingFindings } from "./classify.mjs";

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
 * ⚠️ AND THIS IS THE SECOND TIME. `readSpecOrUnavailable` below was written to
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

/**
 * ⚠️ AN UNREADABLE SPEC IS UNAVAILABLE, NEVER FAIL.
 *
 * `readSpecFile` throws for a missing file, a path outside the bounded roots,
 * and invalid JSON. Uncaught, the exception escapes and Node exits 1 — which
 * this CLI defines as a PROVEN production skew. A mistyped path or a truncated
 * artifact download would then be reported as an incident, and somebody would
 * be sent looking for a break that does not exist.
 *
 * The primary fetch already gets this right; these two readers did not.
 *
 * The boundary at the top of this file now catches these too. This stays
 * because it names WHICH read failed and which file it was — a message worth
 * having when a scheduled run reports UNAVAILABLE at 04:00 and nobody is
 * watching. The boundary is the floor, not the replacement.
 */
function readSpecOrUnavailable(specPath, what) {
  try {
    return readSpecFile(specPath);
  } catch (error) {
    const detail = String(/** @type {Error} */ (error)?.message ?? error);
    unavailable(`could not read the ${what} spec at ${specPath}: ${detail}`);
  }
}

const backendEvidence = { deployedSha };
if (currentSpecPath) {
  backendEvidence.changedPaths = changedContractPaths(
    deployed.spec,
    readSpecOrUnavailable(currentSpecPath, "current backend")
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
  const candidatePath = arg("candidate");
  if (typeof candidatePath !== "string") {
    console.error("--mode release requires --candidate <function-spec.json>");
    process.exit(EXIT.USAGE);
  }
  const candidate = readSpecOrUnavailable(candidatePath, "candidate");
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
    process.exit(releaseBreaking.length ? EXIT.RELEASE_BREAK : EXIT.BLOCKED);
  }
  // Unrelated unknowns are control health, not this release's problem.
  if (blockers.unrelatedUnknowns > 0) {
    console.error(
      `::warning::${blockers.unrelatedUnknowns} unproven path(s) elsewhere in the client — control coverage, not a skew`
    );
  }

  // ⚠️ A COVERAGE GAP BLOCKS A RELEASE TOO, AND IT USED TO ONLY BLOCK THE
  // MONITOR.
  //
  // Production mode acts on `unscannedFiles` and exits COVERAGE_GAP. Release
  // mode reached the OK exit below FIRST, so a release could go green while a
  // client surface calling Convex was never analysed at all — not "we looked
  // and found nothing", but "we never looked". That is the same false assurance
  // this control exists to remove, and it is worse in the release gate than in
  // the monitor: the monitor reports an incident that already exists, the gate
  // decides whether to create one.
  //
  // Latent today because the derived scan returns an empty list. Stated at the
  // gate rather than left to fall through, so it cannot become reachable
  // silently the day a surface is added.
  if (unscannedFiles > 0) {
    for (const entry of unscanned) {
      console.error(
        `::error file=${entry.file}::calls Convex but is in no scanned client surface — this control cannot answer for it`
      );
    }
    console.error(
      `::error::COVERAGE GAP — ${unscannedFiles} client file(s) calling Convex were never scanned, so this release cannot be cleared. Add them to CLIENT_SURFACES in scripts/contractSkew/clientFiles.mjs.`
    );
    process.exit(EXIT.COVERAGE_GAP);
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
  process.exit(EXIT.PRODUCTION_SKEW);
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
