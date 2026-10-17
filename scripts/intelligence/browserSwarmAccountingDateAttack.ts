/**
 * SCRUM-849 ACC-3 — executable ACCOUNTING_DATE_BOUNDARY / STATE_TRANSITION browser attack.
 *
 * Owner invariant: a manual journal posts using the accounting date its preparer declared, and ordinary
 * posting into a closed accounting period is rejected.
 *
 * On the isolated, marker-gated disposable preview, with run-unique synthetic data, the mission drives the
 * product's own public manual-journal commands across two seats (the OWNER prepares, the MANAGER approves:
 * a journal cannot be approved by its poster). It establishes two dedicated 2020 monthly windows far from
 * every other mission's posting date, one OPEN and one CLOSED through the product's own close command, then:
 *   1. declares a date inside the OPEN window, approves, and reads the posted journal back;
 *   2. declares a date inside the CLOSED window, approves, and reads what the backend did.
 * The verdict (browserSwarmAccountingDateOracle.ts) is the server's own journal and period state against
 * dates the scenario chose: the entry and every line carry the declared date, in the period covering it and
 * not the period covering today; the closed-period approval is refused with the closed-period message, the
 * period still CLOSED, no journal anywhere carrying the refused memo, and the draft still pending.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the fail-closed rule) is the shared
 * runBoundaryMission: a read that failed, a setup the product refused, or a premise that did not hold is
 * INCONCLUSIVE or a harness error, never a pass.
 *
 * Not covered, and recorded as such in the evidence: the manual-journal form itself (the commands are the
 * product's public API; the accounting screen is only opened for its screenshot), a LOCKED period, a period
 * that is not yet open or that no period covers, ordinary posting through the accounting outbox, and
 * reopening a closed period. The records the run creates stay in the disposable preview, except that the
 * refused draft is rejected at cleanup so it cannot block a later period close.
 */
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { describeError, probe } from "./browserSwarmBoundaryOracle";
import type { BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { MISSION_TIMING_DEFAULTS, missionCommands, realSleep, type MissionTiming } from "./browserSwarmConsignmentAttack";
import { untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { runBoundaryMission } from "./browserSwarmBoundaryHarness";
import {
  CLOSED_PERIOD_REFUSAL,
  evaluateAccountingDate,
  type DraftView,
  type EntryView,
  type JournalView,
  type PeriodView,
  type SentLine,
} from "./browserSwarmAccountingDateOracle";
import { asArray, inconclusive, isRecord } from "./browserSwarmSeedHelpers";

/**
 * Two adjacent months of 2020, created for this mission only. They sit years before any date another mission
 * posts on, so closing one cannot hold up an economic attack, and the journals this mission posts there cannot
 * be mistaken for another's.
 */
export const ACCOUNTING_DATE_WINDOWS = {
  open: { fiscalYear: 2020, periodNumber: 2, startDate: Date.UTC(2020, 1, 1), endDate: Date.UTC(2020, 2, 1) - 1 },
  closed: { fiscalYear: 2020, periodNumber: 1, startDate: Date.UTC(2020, 0, 1), endDate: Date.UTC(2020, 1, 1) - 1 },
} as const;
export const OPEN_DECLARED_DATE = Date.UTC(2020, 1, 15, 12);
export const CLOSED_DECLARED_DATE = Date.UTC(2020, 0, 15, 12);

/** The journal is balanced at this amount in the minor units of whatever the accounts' currency is. */
const JOURNAL_AMOUNT_MINOR = 12_345;
const ENTRY_PAGE_SIZE = 100;
/** Upper bound on cursor pages read per list, so a backend that never reports `isDone` cannot hold the mission open. */
const MAX_ENTRY_PAGES = 50;

type Window = (typeof ACCOUNTING_DATE_WINDOWS)[keyof typeof ACCOUNTING_DATE_WINDOWS];
type Command = ReturnType<typeof missionCommands>["command"];

function parsePeriod(row: unknown): PeriodView {
  if (!isRecord(row) || typeof row._id !== "string" || typeof row.startDate !== "number" || typeof row.endDate !== "number" || typeof row.status !== "string") {
    return inconclusive("accountingPeriods.list returned a malformed period");
  }
  return { id: row._id, startDate: row.startDate, endDate: row.endDate, status: row.status };
}

async function readPeriods(env: BoundaryMissionEnv, command: Command): Promise<PeriodView[]> {
  const org = env.orgId as Id<"organizations">;
  return asArray(await command(() => env.client.query(api.accountingPeriods.list, { orgId: org })), "accountingPeriods.list").map(parsePeriod);
}

const findWindow = (periods: readonly PeriodView[], window: Window): PeriodView | undefined =>
  periods.find((period) => period.startDate === window.startDate && period.endDate === window.endDate);

/** The window's period as the backend holds it, created through the product's own command when it does not exist yet. */
async function readWindow(env: BoundaryMissionEnv, command: Command, window: Window): Promise<PeriodView> {
  const existing = findWindow(await readPeriods(env, command), window);
  if (existing !== undefined) return existing;
  await command(() =>
    env.client.mutation(api.accountingPeriods.create, {
      orgId: env.orgId as Id<"organizations">,
      fiscalYear: window.fiscalYear,
      periodNumber: window.periodNumber,
      startDate: window.startDate,
      endDate: window.endDate,
      openImmediately: true,
    }),
  );
  const created = findWindow(await readPeriods(env, command), window);
  return created ?? inconclusive(`the period for ${window.fiscalYear}-${window.periodNumber} was not readable after it was created`);
}

/** Closes an OPEN window through the product's own close command, with no override: a window that cannot close cleanly is no premise. */
async function closeWindow(
  env: BoundaryMissionEnv,
  command: Command,
  refusalIsInconclusive: ReturnType<typeof missionCommands>["refusalIsInconclusive"],
  period: PeriodView,
): Promise<boolean> {
  const org = env.orgId as Id<"organizations">;
  const periodId = period.id as Id<"accountingPeriods">;
  const checklist: unknown = await command(() => env.client.query(api.accountingPeriods.closeChecklist, { orgId: org, periodId }));
  if (!isRecord(checklist) || typeof checklist.canClose !== "boolean") return inconclusive("accountingPeriods.closeChecklist returned a malformed response");
  if (!checklist.canClose) {
    env.detail.closeBlockers = checklist.blockers;
    env.unjudged("the closed window could not be closed without an override, so the closed-period boundary could not be set up");
    return false;
  }
  const warnings = asArray(checklist.warnings, "closeChecklist.warnings").filter((warning): warning is string => typeof warning === "string");
  await refusalIsInconclusive(
    () => env.client.mutation(api.accountingPeriods.close, { orgId: org, periodId, acknowledgedWarnings: warnings }),
    "the product refused to close the closed window",
  );
  return true;
}

function parseEntry(row: unknown): EntryView {
  if (!isRecord(row) || typeof row._id !== "string") return inconclusive("listJournalEntries returned a malformed entry");
  return {
    id: row._id,
    status: typeof row.status === "string" ? row.status : null,
    memo: typeof row.memo === "string" ? row.memo : null,
    periodId: typeof row.periodId === "string" ? row.periodId : null,
    accountingDate: typeof row.accountingDate === "number" ? row.accountingDate : null,
  };
}

/**
 * Every journal of one period, or of the whole organization when `periodId` is null, read through the query's own
 * cursor to the last page. A list that is malformed, makes no progress, or outruns the page cap cannot rule an
 * entry out, so it is inconclusive and never a partial answer.
 */
async function readEntries(env: BoundaryMissionEnv, command: Command, periodId: string | null): Promise<EntryView[]> {
  const scope = periodId === null ? "the organization" : `period ${periodId}`;
  const rows: EntryView[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < MAX_ENTRY_PAGES; pageNumber += 1) {
    const requestCursor: string | null = cursor;
    const page: unknown = await command(() =>
      env.client.query(api.accountingLedger.listJournalEntries, {
        orgId: env.orgId as Id<"organizations">,
        ...(periodId === null ? {} : { periodId: periodId as Id<"accountingPeriods"> }),
        paginationOpts: { numItems: ENTRY_PAGE_SIZE, cursor: requestCursor },
      }),
    );
    if (!isRecord(page) || typeof page.isDone !== "boolean") return inconclusive(`the journals of ${scope} came back malformed`);
    rows.push(...asArray(page.page, "listJournalEntries").map(parseEntry));
    if (page.isDone) return rows;
    if (typeof page.continueCursor !== "string" || page.continueCursor === "" || page.continueCursor === requestCursor) {
      return inconclusive(`the journals of ${scope} came back malformed: no cursor to continue from`);
    }
    cursor = page.continueCursor;
  }
  return inconclusive(`the journals of ${scope} could not be read to completion within ${MAX_ENTRY_PAGES} pages`);
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** A pending draft row reduced to what a refusal must not change; null when the row lacks any of it, so nothing is compared. */
function parseDraft(row: Record<string, unknown>): DraftView | null {
  const status = textOrNull(row.status);
  const memo = textOrNull(row.memo);
  const accountingDate = numberOrNull(row.accountingDate);
  const createdBy = textOrNull(row.createdBy);
  if (status === null || memo === null || accountingDate === null || createdBy === null || !Array.isArray(row.lines)) return null;
  const lines: SentLine[] = [];
  for (const line of row.lines as unknown[]) {
    if (!isRecord(line) || typeof line.accountId !== "string" || typeof line.debitMinor !== "number" || typeof line.creditMinor !== "number") return null;
    lines.push({ accountId: line.accountId, debitMinor: line.debitMinor, creditMinor: line.creditMinor });
  }
  return {
    id: String(row._id),
    status,
    memo,
    accountingDate,
    createdBy,
    lines,
    reviewedBy: textOrNull(row.reviewedBy),
    decidedAt: numberOrNull(row.decidedAt),
    rejectionReason: textOrNull(row.rejectionReason),
    journalEntryId: textOrNull(row.journalEntryId),
  };
}

/** The refused draft in the pending list: whether it is listed at all, and its parsed row when it is. */
async function readPendingDraft(env: BoundaryMissionEnv, command: Command, draftId: string): Promise<{ listed: boolean; view: DraftView | null }> {
  const pending: unknown = await command(() => env.client.query(api.financialAudit.listPendingManualJournals, { orgId: env.orgId as Id<"organizations"> }));
  const row = asArray(pending, "listPendingManualJournals").find((candidate) => isRecord(candidate) && candidate._id === draftId);
  return { listed: row !== undefined, view: isRecord(row) ? parseDraft(row) : null };
}

function parseJournal(raw: unknown): JournalView | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !isRecord(raw.entry)) return inconclusive("getJournalEntry returned a malformed response");
  const { entry } = raw;
  return {
    id: String(entry._id),
    status: typeof entry.status === "string" ? entry.status : null,
    memo: typeof entry.memo === "string" ? entry.memo : null,
    accountingDate: typeof entry.accountingDate === "number" ? entry.accountingDate : null,
    periodId: typeof entry.periodId === "string" ? entry.periodId : null,
    lines: asArray(raw.lines, "journal lines").map((line) => {
      if (!isRecord(line) || typeof line.debitMinor !== "number" || typeof line.creditMinor !== "number") {
        return inconclusive("getJournalEntry returned a malformed line");
      }
      return {
        accountId: typeof line.accountId === "string" ? line.accountId : null,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        accountingDate: typeof line.accountingDate === "number" ? line.accountingDate : null,
      };
    }),
  };
}

/** Two active accounts that accept manual posting and name no currency of their own, so the journal is the organization's. */
function manualAccounts(chart: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const account of chart) {
    if (!isRecord(account) || typeof account._id !== "string") continue;
    const unrestricted = account.currencyRestriction === undefined || account.currencyRestriction === null;
    if (account.allowManualPosting === true && account.active === true && unrestricted) ids.push(account._id);
  }
  return ids.sort((left, right) => left.localeCompare(right)).slice(0, 2);
}

