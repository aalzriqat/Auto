import { test, expect } from "@playwright/test";
import { gotoOrgRoute, testDataSuffix } from "../utils";

test.describe("expenses", () => {
  test("can record a new operational expense", async ({ page }) => {
    await gotoOrgRoute(page, "expenses");
    await page
      .getByRole("button", { name: "Record Expense", exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Record Expense" }),
    ).toBeVisible();

    // Date/category/status/payment-method all have valid defaults
    // (today / OTHER / PAID / CASH) — only title and amount are required.
    const title = `Playwright test expense ${testDataSuffix()}`;
    await dialog.getByLabel("Title / Description").fill(title);
    await dialog.getByLabel("Amount ($)").fill("42");

    await dialog
      .getByRole("button", { name: "Record Expense", exact: true })
      .click();

    await expect(
      page.getByText("Expense recorded successfully!"),
    ).toBeVisible();
  });
});
