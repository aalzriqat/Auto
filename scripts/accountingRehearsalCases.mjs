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
  const { results, orgId, recordCase, fireConcurrentReleases, tokens, config, unproven } = ctx;

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
          "36 of the 38 IDENTITY_GUARDED commands have no cloud retry proof; see the rehearsal's evidence inventory",
      };
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
      await ownerMust("mutation", "collections:recordPayment", {
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
      await ownerMust("mutation", "collections:recordPayment", {
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
      expectEqual(remainingMinor, 50_000, "retained credit remaining after a 500 receipt on account");

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
      expectEqual(afterRemaining, 10_000, "retained credit remaining after applying 400 of the 500");

      return {
        customerId: String(customerId),
        retainedAfterReceiptOnAccount: remainingMinor,
        retainedAfterApplying400: afterRemaining,
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
    "returning a CLEARED cheque puts the receivable back and reverses rather than erases",
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

      const entriesAfterClear = await ownerMust("query", "accountingLedger:listJournalEntries", {
        orgId,
        limit: 200,
      });

      const returned = await ownerCall("mutation", "collections:returnClearedCheque", {
        orgId,
        chequeId,
        returnReason: "Rehearsal bounce",
        idempotencyKey: `rehearsal-rv1-return-${stamp}`,
      });
      if (!returned.ok) {
        fail(`returning the cleared cheque was refused: ${returned.error.slice(0, 200)}`);
      }

      const entriesAfterReturn = await ownerMust("query", "accountingLedger:listJournalEntries", {
        orgId,
        limit: 200,
      });
      // A reversal ADDS. If the count fell, the original posting was removed
      // rather than reversed, and the books no longer say the cheque ever
      // cleared — an additions-only check would have called that "no GL effect".
      if ((entriesAfterReturn ?? []).length < (entriesAfterClear ?? []).length) {
        fail(
          `journal entries went DOWN across the return (${entriesAfterClear.length} → ${entriesAfterReturn.length}) — ` +
            `the clearing was erased instead of reversed`
        );
      }
      if ((entriesAfterReturn ?? []).length === (entriesAfterClear ?? []).length) {
        fail(
          "the return produced NO journal entry at all — the cheque bounced and the books still say the money arrived"
        );
      }

      const chequePage = await ownerMust("query", "collections:listCheques", {
        orgId,
        paginationOpts: { numItems: 100, cursor: null },
      });
      const mine = (chequePage?.page ?? []).find((c) => String(c._id) === String(chequeId));
      if (!mine) fail("the cheque is no longer listed after its return — the history was destroyed, not reversed");

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
        chequeStatusAfterReturn: mine.status ?? null,
        journalEntriesAfterClear: entriesAfterClear.length,
        journalEntriesAfterReturn: entriesAfterReturn.length,
        reversalAddedEntries: entriesAfterReturn.length - entriesAfterClear.length,
        commandsExercised: ["collections.clearCheque", "collections.returnClearedCheque"],
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
