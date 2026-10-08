import { test, expect, type Browser } from "@playwright/test";
import { gotoOrgRoute, APPROVER_AUTH_FILE, resolveOrgId, authenticatedConvexClient } from "../utils";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

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
 * RETIRED (SCRUM-795 switch): the former 10-step lifecycle. Steps 1-6 (browser
 * create, second-identity approve) and steps 7-10 (the GL register row, date,
 * period label and line rendering of a posted MANUAL journal) cannot run because
 * the pilot build cannot post a manual journal. No other Playwright spec replays
 * the GL register date/period/line rendering; GeneralLedgerTabCurrency.test.tsx
 * covers currency/scale and pagination only. The enabled backend behaviour stays
 * proven with the switch mocked off (convex/manualJournalAccountingDate.test.ts,
 * accountingPhase10.test.ts).
 * FOLLOW-UP: SCRUM-800 GL register browser replay using an automated posting.
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
  const approverContext = await browser.newContext({ storageState: APPROVER_AUTH_FILE });
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
