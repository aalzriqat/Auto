import { describe, expect, it } from "vitest";
import type { LedgerEvent, LedgerLine, LedgerSnapshot } from "./browserSwarmBoundaryOracle";
import {
  evaluateNavigationRace,
  raceOutcome,
  type NavigationRaceObservation,
} from "./browserSwarmNavigationRaceOracle";

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

const ORIGINAL_LINES = [line("expense", 59_000, 0), line("cash", 0, 59_000)];
const MIRROR_LINES = [line("expense", 0, 59_000), line("cash", 59_000, 0)];

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

const SENTINEL: LedgerSnapshot = {
  events: [event({ id: "s1", eventType: "EXPENSE_POSTED", journalEntryId: "sj1" })],
  journals: { sj1: [line("expense", 61_000, 0), line("cash", 0, 61_000)] },
};

/** The request landed before the page went: one reversal, and the screen no longer lists the expense. */
function applied(overrides: Partial<NavigationRaceObservation> = {}): NavigationRaceObservation {
  return {
    clickIssued: true,
    leftScreen: true,
    returned: true,
    posted: POSTED,
    afterRace: REVERSED,
    final: REVERSED,
    screenRow: "NOT_LISTED",
    repeatPerformed: false,
    sentinelPosted: SENTINEL,
    sentinelAfter: SENTINEL,
    seededAmount: 59,
    expectedCurrency: "JOD",
    ...overrides,
  };
}

/** The request never landed: the ledger is untouched, the expense is listed, and the repeat reversed it once. */
function notApplied(overrides: Partial<NavigationRaceObservation> = {}): NavigationRaceObservation {
  return applied({ afterRace: POSTED, final: REVERSED, screenRow: "LISTED", repeatPerformed: true, ...overrides });
}

/** The same unreversed state with a repeat that could not be made. */
function repeatFailed(overrides: Partial<NavigationRaceObservation> = {}): NavigationRaceObservation {
  return notApplied({ final: POSTED, repeatPerformed: false, ...overrides });
}

