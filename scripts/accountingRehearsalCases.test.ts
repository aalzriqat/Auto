/**
 * Does the rehearsal actually CATCH anything?
 *
 * A rehearsal that only ever passes is decoration, and a green cloud run would
 * tell nobody anything. These tests drive `runRehearsalCases` against an
 * in-memory backend whose behaviour can be broken on purpose, and assert that
 * the case which exists to catch each defect is the case that goes red.
 *
 * This is the same discipline as the mutation battery on the client ratchet: the
 * instrument gets attacked before its output is quoted.
 *
 * ⚠️ EVIDENCE BOUNDARY. The fake below is a MODEL of the deposit-release
 * contract, not the product. It proves the ASSERTIONS discriminate; it proves
 * nothing about Convex, and in particular its `fireConcurrentReleases` stand-in
 * cannot interleave anything. Real interleaving is exactly what the cloud run
 * exists for, and nothing here substitutes for it.
 */
import { describe, expect, test } from "vitest";
import { runRehearsalCases } from "./accountingRehearsalCases.mjs";

type Deposit = {
  _id: string;
  releasedAmountMinor: number;
  refundedAmountMinor: number;
  releaseCount: number;
  freeMinor: number;
  committedMinor: number;
  vehicleId: string;
  status: string;
};

type Defects = {
  /** Distinct keys each pay the ORIGINAL free balance — the OCC failure C2 hunts. */
  doublePayOnDistinctKeys?: boolean;
  /** A later genuine payout is served the earlier one's stored result — the stale-key incident. */
  suppressNextGeneration?: boolean;
  /** Identity is not required at all. */
  acceptUnidentified?: boolean;
  /** Anyone at all may release. */
  acceptUnauthenticated?: boolean;
  /** The chart ships without 2110. */
  noUnappliedLiability?: boolean;
  /** A caller may name someone else's organization — the cross-tenant Critical. */
  acceptForeignOrg?: boolean;
  /** The chart is missing an account the product's own validator requires. */
  missingSystemAccount?: boolean;
  /** A replay posts a SECOND accounting event while leaving the deposit row alone. */
  doublePostOnReplay?: boolean;
  /** The money moves but the books never hear about it. */
  noCanonicalPayment?: boolean;
  /** A journal entry whose debits and credits disagree. */
  unbalancedJournal?: boolean;
  /** A posting failed on its way to the ledger and nobody noticed. */
  stuckFailedOutbox?: boolean;
  /** The GL is written even though no period is open — the partial-post outcome. */
  partialGlWhileClosed?: boolean;
  /** Money leaves while the books are shut and nothing is queued to catch up. */
  loseThePostingWhileClosed?: boolean;
  /** The period cannot be closed at all — so the property is UNTESTED, not proven. */
  refuseClose?: boolean;
};

