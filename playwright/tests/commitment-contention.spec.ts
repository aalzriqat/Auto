import { test, expect } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { authenticatedConvexClient, resolveOrgId, testDataSuffix } from "../utils";

/**
 * SCRUM-195 — the commitment authority under REAL concurrency.
 *
 * ## Why this cannot be a `convex-test`
 *
 * Every other contract in this work runs against `convex-test`, and for the
 * rules that is exactly right. But `convex-test` serialises: two mutations
 * never overlap, so acquire-versus-acquire, release-versus-acquire and
 * reopen-versus-competing-acquire all pass there without the compare-and-swap
 * ever being exercised. A suite that green-lights those locally is not evidence
 * about the runtime — it is evidence that the harness cannot express the
 * question.
 *
 * The question is whether TWO REAL REQUESTS, in flight at the same moment
 * against a real Convex backend, can both take the same car.
 *
 * ## Why this drives mutations rather than the DOM
 *
 * The rest of the E2E suite clicks through screens, and that is the right
 * instrument for "can an operator reach this". It is the wrong instrument here:
 * two browsers pressing two buttons cannot be made simultaneous to the
 * precision a CAS window needs, and the thing under test is the window.
 *
 * So this signs in as a real user through Clerk, takes that session's own
 * token, and calls the SAME PUBLIC MUTATIONS the screens call — concurrently.
 * Nothing here reaches past the product's public surface:
 *
 *   - no `ctx.db`, no raw row writes;
 *   - no test-only mutation, and none exists to call;
 *   - no seeding backdoor — every fixture below is created by the same
 *     `api.*` mutation an operator's own session invokes.
 *
 * The only test-shaped surface involved is `deploymentIdentity.identity`, which
 * is read-only, takes no arguments, and returns no secrets.
 *
 * ## Why it refuses to run against most deployments
 *
 * These tests deliberately try to double-book inventory. Pointed at production
 * that is not a test, it is an incident. The backend therefore has to declare
 * itself disposable before a single race is fired, and the declaration is
 * fail-closed: production does not set that variable, and a preview whose
 * variables did not take reads as "not disposable" and refuses. The failure
 * direction is refusal, never a race against real stock.
 */

test.describe.configure({ timeout: 600_000 });
test.use({ actionTimeout: 25_000 });

const RACERS = 4;

type Ctx = {
  client: ConvexHttpClient;
  orgId: Id<"organizations">;
};

/** Every fixture below goes through a public product mutation. No seeding. */
async function makeVehicle(ctx: Ctx, label: string): Promise<Id<"vehicles">> {
  const suffix = testDataSuffix();
  return (await ctx.client.mutation(api.vehicles.create, {
    orgId: ctx.orgId,
    vin: `RACE${label}${suffix}`.slice(0, 17).toUpperCase(),
    make: "Toyota",
    model: `E2E-RACE-${label}`,
    year: 2024,
    mileage: 12,
    color: "White",
    fuelType: "Gasoline",
    transmission: "Automatic",
    sellingPrice: 28_000,
    status: "AVAILABLE",
  })) as Id<"vehicles">;
}

async function makeCustomer(ctx: Ctx, label: string): Promise<Id<"customers">> {
  return (await ctx.client.mutation(api.customers.create, {
    orgId: ctx.orgId,
    firstName: "Race",
    lastName: `${label}-${testDataSuffix()}`,
  })) as Id<"customers">;
}

async function makeCashQuote(
  ctx: Ctx,
  customerId: Id<"customers">,
  vehicleId: Id<"vehicles">
): Promise<Id<"quotes">> {
  return (await ctx.client.mutation(api.quotes.saveQuote, {
    orgId: ctx.orgId,
    customerId,
    vehicleId,
    mode: "CASH",
    vehiclePrice: 28_000,
    downPayment: 0,
    termMonths: 0,
    totalFinancedAmount: 0,
    intent: "NEW",
  })) as Id<"quotes">;
}

