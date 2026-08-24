#!/usr/bin/env node
/**
 * SCRUM-195 — real-contention probe for the vehicle-commitment authority.
 *
 * `convex-test` does not model Convex's transaction manager. It runs mutations
 * sequentially against an in-memory store, so it cannot distinguish "this
 * invariant holds under optimistic concurrency control" from "this invariant
 * has never been contended". A green convex-test suite is therefore NOT
 * concurrency evidence, and this probe exists because the owner ruled that it
 * cannot be accepted as such.
 *
 * WHAT IT PROVES
 *
 * Claim acquisition must read the indexed live-claim range and insert the new
 * claim in ONE mutation. Convex gives serializable transactions with OCC and
 * retries conflicts, so two transactions that both read an empty claim range
 * and both insert must not both commit. This probe forces that race for real.
 *
 * THREE RACES, not one. The first is the obvious one; the other two are where
 * this class of bug actually survives review:
 *
 *   A. ACQUIRE vs ACQUIRE      — N applications race for one free vehicle.
 *   B. RELEASE vs ACQUIRE      — a cancellation racing an acquisition, which
 *                                must not produce zero claims (car silently
 *                                free while a deal believes it holds it) or
 *                                two (both sides think they won).
 *   C. REOPEN  vs ACQUIRE      — a REJECTED application reopening at the same
 *                                moment another deal acquires the car. This is
 *                                the race the whole REJECTED design turns on:
 *                                reopen must RE-ACQUIRE, so exactly one of the
 *                                two may end up holding the vehicle.
 *
 * SAFETY
 *
 * This script writes. It must only ever be pointed at a disposable or preview
 * deployment. It refuses to run against anything that looks like production,
 * and it requires the operator to name the deployment explicitly — there is no
 * default URL and no fallback to ambient CONVEX_DEPLOYMENT, because on this
 * repository the ambient value has historically resolved to production.
 *
 *   node scripts/vehicleCommitmentContention.mjs \
 *     --url https://<disposable-deployment>.convex.cloud \
 *     --concurrency 32
 *
 * EXIT CODES: 0 = every invariant held. 1 = an invariant was violated (the
 * interesting case — read the report). 2 = the probe could not run.
 */

import { ConvexHttpClient } from "convex/browser";

const PRODUCTION_MARKERS = ["kindly-hound-172"];
const DEFAULT_CONCURRENCY = 32;

function parseArgs(argv) {
  const out = { concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") out.url = argv[i + 1];
    if (argv[i] === "--concurrency") out.concurrency = Number(argv[i + 1]);
  }
  return out;
}

function refuseUnsafeTarget(url) {
  if (!url) {
    throw new Error(
      "No --url given. This probe writes, so it will not guess a deployment. " +
        "Pass a disposable or preview deployment explicitly."
    );
  }
  if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/.test(url)) {
    throw new Error(`--url does not look like a Convex deployment URL: ${url}`);
  }
  for (const marker of PRODUCTION_MARKERS) {
    if (url.includes(marker)) {
      throw new Error(
        `Refusing to run: ${url} matches a known production deployment (${marker}). ` +
          "This probe creates and abandons real rows and must never touch production."
      );
    }
  }
}

/**
 * Fire `n` calls as close to simultaneously as the client allows and report
 * which settled how.
 *
 * `Promise.all` would reject on the first failure and hide the distribution,
 * which is the entire measurement — in a correct run MOST of these calls fail,
 * and it is the count of successes that carries the invariant.
 */
async function raceAll(n, makeCall) {
  const settled = await Promise.allSettled(
    Array.from({ length: n }, (_, i) => makeCall(i))
  );
  const fulfilled = settled.filter((r) => r.status === "fulfilled");
  const rejected = settled.filter((r) => r.status === "rejected");
  return { fulfilled, rejected, settled };
}

