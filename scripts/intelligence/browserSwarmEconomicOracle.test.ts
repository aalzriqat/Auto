import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import {
  BrowserSwarmOracleInconclusiveError,
  classifyIntentExercise,
  classifyServerReplayFailure,
  evaluateCommandIdentityLifetime,
  evaluateConcurrentEditRace,
  evaluateExpenseSingleEffect,
  evaluateIntentReplies,
  isAuthenticationLapse,
  VerdictLedger,
  type ExpenseEffectSnapshot,
} from "./browserSwarmEconomicOracle";
import { MULTI_TAB_RACE_AMOUNTS } from "./browserSwarmEconomicAttacks";

const TITLE = "swarm-gh-1-1-worker-1-dup-a";

function posted(overrides: Partial<ExpenseEffectSnapshot> = {}): ExpenseEffectSnapshot {
  return {
    title: TITLE,
    expenses: [{ id: "exp1", title: TITLE, amount: 41, status: "PAID" }],
    events: [
      {
        id: "ev1",
        sourceId: "exp1",
        eventType: "EXPENSE_POSTED",
        status: "POSTED",
        idempotencyKey: "expense_posted_exp1",
        journalEntryId: "je1",
      },
    ],
    openOutbox: [],
    journals: [
      {
        entryId: "je1",
        lines: [
          { debitMinor: 41_000, creditMinor: 0, scale: 3, currency: "JOD" },
          { debitMinor: 0, creditMinor: 41_000, scale: 3, currency: "JOD" },
        ],
      },
    ],
    ...overrides,
  };
}

function queued(overrides: Partial<ExpenseEffectSnapshot> = {}): ExpenseEffectSnapshot {
  return posted({
    events: [],
    journals: [],
    openOutbox: [
      {
        id: "q1",
        kind: "POST",
        status: "PENDING",
        idempotencyKey: "expense_posted_exp1",
        payload: { amountMinor: 41_000, currency: "JOD" },
      },
    ],
    ...overrides,
  });
}

const expected = { amount: 41, status: "PAID" as const };

/** Both saves were transmitted before either response arrived: a real overlap. */
const OVERLAPPED = [
  { tab: "A", sentSeq: 1, responseSeq: 3 },
  { tab: "B", sentSeq: 2, responseSeq: 4 },
];

