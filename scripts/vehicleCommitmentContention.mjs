#!/usr/bin/env node
/**
 * SCRUM-195 — real-contention probe for the vehicle-commitment authority.
 *
 * `convex-test` does not model Convex's transaction manager. It runs mutations
 * sequentially against an in-memory store, so it cannot distinguish "this
 * invariant holds under optimistic concurrency control" from "this invariant
 * has never been contended". A green convex-test suite is therefore NOT
 * concurrency evidence, which is why this probe exists.
 *
 * WHAT IT PROVES
 *
 * Claim acquisition must read the indexed live-claim range and insert the claim
 * in ONE mutation. Convex gives serializable transactions with OCC and retries
 * conflicts, so two transactions that both observe a free vehicle must not both
 * commit. This forces that race against a real deployment.
 *
 * ## Two corrections from design review, both load-bearing
 *
 * 1. **Counting rows is not an invariant.** The previous revision asserted only
 *    on the final claim count, and its own Race B label said "never zero" while
 *    the predicate accepted zero. Worse, zero is LEGITIMATE in one interleaving
 *    — if the acquirer observes the old claim and refuses, and the release then
 *    succeeds, zero claims is correct. So a count alone can neither confirm nor
 *    refute the invariant. Every race now CORRELATES which call succeeded with
 *    who ends up owning the vehicle, which is the only thing that distinguishes
 *    a correct interleaving from a lost write.
 *
 * 2. **Every race starts clean.** The previous revision ran all three races
 *    against one vehicle, so Race C inherited whatever state Race B left. A
 *    race whose starting conditions depend on the previous race's outcome
 *    cannot support a claim about either.
 *
 * ## Authentication and the test-support surface
 *
 * Design review found the previous contract was either unreachable or a
 * backdoor: `ConvexHttpClient` cannot call Convex *internal* functions, and the
 * real mutations require tenant auth, so the only way to make the old script
 * work would have been public unauthenticated seeding and cancellation
 * endpoints — reachable in production by anyone, and a client-side URL check
 * cannot protect them.
 *
 * So the probe AUTHENTICATES like any other client and drives the REAL public
 * mutations. The only bespoke surface it needs is seeding and observation, and
 * that must be gated server-side by an explicit disposable-deployment
 * capability — never by this script's own opinion of the URL.
 *
 * SAFETY
 *
 * This writes. Identity is ASKED OF THE DEPLOYMENT rather than inferred from a
 * string, mirroring `scripts/releaseGuard.ts`'s `assertDeploymentIdentity`,
 * whose reasoning applies exactly: a URL you were handed can be stale, renamed
 * or wrong; a deployment that names itself cannot. There is no default URL and
 * no fallback to ambient CONVEX_DEPLOYMENT, which on this repository has
 * historically resolved to production.
 *
 *   node scripts/vehicleCommitmentContention.mjs \
 *     --url https://<disposable>.convex.cloud \
 *     --expect <disposable> \
 *     --token <jwt> \
 *     --concurrency 32
 *
 * EXIT: 0 = every invariant held · 1 = an invariant was violated (read the
 * report) · 2 = the probe could not run.
 */

import { ConvexHttpClient } from "convex/browser";

const DEFAULT_CONCURRENCY = 32;

function parseArgs(argv) {
  const out = { concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") out.url = argv[i + 1];
    if (argv[i] === "--expect") out.expect = argv[i + 1];
    if (argv[i] === "--token") out.token = argv[i + 1];
    if (argv[i] === "--concurrency") out.concurrency = Number(argv[i + 1]);
  }
  return out;
}

function deploymentNameOf(url) {
  const match = /^https:\/\/([a-z0-9-]+)\.convex\.cloud\/?$/i.exec((url ?? "").trim());
  return match ? match[1] : null;
}

/**
 * Refuse before connecting, on the caller's own arguments.
 *
 * This is the WEAK half of the safety model and is treated as such — it only
 * catches an obviously wrong invocation. The load-bearing half is
 * `assertDeploymentIsDisposable` below, which asks the deployment.
 */
