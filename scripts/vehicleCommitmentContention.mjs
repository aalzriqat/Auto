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

  const ownerOf = (scenario) =>
    client.query("testSupport:liveClaimOwner", {
      orgId: scenario.orgId,
      vehicleId: scenario.vehicleId,
    });

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
    check(
      "A. the winner is the owner — not merely 'someone' owns it",
      winners.length === 1 && owner?.applicationId === winners[0].value,
      `owner=${owner?.applicationId ?? "none"} winner=${winners[0]?.value ?? "none"}`
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

    check(
      "B. the incumbent never remains the owner after a successful release",
      !(release.ok && owner?.applicationId === incumbent),
      `release=${release.ok} owner=${owner?.applicationId ?? "none"} incumbent=${incumbent}`
    );
    check(
      "B. a successful acquisition owns the vehicle",
      acquire.ok ? owner?.applicationId === acquire.value : true,
      `acquire=${acquire.ok} value=${acquire.value ?? "-"} owner=${owner?.applicationId ?? "none"}`
    );
    check(
      "B. a refused acquisition never owns the vehicle",
      acquire.ok || owner?.applicationId !== acquire.value,
      `acquire refused; owner=${owner?.applicationId ?? "none"}`
    );
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
    check(
      "C. the winner owns the vehicle",
      reopen.ok
        ? owner?.applicationId === rejected
        : acquire.ok && owner?.applicationId === acquire.value,
      `owner=${owner?.applicationId ?? "none"}`
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
    check(
      "D. a finance claim and a cash sale never both succeed on one vehicle",
      race.filter((r) => r.ok).length <= 1,
      `application=${race[0].ok} cashSale=${race[1].ok}`
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
      "D. a finance claim and a manual reservation never both succeed on one vehicle",
      race.filter((r) => r.ok).length <= 1,
      `application=${race[0].ok} reservation=${race[1].ok}`
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
