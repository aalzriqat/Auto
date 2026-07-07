import { test, expect } from "@playwright/test";

test.describe("dashboard landing", () => {
  test("a signed-in user lands on an authenticated org route with the top nav visible", async ({ page }) => {
    await page.goto("/dashboard");

    // Role-dependent: owners land on /{orgId}/dashboard, other roles get
    // bounced to their own section (sales/leads/accounting) by OrgProvider.
    await expect(page).toHaveURL(/\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/);
    await expect(page.getByRole("banner")).toBeVisible();
  });
});
