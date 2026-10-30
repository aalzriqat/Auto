import { test } from "@playwright/test";
import { recordCashSale } from "../fixtures/cashSale";

test.describe("sales", () => {
  test("can record a cash sale end to end via the sales wizard", async ({ page }) => {
    await recordCashSale(page);
  });
});
