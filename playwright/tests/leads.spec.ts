import { test, expect } from "@playwright/test";
import { createCustomer, gotoOrgRoute } from "../utils";

test.describe("leads", () => {
  test("can create a lead tied to a customer", async ({ page }) => {
    const { firstName, lastName } = await createCustomer(page);
    const customerName = `${firstName} ${lastName}`;

    await gotoOrgRoute(page, "leads");
    await page.getByRole("button", { name: "Add Lead", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Add Lead")).toBeVisible();

    // Customer is a custom SearchableSelect (components/ui/searchable-select.tsx):
    // a plain button trigger that opens a popover with an auto-focused search
    // input and a list of plain <button> results — no ARIA combobox/option
    // roles, so type into whatever's focused rather than locating the input.
    await dialog.getByRole("button", { name: "Select a customer" }).click();
    await page.keyboard.type(lastName);
    await dialog.getByRole("button", { name: customerName }).click();

    await dialog.getByRole("button", { name: "Create Lead", exact: true }).click();

    await expect(page.getByText("Lead added successfully")).toBeVisible();
  });
});
