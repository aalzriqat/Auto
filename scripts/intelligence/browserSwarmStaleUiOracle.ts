/**
 * SCRUM-350 LIFE-1 — the pure judgement of a stale screen's economic lifecycle action.
 *
 * LIFE-1: cancelling, voiding, returning, reopening or reversing an economic
 * lifecycle must unwind its own effects without erasing surviving obligations.
 * The expenses screen holds a posted expense in its "Reverse & Delete" dialog;
 * once the backend has reversed that expense (another tab, another user) the
 * dialog stays open and armed. Using it then asks the backend to reverse the
 * same posted expense again.
 *
 * The verdict is the LEDGER: the original posting untouched, exactly one linked
 * mirror reversal, and nothing added by the stale request (the reversal
 * reconciliation of browserSwarmBoundaryOracle.ts, reused unchanged). What the
 * screen announced is judged beside it and never alone: a toast cannot make a
 * pass, only a silent, unclassified or missing one makes the mission unjudged.
 * A premise that was not established is unjudged, never clean.
 */
import {
  evaluateReversalReconciliation,
  judgeUnchanged,
  type Judgement,
  type LedgerSnapshot,
} from "./browserSwarmBoundaryOracle";

/** How the stale screen answered the late click. */
export type StaleScreenAnswer = "SUCCESS_TOAST" | "REFUSAL_TOAST" | "UNCLASSIFIED_TOAST" | "SILENT";

export interface StaleReversalObservation {
  /** "Reverse & Delete" was visible AND enabled (reason entered) before the server-side reversal. */
  actionArmedBeforeChange: boolean;
  /** Whether that same action was still offered (visible and enabled) after the server-side reversal. */
  actionAfterChange: "OFFERED" | "WITHDRAWN";
  /** What the screen announced when the stale action was used; null when it was not used. */
  screenAnswer: StaleScreenAnswer | null;
  /** The expense's ledger after it was posted, after the server-side reversal, and after the stale request. */
  posted: LedgerSnapshot;
  reversed: LedgerSnapshot;
  afterStale: LedgerSnapshot;
  /** The synthetic expense's amount in major units. */
  seededAmount: number;
  /** The organization's currency from its settings; null when that read was not possible. */
  expectedCurrency: string | null;
}

/** The server-side transition counts as made only when the ledger holds a posted, linked reversal. */
function holdsPostedReversal(snapshot: LedgerSnapshot): boolean {
  return snapshot.events.some(
    (event) => event.eventType === "JOURNAL_REVERSAL" && event.status === "POSTED" && event.reversalOfEventId !== null,
  );
}

export function evaluateStaleReversal(observation: StaleReversalObservation): Judgement {
  const unjudged: string[] = [];
  if (!observation.actionArmedBeforeChange) {
    unjudged.push(
      'the "Reverse & Delete" action was not visible and enabled before the server-side reversal, so there was no armed stale action',
    );
  }
  if (!holdsPostedReversal(observation.reversed)) {
    unjudged.push("the ledger holds no posted linked reversal after the server-side reversal, so the screen was not stale");
  }
  if (unjudged.length > 0) return { violations: [], unjudged };

  const ledger = evaluateReversalReconciliation({
    posted: observation.posted,
    reversed: observation.reversed,
    replayed: observation.afterStale,
    seededAmount: observation.seededAmount,
    expectedCurrency: observation.expectedCurrency,
  });
  const unchanged = judgeUnchanged(
    "the expense's ledger across the stale reversal request",
    observation.reversed,
    observation.afterStale,
  );
  const violations = [...ledger.violations, ...unchanged.violations];
  unjudged.push(...ledger.unjudged, ...unchanged.unjudged);

  if (observation.actionAfterChange === "WITHDRAWN") {
    unjudged.push(
      "the screen withdrew the reversal action by itself after the backend reversed the expense, so no stale action was taken through the UI",
    );
  } else if (observation.screenAnswer === "SUCCESS_TOAST") {
    violations.push("the stale screen announced a reversal although the expense had already been reversed");
  } else if (observation.screenAnswer === "UNCLASSIFIED_TOAST") {
    unjudged.push('the stale screen answered the late reversal with a message that is not the product\'s "Expense not found" refusal');
  } else if (observation.screenAnswer !== "REFUSAL_TOAST") {
    unjudged.push("the stale screen gave no answer to the late reversal, so what it told the user is unknown");
  }

  return { violations, unjudged };
}
