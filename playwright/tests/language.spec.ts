import { test, expect } from "@playwright/test";

test.describe("language switcher", () => {
  test("switching to Arabic flips the document to RTL", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForURL(
      /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/,
    );

    // The saved auth storageState forces English (autoflow-locale=en), so we
    // start on "EN" and toggle to Arabic. LanguageSwitcher's accessible name
    // is just the locale code — the "Switch Language" text is a tooltip
    // (title attribute), not the button's name.
    const toggle = page.getByRole("button", { name: /^(en|ar)$/i });
    await expect(toggle).toHaveText(/^en$/i);

    await toggle.click();

    await expect(toggle).toHaveText(/^ar$/i);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  });
});
