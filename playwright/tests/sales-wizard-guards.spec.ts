import { expect, test, type Page } from "@playwright/test";
import { createCustomer, createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";
import { CUSTOMER_STATUS, COMPANY_NAME, dismissOverlays, ensureFinanceCompany } from "../fixtures/financedDeal";

/**
 * SCRUM-609 — sales wizard defects found in production QA (SCRUM-595).
 *
 * F-01: the floating feedback trigger sat over the wizard's step actions.
 * F-03: the review step did not show the sale price / down payment committed to.
 * F-25: a financed quote with down payment ≥ sale price rendered negative
 *       financing behind an enabled button, then failed on save.
 *
 * Deliberately does NOT call `hideFloatingButtons`: F-01 is the subject here.
 */
test.describe.configure({ timeout: 300_000 });
test.use({ actionTimeout: 25_000 });

async function openInstallmentWizard(page: Page) {
  await gotoOrgRoute(page, "sales");
  await dismissOverlays(page);
  await page.locator("#btn-new-installment-sale").click();
  const startFresh = page.getByRole("button", { name: "Start Fresh" });
  const selectVehicle = page.getByRole("button", { name: /Select an available vehicle/ });
  await expect(startFresh.or(selectVehicle).first()).toBeVisible();
  if (await startFresh.isVisible()) {
    await startFresh.click();
    await expect(selectVehicle).toBeVisible();
  }
  return selectVehicle;
}

test.describe("sales wizard guards (SCRUM-609)", () => {
  test("F-01/F-25/F-03: no floating trigger over the steps, down payment ≥ price is refused, review shows committed terms", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("autoflow-locale", "en"));
    await ensureFinanceCompany(page);
    const { model } = await createVehicle(page, {
      model: `E2E-WIZ-${testDataSuffix()}`,
      requireImmediate: true,
    });
    const { firstName, lastName } = await createCustomer(page, {
      lastName: `Wiz-${testDataSuffix()}`,
    });

    const selectVehicle = await openInstallmentWizard(page);

    // F-01 — the floating trigger is gone while the wizard is open; the header
    // offers the same panel.
    const feedbackButtons = page.getByRole("button", { name: "Send Feedback" });
    await expect(feedbackButtons).toHaveCount(1);
    const header = page.locator('button[title="Send Feedback"]');
    await expect(header).toHaveCount(1);
    expect(await header.evaluate((el) => getComputedStyle(el).position)).not.toBe("fixed");
    await header.click();
    await expect(page.getByText("Report a Bug").or(page.getByRole("dialog")).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);

    await selectVehicle.click();
    await page.getByText(model, { exact: false }).first().click();
    await page.locator('input[name="vehiclePrice"]').fill("11100");
    await page.locator('input[name="termMonths"]').fill("48");
    await page.getByText(CUSTOMER_STATUS, { exact: true }).first().click();

    // F-25 — down payment above the sale price.
    await page.locator('input[name="downPayment"]').fill("15000");
    await expect(page.getByRole("alert").filter({ hasText: "less than the sale price" })).toBeVisible();
    await expect(page.getByTestId("finance-panel-blocked")).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByPlaceholder(/Search by name, phone/)).toHaveCount(0);

    // A valid down payment restores the finance panel and the flow.
    await page.locator('input[name="downPayment"]').fill("3000");
    await expect(page.getByTestId("finance-panel-blocked")).toHaveCount(0);
    await page.getByText(COMPANY_NAME, { exact: false }).first().click();

    // F-01 — the step action is the element under the pointer (trial runs the
    // hit-target check without clicking).
    const next = page.getByRole("button", { name: "Next", exact: true });
    await next.click({ trial: true });
    await next.click();

    await page.getByPlaceholder(/Search by name, phone/).fill(lastName);
    await page.getByText(`${firstName} ${lastName}`, { exact: false }).first().click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // F-03 — the review step shows the committed terms.
    const terms = page.getByTestId("review-deal-terms");
    await expect(terms).toBeVisible();
    await expect(terms).toContainText("Sale Price");
    await expect(terms).toContainText("11,100.00");
    await expect(terms).toContainText("Down Payment");
    await expect(terms).toContainText("3,000.00");
    await page.getByRole("button", { name: "Generate Quote", exact: true }).click({ trial: true });
  });
});
