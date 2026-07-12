import { test } from "@playwright/test";
import {
  createCustomer,
  expectVisibleTableCell,
  searchCurrentTable,
} from "../utils";

test.describe("customers", () => {
  test("can create a new customer and see it in the list", async ({ page }) => {
    const { firstName, lastName } = await createCustomer(page);

    await searchCurrentTable(page, lastName);
    await expectVisibleTableCell(page, `${firstName} ${lastName}`);
  });
});
