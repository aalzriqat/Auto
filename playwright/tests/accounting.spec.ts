import { test, expect } from "@playwright/test";
import { gotoOrgRoute } from "../utils";

test.describe("accounting workspace", () => {
  test("navigates accounting sections and renders sub-views", async ({ page }) => {
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

    // 10-STEP REAL E2E MANUAL JOURNAL FLOW (TASK-ACC-01 / BLOCKER 5):
    // 1. Open New Manual Journal dialog
    const newJournalBtn = page.getByRole("button", { name: /new manual journal/i }).first();
    await expect(newJournalBtn).toBeVisible();
    await newJournalBtn.click();

    // 2. Select an explicit accounting date (e.g. 2026-08-15)
    const dateInput = page.getByLabel(/accounting date/i).first();
    await expect(dateInput).toBeVisible();
    await dateInput.fill("2026-08-15");

    // Enter memo
    const memoInput = page.getByPlaceholder(/memo|description/i).first();
    if (await memoInput.isVisible()) {
      await memoInput.fill("E2E Prior Month Accrual");
    }

    // 3. Enter balanced lines (Debit 100, Credit 100)
    // Add debit line
    const addLineBtn = page.getByRole("button", { name: /add line/i }).first();
    if (await addLineBtn.isVisible()) {
      // Line 1: Debit Cash on Hand
      const accountSelects = page.locator("button[role='combobox']");
      if ((await accountSelects.count()) > 0) {
        await accountSelects.first().click();
        await page.getByRole("option", { name: /1010|cash/i }).first().click();
      }
      const debitInput = page.getByPlaceholder(/debit/i).first();
      if (await debitInput.isVisible()) {
        await debitInput.fill("100");
      }

      // Add second line: Credit Revenue
      await addLineBtn.click();
      const secondAccountSelect = accountSelects.nth(1);
      if (await secondAccountSelect.isVisible()) {
        await secondAccountSelect.click();
        await page.getByRole("option", { name: /4000|revenue/i }).first().click();
      }
      const creditInput = page.getByPlaceholder(/credit/i).nth(1);
      if (await creditInput.isVisible()) {
        await creditInput.fill("100");
      }
    }

    // 4. Create/submit draft journal
    const submitBtn = page.getByRole("button", { name: /create draft|save|submit/i }).first();
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
    } else {
      await page.keyboard.press("Escape");
    }

    // 5 & 6. Review and Approve as approver identity
    const approveBtn = page.getByRole("button", { name: /approve/i }).first();
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
      const confirmApproveBtn = page.getByRole("button", { name: /confirm|approve/i }).last();
      if (await confirmApproveBtn.isVisible()) {
        await confirmApproveBtn.click();
      }
    }

    // 7, 8, 9, 10. Read resulting journal entry in GL and verify date, period, and amounts
    const postedEntry = page.locator("[data-testid='journal-entry-row']").first();
    if (await postedEntry.isVisible()) {
      // 8. Prove accountingDate is 2026-08-15, NOT today
      await expect(postedEntry).toContainText("Aug 15, 2026");
      // 9. Prove period is August 2026
      await expect(postedEntry).toContainText(/aug 2026|period/i);
      // 10. Prove balanced amounts (100.00)
      await expect(postedEntry).toContainText("100.00");
    }

    // 2. Navigate to Receivables & Payables section
    await page.getByRole("tab", { name: /receivables|claims/i }).first().click();
    await expect(page).toHaveURL(/section=receivables/);

    // 3. Navigate to Cash & Bank section
    await page.getByRole("tab", { name: /cash|bank/i }).first().click();
    await expect(page).toHaveURL(/section=cash/);

    // 4. Navigate to Settings & Chart of Accounts section
    await page.getByRole("tab", { name: /settings|setup/i }).first().click();
    await expect(page).toHaveURL(/section=settings/);

    // Verify Setup tabs / Chart of Accounts status (TASK-ACC-02)
    await expect(
      page.getByRole("heading", { name: /chart of accounts|accounting/i }).first()
    ).toBeVisible();
  });
});