function makeBackend(defects: Defects = {}) {
  const deposits = new Map<string, Deposit>();
  const commands = new Map<string, string>();
  /** The books the fake keeps, so the reconciliation cases have something to reconcile. */
  const events: Array<Record<string, any>> = [];
  const journalEntries: Array<Record<string, any>> = [];
  const journalLines = new Map<string, Array<Record<string, any>>>();
  const collectionPayments: Array<Record<string, any>> = [];
  const canonicalPayments = new Map<string, Record<string, any>>();
  const pendingEvents: Array<Record<string, any>> = [];
  let periodStatus = "OPEN";
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;
  const vehicleOf = new Map<string, string[]>();

  const release = (args: Record<string, any>, authed: boolean) => {
    if (!authed && !defects.acceptUnauthenticated) {
      return { ok: false as const, error: "Unauthenticated: You must be logged in." };
    }
    // Tenancy is modelled because the TEN case asserts on it. A fake that
    // ignored `orgId` would make TEN red against a HEALTHY backend, which would
    // teach the reader to expect a red case and stop reading — the failure mode
    // that makes a noisy suite worse than none.
    if (args.orgId !== "org_1" && !defects.acceptForeignOrg) {
      return { ok: false as const, error: "You do not have access to this organization." };
    }
    if (!args.idempotencyKey && !defects.acceptUnidentified) {
      return { ok: false as const, error: "This economic command requires a command identity." };
    }
    const deposit = deposits.get(args.depositId);
    if (!deposit) return { ok: false as const, error: "deposit not found" };

    const fingerprint = JSON.stringify([args.depositId, args.resolution, args.refundMethod]);
    if (args.idempotencyKey) {
      const seen = commands.get(args.idempotencyKey);
      if (seen !== undefined) {
        if (seen !== fingerprint) {
          return { ok: false as const, error: "This command was already run with different request content." };
        }
        // A replay that re-posts to the ledger while leaving the deposit row
        // alone is invisible to every case that reads only the row — which is
        // exactly why B1 counts the events.
        if (defects.doublePostOnReplay) {
          events.push({
            _id: id("evt"),
            eventType: "DEPOSIT_REFUNDED",
            sourceType: "deposits",
            sourceId: deposit._id,
            eventVersion: deposit.releaseCount,
            payload: { depositId: deposit._id, amountMinor: deposit.releasedAmountMinor },
          });
        }
        return { ok: true as const, value: null }; // faithful replay
      }
      if (defects.suppressNextGeneration && deposit.releaseCount > 0) {
        return { ok: true as const, value: null }; // a NEW key served as a replay
      }
    }

    const payable = defects.doublePayOnDistinctKeys ? 2_000_000 : deposit.freeMinor;
    if (payable <= 0) {
      return { ok: false as const, error: "There is nothing left of this deposit to refund or forfeit." };
    }
    if (args.idempotencyKey) commands.set(args.idempotencyKey, fingerprint);
    deposit.freeMinor = defects.doublePayOnDistinctKeys ? deposit.freeMinor : 0;
    deposit.releasedAmountMinor += payable;
    deposit.refundedAmountMinor += payable;
    deposit.releaseCount += 1;
    if (deposit.freeMinor === 0 && deposit.committedMinor === 0) deposit.status = args.resolution;
    if (periodStatus === "OPEN") {
      postRefundToTheBooks(deposit, payable);
    } else {
      // No open period is a TEMPORARY HOLD: the decision stands, the posting
      // waits. Writing the journal anyway is the partial-post defect P1 hunts.
      if (defects.partialGlWhileClosed) postRefundToTheBooks(deposit, payable);
      if (!defects.loseThePostingWhileClosed) {
        pendingEvents.push({ _id: id("pev"), status: "PENDING", eventType: "DEPOSIT_REFUNDED" });
      }
    }
    return { ok: true as const, value: null };
  };

  /** The ledger side of a refund — what B1 and B2 reconcile the row against. */
  function postRefundToTheBooks(deposit: Deposit, payable: number) {
    events.push({
      _id: id("evt"),
      eventType: "DEPOSIT_REFUNDED",
      sourceType: "deposits",
      sourceId: deposit._id,
      eventVersion: deposit.releaseCount,
      payload: { depositId: deposit._id, amountMinor: payable },
    });
    const entryId = id("je");
    journalEntries.push({ _id: entryId });
    journalLines.set(entryId, [
      { debitMinor: payable, creditMinor: 0 },
      // An unbalanced entry is a GL that does not add up — B2's whole subject.
      { debitMinor: 0, creditMinor: defects.unbalancedJournal ? payable - 1 : payable },
    ]);
    const canonicalId = id("cp");
    if (!defects.noCanonicalPayment) {
      canonicalPayments.set(canonicalId, { _id: canonicalId, amountMinor: payable, status: "SETTLED" });
    }
    collectionPayments.push({
      _id: id("colp"),
      vehicleId: deposit.vehicleId,
      reference: `Deposit refund ${deposit._id}`,
      direction: "OUT",
      method: "REFUND",
      amount: payable / 100,
      canonicalPaymentId: defects.noCanonicalPayment ? undefined : canonicalId,
    });
  }

  const call = (authed: boolean) => async (kind: string, fnPath: string, args: Record<string, any>) => {
    switch (fnPath) {
      case "chartOfAccounts:initialize":
        return { ok: true as const, value: null };
      case "chartOfAccounts:list":
        return {
          ok: true as const,
          value: defects.noUnappliedLiability
            ? [{ code: "1000", type: "ASSET", name: "Cash" }]
            : [
                { code: "1000", type: "ASSET", name: "Cash" },
                { code: "2110", type: "LIABILITY", name: "Unapplied Customer Receipts" },
              ],
        };
      case "accountingPeriods:create":
        return { ok: true as const, value: id("period") };
      case "accountingPeriods:list":
        return { ok: true as const, value: [{ _id: "p1", status: periodStatus }] };
      case "accountingPeriods:close":
        if (defects.refuseClose) {
          return { ok: false as const, error: "The close checklist is not clean." };
        }
        periodStatus = "CLOSED";
        return { ok: true as const, value: null };
      case "organizations:create":
        // A genuinely different organization the caller owns — what the TEN case
        // needs in order to test OWNERSHIP rather than id syntax.
        return { ok: true as const, value: id("org") };
      case "customers:create":
        return { ok: true as const, value: id("cust") };
      case "vehicles:create":
        return { ok: true as const, value: id("veh") };
      case "quotes:saveQuote":
        return { ok: true as const, value: id("quote") };
      case "deposits:create": {
        const depositId = id("dep");
        deposits.set(depositId, {
          _id: depositId,
          releasedAmountMinor: 0,
          refundedAmountMinor: 0,
          releaseCount: 0,
          freeMinor: 2_000_000,
          committedMinor: 1_000_000,
          vehicleId: String(args.vehicleId ?? ""),
          status: "HELD",
        });
        return { ok: true as const, value: depositId };
      }
      case "chartOfAccounts:validateSystemAccounts":
        return {
          ok: true as const,
          value: defects.missingSystemAccount
            ? { valid: false, missing: ["UNAPPLIED_CUSTOMER_RECEIPTS"] }
            : { valid: true, missing: [] },
        };
      case "accountingLedger:listAccountingEvents":
        return {
          ok: true as const,
          value: events.filter(
            (e) => e.sourceType === args.sourceType && String(e.sourceId) === String(args.sourceId)
          ),
        };
      case "accountingLedger:listJournalEntries":
        // A COPY. Returning the live array handed P1 the same object twice, so
        // its before/after lengths were necessarily equal and the partial-post
        // defect walked straight past it. A real query returns a fresh result;
        // a fake that shares state silently disables the assertions built on it.
        return { ok: true as const, value: [...journalEntries] };
      case "accountingLedger:getJournalEntry":
        return {
          ok: true as const,
          value: { entry: { _id: args.journalEntryId }, lines: journalLines.get(args.journalEntryId) ?? [] },
        };
      case "accountingOutbox:listPending":
        return {
          ok: true as const,
          value:
            args.status === "FAILED"
              ? defects.stuckFailedOutbox
                ? [{ _id: "pev_stuck", status: "FAILED", eventType: "DEPOSIT_REFUNDED" }]
                : []
              : [...pendingEvents],
        };
      case "collections:listPayments":
        return {
          ok: true as const,
          value: { page: [...collectionPayments], isDone: true, continueCursor: null },
        };
      case "subledger:getPaymentBalance": {
        const payment = canonicalPayments.get(args.paymentId);
        return { ok: true as const, value: payment ? { payment, unappliedMinor: 0 } : null };
      }
      case "deposits:allocateToVehicles": {
        // Re-allocating a car to 0 frees its share — the supported operation the
        // second genuine payout depends on.
        const zeroed = (args.allocations ?? []).some((a: any) => a.amount === 0);
        if (zeroed) {
          for (const deposit of deposits.values()) {
            if (deposit.committedMinor > 0) {
              deposit.freeMinor += 1_000_000;
              deposit.committedMinor -= 1_000_000;
            }
          }
        }
        return { ok: true as const, value: null };
      }
      case "deposits:release":
        return release(args, authed);
      case "deposits:listByVehicle":
        return { ok: true as const, value: [...deposits.values()] };
      default:
        return { ok: false as const, error: `unmodelled function ${fnPath}` };
    }
  };

  const authedCall = call(true);
  const must = async (kind: string, fnPath: string, args: Record<string, any>) => {
    const r = await authedCall(kind, fnPath, args);
    if (!r.ok) throw new Error(`${fnPath} failed: ${r.error}`);
    return r.value;
  };

  void vehicleOf;
  return { authedCall, anonymousCall: call(false), must, deposits };
}

