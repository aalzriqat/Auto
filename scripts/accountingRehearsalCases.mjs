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

let unproven = (reason) => {
  throw new Error(`UNPROVEN (no recorder bound): ${reason}`);
};

export async function runRehearsalCases(ctx) {
  const { results, orgId, recordCase, fireConcurrentReleases, tokens, config } = ctx;
  unproven = ctx.unproven;

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

      // BEFORE the state is read: did both requests actually happen, together?
      const execution = assertBothAttemptsExecuted(attempts, ["same-key-1", "same-key-2"], {
        productRefusals: [NOTHING_LEFT_REFUSAL],
      });
      // Same key, same content: the second is a REPLAY and must be served the
      // first's result. A product refusal here is not a harness problem — it
      // is the command log failing to recognise its own key.
      for (const [label, outcome] of Object.entries(execution.outcomes)) {
        if (outcome !== "success") fail(`same-key attempt ${label} was refused by the product instead of replayed`);
      }

      const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      expectEqual(after.releasedAmountMinor, 2_000_000, "released amount after two same-key concurrent attempts");
      expectEqual(after.releaseCount, 1, "releaseCount after two same-key concurrent attempts");
      return { execution, attempts, after: { released: after.releasedAmountMinor, releaseCount: after.releaseCount } };
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

      const execution = assertBothAttemptsExecuted(attempts, ["distinct-key-1", "distinct-key-2"], {
        productRefusals: [NOTHING_LEFT_REFUSAL],
      });

      const after = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      // The whole claim: the free 2,000 left the business once, no matter how
      // many distinct identities asked for it simultaneously.
      expectEqual(after.releasedAmountMinor, 2_000_000, "released amount after two distinct-key concurrent attempts");
      expectEqual(after.refundedAmountMinor, 2_000_000, "refunded amount after two distinct-key concurrent attempts");
      expectEqual(after.releaseCount, 1, "releaseCount after two distinct-key concurrent attempts");
      return { execution, attempts, after: { released: after.releasedAmountMinor, releaseCount: after.releaseCount } };
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
    expectEqual(after.releaseCount ?? 0, 0, "releaseCount after the refused cross-tenant release");
    expectEqual(after.status, "HELD", "deposit status after the refused cross-tenant release");
    return { foreignOrgId, refusal: attempt.error.slice(0, 200) };
  });

  // ── A3 — the chart is not merely present, it is COMPLETE ──────────────────
  //
  // A1 proves 2110 exists and is a liability. That is one account. The product
  // has a set of accounts it requires by systemKey, and a chart missing any of
  // them posts into nothing — so the chart's own validator is the assertion,
  // rather than a list of codes this file would have to keep in step by hand.
  await recordCase(results, "A3", "the fresh chart satisfies the product's own system-account validator", async () => {
    const report = await ownerMust("query", "chartOfAccounts:validateSystemAccounts", { orgId });
    const missing = report?.missing ?? [];
    if (missing.length > 0) {
      fail(`the chart is missing required system accounts: ${missing.join(", ")}`);
    }
    return { missingSystemAccounts: missing.length, report: summarizeValidation(report) };
  });

  // ── B1 — the deposit row is reconciled TO THE BOOKS, not instead of them ───
  //
  // Every deposit case above reads `releasedAmountMinor` and `releaseCount` off
  // the deposit row. That is the row agreeing with itself. A release also emits
  // a domain event, a canonical payment and a journal, and the defect that
  // matters most in this lane — money reported as moved that did not move, or
  // moved twice — can sit entirely in the gap between the row and the ledger.
  //
  // So this case performs a release and then reconciles FOUR independent
  // surfaces for the same money: the deposit row, the accounting event, the
  // canonical payment, and the journal. It also replays the identical intent,
  // because a retry that quietly posted a SECOND event while leaving the row
  // untouched would pass every D-case in this file.
  await recordCase(
    results,
    "B1",
    "a release reconciles exactly across deposit row, accounting event, canonical payment and journal",
    async () => {
      const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "b1" });
      const args = {
        orgId,
        depositId: fx.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
        idempotencyKey: `release-deposit:${fx.depositId}:REFUNDED:CASH:gen0`,
      };
      await resolverMust("mutation", "deposits:release", args);
      const replay = await resolverCall("mutation", "deposits:release", args);
      if (!replay.ok) fail(`the faithful replay was refused: ${replay.error.slice(0, 200)}`);

      const row = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      expectEqual(row.releasedAmountMinor, 2_000_000, "released amount on the deposit row");
      expectEqual(row.releaseCount, 1, "releaseCount on the deposit row");

      // ONE event for this deposit, carrying the SAME amount the row claims.
      const events = await ownerMust("query", "accountingLedger:listAccountingEvents", {
        orgId,
        sourceType: "deposits",
        sourceId: String(fx.depositId),
        limit: 200,
      });
      const refunds = (events ?? []).filter((e) => e.eventType === "DEPOSIT_REFUNDED");
      expectEqual(refunds.length, 1, "DEPOSIT_REFUNDED events for this deposit (the replay must not post a second)");
      expectEqual(
        refunds[0]?.payload?.amountMinor,
        row.releasedAmountMinor,
        "the accounting event's amount against the deposit row's released amount"
      );

      // The canonical payment for that refund, found through the supported
      // listing rather than by constructing an id.
      // Matched on the REFERENCE, which the product writes as
      // `Deposit refund <depositId>`, rather than on the vehicle. The deposit's
      // vehicle is derived from the quote rather than passed in, so filtering by
      // vehicle would have been an assumption about a field this rehearsal never
      // sets — and one that would silently widen if a fixture ever shared a car.
      const payments = await listCollectionPayments({ orgId, ownerMust });
      const refundRows = payments.filter(
        (p) =>
          p.direction === "OUT" &&
          p.method === "REFUND" &&
          String(p.reference ?? "").includes(String(fx.depositId))
      );
      expectEqual(refundRows.length, 1, "outbound REFUND collection payments for this deposit");
      const canonicalId = refundRows[0]?.canonicalPaymentId;
      if (!canonicalId) fail("the refund collection payment carries no canonicalPaymentId — the books were not reached");
      const balance = await ownerMust("query", "subledger:getPaymentBalance", {
        orgId,
        paymentId: canonicalId,
      });
      if (!balance?.payment) fail("the canonical payment for this refund could not be read back");
      expectEqual(
        balance.payment.amountMinor,
        row.releasedAmountMinor,
        "the canonical payment's amount against the deposit row's released amount"
      );

      // THE JOURNAL — the surface this case NAMED and, until the owner-proxy read
      // the runner at 1c0bd6e48, never actually fetched. Three surfaces agreed
      // and the fourth was asserted by its title. B2's per-entry balance cannot
      // stand in for it: a balanced entry on the wrong accounts, or a second
      // balanced entry for the same refund, passes B2 and misstates the books.
      //
      // So: the ONE DEPOSIT_REFUNDED event's own journal entry, its lines
      // resolved through the org's chart, and the posting the product's rule
      // declares for a CASH refund — deposit liability released, cash paid out
      // — with the amount in the org's denomination and nothing else on it.
      const denom = await orgDenomination({ orgId, ownerMust });
      const expectedReleasedMinor = 2000 * denom.minorPerMajor;
      expectEqual(row.releasedAmountMinor, expectedReleasedMinor, `released amount in ${denom.currency} minor units`);
      const { keyOf } = await chartIndex({ orgId, ownerMust });
      const journal = await eventAndJournal({
        orgId,
        ownerMust,
        sourceType: "deposits",
        sourceId: fx.depositId,
        eventType: "DEPOSIT_REFUNDED",
      });
      expectEqual(journal.entry.status, "POSTED", "the refund journal entry's status");
      expectEqual(journal.entry.category, "SYSTEM", "the refund journal entry's category");
      expectExactLines(
        journal.lines,
        keyOf,
        [
          { key: "CUSTOMER_DEPOSITS_LIABILITY", debitMinor: expectedReleasedMinor },
          { key: "CASH_ON_HAND", creditMinor: expectedReleasedMinor },
        ],
        { currency: denom.currency, decimals: denom.decimals, what: "the deposit refund posting", customerId: fx.customerId }
      );
      // And every entry the ledger holds for this deposit is bound to one of the
      // deposit's OWN events — taking the deposit posts too (DEPOSIT_RECEIVED on
      // the same source), so "one entry for this source" would accuse the
      // product falsely; the fake caught that before the cloud did. What must
      // be true: no orphan entry for this source, and exactly one bound to the
      // refund. A second balanced entry for the refund, however it got there,
      // is the duplicate B2 cannot see.
      const depositEvents = await ownerMust("query", "accountingLedger:listAccountingEvents", {
        orgId, sourceType: "deposits", sourceId: String(fx.depositId), limit: 200,
      });
      const eventIds = new Set((depositEvents ?? []).map((e) => String(e._id)));
      const allEntries = await ownerMust("query", "accountingLedger:listJournalEntries", { orgId, limit: 200 });
      const forDeposit = (allEntries ?? []).filter(
        (e) => e.sourceType === "deposits" && String(e.sourceId) === String(fx.depositId)
      );
      const orphans = forDeposit.filter((e) => !eventIds.has(String(e.accountingEventId)));
      if (orphans.length > 0) {
        fail(`${orphans.length} journal entr(y/ies) for this deposit are bound to none of its events — a posting the event log does not know about`);
      }
      const refundEntries = forDeposit.filter((e) => String(e.accountingEventId) === String(journal.event._id));
      expectEqual(refundEntries.length, 1, "journal entries bound to this deposit's refund event");

      return {
        depositId: fx.depositId,
        row: { released: row.releasedAmountMinor, releaseCount: row.releaseCount },
        event: {
          count: refunds.length,
          amountMinor: refunds[0]?.payload?.amountMinor ?? null,
          eventVersion: refunds[0]?.eventVersion ?? null,
        },
        canonicalPayment: {
          id: String(canonicalId),
          amountMinor: balance.payment.amountMinor,
          status: balance.payment.status ?? null,
          unappliedMinor: balance.unappliedMinor ?? null,
        },
        journal: {
          entryId: String(journal.entry._id),
          journalNumber: journal.entry.journalNumber ?? null,
          currency: denom.currency,
          decimals: denom.decimals,
          lines: journal.lines.map((l) => ({
            account: keyOf.get(String(l.accountId)) ?? "?",
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
          entriesForThisDeposit: forDeposit.length,
          entriesBoundToRefund: refundEntries.length,
        },
      };
    }
  );

  // ── B2 — every journal entry balances, and nothing is stuck in the outbox ──
  //
  // Per-entry balance is the floor's wording and it is the right level: a GL
  // whose TOTAL debits equal its total credits can still contain two entries
  // that are individually wrong in opposite directions. Checking each entry
  // catches that; checking the sum does not.
  //
  // The outbox is the other half. A posting that failed on its way to the
  // ledger leaves the deposit row looking settled while the books never
  // received it, which is precisely the shape that would make every case above
  // pass while the dealership's accounts are wrong.
  await recordCase(
    results,
    "B2",
    "every journal entry balances per entry and no accounting event is stuck FAILED",
    async () => {
      const entries = await ownerMust("query", "accountingLedger:listJournalEntries", { orgId, limit: 200 });
      const unbalanced = [];
      let linesRead = 0;
      for (const entry of entries ?? []) {
        // `listJournalEntries` returns the ENTRY rows only; the lines live in a
        // separate table and arrive through `getJournalEntry`. Summing a `lines`
        // field that the list query never returns would have made every entry
        // balance at 0 === 0 — a green check measuring nothing.
        const detail = await ownerMust("query", "accountingLedger:getJournalEntry", {
          orgId,
          journalEntryId: entry._id,
        });
        const lines = detail?.lines ?? [];
        if (lines.length === 0) {
          unbalanced.push({ entryId: String(entry._id), reason: "entry has no journal lines" });
          continue;
        }
        linesRead += lines.length;
        const debit = lines.reduce((sum, l) => sum + (l.debitMinor ?? 0), 0);
        const credit = lines.reduce((sum, l) => sum + (l.creditMinor ?? 0), 0);
        if (debit !== credit) {
          unbalanced.push({ entryId: String(entry._id), debit, credit });
        }
      }
      if (unbalanced.length > 0) {
        fail(`journal entries that do not balance: ${JSON.stringify(unbalanced).slice(0, 400)}`);
      }

      const failed = await ownerMust("query", "accountingOutbox:listPending", {
        orgId,
        status: "FAILED",
        limit: 200,
      });
      if ((failed ?? []).length > 0) {
        fail(
          `${failed.length} accounting event(s) are FAILED in the outbox — the rows above are settled but the ` +
            `books never received them: ${JSON.stringify(failed.slice(0, 3)).slice(0, 400)}`
        );
      }
      const pending = await ownerMust("query", "accountingOutbox:listPending", {
        orgId,
        status: "PENDING",
        limit: 200,
      });

      // An empty ledger would pass both checks above vacuously.
      if ((entries ?? []).length === 0) {
        fail("no journal entries exist at all — a balance check over nothing is not evidence");
      }
      return {
        journalEntries: entries.length,
        journalLinesChecked: linesRead,
        unbalancedEntries: 0,
        failedOutboxEvents: 0,
        pendingOutboxEvents: (pending ?? []).length,
      };
    }
  );
  // ── RT1 — the retry contract on OTHER identity-guarded economic commands ───
  //
  // `deposits.release` has D1. It is one command out of the thirty-eight the
  // census classifies IDENTITY_GUARDED, and the rehearsal INVOKES several of the
  // others to build its fixtures — which is not the same as proving anything
  // about them. Creating a deposit successfully says nothing about what a
  // second delivery of that same create does.
  //
  // The contract being tested is the one SCRUM-57 states: an economic command
  // identity is minted once per intent and preserved across retries, so a
  // replayed intent REPLAYS — it neither fails nor happens twice.
  //
  // Both halves matter and they fail differently. A replay that is REFUSED
  // (a uniqueness barrier, say) looks safe and is not: the operator is told the
  // command failed while the first one stands, and the natural next action is to
  // try again with fresh content. A replay that SUCCEEDS by acting twice is the
  // double-spend. So each case asserts the replay was accepted AND that it
  // returned the identity of the original row.
  await recordCase(
    results,
    "RT1",
    "replaying deposits.create and vehicles.create with the same identity replays rather than duplicating",
    async () => {
      const stamp = Date.now().toString(36);
      const vin = `RHSRT1${stamp.replace(/[ioq]/g, "z").toUpperCase()}`.padEnd(17, "0").slice(0, 17);
      const vehicleArgs = {
        orgId,
        vin,
        make: "Toyota",
        model: "Camry-rt1",
        year: 2022,
        mileage: 800,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 22000,
        sourceType: "STOCK",
        status: "AVAILABLE",
        purchasePrice: 15000,
        purchasePaymentMethod: "CASH",
        idempotencyKey: `rehearsal-rt1-vehicle-${stamp}`,
      };
      const firstVehicle = await ownerMust("mutation", "vehicles:create", vehicleArgs);
      const vehicleReplay = await ownerCall("mutation", "vehicles:create", vehicleArgs);
      if (!vehicleReplay.ok) {
        fail(
          `replaying vehicles.create with the SAME identity was refused (${vehicleReplay.error.slice(0, 200)}). ` +
            `A refused retry is not a safe retry: the first command stands while the operator is told it failed.`
        );
      }
      if (String(vehicleReplay.value) !== String(firstVehicle)) {
        fail(
          `replaying vehicles.create returned a DIFFERENT id (${vehicleReplay.value} vs ${firstVehicle}) — ` +
            `the retry created a second vehicle`
        );
      }

      const customerId = await ownerMust("mutation", "customers:create", {
        orgId,
        firstName: "Rehearsal",
        lastName: `rt1-${stamp}`,
      });
      const quoteId = await ownerMust("mutation", "quotes:saveQuote", {
        orgId,
        customerId,
        vehicleId: firstVehicle,
        vehicleItems: [{ vehicleId: firstVehicle, unitPrice: 22000 }],
        mode: "CASH",
        vehiclePrice: 22000,
        downPayment: 0,
        termMonths: 0,
      });
      const depositArgs = {
        orgId,
        quoteId,
        amount: 5000,
        idempotencyKey: `rehearsal-rt1-deposit-${stamp}`,
      };
      const firstDeposit = await ownerMust("mutation", "deposits:create", depositArgs);
      const depositReplay = await ownerCall("mutation", "deposits:create", depositArgs);
      if (!depositReplay.ok) {
        fail(`replaying deposits.create with the SAME identity was refused: ${depositReplay.error.slice(0, 200)}`);
      }
      if (String(depositReplay.value) !== String(firstDeposit)) {
        fail(
          `replaying deposits.create returned a DIFFERENT id (${depositReplay.value} vs ${firstDeposit}) — ` +
            `the customer's money was recorded twice`
        );
      }

      // And the row count is the real arbiter: ids could agree while a second
      // row existed, if the command returned something cached.
      const rows = await ownerMust("query", "deposits:listByVehicle", { orgId, vehicleId: firstVehicle });
      const mine = (rows ?? []).filter((r) => String(r._id) === String(firstDeposit));
      expectEqual(mine.length, 1, "deposit rows for this vehicle after the replay");
      expectEqual((rows ?? []).length, 1, "TOTAL deposit rows for this vehicle after the replay");

      return {
        vehicle: { id: String(firstVehicle), replayReturnedSameId: true },
        deposit: { id: String(firstDeposit), replayReturnedSameId: true, rowsForVehicle: rows.length },
        commandsProven: ["vehicles.create", "deposits.create"],
        commandsStillUnproven:
          "RT2 covers eight more; the remaining IDENTITY_GUARDED commands have no cloud retry proof — see the evidence inventory",
      };
    }
  );

  // ── RT2 — the retry contract on the commands the floor ORDERED by name ────
  //
  // The owner-proxy's list, verbatim: createReceivable, the whole
  // createInstallmentPlan, fixedAssets.capitalize, partnerEquity.add with an
  // opening contribution, recordEquityMovement, vehicles.createReservation,
  // workOrders.create, and workOrders.update's state barrier. Not the census;
  // these eight.
  //
  // Each proof has two halves. The IDENTITY half is RT1's contract — a replay
  // is accepted and returns the original identity. The FOOTPRINT half is what
  // makes the first half worth anything: exactly ONE accounting occurrence for
  // the thing created, and exactly one row where the product lists rows. A
  // command can hand back the same id twice and still have posted twice.
  await recordCase(
    results,
    "RT2",
    "the eight named economic commands replay once and leave one footprint each",
    async () => {
      const stamp = Date.now().toString(36);
      const denom = await orgDenomination({ orgId, ownerMust });
      const m = denom.minorPerMajor;
      const dueDate = Date.now() + 14 * 24 * 60 * 60 * 1000;
      const customerId = await ownerMust("mutation", "customers:create", {
        orgId,
        firstName: "Rehearsal",
        lastName: `rt2-${stamp}`,
      });
      const oneEvent = async (sourceType, sourceId, eventType, what) => {
        const events = await ownerMust("query", "accountingLedger:listAccountingEvents", {
          orgId, sourceType, sourceId: String(sourceId), limit: 200,
        });
        const n = (events ?? []).filter((e) => e.eventType === eventType).length;
        expectEqual(n, 1, `${eventType} occurrences for ${what}`);
      };
      const proven = {};

      // 1. createReceivable — one debt, one RECEIVABLE_CREATED.
      const receivableId = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "collections:createReceivable", what: "collections.createReceivable",
        args: {
          orgId, customerId, sourceType: "OTHER", creditSystemKey: "MISCELLANEOUS_INCOME",
          title: `Rehearsal RT2 receivable ${stamp}`, amount: 300, dueDate,
          idempotencyKey: `rehearsal-rt2-recv-${stamp}`,
        },
      });
      await oneEvent("receivables", receivableId, "RECEIVABLE_CREATED", "the receivable");
      proven["collections.createReceivable"] = { id: String(receivableId) };

      // 2. createInstallmentPlan — the WHOLE plan: three debts, three events,
      //    and the replay returns the same three ids, not three more.
      const planIds = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "collections:createInstallmentPlan", what: "collections.createInstallmentPlan",
        args: {
          orgId, customerId, sourceType: "OTHER", creditSystemKey: "MISCELLANEOUS_INCOME",
          title: `Rehearsal RT2 plan ${stamp}`, totalAmount: 900, installmentCount: 3, firstDueDate: dueDate,
          idempotencyKey: `rehearsal-rt2-plan-${stamp}`,
        },
      });
      if (!Array.isArray(planIds)) fail(`createInstallmentPlan returned ${JSON.stringify(planIds)} rather than the plan's receivable ids`);
      expectEqual(planIds.length, 3, "receivables minted by a three-instalment plan");
      let planTotal = 0;
      for (const rid of planIds) {
        await oneEvent("receivables", rid, "RECEIVABLE_CREATED", `instalment ${rid}`);
        const row = await findReceivable({ orgId, ownerMust, receivableId: rid });
        planTotal += row.originalAmount ?? row.outstandingAmount ?? 0;
      }
      expectEqual(planTotal, 900, "the plan's instalments sum to the plan total");
      proven["collections.createInstallmentPlan"] = { ids: planIds.map(String), total: planTotal };

      // 3. fixedAssets.capitalize — one asset, one ASSET_CAPITALIZED.
      const assetId = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "fixedAssets:capitalize", what: "fixedAssets.capitalize",
        args: {
          orgId, name: `Rehearsal RT2 lift ${stamp}`, purchaseDate: Date.now(), costMinor: 1500 * m,
          usefulLifeMonths: 12, paymentMethod: "CASH", idempotencyKey: `rehearsal-rt2-asset-${stamp}`,
        },
      });
      await oneEvent("fixedAssets", assetId, "ASSET_CAPITALIZED", "the asset");
      const assetsPage = await ownerMust("query", "fixedAssets:list", { orgId, paginationOpts: { numItems: 200, cursor: null } });
      const sameName = (assetsPage?.page ?? []).filter((a) => a.name === `Rehearsal RT2 lift ${stamp}`);
      expectEqual(sameName.length, 1, "fixed-asset rows carrying this capitalization's name");
      proven["fixedAssets.capitalize"] = { id: String(assetId) };

      // 4. partnerEquity.add WITH opening capital — one partner, one movement,
      //    one CAPITAL_CONTRIBUTED.
      const partnerId = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "partnerEquity:add", what: "partnerEquity.add",
        args: {
          orgId, partnerName: `Rehearsal Partner ${stamp}`, openingContributionMinor: 2500 * m, paymentMethod: "CASH",
          idempotencyKey: `rehearsal-rt2-partner-${stamp}`,
        },
      });
      const partnersPage = await ownerMust("query", "partnerEquity:list", { orgId, paginationOpts: { numItems: 200, cursor: null } });
      const samePartner = (partnersPage?.page ?? []).filter((p) => p.partnerName === `Rehearsal Partner ${stamp}`);
      expectEqual(samePartner.length, 1, "partner rows carrying this name after the replay");
      let txs = await ownerMust("query", "partnerEquity:listTransactions", { orgId, partnerId });
      expectEqual((txs ?? []).length, 1, "equity movements for the partner after add + replay");
      await oneEvent("partnerEquityTransactions", txs[0]._id, "CAPITAL_CONTRIBUTED", "the opening contribution");
      expectEqual(txs[0].amountMinor, 2500 * m, "the opening contribution's amount");
      proven["partnerEquity.add"] = { id: String(partnerId), movementId: String(txs[0]._id) };

      // 5. recordEquityMovement — a DRAW the balance would permit TWICE, so the
      //    balance check is not the barrier; identity is.
      const drawId = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "partnerEquity:recordEquityMovement", what: "partnerEquity.recordEquityMovement",
        args: {
          orgId, partnerId, type: "DRAW", amountMinor: 500 * m, paymentMethod: "CASH",
          idempotencyKey: `rehearsal-rt2-draw-${stamp}`,
        },
      });
      txs = await ownerMust("query", "partnerEquity:listTransactions", { orgId, partnerId });
      expectEqual((txs ?? []).length, 2, "equity movements for the partner after the draw + replay");
      await oneEvent("partnerEquityTransactions", drawId, "PARTNER_DREW", "the draw");
      proven["partnerEquity.recordEquityMovement"] = { id: String(drawId) };

      // 6. vehicles.createReservation WITH a deposit — one reservation, one
      //    deposit row for the car, one DEPOSIT_RECEIVED.
      const reservedVehicle = await makeVehicle({ orgId, ownerMust, label: "rt2res" });
      const reservationId = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "vehicles:createReservation", what: "vehicles.createReservation",
        args: {
          orgId, vehicleId: reservedVehicle, customerId, depositAmount: 300, depositMethod: "CASH",
          idempotencyKey: `rehearsal-rt2-reservation-${stamp}`,
        },
      });
      const reservationDeposits = await ownerMust("query", "deposits:listByVehicle", { orgId, vehicleId: reservedVehicle });
      expectEqual((reservationDeposits ?? []).length, 1, "deposit rows for the reserved vehicle after create + replay");
      await oneEvent("deposits", reservationDeposits[0]._id, "DEPOSIT_RECEIVED", "the reservation deposit");
      expectEqual(reservationDeposits[0].amountMinor ?? reservationDeposits[0].amount * m, 300 * m, "the reservation deposit's amount");
      proven["vehicles.createReservation"] = { id: String(reservationId), depositId: String(reservationDeposits[0]._id) };

      // 7. workOrders.create COMPLETED — the expense is minted BEFORE the work
      //    order row exists, so nothing durable could identify a retry but the
      //    intent identity. One work order, one expense, one EXPENSE_POSTED.
      const woVehicle = await makeVehicle({ orgId, ownerMust, label: "rt2wo" });
      const task = { id: `t-${stamp}`, description: "Brake pads", partsCost: 100, laborCost: 50, completed: true };
      const workOrderId = await replayMustReturnSame({
        call: ownerCall, must: ownerMust, fnPath: "workOrders:create", what: "workOrders.create",
        args: {
          orgId, vehicleId: woVehicle, title: `Rehearsal RT2 WO ${stamp}`, status: "COMPLETED", tasks: [task],
          idempotencyKey: `rehearsal-rt2-wo-${stamp}`,
        },
      });
      const wos = await ownerMust("query", "workOrders:list", { orgId, vehicleId: woVehicle });
      expectEqual((wos ?? []).length, 1, "work orders for the vehicle after create + replay");
      const wo = wos[0];
      if (!wo.expenseId) fail("the COMPLETED work order carries no expenseId — its cost never reached the books");
      await oneEvent("expenses", wo.expenseId, "EXPENSE_POSTED", "the work order's expense");
      proven["workOrders.create"] = { id: String(workOrderId), expenseId: String(wo.expenseId) };

      // 8. workOrders.update's STATE BARRIER — an OPEN order completed through
      //    update posts once; a second update against the posted expense is
      //    REFUSED as locked, and the footprint stays at one.
      const barrierVehicle = await makeVehicle({ orgId, ownerMust, label: "rt2bar" });
      const openId = await ownerMust("mutation", "workOrders:create", {
        orgId, vehicleId: barrierVehicle, title: `Rehearsal RT2 barrier ${stamp}`, status: "OPEN",
        tasks: [{ ...task, completed: false }], idempotencyKey: `rehearsal-rt2-open-${stamp}`,
      });
      await ownerMust("mutation", "workOrders:update", {
        orgId, workOrderId: openId, title: `Rehearsal RT2 barrier ${stamp}`, status: "COMPLETED", tasks: [task],
      });
      const afterComplete = (await ownerMust("query", "workOrders:list", { orgId, vehicleId: barrierVehicle })).find(
        (w) => String(w._id) === String(openId)
      );
      if (!afterComplete?.expenseId) fail("completing the work order through update posted no expense");
      await oneEvent("expenses", afterComplete.expenseId, "EXPENSE_POSTED", "the work order completed through update");
      const locked = await ownerCall("mutation", "workOrders:update", {
        orgId, workOrderId: openId, title: `Rehearsal RT2 barrier ${stamp} edited`, status: "COMPLETED", tasks: [task],
      });
      if (locked.ok) fail("a second update against a work order with a POSTED expense was ACCEPTED — the state barrier is open");
      if (!/locked/i.test(String(locked.error))) {
        unproven(`the second update was refused, but not by the state barrier: ${String(locked.error).slice(0, 160)}`);
      }
      await oneEvent("expenses", afterComplete.expenseId, "EXPENSE_POSTED", "the work order after the refused edit");
      const afterRefusal = (await ownerMust("query", "workOrders:list", { orgId, vehicleId: barrierVehicle })).find(
        (w) => String(w._id) === String(openId)
      );
      expectEqual(afterRefusal?.title, `Rehearsal RT2 barrier ${stamp}`, "the locked work order's title after the refused edit");
      proven["workOrders.update"] = { id: String(openId), expenseId: String(afterComplete.expenseId), refusal: String(locked.error).slice(0, 120) };

      return { currency: denom.currency, commandsProven: Object.keys(proven), proven };
    }
  );

  // ── RC1 — receipt allocation, and the money the dealership still OWES ──────
  //
  // A customer pays MORE than the invoice. The excess is not income and it is
  // not the dealership's — it is a liability that must be visible, discoverable
  // and dischargeable (ACC-9). The floor asks for receipt allocation AND
  // retained-money reconciliation together, because the failure that matters is
  // the pair coming apart: an over-payment that settles the receivable and then
  // cannot be found, or is found and quietly counted as revenue.
  //
  // Driven end to end through public mutations: receivable → over-payment →
  // read the retained position back → apply it to a SECOND receivable and watch
  // the liability fall to nothing.
  await recordCase(
    results,
    "RC1",
    "money received beyond any claim is retained as a discoverable, dischargeable liability",
    async () => {
      const stamp = Date.now().toString(36);
      const customerId = await ownerMust("mutation", "customers:create", {
        orgId,
        firstName: "Rehearsal",
        lastName: `rc1-${stamp}`,
      });
      const dueDate = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const firstReceivable = await ownerMust("mutation", "collections:createReceivable", {
        orgId,
        customerId,
        sourceType: "OTHER",
        // The product REFUSES to infer a credit account from an ambiguous source
        // type, and it is right to: guessing which account a receivable credits
        // is how revenue ends up in the wrong place with no error anywhere.
        creditSystemKey: "MISCELLANEOUS_INCOME",
        title: `Rehearsal invoice A ${stamp}`,
        amount: 1000,
        dueDate,
        idempotencyKey: `rehearsal-rc1-recv-a-${stamp}`,
      });
      const secondReceivable = await ownerMust("mutation", "collections:createReceivable", {
        orgId,
        customerId,
        sourceType: "OTHER",
        // The product REFUSES to infer a credit account from an ambiguous source
        // type, and it is right to: guessing which account a receivable credits
        // is how revenue ends up in the wrong place with no error anywhere.
        creditSystemKey: "MISCELLANEOUS_INCOME",
        title: `Rehearsal invoice B ${stamp}`,
        amount: 400,
        dueDate,
        idempotencyKey: `rehearsal-rc1-recv-b-${stamp}`,
      });

      // ⚠️ RETAINED CREDIT DOES NOT COME FROM OVER-PAYING AN INVOICE.
      //
      // My first version paid 1,500 against the 1,000 invoice and expected 500
      // to be retained. The product refused: "Payment amount cannot exceed the
      // outstanding receivable amount." That guard is right — an allocation
      // that exceeds what is owed is not an over-payment, it is a mis-keyed
      // allocation, and silently turning it into a credit would hide the
      // mistake.
      //
      // Money the dealership holds without a claim against it arrives as a
      // receipt ON ACCOUNT: a payment with no receivable named. So the two
      // things the floor asks about are genuinely two operations, and this case
      // exercises both — ALLOCATION against an invoice, then RETENTION of
      // unapplied money.
      const allocationPaymentId = await ownerMust("mutation", "collections:recordPayment", {
        orgId,
        receivableId: firstReceivable,
        customerId,
        amount: 1000,
        method: "CASH",
        paymentDate: Date.now(),
        reference: `Rehearsal RC1 allocation ${stamp}`,
        idempotencyKey: `rehearsal-rc1-pay-${stamp}`,
      });

      // 500 on account — no receivable named, so none of it is allocated.
      const onAccountPaymentId = await ownerMust("mutation", "collections:recordPayment", {
        orgId,
        customerId,
        amount: 500,
        method: "CASH",
        paymentDate: Date.now(),
        reference: `Rehearsal RC1 on account ${stamp}`,
        idempotencyKey: `rehearsal-rc1-onaccount-${stamp}`,
      });

      // The retained position is read through the operator-facing query, not
      // reconstructed here. A liability with no discoverable discharge path is
      // the defect SCRUM-218-C exists to have closed, so reading it the way an
      // operator would IS part of the assertion.
      //
      // PAGED PROPERLY, because `onlyRemaining` filters the PAGE and not the
      // query: a page can come back EMPTY while `isDone` is still false. A
      // single read would have reported "no retained credit" -- a financial
      // accusation -- for a position sitting on page two. The query documents
      // this in its own argument doc; I wrote the single-read version first.
      const positions = await readRetainedCredits({ orgId, customerId, ownerMust });
      if (positions.length === 0) {
        fail(
          "the receipt on account left NO retained-credit position - 500 of the customer's money is unaccounted " +
            "for, and an operator has no supported way to find or return it"
        );
      }
      const remainingMinor = positions.reduce((sum, p) => sum + (p.remainingUnappliedMinor ?? 0), 0);

      // ⚠️ THE DENOMINATION COMES FROM THE ORGANIZATION, NEVER FROM THE AMOUNT.
      //
      // The first version of this case derived the scale from the retained
      // amount itself (`scale = remaining / 500`) and then checked that
      // `remaining == 500 * scale` — which any amount divisible by 500 passes.
      // The owner-proxy read it and named it. The expectation is now built from
      // the org's currency and the product's own denomination table, and the
      // figure under test is not consulted.
      const denom = await orgDenomination({ orgId, ownerMust });
      const scale = denom.minorPerMajor;
      expectEqual(remainingMinor, 500 * scale, `retained credit remaining after a 500 ${denom.currency} receipt on account`);

      // THE RECEIPTS THEMSELVES, ON THE BOOKS. The allocation posts cash against
      // the receivable; the on-account receipt posts cash against 2110 — the
      // unapplied-receipts LIABILITY (ACC-9) — and nothing against revenue.
      const { keyOf, accountOf } = await chartIndex({ orgId, ownerMust });
      const allocation = await eventAndJournal({
        orgId, ownerMust, sourceType: "collectionPayments", sourceId: allocationPaymentId, eventType: "COLLECTION_PAYMENT",
      });
      expectExactLines(
        allocation.lines, keyOf,
        [{ key: "CASH_ON_HAND", debitMinor: 1000 * scale }, { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", creditMinor: 1000 * scale }],
        { currency: denom.currency, decimals: denom.decimals, what: "the allocated receipt", customerId }
      );
      const onAccount = await eventAndJournal({
        orgId, ownerMust, sourceType: "collectionPayments", sourceId: onAccountPaymentId, eventType: "COLLECTION_PAYMENT",
      });
      expectExactLines(
        onAccount.lines, keyOf,
        [{ key: "CASH_ON_HAND", debitMinor: 500 * scale }, { key: "UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY", creditMinor: 500 * scale }],
        { currency: denom.currency, decimals: denom.decimals, what: "the receipt on account", customerId }
      );

      // THE CONTROL BALANCE. The retained position is a subledger view; the
      // liability the dealership actually carries is the 2110 balance for this
      // customer in the GL. They must agree — a position that says 500 while
      // the control account says something else is the books disagreeing with
      // the operator's screen.
      const unappliedAccount = accountOf.get("UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY");
      const arAccount = accountOf.get("ACCOUNTS_RECEIVABLE_CUSTOMERS");
      if (!unappliedAccount || !arAccount) fail("the chart carries no 2110 / AR system account to reconcile against");
      const glBefore = await customerNetOnAccount({ orgId, ownerMust, accountId: unappliedAccount, customerId });
      expectEqual(
        glBefore.credit - glBefore.debit,
        remainingMinor,
        "2110 net credit for this customer in the GL against the retained position"
      );

      const position = positions[0];
      const movementId = position.receiptMovementId;
      if (!movementId) {
        fail(
          `the retained position carries no receipt-movement id, so applyRetainedCredit has no supported way to ` +
            `obtain its own argument: ${JSON.stringify(position).slice(0, 300)}`
        );
      }
      // The product states this precondition itself: a credit whose own journal
      // is still queued is visible but not yet applicable. Applying anyway and
      // then reporting the refusal as a defect would be an accusation about
      // timing rather than about behaviour.
      if (position.receiptPosted === false) {
        unproven(
          "the receipt's own journal has not posted yet, so applyRetainedCredit is legitimately not applicable; " +
            "the retained POSITION is proven, its discharge is not"
        );
      }

      const applied = await ownerCall("mutation", "collections:applyRetainedCredit", {
        orgId,
        receiptMovementId: movementId,
        receivableId: secondReceivable,
        requestedAmount: 400,
        idempotencyKey: `rehearsal-rc1-apply-${stamp}`,
      });
      if (!applied.ok) {
        fail(`applying the retained credit to a second invoice was refused: ${applied.error.slice(0, 200)}`);
      }

      const afterPositions = await readRetainedCredits({ orgId, customerId, ownerMust });
      const afterRemaining = afterPositions.reduce((sum, p) => sum + (p.remainingUnappliedMinor ?? 0), 0);
      expectEqual(afterRemaining, 100 * scale, "retained credit remaining after applying 400 of the 500");

      // The discharge is a posting too: 2110 down by 400, AR down by 400, and
      // the customer's control balances land where independent arithmetic says
      // — 2110 at 100 credit; AR at zero (1,000 + 400 owed, 1,000 + 400 settled).
      const applicationId = String(applied.value?.applicationId ?? "");
      if (!applicationId) fail(`applyRetainedCredit returned no applicationId: ${JSON.stringify(applied.value).slice(0, 200)}`);
      const applied400 = await eventAndJournal({
        orgId, ownerMust, sourceType: "receiptApplications", sourceId: applicationId, eventType: "RECEIPT_CREDIT_APPLIED",
        pick: (e) => String(e.payload?.applicationId ?? "") === applicationId,
      });
      expectExactLines(
        applied400.lines, keyOf,
        [{ key: "UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY", debitMinor: 400 * scale }, { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", creditMinor: 400 * scale }],
        { currency: denom.currency, decimals: denom.decimals, what: "the retained-credit application", customerId }
      );
      const glAfter = await customerNetOnAccount({ orgId, ownerMust, accountId: unappliedAccount, customerId });
      expectEqual(glAfter.credit - glAfter.debit, 100 * scale, "2110 net credit for this customer after applying 400");
      expectEqual(glAfter.credit - glAfter.debit, afterRemaining, "2110 GL balance against the retained position after the application");
      const arNet = await customerNetOnAccount({ orgId, ownerMust, accountId: arAccount, customerId });
      expectEqual(arNet.debit, 1400 * scale, "AR debits for this customer (two receivables created)");
      expectEqual(arNet.credit, 1400 * scale, "AR credits for this customer (1,000 allocated + 400 applied)");

      return {
        customerId: String(customerId),
        currency: denom.currency,
        minorUnitScale: scale,
        retainedAfterReceiptOnAccount: remainingMinor,
        retainedAfterApplying400: afterRemaining,
        gl: {
          unapplied2110NetCreditBefore: glBefore.credit - glBefore.debit,
          unapplied2110NetCreditAfter: glAfter.credit - glAfter.debit,
          arDebits: arNet.debit,
          arCredits: arNet.credit,
        },
        postings: {
          allocation: String(allocation.entry._id),
          onAccount: String(onAccount.entry._id),
          application: String(applied400.entry._id),
        },
        commandsExercised: ["collections.createReceivable", "collections.recordPayment", "collections.applyRetainedCredit"],
      };
    }
  );

  // ── RV1 — a cleared cheque that BOUNCES reverses; it does not vanish ───────
  //
  // ACC-3: every new way to spend creates new reversal obligations, and the
  // reversal must be SYMMETRIC — the money comes back off, and the history of
  // it having happened stays. A return implemented as a deletion balances just
  // as well and destroys the audit trail, so "the receivable is owed again" is
  // only half the assertion; the other half is that the original posting is
  // still there with a reversing entry against it.
  await recordCase(
    results,
    "RV1",
    "returning a CLEARED cheque reopens the exact debt and posts a linked, equal-and-opposite reversal",
    async () => {
      const stamp = Date.now().toString(36);
      const customerId = await ownerMust("mutation", "customers:create", {
        orgId,
        firstName: "Rehearsal",
        lastName: `rv1-${stamp}`,
      });
      const dueDate = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const receivableId = await ownerMust("mutation", "collections:createReceivable", {
        orgId,
        customerId,
        sourceType: "CHEQUE",
        creditSystemKey: "MISCELLANEOUS_INCOME",
        title: `Rehearsal cheque invoice ${stamp}`,
        amount: 1200,
        dueDate,
        idempotencyKey: `rehearsal-rv1-recv-${stamp}`,
      });

      const chequeId = await ownerMust("mutation", "collections:registerCheque", {
        orgId,
        receivableId,
        customerId,
        bank: "Rehearsal Bank",
        chequeNumber: `RV1${stamp}`.slice(0, 20),
        chequeDate: dueDate,
        amount: 1200,
      });

      await ownerMust("mutation", "collections:depositCheque", { orgId, chequeId });
      // OWNER, not the MANAGER. `clearCheque` requires manage:finance and the
      // seated MANAGER does not hold it, so the cloud run refused with
      // "Forbidden: Missing required permissions: manage:finance".
      //
      // Worth being precise about why this is not the deposits.release
      // situation: there the product REFUSES the deposit's creator on purpose,
      // so using two people is the behaviour under test. Here it is an ordinary
      // permission, and routing the call through an identity that legitimately
      // holds it is fixture correctness, not a weakened guard.
      await ownerMust("mutation", "collections:clearCheque", {
        orgId,
        chequeId,
        idempotencyKey: `rehearsal-rv1-clear-${stamp}`,
      });

      // THE CLEARING, ON THE BOOKS. The cleared cheque is a collection payment
      // (found by its chequeId, not by position in a list), whose ONE receipt
      // occurrence posts bank against the receivable — 1,200, in the org's
      // denomination, nothing else. The receivable itself reads PAID at zero.
      const denom = await orgDenomination({ orgId, ownerMust });
      const scale = denom.minorPerMajor;
      const { keyOf } = await chartIndex({ orgId, ownerMust });
      const payments = await listCollectionPayments({ orgId, ownerMust });
      const chequePayments = payments.filter((p) => String(p.chequeId ?? "") === String(chequeId));
      expectEqual(chequePayments.length, 1, "collection payment rows for this cheque after clearing");
      const paymentId = chequePayments[0]._id;
      const cleared = await eventAndJournal({
        orgId, ownerMust, sourceType: "collectionPayments", sourceId: paymentId, eventType: "COLLECTION_PAYMENT",
      });
      const clearingLines = [
        { key: "BANK_ACCOUNT", debitMinor: 1200 * scale },
        { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", creditMinor: 1200 * scale },
      ];
      expectExactLines(cleared.lines, keyOf, clearingLines, {
        currency: denom.currency, decimals: denom.decimals, what: "the cheque clearing", customerId,
      });
      const settled = await findReceivable({ orgId, ownerMust, receivableId });
      expectEqual(settled.outstandingAmount, 0, "outstanding on the receivable after the cheque cleared");
      expectEqual(settled.status, "PAID", "receivable status after the cheque cleared");
      const clearingLineShape = cleared.lines
        .map((l) => `${keyOf.get(String(l.accountId))}|${l.debitMinor}|${l.creditMinor}`)
        .sort();

      const returned = await ownerCall("mutation", "collections:returnClearedCheque", {
        orgId,
        chequeId,
        returnReason: "Rehearsal bounce",
        idempotencyKey: `rehearsal-rv1-return-${stamp}`,
      });
      if (!returned.ok) {
        fail(`returning the cleared cheque was refused: ${returned.error.slice(0, 200)}`);
      }

      // SYMMETRY, BY IDENTITY. The clearing's event is now REVERSED and names
      // the event that reversed it; the clearing's journal entry is still there,
      // still POSTED-then-REVERSED with its lines intact, and names the entry
      // that reversed it; that entry is a REVERSAL whose lines are the exact
      // opposite of the clearing's — same accounts, same amounts, sides swapped.
      // Org-wide counts cannot say any of this: a different balanced entry
      // anywhere in the ledger would have satisfied "one more entry".
      const reversedEvent = await eventAndJournal({
        orgId, ownerMust, sourceType: "collectionPayments", sourceId: paymentId, eventType: "COLLECTION_PAYMENT",
        expectStatus: "REVERSED",
      });
      if (!reversedEvent.event.reversedByEventId) fail("the clearing's event is REVERSED but names no reversing event");
      expectEqual(String(reversedEvent.entry._id), String(cleared.entry._id), "the clearing's journal entry is the same entry after the return");
      expectEqual(reversedEvent.entry.status, "REVERSED", "the clearing entry's status after the return");
      const originalAfter = reversedEvent.lines
        .map((l) => `${keyOf.get(String(l.accountId))}|${l.debitMinor}|${l.creditMinor}`)
        .sort();
      if (JSON.stringify(originalAfter) !== JSON.stringify(clearingLineShape)) {
        fail("the clearing entry's lines CHANGED across the return — history was edited, not reversed");
      }
      const reversalEntryId = reversedEvent.entry.reversedByJournalEntryId;
      if (!reversalEntryId) fail("the clearing entry is REVERSED but names no reversing journal entry");
      const reversal = await ownerMust("query", "accountingLedger:getJournalEntry", { orgId, journalEntryId: reversalEntryId });
      if (!reversal?.entry) fail("the reversing journal entry could not be read back");
      expectEqual(reversal.entry.category, "REVERSAL", "the reversing entry's category");
      expectEqual(reversal.entry.status, "POSTED", "the reversing entry's status");
      expectEqual(String(reversal.entry.reversalOfJournalEntryId), String(cleared.entry._id), "the reversing entry names the clearing it reverses");
      expectEqual(String(reversal.entry.accountingEventId), String(reversedEvent.event.reversedByEventId), "the reversing entry belongs to the reversing event");
      expectExactLines(
        reversal.lines ?? [], keyOf,
        [
          { key: "ACCOUNTS_RECEIVABLE_CUSTOMERS", debitMinor: 1200 * scale },
          { key: "BANK_ACCOUNT", creditMinor: 1200 * scale },
        ],
        { currency: denom.currency, decimals: denom.decimals, what: "the cheque-return reversal", customerId }
      );

      // THE DEBT IS OWED AGAIN — exactly, not approximately.
      const reopened = await findReceivable({ orgId, ownerMust, receivableId });
      expectEqual(reopened.outstandingAmount, 1200, "outstanding on the receivable after the cheque bounced");
      if (reopened.status === "PAID") fail("the receivable still reads PAID after its cheque bounced");

      const chequePage = await ownerMust("query", "collections:listCheques", {
        orgId,
        paginationOpts: { numItems: 100, cursor: null },
      });
      const mine = (chequePage?.page ?? []).find((c) => String(c._id) === String(chequeId));
      if (!mine) fail("the cheque is no longer listed after its return — the history was destroyed, not reversed");
      expectEqual(mine.status, "RETURNED", "cheque status after the return");

      const failedOutbox = await ownerMust("query", "accountingOutbox:listPending", {
        orgId,
        status: "FAILED",
        limit: 200,
      });
      if ((failedOutbox ?? []).length > 0) {
        fail(`the reversal left ${failedOutbox.length} FAILED accounting event(s) behind`);
      }

      return {
        chequeId: String(chequeId),
        paymentId: String(paymentId),
        currency: denom.currency,
        chequeStatusAfterReturn: mine.status ?? null,
        clearing: { entryId: String(cleared.entry._id), statusAfterReturn: reversedEvent.entry.status, linesIntact: true },
        reversal: {
          entryId: String(reversalEntryId),
          category: reversal.entry.category,
          reversalOf: String(reversal.entry.reversalOfJournalEntryId),
          lines: (reversal.lines ?? []).map((l) => ({
            account: keyOf.get(String(l.accountId)) ?? "?",
            debitMinor: l.debitMinor,
            creditMinor: l.creditMinor,
          })),
        },
        receivable: { outstandingAfterClear: settled.outstandingAmount, outstandingAfterReturn: reopened.outstandingAmount, statusAfterReturn: reopened.status },
        commandsExercised: ["collections.clearCheque", "collections.returnClearedCheque"],
      };
    }
  );

  // ── SR1 — a SOURCED car is sold as the supplier's AGENT, never as stock ────
  //
  // ACC-1: the dealership never owns a consigned vehicle, so its economics are
  // agent-sale economics. The only revenue is the spread over the supplier's
  // entitlement; the sale price is never revenue, the supplier's cost is never
  // COGS, and nothing ever sat in inventory to be relieved. Posting it as an
  // owned sale reaches the same bottom line — which is exactly why it goes
  // unnoticed — while overstating revenue by the entire price of the car.
  //
  // The assertion reads the journal the sale ACTUALLY posted and checks every
  // line against the chart by system key: commission revenue for the margin,
  // AP-Suppliers for the entitlement, and NO line on sales revenue, COGS or
  // vehicle inventory. A rule that had quietly fallen through to the owned
  // branch would fail all three.
  await recordCase(
    results,
    "SR1",
    "a consigned sale posts commission on the spread and touches neither sales revenue, COGS nor inventory",
    async () => {
      const stamp = Date.now().toString(36);
      const vin = `RHSSR1${stamp.replace(/[ioq]/g, "z").toUpperCase()}`.padEnd(17, "0").slice(0, 17);
      const vehicleId = await ownerMust("mutation", "vehicles:create", {
        orgId,
        vin,
        make: "Toyota",
        model: "Camry-sr1",
        year: 2022,
        mileage: 800,
        color: "Blue",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 22000,
        sourceType: "SOURCED",
        sourcedFromName: `Rehearsal Supplier ${stamp}`,
        status: "AVAILABLE",
        // The supplier's ENTITLEMENT — what he is owed for the car. It is
        // `sourceCost`, not `purchasePrice`, and the product refuses the wrong
        // field by name: these were never the dealership's goods, so there is
        // no purchase, and the two numbers are kept apart on purpose.
        sourceCost: 15000,
        idempotencyKey: `rehearsal-sr1-vehicle-${stamp}`,
      });
      const customerId = await ownerMust("mutation", "customers:create", {
        orgId,
        firstName: "Rehearsal",
        lastName: `sr1-${stamp}`,
      });
      const me = await ownerMust("query", "users:getMe", {});
      if (!me?._id) fail("users:getMe returned no user for the OWNER token — the sale has no salesperson to name");

      const entriesBefore = await ownerMust("query", "accountingLedger:listJournalEntries", { orgId, limit: 200 });
      const saleId = await ownerMust("mutation", "sales:create", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: me._id,
        salePrice: 22000,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "CASH",
        idempotencyKey: `rehearsal-sr1-sale-${stamp}`,
      });

      // The journal this sale posted, found through its accounting event
      // rather than by assuming it is the newest entry.
      const events = await ownerMust("query", "accountingLedger:listAccountingEvents", {
        orgId,
        sourceType: "sales",
        sourceId: String(saleId),
        limit: 50,
      });
      const completed = (events ?? []).filter((e) => e.eventType === "SALE_COMPLETED");
      expectEqual(completed.length, 1, "SALE_COMPLETED accounting events for this sale");

      const entriesAfter = await ownerMust("query", "accountingLedger:listJournalEntries", { orgId, limit: 200 });
      const newEntries = (entriesAfter ?? []).filter(
        (e) => !(entriesBefore ?? []).some((b) => String(b._id) === String(e._id))
      );
      if (newEntries.length === 0) {
        fail("the consigned sale posted NO journal entry — the supplier is owed money the books do not record");
      }

      // Resolve every line to its system key through the chart.
      const chart = await ownerMust("query", "chartOfAccounts:list", { orgId });
      const keyOf = new Map((chart ?? []).map((a) => [String(a._id), a.systemKey ?? a.code ?? "?"]));
      const totals = {};
      let linesRead = 0;
      for (const entry of newEntries) {
        const detail = await ownerMust("query", "accountingLedger:getJournalEntry", {
          orgId,
          journalEntryId: entry._id,
        });
        for (const l of detail?.lines ?? []) {
          linesRead += 1;
          const key = keyOf.get(String(l.accountId)) ?? "?";
          const t = totals[key] ?? { debit: 0, credit: 0 };
          t.debit += l.debitMinor ?? 0;
          t.credit += l.creditMinor ?? 0;
          totals[key] = t;
        }
      }

      const commission = totals.CONSIGNMENT_COMMISSION_REVENUE ?? { debit: 0, credit: 0 };
      const supplier = totals.ACCOUNTS_PAYABLE_SUPPLIERS ?? { debit: 0, credit: 0 };
      if (commission.credit <= 0) {
        fail(`no commission revenue was credited for a consigned sale: ${JSON.stringify(totals).slice(0, 400)}`);
      }
      // Scale derived from the commission the product posted, sanity-checked
      // the same way RC1 does it, so the assertion is about the RATIO of
      // margin to entitlement and not about the dealership's decimal places.
      const scale = commission.credit / 7000;
      if (![1, 10, 100, 1000].includes(scale)) {
        fail(
          `commission credited (${commission.credit} minor) is not the 7,000 spread at any sane scale — ` +
            `the margin was measured wrongly, not merely in different units`
        );
      }
      expectEqual(commission.credit, 7000 * scale, `commission revenue = sale price − entitlement (scale ${scale})`);
      expectEqual(supplier.credit, 15000 * scale, `AP-Suppliers credited for the supplier's entitlement (scale ${scale})`);

      // The three lines that would mean the car was posted as the dealership's.
      for (const forbidden of ["SALES_REVENUE", "COST_OF_VEHICLES_SOLD", "VEHICLE_INVENTORY"]) {
        const t = totals[forbidden];
        if (t && (t.debit !== 0 || t.credit !== 0)) {
          fail(
            `${forbidden} was touched (${JSON.stringify(t)}) on a CONSIGNED sale — the car was posted as ` +
              `dealership stock, overstating revenue by the price of the vehicle`
          );
        }
      }

      return {
        saleId: String(saleId),
        vehicleId: String(vehicleId),
        minorUnitScale: scale,
        journalEntriesPosted: newEntries.length,
        journalLinesRead: linesRead,
        commissionRevenueMinor: commission.credit,
        supplierPayableMinor: supplier.credit,
        forbiddenAccountsTouched: [],
        commandsExercised: ["vehicles.create (SOURCED)", "sales.create"],
      };
    }
  );

  // ── P1 — a CLOSED period holds the posting; it does not half-post it ───────
  //
  // RUNS LAST, AND THAT IS STRUCTURAL. Closing the organization's only open
  // period changes the world for every case after it: postings would be held
  // for a reason those cases do not know about, and they would go red while the
  // product behaved correctly. A case whose side effects invalidate its
  // neighbours has to be the last thing that happens.
  //
  // The property under test is the one the posting engine documents: no open
  // period is a TEMPORARY HOLD. The money decision is recorded, the event waits
  // in the outbox, and the general ledger is not touched — not touched
  // *partially* least of all, which is the outcome that would leave a
  // dealership's accounts internally inconsistent with no error anywhere.
  await recordCase(
    results,
    "P1",
    "with no OPEN period the posting is HELD in the outbox and the GL is not partially written",
    async () => {
      const periods = await ownerMust("query", "accountingPeriods:list", { orgId });
      const open = (periods ?? []).filter((p) => p.status === "OPEN");
      if (open.length === 0) {
        unproven("no OPEN period existed to close, so the closed-period behaviour was never exercised");
      }

      // The fixture is built while the period is still OPEN, on purpose: taking
      // a deposit and allocating it are ordinary trading and they post normally.
      const fx = await makePartiallyCommittedDeposit({ orgId, ownerMust, label: "p1" });

      // Close through the real mutation. If the product refuses — a close
      // checklist that is not clean is a legitimate refusal, not a defect —
      // this case reports UNPROVEN rather than inventing a way through. Forcing
      // the period shut by another route would be exactly the "manual state
      // forcing that bypasses the behaviour under test" the floor prohibits.
      const closed = await ownerCall("mutation", "accountingPeriods:close", {
        orgId,
        periodId: open[0]._id,
      });
      if (!closed.ok) {
        unproven(`the period could not be closed through the supported mutation: ${closed.error.slice(0, 200)}`);
      }

      // ⚠️ THE BASELINE IS TAKEN HERE, AFTER THE CLOSE — and the first cloud run
      // of this case failed because it was taken before the fixture instead.
      // Creating the deposit and allocating it posted three journal entries
      // while the period was still open, and those landed inside the measured
      // window, so the case reported "3 journals written while no period is
      // OPEN" about entries the product was entirely right to write.
      //
      // That is a false accusation of a financial defect, which is worse than a
      // missed one: it burns a real investigation and, repeated, it teaches
      // everyone to discount the case. The window has to contain the release
      // and nothing else.
      const beforeEntries = await ownerMust("query", "accountingLedger:listJournalEntries", { orgId, limit: 200 });

      const release = await resolverCall("mutation", "deposits:release", {
        orgId,
        depositId: fx.depositId,
        resolution: "REFUNDED",
        refundMethod: "CASH",
        idempotencyKey: `release-deposit:${fx.depositId}:REFUNDED:CASH:gen0`,
      });

      const afterEntries = await ownerMust("query", "accountingLedger:listJournalEntries", { orgId, limit: 200 });
      const pending = await ownerMust("query", "accountingOutbox:listPending", {
        orgId,
        status: "PENDING",
        limit: 200,
      });
      const failed = await ownerMust("query", "accountingOutbox:listPending", {
        orgId,
        status: "FAILED",
        limit: 200,
      });

      // Whichever disposition the product chose — refuse the command outright,
      // or accept it and hold the posting — the GL must be untouched. A NEW
      // journal entry written while no period is open is the partial-post
      // outcome this case exists to rule out.
      expectEqual(
        (afterEntries ?? []).length,
        (beforeEntries ?? []).length,
        "journal entries written while no accounting period is OPEN"
      );
      if ((failed ?? []).length > 0) {
        fail(
          `a posting DEAD-LETTERED rather than being held while the period was closed: ` +
            `${JSON.stringify(failed.slice(0, 2)).slice(0, 300)}`
        );
      }
      if (release.ok && (pending ?? []).length === 0) {
        fail(
          "the release was accepted, no journal was written, and nothing is waiting in the outbox — " +
            "the money decision exists on the deposit row with no path to the books at all"
        );
      }

      const row = await readDeposit({ orgId, vehicleId: fx.vehicleA, depositId: fx.depositId, ownerMust });
      return {
        closedPeriodId: String(open[0]._id),
        releaseAccepted: release.ok,
        releaseRefusal: release.ok ? null : release.error.slice(0, 200),
        journalEntriesBefore: (beforeEntries ?? []).length,
        journalEntriesAfter: (afterEntries ?? []).length,
        pendingOutboxEvents: (pending ?? []).length,
        failedOutboxEvents: (failed ?? []).length,
        depositRow: { released: row.releasedAmountMinor ?? 0, releaseCount: row.releaseCount ?? 0 },
      };
    }
  );
}

/**
 * Every remaining retained position for a customer, paged to exhaustion.
 *
 * `collections:listRetainedCredits` documents that `onlyRemaining` filters the
 * PAGE rather than the query, so `page.length < numItems` -- including zero --
 * is not the end of the results. Stopping at the first page would let this
 * rehearsal report a customer's money as missing because it sat on page two.
 */
async function readRetainedCredits({ orgId, customerId, ownerMust }) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await ownerMust("query", "collections:listRetainedCredits", {
      orgId,
      customerId,
      onlyRemaining: true,
      paginationOpts: { numItems: 50, cursor },
    });
    rows.push(...(result?.page ?? []));
    if (result?.isDone || !result?.continueCursor) break;
    cursor = result.continueCursor;
  }
  return rows;
}

/**
 * Proves that BOTH concurrent attempts actually reached the backend, in flight
 * together — before the final state is allowed to mean anything.
 *
 * Codex RG-01, reproduced: C1 and C2 recorded their `attempts` in the evidence
 * and asserted only the deposit's final state. One worker succeeding and one
 * crashing before it ever sent a request produces EXACTLY the expected result
 * — 2,000,000 released, releaseCount 1 — so a rehearsal that ran one request
 * would have certified concurrency it never measured. The certified run's own
 * artifact happened to show both workers healthy; the case could not have
 * told the difference.
 *
 * What is required, and why each part:
 *   - exactly the labelled attempts expected, each with exit code 0 and a
 *     parsed body: a worker that crashed or printed garbage is a TRANSPORT
 *     failure, and transport failure is UNPROVEN, never PASS and never FAIL —
 *     nothing about the product was measured;
 *   - HTTP 200 and a status of `success`, or an `error` whose message the
 *     CASE recognises as a product refusal: the product refusing the loser
 *     ("nothing left of this deposit") is a valid outcome of the race. Codex
 *     RG-01-R1, reproduced against the first fix: it accepted ANY error with
 *     a message, so a 503 with a non-JSON body, an auth refusal or an
 *     argument-validation error each certified an attempt that never reached
 *     `deposits.release` — the same false pass one layer down. An error the
 *     case does not recognise is UNPROVEN: nothing about the race was seen;
 *   - finite send/receive timestamps whose intervals OVERLAP: two requests
 *     that ran one after the other measure nothing about concurrency, however
 *     healthy each was. Overlap of client intervals is what this harness can
 *     honestly claim; it is not proof of overlap inside Convex transactions,
 *     and the evidence says so.
 */
export function assertBothAttemptsExecuted(attempts, expectedLabels, { productRefusals }) {
  const outcomes = {};
  const byLabel = new Map((attempts ?? []).map((a) => [a.label, a]));
  const transportFailures = [];
  for (const label of expectedLabels) {
    const a = byLabel.get(label);
    if (!a) {
      transportFailures.push(`${label}: no outcome recorded`);
      continue;
    }
    const r = a.result;
    if (a.exitCode !== 0 || !r || typeof r !== "object") {
      transportFailures.push(`${label}: exit ${a.exitCode}, ${r ? "unparseable result" : "no result"}`);
      continue;
    }
    if (r.status === "worker_error" || (r.status !== "success" && r.status !== "error")) {
      transportFailures.push(`${label}: worker status ${String(r.status)} — ${String(r.error ?? "").slice(0, 120)}`);
      continue;
    }
    if (r.httpStatus !== 200) {
      // Convex answers a handler's own refusal with 200 and status "error";
      // anything else never reached the handler — gateway, auth layer, a body
      // that was not JSON.
      transportFailures.push(`${label}: HTTP ${String(r.httpStatus)} — ${String(r.error ?? "").slice(0, 120)}`);
      continue;
    }
    if (r.status === "error") {
      const message = String(r.error ?? "");
      if (!productRefusals.some((re) => re.test(message))) {
        transportFailures.push(`${label}: error not recognised as a product refusal of this race — ${message.slice(0, 160)}`);
        continue;
      }
      outcomes[label] = "refused";
    } else {
      outcomes[label] = "success";
    }
    if (!Number.isFinite(r.sentAt) || !Number.isFinite(r.receivedAt) || r.receivedAt < r.sentAt) {
      transportFailures.push(`${label}: timestamps not finite/ordered (${r.sentAt} → ${r.receivedAt})`);
    }
  }
  if (transportFailures.length > 0) {
    unproven(
      `concurrency was NOT measured — ${transportFailures.join("; ")}. A worker that never reached the backend ` +
        `says nothing about the product; this is a harness failure, not a product result.`
    );
  }
  const [x, y] = expectedLabels.map((l) => byLabel.get(l).result);
  const overlap = x.sentAt <= y.receivedAt && y.sentAt <= x.receivedAt;
  if (!overlap) {
    unproven(
      `the two attempts did NOT overlap in flight (${x.sentAt}→${x.receivedAt} vs ${y.sentAt}→${y.receivedAt}); ` +
        `sequential requests measure nothing about concurrency`
    );
  }
  return {
    bothExecuted: true,
    intervalsOverlap: true,
    outcomes,
    overlapNote: "client send/receive intervals overlap; not proof of overlap inside Convex transactions",
  };
}

/**
 * The one refusal a healthy `deposits.release` race can produce: the loser
 * finds nothing free. Pinned by the same pattern the product's own tests use
 * (`convex/multiVehicleDepositAllocation.test.ts`); the product throws a plain
 * ConvexError string here, so there is no code to pin instead.
 */
const NOTHING_LEFT_REFUSAL = /nothing left of this deposit/i;

/** Keeps the validator's own shape out of the evidence without hiding its verdict. */
function summarizeValidation(report) {
  if (!report || typeof report !== "object") return null;
  return {
    missing: report.missing ?? [],
    ...(typeof report.valid === "boolean" ? { valid: report.valid } : {}),
  };
}

/**
 * Every collection payment for the org, through the paginated public query.
 *
 * Paginated on purpose rather than with a large page size: the page cap is the
 * product's, and a rehearsal that assumed one page would silently stop
 * reconciling as soon as the fixture count grew past it.
 */
async function listCollectionPayments({ orgId, ownerMust }) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await ownerMust("query", "collections:listPayments", {
      orgId,
      paginationOpts: { numItems: 100, cursor },
    });
    rows.push(...(result?.page ?? []));
    if (result?.isDone || !result?.continueCursor) break;
    cursor = result.continueCursor;
  }
  return rows;
}

