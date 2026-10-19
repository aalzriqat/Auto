import { describe, expect, it } from "vitest";
import {
  CLOSED_PERIOD_REFUSAL,
  evaluateAccountingDate,
  evaluateManualJournalsOff,
  type AccountingDateObservation,
  type ManualJournalsOffObservation,
  type DraftView,
  type EntryView,
  type JournalView,
} from "./browserSwarmAccountingDateOracle";

/**
 * SCRUM-849 ACC-3 — the pure judgement of a manual journal's accounting date and the closed-period boundary.
 *
 * Every date is written out by hand, in UTC milliseconds: the OPEN window is February 2020 (declared date
 * 15 Feb 12:00), the CLOSED window is January 2020 (declared date 15 Jan 12:00), and the approval happens in
 * October 2026, so a journal stamped with the approval time cannot be mistaken for the declared date. Each
 * test flips exactly one fact of the backend's journal or period state.
 */
const OPEN = { id: "period-feb", startDate: 1_580_515_200_000, endDate: 1_583_020_799_999, status: "OPEN" };
const CLOSED = { id: "period-jan", startDate: 1_577_836_800_000, endDate: 1_580_515_199_999, status: "CLOSED" };
const DECLARED = 1_581_768_000_000;
const CLOSED_DECLARED = 1_579_089_600_000;
const APPROVAL_AT = 1_760_000_000_000;
const NOW_PERIOD = "period-now";

const SENT = [
  { accountId: "acct-a", debitMinor: 12_345, creditMinor: 0 },
  { accountId: "acct-b", debitMinor: 0, creditMinor: 12_345 },
];

const postedJournal = (over: Partial<JournalView> = {}): JournalView => ({
  id: "je-1",
  status: "POSTED",
  memo: "memo-posted",
  accountingDate: DECLARED,
  periodId: OPEN.id,
  lines: SENT.map((line) => ({ ...line, accountingDate: DECLARED })),
  ...over,
});

const entry = (id: string, memo: string, periodId: string, over: Partial<EntryView> = {}): EntryView => ({
  id,
  memo,
  periodId,
  accountingDate: DECLARED,
  status: "POSTED",
  ...over,
});

/** The list row the backend serves for a journal read by id: the same table, so the same header fields. */
const rowOf = (journal: JournalView): EntryView => ({
  id: journal.id,
  status: journal.status,
  memo: journal.memo,
  periodId: journal.periodId,
  accountingDate: journal.accountingDate as number,
});

/** The journal the scenario itself posted: present in every open-period and organization-wide list. */
const POSTED_ROW = rowOf(postedJournal());

const pendingDraft = (over: Partial<DraftView> = {}): DraftView => ({
  id: "draft-2",
  status: "PENDING_APPROVAL",
  memo: "memo-refused",
  accountingDate: CLOSED_DECLARED,
  createdBy: "user-owner",
  lines: SENT,
  reviewedBy: null,
  decidedAt: null,
  rejectionReason: null,
  journalEntryId: null,
  ...over,
});

const refusal = {
  kind: "REFUSED" as const,
  message: "The accounting period covering 2020-01-15 is CLOSED. Manual journal posting not allowed.",
};

/**
 * The default lists are derived from the posted journal, so a changed journal keeps the lists physically possible.
 * `premiseOnly` marks the cases whose posted journal is unreadable or absent: there is no honest row to derive, so
 * the default journal's row stands in and only the posted-journal premise is under test.
 */
function observation(over: Partial<AccountingDateObservation> = {}, premiseOnly = false): AccountingDateObservation {
  const posted = over.posted ?? { journal: postedJournal() };
  const row = premiseOnly || posted.journal === null ? POSTED_ROW : rowOf(posted.journal);
  const inPeriod = (periodId: string) => (row.periodId === periodId ? [row] : []);
  const built: AccountingDateObservation = {
    declaredDate: DECLARED,
    closedDeclaredDate: CLOSED_DECLARED,
    approvalStartedAt: APPROVAL_AT,
    openPeriod: OPEN,
    closedPeriodBefore: CLOSED,
    sentLines: SENT,
    memos: { posted: "memo-posted", refused: "memo-refused" },
    posted,
    refused: {
      approval: refusal,
      closedPeriodAfter: CLOSED,
      entriesInClosedBefore: inPeriod(CLOSED.id),
      entriesInClosedAfter: inPeriod(CLOSED.id),
      entriesInOpenBefore: inPeriod(OPEN.id),
      entriesInOpenAfter: inPeriod(OPEN.id),
      orgEntriesBefore: [row],
      orgEntriesAfter: [row],
      draftBefore: pendingDraft(),
      draftAfter: pendingDraft(),
      draftStillPending: true,
    },
    ...over,
  };
  assertPossible(premiseOnly ? null : built.posted.journal, built.refused);
  return built;
}

