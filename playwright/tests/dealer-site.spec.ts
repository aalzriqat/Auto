import { expect, test } from "@playwright/test";
import {
  ensurePublishedDealerWebsite,
  ensureTurnstileToken,
  expectVisibleTableCell,
  gotoOrgRoute,
  searchCurrentTable,
  type PublishedDealerWebsite,
} from "../utils";

test.describe("public dealer website", () => {
  const forms = [
    {
      name: "contact",
      path: () => "/contact",
      buttonName: "Send message",
      firstName: "Public",
      lastNamePrefix: "Contact",
      emailPrefix: "contact",
      message: "I want to speak with sales.",
    },
    {
      name: "financing",
      path: () => "/finance",
      buttonName: "Request financing",
      firstName: "Public",
      lastNamePrefix: "Finance",
      emailPrefix: "finance",
      message: "Please send financing details.",
    },
    {
      name: "vehicle inquiry",
      path: (site: PublishedDealerWebsite) => `/inventory/${site.vehicleSlug}`,
      buttonName: "Send inquiry",
      firstName: "Public",
      lastNamePrefix: "Vehicle",
      emailPrefix: "vehicle",
      message: "I am interested in this vehicle.",
    },
  ];

  // Each public door has its own fresh site, browser context and 60s budget.
  // Combining all three also combines three bounded widget-fallback waits.
  for (const formCase of forms) {
    test(`${formCase.name} form creates a CRM lead`, async ({ page }) => {
      const site = await ensurePublishedDealerWebsite(page);
      const submission = {
        ...formCase,
        path: formCase.path(site),
        lastName: `${formCase.lastNamePrefix}-${Date.now()}`,
      };
      const consoleErrors: string[] = [];
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      };
      page.on("console", onConsole);
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
      // Toasts vanish in a few seconds; keep the first one for the failure log.
      const firstToast = await page
        .locator("[data-sonner-toast]")
        .first()
        .innerText({ timeout: 3_000 })
        .catch(() => "");
      const thanks = page.getByRole("heading", { name: "Thank you!" });
      try {
        await expect(thanks).toBeVisible();
      } catch (error) {
        // Name the cause in the job log: what the form said instead of the thank-you.
        const shown = (await page.locator("main, body").first().innerText().catch(() => "")).replace(/\s+/g, " ");
        const toasts = [firstToast, ...(await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []))]
          .filter(Boolean)
          .join(" | ");
        console.log(`[dealer-site] ${submission.path} showed no thank-you. Page text: ${shown.slice(0, 600)}`);
        console.log(`[dealer-site] ${submission.path} toasts: ${toasts || "(none)"}; console errors: ${consoleErrors.join(" || ").slice(0, 800) || "(none)"}`);
        throw error;
      } finally {
        page.off("console", onConsole);
      }
      await gotoOrgRoute(page, "leads");
      await searchCurrentTable(page, submission.lastName);
      await expectVisibleTableCell(page, submission.lastName);
    });
  }
});
