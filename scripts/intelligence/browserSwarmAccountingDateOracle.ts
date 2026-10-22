/**
 * SCRUM-849 ACC-3 — the pure judgement of a manual journal's accounting date and the closed-period boundary.
 *
 * ACC-3: a manual journal posts using the accounting date its preparer declared, and ordinary posting into a
 * closed accounting period is rejected. The verdict is the BACKEND's own journal and period state read through
 * permission-checked queries, judged against figures the scenario chose (never taken from the product, never a
 * UI label): the posted entry carries the declared date on its header and on every line, sits in the period
 * covering that date rather than the period covering the approval day, and a draft dated into a CLOSED period
 * is refused with the closed period left closed, empty of the refused journal, and the draft still pending.
 * Anything not read is unjudged, never clean.
 */
import { judgeRefusedAttempt, type Judgement, type ProbeOutcome } from "./browserSwarmBoundaryOracle";

/** The refusal `approveManualJournal` raises for a CLOSED period (the state this scenario sets up), and no other refusal. */
export const CLOSED_PERIOD_REFUSAL = /\bis CLOSED\. Manual journal posting not allowed/;

/** The refusal createManualJournal and approveManualJournal raise while manual journals are off (SCRUM-795), and no other refusal. */
export const MANUAL_JOURNALS_DISABLED_REFUSAL = /turned off during the pilot/;

export interface PeriodView {
  id: string;
  startDate: number;
  endDate: number;
  status: string;
}

export interface JournalLineView {
  accountId: string | null;
  debitMinor: number;
  creditMinor: number;
  accountingDate: number | null;
}

/** One posted journal as `getJournalEntry` serves it. */
export interface JournalView {
  id: string;
  status: string | null;
  memo: string | null;
  accountingDate: number | null;
  periodId: string | null;
  lines: readonly JournalLineView[];
}

/** One row of `listJournalEntries`, reduced to what the mission judges. */
export interface EntryView {
  id: string;
  status: string | null;
  memo: string | null;
  periodId: string | null;
  accountingDate: number | null;
}

export interface SentLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
}

/**
 * The refused draft as `listPendingManualJournals` serves it, reduced to the fields a refusal must leave alone:
 * what was prepared (memo, date, lines, preparer) and every field a decision would set.
 */
export interface DraftView {
  id: string;
  status: string | null;
  memo: string | null;
  accountingDate: number | null;
  createdBy: string | null;
  lines: readonly SentLine[];
  reviewedBy: string | null;
  decidedAt: number | null;
  rejectionReason: string | null;
  journalEntryId: string | null;
}

export interface AccountingDateObservation {
  /** The date declared for the journal that must post, inside the OPEN window. */
  declaredDate: number;
  /** The date declared for the journal that must be refused, inside the CLOSED window. */
  closedDeclaredDate: number;
  /** The clock just before the posting approval: later than the whole OPEN window, or a wrong date cannot be told apart. */
  approvalStartedAt: number;
  openPeriod: PeriodView;
  /** The CLOSED window as read immediately before the refused approval. */
  closedPeriodBefore: PeriodView;
  sentLines: readonly SentLine[];
  memos: { posted: string; refused: string };
  posted: { journal: JournalView | null };
  refused: {
    approval: ProbeOutcome;
    closedPeriodAfter: PeriodView | null;
    /** Journal lists read immediately before and after the refused approval; a write is a row in `after` that `before` lacked. */
    entriesInClosedBefore: readonly EntryView[] | null;
    entriesInClosedAfter: readonly EntryView[] | null;
    entriesInOpenBefore: readonly EntryView[] | null;
    entriesInOpenAfter: readonly EntryView[] | null;
    /** Every journal of the organization, in any period, read to completion; null when it could not be. */
    orgEntriesBefore: readonly EntryView[] | null;
    orgEntriesAfter: readonly EntryView[] | null;
    /** The refused draft's pending row read immediately before the approval, and after it; null when absent or malformed. */
    draftBefore: DraftView | null;
    draftAfter: DraftView | null;
    /** Whether the refused draft is still PENDING_APPROVAL; null when the pending list was not read. */
    draftStillPending: boolean | null;
  };
}

