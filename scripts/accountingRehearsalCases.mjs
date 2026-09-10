/**
 * The rehearsal's cases, driven ONLY through the real public API of a live
 * preview deployment as two genuine Clerk-authenticated users.
 *
 * Kept apart from `accountingPreviewRehearsal.mjs` so that file stays about
 * targeting, refusal and evidence, and this one stays about economics.
 *
 * Two rules hold throughout:
 *
 *   1. **HTTP success is never the proof.** Every case reads the economic state
 *      back — released amount, `releaseCount`, canonical payments, ledger
 *      effects, remaining balance — and asserts on that. A mutation that returns
 *      200 and moves the wrong money is the failure being hunted, so a green
 *      response is only ever the start of a case, never its conclusion.
 *
 *   2. **Interleavings are prepared through supported operations.** No fixture
 *      is forced into place by writing rows directly. A state reached by
 *      bypassing the behaviour under test proves nothing about that behaviour.
 */

function fail(message) {
  throw new Error(message);
}

function expectEqual(actual, expected, what) {
  if (actual !== expected) fail(`${what}: expected ${expected}, got ${actual}`);
}

const uuid = () => globalThis.crypto.randomUUID();

/**
 * A deposit whose free part is only PART of the row.
 *
 * 5,000 taken against a two-car deal, 3,000 of it committed to those cars, so
 * 2,000 is free to pay out NOW and the rest becomes free only when a car falls
 * away. This shape is what makes a second GENUINE payout of one deposit possible
 * at all — a fully free deposit closes on its first release — and a second
 * genuine payout is precisely what the generation-aware identity has to stay
 * distinguishable from a retry.
 */
async function makePartiallyCommittedDeposit({ orgId, ownerMust, label }) {
  const stamp = Date.now().toString(36);
  const customerId = await ownerMust("mutation", "customers:create", {
    orgId,
    firstName: "Rehearsal",
    lastName: `${label}-${stamp}`,
  });

  const vehicle = async (suffix, vin) =>
    ownerMust("mutation", "vehicles:create", {
      orgId,
      vin,
      make: "Toyota",
      model: `Camry-${suffix}`,
      year: 2022,
      mileage: 800,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: suffix === "a" ? 22000 : 18000,
      // STOCK, not "OWNED". The first cloud run rejected every fixture on this
      // exact value: the validator is `v.union(v.literal("STOCK"),
      // v.literal("SOURCED"))`, and SOURCED vehicles are consignment (ACC-1) —
      // they never capitalize into inventory, so they are the wrong shape for a
      // deposit-release rehearsal.
      sourceType: "STOCK",
      // ⚠️ REQUIRED even though the Convex arg validator declares it
      // `v.optional(vehicleStatus)`. The cloud run refused every fixture with
      // "Validation failed: status: Required" — the ARG VALIDATOR IS NOT THE
      // LAST WORD here, a zod schema runs after it and demands this field. It is
      // a documented trap in this repository and it still caught me, because a
      // reader of `convex/vehicles.ts` alone would conclude the field is
      // optional. `convex-test` never surfaced it.
      status: "AVAILABLE",
      purchasePrice: 15000,
      purchasePaymentMethod: "CASH",
      idempotencyKey: `rehearsal-vehicle-${label}-${suffix}-${stamp}`,
    });

  // VINs must be unique per org and carry no I/O/Q, so they are minted from the
  // run stamp rather than hardcoded — two rehearsal runs against one preview
  // must not collide on a uniqueness barrier that is not what is under test.
  const base = stamp.replace(/[ioq]/g, "z").toUpperCase().padEnd(8, "0").slice(0, 8);
  const vehicleA = await vehicle("a", `RHS${base}${label.toUpperCase().slice(0, 1)}A`.slice(0, 17));
  const vehicleB = await vehicle("b", `RHS${base}${label.toUpperCase().slice(0, 1)}B`.slice(0, 17));

  const quoteId = await ownerMust("mutation", "quotes:saveQuote", {
    orgId,
    customerId,
    vehicleId: vehicleA,
    vehicleItems: [
      { vehicleId: vehicleA, unitPrice: 22000 },
      { vehicleId: vehicleB, unitPrice: 18000 },
    ],
    mode: "CASH",
    vehiclePrice: 40000,
    downPayment: 0,
    termMonths: 0,
  });

  const depositId = await ownerMust("mutation", "deposits:create", {
    orgId,
    quoteId,
    amount: 5000,
    idempotencyKey: `rehearsal-deposit-${label}-${stamp}`,
  });

  await ownerMust("mutation", "deposits:allocateToVehicles", {
    orgId,
    quoteId,
    allocations: [
      { vehicleId: vehicleA, amount: 2000 },
      { vehicleId: vehicleB, amount: 1000 },
    ],
  });

  return { customerId, vehicleA, vehicleB, quoteId, depositId };
}