/** Mirrors the real recorder: a failure is captured as evidence, never thrown. */
const recordCase = (
  results: Array<Record<string, unknown>>,
  id: string,
  description: string,
  assertion: () => unknown
) =>
  Promise.resolve()
    .then(assertion)
    .then((detail) => {
      results.push({ id, description, status: "PASS", detail: detail ?? null });
    })
    .catch((error) => {
      results.push({
        id,
        description,
        // Mirrors the real recorder: "could not be tested" is a THIRD outcome,
        // and collapsing it into FAIL is what tempts someone to weaken the
        // assertion until the red goes away.
        status: (error as any)?.__unproven ? "UNPROVEN" : "FAIL",
        detail: String((error as Error)?.message ?? error),
      });
    });

async function runAgainst(defects: Defects = {}) {
  const backend = makeBackend(defects);
  const results: Array<Record<string, unknown>> = [];
  await runRehearsalCases({
    results,
    orgId: "org_1",
    config: { convexUrl: "https://x.convex.cloud" },
    tokens: { sales: "t-sales", approver: "t-approver" },
    asSales: backend.authedCall,
    asApprover: backend.authedCall,
    anonymousCall: backend.anonymousCall,
    salesMust: backend.must,
    approverMust: backend.must,
    recordCase,
    unproven: (reason: string) => {
      const error = new Error(reason);
      error.name = "Unproven";
      (error as any).__unproven = true;
      throw error;
    },
    // The harness cannot interleave; it issues each attempt in turn. That is
    // enough to exercise the ASSERTIONS, and is precisely why the cloud run is
    // not optional.
    fireConcurrentReleases: async ({ attempts }: any) => {
      const out = [];
      for (const attempt of attempts) {
        const r = await backend.authedCall("mutation", "deposits:release", attempt.args);
        out.push({ label: attempt.label, exitCode: 0, result: { status: r.ok ? "success" : "error" } });
      }
      return out;
    },
  } as never);
  return results;
}