async function resolveRoot(ctx: Ctx, vehicleId: Id<"vehicles">) {
  return await ctx.client.query(api.commitments.resolveVehicleRoot, {
    orgId: ctx.orgId,
    vehicleId,
  });
}

/** How many of a set of concurrent calls actually succeeded. */
function fulfilled<T>(results: PromiseSettledResult<T>[]) {
  return results.filter(
    (r): r is PromiseFulfilledResult<T> => r.status === "fulfilled"
  );
}

function rejectionMessages(results: PromiseSettledResult<unknown>[]) {
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => String((r.reason as Error)?.message ?? r.reason));
}

/**
 * ⚠️ Every refusal in a race must be a COMMITMENT refusal.
 *
 * A race that "passes" because the losers hit a validator error, an auth error
 * or a missing function proves nothing about the authority — it proves the
 * requests failed. This is the same discipline the direct corpus applies, and
 * it matters more here, where a flaky deployment can produce plausible-looking
 * failures that have nothing to do with the rule.
 */
function expectCommitmentRefusals(messages: string[]) {
  for (const message of messages) {
    expect(
      message,
      `a loser must be refused by the commitment authority, not by an unrelated error. Got: ${message}`
    ).not.toMatch(/Validator error|Unexpected field|Could not find|Unauthenticated|Forbidden/i);
    expect(message, `refusal must name the rule. Got: ${message}`).toMatch(
      /committed|another deal|another customer|already held|no longer available|reserv|application|ambiguous/i
    );
  }
}

