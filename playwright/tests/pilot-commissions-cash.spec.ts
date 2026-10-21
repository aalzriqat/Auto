import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";
import { recordQuoteDeposit } from "../fixtures/dealScenarios";

/**
 * Pilot browser checks for two owner-ruled behaviours, run against the
 * disposable preview backend like every other spec in this folder:
 *
 *  - SCRUM-802 cash pay-first (#526): Submit Sale on a cash quote with no
 *    deposit is refused by the backend; with the full price held as a deposit
 *    the sale completes and opens its deal.
 *  - SCRUM-783 deal commissions (#633): the deal page shows the commissions
 *    total and the net profit after them; a commission line registered on the
 *    Commissions page appears in that total.
 *
 * Each step attaches a screenshot to the report so a reader sees the screen,
 * not only the pass.
 */

const PRICE = 15_000; // the selling price createVehicle sets

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

/** Wizard steps 1-3: pick the vehicle, create a buyer, generate the quote. */
async function cashQuote(page: Page, model: string): Promise<void> {
  const lastName = `Buyer-${testDataSuffix()}`;
  await gotoOrgRoute(page, "sales");
  await page.locator("#btn-new-cash-sale").click();

  await page.getByRole("button", { name: /Select an available vehicle/ }).click();
  await page.keyboard.type(model);
  await page.getByRole("button", { name: new RegExp(model) }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByRole("button", { name: "Create a new customer", exact: true }).click();
  await page.getByRole("textbox", { name: /First Name/ }).fill("Playwright");
  await page.getByRole("textbox", { name: /Last Name/ }).fill(lastName);
  await page.getByRole("button", { name: "Create & Select", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByRole("button", { name: "Generate Quote", exact: true }).click();
  await expect(page.getByText("Quote generated and saved!")).toBeVisible();
  await expect(page.getByText("Quote Generated Successfully!")).toBeVisible();
}

/** Pay in full, submit, and land on the sale's deal page. */
async function payAndOpenDeal(page: Page): Promise<void> {
  await recordQuoteDeposit(page, { amount: PRICE, method: "CASH" });
  await page.getByRole("button", { name: "Submit Sale", exact: true }).click();
  await expect(page.getByText("Cash sale completed successfully")).toBeVisible();
  const openDeal = page.getByRole("link", { name: "Open Deal" });
  await expect(openDeal).toHaveAttribute("href", /\/sales\/[^/]+\/deal$/);
  await openDeal.click();
  await expect(page).toHaveURL(/\/sales\/[^/]+\/deal$/);
  await expect(page.getByText("Status history")).toBeVisible();
}

test.describe("pilot: cash pay-first and deal commissions", () => {
  test("a cash sale with no deposit is refused and creates no sale", async ({ page }, testInfo) => {
    const { model } = await createVehicle(page);
    await cashQuote(page, model);
    await shot(page, testInfo, "1-quote-no-deposit");

    await page.getByRole("button", { name: "Submit Sale", exact: true }).click();
    // The refusal is a backend error toast; the wizard must not offer the deal.
    await expect(page.locator("[data-sonner-toast][data-type='error']").first()).toBeVisible();
    await shot(page, testInfo, "2-submit-refused");
    await expect(page.getByRole("link", { name: "Open Deal" })).toHaveCount(0);
    await expect(page.getByText("Cash sale completed successfully")).toHaveCount(0);
  });

  test("the deal shows commissions and net profit, and a registered line adds to the total", async ({
    page,
  }, testInfo) => {
    const { model } = await createVehicle(page);
    await cashQuote(page, model);
    await payAndOpenDeal(page);

    const row = page.getByTestId("deal-commissions-row");
    await expect(row).toBeVisible();
    await expect(row.getByText("Net profit after commissions", { exact: true })).toBeVisible();
    // The net figure stays pending until the salesperson's commission is decided; log what the screen says.
    console.log(`[pilot-commissions] deal row: ${(await row.innerText()).replace(/\s+/g, " ")}`);
    await shot(page, testInfo, "3-deal-commissions-collapsed");
    await row.getByRole("button", { name: /Total commissions/ }).click();
    await expect(row.getByText("Salesperson's commission", { exact: true })).toBeVisible();
    await shot(page, testInfo, "4-deal-commissions-expanded");
    const totalBefore = await row.getByRole("button").first().innerText();

    // Register a purchase-type line for a colleague on the Commissions page.
    await gotoOrgRoute(page, "commissions");
    const saleRow = page.getByRole("row").filter({ hasText: model }).first();
    await expect(saleRow).toBeVisible();
    await saleRow.getByRole("button", { name: "Lines" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Commission lines")).toBeVisible();
    await shot(page, testInfo, "5-lines-dialog");

    await dialog.getByRole("combobox").nth(1).click(); // Employee
    await page.getByRole("option").first().click();
    await dialog.locator("#deal-commission-amount").fill("100");
    await dialog.locator("#deal-commission-note").fill("QA TEST purchase commission");
    await dialog.getByRole("button", { name: "Add line", exact: true }).click();
    await expect(page.getByText("Commission line added")).toBeVisible();
    await expect(dialog.getByText("QA TEST purchase commission")).toBeVisible();
    await shot(page, testInfo, "6-line-added");
    await page.keyboard.press("Escape");

    // The new line is part of the deal page's total.
    await page.goBack();
    await page.reload();
    const rowAfter = page.getByTestId("deal-commissions-row");
    await expect(rowAfter).toBeVisible();
    const totalAfter = await rowAfter.getByRole("button").first().innerText();
    expect(totalAfter).not.toBe(totalBefore);
    await rowAfter.getByRole("button").first().click();
    await expect(rowAfter.getByText("QA TEST purchase commission")).toBeVisible();
    await shot(page, testInfo, "7-deal-after-line");
  });

  // SCRUM-854 (#638): a SALE line for the sale's own salesperson would be paid on
  // top of the commission already on the sale row, so the backend refuses it.
  test("a SALE line for the sale's own salesperson is refused (SCRUM-854)", async ({
    page,
  }, testInfo) => {
    const { model } = await createVehicle(page);
    await cashQuote(page, model);
    await payAndOpenDeal(page);

    await gotoOrgRoute(page, "commissions");
    const saleRow = page.getByRole("row").filter({ hasText: model }).first();
    await saleRow.getByRole("button", { name: "Lines" }).click();
    const dialog = page.getByRole("dialog");
    const salesperson = (
      await dialog.getByText("Salesperson's commission").first().locator("xpath=following-sibling::*[1]").innerText()
    ).trim();

    await dialog.getByRole("combobox").nth(0).click(); // Type
    await page.getByRole("option", { name: "Sale commission" }).click();
    await dialog.getByRole("combobox").nth(1).click(); // Employee
    await page.getByRole("option", { name: salesperson, exact: true }).click();
    await dialog.locator("#deal-commission-amount").fill("50");
    await dialog.getByRole("button", { name: "Add line", exact: true }).click();

    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible();
    const text = (await toast.innerText()).trim();
    const refused = (await toast.getAttribute("data-type")) === "error";
    console.log(`[pilot-commissions] SCRUM-854 SALE line for the salesperson ${refused ? "REFUSED" : "ACCEPTED"}: ${text}`);
    testInfo.annotations.push({
      type: "scrum-854",
      description: `SALE line for the salesperson ${refused ? "REFUSED" : "ACCEPTED"}: ${text}`,
    });
    await shot(page, testInfo, "8-sale-line-for-salesperson");
    expect(refused, `SALE line for the salesperson was accepted: ${text}`).toBe(true);
  });
});
