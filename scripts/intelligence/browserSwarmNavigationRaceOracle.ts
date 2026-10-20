/**
 * SCRUM-350 LIFE-1 — the pure judgement of a navigation race against an economic lifecycle transition.
 *
 * LIFE-1: cancelling, voiding, returning, reopening or reversing an economic
 * lifecycle must unwind its own effects without erasing surviving obligations.
 * The attack submits a posted expense's "Reverse & Delete" and navigates away
 * (history back) and returns (history forward) straight after. Whether the
 * request was still in flight is not measured here, and it may or may not have
 * reached the backend, so BOTH outcomes are legitimate and neither is assumed:
 *
 *  - not applied: the ledger is exactly what it was before the click;
 *  - applied: the ledger holds exactly one linked mirror reversal of the
 *    original posting and the original is untouched.
 *
 * Anything between (a half-applied reversal, a duplicate, an unlinked or
 * non-mirroring reversal) is a breach, and the ledger reconciliation of
 * browserSwarmBoundaryOracle.ts is reused unchanged to say so. A not-applied
 * outcome must still be recoverable: the reversal repeated from the returned
 * screen ends with exactly one reversal. A repeat that could not be made leaves
 * convergence unjudged, but a ledger/screen mismatch already shown is a breach.
 * After the reload the expenses screen is judged against the ledger beside it
 * (a reversed expense is not listed, an unreversed one is), never alone, and
 * an absence only counts once a sentinel expense proves the list had loaded;
 * the sentinel's own ledger must not move. A premise that was not established
 * is unjudged, never clean.
 */
import {
  evaluateReversalReconciliation,
  judgeUnchanged,
  type Judgement,
  type LedgerSnapshot,
} from "./browserSwarmBoundaryOracle";

export interface NavigationRaceObservation {
  /** "Reverse & Delete" was clicked while the dialog was armed. */
  clickIssued: boolean;
  /** History back left the expenses screen. */
  leftScreen: boolean;
  /** History forward brought the expenses screen back. */
  returned: boolean;
  /** The expense's ledger after it was posted, after the race settled, and after any recovery. */
  posted: LedgerSnapshot;
  afterRace: LedgerSnapshot;
  final: LedgerSnapshot;
  /**
   * Whether the reloaded screen listed the expense once the race had settled; null when it was not read,
   * including when the sentinel expense (a second posted expense that must be listed) never appeared,
   * because absence is only evidence after the list has loaded.
   */
  screenRow: "LISTED" | "NOT_LISTED" | null;
  /** The reversal was repeated from the returned screen (only ever after a not-applied race). */
  repeatPerformed: boolean;
  /** The sentinel expense's ledger when it was posted and after everything else; the race must not move it. */
  sentinelPosted: LedgerSnapshot;
  /** Null when the after-read did not happen or failed: the sentinel is then unjudged, never clean. */
  sentinelAfter: LedgerSnapshot | null;
  /** The synthetic expense's amount in major units. */
  seededAmount: number;
  /** The organization's currency from its settings; null when that read was not possible. */
  expectedCurrency: string | null;
}

const reversalCount = (snapshot: LedgerSnapshot): number =>
  snapshot.events.filter((event) => event.eventType === "JOURNAL_REVERSAL").length;

const sentinelPosted = (snapshot: LedgerSnapshot): boolean => {
  const postings = snapshot.events.filter((event) => event.eventType === "EXPENSE_POSTED");
  return postings.length === 1 && postings[0]?.status === "POSTED" && reversalCount(snapshot) === 0;
};

/** Which of the two legitimate outcomes the race produced, read from the ledger alone. */
export function raceOutcome(afterRace: LedgerSnapshot): "APPLIED" | "NOT_APPLIED" {
  return reversalCount(afterRace) === 0 ? "NOT_APPLIED" : "APPLIED";
}

export function evaluateNavigationRace(observation: NavigationRaceObservation): Judgement {
  const unjudged: string[] = [];
  if (!observation.clickIssued) unjudged.push('"Reverse & Delete" was not clicked, so no reversal was submitted');
  if (!observation.leftScreen) unjudged.push("history back did not leave the expenses screen, so there was no navigation after the submit");
  if (!observation.returned) unjudged.push("history forward did not return to the expenses screen");
  if (unjudged.length > 0) return { violations: [], unjudged };

  const { posted, afterRace, final, seededAmount, expectedCurrency } = observation;
  const applied = raceOutcome(afterRace) === "APPLIED";
  const verdicts: Judgement[] = [];
  if (applied) {
    // The race stage and, when it moved, the recovery stage, against the same posting.
    verdicts.push(evaluateReversalReconciliation({ posted, reversed: afterRace, replayed: final, seededAmount, expectedCurrency }));
  } else {
    verdicts.push(judgeUnchanged("the expense's ledger across the submitted reversal and navigation", posted, afterRace));
    if (observation.repeatPerformed) {
      verdicts.push(evaluateReversalReconciliation({ posted, reversed: final, replayed: final, seededAmount, expectedCurrency }));
    } else {
      // Convergence is unproven, but what the ledger and the screen show now is still judged below.
      const postings = posted.events.filter((event) => event.eventType === "EXPENSE_POSTED");
      if (postings.length !== 1 || postings[0]?.status !== "POSTED") {
        verdicts.push({ violations: [], unjudged: ["the expense was not a single posted event before the race"] });
      }
      unjudged.push("the reversal was not repeated from the returned screen, so a reversal that had not applied was not shown to converge");
    }
  }

  // The screen is judged against the target's ledger only: the bystander posting below is judged separately,
  // so a sentinel that cannot be judged never suppresses a target breach.
  const ledgerJudged = verdicts.every((verdict) => verdict.unjudged.length === 0);
  if (observation.screenRow === null) {
    unjudged.push("the reloaded expenses screen was not read, so what it lists is unknown");
  } else if (!ledgerJudged) {
    // The screen is judged against the ledger; a ledger that could not be judged gives it nothing to be judged against.
  } else if (applied && observation.screenRow === "LISTED") {
    verdicts.push({ violations: ["the reloaded screen still lists an expense the ledger shows as reversed"], unjudged: [] });
  } else if (!applied && observation.screenRow === "NOT_LISTED") {
    verdicts.push({ violations: ["the reloaded screen does not list an expense the ledger shows as unreversed"], unjudged: [] });
  }

  // A bystander posting: a second posted expense the race had no business touching. A pass needs a real
  // unchanged after-read; an unavailable one is unjudged, never clean.
  if (!sentinelPosted(observation.sentinelPosted)) {
    verdicts.push({ violations: [], unjudged: ["the sentinel expense was not a single posted event before the race"] });
  } else if (observation.sentinelAfter === null) {
    verdicts.push({ violations: [], unjudged: ["the sentinel expense's ledger could not be read after the race, so it is not shown unchanged"] });
  } else {
    verdicts.push(judgeUnchanged("the sentinel expense's ledger across the race", observation.sentinelPosted, observation.sentinelAfter));
  }

  return {
    violations: [...new Set(verdicts.flatMap((verdict) => verdict.violations))],
    unjudged: [...new Set([...unjudged, ...verdicts.flatMap((verdict) => verdict.unjudged)])],
  };
}