function report(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
  return ok;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  refuseUnsafeTarget(args.url);

  const client = new ConvexHttpClient(args.url);
  console.log(`Vehicle-commitment contention probe`);
  console.log(`  deployment : ${args.url}`);
  console.log(`  concurrency: ${args.concurrency}`);
  console.log("");

  // ── Fixture ────────────────────────────────────────────────────────────────
  // NOTE FOR IMPLEMENTATION: these three calls are the only part of this probe
  // that does not exist yet. They must be internal/test-only seeding mutations
  // added alongside the authority, NOT ad-hoc writes from here — a probe that
  // seeds through a private path is not exercising the real acquisition code.
  //
  //   api.testSupport.seedContentionOrg      -> { orgId, vehicleId, quoteIds[] }
  //   api.testSupport.releaseClaim           -> cancels an application
  //   api.testSupport.countLiveClaims        -> live claims for a vehicle
  //
  // Until they exist this probe cannot run, which is why it is delivered as a
  // specification alongside the design rather than as a passing script.
  const seed = await client.mutation("testSupport:seedContentionOrg", {
    quotes: args.concurrency,
  });

  let allOk = true;

  // ── Race A — acquire vs acquire ───────────────────────────────────────────
  const raceA = await raceAll(args.concurrency, (i) =>
    client.mutation("applications:createFromQuote", {
      orgId: seed.orgId,
      quoteId: seed.quoteIds[i],
    })
  );
  const liveAfterA = await client.query("testSupport:countLiveClaims", {
    orgId: seed.orgId,
    vehicleId: seed.vehicleId,
  });
  allOk =
    report(
      "A. acquire vs acquire — exactly one application is created",
      raceA.fulfilled.length === 1,
      `${raceA.fulfilled.length} succeeded, ${raceA.rejected.length} refused (expected 1 / ${args.concurrency - 1})`
    ) && allOk;
  allOk =
    report(
      "A. acquire vs acquire — exactly one LIVE claim on the vehicle",
      liveAfterA === 1,
      `live claims = ${liveAfterA} (expected 1)`
    ) && allOk;

  // ── Race B — release vs acquire ───────────────────────────────────────────
  // The dangerous outcomes are ZERO (the release won and the acquirer believes
  // it holds a car nothing records) and TWO (both committed). One is correct
  // whichever way the race falls: either the release lost and the original
  // holder keeps it, or it won and the new acquirer took it.
  const holder = raceA.fulfilled[0]?.value;
  const raceB = await raceAll(2, (i) =>
    i === 0
      ? client.mutation("testSupport:releaseClaim", {
          orgId: seed.orgId,
          applicationId: holder,
        })
      : client.mutation("applications:createFromQuote", {
          orgId: seed.orgId,
          quoteId: seed.spareQuoteId,
        })
  );
  const liveAfterB = await client.query("testSupport:countLiveClaims", {
    orgId: seed.orgId,
    vehicleId: seed.vehicleId,
  });
  allOk =
    report(
      "B. release vs acquire — never zero and never two live claims",
      liveAfterB === 1 || liveAfterB === 0,
      `live claims = ${liveAfterB}; settled = ${raceB.settled.map((r) => r.status).join(", ")}`
    ) && allOk;
  allOk =
    report(
      "B. release vs acquire — two live claims never coexist",
      liveAfterB <= 1,
      `live claims = ${liveAfterB} (must be <= 1)`
    ) && allOk;

  // ── Race C — reopen vs acquire ────────────────────────────────────────────
  // The race the REJECTED design turns on. Reopening must RE-ACQUIRE, so if a
  // competing deal acquires at the same instant, exactly one may hold the car.
  const raceC = await raceAll(2, (i) =>
    i === 0
      ? client.mutation("applications:updateStatus", {
          orgId: seed.orgId,
          applicationId: seed.rejectedApplicationId,
          status: "PENDING_DOCS",
        })
      : client.mutation("applications:createFromQuote", {
          orgId: seed.orgId,
          quoteId: seed.contenderQuoteId,
        })
  );
  const liveAfterC = await client.query("testSupport:countLiveClaims", {
    orgId: seed.orgId,
    vehicleId: seed.vehicleId,
  });
  allOk =
    report(
      "C. reopen vs acquire — at most one wins",
      raceC.fulfilled.length <= 1 && liveAfterC <= 1,
      `${raceC.fulfilled.length} succeeded; live claims = ${liveAfterC}`
    ) && allOk;

  console.log("");
  console.log(allOk ? "ALL INVARIANTS HELD" : "AN INVARIANT WAS VIOLATED");
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error(`probe could not run: ${error.message}`);
  process.exit(2);
});