/* ────────────────────────────────────────────────────────────────────────────
 * LEDGER RECONCILIATION HELPERS — the owner-proxy's evidence-floor closure
 * (2026-09-11 09:51). Every one of these reads the product the way its
 * consumer would, binds a money claim to the JOURNAL LINES that carry it, and
 * takes its expectations from somewhere other than the figure being judged.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The product's supported denominations, MIRRORED from `convex/utils/money.ts`
 * (`CURRENCY_SCALES`). The rehearsal cannot import that TypeScript module from
 * plain Node on the CI runner, so it carries a copy — and
 * `accountingRehearsalCases.test.ts` reads the product source and fails if the
 * two ever disagree, so this is a pinned mirror rather than a second opinion.
 *
 * Why it exists at all: RC1 used to derive the minor-unit scale from the amount
 * it was about to judge (`scale = remaining / 500`, then `remaining == 500 *
 * scale`), which is circular — the owner-proxy read it and said so. The
 * denomination now comes from the organization's own currency and this table,
 * and the amount under test has no say in it.
 */
export const CURRENCY_SCALES = {
  JOD: 3,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  EGP: 2,
  JPY: 0,
};

/**
 * The product's own default when an organization has never set a currency —
 * `getOrgCurrency` in `convex/accounting/workflowHooks.ts` returns
 * `settings?.currency ?? "JOD"`. Mirrored and pinned by the same test as the
 * scale table. The first cloud run of this closure failed all four money cases
 * on "the organization carries no currency": the runner read the
 * `organizations` row, which has no such field, while the product resolves
 * the denomination from `orgSettings` with this default. The org/currency
 * contract is the product's resolver, not a field I assumed.
 */
