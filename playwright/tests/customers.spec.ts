import { test, expect } from "@playwright/test";
import { createCustomer } from "../utils";

test.describe("customers", () => {
  test("can create a new customer and see it in the list", async ({ page }) => {
    const { firstName, lastName } = await createCustomer(page);

    await expect(page.getByText(`${firstName} ${lastName}`)).toBeVisible();
  });
});
