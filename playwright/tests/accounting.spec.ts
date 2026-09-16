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
    if (await manualTab.isVisible()) {
      await manualTab.click();
      // Assert that Accounting Date input exists (TASK-ACC-01)
      await expect(page.getByLabel(/accounting date/i).first()).toBeVisible();
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