const merge = (...verdicts: readonly Judgement[]): Judgement => ({
  violations: verdicts.flatMap((verdict) => verdict.violations),
  unjudged: verdicts.flatMap((verdict) => verdict.unjudged),
});

const unjudged = (reason: string): Judgement => ({ violations: [], unjudged: [reason] });
const violation = (reason: string): Judgement => ({ violations: [reason], unjudged: [] });

const within = (period: PeriodView, date: number): boolean => date >= period.startDate && date <= period.endDate;

const sortedIds = (entries: readonly EntryView[]): string[] => entries.map((row) => row.id).sort((a, b) => a.localeCompare(b));

/** The rows `after` holds that `before` did not: the only authoritative evidence that something was written in between. */
const newRows = (before: readonly EntryView[], after: readonly EntryView[]): EntryView[] => {
  const known = new Set(before.map((row) => row.id));
  return after.filter((row) => !known.has(row.id));
};

/**
 * A journal present on both organization-wide reads must be the same journal. Another mission may legitimately
 * change a row it owns, so a change is never a breach, but it may equally be the refused approval moving or voiding
 * an existing journal, so it is never clean either. A row without a readable status or a finite accounting date
 * fails closed.
 */
const readable = (row: EntryView): boolean => row.status !== null && Number.isFinite(row.accountingDate);

function judgeExistingRows(before: readonly EntryView[], after: readonly EntryView[]): Judgement {
  const unreadable = [...before, ...after].filter((row) => !readable(row));
  const earlier = new Map(before.map((row) => [row.id, row]));
  const changed: string[] = [];
  for (const row of after) {
    const prior = earlier.get(row.id);
    if (prior === undefined || !readable(prior) || !readable(row)) continue;
    const fields = (
      [
        ["status", prior.status, row.status],
        ["memo", prior.memo, row.memo],
        ["periodId", prior.periodId, row.periodId],
        ["accountingDate", prior.accountingDate, row.accountingDate],
      ] as const
    )
      .filter(([, was, now]) => !Object.is(was, now))
      .map(([name]) => name);
    if (fields.length > 0) changed.push(`${row.id} (${fields.join(", ")})`);
  }
  const verdicts: Judgement[] = [];
  const present = new Set(after.map((row) => row.id));
  const vanished = before.filter((row) => !present.has(row.id));
  if (vanished.length > 0) {
    verdicts.push(unjudged(`journal(s) [${sortedIds(vanished).join(", ")}] present before the refused approval are missing after it, so the refused approval could not be ruled out as the cause`));
  }
  if (unreadable.length > 0) {
    const ids = [...new Set(unreadable.map((row) => row.id))].sort((a, b) => a.localeCompare(b));
    verdicts.push(unjudged(`organization journal(s) [${ids.join(", ")}] carry no readable status or finite accountingDate, so they could not be compared across the refused approval`));
  }
  if (changed.length > 0) {
    verdicts.push(
      unjudged(`existing journal(s) [${changed.join(", ")}] changed during the refused approval and carry no link to another source, so the refused approval could not be ruled out as the cause`),
    );
  }
  return merge(...verdicts);
}

const hasDuplicateIds = (rows: readonly EntryView[]): boolean => new Set(rows.map((row) => row.id)).size !== rows.length;

/** Both reads of a pair, only when each is present and free of repeated ids: the only pair a before/after delta may rest on. */
const comparable = (
  before: readonly EntryView[] | null,
  after: readonly EntryView[] | null,
): [readonly EntryView[], readonly EntryView[]] | null =>
  before !== null && after !== null && !hasDuplicateIds(before) && !hasDuplicateIds(after) ? [before, after] : null;

/** A list that repeats a journal id cannot be compared by id, so no verdict may rest on it. */
function judgeDuplicateIds(lists: readonly [string, readonly EntryView[] | null][]): Judgement {
  const verdicts: Judgement[] = [];
  for (const [label, rows] of lists) {
    if (rows === null) continue;
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const row of rows) (seen.has(row.id) ? repeated : seen).add(row.id);
    if (repeated.size > 0) {
      verdicts.push(unjudged(`the ${label} journal list holds duplicate journal id(s) [${[...repeated].sort((a, b) => a.localeCompare(b)).join(", ")}], so rows could not be compared by id`));
    }
  }
  return merge(...verdicts);
}

