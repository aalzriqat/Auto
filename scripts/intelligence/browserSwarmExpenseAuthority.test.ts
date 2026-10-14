import { describe, expect, it } from "vitest";
import { BrowserSwarmOracleInconclusiveError } from "./browserSwarmEconomicOracle";
import {
  EXPENSE_AUTHORITY_PAGE_SIZE,
  EXPENSE_AUTHORITY_ROW_LIMIT,
  readExpenseEffectSnapshot,
  type ExpenseAuthorityRefs,
} from "./browserSwarmExpenseAuthority";

const refs: ExpenseAuthorityRefs = {
  listExpenses: "listExpenses",
  listAccountingEvents: "listAccountingEvents",
  listPendingOutbox: "listPendingOutbox",
  getJournalEntry: "getJournalEntry",
};

type Call = { ref: unknown; args: Record<string, unknown> };

function fakeClient(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      async query(ref: unknown, args: Record<string, unknown>) {
        calls.push({ ref, args });
        const handler = handlers[String(ref)];
        if (!handler) throw new Error("unexpected query " + String(ref));
        return handler(args);
      },
    },
  };
}

const TITLE = "swarm-title";

function defaultHandlers(overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  return {
    listExpenses: (args: Record<string, unknown>) => {
      const cursor = (args.paginationOpts as { cursor: string | null }).cursor;
      if (cursor === null) {
        return {
          page: [
            { _id: "exp1", title: TITLE, amount: 41, status: "PAID" },
            { _id: "noise", title: "other", amount: 1, status: "PAID" },
          ],
          isDone: false,
          continueCursor: "c2",
        };
      }
      return {
        page: [{ _id: "exp2", title: TITLE, amount: 41, status: "PAID" }],
        isDone: true,
        continueCursor: "",
      };
    },
    listAccountingEvents: (args: Record<string, unknown>) => [
      {
        _id: "ev-" + String(args.sourceId),
        sourceId: args.sourceId,
        eventType: "EXPENSE_POSTED",
        status: "POSTED",
        idempotencyKey: "expense_posted_" + String(args.sourceId),
        journalEntryId: "je-" + String(args.sourceId),
      },
    ],
    listPendingOutbox: (args: Record<string, unknown>) =>
      args.status === "PENDING"
        ? [
            {
              _id: "q1",
              kind: "POST",
              status: "PENDING",
              idempotencyKey: "expense_posted_exp1",
              payload: { amountMinor: 41_000, currency: "JOD" },
            },
            { _id: "q2", kind: "POST", status: "PENDING", idempotencyKey: "expense_posted_unrelated" },
          ]
        : [],
    getJournalEntry: (args: Record<string, unknown>) => ({
      entry: { _id: args.journalEntryId },
      lines: [
        { debitMinor: 41_000, creditMinor: 0, scale: 3, currency: "JOD" },
        { debitMinor: 0, creditMinor: 41_000, scale: 3, currency: "JOD" },
      ],
    }),
    ...overrides,
  };
}

describe("SCRUM-826 expense backend authority reader", () => {
  it("pages the complete expense list and reads every posting surface for each match", async () => {
    const { client, calls } = fakeClient(defaultHandlers());
    const snapshot = await readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs });

    expect(snapshot.expenses.map((row) => row.id)).toEqual(["exp1", "exp2"]);
    expect(snapshot.events.map((row) => row.id)).toEqual(["ev-exp1", "ev-exp2"]);
    expect(snapshot.openOutbox.map((row) => row.id)).toEqual(["q1"]);
    expect(snapshot.journals.map((row) => row.entryId)).toEqual(["je-exp1", "je-exp2"]);

    const pageSizes = calls
      .filter((call) => call.ref === "listExpenses")
      .map((call) => (call.args.paginationOpts as { numItems: number }).numItems);
    expect(pageSizes).toEqual([EXPENSE_AUTHORITY_PAGE_SIZE, EXPENSE_AUTHORITY_PAGE_SIZE]);
    expect(
      calls
        .filter((call) => call.ref === "listPendingOutbox")
        .map((call) => call.args.status)
        .sort(),
    ).toEqual(["FAILED", "PENDING"]);
  });

  it("is inconclusive when the outbox read could have been truncated", async () => {
    const { client } = fakeClient(
      defaultHandlers({
        listPendingOutbox: () =>
          Array.from({ length: EXPENSE_AUTHORITY_ROW_LIMIT }, (_, index) => ({
            _id: "q" + index,
            kind: "POST",
            status: "PENDING",
            idempotencyKey: "k" + index,
          })),
      }),
    );
    await expect(
      readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs }),
    ).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("is inconclusive when the event read for one expense could have been truncated", async () => {
    const { client } = fakeClient(
      defaultHandlers({
        listAccountingEvents: () =>
          Array.from({ length: EXPENSE_AUTHORITY_ROW_LIMIT }, (_, index) => ({
            _id: "e" + index,
            eventType: "EXPENSE_POSTED",
            status: "POSTED",
            idempotencyKey: "x",
          })),
      }),
    );
    await expect(
      readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs }),
    ).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("is inconclusive when the expense list never terminates", async () => {
    const { client } = fakeClient(
      defaultHandlers({
        listExpenses: () => ({ page: [], isDone: false, continueCursor: "again" }),
      }),
    );
    await expect(
      readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs }),
    ).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("is inconclusive when a backend response has the wrong shape", async () => {
    const { client } = fakeClient(defaultHandlers({ listExpenses: () => null }));
    await expect(
      readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs }),
    ).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("carries each journal line's own currency so its scale can be vouched (SCRUM-826 F1)", async () => {
    const { client } = fakeClient(defaultHandlers());
    const snapshot = await readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs });
    expect(snapshot.journals[0].lines.map((line) => line.currency)).toEqual(["JOD", "JOD"]);
  });

  it("is inconclusive when a journal line carries no currency (SCRUM-826 F1)", async () => {
    const { client } = fakeClient(
      defaultHandlers({
        getJournalEntry: (args: Record<string, unknown>) => ({
          entry: { _id: args.journalEntryId },
          lines: [
            { debitMinor: 41_000, creditMinor: 0, scale: 3 },
            { debitMinor: 0, creditMinor: 41_000, scale: 3 },
          ],
        }),
      }),
    );
    await expect(
      readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs }),
    ).rejects.toBeInstanceOf(BrowserSwarmOracleInconclusiveError);
  });

  it("keeps a posted event without a journal visible to the oracle instead of dropping it", async () => {
    const { client } = fakeClient(defaultHandlers({ getJournalEntry: () => null }));
    const snapshot = await readExpenseEffectSnapshot(client, { orgId: "org1", title: TITLE, refs });
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.journals).toEqual([]);
  });
});