describe("SCRUM-826 single-economic-effect oracle", () => {
  it("passes exactly one expense with exactly one balanced posting of the authoritative amount", () => {
    const verdict = evaluateExpenseSingleEffect(posted(), expected);
    expect(verdict).toMatchObject({
      passed: true,
      violations: [],
      expenseId: "exp1",
      postingMode: "POSTED",
      ledgerAmountMinor: 41_000,
    });
  });

  it("passes exactly one durably queued posting when the books have no open period", () => {
    const verdict = evaluateExpenseSingleEffect(queued(), expected);
    expect(verdict).toMatchObject({ passed: true, postingMode: "QUEUED", ledgerAmountMinor: 41_000 });
  });

  it("flags a duplicated operational record as a breach", () => {
    const verdict = evaluateExpenseSingleEffect(
      posted({
        expenses: [
          { id: "exp1", title: TITLE, amount: 41, status: "PAID" },
          { id: "exp2", title: TITLE, amount: 41, status: "PAID" },
        ],
      }),
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/2 expense records/);
  });

  it("flags a lost intent (zero records) as a breach", () => {
    const verdict = evaluateExpenseSingleEffect(posted({ expenses: [], events: [], journals: [] }), expected);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/0 expense records/);
  });

  it("flags a second posted economic event for the same expense", () => {
    const snapshot = posted();
    const verdict = evaluateExpenseSingleEffect(
      {
        ...snapshot,
        events: [
          ...snapshot.events,
          { ...snapshot.events[0], id: "ev2", journalEntryId: "je2" },
        ],
        journals: [...snapshot.journals, { ...snapshot.journals[0], entryId: "je2" }],
      },
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/2 economic postings/);
  });

  it("flags a posted event that also still has an open queued post", () => {
    const verdict = evaluateExpenseSingleEffect(
      posted({ openOutbox: queued().openOutbox }),
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/2 economic postings/);
  });

  it("flags an expense marked paid with no economic posting at all", () => {
    const verdict = evaluateExpenseSingleEffect(posted({ events: [], journals: [] }), expected);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/0 economic postings/);
  });

  it("flags a journal whose amount disagrees with the authoritative expense", () => {
    const verdict = evaluateExpenseSingleEffect(
      posted({
        journals: [
          {
            entryId: "je1",
            lines: [
              { debitMinor: 71_000, creditMinor: 0, scale: 3, currency: "JOD" },
              { debitMinor: 0, creditMinor: 71_000, scale: 3, currency: "JOD" },
            ],
          },
        ],
      }),
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/ledger amount 71000.*41000/);
  });

  it("flags an unbalanced journal", () => {
    const verdict = evaluateExpenseSingleEffect(
      posted({
        journals: [
          {
            entryId: "je1",
            lines: [
              { debitMinor: 41_000, creditMinor: 0, scale: 3, currency: "JOD" },
              { debitMinor: 0, creditMinor: 40_000, scale: 3, currency: "JOD" },
            ],
          },
        ],
      }),
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/unbalanced/);
  });

  it("flags a queued posting whose amount disagrees with the expense", () => {
    const verdict = evaluateExpenseSingleEffect(
      queued({
        openOutbox: [
          {
            id: "q1",
            kind: "POST",
            status: "PENDING",
            idempotencyKey: "expense_posted_exp1",
            payload: { amountMinor: 71_000, currency: "JOD" },
          },
        ],
      }),
      expected,
    );
    expect(verdict.passed).toBe(false);
  });

  it("flags a dead-lettered posting as a money-path failure, not a pass", () => {
    const verdict = evaluateExpenseSingleEffect(
      queued({
        openOutbox: [
          {
            id: "q1",
            kind: "POST",
            status: "FAILED",
            idempotencyKey: "expense_posted_exp1",
            payload: { amountMinor: 41_000, currency: "JOD" },
          },
        ],
      }),
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/FAILED/);
  });

  it("flags the wrong authoritative amount or status", () => {
    expect(
      evaluateExpenseSingleEffect(
        posted({ expenses: [{ id: "exp1", title: TITLE, amount: 42, status: "PAID" }] }),
        expected,
      ).passed,
    ).toBe(false);
    expect(
      evaluateExpenseSingleEffect(
        posted({ expenses: [{ id: "exp1", title: TITLE, amount: 41, status: "PENDING" }] }),
        expected,
      ).passed,
    ).toBe(false);
  });

  it("is inconclusive, never a pass, when a posted event's journal could not be read", () => {
    expect(() => evaluateExpenseSingleEffect(posted({ journals: [] }), expected)).toThrow(
      BrowserSwarmOracleInconclusiveError,
    );
  });

  function postedWithLines(
    lines: { debitMinor: number; creditMinor: number; scale: number; currency: string }[],
  ): ExpenseEffectSnapshot {
    return posted({ journals: [{ entryId: "je1", lines }] });
  }

  it("flags a balanced journal posted at the wrong minor-unit scale for its currency (SCRUM-826 F1)", () => {
    // 41 JOD is 41,000 fils (scale 3). A journal claiming scale 0 for JOD
    // agrees with itself but is ledger money at the wrong denomination.
    const verdict = evaluateExpenseSingleEffect(
      postedWithLines([
        { debitMinor: 41, creditMinor: 0, scale: 0, currency: "JOD" },
        { debitMinor: 0, creditMinor: 41, scale: 0, currency: "JOD" },
      ]),
      expected,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/scale 0.*JOD.*3/);
  });

  it("passes a correctly scaled posting in another canonical currency (positive control)", () => {
    const verdict = evaluateExpenseSingleEffect(
      postedWithLines([
        { debitMinor: 4_100, creditMinor: 0, scale: 2, currency: "USD" },
        { debitMinor: 0, creditMinor: 4_100, scale: 2, currency: "USD" },
      ]),
      expected,
    );
    expect(verdict).toMatchObject({ passed: true, ledgerAmountMinor: 4_100 });
  });

  it("is inconclusive when a journal mixes currencies", () => {
    expect(() =>
      evaluateExpenseSingleEffect(
        postedWithLines([
          { debitMinor: 41_000, creditMinor: 0, scale: 3, currency: "JOD" },
          { debitMinor: 0, creditMinor: 41_000, scale: 3, currency: "KWD" },
        ]),
        expected,
      ),
    ).toThrow(BrowserSwarmOracleInconclusiveError);
  });

  it("is inconclusive when a journal line's currency is not canonical", () => {
    expect(() =>
      evaluateExpenseSingleEffect(
        postedWithLines([
          { debitMinor: 41_000, creditMinor: 0, scale: 3, currency: "jod" },
          { debitMinor: 0, creditMinor: 41_000, scale: 3, currency: "jod" },
        ]),
        expected,
      ),
    ).toThrow(BrowserSwarmOracleInconclusiveError);
  });

  it("is inconclusive when the queued currency has no vouched scale", () => {
    expect(() =>
      evaluateExpenseSingleEffect(
        queued({
          openOutbox: [
            {
              id: "q1",
              kind: "POST",
              status: "PENDING",
              idempotencyKey: "expense_posted_exp1",
              payload: { amountMinor: 41_000, currency: "JD" },
            },
          ],
        }),
        expected,
      ),
    ).toThrow(BrowserSwarmOracleInconclusiveError);
  });

  it("ignores rows that belong to other titles and other expenses", () => {
    const base = posted();
    const verdict = evaluateExpenseSingleEffect(
      {
        ...base,
        expenses: [...base.expenses, { id: "other", title: TITLE + "-x", amount: 41, status: "PAID" }],
        openOutbox: [
          {
            id: "q9",
            kind: "POST",
            status: "PENDING",
            idempotencyKey: "expense_posted_other",
            payload: { amountMinor: 41_000, currency: "JOD" },
          },
        ],
      },
      expected,
    );
    expect(verdict.passed).toBe(true);
  });
});