function refuseObviouslyUnsafeArgs(args) {
  if (!args.url) {
    throw new Error(
      "No --url. This probe writes, so it will not guess a deployment. Name a disposable one explicitly."
    );
  }
  if (!args.expect) {
    throw new Error(
      "No --expect. Name the deployment you believe you are pointing at, so the deployment itself can contradict you."
    );
  }
  if (!args.token) {
    throw new Error(
      "No --token. The probe drives the REAL authenticated mutations; it does not use unauthenticated seeding endpoints, because those would be reachable in production."
    );
  }
  if (!deploymentNameOf(args.url)) {
    throw new Error(`--url is not a Convex deployment URL: ${args.url}`);
  }
  const production = process.env.CONVEX_PROD_DEPLOYMENT?.trim();
  if (production && deploymentNameOf(args.url) === production) {
    throw new Error(
      `Refusing: ${args.url} is this repository's production deployment (${production}).`
    );
  }
}

/**
 * The real check: make the deployment say who it is.
 *
 * Adopted from `assertDeploymentIdentity` in `scripts/releaseGuard.ts` — "a log
 * line can be stale, reformatted or absent; this cannot be any of those." The
 * disposable flag must come from the deployment's own configuration, so a
 * production deployment cannot be talked into accepting this probe by passing
 * it a persuasive URL.
 */
async function assertDeploymentIsDisposable(client, expected) {
  const identity = await client.query("testSupport:deploymentIdentity", {});
  const reported = deploymentNameOf(identity?.cloudUrl);
  if (!reported) {
    throw new Error(
      "The deployment did not report its own URL, so its identity cannot be confirmed. Refusing to write to a deployment that will not say which one it is."
    );
  }
  if (reported !== expected) {
    throw new Error(
      `The deployment that answered is "${reported}", but you named "${expected}". The probe was pointed somewhere else.`
    );
  }
  if (identity?.disposable !== true) {
    throw new Error(
      `Deployment "${reported}" does not declare itself disposable. This probe creates and abandons real rows and will not run anywhere else.`
    );
  }
  return reported;
}

/**
 * Fire N calls as close to simultaneously as the client allows, keeping WHICH
 * call settled how.
 *
 * `Promise.all` would reject on the first failure and destroy the
 * distribution — and the distribution is the measurement, since in a correct
 * run most of these calls are supposed to fail.
 */
async function raceAll(n, makeCall) {
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => makeCall(i)));
  return settled.map((result, index) => ({
    index,
    ok: result.status === "fulfilled",
    value: result.status === "fulfilled" ? result.value : undefined,
    error: result.status === "rejected" ? String(result.reason?.message ?? result.reason) : undefined,
  }));
}

/**
 * Name which cross-authority failure actually happened.
 *
 * Zero winners and two winners are OPPOSITE bugs — starvation versus
 * double-booking — and a bare count reports them identically. Whoever reads a
 * failed run needs to know which one they are chasing.
 */
