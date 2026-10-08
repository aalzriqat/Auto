import { test, expect } from "@playwright/test";
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
 * (convex/e2eBootstrap.ts, seedLegacyManualJournalDraft). If it is missing this
 * spec FAILS; it never skips the approve check.
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

function refusalCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === "object" && "code" in data) {
    return String((data as { code: unknown }).code);
  }
  return String((error as Error | null)?.message ?? "").includes(REFUSAL_CODE)
    ? REFUSAL_CODE
    : undefined;
}

type Pending = Array<{ _id: Id<"manualJournalDrafts">; memo: string }>;

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
    const approveButtons = await page.getByTestId("approve-draft-btn").all();
    expect(approveButtons.length, "expected the seeded legacy draft's Approve button").toBeGreaterThanOrEqual(1);
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

    // (ii-b) approve of the seeded legacy draft is refused. MANDATORY, never skipped.
    const pending = (await client.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Pending;
    const seeded = pending.find((d) => d.memo === LEGACY_MEMO);
    if (!seeded) {
      throw new Error(
        "fixture missing: e2e bootstrap did not seed the SCRUM-795 legacy draft"
      );
    }
    const approveError = await client
      .mutation(api.financialAudit.approveManualJournal, { orgId, draftId: seeded._id })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(approveError, "approve must be refused").toBeDefined();
    expect(refusalCode(approveError)).toBe(REFUSAL_CODE);

    // Nothing posted: the draft is still pending.
    const after = (await client.query(api.financialAudit.listPendingManualJournals, {
      orgId,
    })) as Pending;
    expect(after.some((d) => d._id === seeded._id)).toBe(true);

    // (i-b) Reject stays enabled for a second finance user (the creator cannot
    // reject their own draft). Looked at, not clicked.
    const approverContext = await browser.newContext({ storageState: APPROVER_AUTH_FILE });
    try {
      const approverPage = await approverContext.newPage();
      await gotoOrgRoute(approverPage, "accounting");
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
