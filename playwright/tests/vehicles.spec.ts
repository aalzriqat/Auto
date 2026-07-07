import { test, expect } from "@playwright/test";
import { createVehicle } from "../utils";

test.describe("vehicles", () => {
  test("can add a new vehicle to inventory and see it in the list", async ({ page }) => {
    const { model } = await createVehicle(page);

    // The vehicles list is a live Convex query — the new row should appear
    // without a manual reload once the dialog closes.
    await expect(page.getByText(model)).toBeVisible();
  });
});
