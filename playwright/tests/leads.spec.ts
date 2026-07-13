import { test, expect } from "@playwright/test";
import { createCustomer, gotoOrgRoute } from "../utils";

test.describe("leads", () => {
  test("can create a lead tied to a customer", async ({ page }) => {
    const { firstName, lastName } = await createCustomer(page);
    const customerName = `${firstName} ${lastName}`;

    await gotoOrgRoute(page, "leads");
    await page.getByRole("button", { name: "Add Lead", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Add Lead" }),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Select customer" }).click();
    await dialog.locator('input[placeholder^="Search"]').fill(lastName);
    const customerOption = dialog.getByRole("button", { name: customerName });
    await expect(customerOption).toBeVisible({ timeout: 30_000 });
    await customerOption.click();

    await dialog.getByRole("button", { name: "Add Lead", exact: true }).click();

    await expect(page.getByText("Lead added successfully")).toBeVisible();
  });
});