const show = (value: unknown): string => (value === null ? "nothing" : String(value));

function judgeDraftUnchanged(refused: Pick<AccountingDateObservation["refused"], "draftBefore" | "draftAfter" | "draftStillPending">): Judgement {
  const { draftBefore, draftAfter, draftStillPending } = refused;
  if (draftBefore === null) return unjudged("the refused draft was not read before the approval, so its fields could not be compared");
  // A draft that left the pending list is already a violation; there is no row left to compare.
  if (draftStillPending !== true) return { violations: [], unjudged: [] };
  if (draftAfter === null) return unjudged("the refused draft could not be read after the refused approval, so its fields could not be compared");
  if (draftBefore.id !== draftAfter.id) {
    return unjudged(`the draft read after the refused approval (${draftAfter.id}) is not the draft read before it (${draftBefore.id}), so its fields could not be compared`);
  }
  // NaN !== NaN, so a non-finite number would read as a change; it is unreadable evidence, not a difference.
  const numbers = [draftBefore, draftAfter].flatMap((draft) => [
    draft.accountingDate,
    draft.decidedAt,
    ...draft.lines.flatMap((line) => [line.debitMinor, line.creditMinor]),
  ]);
  if (numbers.some((value) => value !== null && !Number.isFinite(value))) {
    return unjudged("the refused draft carries a non-finite number, so its fields could not be compared");
  }
  const pairs: [string, unknown, unknown][] = [
    ["status", draftBefore.status, draftAfter.status],
    ["memo", draftBefore.memo, draftAfter.memo],
    ["accountingDate", draftBefore.accountingDate, draftAfter.accountingDate],
    ["createdBy", draftBefore.createdBy, draftAfter.createdBy],
    ["lines", draftBefore.lines.map(lineKey).join(","), draftAfter.lines.map(lineKey).join(",")],
    ["reviewedBy", draftBefore.reviewedBy, draftAfter.reviewedBy],
    ["decidedAt", draftBefore.decidedAt, draftAfter.decidedAt],
    ["rejectionReason", draftBefore.rejectionReason, draftAfter.rejectionReason],
    ["journalEntryId", draftBefore.journalEntryId, draftAfter.journalEntryId],
  ];
  return {
    violations: pairs
      .filter(([, before, after]) => before !== after)
      .map(([name, before, after]) => `the refused draft's ${name} changed from ${show(before)} to ${show(after)}, though the approval was refused`),
    unjudged: [],
  };
}

const lineKey = (line: Pick<JournalLineView, "accountId" | "debitMinor" | "creditMinor">): string => `${line.accountId}|${line.debitMinor}|${line.creditMinor}`;

/** The scenario must be able to tell a right date from a wrong one, or no verdict on the date means anything. */
function judgePremise(observation: AccountingDateObservation): Judgement {
  const { openPeriod, closedPeriodBefore, declaredDate, closedDeclaredDate, approvalStartedAt } = observation;
  const problems: string[] = [];
  if (openPeriod.status !== "OPEN") problems.push(`the open window ${openPeriod.id} is ${openPeriod.status}, not OPEN`);
  if (!within(openPeriod, declaredDate)) problems.push(`the declared date ${declaredDate} is outside the open window ${openPeriod.id}`);
  if (!(approvalStartedAt > openPeriod.endDate)) {
    problems.push(
      `the approval started at ${approvalStartedAt}, inside or before the open window, so a journal stamped with the approval time could not be told from the declared date`,
    );
  }
  if (closedPeriodBefore.status !== "CLOSED") {
    problems.push(`the closed window ${closedPeriodBefore.id} is ${closedPeriodBefore.status} before the attempt, not CLOSED`);
  }
  if (!within(closedPeriodBefore, closedDeclaredDate)) {
    problems.push(`the declared date ${closedDeclaredDate} is outside the closed window ${closedPeriodBefore.id}`);
  }
  return { violations: [], unjudged: problems };
}

