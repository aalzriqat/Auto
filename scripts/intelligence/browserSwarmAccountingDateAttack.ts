/**
 * SCRUM-849 ACC-3 / SCRUM-795 — executable ACCOUNTING_DATE_BOUNDARY / STATE_TRANSITION browser attack.
 *
 * RETARGETED by SCRUM-795 (owner ruling SCRUM-760 c22474): manual journals are OFF for the pilot, so the
 * original "declare a date, approve, read the posted date" lifecycle can no longer run. The mission keeps its
 * registered name and now proves the CREATE door of the OFF state on the isolated, marker-gated disposable
 * preview, through the product's own public command, as the OWNER seat:
 *   1. createManualJournal, with a well-formed balanced request and a declared date, is refused with the
 *      pilot message (MANUAL_JOURNALS_DISABLED) and not for any other reason;
 *   2. between two complete organization-wide journal reads and two reads of the pending list, no journal
 *      appears, none changes, no draft appears, and every pending draft keeps its fields and stays pending.
 *
 * SCOPE: THE APPROVE DOOR IS NOT CLAIMED HERE. The swarm lane runs trusted main's mission against the candidate
 * backend and never holds the legacy pending draft: that draft is seeded only by trusted-main E2E
 * (scripts/legacyManualJournalSeedScope.test.ts pins it, and that pin is deliberately not widened). The
 * approveManualJournal refusal is covered by convex/manualJournalsPilotOff.scrum795.test.ts and by the trusted-main
 * Playwright spec (playwright/tests/accounting.spec.ts, proveLegacyApproveRefused), not by this mission.
 *
 * CANNOT RUN IS FAIL (AGENTS.md: a scenario that cannot run is a failure, never a skip) for everything the mission
 * claims. A chart with no usable accounts, a lapsed session, a refusal for any other reason, or a journal or pending
 * list that cannot be read on either side leaves the claim unobserved and the mission FAILS (oracle.passed = false),
 * never INCONCLUSIVE and never a pass.
 *
 * Not covered, and recorded as such in the evidence: the approve door (above), the manual-journal form (the
 * commands are the product's public API; the accounting screen is only opened for its screenshot), the
 * declared-date and closed-period posting rules (proven against the enabled code with the switch mocked off in
 * convex/manualJournalAccountingDate.test.ts), a LOCKED period, outbox posting and reopening a closed period. The
 * original date/period judgement stays in browserSwarmAccountingDateOracle.ts (evaluateAccountingDate) for the day
 * the switch is lifted.
 *
 * The mission lifecycle (egress-contained browser, evidence, cleanup and the fail-closed rule) is the shared
 * runBoundaryMission.
 */
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { describeError, probe, type Judgement, type ProbeOutcome } from "./browserSwarmBoundaryOracle";
import type { BoundaryMissionEnv } from "./browserSwarmBoundaryHarness";
import type { BrowserAttackHandlerRegistry } from "./browserAttackSwarmExecutor";
import { MISSION_TIMING_DEFAULTS, missionCommands, realSleep, type MissionTiming } from "./browserSwarmConsignmentAttack";
import { untilAborted, type MissionBrowserRuntime } from "./browserSwarmEconomicAttacks";
import { runBoundaryMission } from "./browserSwarmBoundaryHarness";
import {
  evaluateManualJournalsOff,
  MANUAL_JOURNALS_DISABLED_REFUSAL,
  type DraftView,
  type EntryView,
  type SentLine,
} from "./browserSwarmAccountingDateOracle";
import { asArray, inconclusive, isRecord } from "./browserSwarmSeedHelpers";

/** The date the refused create declares. It only has to be a plausible date: the refusal must not depend on it. */
export const REFUSED_CREATE_DECLARED_DATE = Date.UTC(2020, 1, 15, 12);

/** The journal is balanced at this amount in the minor units of whatever the accounts' currency is. */
const JOURNAL_AMOUNT_MINOR = 12_345;
const ENTRY_PAGE_SIZE = 100;
/** Upper bound on cursor pages read per list, so a backend that never reports `isDone` cannot hold the mission open. */
const MAX_ENTRY_PAGES = 50;

type Command = ReturnType<typeof missionCommands>["command"];