/** Reads a deposit back through the public API — never by touching rows. */
async function readDeposit({ orgId, vehicleId, depositId, ownerMust }) {
  const rows = await ownerMust("query", "deposits:listByVehicle", { orgId, vehicleId });
  const row = rows.find((r) => r._id === depositId);
  if (!row) fail(`deposit ${depositId} was not returned by deposits:listByVehicle`);
  return row;
}

/**
 * Brings the fresh organization to the state a real dealership starts in:
 * a chart of accounts and an OPEN period.
 *
 * The E2E bootstrap seats people and roles; it deliberately does not open books.
 * Without these two calls the first cloud run had no 2110 and no open period, so
 * every posting below would have been HELD — and a rehearsal whose postings are
 * all held proves nothing while looking busy.
 *
 * Both are driven through the real public mutations, and both are tolerated if
 * they already exist: a re-run against a surviving preview must not fail on
 * "already initialized", and the ASSERTIONS about chart and period live in A1
 * and A2, where they belong. Setup that quietly doubles as an assertion is how
 * a rehearsal ends up proving its own setup.
 */
async function openTheBooks({ orgId, ownerCall }) {
  const notes = {};
  const chart = await ownerCall("mutation", "chartOfAccounts:initialize", { orgId });
  notes.chart = chart.ok ? "initialized" : `already present or refused: ${chart.error.slice(0, 120)}`;

  const now = new Date();
  const fiscalYear = now.getUTCFullYear();
  const period = await ownerCall("mutation", "accountingPeriods:create", {
    orgId,
    fiscalYear,
    periodNumber: now.getUTCMonth() + 1,
    startDate: Date.UTC(fiscalYear, now.getUTCMonth(), 1),
    endDate: Date.UTC(fiscalYear, now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    openImmediately: true,
  });
  notes.period = period.ok ? "created and opened" : `already present or refused: ${period.error.slice(0, 120)}`;
  return notes;
}

export async function runRehearsalCases(ctx) {
  const { results, orgId, recordCase, fireConcurrentReleases, tokens, config } = ctx;

  // TWO PEOPLE, AND THE PRODUCT INSISTS ON IT.
  //
  // The first working cloud run refused every release with "Deposit creator
  // cannot resolve their own deposit refund or forfeiture"
  // (`convex/utils/depositHelpers.ts`). That is a real segregation-of-duties
  // invariant, not an obstacle: the same person must not both take a customer's
  // money and decide it goes back out. It is the same rule the E2E bootstrap
  // documents for approvals, and it is exactly why that bootstrap seats TWO
  // identities.
  //
  // So the OWNER creates fixtures and the MANAGER resolves them, which is also
  // how a dealership actually works. Routing everything through one identity —
  // which is what this file did first — could not have exercised the money path
  // at all.
  const ownerCall = ctx.asSales;
  const ownerMust = ctx.salesMust;
  const resolverCall = ctx.asApprover;
  const resolverMust = ctx.approverMust;

  const bookkeeping = await openTheBooks({ orgId, ownerCall });
  results.push({
    id: "SETUP",
    description: "the fresh organization is brought to a chart + OPEN period through public mutations",
    status: "PASS",
    detail: bookkeeping,
  });

  // ── A1 — the launch chart, on a genuinely fresh cloud deployment ───────────
  await recordCase(results, "A1", "the launch chart exists with 2110 as a LIABILITY", async () => {
    const accounts = await ownerMust("query", "chartOfAccounts:list", { orgId });
    const unapplied = accounts.find((a) => a.code === "2110");
    if (!unapplied) fail("account 2110 is absent from the chart of this fresh organization");
    if (unapplied.type !== "LIABILITY") {
      fail(`2110 must be a LIABILITY — customer money received is not money earned — but is ${unapplied.type}`);
    }
    const legacy = accounts.find((a) => a.code === "1220");
    return {
      code2110: { code: unapplied.code, type: unapplied.type, name: unapplied.name },
      legacy1220Present: Boolean(legacy),
      accountCount: accounts.length,
    };
  });

  // ── A2 — an OPEN period, so nothing below is held for the wrong reason ─────
  await recordCase(results, "A2", "an accounting period is OPEN on this deployment", async () => {
    const periods = await ownerMust("query", "accountingPeriods:list", { orgId });
    const open = periods.filter((p) => p.status === "OPEN");
    if (open.length === 0) {
      fail("no OPEN accounting period — every posting below would be HELD, which would mask real failures");
    }
    return { openPeriods: open.length, totalPeriods: periods.length };
  });

  // ── D1 — a faithful lost-response retry, WITH server updates visible ───────
  await recordCase(
    results,
    "D1",
    "the SAME intent replayed after the server has moved on pays exactly once",
    async () => {
      const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "d1" });
      const key = `release-deposit:${fx.depositId}:REFUNDED:CASH:gen0`;
      const args = {
        orgId,
        depositId: fx.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
        idempotencyKey: key,
      };

      await resolverMust("mutation", "deposits:release", args);
      const afterFirst = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });

      // The operator's response was lost. The server has since moved on — the
      // deposit row now carries releaseCount 1 and a released amount — and the
      // client, having never been told, submits the SAME intent again.
      const replay = await resolverCall("mutation", "deposits:release", args);
      if (!replay.ok) {
        fail(`a faithful retry of the same intent was REFUSED (${replay.error}); a retry must replay, not fail`);
      }
      const afterReplay = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });

      expectEqual(afterReplay.releasedAmountMinor, 2_000_000, "released amount after the replay");
      expectEqual(afterReplay.releaseCount, 1, "releaseCount after the replay");
      expectEqual(afterReplay.refundedAmountMinor, 2_000_000, "refunded amount after the replay");
      return {
        depositId: fx.depositId,
        afterFirst: { released: afterFirst.releasedAmountMinor, releaseCount: afterFirst.releaseCount },
        afterReplay: { released: afterReplay.releasedAmountMinor, releaseCount: afterReplay.releaseCount },
      };
    }
  );

  // ── D2 — a genuinely NEW payout must not be suppressed ─────────────────────
  await recordCase(
    results,
    "D2",
    "the next generation is a new command, so the freed remainder is actually paid",
    async () => {
      const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "d2" });
      const base = {
        orgId,
        depositId: fx.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
      };
      await resolverMust("mutation", "deposits:release", {
        ...base,
        idempotencyKey: `release-deposit:${fx.depositId}:REFUNDED:CASH:gen0`,
      });

      // The second car falls away through a SUPPORTED operation, freeing its
      // share. No row is forced.
      await ownerMust("mutation", "deposits:allocateToVehicles", {
        orgId,
        quoteId: fx.quoteId,
        allocations: [
          { vehicleId: fx.vehicleA, amount: 2000 },
          { vehicleId: fx.vehicleB, amount: 0 },
        ],
      });

      await resolverMust("mutation", "deposits:release", {
        ...base,
        idempotencyKey: `release-deposit:${fx.depositId}:REFUNDED:CASH:gen1`,
      });

      const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      expectEqual(after.releaseCount, 2, "releaseCount after the second genuine payout");
      expectEqual(after.releasedAmountMinor, 3_000_000, "released amount after the second genuine payout");
      return { depositId: fx.depositId, releaseCount: after.releaseCount, released: after.releasedAmountMinor };
    }
  );

  // ── D3 — the same key with different content is REFUSED, not replayed ──────
  await recordCase(results, "D3", "the same key with a changed refund method is refused", async () => {
    const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "d3" });
    const key = `release-deposit:${fx.depositId}:REFUNDED:CASH:gen0`;
    await resolverMust("mutation", "deposits:release", {
      orgId,
      depositId: fx.depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: key,
    });
    const conflict = await resolverCall("mutation", "deposits:release", {
      orgId,
      depositId: fx.depositId,
      resolution: "REFUNDED",
      refundMethod: "BANK_TRANSFER",
      idempotencyKey: key,
    });
    if (conflict.ok) {
      fail("a changed refund method under the same key was ACCEPTED — it must be refused, not silently deduped");
    }
    const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
    expectEqual(after.releaseCount, 1, "releaseCount after the refused conflict");
    return { refusal: conflict.error.slice(0, 200), releaseCount: after.releaseCount };
  });

  // ── D4 — an economic command with NO identity is refused before it posts ───
  await recordCase(results, "D4", "a release with no command identity is refused", async () => {
    const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "d4" });
    const naked = await resolverCall("mutation", "deposits:release", {
      orgId,
      depositId: fx.depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });
    if (naked.ok) fail("a release with no idempotencyKey was accepted");
    const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
    expectEqual(after.releasedAmountMinor ?? 0, 0, "released amount after the refused unidentified command");
    return { refusal: naked.error.slice(0, 200) };
  });

  // ── C1 — SAME-KEY attempts in flight together ─────────────────────────────
  await recordCase(
    results,
    "C1",
    "two SAME-KEY releases in flight together pay the free balance exactly once",
    async () => {
      const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "c1" });
      const key = `release-deposit:${fx.depositId}:REFUNDED:CASH:gen0`;
      const args = {
        orgId,
        depositId: fx.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
        idempotencyKey: key,
      };
      const attempts = await fireConcurrentReleases({
        convexUrl: config.convexUrl,
        attempts: [
          { label: "same-key-1", token: tokens.approver, args },
          { label: "same-key-2", token: tokens.approver, args },
        ],
      });

      const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      expectEqual(after.releasedAmountMinor, 2_000_000, "released amount after two same-key concurrent attempts");
      expectEqual(after.releaseCount, 1, "releaseCount after two same-key concurrent attempts");
      return { attempts, after: { released: after.releasedAmountMinor, releaseCount: after.releaseCount } };
    }
  );

  // ── C2 — DISTINCT-KEY attempts against ONE unchanged free balance ─────────
  //
  // The case the generation cannot answer on its own, and the reason this
  // rehearsal had to leave `convex-test`. Two DIFFERENT keys are, by identity
  // alone, two different commands — so nothing in the command log stops the
  // second. What must stop it is the server recomputing the free balance: the
  // loser either loses an OCC race and retries into "nothing left", or finds
  // nothing free and refuses. Either way the money leaves ONCE.
  await recordCase(
    results,
    "C2",
    "two DISTINCT-KEY releases in flight together cannot pay one free balance twice",
    async () => {
      const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "c2" });
      const base = {
        orgId,
        depositId: fx.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
      };
      const attempts = await fireConcurrentReleases({
        convexUrl: config.convexUrl,
        attempts: [
          { label: "distinct-key-1", token: tokens.approver, args: { ...base, idempotencyKey: `rehearsal-c2-a-${uuid()}` } },
          { label: "distinct-key-2", token: tokens.approver, args: { ...base, idempotencyKey: `rehearsal-c2-b-${uuid()}` } },
        ],
      });

      const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      // The whole claim: the free 2,000 left the business once, no matter how
      // many distinct identities asked for it simultaneously.
      expectEqual(after.releasedAmountMinor, 2_000_000, "released amount after two distinct-key concurrent attempts");
      expectEqual(after.refundedAmountMinor, 2_000_000, "refunded amount after two distinct-key concurrent attempts");
      expectEqual(after.releaseCount, 1, "releaseCount after two distinct-key concurrent attempts");
      return { attempts, after: { released: after.releasedAmountMinor, releaseCount: after.releaseCount } };
    }
  );

  // ── UNAUTH — authority is enforced by the SERVER, not by the client ───────
  //
  // This replaces a case that asserted "the salesperson cannot release a
  // deposit". That case could never have failed honestly: the bootstrap seats
  // the primary identity as OWNER, which holds every permission, so the case
  // would have been red for a reason that has nothing to do with authority.
  // An assertion that cannot distinguish the property it names from an
  // unrelated misconfiguration is not evidence.
  //
  // An UNAUTHENTICATED release is the version that cannot be wrong for an
  // incidental reason: no identity at all must never move money, whatever the
  // role mapping happens to be.
  await recordCase(results, "UNAUTH", "an unauthenticated release is refused", async () => {
    const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "unauth" });
    const attempt = await ctx.anonymousCall("mutation", "deposits:release", {
      orgId,
      depositId: fx.depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: `rehearsal-unauth-${uuid()}`,
    });
    if (attempt.ok) fail("a release with NO authentication was accepted");
    const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
    expectEqual(after.releasedAmountMinor ?? 0, 0, "released amount after the refused unauthenticated release");
    return { refusal: attempt.error.slice(0, 200) };
  });

  // ── TEN — naming an org you DO belong to is not the same as owning the row ─
  //
  // ⚠️ THIS CASE PASSED FOR THE WRONG REASON ONCE, WHICH IS WHY IT LOOKS LIKE
  // THIS NOW. It used to mutate one character of the real org id and assert the
  // refusal. It was refused — by the ARGUMENT VALIDATOR, because the mangled
  // string was not a well-formed Convex id at all. A green case that never
  // reached the ownership check is worse than no case: it reports tenancy as
  // proven while testing string syntax.
  //
  // The honest probe uses a SECOND REAL ORGANIZATION that the caller genuinely
  // belongs to and owns. Membership is then satisfied, the id is well-formed,
  // and the only thing standing between the caller and another tenant's money
  // is `requireOwnedRow` (TEN-1) — the exact check whose absence shipped two
  // cross-tenant Criticals.
  await recordCase(results, "TEN", "a VALID org the caller owns cannot reach another org's deposit", async () => {
    const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "ten" });
    const foreignOrgId = await resolverMust("mutation", "organizations:create", {
      name: `Rehearsal Second Dealership ${Date.now().toString(36)}`,
    });
    if (foreignOrgId === orgId) fail("the second organization is the same row; the probe would be vacuous");

    const attempt = await resolverCall("mutation", "deposits:release", {
      orgId: foreignOrgId,
      depositId: fx.depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: `rehearsal-tenancy-${uuid()}`,
    });
    if (attempt.ok) {
      fail("a release naming a DIFFERENT organization the caller owns was accepted — the deposit belongs to neither");
    }
    // The refusal must not be an argument-shape complaint, or this case has
    // quietly reverted to testing string syntax again.
    if (/ArgumentValidationError/i.test(attempt.error)) {
      fail(`the refusal came from the argument validator, not an ownership check: ${attempt.error.slice(0, 200)}`);
    }
    const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
    expectEqual(after.releasedAmountMinor ?? 0, 0, "released amount after the refused cross-tenant release");
    return { foreignOrgId, refusal: attempt.error.slice(0, 200) };
  });
}