describe("SCRUM-826 client command identity lifetime oracle (ECON-2)", () => {
  it("passes when every attempt of one intent carried one identity", () => {
    expect(evaluateCommandIdentityLifetime(["k1", "k1", "k1"])).toEqual({
      passed: true,
      violations: [],
      key: "k1",
    });
  });

  it("flags per-attempt identity minting as a breach", () => {
    const verdict = evaluateCommandIdentityLifetime(["k1", "k2"]);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/2 distinct command identities/);
  });

  it("flags an attempt sent without an identity", () => {
    const verdict = evaluateCommandIdentityLifetime(["k1", undefined]);
    expect(verdict.passed).toBe(false);
  });

  it("is inconclusive when no attempt was observed at all", () => {
    expect(() => evaluateCommandIdentityLifetime([])).toThrow(
      BrowserSwarmOracleInconclusiveError,
    );
  });
});

describe("SCRUM-826 concurrent-tab edit race oracle (CONC-1 / ECON-2)", () => {
  const LOCKED =
    "Posted expenses are locked. Use a correction or reversal workflow before changing accounting fields.";

  it("is inconclusive, never a pass, when the two saves never overlapped (SCRUM-826 F2)", () => {
    // A sent, committed and heard back before B ever sent: a sequential edit,
    // not a race. Identical outcomes to the positive case — only the ordering
    // evidence distinguishes them.
    expect(() =>
      evaluateConcurrentEditRace({
        ordering: [
          { tab: "A", sentSeq: 1, responseSeq: 2 },
          { tab: "B", sentSeq: 3, responseSeq: 4 },
        ],
        tabs: [
          { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
          { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
        ],
        authoritative: { amount: 50, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      }),
    ).toThrow(/did not overlap/);
  });

  it("is inconclusive when a tab's send or response was not ordered", () => {
    expect(() =>
      evaluateConcurrentEditRace({
        ordering: [{ tab: "A", sentSeq: 1, responseSeq: 3 }],
        tabs: [
          { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
          { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
        ],
        authoritative: { amount: 50, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      }),
    ).toThrow(BrowserSwarmOracleInconclusiveError);
  });

  it("passes when exactly one tab won, the other was refused by the posting lock, and the backend holds the winner", () => {
    expect(
      evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
        tabs: [
          { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
          { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
        ],
        authoritative: { amount: 50, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      }),
    ).toEqual({ passed: true, violations: [], winner: "A", winningAmount: 50 });
  });

  // CodeRabbit on PR #566: with the handler's real amounts, a winner whose
  // amount write the backend dropped (status moved, amount still the setup
  // value) must be a breach, whichever tab wins.
  for (const winner of ["A", "B"] as const) {
    it(`the MULTI_TAB_RACE plan detects tab ${winner}'s dropped amount write`, () => {
      const { setup, A, B } = MULTI_TAB_RACE_AMOUNTS;
      const verdict = evaluateConcurrentEditRace({
        ordering: OVERLAPPED,
        tabs: [
          winner === "A"
            ? { tab: "A", intendedAmount: A, outcome: "SUCCESS" }
            : { tab: "A", intendedAmount: A, outcome: "REFUSED", message: LOCKED },
          winner === "B"
            ? { tab: "B", intendedAmount: B, outcome: "SUCCESS" }
            : { tab: "B", intendedAmount: B, outcome: "REFUSED", message: LOCKED },
        ],
        authoritative: { amount: setup, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      });
      expect(verdict.passed).toBe(false);
    });
  }

  it("flags two tabs both reporting success as a lost update", () => {
    const verdict = evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
      tabs: [
        { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
        { tab: "B", intendedAmount: 80, outcome: "SUCCESS" },
      ],
      authoritative: { amount: 80, status: "PAID" },
      staleRetry: { outcome: "REFUSED", message: LOCKED },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/2 tabs reported success/);
  });

  it("flags a backend that holds a value no successful tab asked for", () => {
    const verdict = evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
      tabs: [
        { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
        { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
      ],
      authoritative: { amount: 80, status: "PAID" },
      staleRetry: { outcome: "REFUSED", message: LOCKED },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/backend holds 80/);
  });

  it("flags a stale retry from the losing tab that the backend accepted", () => {
    const verdict = evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
      tabs: [
        { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
        { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
      ],
      authoritative: { amount: 50, status: "PAID" },
      staleRetry: { outcome: "SUCCESS" },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/stale retry/);
  });

  it("flags a backend left unpaid after a tab reported a successful payment", () => {
    const verdict = evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
      tabs: [
        { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
        { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
      ],
      authoritative: { amount: 50, status: "PENDING" },
      staleRetry: { outcome: "REFUSED", message: LOCKED },
    });
    expect(verdict.passed).toBe(false);
  });

  it("is inconclusive when a tab's outcome was never observed", () => {
    expect(() =>
      evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
        tabs: [
          { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
          { tab: "B", intendedAmount: 80, outcome: "UNKNOWN" },
        ],
        authoritative: { amount: 50, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      }),
    ).toThrow(BrowserSwarmOracleInconclusiveError);
  });

  it("is inconclusive, not a pass, when the loser was refused for an environmental reason", () => {
    expect(() =>
      evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
        tabs: [
          { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
          {
            tab: "B",
            intendedAmount: 80,
            outcome: "REFUSED",
            message: "Rate limit exceeded. Try again in 3s",
          },
        ],
        authoritative: { amount: 50, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      }),
    ).toThrow(BrowserSwarmOracleInconclusiveError);
  });

  it("flags no tab succeeding as a dead-ended workflow", () => {
    const verdict = evaluateConcurrentEditRace({
      ordering: OVERLAPPED,
      tabs: [
        { tab: "A", intendedAmount: 50, outcome: "REFUSED", message: LOCKED },
        { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
      ],
      authoritative: { amount: 50, status: "PENDING" },
      staleRetry: { outcome: "REFUSED", message: LOCKED },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/0 tabs reported success/);
  });
});

describe("SCRUM-826 O1/O2 — client-visible replies to one intent", () => {
  const ok = (requestId: number) => ({ requestId, success: true, withheld: false });

  it("passes when every client-visible reply to the intent succeeded", () => {
    const verdict = evaluateIntentReplies("i-1", [ok(1), ok(2), ok(3)]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.refused).toBe(0);
  });

  it("names a fingerprint refusal of a same-intent retry as an ECON-2 breach", () => {
    const verdict = evaluateIntentReplies("i-1", [
      ok(1),
      {
        requestId: 2,
        success: false,
        withheld: false,
        errorText: "Idempotency key reused with different request content",
      },
    ]);
    expect(verdict.refused).toBe(1);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toMatch(/i-1.*attempt 2.*fingerprint/);
  });

  it("counts any other refusal of a same-intent attempt as a breach too", () => {
    const verdict = evaluateIntentReplies("i-1", [
      { requestId: 4, success: false, withheld: false, errorText: "boom" },
    ]);
    expect(verdict.refused).toBe(1);
    expect(verdict.violations[0]).toMatch(/attempt 4 was refused.*boom/);
  });

  it("never counts the reply the harness withheld as client-visible", () => {
    const verdict = evaluateIntentReplies("i-1", [
      { requestId: 5, success: false, withheld: true, errorText: "x" },
      ok(5),
    ]);
    expect(verdict.violations).toEqual([]);
    expect(verdict.refused).toBe(0);
  });

  it("classifies a confirmed or duplicated intent as exercised", () => {
    expect(
      classifyIntentExercise({ uiConfirmed: true, backendRecords: 1, refusedReplies: 0 }),
    ).toBe("EXERCISED");
    expect(
      classifyIntentExercise({ uiConfirmed: false, backendRecords: 2, refusedReplies: 0 }),
    ).toBe("EXERCISED");
  });

  it("classifies an unconfirmed intent the backend refused as a product refusal, not a harness error", () => {
    expect(
      classifyIntentExercise({ uiConfirmed: false, backendRecords: 1, refusedReplies: 1 }),
    ).toBe("PRODUCT_REFUSED");
    expect(
      classifyIntentExercise({ uiConfirmed: false, backendRecords: 0, refusedReplies: 2 }),
    ).toBe("PRODUCT_REFUSED");
  });

  it("treats a backend ConvexError on a server replay as a product refusal", () => {
    const refusal = new ConvexError("Idempotency key reused with different request content");
    expect(classifyServerReplayFailure(refusal)).toBe("BACKEND_REFUSED");
  });

  it("keeps a transport or unidentified failure on a server replay inconclusive", () => {
    expect(classifyServerReplayFailure(new TypeError("fetch failed"))).toBe("UNIDENTIFIED");
    expect(classifyServerReplayFailure(new Error("502 Bad Gateway"))).toBe("UNIDENTIFIED");
    expect(classifyServerReplayFailure("boom")).toBe("UNIDENTIFIED");
  });

  it("decides a ledger by proof first, unjudged second, independent of order (S1)", () => {
    const orders: Array<Array<(ledger: VerdictLedger) => void>> = [
      [(l) => l.prove("p"), (l) => l.unjudgeable("u")],
      [(l) => l.unjudgeable("u"), (l) => l.prove("p")],
    ];
    for (const order of orders) {
      const ledger = new VerdictLedger();
      for (const step of order) step(ledger);
      expect(ledger.decide()).toEqual({ kind: "BREACH", violations: ["p"], unjudged: ["u"] });
    }
    const unjudgedOnly = new VerdictLedger();
    unjudgedOnly.unjudgeable("a");
    unjudgedOnly.unjudgeable("b");
    expect(unjudgedOnly.decide()).toEqual({ kind: "INCONCLUSIVE", reason: "a; b", unjudged: ["a", "b"] });
    expect(new VerdictLedger().decide()).toEqual({ kind: "PASS" });
    const deduped = new VerdictLedger();
    deduped.prove("x", "x");
    deduped.prove("x");
    expect(deduped.proven).toEqual(["x"]);
  });

  it("keeps a lapsed harness session on a server replay inconclusive, never a product refusal (P2)", () => {
    const lapse = new ConvexError({ code: "UNAUTHENTICATED", message: "Not authenticated" });
    expect(classifyServerReplayFailure(lapse)).toBe("UNIDENTIFIED");
    expect(isAuthenticationLapse(lapse)).toBe(true);
    // The same principal just acted: an authorization refusal stays a product verdict.
    const denied = new ConvexError({ code: "UNAUTHORIZED", message: "Not allowed" });
    expect(classifyServerReplayFailure(denied)).toBe("BACKEND_REFUSED");
    expect(isAuthenticationLapse(denied)).toBe(false);
    expect(isAuthenticationLapse(new Error("UNAUTHENTICATED"))).toBe(false);
  });

  it("does not judge a socket reply refused for a lapsed session as a product refusal (P2)", () => {
    const verdict = evaluateIntentReplies("t", [
      {
        requestId: 9,
        success: false,
        withheld: false,
        errorText: 'Server Error | {"code":"UNAUTHENTICATED","message":"Not authenticated"}',
      },
      {
        requestId: 10,
        success: false,
        withheld: false,
        errorText: 'Server Error | {"code":"UNAUTHORIZED","message":"Not allowed"}',
      },
    ]);
    expect(verdict.authenticationLapses).toBe(1);
    expect(verdict.refused).toBe(1);
    expect(verdict.violations).toEqual([
      't: attempt 10 was refused: Server Error | {"code":"UNAUTHORIZED","message":"Not allowed"}',
    ]);
  });

  it("keeps an unconfirmed intent with no refusal reply as not exercised", () => {
    expect(
      classifyIntentExercise({ uiConfirmed: false, backendRecords: 1, refusedReplies: 0 }),
    ).toBe("NOT_EXERCISED");
    expect(
      classifyIntentExercise({ uiConfirmed: false, backendRecords: 0, refusedReplies: 0 }),
    ).toBe("NOT_EXERCISED");
  });
});
