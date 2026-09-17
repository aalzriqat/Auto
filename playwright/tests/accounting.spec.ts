import { test, expect } from "@playwright/test";
import { gotoOrgRoute, APPROVER_AUTH_FILE } from "../utils";

test.describe("accounting workspace", () => {
  test("enforces full 10-step manual journal lifecycle across creator and approver identities", async ({
    page,
    browser,
  }) => {
    await gotoOrgRoute(page, "accounting");

    // Verify main page title / heading or container
    await expect(page.getByRole("tab", { name: /overview/i }).first()).toBeVisible();

    // 1. Navigate to Journal section
    await page.getByRole("tab", { name: /journal/i }).first().click();
    await expect(page).toHaveURL(/section=journal/);

    // Switch to Manual Journal sub-view
    const manualTab = page.getByRole("tab", { name: /manual journal/i }).first();
    await expect(manualTab).toBeVisible();
    await manualTab.click();

    // 10-STEP REAL E2E MANUAL JOURNAL FLOW (TASK-ACC-01 / BLOCKER 1):
    const uniqueMemo = `E2E Manual Journal ${Date.now()}`;
    const declaredAccountingDate = "2026-08-15";

    // Step 1: Open New Manual Journal dialog
    const newJournalBtn = page.getByTestId("new-manual-journal-btn");
    await expect(newJournalBtn).toBeVisible();
    await newJournalBtn.click();

    // Step 2: Select an explicit accounting date (e.g. 2026-08-15)
    const dateInput = page.getByTestId("manual-journal-accounting-date");
    await expect(dateInput).toBeVisible();
    await dateInput.fill(declaredAccountingDate);

    // Step 3: Enter unique memo
    const memoInput = page.getByTestId("manual-journal-memo");
    await expect(memoInput).toBeVisible();
    await memoInput.fill(uniqueMemo);

    // Step 4: Enter balanced lines (Debit 100, Credit 100)
    // Line 0: Debit line
    const account0 = page.getByTestId("journal-line-account-0");
    await expect(account0).toBeVisible();
    await account0.click();
    const firstOption = page.locator("[data-testid^='searchable-option-']").first();
    await expect(firstOption).toBeVisible();
    await firstOption.click();

    const debitInput = page.getByTestId("journal-line-amount-0");
    await expect(debitInput).toBeVisible();
    await debitInput.fill("100");

    // Line 1: Credit line
    const account1 = page.getByTestId("journal-line-account-1");
    await expect(account1).toBeVisible();
    await account1.click();
    const secondOption = page.locator("[data-testid^='searchable-option-']").nth(1);
    await expect(secondOption).toBeVisible();
    await secondOption.click();

    const side1 = page.getByTestId("journal-line-side-1");
    await expect(side1).toBeVisible();
    await side1.click();
    await page.getByRole("option", { name: /credit/i }).click();

    const creditInput = page.getByTestId("journal-line-amount-1");
    await expect(creditInput).toBeVisible();
    await creditInput.fill("100");

    // Step 5: Submit draft journal for approval
    const submitBtn = page.getByTestId("submit-manual-journal-btn");
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Verify draft appears in pending list
    const draftCard = page.locator(
      `[data-testid='manual-journal-draft-card'][data-memo='${uniqueMemo}']`
    );
    await expect(draftCard).toBeVisible();

    // Step 6: Review and Approve as approver identity (Segregation of Duties)
    const approverContext = await browser.newContext({
      storageState: APPROVER_AUTH_FILE,
    });
    const approverPage = await approverContext.newPage();
    try {
      await gotoOrgRoute(approverPage, "accounting");
      await approverPage.getByRole("tab", { name: /journal/i }).first().click();
      const approverManualTab = approverPage.getByRole("tab", { name: /manual journal/i }).first();
      await expect(approverManualTab).toBeVisible();
      await approverManualTab.click();

      const approverDraftCard = approverPage.locator(
        `[data-testid='manual-journal-draft-card'][data-memo='${uniqueMemo}']`
      );
      await expect(approverDraftCard).toBeVisible();

      const approveBtn = approverDraftCard.getByTestId("approve-draft-btn");
      await expect(approveBtn).toBeVisible();
      await expect(approveBtn).toBeEnabled();
      await approveBtn.click();

      // Ensure draft is removed from pending list
      await expect(approverDraftCard).not.toBeVisible();
    } finally {
      await approverContext.close();
    }

    // Step 7: Switch to Transaction Register / General Ledger on creator's page
    const registerTab = page.getByRole("tab", { name: /register|general ledger/i }).first();
    await expect(registerTab).toBeVisible();
    await registerTab.click();

    // Step 8: Locate posted GL row matching the unique memo
    const postedEntry = page.locator(
      `[data-testid='journal-entry-row'][data-memo='${uniqueMemo}']`
    );
    await expect(postedEntry).toBeVisible();

    // Step 9: Prove accountingDate is 2026-08-15
    const entryDate = postedEntry.getByTestId("journal-entry-date");
    await expect(entryDate).toBeVisible();
    await expect(entryDate).toContainText("Aug 15, 2026");

    // Step 10: Open entry detail dialog and assert exact period and balanced lines
    const viewLinesBtn = postedEntry.getByTestId("view-entry-lines-btn");
    await expect(viewLinesBtn).toBeVisible();
    await viewLinesBtn.click();

    const dialogMemo = page.getByTestId("dialog-entry-memo");
    await expect(dialogMemo).toBeVisible();
    await expect(dialogMemo).toContainText(uniqueMemo);

    const dialogPeriod = page.getByTestId("dialog-entry-period");
    await expect(dialogPeriod).toBeVisible();
    await expect(dialogPeriod).toContainText(/2026-P8|2026-08/i);

    const lineRows = page.getByTestId("journal-line-row");
    await expect(lineRows).toHaveCount(2);
    await expect(page.getByTestId("line-debit").first()).toContainText("100.00");
    await expect(page.getByTestId("line-credit").last()).toContainText("100.00");

    await page.keyboard.press("Escape");

    // 2. Navigate to Receivables & Payables section
    await page.getByRole("tab", { name: /receivables|claims/i }).first().click();
    await expect(page).toHaveURL(/section=receivables/);

    // 3. Navigate to Cash & Bank section
    await page.getByRole("tab", { name: /cash|bank/i }).first().click();
    await expect(page).toHaveURL(/section=cash/);

    // 4. Navigate to Settings & Chart of Accounts section
    await page.getByRole("tab", { name: /settings|setup/i }).first().click();
    await expect(page).toHaveURL(/section=settings/);

    // Verify Setup tabs / Chart of Accounts status
    await expect(
      page.getByRole("heading", { name: /chart of accounts|accounting/i }).first()
    ).toBeVisible();
  });
});
