import { test, expect } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  APPROVER_AUTH_FILE,
  authenticatedConvexClient,
  resolveOrgId,
  testDataSuffix,
} from "../utils";

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

/**
 * The whole observable outcome, read through the same public queries a screen
 * would use.
 *
 * The first version of these races asked only "did exactly one call succeed,
 * and are there no conflicting roots". That is satisfiable by an implementation
 * that picks a winner and then records the WRONG one — a rival's deposit
 * accepted while the car ends up owned by the holder reads as a clean pass. So
 * every race below now correlates WHICH side won to WHAT must then be true.
 */
async function finalState(ctx: Ctx, vehicleId: Id<"vehicles">) {
  const root = await resolveRoot(ctx, vehicleId);
  const vehicle = await ctx.client.query(api.vehicles.get, {
    orgId: ctx.orgId,
    vehicleId,
  });
  const deposits = await ctx.client.query(api.deposits.listByVehicle, {
    orgId: ctx.orgId,
    vehicleId,
  });
  // ⚠️ Despite the name, this query is a UNIFIED HOLD HISTORY, not a list of
  // reservations. It deliberately renders held DEPOSITS as hold entries too --
  // its own comment explains why: a deposit "holds the vehicle just as hard as
  // a reservation does" but writes only a deposits row, so the tab used to read
  // "No reservations recorded" over a car that was genuinely off the market.
  //
  // Reservation rows carry `origin: "RESERVATION"`; deposit-derived entries
  // carry `origin: "DEPOSIT"` and are ACTIVE while `holdActive` is true. Race D
  // read the name and not the implementation, so a winning DEPOSIT counted as a
  // surviving reservation and the deposit branch failed on its own winner.
  const holdHistory = await ctx.client.query(api.vehicles.getReservationHistory, {
    orgId: ctx.orgId,
    vehicleId,
  });
  return {
    root,
    status: (vehicle as { status?: string } | null)?.status ?? null,
    liveDeposits: ((deposits ?? []) as Array<{ holdActive?: boolean }>).filter(
      (d) => d.holdActive === true
    ),
    /** Genuine reservation rows only — see the note above. */
    activeReservations: (
      (holdHistory ?? []) as Array<{ status?: string; origin?: string }>
    ).filter((r) => r.status === "ACTIVE" && r.origin === "RESERVATION"),
  };
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

  test("RACE B — release vs acquire: the winner is named, not merely counted", async ({
    page,
    browser,
  }) => {
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

    /**
     * TWO IDENTITIES, because releasing money is a maker-checker decision.
     *
     * `releaseHeldDeposit` refuses the person who took the deposit from also
     * resolving it, and refuses a REFUND with no explicit refund method. Both
     * fire BEFORE the commitment authority is consulted, so a single-session
     * race would fail on a financial control having never reached the
     * release-versus-acquire window — proving the request was rejected, not
     * that the authority works. Exactly the wrong-reason pass this whole suite
     * is built to refuse, and it would have burned a Preview dispatch to learn.
     *
     * The approver is a REAL second operator, provisioned through the product's
     * own Add Team Member path in auth.setup.ts. No impersonation, no backdoor.
     */
    const approverContext = await browser.newContext({ storageState: APPROVER_AUTH_FILE });
    try {
      const approverPage = await approverContext.newPage();
      await approverPage.goto("/");
      const approverClient = await authenticatedConvexClient(approverPage);
      const approverOrgId = await resolveOrgId(approverPage);
      // A second identity in a different dealership would make every assertion
      // below meaningless: its release would target another org's world.
      expect(
        approverOrgId,
        "both identities must be racing inside the SAME dealership"
      ).toEqual(orgId);

      const rivalCustomer = await makeCustomer(ctx, "Briv");
      const rivalQuote = await makeCashQuote(ctx, rivalCustomer, vehicleId);

      // The holder's deal lets go at the same moment a rival reaches for the
      // car. Both orderings are legitimate; what each one OBLIGES afterwards is
      // not negotiable, and that is what this asserts.
      const [releaseResult, rivalResult] = await Promise.allSettled([
        approverClient.mutation(api.deposits.release, {
          orgId,
          depositId,
          resolution: "REFUNDED",
          // Required by `releaseHeldDeposit`: a refund moves real cash, and the
          // GL entry must credit the account it actually left from.
          refundMethod: "CASH",
          notes: "e2e release/acquire race",
        }),
        client.mutation(api.deposits.create, { orgId, quoteId: rivalQuote, amount: 1_000 }),
      ]);

      // An authorised release must always succeed. Nothing a rival attempts
      // concurrently may prevent a dealership from returning a customer's
      // money — if this ever fails, somebody is trapped in a deal by a
      // stranger's timing.
      expect(
        releaseResult.status,
        `the approver's release must succeed. Got: ${rejectionMessages([releaseResult]).join(" | ")}`
      ).toBe("fulfilled");

      const after = await finalState(ctx, vehicleId);
      expect(
        after.root.conflictingRootIds,
        "no ordering may leave two live roots on one car"
      ).toHaveLength(0);

      if (rivalResult.status === "fulfilled") {
        // The release landed first, so the rival took a genuinely free car. The
        // car must now be THEIRS — not merely "owned by somebody".
        expect(after.root.kind, "the rival acquired it, so it is owned").toBe("OWNED");
        expect(
          after.root.customerId,
          "and owned by the RIVAL — a race that hands the car to the wrong deal is the defect, not the pass"
        ).toEqual(rivalCustomer);
        expect(
          after.liveDeposits.length,
          "exactly one live hold: the rival's. The refunded one must not still be holding"
        ).toBe(1);
      } else {
        // The rival was refused while the hold was still live, and the release
        // then completed. Nobody holds the car.
        expectCommitmentRefusals(rejectionMessages([rivalResult]));
        expect(
          after.root.kind,
          "the rival lost and the holder's money went back, so the car is free"
        ).toBe("FREE");
        expect(
          after.liveDeposits,
          "and no money is still holding it — a FREE car with a live hold is the false-free"
        ).toHaveLength(0);
      }
    } finally {
      await approverContext.close();
    }
  });

  test("RACE C — reopen vs competing acquire: one winner, and the root names them", async ({ page }) => {
    await page.goto("/");
    const client = await authenticatedConvexClient(page);
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const ctx: Ctx = { client, orgId };
    expect((await client.query(api.deploymentIdentity.identity, {})).isDisposable).toBe(true);

    const vehicleId = await makeVehicle(ctx, "C");

    // A fresh preview has no finance companies. Create one through the real
    // product mutation rather than failing the fixture — this is the same call
    // Settings > Finance Companies makes, so it is still no backdoor.
    const existing = await client.query(api.finance.listCompanies, { orgId });
    const companyId = (existing?.[0]?._id ??
      (await client.mutation(api.finance.createCompany, {
        orgId,
        name: `E2E Race Finance ${testDataSuffix()}`,
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      }))) as Id<"financeCompanies">;
    expect(companyId, "the race needs a finance company to exist").toBeTruthy();

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

    await client.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "REJECTED",
    });

    // The premise, asserted rather than assumed. If REJECTED did not actually
    // free the car, the race below would be starting from a held vehicle and
    // whatever it proved would be about something else entirely.
    const afterReject = await finalState(ctx, vehicleId);
    expect(
      afterReject.root.kind,
      "a rejected application must genuinely release the car before the race begins"
    ).toBe("FREE");

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
    expectCommitmentRefusals(rejectionMessages([reopenResult, rivalResult]));

    const after = await finalState(ctx, vehicleId);
    expect(after.root.kind, "the winner genuinely owns it").toBe("OWNED");
    expect(after.root.conflictingRootIds, "and there is exactly one root").toHaveLength(0);

    if (reopenResult.status === "fulfilled") {
      // Reopening reacquired the SAME deal's car, so the applicant holds it and
      // the rival's money never landed.
      expect(
        after.root.customerId,
        "the reopened application owns it — not the rival whose deposit was refused"
      ).toEqual(applicantCustomer);
      expect(after.liveDeposits, "and the rival holds no live deposit").toHaveLength(0);
    } else {
      expect(
        after.root.customerId,
        "the rival got there first, so the car is theirs and the reopen was refused"
      ).toEqual(rivalCustomer);
      expect(after.liveDeposits.length, "held by the rival's money").toBe(1);
    }
  });

  test("RACE D — deposit vs reservation vs cash sale: the winner's consequences are specific", async ({ page }) => {
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
    const [depositResult, reservationResult, saleResult]: PromiseSettledResult<unknown>[] =
      await Promise.allSettled<unknown>([
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

    const results = [depositResult, reservationResult, saleResult];
    const winners = fulfilled(results);
    expect(
      winners.length,
      `one car cannot be taken by three deals at once; ${winners.length} succeeded. ` +
        `Losers said: ${rejectionMessages(results).join(" | ")}`
    ).toBe(1);
    expectCommitmentRefusals(rejectionMessages(results));

    const after = await finalState(ctx, vehicleId);
    expect(
      after.root.conflictingRootIds,
      "no duplicate ACTIVE roots — the AMBIGUOUS state must not be reachable through a race"
    ).toHaveLength(0);

    // Which primitive won dictates a DIFFERENT observable world. Asserting only
    // "one of them won" would accept a deposit that succeeded while the car
    // silently went SOLD to somebody else.
    if (depositResult.status === "fulfilled") {
      expect(after.root.kind, "the deposit holds the car").toBe("OWNED");
      expect(after.root.customerId, "for the depositor's deal").toEqual(depositCustomer);
      expect(after.liveDeposits.length, "and their money is live against it").toBe(1);
      expect(after.status, "a deposit does not sell a car").not.toBe("SOLD");
      expect(after.activeReservations, "and the refused reservation left nothing").toHaveLength(0);
    } else if (reservationResult.status === "fulfilled") {
      expect(after.root.kind, "the reservation holds the car").toBe("OWNED");
      expect(after.root.customerId, "for the reserving customer").toEqual(reservationCustomer);
      expect(after.status, "a reservation does not sell a car").not.toBe("SOLD");
      expect(after.activeReservations.length, "exactly one live reservation").toBe(1);
      expect(after.liveDeposits, "and the refused deposit left no live money").toHaveLength(0);
    } else {
      // The cash sale won: the car left inventory, and NOTHING may still be
      // holding it. A surviving hard hold on a sold car is the state that lets
      // the same car be sold twice.
      expect(after.status, "the cash sale completed, so the car is sold").toBe("SOLD");
      expect(
        after.liveDeposits,
        "no deposit may still hold a car that has been sold to somebody else"
      ).toHaveLength(0);
      expect(
        after.activeReservations,
        "and no reservation may still hold it either"
      ).toHaveLength(0);
    }
  });
});