const rowKey = (row: EntryView): string => [row.status, row.memo, row.periodId, String(row.accountingDate)].join("|");

/**
 * The backend serves a period list and the organization-wide list from one table, so two lists read with no write in
 * between must agree row for row: a period's rows are the organization's rows in that period, field for field. The
 * journal the scenario posted exists before the refused approval, so its header must be on the "before" organization
 * read exactly as the journal read by id shows it. An impossible fixture is a test bug, not a case.
 */
function assertPossible(posted: JournalView | null, refused: AccountingDateObservation["refused"]): void {
  const lists: [readonly EntryView[] | null, readonly EntryView[] | null, string, string][] = [
    [refused.entriesInClosedBefore, refused.orgEntriesBefore, "closed before", CLOSED.id],
    [refused.entriesInOpenBefore, refused.orgEntriesBefore, "open before", OPEN.id],
    [refused.entriesInClosedAfter, refused.orgEntriesAfter, "closed after", CLOSED.id],
    [refused.entriesInOpenAfter, refused.orgEntriesAfter, "open after", OPEN.id],
  ];
  for (const [period, org, label, periodId] of lists) {
    if (period === null || org === null) continue;
    const orgById = new Map(org.map((row) => [row.id, row]));
    for (const row of period) {
      const served = orgById.get(row.id);
      if (served === undefined) throw new Error(`impossible fixture: ${label} row ${row.id} is missing from the organization-wide list`);
      if (rowKey(served) !== rowKey(row)) throw new Error(`impossible fixture: ${label} row ${row.id} differs from the organization-wide row`);
      if (row.periodId !== periodId) throw new Error(`impossible fixture: ${label} row ${row.id} is not in period ${periodId}`);
    }
    const listed = new Set(period.map((row) => row.id));
    const unlisted = org.filter((row) => row.periodId === periodId && !listed.has(row.id)).map((row) => row.id);
    if (unlisted.length > 0) throw new Error(`impossible fixture: organization rows [${unlisted.join(", ")}] sit in period ${periodId} but not in the ${label} list`);
  }
  if (posted !== null && refused.orgEntriesBefore !== null) {
    const served = refused.orgEntriesBefore.find((row) => row.id === posted.id);
    if (served === undefined) throw new Error(`impossible fixture: the posted journal ${posted.id} is missing from the organization-wide before list`);
    if (rowKey(served) !== rowKey(rowOf(posted))) throw new Error(`impossible fixture: the posted journal ${posted.id} differs from its organization-wide before row`);
  }
}

const withRefused = (over: Partial<AccountingDateObservation["refused"]>): AccountingDateObservation => {
  const base = observation();
  const refused = { ...base.refused, ...over };
  assertPossible(base.posted.journal, refused);
  return { ...base, refused };
};

describe("SCRUM-849 ACC-3 oracle: the correct product", () => {
  it("judges a journal on its declared date and a refused closed-period approval as clean", () => {
    expect(evaluateAccountingDate(observation())).toEqual({ violations: [], unjudged: [] });
  });
});

describe("SCRUM-849 ACC-3 oracle: wrong-date negative controls", () => {
  it("FAILS a journal stamped with the approval time on its header, its period and its lines (the SCRUM-50 defect)", () => {
    const wrong = postedJournal({
      accountingDate: APPROVAL_AT,
      periodId: NOW_PERIOD,
      lines: SENT.map((line) => ({ ...line, accountingDate: APPROVAL_AT })),
    });
    const verdict = evaluateAccountingDate(observation({ posted: { journal: wrong } }));
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/entry carries accountingDate 1760000000000, not the declared 1581768000000.*approval/),
        expect.stringMatching(/entry sits in period period-now, not period-feb/),
        expect.stringMatching(/line 1 carries accountingDate 1760000000000, not the declared 1581768000000/),
      ]),
    );
  });

  it("FAILS a journal whose header is dated right but one line is dated at approval", () => {
    const journal = postedJournal();
    const lines = [{ ...journal.lines[0]!, accountingDate: APPROVAL_AT }, journal.lines[1]!];
    const verdict = evaluateAccountingDate(observation({ posted: { journal: { ...journal, lines } } }));
    expect(verdict.violations).toEqual([expect.stringMatching(/line 1 carries accountingDate 1760000000000/)]);
  });

  it("FAILS a journal dated right but filed under the wrong period", () => {
    const verdict = evaluateAccountingDate(observation({ posted: { journal: postedJournal({ periodId: CLOSED.id }) } }));
    expect(verdict.violations).toEqual([expect.stringMatching(/entry sits in period period-jan, not period-feb/)]);
  });

  it("FAILS a journal dated right but carrying other lines than the ones submitted, or not POSTED", () => {
    const short = postedJournal({ lines: [{ ...SENT[0]!, debitMinor: 12_344, accountingDate: DECLARED }, { ...SENT[1]!, accountingDate: DECLARED }] });
    expect(evaluateAccountingDate(observation({ posted: { journal: short } })).violations).toEqual([
      expect.stringMatching(/lines do not match the lines submitted/),
    ]);
    const unposted = evaluateAccountingDate(observation({ posted: { journal: postedJournal({ status: "DRAFT" }) } }));
    expect(unposted.violations).toEqual([expect.stringMatching(/entry is DRAFT, not POSTED/)]);
  });

  it("FAILS a journal that is not the one submitted (another memo)", () => {
    const verdict = evaluateAccountingDate(observation({ posted: { journal: postedJournal({ memo: "someone else" }) } }));
    expect(verdict.violations).toEqual([expect.stringMatching(/entry memo "someone else" is not the submitted memo-posted/)]);
  });
});

