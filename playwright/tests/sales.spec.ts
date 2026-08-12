import { test, expect } from "@playwright/test";
import { createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";

test.describe("sales", () => {
  test("can record a cash sale end to end via the sales wizard", async ({
    page,
  }) => {
    // Self-contained: creates its own vehicle+customer rather than picking
    // from whatever real inventory exists in the shared QA org, so this test
    // never depletes stock and never depends on other specs' run order.
    const { model } = await createVehicle(page);
    const lastName = `Buyer-${testDataSuffix()}`;

    await gotoOrgRoute(page, "sales");
    await page.locator("#btn-new-cash-sale").click();

    // Step 1 — vehicle + price
    await page
      .getByRole("button", { name: /Select an available vehicle/ })
      .click();
    await page.keyboard.type(model);
    await page.getByRole("button", { name: new RegExp(model) }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 2 — customer (inline create form uses hard-coded English labels,
    // not t(), so these are stable regardless of app locale)
    await page
      .getByRole("button", { name: "Create a new customer", exact: true })
      .click();
    await page.getByRole("textbox", { name: /First Name/ }).fill("Playwright");
    await page.getByRole("textbox", { name: /Last Name/ }).fill(lastName);
    await page
      .getByRole("button", { name: "Create & Select", exact: true })
      .click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Step 3 — review + generate the quote (this only creates a Quote row,
    // not a Sale yet — completeFromQuote below is what actually sells it)
    await page
      .getByRole("button", { name: "Generate Quote", exact: true })
      .click();
    await expect(page.getByText("Quote generated and saved!")).toBeVisible();

    // Step 4 — complete the sale. "Done & Close" alone only closes the wizard
    // after a quote — it never calls sales.completeFromQuote, so no sale is
    // actually recorded unless "Submit Sale" is clicked.
    await expect(page.getByText("Quote Generated Successfully!")).toBeVisible();
    await page
      .getByRole("button", { name: "Submit Sale", exact: true })
      .click();

    await expect(
      page.getByText("Cash sale completed successfully"),
    ).toBeVisible();

    /**
     * SCRUM-29: completing a cash sale opens the DEAL, not the sales list.
     *
     * This previously asserted a "Sale Completed ✓" link, which pointed at
     * `/sales?highlightId=…` — it returned the operator to the LIST, which is
     * the thing this issue exists to stop being the destination. That assertion
     * failing is how the change was confirmed to reach the real workflow rather
     * than only the component tests.
     *
     * The `href` is asserted as well as the label, because a link whose text
     * changed while it still went to the list would satisfy a text-only check.
     */
    const openDeal = page.getByRole("link", { name: "Open Deal" });
    await expect(openDeal).toBeVisible();
    await expect(openDeal).toHaveAttribute("href", /\/sales\/[^/]+\/deal$/);

    // And it actually arrives: the sale-keyed deal route is new in SCRUM-29, so
    // this is the only place that proves it resolves and renders in a browser
    // rather than in jsdom. "Status history" is present for every deal, at every
    // permission level — the money panel is not, so it is the wrong thing to
    // wait on here.
    await openDeal.click();
    await expect(page).toHaveURL(/\/sales\/[^/]+\/deal$/);
    await expect(page.getByText("Status history")).toBeVisible();
  });
});