/** A row read for this mission must belong to the mission's own organization; a row that names another tenant (or none) is never evidence. */
function assertTenantRow(row: Record<string, unknown>, orgId: string, what: string): void {
  if (row.orgId !== orgId) return inconclusive(`${what} returned a row that does not belong to the mission's organization`);
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
    rows.push(
      ...asArray(page.page, "listJournalEntries").map((row) => {
        if (isRecord(row)) assertTenantRow(row, env.orgId, "listJournalEntries");
        return parseEntry(row);
      }),
    );
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

/** Every pending draft of the organization, parsed; null when any row cannot be reduced to what a refusal must not change. */
async function readPendingDrafts(env: BoundaryMissionEnv, command: Command): Promise<DraftView[] | null> {
  const pending: unknown = await command(() => env.client.query(api.financialAudit.listPendingManualJournals, { orgId: env.orgId as Id<"organizations"> }));
  const views = asArray(pending, "listPendingManualJournals").map((row) => {
    if (!isRecord(row)) return null;
    assertTenantRow(row, env.orgId, "listPendingManualJournals");
    return parseDraft(row);
  });
  return views.every((view): view is DraftView => view !== null) ? views : null;
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

/** A door the mission could not exercise: a failure, because a scenario that cannot run is never a skip. */
const notExercised = (reason: string): Judgement => ({ violations: [`${reason}; the refusal this mission requires was never observed`], unjudged: [] });

export function accountingDateSpec(options: MissionTiming) {
  return {
    attack: "ACCOUNTING_DATE_BOUNDARY",
    seat: "primary" as const,
    oracles: ["STATE_TRANSITION" as const],
    passSummary:
      "With manual journals off for the pilot, createManualJournal was refused with the pilot message. Between two complete organization-wide journal reads and two reads of the pending list, no journal appeared or changed and no draft appeared; every pending draft kept its fields and stayed pending. A journal or draft that appeared or changed for any other reason is reported as unjudged, never as a pass. Not read: the approveManualJournal door (covered by convex/manualJournalsPilotOff.scrum795.test.ts and the trusted-main E2E, not this mission), the manual-journal form, the declared-date and closed-period posting rules (disabled for the pilot), a LOCKED period, outbox posting, and reopening a closed period.",
    breachSummary: "Manual journals off for the pilot was not proven: the create door was accepted or never exercised, a read it needs failed (a mission that cannot run fails), or the refusal still changed journals or drafts",
    async run(env: BoundaryMissionEnv): Promise<void> {
      const { client, orgId, nonce, signal, detail, page } = env;
      const org = orgId as Id<"organizations">;
      const { command } = missionCommands(env, options);
      detail.notExercised = ["APPROVE_DOOR", "MANUAL_JOURNAL_FORM", "POSTING_RULES_WHILE_OFF", "LOCKED_PERIOD", "OUTBOX_POSTING", "PERIOD_REOPEN"];

      const accountIds = manualAccounts(asArray(await command(() => client.query(api.chartOfAccounts.list, { orgId: org })), "chartOfAccounts.list"));
      if (accountIds.length < 2) {
        env.judge(notExercised("the chart holds fewer than two active, currency-free accounts that accept manual posting, so no well-formed journal could be attempted and nothing was attempted"));
        return;
      }
      const sentLines: SentLine[] = [
        { accountId: accountIds[0]!, debitMinor: JOURNAL_AMOUNT_MINOR, creditMinor: 0 },
        { accountId: accountIds[1]!, debitMinor: 0, creditMinor: JOURNAL_AMOUNT_MINOR },
      ];
      const memo = `${nonce} manual journal while off`;

      // Baselines, read immediately before the first attempt.
      // A read that fails is null, and the oracle turns a null into a violation: the mission claims an unchanged ledger.
      const readSafely = async <T>(label: string, read: () => Promise<T>): Promise<T | null> => {
        try {
          return await read();
        } catch (error) {
          if (signal.aborted) throw error;
          detail[`readFailure${label}`] = describeError(error);
          return null;
        }
      };
      const entriesBefore = await readSafely("EntriesBefore", () => readEntries(env, command, null));
      const draftsBefore = await readSafely("DraftsBefore", () => readPendingDrafts(env, command));

      const createAttempt: ProbeOutcome = await probe(
        () =>
          client.mutation(api.financialAudit.createManualJournal, {
            orgId: org,
            memo,
            lines: sentLines.map((line) => ({ ...line, accountId: line.accountId as Id<"chartOfAccounts"> })),
            idempotencyKey: `${nonce}-off`,
            accountingDate: REFUSED_CREATE_DECLARED_DATE,
          }),
        MANUAL_JOURNALS_DISABLED_REFUSAL,
        signal,
      );
      detail.createAttempt = createAttempt;

      const entriesAfter = await readSafely("EntriesAfter", () => readEntries(env, command, null));
      const draftsAfter = await readSafely("DraftsAfter", () => readPendingDrafts(env, command));
      env.judge(
        evaluateManualJournalsOff({
          memo,
          createAttempt,
          entriesBefore,
          entriesAfter,
          draftsBefore,
          draftsAfter,
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