/** The posted entry carries the declared date on its header and every line, in the period covering it. */
function judgePosted(observation: AccountingDateObservation): Judgement {
  const { journal } = observation.posted;
  if (journal === null) return unjudged("the posted journal was not read, so its accounting date could not be judged");
  const { declaredDate, openPeriod, approvalStartedAt, sentLines, memos } = observation;
  const found: string[] = [];
  const missing: string[] = [];
  if (journal.status === null) {
    missing.push("the entry carries no readable status");
  } else if (journal.status !== "POSTED") {
    found.push(`the entry is ${journal.status}, not POSTED`);
  }
  if (journal.memo === null) {
    missing.push("the entry carries no readable memo");
  } else if (journal.memo !== memos.posted) {
    found.push(`the entry memo "${journal.memo}" is not the submitted ${memos.posted}`);
  }

  if (journal.accountingDate === null || !Number.isFinite(journal.accountingDate)) {
    missing.push("the entry carries no readable accounting date");
  } else if (journal.accountingDate !== declaredDate) {
    const atApproval = journal.accountingDate >= approvalStartedAt ? ", the approval time (the SCRUM-50 defect)" : "";
    found.push(`the entry carries accountingDate ${journal.accountingDate}, not the declared ${declaredDate}${atApproval}`);
  }
  if (journal.periodId === null) {
    missing.push("the entry carries no period");
  } else if (journal.periodId !== openPeriod.id) {
    found.push(`the entry sits in period ${journal.periodId}, not ${openPeriod.id}, the period covering the declared date`);
  }
  let linesReadable = true;
  journal.lines.forEach((line, index) => {
    if (line.accountingDate === null || !Number.isFinite(line.accountingDate)) {
      missing.push(`line ${index + 1} carries no readable accounting date`);
    } else if (line.accountingDate !== declaredDate) {
      found.push(`line ${index + 1} carries accountingDate ${line.accountingDate}, not the declared ${declaredDate}`);
    }
    if (line.accountId === null) {
      linesReadable = false;
      missing.push(`line ${index + 1} carries no readable account`);
    }
    if (!Number.isFinite(line.debitMinor) || !Number.isFinite(line.creditMinor)) {
      linesReadable = false;
      missing.push(`line ${index + 1} carries no readable amount`);
    }
  });
  // Lines that could not be read cannot be compared with the lines submitted: unjudged above, never a mismatch.
  const posted = journal.lines.map(lineKey).sort((a, b) => a.localeCompare(b));
  const sent = sentLines.map(lineKey).sort((a, b) => a.localeCompare(b));
  if (linesReadable && posted.join(",") !== sent.join(",")) {
    found.push(`the entry lines do not match the lines submitted: posted [${posted.join(", ")}], submitted [${sent.join(", ")}]`);
  }
  return { violations: found, unjudged: missing };
}

