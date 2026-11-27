/**
 * SCRUM-1023 Phase 1: pair completeness of the purged ledger rows. READ-ONLY, pure (PR #908 round 1, R3 and R5).
 *
 * A purged event or journal must be half of a complete reversed pair: the original names its reverser AND the
 * reverser names the original, both are in the purge set, and both journals are POSTED or REVERSED. A reversal that
 * was itself reversed needs ITS reverser in the set too. Only the events and journals an owner-approved exception
 * names by exact id are exempt, so a hidden second entry can never ride along on an exception.
 */
import type { Doc } from "../_generated/dataModel";
import type { ApprovedException, LedgerRefusal, LedgerRefusalCode } from "./purgeManifestLedger";

function refuse(out: LedgerRefusal[], code: LedgerRefusalCode, table: string, detail: string): void {
  out.push({ code, table, detail, count: 1 });
}

/** Each id of an exception counts once, so a repeated journal id cannot double its net. */
export function normalizeApproved(approved: ReadonlyArray<ApprovedException>): ApprovedException[] {
  return approved.map((ex) => ({ ...ex, eventIds: [...new Set(ex.eventIds)], journalIds: [...new Set(ex.journalIds)] }));
}

/** The ids of the events and journals an approved exception exempts from pairing. */
export function exemptIds(approved: ReadonlyArray<ApprovedException>): { eventIds: Set<string>; journalIds: Set<string> } {
  return {
    eventIds: new Set(approved.flatMap((a) => a.eventIds)),
    journalIds: new Set(approved.flatMap((a) => a.journalIds)),
  };
}

const okJournalStatus = (j: Doc<"journalEntries">): boolean => j.status === "POSTED" || j.status === "REVERSED";

function eventPairProblem(e: Doc<"accountingEvents">, events: ReadonlyMap<string, Doc<"accountingEvents">>): string | null {
  if (e.eventType === "JOURNAL_REVERSAL") {
    const original = e.reversalOfEventId ? events.get(e.reversalOfEventId) : undefined;
    if (!original || original.reversedByEventId !== e._id) return "a reversal whose original is not in the purge set or does not point back at it";
  }
  if (e.status === "REVERSED") {
    const reverser = e.reversedByEventId ? events.get(e.reversedByEventId) : undefined;
    if (!reverser || reverser.reversalOfEventId !== e._id) return "a reversed event whose reverser is not in the purge set or does not point back at it";
  }
  return null;
}

function journalPaired(j: Doc<"journalEntries">, journals: ReadonlyMap<string, Doc<"journalEntries">>): boolean {
  if (!okJournalStatus(j)) return false;
  if (j.category === "REVERSAL") {
    const original = j.reversalOfJournalEntryId ? journals.get(j.reversalOfJournalEntryId) : undefined;
    if (!original || original.reversedByJournalEntryId !== j._id) return false;
  } else if (j.status !== "REVERSED") {
    return false;
  }
  if (j.status === "REVERSED") {
    const reverser = j.reversedByJournalEntryId ? journals.get(j.reversedByJournalEntryId) : undefined;
    if (!reverser || reverser.reversalOfJournalEntryId !== j._id || !okJournalStatus(reverser)) return false;
  }
  return true;
}

/**
 * Pair completeness of events and journals, checked in BOTH directions. An exempt event must really be unreversed
 * (a reversed one contradicts the exception that names it).
 */
export function checkPairs(
  events: ReadonlyMap<string, Doc<"accountingEvents">>,
  journals: ReadonlyMap<string, Doc<"journalEntries">>,
  approved: ReadonlyArray<ApprovedException>,
  out: LedgerRefusal[],
  proven: { eventIds: ReadonlySet<string>; journalIds: ReadonlySet<string> } = { eventIds: new Set(), journalIds: new Set() },
): void {
  const exempt = exemptIds(approved);
  for (const e of events.values()) {
    // Phase 1b: the receipt and refund of a proven REFUNDED deposit are two independent entries, not a reversal pair.
    // They are exempt from pairing only while plainly POSTED and unreversed; netting still runs over their lines.
    if (proven.eventIds.has(e._id) && e.status === "POSTED" && e.eventType !== "JOURNAL_REVERSAL" && !e.reversedByEventId) continue;
    if (exempt.eventIds.has(e._id)) {
      if (e.eventType === "JOURNAL_REVERSAL" || e.status === "REVERSED") {
        refuse(out, "EXCEPTION_MISMATCH", "accountingEvents", "an approved exception names an event that is already reversed");
      } else if (e.status !== "POSTED") {
        refuse(out, "EXCEPTION_MISMATCH", "accountingEvents", `an approved exception names an event that is ${e.status}, not POSTED`);
      }
      continue;
    }
    if (e.eventType !== "JOURNAL_REVERSAL" && e.status !== "REVERSED") {
      refuse(out, "UNREVERSED_EVENT", "accountingEvents", `a ${e.status} ${e.eventType} event that was never reversed`);
      continue;
    }
    const problem = eventPairProblem(e, events);
    if (problem) refuse(out, "INCOMPLETE_REVERSAL_PAIR", "accountingEvents", problem);
  }
  for (const j of journals.values()) {
    if (proven.journalIds.has(j._id) && j.status === "POSTED" && j.category !== "REVERSAL" && !j.reversedByJournalEntryId) continue;
    if (exempt.journalIds.has(j._id)) {
      if (j.status !== "POSTED" || j.category === "REVERSAL" || j.reversedByJournalEntryId) {
        refuse(out, "EXCEPTION_MISMATCH", "journalEntries", `an approved exception names a ${j.status}/${j.category} journal, not a plain POSTED one`);
      }
      continue;
    }
    if (!journalPaired(j, journals)) refuse(out, "JOURNAL_NOT_PAIRED", "journalEntries", `a ${j.status}/${j.category} journal without its pair`);
  }
}

/** Every named event or journal must be in the purge set, or the approval is stale. Returns the count of strays. */
export function strayExemptions(
  approved: ReadonlyArray<ApprovedException>, events: ReadonlyMap<string, unknown>, journals: ReadonlyMap<string, unknown>,
): number {
  let strays = 0;
  for (const ex of approved) {
    strays += ex.eventIds.filter((id) => !events.has(id)).length;
    strays += ex.journalIds.filter((id) => !journals.has(id)).length;
  }
  return strays;
}
