import { test, expect, type Browser } from "@playwright/test";
import { newContainedContext } from "../containedContext";
import { gotoOrgRoute, APPROVER_AUTH_FILE, resolveOrgId, authenticatedConvexClient } from "../utils";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  decideReplayEnvironment,
  replayOrgRefusals,
  REPLAY_CURRENCY_SCALES,
  type ReplayAttestation,
} from "../fixtures/replayIsolation";

/**
 * SCRUM-795 (SCRUM-50): manual journals are OFF for the narrowed pilot (owner
 * ruling SCRUM-760 c22474 / c22479). This spec proves the OFF state on a REAL
 * backend:
 *   (i)  the UI shows the pilot notice, disables "New manual journal" and every
 *        "Approve", and leaves "Reject" enabled for a legacy pending draft;
 *   (ii) the backend refuses create AND approve with MANUAL_JOURNALS_DISABLED,
 *        and the seeded legacy draft is still pending afterwards.
 *
 * The legacy pending draft is seeded by the E2E bootstrap
 * (convex/e2eBootstrap.ts, seedLegacyManualJournalDraft) ONLY when the bootstrap
 * runs with E2E_SEED_LEGACY_MANUAL_JOURNAL=1, and that is requested ONLY by
 * trusted-main-e2e.yml (scripts/legacyManualJournalSeedScope.test.ts pins it).
 * Why nowhere else:
 *   - browser-attack-swarm.yml runs TRUSTED MAIN's bootstrap script against the
 *     CANDIDATE backend. After merge, a seed request would reach un-rebased PR
 *     backends whose args validator does not know the field and reject it,
 *     failing the bootstrap for every other lane; before merge, main's script
 *     cannot seed at all. Script and backend are the same version only in
 *     trusted-main-e2e (main push, main's backend, its own preview).
 *   - The accounting rehearsal preview must stay UNSEEDED: a pending manual
 *     draft blocks the period-close checklist, which would turn its case P1
 *     (close the only open period) UNPROVEN.
 * So the real-backend approve refusal is MANDATORY where the flag is "1" (a
 * missing draft FAILS there) and is recorded as an explicit "NOT RUN"
 * annotation elsewhere; it is never silently passed. The refusal is sent as the
 * approver seat (a different user from the draft's creator), so it is the pilot
 * switch and not separation of duties.
 *
 * RETIRED (SCRUM-795 switch): the former 10-step lifecycle's steps 1-6 (browser
 * create, second-identity approve), because the pilot build cannot post a manual
 * journal. Steps 7-10 (the GL register row's accounting date, the period label
 * and the balanced debit/credit lines of a POSTED journal) are replayed by the
 * second test below through an owner's opening balance
 * (accountingCutover.postOpeningBalanceDirect), but ONLY inside an isolation
 * boundary (playwright/fixtures/replayIsolation.ts): the replay writes to the
 * books, so it runs only when the backend itself attests, through
 * e2eBootstrap.replayAttestation, that it is a disposable preview and that the
 * organization was created by the trusted seed on it. Production deployments
 * are refused outright. Without that attestation the replay is SKIPPED (shown
 * as skipped, never passed). The trusted-main E2E lane seeds such an org, so the
 * replay can run there once the lane is allowed to run it; every other lane
 * skips. The backend tests are the evidence meanwhile:
 * convex/manualJournalAccountingDate.test.ts and accountingPhase10.test.ts
 * (switch mocked off).
 */
const REFUSAL_CODE = "MANUAL_JOURNALS_DISABLED";
const LEGACY_MEMO = "E2E legacy pending draft (SCRUM-795)";
const LEGACY_SEEDED = process.env.E2E_SEED_LEGACY_MANUAL_JOURNAL === "1";
const NOT_RUN =
  "real-backend approve refusal: this preview is not seeded with the legacy draft (seeded only by trusted-main-e2e; SCRUM-795)";

function refusalCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && "code" in data) {
    return String((data as { code: unknown }).code);
  }
  return String((error as Error | null)?.message ?? "").includes(REFUSAL_CODE)
    ? REFUSAL_CODE
    : undefined;
}

type Pending = Array<{ _id: Id<"manualJournalDrafts">; memo: string; createdBy: Id<"users"> }>;

