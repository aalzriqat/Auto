import { expect, test } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { Locale } from "../../lib/i18n/dictionaries";
import { newContainedContext } from "../containedContext";
import { recordCashSale } from "../fixtures/cashSale";
import {
  authenticatedConvexClient,
  createVehicle,
  USER_AUTH_FILE,
} from "../utils";

const viewports = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
};
const locales = ["en", "ar"] satisfies readonly Locale[];

test.describe("sales", () => {
  for (const locale of locales) {
    for (const viewport of ["desktop", "mobile"] as const) {
      const title = "can record a cash sale end to end via the sales wizard";
      const baseline = locale === "en" && viewport === "desktop";
      test(
        baseline ? title : `${title} · ${locale} · ${viewport}`,
        async ({ browser, page }) => {
          const setup = await newContainedContext(browser, {
            storageState: USER_AUTH_FILE,
            viewport: viewports.desktop,
          });
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

          await page.setViewportSize(viewports[viewport]);
          await page.addInitScript(
            (value) => window.localStorage.setItem("autoflow-locale", value),
            locale,
          );
          await recordCashSale(page, vehicle, 15_000, locale);
          await expect(page.locator("html")).toHaveAttribute(
            "dir",
            locale === "ar" ? "rtl" : "ltr",
          );

          const match = /\/([^/]+)\/sales\/([^/]+)\/deal$/.exec(
            new URL(page.url()).pathname,
          );
          if (!match)
            throw new Error(
              "Cash completion did not open a sale-keyed Deal Cockpit route.",
            );
          const client = await authenticatedConvexClient(page);
          const sale = await client.query(api.sales.get, {
            orgId: match[1] as Id<"organizations">,
            saleId: match[2] as Id<"sales">,
          });
          expect(sale).toMatchObject({
            status: "COMPLETED",
            paymentStatus: "PAID",
          });
          const dealUrl = page.url();
          await page.reload();
          await expect(page).toHaveURL(dealUrl);
          const identity = page.getByTestId(
            viewport === "desktop" ? "deal-identity" : "deal-identity-mobile",
          );
          await expect(identity).toBeVisible();
        },
      );
    }
  }
});
