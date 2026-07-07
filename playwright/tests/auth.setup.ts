import { test as setup, expect } from "@playwright/test";

const authFile = "playwright/.auth/user.json";

/**
 * Signs in against Clerk's hosted <SignIn/> using the same QA fixture and
 * field ids proven to work by the existing TestSprite-generated scripts
 * (testsprite_tests/TC001_*.py, TC009_*.py): #identifier-field,
 * #password-field, then a "Continue" button. Forces English locale before
 * the app boots — LanguageProvider defaults to Arabic/RTL on an empty
 * localStorage, and that default persists into the saved storageState for
 * every dependent test otherwise.
 */
setup("authenticate", async ({ page }) => {
  const user = process.env.E2E_LOGIN_USER;
  const password = process.env.E2E_LOGIN_PASSWORD;
  if (!user || !password) {
    throw new Error("E2E_LOGIN_USER and E2E_LOGIN_PASSWORD must be set to run the E2E suite.");
  }

  await page.addInitScript(() => {
    window.localStorage.setItem("autoflow-locale", "en");
  });

  await page.goto("/sign-in");

  const identifierField = page.locator("#identifier-field");
  await identifierField.waitFor({ state: "visible", timeout: 15_000 });
  await identifierField.fill(user);

  // Clerk shows the password field on the same screen for some identifiers
  // (combined form) but only after clicking "Continue" for others (two-step
  // form) — handle both rather than assuming one.
  const passwordField = page.locator("#password-field");
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  if (!(await passwordField.isVisible().catch(() => false))) {
    await continueButton.click();
  }
  await passwordField.waitFor({ state: "visible", timeout: 15_000 });
  await passwordField.fill(password);

  await continueButton.click();

  // A logged-in session always ends up on some /{orgId}/... route; the
  // exact landing page depends on the fixture's role (owner -> /dashboard,
  // sales -> /sales, etc.), so match broadly rather than one specific path.
  // Matched against pathname specifically (not the full URL string) — a
  // regex without a leading anchor can accidentally match "host:port" as
  // the orgId segment against the bare Clerk-fallback /dashboard URL.
  await page.waitForURL(
    (url) => /^\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/.test(url.pathname + url.search),
    { timeout: 30_000 }
  );

  await expect(page.getByRole("banner")).toBeVisible();

  await page.context().storageState({ path: authFile });
});
