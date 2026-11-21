import { expect, test, type Browser } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Locale } from "../../lib/i18n/dictionaries";
import { recordCashSale } from "../fixtures/cashSale";
import { newDealLifecycleContext } from "../fixtures/dealLifecycleContext";
import {
  authenticatedConvexClient,
  createVehicle,
  USER_AUTH_FILE,
} from "../utils";

test.describe("sales", () => {
  async function verifyCashLifecycle(
    browser: Browser,
    baseURL: string | undefined,
    locale: Locale,
    viewport: "desktop" | "mobile",
  ): Promise<void> {
    const setup = await newDealLifecycleContext(browser, baseURL, USER_AUTH_FILE, "desktop");
    let vehicle: Awaited<ReturnType<typeof createVehicle>>;
    try {
      const setupPage = await setup.newPage();
      await setupPage.addInitScript(() =>
        window.localStorage.setItem("autoflow-locale", "en"),
      );
      vehicle = await createVehicle(setupPage, {
        requireImmediate: true,
      });
    } finally {
      await setup.close();
    }

    const seller = await newDealLifecycleContext(browser, baseURL, USER_AUTH_FILE, viewport);
    try {
      const salePrice = 15_000;
      const page = await seller.newPage();
      await page.addInitScript(
        (value) => window.localStorage.setItem("autoflow-locale", value),
        locale,
      );
      await recordCashSale(page, vehicle, salePrice, locale);
      await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");

      const match = /\/([^/]+)\/sales\/([^/]+)\/deal$/.exec(new URL(page.url()).pathname);
      if (!match) throw new Error("Cash completion did not open a sale-keyed Deal Cockpit route.");
      const client = await authenticatedConvexClient(page);
      const saleArgs = {
        orgId: match[1] as Id<"organizations">,
        saleId: match[2] as Id<"sales">,
      };
      const sale = await client.query(api.sales.get, saleArgs);
      expect(sale).toMatchObject({
        status: "COMPLETED",
        salePrice,
        vehicle: { vin: vehicle.vin },
      });
      // The Bill of Sale reads the deposit applied to this sale from the ledger.
      const economics = await client.query(api.sales.getBillOfSaleEconomics, saleArgs);
      expect(economics).toMatchObject({
        kind: "CASH",
        totalBilled: salePrice,
        depositsApplied: salePrice,
        balanceDue: 0,
      });
      const dealUrl = page.url();
      await page.reload();
      await expect(page).toHaveURL(dealUrl);
      await expect(page.getByTestId(viewport === "desktop" ? "deal-identity" : "deal-identity-mobile")).toBeVisible();
    } finally {
      await seller.close();
    }
  }

  test("can record a cash sale end to end via the sales wizard", async ({ browser, baseURL }) => {
    await verifyCashLifecycle(browser, baseURL, "en", "desktop");
  });

  test("can record a cash sale end to end via the sales wizard · en · mobile", async ({ browser, baseURL }) => {
    await verifyCashLifecycle(browser, baseURL, "en", "mobile");
  });

  test("can record a cash sale end to end via the sales wizard · ar · desktop", async ({ browser, baseURL }) => {
    await verifyCashLifecycle(browser, baseURL, "ar", "desktop");
  });

  test("can record a cash sale end to end via the sales wizard · ar · mobile", async ({ browser, baseURL }) => {
    await verifyCashLifecycle(browser, baseURL, "ar", "mobile");
  });
});