test.describe("commitment authority under real concurrency", () => {
  test("the deployment declares itself disposable before anything is raced", async ({ page }) => {
    await page.goto("/");
    const client = await authenticatedConvexClient(page);
    const identity = await client.query(api.deploymentIdentity.identity, {});

    // ⚠️ This is a SAFETY assertion, not a smoke test. Everything below tries
    // to double-book inventory; against production that is an incident.
    expect(
      identity.isDisposable,
      `Refusing to race a deployment that has not declared itself disposable (${identity.deployment}). ` +
        "Set AUTOFLOW_DISPOSABLE_DEPLOYMENT=true on the preview backend."
    ).toBe(true);

    // Server-side evidence of WHICH commit answered. A race is only evidence
    // about the candidate if the backend agrees which commit it is running —
    // otherwise a green run could have raced a stale preview while the report
    // names the SHA that was merely checked out.
    expect(
      identity.gitSha,
      "The backend did not report the commit it was deployed from (DEPLOYMENT_GIT_SHA). " +
        "Without it this run cannot be attributed to a candidate SHA, and an unattributable pass is not evidence."
    ).toBeTruthy();
    if (process.env.GITHUB_SHA) {
      expect(
        identity.gitSha,
        "The backend answering these races is running a different commit than the workflow checked out."
      ).toBe(process.env.GITHUB_SHA);
    }
    // eslint-disable-next-line no-console
    console.log(
      `[contention] backend=${identity.deployment} sha=${identity.gitSha} disposable=${identity.isDisposable}`
    );
  });

  test("RACE A — acquire vs acquire: exactly one deal ends up owning the car", async ({ page }) => {
    await page.goto("/");
    const client = await authenticatedConvexClient(page);
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const ctx: Ctx = { client, orgId };
    const identity = await client.query(api.deploymentIdentity.identity, {});
    expect(identity.isDisposable, "refusing to race a non-disposable deployment").toBe(true);

    const vehicleId = await makeVehicle(ctx, "A");
    // Four DIFFERENT deals, each with its own customer and quote, all reaching
    // for the same physical car at the same moment.
    const quotes: Id<"quotes">[] = [];
    for (let i = 0; i < RACERS; i++) {
      const customerId = await makeCustomer(ctx, `A${i}`);
      quotes.push(await makeCashQuote(ctx, customerId, vehicleId));
    }

    const results = await Promise.allSettled(
      quotes.map((quoteId) =>
        client.mutation(api.deposits.create, { orgId, quoteId, amount: 1_000 })
      )
    );

    const winners = fulfilled(results);
    expect(
      winners.length,
      `exactly one of ${RACERS} simultaneous deposits may take the car; ` +
        `${winners.length} succeeded. Losers said: ${rejectionMessages(results).join(" | ")}`
    ).toBe(1);
    expectCommitmentRefusals(rejectionMessages(results));

    // Final-state proof, not just a count of successful calls: the authority
    // itself must name exactly one owner.
    const root = await resolveRoot(ctx, vehicleId);
    expect(root.kind, "the car ends up genuinely owned").toBe("OWNED");
    expect(
      root.conflictingRootIds,
      "and NOT ambiguous — two roots surviving a race is the defect this exists to catch"
    ).toHaveLength(0);
  });

  test("RACE B — release vs acquire: the outcome is serializable either way", async ({ page }) => {
    await page.goto("/");
    const client = await authenticatedConvexClient(page);
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const ctx: Ctx = { client, orgId };
    expect((await client.query(api.deploymentIdentity.identity, {})).isDisposable).toBe(true);

    const vehicleId = await makeVehicle(ctx, "B");
    const holderCustomer = await makeCustomer(ctx, "Bhold");
    const holderQuote = await makeCashQuote(ctx, holderCustomer, vehicleId);
    const depositId = (await client.mutation(api.deposits.create, {
      orgId,
      quoteId: holderQuote,
      amount: 1_000,
    })) as Id<"deposits">;

    const rivalCustomer = await makeCustomer(ctx, "Briv");
    const rivalQuote = await makeCashQuote(ctx, rivalCustomer, vehicleId);

    // The holder lets go at the same moment a rival reaches for it. BOTH
    // orderings are legitimate — what is not legitimate is both winning, or
    // the car ending up owned by nobody while a live deposit still exists.
    const [releaseResult, rivalResult] = await Promise.allSettled([
      client.mutation(api.deposits.release, {
        orgId,
        depositId,
        resolution: "REFUNDED",
        notes: "e2e release/acquire race",
      }),
      client.mutation(api.deposits.create, { orgId, quoteId: rivalQuote, amount: 1_000 }),
    ]);

    const root = await resolveRoot(ctx, vehicleId);
    expect(
      root.conflictingRootIds,
      "no ordering may leave two live roots on one car"
    ).toHaveLength(0);

    if (rivalResult.status === "fulfilled") {
      // Rival got there first, or the release landed first and freed it.
      expect(root.kind, "a successful rival acquisition must leave the car owned").toBe("OWNED");
    } else {
      expectCommitmentRefusals([String((rivalResult.reason as Error)?.message)]);
      // The rival lost. Whether the car is still held depends on which side
      // won, but it must not be silently owned by the rival.
      expect(["OWNED", "FREE"]).toContain(root.kind);
    }
    expect(
      releaseResult.status === "fulfilled" || rivalResult.status === "fulfilled",
      "at least one side of the race must have made progress"
    ).toBe(true);
  });

  test("RACE C — reopen vs competing acquire: exactly one winner", async ({ page }) => {
    await page.goto("/");
    const client = await authenticatedConvexClient(page);
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const ctx: Ctx = { client, orgId };
    expect((await client.query(api.deploymentIdentity.identity, {})).isDisposable).toBe(true);

    const vehicleId = await makeVehicle(ctx, "C");
    const financeCompanies = await client.query(api.finance.listCompanies, { orgId });
    const companyId = financeCompanies?.[0]?._id as Id<"financeCompanies"> | undefined;
    expect(
      companyId,
      "this race needs a finance company; the org has none and the fixture must not invent one behind the product"
    ).toBeTruthy();

    const applicantCustomer = await makeCustomer(ctx, "Capp");
    const applicantQuote = (await client.mutation(api.quotes.saveQuote, {
      orgId,
      customerId: applicantCustomer,
      vehicleId,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId,
      vehiclePrice: 28_000,
      downPayment: 0,
      termMonths: 48,
      totalFinancedAmount: 28_000,
      intent: "NEW",
    })) as Id<"quotes">;
    const applicationId = (await client.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId: applicantQuote,
    })) as Id<"financeApplications">;

    // Rejected: the car is genuinely free again, and now two people want it.
    await client.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "REJECTED",
    });

    const rivalCustomer = await makeCustomer(ctx, "Criv");
    const rivalQuote = await makeCashQuote(ctx, rivalCustomer, vehicleId);

    const [reopenResult, rivalResult] = await Promise.allSettled([
      client.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "PENDING_DOCS",
      }),
      client.mutation(api.deposits.create, { orgId, quoteId: rivalQuote, amount: 1_000 }),
    ]);

    const bothWon = reopenResult.status === "fulfilled" && rivalResult.status === "fulfilled";
    expect(
      bothWon,
      "a reopen and a competing acquisition must not both succeed on one car"
    ).toBe(false);
    expect(
      reopenResult.status === "fulfilled" || rivalResult.status === "fulfilled",
      "one of them has to win — a race where nobody makes progress is a livelock"
    ).toBe(true);

    const root = await resolveRoot(ctx, vehicleId);
    expect(root.kind, "the winner genuinely owns it").toBe("OWNED");
    expect(root.conflictingRootIds, "and there is exactly one root").toHaveLength(0);
  });

  test("RACE D — deposit vs reservation vs cash sale: one car, one outcome", async ({ page }) => {
    await page.goto("/");
    const client = await authenticatedConvexClient(page);
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const ctx: Ctx = { client, orgId };
    expect((await client.query(api.deploymentIdentity.identity, {})).isDisposable).toBe(true);

    const vehicleId = await makeVehicle(ctx, "D");
    const depositCustomer = await makeCustomer(ctx, "Ddep");
    const depositQuote = await makeCashQuote(ctx, depositCustomer, vehicleId);
    const reservationCustomer = await makeCustomer(ctx, "Dres");
    const saleCustomer = await makeCustomer(ctx, "Dsale");
    const saleQuote = await makeCashQuote(ctx, saleCustomer, vehicleId);
    // The signed-in operator records the sale — the same person the UI would
    // put here, read from their own session rather than looked up.
    const me = await client.query(api.users.getMe, {});
    const salespersonId = me?._id as Id<"users"> | undefined;
    expect(salespersonId, "the signed-in operator must resolve to a user").toBeTruthy();
    if (!salespersonId) throw new Error("no authenticated user");

    // Three DIFFERENT primitives, three different deals, one car. Historically
    // these three subsystems did not consult one another at all, so this is the
    // race the whole design exists to answer.
    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled<unknown>([
      client.mutation(api.deposits.create, { orgId, quoteId: depositQuote, amount: 1_000 }),
      client.mutation(api.vehicles.createReservation, {
        orgId,
        vehicleId,
        customerId: reservationCustomer,
      }),
      client.mutation(api.sales.create, {
        orgId,
        vehicleId,
        customerId: saleCustomer,
        salespersonId,
        salePrice: 28_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        quoteId: saleQuote,
      }),
    ]);

    const winners = fulfilled(results);
    expect(
      winners.length,
      `one car cannot be taken by three deals at once; ${winners.length} succeeded. ` +
        `Losers said: ${rejectionMessages(results).join(" | ")}`
    ).toBe(1);
    expectCommitmentRefusals(rejectionMessages(results));

    const root = await resolveRoot(ctx, vehicleId);
    expect(
      root.conflictingRootIds,
      "no duplicate ACTIVE roots — the AMBIGUOUS state must not be reachable through a race"
    ).toHaveLength(0);
    // Either somebody holds it, or the cash sale won and it is sold. What is
    // forbidden is FREE while money sits against it.
    const holdingDeposits = await client.query(api.deposits.listByVehicle, { orgId, vehicleId });
    const liveMoney = (holdingDeposits ?? []).filter(
      (d: { holdActive?: boolean }) => d.holdActive === true
    );
    if (liveMoney.length > 0) {
      expect(
        root.kind,
        "money is held against this car, so it must not read as FREE — that is the false-free that hands a sold car to a rival"
      ).toBe("OWNED");
    }
  });
});