/** A draft dated into a CLOSED period is refused and changes nothing: no journal anywhere, the period still closed. */
function judgeRefused(observation: AccountingDateObservation): Judgement {
  const { refused, memos, openPeriod } = observation;
  const verdicts: Judgement[] = [judgeRefusedAttempt("approving a draft dated into the CLOSED period", refused.approval)];

  if (refused.closedPeriodAfter === null) {
    verdicts.push(unjudged("the closed period was not read after the refused approval"));
  } else if (refused.closedPeriodAfter.status !== "CLOSED") {
    verdicts.push(violation(`the closed period is ${refused.closedPeriodAfter.status} after the refused approval`));
  }

  // A write is a row that appeared between the two reads. Without both reads nothing can be called new, so a row
  // that merely carries the refused memo is no proof: the verdict is unjudged and no violation is invented.
  const reported = new Set<string>();
  verdicts.push(
    judgeDuplicateIds([
      ["closed-period before", refused.entriesInClosedBefore],
      ["closed-period after", refused.entriesInClosedAfter],
      ["open-period before", refused.entriesInOpenBefore],
      ["open-period after", refused.entriesInOpenAfter],
      ["organization before", refused.orgEntriesBefore],
      ["organization after", refused.orgEntriesAfter],
    ]),
  );
  if (refused.entriesInClosedBefore === null) verdicts.push(unjudged("the journals of the closed period were not read before the refused approval"));
  if (refused.entriesInClosedAfter === null) verdicts.push(unjudged("the journals of the closed period were not read after the refused approval"));
  const closedPair = comparable(refused.entriesInClosedBefore, refused.entriesInClosedAfter);
  const openPair = comparable(refused.entriesInOpenBefore, refused.entriesInOpenAfter);
  const orgPair = comparable(refused.orgEntriesBefore, refused.orgEntriesAfter);
  if (closedPair !== null) {
    const written = newRows(...closedPair);
    written.forEach((row) => reported.add(row.id));
    if (written.length > 0) {
      verdicts.push(violation(`the closed period now holds journal(s) [${sortedIds(written).join(", ")}] that the refused approval wrote`));
    }
  }

  if (refused.entriesInOpenBefore === null) {
    verdicts.push(unjudged("the journals of the open period were not read before the refused approval, so a silent retarget could not be ruled out"));
  }
  if (refused.entriesInOpenAfter === null) {
    verdicts.push(unjudged("the journals of the open period were not read after the refused approval, so a silent retarget could not be ruled out"));
  }
  if (openPair !== null) {
    for (const row of newRows(...openPair).filter((candidate) => candidate.memo === memos.refused)) {
      reported.add(row.id);
      verdicts.push(violation(`the refused journal was posted anyway, into period ${openPeriod.id} as ${row.id}`));
    }
  }

  // The refused draft's journal may land in ANY period, not only the two windows the scenario set up.
  if (refused.orgEntriesBefore === null) {
    verdicts.push(unjudged("the organization's journals were not read before the refused approval, so a retarget into any other period could not be ruled out"));
  }
  if (refused.orgEntriesAfter === null) {
    verdicts.push(unjudged("the organization's journals were not read after the refused approval, so a retarget into any other period could not be ruled out"));
  }
  if (orgPair !== null) {
    const unattributed: EntryView[] = [];
    for (const row of newRows(...orgPair)) {
      if (reported.has(row.id)) continue;
      if (row.memo === memos.refused) {
        verdicts.push(violation(`the refused journal was posted anyway, into period ${row.periodId ?? "unknown"} as ${row.id}`));
      } else {
        unattributed.push(row);
      }
    }
    verdicts.push(judgeExistingRows(...orgPair));
    // Another mission may write to this organization during the window, so such a row is not called a breach; but
    // it could be the refused draft's journal written with a changed memo, so it cannot be called clean either.
    if (unattributed.length > 0) {
      verdicts.push(
        unjudged(
          `new journal(s) [${sortedIds(unattributed).join(", ")}] appeared in the organization during the refused approval and carry no link to another source, so a retarget of the refused draft could not be ruled out`,
        ),
      );
    }
  }

  if (refused.draftStillPending === null) {
    verdicts.push(unjudged("the pending drafts were not read, so the refused draft's state could not be judged"));
  } else if (!refused.draftStillPending) {
    verdicts.push(violation("the refused draft is no longer pending, though nothing was posted from it"));
  }
  verdicts.push(judgeDraftUnchanged(refused));
  return merge(...verdicts);
}

export function evaluateAccountingDate(observation: AccountingDateObservation): Judgement {
  const premise = judgePremise(observation);
  // A scenario that cannot tell a right date from a wrong one is judged on nothing: nothing else is reported as clean.
  if (premise.unjudged.length > 0) return premise;
  return merge(judgePosted(observation), judgeRefused(observation));
}

export interface ManualJournalsOffObservation {
  /** The memo the refused create carried: a journal or draft bearing it is the attempt having written something. */
  memo: string;
  createAttempt: ProbeOutcome;
  /** Every journal of the organization, read to completion immediately before the attempt and after it; null when it could not be. */
  entriesBefore: readonly EntryView[] | null;
  entriesAfter: readonly EntryView[] | null;
  /** Every pending draft, read at the same moments; null when the list or a row could not be read. */
  draftsBefore: readonly DraftView[] | null;
  draftsAfter: readonly DraftView[] | null;
}