describe("SCRUM-849 ACC-3 oracle: closed-period negative controls", () => {
  it("FAILS an approval into a CLOSED period that was accepted", () => {
    const verdict = evaluateAccountingDate(
      withRefused({
        approval: { kind: "ACCEPTED", value: { journalId: "je-2" } },
        entriesInClosedAfter: [entry("je-2", "memo-refused", CLOSED.id)],
        orgEntriesAfter: [POSTED_ROW, entry("je-2", "memo-refused", CLOSED.id)],
      }),
    );
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/approving a draft dated into the CLOSED period was accepted/),
        expect.stringMatching(/the closed period now holds journal\(s\) \[je-2\]/),
      ]),
    );
  });

  it("FAILS a refusal that still wrote the journal into the closed period", () => {
    const written = entry("je-2", "memo-refused", CLOSED.id);
    const verdict = evaluateAccountingDate(withRefused({ entriesInClosedAfter: [written], orgEntriesAfter: [POSTED_ROW, written] }));
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/the closed period now holds journal\(s\) \[je-2\]/)]);
  });

  it("FAILS a refused draft silently retargeted into the open period", () => {
    const written = entry("je-3", "memo-refused", OPEN.id);
    const verdict = evaluateAccountingDate(withRefused({ entriesInOpenAfter: [POSTED_ROW, written], orgEntriesAfter: [POSTED_ROW, written] }));
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/refused journal was posted anyway, into period period-feb as je-3/)]);
  });

  it("FAILS a refusal that reopened the closed period", () => {
    const verdict = evaluateAccountingDate(withRefused({ closedPeriodAfter: { ...CLOSED, status: "OPEN" } }));
    expect(verdict.violations).toEqual([expect.stringMatching(/closed period is OPEN after the refused approval/)]);
  });

  it("FAILS a refusal that consumed the draft", () => {
    const verdict = evaluateAccountingDate(withRefused({ draftStillPending: false }));
    expect(verdict.violations).toEqual([expect.stringMatching(/refused draft is no longer pending/)]);
  });

  it("matches only the closed-period refusal, not another refusal of the same call", () => {
    expect(CLOSED_PERIOD_REFUSAL.test(refusal.message)).toBe(true);
    // The scenario closes its window; a LOCKED period's refusal is a different state, so it is not this scenario's evidence.
    expect(CLOSED_PERIOD_REFUSAL.test("The accounting period covering 2020-01-15 is LOCKED. Manual journal posting not allowed.")).toBe(false);
    expect(CLOSED_PERIOD_REFUSAL.test("No accounting period covers 2020-01-15. Open the period for that date.")).toBe(false);
    expect(CLOSED_PERIOD_REFUSAL.test("Manual journal reviewer cannot be the same as the poster.")).toBe(false);
    expect(CLOSED_PERIOD_REFUSAL.test("The accounting period covering 2020-01-15 has not been opened yet.")).toBe(false);
  });
});

