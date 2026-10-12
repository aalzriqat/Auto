import { describe, expect, it } from "vitest";
import {
  BrowserSwarmOracleInconclusiveError,
  evaluateCommandIdentityLifetime,
  evaluateConcurrentEditRace,
  evaluateExpenseSingleEffect,
  type ExpenseEffectSnapshot,
} from "./browserSwarmEconomicOracle";

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
          { debitMinor: 41_000, creditMinor: 0, scale: 3 },
          { debitMinor: 0, creditMinor: 41_000, scale: 3 },
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
              { debitMinor: 71_000, creditMinor: 0, scale: 3 },
              { debitMinor: 0, creditMinor: 71_000, scale: 3 },
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
              { debitMinor: 41_000, creditMinor: 0, scale: 3 },
              { debitMinor: 0, creditMinor: 40_000, scale: 3 },
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

  it("passes when exactly one tab won, the other was refused by the posting lock, and the backend holds the winner", () => {
    expect(
      evaluateConcurrentEditRace({
        tabs: [
          { tab: "A", intendedAmount: 50, outcome: "SUCCESS" },
          { tab: "B", intendedAmount: 80, outcome: "REFUSED", message: LOCKED },
        ],
        authoritative: { amount: 50, status: "PAID" },
        staleRetry: { outcome: "REFUSED", message: LOCKED },
      }),
    ).toEqual({ passed: true, violations: [], winner: "A", winningAmount: 50 });
  });

  it("flags two tabs both reporting success as a lost update", () => {
    const verdict = evaluateConcurrentEditRace({
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