/**
 * A door that was not exercised is a failure (AGENTS.md: a scenario that cannot run is a failure, never a skip).
 * The only pass is a refusal carrying the expected pilot message: a lapsed session or a refusal for any other reason
 * is a violation, not unjudged.
 */
function judgeDoorRefused(label: string, outcome: ProbeOutcome): Judgement {
  switch (outcome.kind) {
    case "ACCEPTED":
      return violation(`${label} was accepted`);
    case "REFUSED":
      return { violations: [], unjudged: [] };
    case "LAPSED":
      return violation(`${label} was not exercised: the harness session lapsed, so the refusal it must raise was never observed`);
    default:
      return violation(`${label} was not exercised: it failed for a reason other than the pilot refusal (${outcome.message})`);
  }
}

/**
 * SCRUM-795 swarm scope: ONLY the create door. With manual journals off, createManualJournal is refused with the
 * pilot message and the refusal leaves no trace: no journal appears or changes, no draft appears, every pending draft
 * keeps its fields and stays pending.
 *
 * The approve door is NOT in this mission's scope: the swarm lane never holds the legacy pending draft (it is seeded
 * only by trusted-main E2E). It is covered by convex/manualJournalsPilotOff.scrum795.test.ts and the trusted-main
 * Playwright spec (accounting.spec.ts proveLegacyApproveRefused).
 *
 * Everything the mission still claims fails closed: a create that was not exercised, or a before/after read that is
 * missing, is a violation, never unjudged and never a pass.
 */
export function evaluateManualJournalsOff(observation: ManualJournalsOffObservation): Judgement {
  const { memo, createAttempt, entriesBefore, entriesAfter, draftsBefore, draftsAfter } = observation;
  const verdicts: Judgement[] = [judgeDoorRefused("preparing a manual journal while manual journals are off", createAttempt)];

  if (entriesBefore === null || entriesAfter === null) {
    verdicts.push(violation("the organization's journals could not be read on both sides of the refused attempt, so an unchanged ledger was never observed"));
  } else {
    verdicts.push(judgeDuplicateIds([["organization before", entriesBefore], ["organization after", entriesAfter]]));
    const pair = comparable(entriesBefore, entriesAfter);
    if (pair !== null) {
      const unattributed: EntryView[] = [];
      for (const row of newRows(...pair)) {
        if (row.memo === memo) verdicts.push(violation(`a journal carrying the refused memo was posted anyway as ${row.id}`));
        else unattributed.push(row);
      }
      verdicts.push(judgeExistingRows(...pair));
      if (unattributed.length > 0) {
        verdicts.push(
          unjudged(
            `new journal(s) [${sortedIds(unattributed).join(", ")}] appeared in the organization during the refused attempt and carry no link to another source, so a write by the refused attempt could not be ruled out`,
          ),
        );
      }
    }
  }

  if (draftsBefore === null || draftsAfter === null) {
    verdicts.push(violation("the pending drafts could not be read on both sides of the refused attempt, or a row was malformed, so unchanged drafts were never observed"));
  } else {
    const known = new Set(draftsBefore.map((draft) => draft.id));
    for (const draft of draftsAfter) {
      if (known.has(draft.id)) continue;
      verdicts.push(
        draft.memo === memo
          ? violation(`a draft carrying the refused memo was prepared anyway as ${draft.id}`)
          : unjudged(`a new pending draft ${draft.id} appeared during the refused attempt, so a write by it could not be ruled out`),
      );
    }
    for (const before of draftsBefore) {
      const after = draftsAfter.find((draft) => draft.id === before.id) ?? null;
      if (after === null) {
        verdicts.push(violation(`pending draft ${before.id} left the pending list though the attempt was refused`));
      } else {
        verdicts.push(judgeDraftUnchanged({ draftBefore: before, draftAfter: after, draftStillPending: true }));
      }
    }
  }
  return merge(...verdicts);
}
