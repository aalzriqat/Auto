import { test, expect } from "@playwright/test";
import { createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";

test.describe("sales", () => {
  test("can record a cash sale end to end via the sales wizard", async ({ page }) => {
    // Self-contained: creates its own vehicle+customer rather than picking
    // from whatever real inventory exists in the shared QA org, so this test
    // never depletes stock and never depends on other specs' run order.
    const { model } = await createVehicle(page);
    const lastName = `Buyer-${testDataSuffix()}`;

    await gotoOrgRoute(page, "sales");
    await page.locator("#btn-new-cash-sale").click();

    // Step 1 — vehicle + price
    await page.getByRole("button", { name: /Select an available vehicle/ }).click();
    await page.keyboard.type(model);
    await page.getByRole("button", { name: new RegExp(model) }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2 — customer (inline create form uses hard-coded English labels,
    // not t(), so these are stable regardless of app locale)
    await page.getByRole("button", { name: "Create a new customer", exact: true }).click();
    await page.getByLabel("First Name", { exact: true }).fill("Playwright");
    await page.getByLabel("Last Name", { exact: true }).fill(lastName);
    await page.getByRole("button", { name: "Create & Select", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 3 — review + generate the quote (this only creates a Quote row,
    // not a Sale yet — completeFromQuote below is what actually sells it)
    await page.getByRole("button", { name: "Generate Quote", exact: true }).click();
    await expect(page.getByText("Quote generated and saved!")).toBeVisible();

    // Step 4 — complete the sale. "Done & Close" alone (as the old
    // TestSprite-generated TC009 script did) only closes the wizard after a
    // quote — it never calls sales.completeFromQuote, so no sale is actually
    // recorded unless "Submit Sale" is clicked.
    await expect(page.getByText("Quote Generated Successfully!")).toBeVisible();
    await page.getByRole("button", { name: "Submit Sale", exact: true }).click();

    await expect(page.getByText("Cash sale completed successfully")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sale Completed ✓" })).toBeVisible();
  });
});