export function accountingDateSpec(options: MissionTiming) {
  return {
    attack: "ACCOUNTING_DATE_BOUNDARY",
    seat: "primary" as const,
    oracles: ["STATE_TRANSITION" as const],
    passSummary:
      "A manual journal declared inside an OPEN 2020 window was approved from a second seat and posted to the declared date on its entry and on every line, in the period covering that date and not the period covering today. A second journal declared inside a CLOSED 2020 window was refused with the closed-period message: the period stayed CLOSED, between two complete organization-wide journal reads (every cursor page, taken immediately before and after the refused approval) no journal appeared and no existing journal changed its status, memo, period or date, and its draft stayed pending with its memo, date, lines, preparer and decision fields unchanged. A journal that appeared or changed for any other reason is reported as unjudged, never as a pass. Judged on the server's own journal and period state against dates the scenario chose. Not read: the manual-journal form, a LOCKED period, a period that is not open or that no period covers, outbox posting, and reopening a closed period.",
    breachSummary: "A manual journal did not post to its declared accounting date, or posting into a closed period was not refused",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const { command, refusalIsInconclusive } = missionCommands(env, options);
      detail.notExercised = ["MANUAL_JOURNAL_FORM", "LOCKED_PERIOD", "UNOPENED_OR_UNCOVERED_PERIOD", "OUTBOX_POSTING", "PERIOD_REOPEN"];
      detail.windows = ACCOUNTING_DATE_WINDOWS;

      const approver = await env.openSeat("approver");
      if (approver.orgId !== orgId) {
        env.unjudged("the approver seat signed in to a different organization, so no journal could be approved by a second person; nothing was seeded");
        return;
      }

      const accountIds = manualAccounts(asArray(await command(() => client.query(api.chartOfAccounts.list, { orgId: org })), "chartOfAccounts.list"));
      if (accountIds.length < 2) {
        env.unjudged("the chart holds fewer than two active, currency-free accounts that accept manual posting, so no balanced journal could be submitted; nothing was seeded");
        return;
      }
      const sentLines: SentLine[] = [
        { accountId: accountIds[0]!, debitMinor: JOURNAL_AMOUNT_MINOR, creditMinor: 0 },
        { accountId: accountIds[1]!, debitMinor: 0, creditMinor: JOURNAL_AMOUNT_MINOR },
      ];
      const memos = { posted: `${nonce} declared date`, refused: `${nonce} closed period` };

      // The windows: the closed one is closed BEFORE any draft exists, because a pending draft blocks every period close.
      let closedPeriod = await readWindow(env, command, ACCOUNTING_DATE_WINDOWS.closed);
      if (closedPeriod.status === "OPEN") {
        if (!(await closeWindow(env, command, refusalIsInconclusive, closedPeriod))) return;
        closedPeriod =
          findWindow(await readPeriods(env, command), ACCOUNTING_DATE_WINDOWS.closed) ??
          inconclusive("the closed window was not readable again after it was closed");
      }
      const openPeriod = await readWindow(env, command, ACCOUNTING_DATE_WINDOWS.open);
      detail.periods = { open: openPeriod, closed: closedPeriod };

      const createDraft = (memo: string, key: string, accountingDate: number) =>
        refusalIsInconclusive(
          () => client.mutation(api.financialAudit.createManualJournal, { orgId: org, memo, lines: sentLines.map((line) => ({ ...line, accountId: line.accountId as Id<"chartOfAccounts"> })), idempotencyKey: `${nonce}-${key}`, accountingDate }),
          `the product refused to prepare the ${key} manual journal`,
        );
      const draftIdOf = (created: unknown): Id<"manualJournalDrafts"> =>
        isRecord(created) && typeof created.draftId === "string"
          ? (created.draftId as Id<"manualJournalDrafts">)
          : inconclusive("createManualJournal returned no draft id");

      // 1. A declared date inside the OPEN window posts to that date, approved at today's date by someone else.
      const postedDraft = draftIdOf(await createDraft(memos.posted, "declared", OPEN_DECLARED_DATE));
      const approvalStartedAt = Date.now();
      const approved = await refusalIsInconclusive(
        () => approver.client.mutation(api.financialAudit.approveManualJournal, { orgId: org, draftId: postedDraft }),
        "the product refused to post the journal declared inside the open window",
      );
      const journalId = isRecord(approved) && typeof approved.journalId === "string" ? approved.journalId : inconclusive("approveManualJournal returned no journal id");
      detail.postedJournalId = journalId;
      const journal = parseJournal(await command(() => client.query(api.accountingLedger.getJournalEntry, { orgId: org, journalEntryId: journalId as Id<"journalEntries"> })));

      // 2. A declared date inside the CLOSED window is refused, and the backend is read for anything it did anyway.
      const closedDraft = draftIdOf(await createDraft(memos.refused, "closed", CLOSED_DECLARED_DATE));
      env.onCleanup("reject the refused manual-journal draft", async () => {
        await approver.client.mutation(api.financialAudit.rejectManualJournal, { orgId: org, draftId: closedDraft, rejectionReason: `${nonce} refused by the closed period` });
      });
      detail.closedDraftId = String(closedDraft);
      // Every baseline is read immediately before the approval, after the refused draft exists: a journal that
      // carries its memo can only appear in the "after" reads, and "written" means "absent from the baseline".
      const closedPeriodBefore =
        findWindow(await readPeriods(env, command), ACCOUNTING_DATE_WINDOWS.closed) ??
        inconclusive("the closed window was not readable again before the refused approval");
      const entriesInClosedBefore = await readEntries(env, command, closedPeriod.id);
      const entriesInOpenBefore = await readEntries(env, command, openPeriod.id);
      const orgEntriesBefore = await readEntries(env, command, null);
      const draftBefore = (await readPendingDraft(env, command, closedDraft)).view;
      const approval = await probe(
        () => command(() => approver.client.mutation(api.financialAudit.approveManualJournal, { orgId: org, draftId: closedDraft })),
        CLOSED_PERIOD_REFUSAL,
        signal,
      );
      detail.closedApproval = approval;

      const closedPeriodAfter = findWindow(await readPeriods(env, command), ACCOUNTING_DATE_WINDOWS.closed) ?? null;
      const entriesInClosedAfter = await readEntries(env, command, closedPeriod.id);
      const entriesInOpenAfter = await readEntries(env, command, openPeriod.id);
      const orgEntriesAfter = await readEntries(env, command, null);
      const { listed: draftStillPending, view: draftAfter } = await readPendingDraft(env, command, closedDraft);

      detail.journal = journal;
      const refused = {
        approval,
        closedPeriodAfter,
        entriesInClosedBefore,
        entriesInClosedAfter,
        entriesInOpenBefore,
        entriesInOpenAfter,
        orgEntriesBefore,
        orgEntriesAfter,
        draftBefore,
        draftAfter,
        draftStillPending,
      };
      detail.refused = refused;
      env.judge(
        evaluateAccountingDate({
          declaredDate: OPEN_DECLARED_DATE,
          closedDeclaredDate: CLOSED_DECLARED_DATE,
          approvalStartedAt,
          openPeriod,
          closedPeriodBefore,
          sentLines,
          memos,
          posted: { journal },
          refused,
        }),
      );

      // The screen a dealer sees; its screenshot is part of the mission's evidence. Opened only AFTER the backend
      // state is judged, so a screen that will not load can leave a clean run inconclusive but never hide a proven breach.
      try {
        await untilAborted(signal, page.goto(`/${orgId}/accounting`, { waitUntil: "domcontentloaded", timeout: options.uiSettleMs }));
      } catch (error) {
        if (signal.aborted) throw error;
        env.unjudged(`the accounting screen could not be opened for the screenshot (${describeError(error)})`);
      }
    },
  };
}

export type AccountingDateAttackOptions = Partial<MissionTiming>;

export function createAccountingDateAttackHandlers(
  runtimeApi: MissionBrowserRuntime,
  overrides: AccountingDateAttackOptions = {},
): BrowserAttackHandlerRegistry {
  const options: MissionTiming = {
    sleep: overrides.sleep ?? realSleep,
    pollMs: overrides.pollMs ?? MISSION_TIMING_DEFAULTS.pollMs,
    postingWaitMs: overrides.postingWaitMs ?? MISSION_TIMING_DEFAULTS.postingWaitMs,
    uiSettleMs: overrides.uiSettleMs ?? MISSION_TIMING_DEFAULTS.uiSettleMs,
  };
  return {
    ACCOUNTING_DATE_BOUNDARY: (context) => runBoundaryMission(runtimeApi, context, accountingDateSpec(options)),
  };
}