export const DEFAULT_ORG_CURRENCY = "JOD";

/** The organization's denomination, resolved the way the product resolves it. */
async function orgDenomination({ orgId, ownerMust }) {
  const settings = await ownerMust("query", "orgSettings:get", { orgId });
  const explicit = typeof settings?.currency === "string" && settings.currency.length > 0 ? settings.currency : null;
  const currency = explicit ?? DEFAULT_ORG_CURRENCY;
  const decimals = CURRENCY_SCALES[currency];
  if (decimals === undefined) {
    unproven(
      `the organization's currency ${currency} is not in the rehearsal's mirror of the product's supported ` +
        `denominations, so expected minor amounts cannot be derived independently`
    );
  }
  return { currency, decimals, minorPerMajor: 10 ** decimals, source: explicit ? "orgSettings.currency" : "product default" };
}

/** account id → system key, and system key → account id, from the org's real chart. */
async function chartIndex({ orgId, ownerMust }) {
  const chart = await ownerMust("query", "chartOfAccounts:list", { orgId });
  const keyOf = new Map();
  const accountOf = new Map();
  for (const a of chart ?? []) {
    keyOf.set(String(a._id), a.systemKey ?? a.code ?? "?");
    if (a.systemKey && !accountOf.has(a.systemKey)) accountOf.set(a.systemKey, a._id);
  }
  return { keyOf, accountOf };
}