const statusOf = (results: Array<Record<string, unknown>>, id: string) =>
  results.find((r) => r.id === id)?.status;

describe("the rehearsal passes against a backend that behaves", () => {
  test("every case is green when nothing is broken", async () => {
    const results = await runAgainst();
    const failures = results.filter((r) => r.status === "FAIL");
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    // UNPROVEN is not FAIL, so a case that quietly declined to run would slip
    // past the line above — which is precisely how a partial rehearsal gets
    // quoted as a complete one. Against a healthy backend nothing may decline.
    const declined = results.filter((r) => r.status === "UNPROVEN");
    expect(declined.map((d) => `${d.id}: ${d.detail}`)).toEqual([]);
    // And it actually ran the cases rather than finding nothing to do.
    expect(results.length).toBeGreaterThanOrEqual(14);
    for (const id of ["A3", "B1", "B2", "P1"]) {
      expect(statusOf(results, id), `${id} must actually execute`).toBe("PASS");
    }
  });
});

describe("the rehearsal FAILS when the backend misbehaves — one defect per case", () => {
  test("C2 catches two distinct keys paying one free balance twice", async () => {
    // The defect the cloud run exists for: identity alone cannot stop this,
    // because two different keys are two different commands.
    const results = await runAgainst({ doublePayOnDistinctKeys: true });
    expect(statusOf(results, "C2")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "C2")?.detail)).toMatch(/released amount/i);
  });

  test("D2 catches a genuinely new payout being suppressed", async () => {
    // The original incident: money not moved, success reported.
    const results = await runAgainst({ suppressNextGeneration: true });
    expect(statusOf(results, "D2")).toBe("FAIL");
  });

  test("D4 catches an unidentified economic command being accepted", async () => {
    const results = await runAgainst({ acceptUnidentified: true });
    expect(statusOf(results, "D4")).toBe("FAIL");
  });

  test("UNAUTH catches money moving with no authentication at all", async () => {
    const results = await runAgainst({ acceptUnauthenticated: true });
    expect(statusOf(results, "UNAUTH")).toBe("FAIL");
  });

  test("TEN catches a release reaching across a tenant boundary", async () => {
    // TEN-1: naming an org is not the same as owning the row. Two cross-tenant
    // Criticals have already shipped from that conflation.
    const results = await runAgainst({ acceptForeignOrg: true });
    expect(statusOf(results, "TEN")).toBe("FAIL");
  });

  test("A1 catches a chart shipped without the 2110 liability", async () => {
    const results = await runAgainst({ noUnappliedLiability: true });
    expect(statusOf(results, "A1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "A1")?.detail)).toMatch(/2110 is absent/);
  });

  test("A3 catches a chart missing an account the product's own validator requires", async () => {
    const results = await runAgainst({ missingSystemAccount: true });
    expect(statusOf(results, "A3")).toBe("FAIL");
  });

  test("B1 catches a replay that posts a SECOND event while the deposit row stays still", async () => {
    // The row is correct, releaseCount is correct, every D-case passes — and the
    // books have been credited twice. Only a case that counts the events sees it.
    const results = await runAgainst({ doublePostOnReplay: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "B1")?.detail)).toMatch(/DEPOSIT_REFUNDED events/);
    // And the row-only cases are blind to it, which is the reason B1 exists.
    expect(statusOf(results, "D1")).toBe("PASS");
  });

  test("B1 catches money leaving without ever reaching a canonical payment", async () => {
    const results = await runAgainst({ noCanonicalPayment: true });
    expect(statusOf(results, "B1")).toBe("FAIL");
  });

  test("B2 catches a journal entry whose debits and credits disagree", async () => {
    const results = await runAgainst({ unbalancedJournal: true });
    expect(statusOf(results, "B2")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "B2")?.detail)).toMatch(/do not balance/);
  });

  test("B2 catches a posting stuck FAILED on its way to the ledger", async () => {
    const results = await runAgainst({ stuckFailedOutbox: true });
    expect(statusOf(results, "B2")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "B2")?.detail)).toMatch(/FAILED in the outbox/);
  });

  test("P1 catches a GL written while no accounting period is open", async () => {
    // The partial post: the books move while they are shut, so the period's
    // reported balances and its journals stop agreeing with each other.
    const results = await runAgainst({ partialGlWhileClosed: true });
    expect(statusOf(results, "P1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "P1")?.detail)).toMatch(/journal entries written/);
  });

  test("P1 catches money leaving with no queued path to the books", async () => {
    const results = await runAgainst({ loseThePostingWhileClosed: true });
    expect(statusOf(results, "P1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "P1")?.detail)).toMatch(/no path to the books/);
  });

  test("P1 reports UNPROVEN rather than PASS when it cannot close the period", async () => {
    // The distinction the third status exists for: the product refusing to
    // close a period is not evidence that closed periods behave correctly.
    const results = await runAgainst({ refuseClose: true });
    expect(statusOf(results, "P1")).toBe("UNPROVEN");
  });

  test("a defect in one case does not silently take the others down with it", async () => {
    // Each case builds its own fixture, so an unrelated red must stay local —
    // otherwise one failure would mask the true state of everything after it.
    const results = await runAgainst({ noUnappliedLiability: true });
    expect(statusOf(results, "D1")).toBe("PASS");
    expect(statusOf(results, "C1")).toBe("PASS");
  });
});