describe("SCRUM-849 ACC-3 oracle: absent or unparseable evidence is unjudged, never clean", () => {
  const unjudged = (verdict: ReturnType<typeof evaluateAccountingDate>, pattern: RegExp) => {
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(pattern)]);
  };

  it("does not pass when the posted journal was not read", () => {
    unjudged(evaluateAccountingDate(observation({ posted: { journal: null } }, true)), /posted journal was not read/);
  });

  it("is unjudged, with no violation, when the posted header date or period is missing or non-finite", () => {
    unjudged(evaluateAccountingDate(observation({ posted: { journal: postedJournal({ accountingDate: null }) } }, true)), /entry carries no readable accounting date/);
    unjudged(evaluateAccountingDate(observation({ posted: { journal: postedJournal({ accountingDate: Number.NaN }) } }, true)), /entry carries no readable accounting date/);
    unjudged(evaluateAccountingDate(observation({ posted: { journal: postedJournal({ periodId: null }) } }, true)), /entry carries no period/);
  });

  it("is unjudged, with no violation, when every posted line date is missing or non-finite", () => {
    for (const accountingDate of [null, Number.NaN]) {
      const lines = SENT.map((line) => ({ ...line, accountingDate }));
      const verdict = evaluateAccountingDate(observation({ posted: { journal: postedJournal({ lines }) } }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([
        expect.stringMatching(/^line 1 carries no readable accounting date/),
        expect.stringMatching(/^line 2 carries no readable accounting date/),
      ]);
    }
  });

  it("FAILS, as a real breach, a posted journal that carries no lines at all", () => {
    const verdict = evaluateAccountingDate(observation({ posted: { journal: postedJournal({ lines: [] }) } }));
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/lines do not match the lines submitted: posted \[\], submitted \[acct-a\|12345\|0, acct-b\|0\|12345\]/)]);
  });

  it("is unjudged, never a 'changed' breach, when identical refused-draft fields are non-finite", () => {
    const sameNaN = (over: Partial<DraftView>) =>
      evaluateAccountingDate(withRefused({ draftBefore: pendingDraft(over), draftAfter: pendingDraft(over) }));
    for (const over of [
      { accountingDate: Number.NaN },
      { decidedAt: Number.NaN },
      { lines: [{ ...SENT[0]!, debitMinor: Number.NaN }, SENT[1]!] },
    ]) {
      const verdict = sameNaN(over);
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/refused draft carries a non-finite number, so its fields could not be compared/)]);
    }
  });

  it("is unjudged, never a breach, when the posted journal's status or memo was not read", () => {
    unjudged(evaluateAccountingDate(observation({ posted: { journal: postedJournal({ status: null }) } }, true)), /entry carries no readable status/);
    unjudged(evaluateAccountingDate(observation({ posted: { journal: postedJournal({ memo: null }) } }, true)), /entry carries no readable memo/);
  });

  it("is unjudged, never a breach, when a posted line has no account or a non-finite amount", () => {
    const [first, second] = postedJournal().lines;
    const withLines = (lines: JournalView["lines"]) => evaluateAccountingDate(observation({ posted: { journal: postedJournal({ lines }) } }));
    unjudged(withLines([{ ...first!, accountId: null }, second!]), /line 1 carries no readable account/);
    unjudged(withLines([first!, { ...second!, creditMinor: Number.NaN }]), /line 2 carries no readable amount/);
    unjudged(withLines([{ ...first!, debitMinor: Number.POSITIVE_INFINITY }, second!]), /line 1 carries no readable amount/);
  });

  it("still reports a real status, memo or line breach alongside an unreadable field", () => {
    const [first, second] = postedJournal().lines;
    const verdict = evaluateAccountingDate(
      observation({ posted: { journal: postedJournal({ status: "DRAFT", lines: [{ ...first!, accountId: null }, second!] }) } }),
    );
    expect(verdict.violations).toEqual([expect.stringMatching(/entry is DRAFT, not POSTED/)]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(/line 1 carries no readable account/)]);
  });

  it("does not pass when the refusal was not a closed-period refusal, or the session lapsed", () => {
    unjudged(
      evaluateAccountingDate(withRefused({ approval: { kind: "UNCLASSIFIED", message: "Rate limit exceeded. Try again in 3s." } })),
      /approving a draft dated into the CLOSED period: failed for a reason that is not an authorization refusal/,
    );
    unjudged(evaluateAccountingDate(withRefused({ approval: { kind: "LAPSED" } })), /session lapsed/);
  });

  it("does not pass when the closed period, its journals or the pending list were not read", () => {
    unjudged(evaluateAccountingDate(withRefused({ closedPeriodAfter: null })), /closed period was not read after the refused approval/);
    unjudged(evaluateAccountingDate(withRefused({ entriesInClosedAfter: null })), /journals of the closed period were not read after/);
    unjudged(evaluateAccountingDate(withRefused({ entriesInClosedBefore: null })), /journals of the closed period were not read before/);
    unjudged(evaluateAccountingDate(withRefused({ entriesInOpenAfter: null })), /journals of the open period were not read/);
    unjudged(evaluateAccountingDate(withRefused({ draftStillPending: null })), /pending drafts were not read/);
  });

  it("does not call an unrelated existing journal a new write when the closed period's journals were not read before", () => {
    const verdict = evaluateAccountingDate(
      withRefused({
        entriesInClosedBefore: null,
        entriesInClosedAfter: [entry("je-old", "an older, unrelated memo", CLOSED.id)],
        orgEntriesBefore: [POSTED_ROW, entry("je-old", "an older, unrelated memo", CLOSED.id)],
        orgEntriesAfter: [POSTED_ROW, entry("je-old", "an older, unrelated memo", CLOSED.id)],
      }),
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(/journals of the closed period were not read before/)]);
  });

  it("still FAILS a same-memo closed-period row through the organization-wide delta when only the period baseline is missing", () => {
    const written = entry("je-new", "memo-refused", CLOSED.id);
    const verdict = evaluateAccountingDate(
      withRefused({ entriesInClosedBefore: null, entriesInClosedAfter: [written], orgEntriesAfter: [POSTED_ROW, written] }),
    );
    expect(verdict.violations).toEqual([expect.stringMatching(/refused journal was posted anyway, into period period-jan as je-new/)]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(/journals of the closed period were not read before/)]);
  });

  it("invents no violation from a same-memo row when neither the closed-period nor the organization baseline exists", () => {
    const written = entry("je-new", "memo-refused", CLOSED.id);
    const verdict = evaluateAccountingDate(
      withRefused({ entriesInClosedBefore: null, entriesInClosedAfter: [written], orgEntriesBefore: null, orgEntriesAfter: [POSTED_ROW, written] }),
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([
      expect.stringMatching(/journals of the closed period were not read before/),
      expect.stringMatching(/organization's journals were not read before/),
    ]);
  });

  it("does not call a same-memo row a new write when the BEFORE snapshot already held it", () => {
    const already = entry("je-old", "memo-refused", CLOSED.id);
    const verdict = evaluateAccountingDate(
      withRefused({
        entriesInClosedBefore: [already],
        entriesInClosedAfter: [already],
        orgEntriesBefore: [POSTED_ROW, already],
        orgEntriesAfter: [POSTED_ROW, already],
      }),
    );
    expect(verdict).toEqual({ violations: [], unjudged: [] });
  });

  it("flags a NEW row in the closed period by ID delta, whatever its memo, reported once", () => {
    const written = entry("je-new", "another memo", CLOSED.id);
    const verdict = evaluateAccountingDate(withRefused({ entriesInClosedAfter: [written], orgEntriesAfter: [POSTED_ROW, written] }));
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/closed period now holds journal\(s\) \[je-new\]/)]);
  });

  it("is unjudged, not a breach, for a NEW open-period row whose memo was changed", () => {
    const written = entry("je-4", "a changed memo", OPEN.id);
    const verdict = evaluateAccountingDate(withRefused({ entriesInOpenAfter: [POSTED_ROW, written], orgEntriesAfter: [POSTED_ROW, written] }));
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(/new journal\(s\) \[je-4\] appeared in the organization/)]);
  });

  it("invents no violation from a same-memo open-period row when there is no open-period baseline: unjudged only", () => {
    const written = entry("je-3", "memo-refused", OPEN.id);
    const verdict = evaluateAccountingDate(
      withRefused({
        entriesInOpenBefore: null,
        entriesInOpenAfter: [POSTED_ROW, written],
        orgEntriesBefore: null,
        orgEntriesAfter: [POSTED_ROW, written],
      }),
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([
      expect.stringMatching(/journals of the open period were not read before/),
      expect.stringMatching(/organization's journals were not read before/),
    ]);
  });

  it("does not call a same-memo open-period row a retarget when the BEFORE snapshot already held it", () => {
    const already = entry("je-3", "memo-refused", OPEN.id);
    const verdict = evaluateAccountingDate(
      withRefused({
        entriesInOpenBefore: [POSTED_ROW, already],
        entriesInOpenAfter: [POSTED_ROW, already],
        orgEntriesBefore: [POSTED_ROW, already],
        orgEntriesAfter: [POSTED_ROW, already],
      }),
    );
    expect(verdict).toEqual({ violations: [], unjudged: [] });
  });

  it("FAILS a refused draft silently retargeted into a THIRD period, seen only in the organization-wide delta", () => {
    const written = entry("je-9", "memo-refused", "period-mar");
    const verdict = evaluateAccountingDate(
      withRefused({ orgEntriesAfter: [entry("je-1", "memo-posted", OPEN.id), written] }),
    );
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/refused journal was posted anyway, into period period-mar as je-9/)]);
  });

  // Another mission may write to the same organization during the window, so an unattributed new row is not a
  // breach; but it may be the refused draft's journal written with a changed memo, so it is not clean either.
  it("is unjudged, with no violation, when an unattributed new journal appears in a third period with a changed or null memo", () => {
    for (const memo of ["an unrelated memo", null]) {
      const written = { ...entry("je-9", "x", "period-mar"), memo };
      const verdict = evaluateAccountingDate(withRefused({ orgEntriesAfter: [entry("je-1", "memo-posted", OPEN.id), written] }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/new journal\(s\) \[je-9\] appeared in the organization during the refused approval.*could not be ruled out/)]);
    }
  });

  it("lists every unattributed new journal, in id order, in one unjudged reason", () => {
    const verdict = evaluateAccountingDate(
      withRefused({
        orgEntriesAfter: [entry("je-1", "memo-posted", OPEN.id), entry("je-8", "other", "period-mar"), entry("je-7", "other", "period-apr")],
      }),
    );
    expect(verdict.violations).toEqual([]);
    expect(verdict.unjudged).toEqual([expect.stringMatching(/\[je-7, je-8\]/)]);
  });

  it("is clean when no journal appeared in the organization during the refused approval", () => {
    expect(evaluateAccountingDate(withRefused({}))).toEqual({ violations: [], unjudged: [] });
  });

  it("names only the actual period of an organization-wide retarget, never claiming where it is not", () => {
    const written = entry("je-9", "memo-refused", "period-mar");
    const [violationText] = evaluateAccountingDate(withRefused({ orgEntriesAfter: [POSTED_ROW, written] })).violations;
    expect(violationText).toBe("the refused journal was posted anyway, into period period-mar as je-9");
  });

  // Another mission may change a row it owns while the refused approval runs, so a change is not a breach; but the
  // refused approval might have moved or voided an existing journal, so a changed row is never clean.
  describe("an existing organization journal that changed during the refused approval", () => {
    // Every list the backend would serve at the same moment, so the fixture stays possible.
    const readsOf = (row: EntryView) => ({
      orgEntries: [row],
      open: row.periodId === OPEN.id ? [row] : [],
      closed: row.periodId === CLOSED.id ? [row] : [],
    });
    const refusedWith = (before: EntryView, after: EntryView) => {
      const b = readsOf(before);
      const a = readsOf(after);
      const base = observation();
      const refused = {
        ...base.refused,
        orgEntriesBefore: b.orgEntries,
        entriesInOpenBefore: b.open,
        entriesInClosedBefore: b.closed,
        orgEntriesAfter: a.orgEntries,
        entriesInOpenAfter: a.open,
        entriesInClosedAfter: a.closed,
      };
      // A before row that is not the posted journal's own row is a premise-only case (an unreadable existing row).
      assertPossible(before === POSTED_ROW ? base.posted.journal : null, refused);
      return { ...base, refused };
    };
    const changedAfter = (over: Partial<EntryView>) => evaluateAccountingDate(refusedWith(POSTED_ROW, { ...POSTED_ROW, ...over }));

    it("is unjudged, with no violation, when it moved to a third period", () => {
      const verdict = changedAfter({ periodId: "period-mar" });
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/existing journal\(s\) \[je-1 \(periodId\)\] changed during the refused approval/)]);
    });

    it("is unjudged, with no violation, when only its status changed", () => {
      const verdict = changedAfter({ status: "VOIDED" });
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/\[je-1 \(status\)\] changed during the refused approval/)]);
    });

    it("is unjudged when its memo or accounting date changed, naming every changed field", () => {
      const verdict = changedAfter({ memo: "edited", accountingDate: APPROVAL_AT });
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/\[je-1 \(memo, accountingDate\)\] changed/)]);
    });

    it("is clean when the existing row is unchanged", () => {
      expect(changedAfter({})).toEqual({ violations: [], unjudged: [] });
    });

    it("fails closed on a non-finite accountingDate, even when identical on both reads", () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const row = { ...POSTED_ROW, accountingDate: bad };
        const verdict = evaluateAccountingDate(refusedWith(row, row));
        expect(verdict.violations).toEqual([]);
        expect(verdict.unjudged).toEqual([expect.stringMatching(/journal\(s\) \[je-1\] carry no readable status or finite accountingDate/)]);
      }
    });

    it("fails closed when a row on either read carries no readable status", () => {
      const noStatus = { ...POSTED_ROW, status: null };
      unjudged(evaluateAccountingDate(refusedWith(POSTED_ROW, noStatus)), /journal\(s\) \[je-1\] carry no readable status/);
      unjudged(evaluateAccountingDate(refusedWith(noStatus, POSTED_ROW)), /journal\(s\) \[je-1\] carry no readable status/);
    });

    it("is unjudged, with no violation, when a journal present before the refused approval is missing after it", () => {
      const extra = entry("je-2", "memo-other", OPEN.id);
      const verdict = evaluateAccountingDate(
        withRefused({
          orgEntriesBefore: [POSTED_ROW, extra],
          entriesInOpenBefore: [POSTED_ROW, extra],
        }),
      );
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/journal\(s\) \[je-2\] present before the refused approval are missing after it/)]);
    });

    it("derives no delta from a list pair that repeats an id: a duplicate plus an apparent new closed-period row is INCONCLUSIVE, not a breach", () => {
      // je-7 is in the closed period and on the organization read, with a memo that is NOT the refused draft's, so the
      // organization pair can only call it unattributed. Only the repeated closed-period list could call it a breach.
      const other = entry("je-7", "memo-other", CLOSED.id);
      const verdict = evaluateAccountingDate(withRefused({ entriesInClosedAfter: [other, other], orgEntriesAfter: [POSTED_ROW, other] }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([
        expect.stringMatching(/closed-period after journal list holds duplicate journal id\(s\) \[je-7\]/),
        expect.stringMatching(/new journal\(s\) \[je-7\] appeared in the organization/),
      ]);
    });

    it("still reports a breach that independent, duplicate-free evidence shows", () => {
      // je-7 is written into the closed period on both duplicate-free reads; a separate open-period list repeats an id.
      const written = entry("je-7", "memo-refused", CLOSED.id);
      const verdict = evaluateAccountingDate(
        withRefused({
          entriesInClosedAfter: [written],
          orgEntriesAfter: [POSTED_ROW, written],
          entriesInOpenAfter: [POSTED_ROW, POSTED_ROW],
        }),
      );
      expect(verdict.violations).toEqual([expect.stringMatching(/closed period now holds journal\(s\) \[je-7\] that the refused approval wrote/)]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/open-period after journal list holds duplicate journal id\(s\) \[je-1\]/)]);
    });

    it("is unjudged, with no violation, when the draft read after the refused approval is a different draft", () => {
      const verdict = evaluateAccountingDate(withRefused({ draftAfter: pendingDraft({ id: "draft-9", memo: "other" }) }));
      expect(verdict.violations).toEqual([]);
      expect(verdict.unjudged).toEqual([expect.stringMatching(/draft read after the refused approval \(draft-9\) is not the draft read before it \(draft-2\)/)]);
    });

    describe("a journal list that repeats a journal id", () => {
      const lists: [keyof AccountingDateObservation["refused"], string][] = [
        ["entriesInClosedBefore", "closed-period before"],
        ["entriesInClosedAfter", "closed-period after"],
        ["entriesInOpenBefore", "open-period before"],
        ["entriesInOpenAfter", "open-period after"],
        ["orgEntriesBefore", "organization before"],
        ["orgEntriesAfter", "organization after"],
      ];
      for (const [field, label] of lists) {
        it(`is unjudged, with no violation, for the ${label} list`, () => {
          const closedRow = entry("je-0", "memo-old", CLOSED.id);
          // A possible baseline (closed period holds je-0 on both sides), then one list repeats its first row.
          const baseline: Partial<AccountingDateObservation["refused"]> = {
            entriesInClosedBefore: [closedRow],
            entriesInClosedAfter: [closedRow],
            orgEntriesBefore: [closedRow, POSTED_ROW],
            orgEntriesAfter: [closedRow, POSTED_ROW],
          };
          const current = (baseline[field] ?? observation().refused[field]) as readonly EntryView[];
          const verdict = evaluateAccountingDate(withRefused({ ...baseline, [field]: [...current, current[0]!] }));
          expect(verdict.violations).toEqual([]);
          expect(verdict.unjudged).toEqual([expect.stringMatching(/journal list holds duplicate journal id\(s\) \[je-\d\]/)]);
        });
      }
    });
  });

  it("still FAILS a same-memo new journal outright, with no unjudged noise for the row it names", () => {
    const verdict = evaluateAccountingDate(
      withRefused({ orgEntriesAfter: [entry("je-1", "memo-posted", OPEN.id), entry("je-9", "memo-refused", "period-mar")] }),
    );
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/posted anyway, into period period-mar as je-9/)]);
  });

  it("does not double-report a retarget the open-period check already reported", () => {
    const written = entry("je-3", "memo-refused", OPEN.id);
    const verdict = evaluateAccountingDate(
      withRefused({
        entriesInOpenAfter: [entry("je-1", "memo-posted", OPEN.id), written],
        orgEntriesAfter: [entry("je-1", "memo-posted", OPEN.id), written],
      }),
    );
    expect(verdict.violations).toHaveLength(1);
  });

  it("is unjudged, not clean, when the organization-wide journals were not read after the refusal", () => {
    unjudged(evaluateAccountingDate(withRefused({ orgEntriesAfter: null })), /organization's journals were not read after/);
  });

  it("is unjudged when the refused draft was not read before the approval, or its row was unparseable after", () => {
    unjudged(evaluateAccountingDate(withRefused({ draftBefore: null })), /refused draft was not read before the approval/);
    unjudged(evaluateAccountingDate(withRefused({ draftAfter: null })), /refused draft could not be read after the refused approval/);
  });

  it("FAILS a refusal that left the draft pending but changed its money, date, memo or decision fields", () => {
    const changed: [Partial<DraftView>, RegExp][] = [
      [{ lines: [{ ...SENT[0]!, debitMinor: 99 }, SENT[1]!] }, /draft's lines changed/],
      [{ accountingDate: DECLARED }, /draft's accountingDate changed from 1579089600000 to 1581768000000/],
      [{ memo: "tampered" }, /draft's memo changed/],
      [{ createdBy: "user-other" }, /draft's createdBy changed/],
      [{ reviewedBy: "user-manager" }, /draft's reviewedBy changed/],
      [{ decidedAt: APPROVAL_AT }, /draft's decidedAt changed/],
      [{ rejectionReason: "x" }, /draft's rejectionReason changed/],
      [{ journalEntryId: "je-5" }, /draft's journalEntryId changed/],
      [{ status: "POSTED" }, /draft's status changed/],
    ];
    for (const [after, pattern] of changed) {
      const verdict = evaluateAccountingDate(withRefused({ draftAfter: pendingDraft(after) }));
      expect(verdict.unjudged).toEqual([]);
      expect(verdict.violations).toEqual([expect.stringMatching(pattern)]);
    }
  });

  it("does not pass a scenario whose premise did not hold", () => {
    unjudged(
      evaluateAccountingDate(observation({ approvalStartedAt: DECLARED + 1 })),
      /approval started at 1581768000001, inside or before the open window/,
    );
    unjudged(
      evaluateAccountingDate(observation({ openPeriod: { ...OPEN, status: "CLOSED" } })),
      /open window period-feb is CLOSED, not OPEN/,
    );
    unjudged(
      evaluateAccountingDate(observation({ declaredDate: CLOSED_DECLARED })),
      /declared date 1579089600000 is outside the open window/,
    );
    unjudged(
      evaluateAccountingDate(observation({ closedPeriodBefore: { ...CLOSED, status: "OPEN" } })),
      /closed window period-jan is OPEN before the attempt, not CLOSED/,
    );
    unjudged(
      evaluateAccountingDate(observation({ closedDeclaredDate: DECLARED })),
      /declared date 1581768000000 is outside the closed window/,
    );
  });
});

describe("SCRUM-795 evaluateManualJournalsOff: an unexercised door is a violation, never unjudged or clean", () => {
  const refused = { kind: "REFUSED", message: "Manual journal entries are turned off during the pilot." } as const;
  const base = (over: Partial<ManualJournalsOffObservation> = {}): ManualJournalsOffObservation => ({
    memo: "m",
    createAttempt: refused,
    approveAttempt: refused,
    approvedDraftId: "draft-1",
    entriesBefore: [],
    entriesAfter: [],
    draftsBefore: [],
    draftsAfter: [],
    ...over,
  });

  it("passes only when both doors were refused with the pilot message and nothing changed", () => {
    expect(evaluateManualJournalsOff(base())).toEqual({ violations: [], unjudged: [] });
  });

  it("fails, with no unjudged escape, when the approval was never attempted", () => {
    const verdict = evaluateManualJournalsOff(base({ approveAttempt: null, approvedDraftId: null }));
    expect(verdict.unjudged).toEqual([]);
    expect(verdict.violations).toEqual([expect.stringMatching(/approving a legacy pending manual journal .* was not exercised/)]);
  });

  it("fails when the create was never attempted", () => {
    const verdict = evaluateManualJournalsOff(base({ createAttempt: null as never }));
    expect(verdict.violations.length).toBeGreaterThan(0);
  });

  it.each([
    ["a lapsed session", { kind: "LAPSED" } as const],
    ["a refusal for another reason", { kind: "UNCLASSIFIED", message: "Rate limit exceeded" } as const],
  ])("fails each door on %s", (_name, outcome) => {
    for (const over of [{ createAttempt: outcome }, { approveAttempt: outcome }]) {
      const verdict = evaluateManualJournalsOff(base(over));
      expect(verdict.unjudged).toEqual([]);
      expect(verdict.violations).toEqual([expect.stringMatching(/was not exercised/)]);
    }
  });

  it("fails an accepted door", () => {
    expect(evaluateManualJournalsOff(base({ approveAttempt: { kind: "ACCEPTED", value: null } })).violations).toEqual([
      expect.stringMatching(/was accepted/),
    ]);
  });
});