/**
 * The ONE accounting event for a source and type, and the journal entry it
 * points at. "One economic occurrence" is asserted here, on the event, because
 * a duplicate event is the shape every row-level check is blind to.
 */
async function eventAndJournal({ orgId, ownerMust, sourceType, sourceId, eventType, expectStatus = "POSTED", pick }) {
  // `pick` selects by payload when the source id is a composed string the
  // product formats internally (a receipt application); otherwise the event is
  // addressed by its source, the way the ledger indexes it.
  const events = await ownerMust(
    "query",
    "accountingLedger:listAccountingEvents",
    pick ? { orgId, limit: 200 } : { orgId, sourceType, sourceId: String(sourceId), limit: 200 }
  );
  const matching = (events ?? []).filter((e) => e.eventType === eventType && (!pick || pick(e)));
  expectEqual(matching.length, 1, `${eventType} events for ${sourceType} ${sourceId} (one economic occurrence)`);
  const event = matching[0];
  if (pick) sourceId = event.sourceId;
  expectEqual(event.status, expectStatus, `status of the ${eventType} event for ${sourceType} ${sourceId}`);
  if (!event.journalEntryId) {
    fail(`the ${eventType} event for ${sourceType} ${sourceId} points at NO journal entry — the books were not reached`);
  }
  const detail = await ownerMust("query", "accountingLedger:getJournalEntry", {
    orgId,
    journalEntryId: event.journalEntryId,
  });
  if (!detail?.entry) fail(`journal entry ${event.journalEntryId} for ${eventType} could not be read back`);
  // The binding runs BOTH ways: the entry must name the same source the event
  // does, and the same event. An entry found through an id is not evidence
  // until it says, itself, what it is for.
  expectEqual(String(detail.entry.accountingEventId), String(event._id), "the journal entry's accountingEventId");
  expectEqual(detail.entry.sourceType, sourceType, "the journal entry's sourceType");
  expectEqual(String(detail.entry.sourceId), String(sourceId), "the journal entry's sourceId");
  return { event, entry: detail.entry, lines: detail.lines ?? [] };
}

