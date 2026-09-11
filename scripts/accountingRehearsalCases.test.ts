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
  /** A replayed create makes a SECOND row — the double-spend. */
  duplicateOnCreateReplay?: boolean;
  /** A replayed create is REFUSED — safe-looking, and not safe. */
  refuseCreateReplay?: boolean;
  /** An over-payment settles the invoice and the excess simply disappears. */
  swallowOverpayment?: boolean;
  /** Applying a retained credit does not reduce the liability. */
  ignoreRetainedApplication?: boolean;
  /** A returned cheque ERASES its clearing instead of reversing it. */
  eraseOnChequeReturn?: boolean;
  /** A returned cheque posts nothing at all — the books still say money arrived. */
  silentChequeReturn?: boolean;
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
  const createdByKey = new Map<string, string>();
  const retained = new Map<string, { receiptMovementId: string; customerId: string; remainingUnappliedMinor: number; receiptPosted: boolean }>();
  const cheques = new Map<string, Record<string, any>>();
  /** quoteId -> vehicleId, because a deposit names a QUOTE and is read back by VEHICLE. */
  const quoteVehicle = new Map<string, string>();
  let periodStatus = "OPEN";

  /**
   * The identity contract on a CREATE, modelled the way RT1 asserts it: a
   * replayed key replays. `probe` mode returns null when the caller must go on
   * and build the row itself, so deposits keep their own construction.
   */
  function replayableCreate(prefix: string, args: Record<string, any>, probe = false) {
    const key = args.idempotencyKey;
    if (key && createdByKey.has(key)) {
      if (defects.refuseCreateReplay) {
        return { ok: false as const, error: "Duplicate request." };
      }
      if (defects.duplicateOnCreateReplay) {
        const fresh = id(prefix);
        createdByKey.set(key, fresh);
        return { ok: true as const, value: fresh };
      }
      return { ok: true as const, value: createdByKey.get(key)! };
    }
    if (probe) return null;
    const made = id(prefix);
    if (key) createdByKey.set(key, made);
    return { ok: true as const, value: made };
  }
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
      case "collections:createReceivable": {
        // The product refuses to INFER a credit account from an ambiguous
        // source type. The fake accepted anything, so the cloud run was the
        // first thing to tell me — twice, in one run. A fake more permissive
        // than the product turns every one of its preconditions into a
        // cloud-only discovery.
        const ambiguous = args.sourceType === "OTHER" || args.sourceType === "CHEQUE";
        if (ambiguous && !args.creditSystemKey) {
          return {
            ok: false as const,
            error: "This receivable's credit account isn't obvious from its source type — specify creditSystemKey.",
          };
        }
        return replayableCreate("recv", args)!;
      }
      case "collections:recordPayment": {
        const made = replayableCreate("pay", args, true);
        if (made) return made;
        const paymentId = id("pay");
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, paymentId);
        // The excess is a LIABILITY, not income. A backend that keeps the
        // change is the defect RC1 exists to catch.
        const overMinor = Math.round((Number(args.amount) - 1000) * 100);
        if (overMinor > 0 && !defects.swallowOverpayment) {
          const movementId = id("mov");
          retained.set(movementId, {
            receiptMovementId: movementId,
            customerId: String(args.customerId),
            remainingUnappliedMinor: overMinor,
            receiptPosted: true,
          });
        }
        return { ok: true as const, value: paymentId };
      }
      case "collections:listRetainedCredits": {
        const all = [...retained.values()].filter(
          (r) => !args.customerId || r.customerId === String(args.customerId)
        );
        const visible = args.onlyRemaining ? all.filter((r) => r.remainingUnappliedMinor > 0) : all;
        return { ok: true as const, value: { page: visible, isDone: true, continueCursor: null } };
      }
      case "collections:applyRetainedCredit": {
        const made = replayableCreate("apply", args, true);
        if (made) return made;
        const position = retained.get(String(args.receiptMovementId));
        if (!position) return { ok: false as const, error: "Retained position not found." };
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, id("apply"));
        if (!defects.ignoreRetainedApplication) {
          position.remainingUnappliedMinor -= Math.round(Number(args.requestedAmount) * 100);
        }
        return { ok: true as const, value: null };
      }
      case "collections:registerCheque": {
        const chequeId = id("chq");
        cheques.set(chequeId, { _id: chequeId, status: "REGISTERED" });
        return { ok: true as const, value: chequeId };
      }
      case "collections:depositCheque": {
        const cheque = cheques.get(String(args.chequeId));
        if (cheque) cheque.status = "DEPOSITED";
        return { ok: true as const, value: null };
      }
      case "collections:clearCheque": {
        const made = replayableCreate("clr", args, true);
        if (made) return made;
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, id("clr"));
        const cheque = cheques.get(String(args.chequeId));
        if (cheque) cheque.status = "CLEARED";
        const entryId = id("je");
        journalEntries.push({ _id: entryId });
        journalLines.set(entryId, [
          { debitMinor: 120_000, creditMinor: 0 },
          { debitMinor: 0, creditMinor: 120_000 },
        ]);
        return { ok: true as const, value: null };
      }
      case "collections:returnClearedCheque": {
        const made = replayableCreate("ret", args, true);
        if (made) return made;
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, id("ret"));
        const cheque = cheques.get(String(args.chequeId));
        if (defects.eraseOnChequeReturn) {
          // Balances perfectly, and destroys the record that it ever happened.
          journalEntries.pop();
          cheques.delete(String(args.chequeId));
          return { ok: true as const, value: null };
        }
        if (cheque) cheque.status = "RETURNED";
        if (!defects.silentChequeReturn) {
          const reversalId = id("je");
          journalEntries.push({ _id: reversalId });
          journalLines.set(reversalId, [
            { debitMinor: 0, creditMinor: 120_000 },
            { debitMinor: 120_000, creditMinor: 0 },
          ]);
        }
        return { ok: true as const, value: null };
      }
      case "collections:listCheques":
        return { ok: true as const, value: { page: [...cheques.values()], isDone: true, continueCursor: null } };
      case "organizations:create":
        // A genuinely different organization the caller owns — what the TEN case
        // needs in order to test OWNERSHIP rather than id syntax.
        return { ok: true as const, value: id("org") };
      case "customers:create":
        return { ok: true as const, value: id("cust") };
      case "vehicles:create":
        // Non-probe mode never returns null; the assertion keeps that visible
        // to the type checker instead of widening every caller's result.
        return replayableCreate("veh", args)!;
      case "quotes:saveQuote": {
        const quoteId = id("quote");
        quoteVehicle.set(quoteId, String(args.vehicleId ?? ""));
        return { ok: true as const, value: quoteId };
      }
      case "deposits:create": {
        const replayed = replayableCreate("dep", args, true);
        if (replayed) return replayed;
        const depositId = id("dep");
        // Taking a deposit POSTS. Modelling that is not decoration: P1's first
        // cloud run failed because it measured its journal window from before
        // the fixture, so these ordinary open-period entries were counted as
        // postings made while the books were shut. The fake did not post on
        // create, so nothing here could reproduce it. It does now.
        if (periodStatus === "OPEN") {
          const receiptEntry = id("je");
          journalEntries.push({ _id: receiptEntry });
          journalLines.set(receiptEntry, [
            { debitMinor: 5_000_00, creditMinor: 0 },
            { debitMinor: 0, creditMinor: 5_000_00 },
          ]);
        }
        deposits.set(depositId, {
          _id: depositId,
          releasedAmountMinor: 0,
          refundedAmountMinor: 0,
          releaseCount: 0,
          freeMinor: 2_000_000,
          committedMinor: 1_000_000,
          vehicleId: quoteVehicle.get(String(args.quoteId)) ?? String(args.vehicleId ?? ""),
          status: "HELD",
        });
        if (args.idempotencyKey) createdByKey.set(args.idempotencyKey, depositId);
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
        // Actually FILTERS. Returning every deposit made RT1's "one row for this
        // vehicle" assertion unsatisfiable against a healthy backend, which
        // would have taught the reader that a red RT1 is normal.
        return {
          ok: true as const,
          value: [...deposits.values()].filter((d) => d.vehicleId === String(args.vehicleId)),
        };
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
    expect(results.length).toBeGreaterThanOrEqual(17);
    for (const id of ["A3", "B1", "B2", "P1", "RT1", "RC1", "RV1"]) {
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

  test("RT1 catches a replayed create that makes a SECOND row", async () => {
    const results = await runAgainst({ duplicateOnCreateReplay: true });
    expect(statusOf(results, "RT1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RT1")?.detail)).toMatch(/DIFFERENT id/);
  });

  test("RT1 catches a replayed create that is REFUSED", async () => {
    // A refused retry looks safe and is not: the first command stands while the
    // operator is told it failed, and the natural next action is to try again
    // with fresh content — which is how one intent becomes two commands.
    const results = await runAgainst({ refuseCreateReplay: true });
    expect(statusOf(results, "RT1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RT1")?.detail)).toMatch(/refused/);
  });

  test("RC1 catches an over-payment whose excess simply disappears", async () => {
    // The customer's 500 is the dealership's liability, not its income. A
    // backend that keeps the change balances perfectly and is stealing.
    const results = await runAgainst({ swallowOverpayment: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RC1")?.detail)).toMatch(/unaccounted for/);
  });

  test("RC1 catches a retained credit that is applied but never reduced", async () => {
    // Worse than a refusal: the invoice is settled from a liability that still
    // reads as owed, so the same 400 can be spent again.
    const results = await runAgainst({ ignoreRetainedApplication: true });
    expect(statusOf(results, "RC1")).toBe("FAIL");
  });

  test("RV1 catches a cheque return that ERASES its clearing", async () => {
    // Balances perfectly and destroys the history. ACC-3: a reversal ADDS.
    const results = await runAgainst({ eraseOnChequeReturn: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
  });

  test("RV1 catches a cheque that bounces with no accounting effect at all", async () => {
    const results = await runAgainst({ silentChequeReturn: true });
    expect(statusOf(results, "RV1")).toBe("FAIL");
    expect(String(results.find((r) => r.id === "RV1")?.detail)).toMatch(/NO journal entry/);
  });

  test("a defect in one case does not silently take the others down with it", async () => {
    // Each case builds its own fixture, so an unrelated red must stay local —
    // otherwise one failure would mask the true state of everything after it.
    const results = await runAgainst({ noUnappliedLiability: true });
    expect(statusOf(results, "D1")).toBe("PASS");
    expect(statusOf(results, "C1")).toBe("PASS");
  });
});
