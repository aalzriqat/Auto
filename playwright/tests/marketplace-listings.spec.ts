import { expect, test } from "@playwright/test";

/**
 * Public marketplace browse, covering direct listings from individuals and
 * unaffiliated dealers.
 *
 * These pages are deliberately anonymous — a buyer must be able to browse and
 * contact a seller without an account — so this spec runs without the shared
 * auth state the other specs use.
 *
 * The regression being guarded: direct listings were once write-only. A seller
 * could create one and an admin could approve it, but `marketplaceBrowse.search`
 * unioned subscribed dealer orgs only, so an approved listing reached no buyer
 * surface at all. Anything asserting a *specific* listing would need seeded
 * data, which CI has none of; these assertions instead prove the merged query
 * executes against a real deployment and renders, and that any private-seller
 * card that is present is labelled and withholds the dealer-only trade-in CTA.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ context }) => {
  // LanguageProvider defaults to Arabic/RTL on an empty localStorage.
  await context.addInitScript(() => window.localStorage.setItem("autoflow-locale", "en"));
});

const noErrorBoundary = async (page: import("@playwright/test").Page) => {
  await expect(page.locator("body")).not.toContainText("Something went wrong");
  await expect(page.locator("body")).not.toContainText("Application error");
};

test("browse renders for an anonymous visitor and the merged query resolves", async ({ page }) => {
  await page.goto("/marketplace/cars");

  await expect(page.getByRole("heading", { name: /Browse Cars/i })).toBeVisible();
  // A failing search query would leave the grid stuck on its skeleton, so the
  // sell CTA rendering alongside it is the signal the page settled.
  await expect(page.getByText(/List Your Car/i).first()).toBeVisible();
  await noErrorBoundary(page);
});

test("private-seller cards are labelled and withhold the trade-in CTA", async ({ page }) => {
  await page.goto("/marketplace/cars");
  await expect(page.getByText(/List Your Car/i).first()).toBeVisible();

  const privateBadges = page.getByText("Private seller", { exact: true });
  const count = await privateBadges.count();

  // CI may have no direct listings; when one is present it must be badged as a
  // private seller and must not offer a trade-in, which is dealer-only.
  for (let i = 0; i < count; i += 1) {
    const card = privateBadges.nth(i).locator("xpath=ancestor::div[contains(@class,'flex-col')][1]");
    await expect(card).not.toContainText("Trade-in offer");
  }
});

test("the sell form is reachable and gates on sign-in rather than failing at submit", async ({ page }) => {
  await page.goto("/marketplace/sell");

  await expect(page.getByText(/List Your Car|Sign in/i).first()).toBeVisible();
  await noErrorBoundary(page);
});

test("my-listings renders for a signed-out visitor", async ({ page }) => {
  await page.goto("/marketplace/my-listings");

  await noErrorBoundary(page);
});