/**
 * Exact lines: the multiset of (system key, debit, credit) must equal the
 * expectation — no missing line, no extra line, no amount off by a minor unit
 * — and every line must be denominated in the organization's currency at its
 * scale. A balanced entry on the wrong accounts, or the right accounts in the
 * wrong denomination, fails here; per-entry balance (B2) cannot see either.
 */
function expectExactLines(lines, keyOf, expected, { currency, decimals, what, customerId }) {
  const shape = (key, debit, credit) => `${key} Dr ${debit} Cr ${credit}`;
  const actual = lines.map((l) => shape(keyOf.get(String(l.accountId)) ?? "?", l.debitMinor ?? 0, l.creditMinor ?? 0)).sort();
  const wanted = expected.map((e) => shape(e.key, e.debitMinor ?? 0, e.creditMinor ?? 0)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${what}: journal lines are not exactly the expected posting.\n  expected ${JSON.stringify(wanted)}\n  actual   ${JSON.stringify(actual)}`);
  }
  for (const l of lines) {
    expectEqual(l.currency, currency, `${what}: currency on a journal line`);
    expectEqual(l.scale, decimals, `${what}: minor-unit scale on a journal line`);
    if (customerId !== undefined) {
      expectEqual(String(l.customerId), String(customerId), `${what}: customer dimension on a journal line`);
    }
  }
}

/** A customer's net position on one control account, from the GL itself. */
async function customerNetOnAccount({ orgId, ownerMust, accountId, customerId }) {
  const activity = await ownerMust("query", "accountingLedger:getAccountActivity", {
    orgId,
    accountId,
    limit: 500,
  });
  if (!activity?.account) fail(`account ${accountId} could not be read back for its activity`);
  const mine = (activity.lines ?? []).filter((l) => String(l.customerId) === String(customerId));
  const debit = mine.reduce((s, l) => s + (l.debitMinor ?? 0), 0);
  const credit = mine.reduce((s, l) => s + (l.creditMinor ?? 0), 0);
  return { debit, credit, lines: mine.length, normalBalance: activity.account.normalBalance };
}

/** Pages the receivable list to find ONE receivable by id. */
async function findReceivable({ orgId, ownerMust, receivableId }) {
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const result = await ownerMust("query", "collections:listReceivables", {
      orgId,
      paginationOpts: { numItems: 100, cursor },
    });
    const hit = (result?.page ?? []).find((r) => String(r._id) === String(receivableId));
    if (hit) return hit;
    if (result?.isDone || !result?.continueCursor) break;
    cursor = result.continueCursor;
  }
  fail(`receivable ${receivableId} is not listed at all`);
}

/** A fresh STOCK vehicle for cases that need a car nobody else is committed to. */
async function makeVehicle({ orgId, ownerMust, label }) {
  const stamp = Date.now().toString(36);
  const vin = `RHS${label}${stamp}`.replace(/[ioq]/gi, "z").toUpperCase().padEnd(17, "0").slice(0, 17);
  return ownerMust("mutation", "vehicles:create", {
    orgId,
    vin,
    make: "Toyota",
    model: `Camry-${label}`,
    year: 2022,
    mileage: 800,
    color: "Blue",
    fuelType: "Gasoline",
    transmission: "Automatic",
    sellingPrice: 22000,
    sourceType: "STOCK",
    status: "AVAILABLE",
    purchasePrice: 15000,
    purchasePaymentMethod: "CASH",
    idempotencyKey: `rehearsal-${label}-vehicle-${stamp}-${uuid()}`,
  });
}

/**
 * The retry contract, asserted the same way for every command: the replay is
 * ACCEPTED (a refused retry leaves the operator retrying with fresh content)
 * and returns the ORIGINAL identity (a fresh one is the double-spend).
 */
async function replayMustReturnSame({ call, must, fnPath, args, what }) {
  const first = await must("mutation", fnPath, args);
  const replay = await call("mutation", fnPath, args);
  if (!replay.ok) {
    fail(`replaying ${what} with the SAME identity was refused (${String(replay.error).slice(0, 200)}) — a refused retry is not a safe retry`);
  }
  const norm = (v) => JSON.stringify(Array.isArray(v) ? v.map(String).sort() : String(v));
  if (norm(replay.value) !== norm(first)) {
    fail(`replaying ${what} returned a DIFFERENT identity (${norm(replay.value)} vs ${norm(first)}) — the retry acted twice`);
  }
  return first;
}
