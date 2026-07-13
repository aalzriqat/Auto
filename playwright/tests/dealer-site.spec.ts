import { expect, test } from "@playwright/test";
import {
  ensurePublishedDealerWebsite,
  ensureTurnstileToken,
  expectVisibleTableCell,
  gotoOrgRoute,
  searchCurrentTable,
} from "../utils";

test.describe("public dealer website", () => {
  test("contact, financing, and vehicle inquiry forms create CRM leads", async ({
    page,
  }) => {
    const site = await ensurePublishedDealerWebsite(page);
    const submissions = [
      {
        path: "/contact",
        buttonName: "Send message",
        firstName: "Public",
        lastName: `Contact-${Date.now()}`,
        emailPrefix: "contact",
        message: "I want to speak with sales.",
      },
      {
        path: "/finance",
        buttonName: "Request financing",
        firstName: "Public",
        lastName: `Finance-${Date.now()}`,
        emailPrefix: "finance",
        message: "Please send financing details.",
      },
      {
        path: `/inventory/${site.vehicleSlug}`,
        buttonName: "Send inquiry",
        firstName: "Public",
        lastName: `Vehicle-${Date.now()}`,
        emailPrefix: "vehicle",
        message: `I am interested in ${site.vehicleModel}.`,
      },
    ];

    for (const submission of submissions) {
      await page.goto(
        `/dealer-site${submission.path}?host=${encodeURIComponent(site.host)}`,
      );
      const form = page.locator("form").first();
      await expect(form.getByPlaceholder("First name")).toBeVisible();

      await form.getByPlaceholder("First name").fill(submission.firstName);
      await form.getByPlaceholder("Last name").fill(submission.lastName);
      await form
        .getByPlaceholder("Email")
        .fill(`${submission.emailPrefix}-${submission.lastName.toLowerCase()}@example.com`);
      await form.getByPlaceholder("Message").fill(submission.message);
      await ensureTurnstileToken(form);

      await form.getByRole("button", { name: submission.buttonName }).click();
      await expect(
        page.getByRole("heading", { name: "Thank you!" }),
      ).toBeVisible();
    }

    await gotoOrgRoute(page, "leads");
    for (const submission of submissions) {
      await searchCurrentTable(page, submission.lastName);
      await expectVisibleTableCell(page, submission.lastName);
    }
  });
});
