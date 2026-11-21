import { expect, type Page } from "@playwright/test";
import { getDictionary, type Locale } from "../../lib/i18n/dictionaries";
import { createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";
import { recordQuoteDeposit } from "./dealScenarios";

/** Original sales.spec journey, shared so its UI assertions remain identical. */
export async function recordCashSale(page: Page, vehicle?: { model: string }, depositAmount = 15_000, locale: Locale = "en"): Promise<void> {
    const copy = getDictionary(locale);
    // Self-contained: creates its own vehicle+customer rather than picking
    // from whatever real inventory exists in the shared QA org, so this test
    // never depletes stock and never depends on other specs' run order.
    const { model } = vehicle ?? await createVehicle(page);
    const lastName = `Buyer-${testDataSuffix()}`;

    await gotoOrgRoute(page, "sales");
    await page.locator("#btn-new-cash-sale").click();

    // Step 1 — vehicle + price
    await page
      .getByRole("button", { name: copy.SelectAvailableVehicle })
      .click();
    await page.keyboard.type(model);
    await page.getByRole("button", { name: new RegExp(model) }).click();
    await page.getByRole("button", { name: copy.Next, exact: true }).click();

    // Step 2 — create the customer in the selected language.
    await page
      .getByRole("button", { name: copy.CreateNewCustomerBtn, exact: true })
      .click();
    await page.getByRole("textbox", { name: copy.FirstName }).fill("Playwright");
    await page.getByRole("textbox", { name: copy.LastName }).fill(lastName);
    await page
      .getByRole("button", { name: copy.CreateAndSelectCustomer, exact: true })
      .click();
    await page.getByRole("button", { name: copy.Next, exact: true }).click();

    // Step 3 — review + generate the quote (this only creates a Quote row,
    // not a Sale yet — completeFromQuote below is what actually sells it)
    await page
      .getByRole("button", { name: copy.GenerateQuote, exact: true })
      .click();
    await expect(page.getByText(copy.QuoteSavedSuccess)).toBeVisible();

    // Step 4 — complete the sale. "Done & Close" alone only closes the wizard
    // after a quote — it never calls sales.completeFromQuote, so no sale is
    // actually recorded unless "Submit Sale" is clicked.
    await expect(page.getByText(copy.QuoteGeneratedSuccess)).toBeVisible();
    // SCRUM-802 (owner ruling, Option A): pilot cash procedure. A cash sale
    // completes only when its full price is already held as a deposit, so the
    // customer's full payment (the vehicle's quoted price) is
    // recorded as a deposit first and Submit Sale then applies it. Completing
    // an unpaid cash sale is refused by the backend.
    await recordQuoteDeposit(page, { amount: depositAmount, method: "CASH" }, locale);
    await page
      .getByRole("button", { name: copy.SubmitSale, exact: true })
      .click();

    await expect(
      page.getByText(copy.SaleCompletedSuccess),
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
    const openDeal = page.getByRole("link", { name: copy.OpenDeal });
    await expect(openDeal).toBeVisible();
    await expect(openDeal).toHaveAttribute("href", /\/sales\/[^/]+\/deal$/);

    // And it actually arrives: the sale-keyed deal route is new in SCRUM-29, so
    // this is the only place that proves it resolves and renders in a browser
    // rather than in jsdom. "Status history" is present for every deal, at every
    // permission level — the money panel is not, so it is the wrong thing to
    // wait on here.
    await openDeal.click();
    await expect(page).toHaveURL(/\/sales\/[^/]+\/deal$/);
    await expect(page.getByText(copy.StatusLogHeading)).toBeVisible();
}