async function proveLegacyApproveRefused(browser: Browser, orgId: Id<"organizations">): Promise<void> {
  // (ii-b) approve of the seeded legacy draft is refused. MANDATORY where the draft is seeded.
  // Sent as the AUTHORIZED, DISTINCT reviewer (the approver seat), not as the
  // draft's creator, so the refusal is the pilot switch and nothing else.
  const approverContext = await newContainedContext(browser, { storageState: APPROVER_AUTH_FILE });
  try {
    const approverPage = await approverContext.newPage();
    await gotoOrgRoute(approverPage, "accounting");
    const approverClient = await authenticatedConvexClient(approverPage);

    const pending = (await approverClient.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Pending;
    const seeded = pending.find((d) => d.memo === LEGACY_MEMO);
    if (!seeded) {
      throw new Error(
        "fixture missing: e2e bootstrap did not seed the SCRUM-795 legacy draft (run the bootstrap with E2E_SEED_LEGACY_MANUAL_JOURNAL=1)"
      );
    }
    const approverMe = (await approverClient.query(api.users.getMe, {})) as { _id: Id<"users"> };
    expect(approverMe._id, "the approver must be a different user from the draft's creator").not.toBe(
      seeded.createdBy
    );

    const approveError = await approverClient
      .mutation(api.financialAudit.approveManualJournal, { orgId, draftId: seeded._id })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(approveError, "approve must be refused").toBeDefined();
    expect(refusalCode(approveError)).toBe(REFUSAL_CODE);

    // Nothing posted: the draft is still pending.
    const after = (await approverClient.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Pending;
    expect(after.some((d) => d._id === seeded._id)).toBe(true);

    // (i-b) Reject stays enabled for a second finance user (the creator cannot
    // reject their own draft). Looked at, not clicked.
    await approverPage.getByRole("tab", { name: /journal/i }).first().click();
    await approverPage.getByRole("tab", { name: /manual journal/i }).first().click();
    const card = approverPage.locator(
      `[data-testid='manual-journal-draft-card'][data-memo='${LEGACY_MEMO}']`
    );
    await expect(card).toBeVisible();
    await expect(card.getByTestId("reject-draft-btn")).toBeEnabled();
    await expect(card.getByTestId("approve-draft-btn")).toBeDisabled();
  } finally {
    await approverContext.close();
  }
}

test.describe("accounting workspace", () => {
  test("manual journals are off for the pilot: notice in the UI, refusal from the backend", async ({
    page,
    browser,
  }) => {
    await gotoOrgRoute(page, "accounting");
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const client = await authenticatedConvexClient(page);

    await expect(page.getByRole("tab", { name: /overview/i }).first()).toBeVisible();

    await page.getByRole("tab", { name: /journal/i }).first().click();
    await expect(page).toHaveURL(/section=journal/);
    const manualTab = page.getByRole("tab", { name: /manual journal/i }).first();
    await expect(manualTab).toBeVisible();
    await manualTab.click();

    // (i) UI as the creator: notice, New disabled, at least one Approve and all disabled.
    await expect(page.getByTestId("manual-journals-pilot-off-notice")).toBeVisible();
    await expect(page.getByTestId("new-manual-journal-btn")).toBeDisabled();
    if (LEGACY_SEEDED) {
      await expect(
        page.locator(`[data-testid='manual-journal-draft-card'][data-memo='${LEGACY_MEMO}']`)
      ).toBeVisible();
    }
    const approveButtons = await page.getByTestId("approve-draft-btn").all();
    if (LEGACY_SEEDED) {
      expect(approveButtons.length, "expected the seeded legacy draft's Approve button").toBeGreaterThanOrEqual(1);
    }
    for (const approve of approveButtons) {
      await expect(approve).toBeDisabled();
    }

    // (ii-a) create is refused by the backend whatever the UI does.
    const accounts = (await client.query(api.chartOfAccounts.list, { orgId })) as Array<{
      _id: Id<"chartOfAccounts">;
      allowManualPosting: boolean;
    }>;
    const manual = accounts.filter((a) => a.allowManualPosting);
    expect(manual.length).toBeGreaterThanOrEqual(2);
    const createError = await client
      .mutation(api.financialAudit.createManualJournal, {
        orgId,
        memo: `E2E manual journal refused ${Date.now()}`,
        accountingDate: Date.now(),
        idempotencyKey: `e2e-scrum795-${Date.now()}`,
        lines: [
          { accountId: manual[0]._id, debitMinor: 10_000, creditMinor: 0 },
          { accountId: manual[1]._id, debitMinor: 0, creditMinor: 10_000 },
        ],
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(createError, "create must be refused").toBeDefined();
    expect(refusalCode(createError)).toBe(REFUSAL_CODE);

    // (ii-b) the real-backend approve refusal needs the seeded legacy draft.
    if (LEGACY_SEEDED) {
      await proveLegacyApproveRefused(browser, orgId);
    } else {
      test.info().annotations.push({ type: "NOT RUN", description: NOT_RUN });
      console.warn(NOT_RUN);
    }

    // The rest of the accounting workspace still navigates.
    await page.getByRole("tab", { name: /receivables|claims/i }).first().click();
    await expect(page).toHaveURL(/section=receivables/);

    await page.getByRole("tab", { name: /cash|bank/i }).first().click();
    await expect(page).toHaveURL(/section=cash/);

    await page.getByRole("tab", { name: /settings|setup/i }).first().click();
    await expect(page).toHaveURL(/section=settings/);

    await expect(
      page.getByRole("heading", { name: /chart of accounts|accounting/i }).first()
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Posted-row replay (formerly steps 7-10 of the retired manual-journal lifecycle)
// ---------------------------------------------------------------------------

type JournalRow = {
  _id: Id<"journalEntries">;
  status: string;
  memo: string;
  accountingDate: number;
};
type JournalDetail = {
  entry: { _id: Id<"journalEntries">; memo: string; currency?: string; accountingDate: number; periodId?: Id<"accountingPeriods">; status: string };
  period: { fiscalYear: number; periodNumber: number; startDate: number; endDate: number } | null;
  lines: Array<{ debitMinor: number; creditMinor: number; accountingDate?: number; scale?: number }>;
};

// Written out by hand, never taken from the product: 15 Aug 2026 12:00 UTC, in
// the 2026 period 8 window (1 Aug 00:00 UTC to 31 Aug 23:59:59.999 UTC).
const OPENING_DATE = Date.UTC(2026, 7, 15, 12);
const OPENING_UNITS = 100;

/** Every journal of the organization, in any status, read through the query's own cursor to the last page. */
async function listAllJournals(
  client: Awaited<ReturnType<typeof authenticatedConvexClient>>,
  orgId: Id<"organizations">
): Promise<JournalRow[]> {
  const rows: JournalRow[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 500; pageNumber += 1) {
    const page: { page: JournalRow[]; isDone: boolean; continueCursor: string } = await client.query(
      api.accountingLedger.listJournalEntries,
      { orgId, paginationOpts: { numItems: 200, cursor } }
    );
    rows.push(...page.page);
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
  throw new Error("the journal list could not be read to completion within 500 pages");
}

test.describe("accounting register: a posted journal", () => {
  test("shows its accounting date, period and balanced debit/credit totals", async ({ page }) => {
    // 1. ISOLATION BOUNDARY. This replay WRITES to the books (creating a period wakes held rows and schedules
    //    outbox work; the opening balance is a posted journal), so it runs only when the BACKEND ITSELF attests,
    //    over the connection this test uses, that it is a disposable preview and that the organization was
    //    created by the trusted seed on it (e2eBootstrap.replayAttestation: preview class, marker minted on this
    //    deployment, org bound to the marker and created after it). An operator-supplied name is not trusted.
    //    A refused guard (production, or URL/backend/marker disagree) FAILS. Without the attestation the replay
    //    is SKIPPED, which the report shows as skipped (never passed); that is unavailable evidence, not
    //    certification, and the backend tests stay the evidence. See replayIsolation.ts and its unit test.
    await gotoOrgRoute(page, "accounting");
    const orgId = (await resolveOrgId(page)) as Id<"organizations">;
    const client = await authenticatedConvexClient(page);
    const attestation = await client
      .query(api.e2eBootstrap.replayAttestation, { orgId })
      .then(
        (value) => value as ReplayAttestation,
        () => null
      );
    const environment = decideReplayEnvironment(
      process.env.NEXT_PUBLIC_CONVEX_URL,
      attestation,
      process.env.E2E_REPLAY_DEDICATED_ORG === "1"
    );
    if (environment.kind === "REFUSED") throw new Error(`GL register replay refused: ${environment.reason}`);
    test.skip(environment.kind === "NOT_RUN", `GL register replay not run: ${environment.kind === "NOT_RUN" ? environment.reason : ""}`);

    // Every read happens BEFORE the first write. The organization must be freshly created: no period, no
    // journal in any status (POSTED and REVERSED included, the mutation's own refusal rule), no opening
    // balance, a supported currency and two usable accounts. Anything else FAILS; it never skips.
    const allJournals = await listAllJournals(client, orgId);
    const status = (await client.query(api.accountingCutover.openingBalanceStatus, { orgId })) as {
      posted: boolean;
      pendingDraftId: string | null;
      canPostDirectly: boolean;
      currency: string;
    };
    const periods = (await client.query(api.accountingPeriods.list, { orgId })) as Array<{ _id: Id<"accountingPeriods"> }>;
    const accounts = (await client.query(api.chartOfAccounts.list, { orgId })) as Array<{
      _id: Id<"chartOfAccounts">;
      allowManualPosting: boolean;
      active: boolean;
    }>;
    const usable = accounts.filter((a) => a.allowManualPosting && a.active);
    const refusals = replayOrgRefusals({
      currency: status.currency,
      periodCount: periods.length,
      journalCount: allJournals.length,
      openingBalancePosted: status.posted,
      pendingOpeningDraft: status.pendingDraftId !== null,
      canPostDirectly: status.canPostDirectly,
      usableAccountCount: usable.length,
    });
    expect(refusals, "the GL register replay needs a freshly created disposable organization").toEqual([]);

    // 2. The writes: a period for the date, then an owner's opening balance with hand-written literals.
    const periodId = (await client.mutation(api.accountingPeriods.create, {
      orgId,
      fiscalYear: 2026,
      periodNumber: 8,
      startDate: Date.UTC(2026, 7, 1, 0, 0, 0, 0),
      endDate: Date.UTC(2026, 8, 0, 23, 59, 59, 999),
      openImmediately: true,
    })) as Id<"accountingPeriods">;
    const minor = OPENING_UNITS * 10 ** REPLAY_CURRENCY_SCALES[status.currency]!;
    const memo = `E2E opening balance register replay ${Date.now()}`;
    await client.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId,
      asOfDate: OPENING_DATE,
      memo,
      expectedCurrency: status.currency,
      lines: [
        { accountId: usable[0]._id, debitMinor: minor, creditMinor: 0 },
        { accountId: usable[1]._id, debitMinor: 0, creditMinor: minor },
      ],
    });
    const known = { memo, debitMinor: minor, date: OPENING_DATE, periodId };
    const posted = (await listAllJournals(client, orgId)).filter((row) => row.status === "POSTED");
    const target = posted.find((row) => row.memo === known.memo);
    expect(target, "the opening balance this test posted must be listed").toBeDefined();

    // 2. What the backend holds for it, and the invariants that must hold whatever its source.
    const detail = (await client.query(api.accountingLedger.getJournalEntry, {
      orgId,
      journalEntryId: target!._id,
    })) as JournalDetail | null;
    expect(detail, "the posted journal must be readable").not.toBeNull();
    const { entry, period, lines } = detail!;
    expect(period, "a posted journal sits in an accounting period").not.toBeNull();
    expect(entry.accountingDate).toBeGreaterThanOrEqual(period!.startDate);
    expect(entry.accountingDate).toBeLessThanOrEqual(period!.endDate);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.accountingDate).toBe(entry.accountingDate);
    const debitMinor = lines.reduce((sum, line) => sum + line.debitMinor, 0);
    const creditMinor = lines.reduce((sum, line) => sum + line.creditMinor, 0);
    expect(debitMinor).toBeGreaterThan(0);
    expect(debitMinor, "debits equal credits").toBe(creditMinor);
    // The journal this test posted: every figure is a hand-written literal.
    expect(entry.accountingDate).toBe(known.date);
    expect(entry.periodId).toBe(known.periodId);
    expect(period!.fiscalYear).toBe(2026);
    expect(period!.periodNumber).toBe(8);
    expect(debitMinor).toBe(known.debitMinor);
    expect(creditMinor).toBe(known.debitMinor);

    // 3. The register shows the same date, period and lines.
    await page.getByRole("tab", { name: /journal/i }).first().click();
    const registerTab = page.getByRole("tab", { name: /register|general ledger/i }).first();
    await expect(registerTab).toBeVisible();
    await registerTab.click();

    const row = page.locator(`[data-testid='journal-entry-row'][data-entry-id='${entry._id}']`);
    for (let loads = 0; loads < 500 && !(await row.isVisible()); loads += 1) {
      const more = page.getByTestId("gl-load-more-btn");
      if (!(await more.isVisible())) break;
      await more.click();
    }
    await expect(row).toBeVisible();
    await expect(row.getByTestId("journal-entry-date")).toContainText(
      new Date(entry.accountingDate).toLocaleDateString("en-US")
    );

    await row.getByTestId("view-entry-lines-btn").click();
    await expect(page.getByTestId("dialog-entry-memo")).toContainText(entry.memo);
    await expect(page.getByTestId("dialog-entry-period")).toContainText(
      `${period!.fiscalYear}-P${period!.periodNumber}`
    );
    const lineRows = page.getByTestId("journal-line-row");
    await expect(lineRows).toHaveCount(lines.length);

    // Debit and credit columns, summed off the screen, equal the backend's totals in major units.
    const scale = lines[0].scale ?? REPLAY_CURRENCY_SCALES[entry.currency ?? ""] ?? Number.NaN;
    const columnTotal = async (testId: "line-debit" | "line-credit"): Promise<number> => {
      const texts = await page.getByTestId(testId).allTextContents();
      return texts.reduce((sum, text) => {
        const amount = Number(text.replace(/[^0-9.]/g, ""));
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0);
    };
    expect(await columnTotal("line-debit")).toBeCloseTo(debitMinor / 10 ** scale, scale);
    expect(await columnTotal("line-credit")).toBeCloseTo(creditMinor / 10 ** scale, scale);

    await page.keyboard.press("Escape");
  });
});
