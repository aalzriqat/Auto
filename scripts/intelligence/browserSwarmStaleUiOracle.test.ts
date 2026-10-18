import { describe, expect, it } from "vitest";
import type { LedgerEvent, LedgerLine, LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import { evaluateStaleReversal, type StaleReversalObservation } from "./browserSwarmStaleUiOracle";

const line = (accountId: string, debitMinor: number, creditMinor: number): LedgerLine => ({
  accountId,
  debitMinor,
  creditMinor,
  scale: 3,
  currency: "JOD",
});

const event = (overrides: Partial<LedgerEvent> & Pick<LedgerEvent, "id" | "eventType">): LedgerEvent => ({
  status: "POSTED",
  reversalOfEventId: null,
  reversedByEventId: null,
  journalEntryId: null,
  ...overrides,
});

const ORIGINAL_LINES = [line("expense", 53_000, 0), line("cash", 0, 53_000)];
const MIRROR_LINES = [line("expense", 0, 53_000), line("cash", 53_000, 0)];

const POSTED: LedgerSnapshot = {
  events: [event({ id: "e1", eventType: "EXPENSE_POSTED", journalEntryId: "j1" })],
  journals: { j1: ORIGINAL_LINES },
};

const REVERSED: LedgerSnapshot = {
  events: [
    event({ id: "e1", eventType: "EXPENSE_POSTED", status: "REVERSED", reversedByEventId: "e2", journalEntryId: "j1" }),
    event({ id: "e2", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j2" }),
  ],
  journals: { j1: ORIGINAL_LINES, j2: MIRROR_LINES },
};

/** A correct product: the stale request is refused and the ledger does not move. */
function clean(overrides: Partial<StaleReversalObservation> = {}): StaleReversalObservation {
  return {
    actionArmedBeforeChange: true,
    actionAfterChange: "OFFERED",
    screenAnswer: "REFUSAL_TOAST",
    posted: POSTED,
    reversed: REVERSED,
    afterStale: REVERSED,
    seededAmount: 53,
    expectedCurrency: "JOD",
    ...overrides,
  };
}

describe("SCRUM-350 STALE_UI oracle (stale posted-expense reversal)", () => {
  it("is clean only when the ledger held and the screen refused", () => {
    expect(evaluateStaleReversal(clean())).toEqual({ violations: [], unjudged: [] });
  });

  describe("breaches", () => {
    it("flags a stale screen that announces a reversal the backend had already made", () => {
      const verdict = evaluateStaleReversal(clean({ screenAnswer: "SUCCESS_TOAST" }));
      expect(verdict.violations).toEqual([expect.stringMatching(/announced a reversal although the expense had already been reversed/)]);
      expect(verdict.unjudged).toEqual([]);
    });

    it("flags a second reversal event created by the stale request", () => {
      const second: LedgerSnapshot = {
        events: [
          ...REVERSED.events,
          event({ id: "e3", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j3" }),
        ],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const verdict = evaluateStaleReversal(clean({ afterStale: second }));
      expect(verdict.violations).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/2 reversal events/),
          expect.stringMatching(/ledger across the stale reversal request changed/),
        ]),
      );
    });

    it("flags an unlinked extra reversal", () => {
      const stray: LedgerSnapshot = {
        events: [...REVERSED.events, event({ id: "e3", eventType: "JOURNAL_REVERSAL", journalEntryId: "j3" })],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const verdict = evaluateStaleReversal(clean({ afterStale: stray }));
      expect(verdict.violations).toEqual(expect.arrayContaining([expect.stringMatching(/not linked to the posted event/)]));
    });

    it("flags a ledger change that is not a new event, as a change by the stale request", () => {
      const rewritten: LedgerSnapshot = {
        events: REVERSED.events,
        journals: { ...REVERSED.journals, j1: [line("expense", 99_000, 0), line("cash", 0, 99_000)] },
      };
      const verdict = evaluateStaleReversal(clean({ afterStale: rewritten }));
      expect(verdict.violations).toEqual(expect.arrayContaining([expect.stringMatching(/rewritten instead of reversed/)]));
      expect(verdict.violations).toEqual(
        expect.arrayContaining([expect.stringMatching(/ledger across the stale reversal request changed/)]),
      );
    });

    it("flags a reversal that does not mirror the original", () => {
      const lopsided: LedgerSnapshot = {
        events: REVERSED.events,
        journals: { j1: ORIGINAL_LINES, j2: [line("expense", 0, 10_000), line("cash", 10_000, 0)] },
      };
      const verdict = evaluateStaleReversal(clean({ reversed: lopsided, afterStale: lopsided }));
      expect(verdict.violations).toEqual([expect.stringMatching(/does not mirror/)]);
    });

    it("reports a ledger breach and a lying screen together", () => {
      const second: LedgerSnapshot = {
        events: [
          ...REVERSED.events,
          event({ id: "e3", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j3" }),
        ],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const verdict = evaluateStaleReversal(clean({ afterStale: second, screenAnswer: "SUCCESS_TOAST" }));
      expect(verdict.violations.length).toBeGreaterThanOrEqual(3);
      expect(verdict.violations).toEqual(expect.arrayContaining([expect.stringMatching(/announced a reversal/)]));
    });

    it("still judges the ledger when the screen answer is missing", () => {
      const second: LedgerSnapshot = {
        events: [
          ...REVERSED.events,
          event({ id: "e3", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j3" }),
        ],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const verdict = evaluateStaleReversal(clean({ afterStale: second, screenAnswer: "SILENT" }));
      expect(verdict.violations.length).toBeGreaterThan(0);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/gave no answer/)]);
    });
  });

  describe("fail closed: nothing unestablished is clean", () => {
    it("judges nothing when the action was not armed before the change", () => {
      const verdict = evaluateStaleReversal(clean({ actionArmedBeforeChange: false, screenAnswer: "SUCCESS_TOAST" }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/no armed stale action/)]);
    });

    it.each([
      ["no reversal event at all", { events: POSTED.events, journals: POSTED.journals }],
      [
        "a reversal that is not linked",
        {
          events: [...POSTED.events, event({ id: "e2", eventType: "JOURNAL_REVERSAL", journalEntryId: "j2" })],
          journals: REVERSED.journals,
        },
      ],
      [
        "a reversal that is not posted",
        {
          events: [
            ...POSTED.events,
            event({ id: "e2", eventType: "JOURNAL_REVERSAL", status: "PENDING", reversalOfEventId: "e1", journalEntryId: "j2" }),
          ],
          journals: REVERSED.journals,
        },
      ],
    ] as const)("judges nothing when the server-side reversal left %s", (_name, reversed) => {
      const verdict = evaluateStaleReversal(clean({ reversed, screenAnswer: "SUCCESS_TOAST" }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/screen was not stale/)]);
    });

    it("reports both unestablished premises", () => {
      const verdict = evaluateStaleReversal(clean({ actionArmedBeforeChange: false, reversed: POSTED }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toHaveLength(2);
    });

    it("is unjudged, not clean, when the screen withdrew the action itself", () => {
      const verdict = evaluateStaleReversal(clean({ actionAfterChange: "WITHDRAWN", screenAnswer: null }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/withdrew the reversal action/)]);
    });

    it.each([
      ["a silent screen", "SILENT", /gave no answer/],
      ["a message that is not the product's refusal", "UNCLASSIFIED_TOAST", /not the product's "Expense not found" refusal/],
      ["no screen answer at all", null, /gave no answer/],
    ] as const)("is unjudged for %s", (_name, screenAnswer, pattern) => {
      const verdict = evaluateStaleReversal(clean({ screenAnswer }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(pattern)]);
    });

    it("is unjudged when the organization's currency was not readable", () => {
      const verdict = evaluateStaleReversal(clean({ expectedCurrency: null }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/currency was not readable/)]);
    });

    it("is unjudged when the original posting was never in the ledger", () => {
      const verdict = evaluateStaleReversal(clean({ posted: { events: [], journals: {} } }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/never posted to the ledger/)]);
    });
  });
});