function describeCrossOutcome(race) {
  const winners = race.filter((r) => r.ok).length;
  if (winners === 1) return "exactly one won, as required";
  if (winners === 0) {
    return "STARVATION: neither succeeded on a free vehicle, so the two subsystems refused each other";
  }
  return "DOUBLE BOOKING: both succeeded, so the two subsystems did not serialize against each other";
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  refuseObviouslyUnsafeArgs(args);

  const client = new ConvexHttpClient(args.url);
  client.setAuth(args.token);
  const deployment = await assertDeploymentIsDisposable(client, args.expect);

  console.log("Vehicle-commitment contention probe");
  console.log(`  deployment : ${deployment} (self-declared disposable)`);
  console.log(`  concurrency: ${args.concurrency}`);
  console.log("");

  /**
   * A fresh org + vehicle + quotes for ONE race.
   *
   * Per-race rather than shared: a race inheriting the previous race's state
   * cannot support a claim about either of them.
   */
  const freshScenario = (label, quotes) =>
    client.mutation("testSupport:seedCommitmentScenario", { label, quotes });

  /**
   * WHO owns this vehicle, expressed as a ROOT — not as an application.
   *
   * The previous revision asked for `{ applicationId }`, which was correct for
   * the pre-c14554 model and is wrong for this one. Under deal lineage a root
   * may be owned by deposits alone (`QUOTE:<quoteId>` with no application at
   * all), or by a standalone reservation (`RESERVATION:<id>`), or may outlive
   * the release of its application evidence while its deposit stays live.
   * Correlating winners by application id could not express any of those, so
   * the probe would have reported green while the authority disagreed.
   *
   * Contract: `{ rootKind: "QUOTE" | "RESERVATION", rootId } | null`.
   */
  const ownerOf = (scenario) =>
    client.query("testSupport:liveCommitmentRoot", {
      orgId: scenario.orgId,
      vehicleId: scenario.vehicleId,
    });

  /** The root a given call's result belongs to, for winner correlation. */
  const rootOf = (scenario, kind, id) =>
    client.query("testSupport:rootForEvidence", { orgId: scenario.orgId, kind, id });

  const sameRoot = (a, b) => a != null && b != null && a.rootKind === b.rootKind && a.rootId === b.rootId;

  // ── Race A — acquire vs acquire ───────────────────────────────────────────
  {
    const s = await freshScenario("race-a", args.concurrency);
    const race = await raceAll(args.concurrency, (i) =>
      client.mutation("applications:createFromQuote", { orgId: s.orgId, quoteId: s.quoteIds[i] })
    );
    const winners = race.filter((r) => r.ok);
    const owner = await ownerOf(s);

    check(
      "A. exactly one acquisition succeeds",
      winners.length === 1,
      `${winners.length} succeeded of ${args.concurrency}`
    );
    const winnerRoot =
      winners.length === 1 ? await rootOf(s, "application", winners[0].value) : null;
    check(
      "A. the winner's ROOT is the owner — not merely 'someone' owns it",
      sameRoot(owner, winnerRoot),
      `owner=${JSON.stringify(owner)} winnerRoot=${JSON.stringify(winnerRoot)}`
    );
  }

  // ── Race B — release vs acquire ───────────────────────────────────────────
  // Zero claims is LEGITIMATE here (the acquirer saw the old claim, refused,
  // and the release then succeeded), so the count alone proves nothing. What
  // must hold is the correlation.
  {
    const s = await freshScenario("race-b", 2);
    const incumbent = await client.mutation("applications:createFromQuote", {
      orgId: s.orgId,
      quoteId: s.quoteIds[0],
    });

    const race = await raceAll(2, (i) =>
      i === 0
        ? client.mutation("applications:cancelApplication", {
            orgId: s.orgId,
            applicationId: incumbent,
          })
        : client.mutation("applications:createFromQuote", {
            orgId: s.orgId,
            quoteId: s.quoteIds[1],
          })
    );
    const [release, acquire] = race;
    const owner = await ownerOf(s);

    const incumbentRoot = await rootOf(s, "application", incumbent);
    const acquiredRoot = acquire.ok ? await rootOf(s, "application", acquire.value) : null;

    // Added after review: the whole race is vacuous if the release itself
    // fails. Every conditional below is satisfied when BOTH calls reject and
    // the incumbent simply stays — so without this, Race B could report green
    // having proven nothing about releasing at all. Cancelling one's own live
    // application under contention is not permitted to fail.
    check(
      "B. the release itself succeeded — otherwise this race proves nothing",
      release.ok,
      `release=${release.ok}${release.error ? ` (${release.error})` : ""}`
    );
    check(
      "B. the incumbent never remains the owner after a successful release",
      !(release.ok && sameRoot(owner, incumbentRoot)),
      `release=${release.ok} owner=${JSON.stringify(owner)} incumbentRoot=${JSON.stringify(incumbentRoot)}`
    );
    check(
      "B. a successful acquisition owns the vehicle",
      acquire.ok ? sameRoot(owner, acquiredRoot) : true,
      `acquire=${acquire.ok} owner=${JSON.stringify(owner)} acquiredRoot=${JSON.stringify(acquiredRoot)}`
    );
    // DELIBERATELY NOT ASSERTED: "a refused acquisition never owns the vehicle".
    //
    // It reads as the natural mirror of the check above and it is unsound. A
    // refused call carries no application id, so `acquire.value` is `undefined`
    // by construction — and on the interleaving this race's own header names as
    // LEGITIMATE (the acquirer sees the incumbent claim, refuses, the release
    // then succeeds) the vehicle has no owner either. The comparison becomes
    // `undefined !== undefined`, which is false, and the probe reports
    // INVARIANT VIOLATED against a perfectly correct implementation.
    //
    // Verified by executing the predicate in isolation rather than reasoning
    // about it. A safety probe that cries wolf on correct behaviour is worse
    // than one assertion short: it trains the reader to disbelieve it, or sends
    // someone to "fix" working code. The sound content of this idea is already
    // covered by the two checks either side of it.
    check(
      "B. never two owners",
      (await client.query("testSupport:liveClaimCount", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
      })) <= 1,
      "at most one live claim"
    );
  }

  // ── Race C — reopen vs acquire ────────────────────────────────────────────
  // The race the whole REJECTED design turns on: rejection releases the claim,
  // so reopening must RE-ACQUIRE and lose if a competitor got there first.
  {
    const s = await freshScenario("race-c", 2);
    const rejected = await client.mutation("testSupport:seedRejectedApplication", {
      orgId: s.orgId,
      quoteId: s.quoteIds[0],
    });

    const race = await raceAll(2, (i) =>
      i === 0
        ? client.mutation("applications:updateStatus", {
            orgId: s.orgId,
            applicationId: rejected,
            status: "PENDING_DOCS",
          })
        : client.mutation("applications:createFromQuote", {
            orgId: s.orgId,
            quoteId: s.quoteIds[1],
          })
    );
    const [reopen, acquire] = race;
    const owner = await ownerOf(s);

    check(
      "C. exactly one of reopen/acquire wins — starvation is a failure too",
      race.filter((r) => r.ok).length === 1,
      `reopen=${reopen.ok} acquire=${acquire.ok}`
    );
    const reopenedRoot = await rootOf(s, "application", rejected);
    const contenderRoot = acquire.ok ? await rootOf(s, "application", acquire.value) : null;
    check(
      "C. the winner's ROOT owns the vehicle",
      reopen.ok ? sameRoot(owner, reopenedRoot) : sameRoot(owner, contenderRoot),
      `owner=${JSON.stringify(owner)} reopen=${reopen.ok}`
    );
  }

  // ── Race D — CROSS-AUTHORITY, the one the earlier revision omitted ────────
  // Design review's sharpest point: all previous races exercised the finance
  // lifecycle against itself. The defect that started this entire issue was two
  // DIFFERENT subsystems disagreeing, so the finance claim must be raced
  // against cash completion and against a manual reservation. If the read side
  // and the write side touch different index ranges, OCC may not serialize them
  // against each other at all — and nothing else in this probe would notice.
  {
    const s = await freshScenario("race-d-cash", 1);
    const race = await raceAll(2, (i) =>
      i === 0
        ? client.mutation("applications:createFromQuote", {
            orgId: s.orgId,
            quoteId: s.quoteIds[0],
          })
        : client.mutation("sales:create", {
            orgId: s.orgId,
            vehicleId: s.vehicleId,
            customerId: s.otherCustomerId,
            salespersonId: s.salespersonId,
            salePrice: s.price,
            saleDate: Date.now(),
            status: "COMPLETED",
          })
    );
    // `=== 1`, not `<= 1`. Race D starts from a genuinely FREE vehicle, so
    // exactly one of the two must win. Accepting zero would let the starvation
    // bug through silently — both cross-subsystem calls spuriously refusing
    // because each defers to the other over index ranges OCC never serialized
    // against one another. That is precisely the two-subsystems-disagree class
    // Race D was added to catch, so tolerating zero would defeat its purpose.
    check(
      "D. exactly one of finance claim / cash sale wins on a free vehicle",
      race.filter((r) => r.ok).length === 1,
      `application=${race[0].ok} cashSale=${race[1].ok} — ${describeCrossOutcome(race)}`
    );
    // Counting winners is not enough, and this is the gap review found: a
    // LEGACY path can succeed WITHOUT acquiring a root. If the cash sale wins
    // but never registers ownership, the count says "exactly one" while the
    // authority says the car is FREE — green on a vehicle that has just been
    // sold out from under the authority. Correlate, do not count.
    const owner = await ownerOf(s);
    const winnerRoot = race[0].ok
      ? await rootOf(s, "application", race[0].value)
      : race[1].ok
        ? await rootOf(s, "sale", race[1].value)
        : null;
    check(
      "D. the winner actually REGISTERED ownership, not merely succeeded",
      sameRoot(owner, winnerRoot),
      `owner=${JSON.stringify(owner)} winnerRoot=${JSON.stringify(winnerRoot)}`
    );
  }

  {
    const s = await freshScenario("race-d-reserve", 1);
    const race = await raceAll(2, (i) =>
      i === 0
        ? client.mutation("applications:createFromQuote", {
            orgId: s.orgId,
            quoteId: s.quoteIds[0],
          })
        : client.mutation("vehicles:createReservation", {
            orgId: s.orgId,
            vehicleId: s.vehicleId,
            customerId: s.otherCustomerId,
          })
    );
    check(
      "D. exactly one of finance claim / manual reservation wins on a free vehicle",
      race.filter((r) => r.ok).length === 1,
      `application=${race[0].ok} reservation=${race[1].ok} — ${describeCrossOutcome(race)}`
    );
    const owner = await ownerOf(s);
    const winnerRoot = race[0].ok
      ? await rootOf(s, "application", race[0].value)
      : race[1].ok
        ? await rootOf(s, "reservation", race[1].value)
        : null;
    check(
      "D. the reservation winner registered a ROOT rather than just a hold row",
      sameRoot(owner, winnerRoot),
      `owner=${JSON.stringify(owner)} winnerRoot=${JSON.stringify(winnerRoot)}`
    );
  }

  // ── Race E — DEPOSITS, which c14554 made a root-establishing operation ─────
  // The gap review found in the previous revision: the word "deposit" did not
  // appear anywhere in this probe. That was correct for the pre-c14554 model,
  // where only a Finance Application could claim — and wrong the moment the
  // ruling made "the first deposit OR Finance Application on a quote
  // establishes the root".
  //
  // It matters more than the other races, not less: the primitive deposits go
  // through, `holdVehicleForDeposit`, was BUILT for parallel non-exclusive
  // holds ("the same car can be sourced again"). Turning it into an exclusive
  // acquisition is the largest behavioural change in this design, and it is the
  // one path no race touched.
  {
    const s = await freshScenario("race-e-deposits", 2);
    const race = await raceAll(2, (i) =>
      client.mutation("deposits:create", {
        orgId: s.orgId,
        quoteId: s.quoteIds[i],
        amount: 1_000,
      })
    );
    const owner = await ownerOf(s);
    const winnerRoot = race[0].ok
      ? await rootOf(s, "deposit", race[0].value)
      : race[1].ok
        ? await rootOf(s, "deposit", race[1].value)
        : null;

    check(
      "E. two first deposits from different quotes — exactly one wins",
      race.filter((r) => r.ok).length === 1,
      `first=${race[0].ok} second=${race[1].ok} — ${describeCrossOutcome(race)}`
    );
    check(
      "E. the winning deposit's root owns the vehicle",
      sameRoot(owner, winnerRoot),
      `owner=${JSON.stringify(owner)} winnerRoot=${JSON.stringify(winnerRoot)}`
    );
  }

  {
    const s = await freshScenario("race-e-cross", 2);
    const race = await raceAll(2, (i) =>
      i === 0
        ? client.mutation("deposits:create", {
            orgId: s.orgId,
            quoteId: s.quoteIds[0],
            amount: 1_000,
          })
        : client.mutation("applications:createFromQuote", {
            orgId: s.orgId,
            quoteId: s.quoteIds[1],
          })
    );
    check(
      "E. a deposit and a finance application from DIFFERENT roots — exactly one wins",
      race.filter((r) => r.ok).length === 1,
      `deposit=${race[0].ok} application=${race[1].ok} — ${describeCrossOutcome(race)}`
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(
    failed.length === 0
      ? `ALL ${results.length} INVARIANTS HELD`
      : `${failed.length} of ${results.length} INVARIANTS VIOLATED`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`probe could not run: ${error.message}`);
  process.exit(2);
});