describe("SCRUM-350 NAVIGATION_RACE oracle (interrupted posted-expense reversal)", () => {
  it("names the outcome from the ledger alone", () => {
    expect(raceOutcome(POSTED)).toBe("NOT_APPLIED");
    expect(raceOutcome(REVERSED)).toBe("APPLIED");
  });

  describe("both legitimate outcomes are clean", () => {
    it("accepts a request that landed before the navigation", () => {
      expect(evaluateNavigationRace(applied())).toEqual({ violations: [], unjudged: [] });
    });

    it("accepts a request that did not land when the repeat ends with exactly one reversal", () => {
      expect(evaluateNavigationRace(notApplied())).toEqual({ violations: [], unjudged: [] });
    });
  });

  describe("breaches", () => {
    it("flags a half-applied reversal: the original marked reversed with no reversal event", () => {
      const half: LedgerSnapshot = {
        events: [
          event({ id: "e1", eventType: "EXPENSE_POSTED", status: "REVERSED", reversedByEventId: "e2", journalEntryId: "j1" }),
        ],
        journals: { j1: ORIGINAL_LINES },
      };
      const verdict = evaluateNavigationRace(notApplied({ afterRace: half }));
      expect(verdict.violations).toEqual([expect.stringMatching(/submitted reversal and navigation changed/)]);
    });

    it("flags a duplicate reversal produced by the race", () => {
      const duplicate: LedgerSnapshot = {
        events: [...REVERSED.events, event({ id: "e3", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j3" })],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const verdict = evaluateNavigationRace(applied({ afterRace: duplicate, final: duplicate }));
      expect(verdict.violations).toEqual([expect.stringMatching(/2 reversal events/)]);
    });

    it("flags a repeat from an unreversed ledger that produces two reversals", () => {
      const duplicate: LedgerSnapshot = {
        events: [...REVERSED.events, event({ id: "e3", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j3" })],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const verdict = evaluateNavigationRace(notApplied({ final: duplicate }));
      expect(verdict.violations).toEqual([expect.stringMatching(/2 reversal events/)]);
    });

    it("flags a repeat whose reversal is not linked to the posted event", () => {
      const unlinked: LedgerSnapshot = {
        events: [
          event({ id: "e1", eventType: "EXPENSE_POSTED", status: "REVERSED", reversedByEventId: "e2", journalEntryId: "j1" }),
          event({ id: "e2", eventType: "JOURNAL_REVERSAL", reversalOfEventId: null, journalEntryId: "j2" }),
        ],
        journals: REVERSED.journals,
      };
      const verdict = evaluateNavigationRace(notApplied({ final: unlinked }));
      expect(verdict.violations).toEqual(expect.arrayContaining([expect.stringMatching(/not linked to the posted event/)]));
    });

    it("flags a reversal produced by the race that is not linked to the posted event", () => {
      const unlinked: LedgerSnapshot = {
        events: [
          event({ id: "e1", eventType: "EXPENSE_POSTED", status: "REVERSED", reversedByEventId: "e2", journalEntryId: "j1" }),
          event({ id: "e2", eventType: "JOURNAL_REVERSAL", reversalOfEventId: null, journalEntryId: "j2" }),
        ],
        journals: REVERSED.journals,
      };
      const verdict = evaluateNavigationRace(applied({ afterRace: unlinked, final: unlinked }));
      expect(verdict.violations).toEqual(expect.arrayContaining([expect.stringMatching(/after reversal: .*not linked to the posted event/)]));
    });

    it("flags a race that moves the sentinel expense's ledger", () => {
      const moved: LedgerSnapshot = {
        events: [event({ id: "s1", eventType: "EXPENSE_POSTED", status: "REVERSED", journalEntryId: "sj1" })],
        journals: SENTINEL.journals,
      };
      const verdict = evaluateNavigationRace(applied({ sentinelAfter: moved }));
      expect(verdict.violations).toEqual([expect.stringMatching(/sentinel expense's ledger across the race changed/)]);
    });

    it("is a breach, not merely unjudged, when the repeat could not be made but the screen lost the unreversed expense", () => {
      const verdict = evaluateNavigationRace(repeatFailed({ screenRow: "NOT_LISTED" }));
      expect(verdict.violations).toEqual([expect.stringMatching(/does not list an expense the ledger shows as unreversed/)]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/was not repeated/)]);
    });

    it("flags a reversal that does not mirror the posting", () => {
      const skewed: LedgerSnapshot = {
        events: REVERSED.events,
        journals: { j1: ORIGINAL_LINES, j2: [line("expense", 0, 58_000), line("cash", 58_000, 0)] },
      };
      const verdict = evaluateNavigationRace(applied({ afterRace: skewed, final: skewed }));
      expect(verdict.violations).toEqual([expect.stringMatching(/does not mirror/)]);
    });

    it("flags an unreversed race outcome that the repeat could not bring to a single reversal", () => {
      const verdict = evaluateNavigationRace(notApplied({ final: POSTED }));
      expect(verdict.violations).toEqual([expect.stringMatching(/holds no reversal event/)]);
    });

    it("flags a reloaded screen that still lists an expense the ledger shows as reversed", () => {
      const verdict = evaluateNavigationRace(applied({ screenRow: "LISTED" }));
      expect(verdict.violations).toEqual([expect.stringMatching(/still lists an expense the ledger shows as reversed/)]);
    });

    it("flags a reloaded screen that lost an expense the ledger shows as unreversed", () => {
      const verdict = evaluateNavigationRace(notApplied({ screenRow: "NOT_LISTED" }));
      expect(verdict.violations).toEqual([expect.stringMatching(/does not list an expense the ledger shows as unreversed/)]);
    });

    it("flags a posting in a currency other than the organization's", () => {
      const verdict = evaluateNavigationRace(applied({ expectedCurrency: "USD" }));
      expect(verdict.violations).toEqual([expect.stringMatching(/organization's currency is USD/)]);
    });
  });

  describe("never a vacuous pass", () => {
    it.each([
      ["no click", { clickIssued: false }, /was not clicked/],
      ["history back that did not leave the screen", { leftScreen: false }, /history back did not leave/],
      ["history forward that did not return", { returned: false }, /history forward did not return/],
    ] as const)("is unjudged for %s, whatever the ledger says", (_label, overrides, pattern) => {
      const verdict = evaluateNavigationRace(applied(overrides));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(pattern)]);
    });

    it("is unjudged, not clean, when the repeat could not be made and nothing else disagrees", () => {
      const verdict = evaluateNavigationRace(repeatFailed());
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/was not repeated/)]);
    });

    it("is unjudged, never clean, when the sentinel could not be read after the race", () => {
      const verdict = evaluateNavigationRace(applied({ sentinelAfter: null }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/sentinel expense's ledger could not be read after the race/)]);
    });

    it("keeps a proven target breach when the sentinel after-read is unavailable", () => {
      const screen = evaluateNavigationRace(applied({ screenRow: "LISTED", sentinelAfter: null }));
      expect(screen.violations).toEqual([expect.stringMatching(/still lists an expense the ledger shows as reversed/)]);
      expect(screen.unjudged).toEqual([expect.stringMatching(/could not be read after the race/)]);

      const duplicate: LedgerSnapshot = {
        events: [...REVERSED.events, event({ id: "e3", eventType: "JOURNAL_REVERSAL", reversalOfEventId: "e1", journalEntryId: "j3" })],
        journals: { ...REVERSED.journals, j3: MIRROR_LINES },
      };
      const ledger = evaluateNavigationRace(applied({ afterRace: duplicate, final: duplicate, sentinelAfter: null }));
      expect(ledger.violations).toEqual([expect.stringMatching(/2 reversal events/)]);
    });

    it("judges the screen against the target even when the sentinel was not posted beforehand", () => {
      const verdict = evaluateNavigationRace(
        applied({ screenRow: "LISTED", sentinelPosted: { events: [], journals: {} }, sentinelAfter: null }),
      );
      expect(verdict.violations).toEqual([expect.stringMatching(/still lists an expense the ledger shows as reversed/)]);
    });

    it("is unjudged when the sentinel was not a posted expense before the race", () => {
      const verdict = evaluateNavigationRace(applied({ sentinelPosted: { events: [], journals: {} }, sentinelAfter: { events: [], journals: {} } }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/sentinel expense was not a single posted event/)]);
    });

    it("is unjudged when the reloaded screen was not read, even with a clean ledger", () => {
      const verdict = evaluateNavigationRace(applied({ screenRow: null }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/reloaded expenses screen was not read/)]);
    });

    it("is unjudged when the posting was never a real posting", () => {
      const verdict = evaluateNavigationRace(
        applied({ posted: { events: [], journals: {} }, afterRace: { events: [], journals: {} }, final: { events: [], journals: {} } }),
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged.length).toBeGreaterThan(0);
    });

    it("is unjudged when the organization's currency was not read", () => {
      const verdict = evaluateNavigationRace(applied({ expectedCurrency: null }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/currency was not readable/)]);
    });
  });
});
