import { test as setup, expect, type Page } from "@playwright/test";

const authFile = "playwright/.auth/user.json";
const orgRoutePattern = /^\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/;

function isOrgRoute(url: URL): boolean {
  return orgRoutePattern.test(url.pathname + url.search);
}

function isSignInRoute(url: URL): boolean {
  return url.pathname.startsWith("/sign-in");
}

function verificationCodeFor(): string {
  return process.env.E2E_LOGIN_VERIFICATION_CODE || "424242";
}

async function waitUntilNotSignIn(
  page: Page,
  timeout: number,
): Promise<boolean> {
  return page
    .waitForURL((url) => !isSignInRoute(url), { timeout })
    .then(() => true)
    .catch(() => false);
}

async function typeVerificationCode(
  page: Page,
  verificationCode: string,
): Promise<void> {
  const codeInput = page
    .locator(
      'input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[name*="code"]:visible, input[type="tel"]:visible',
    )
    .first();

  const hasCodeInput = await codeInput
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (hasCodeInput) {
    await codeInput.click();
    await codeInput.pressSequentially(verificationCode);
    return;
  }

  const verificationCodeField = page
    .getByRole("textbox", { name: /verification code/i })
    .first();
  await verificationCodeField.waitFor({ state: "visible", timeout: 15_000 });
  await verificationCodeField.pressSequentially(verificationCode);
}

async function completeVerificationIfNeeded(
  page: Page,
  verificationCode?: string,
): Promise<void> {
  const reachedFactorStep = await page
    .waitForURL((url) => url.pathname.startsWith("/sign-in/factor"), {
      timeout: 5_000,
    })
    .then(() => true)
    .catch(() => false);
  if (!reachedFactorStep) return;

  if (!verificationCode) {
    throw new Error(
      "Clerk requested an email verification code. Set E2E_LOGIN_VERIFICATION_CODE to continue.",
    );
  }

  await typeVerificationCode(page, verificationCode);

  if (await waitUntilNotSignIn(page, 3_000)) return;
  if (!isSignInRoute(new URL(page.url()))) return;

  const continueButton = page
    .getByRole("button", { name: /^(Continue|Verify)\b/i })
    .first();
  const canContinue = await continueButton
    .isEnabled({ timeout: 5_000 })
    .catch(() => false);
  if (canContinue) {
    await continueButton.click();
  }
}

async function completeOnboardingIfNeeded(page: Page): Promise<void> {
  if (isOrgRoute(new URL(page.url()))) return;

  const dealershipNameField = page.getByRole("textbox", {
    name: "Dealership Name",
  });
  const needsOnboarding = await dealershipNameField
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!needsOnboarding) return;

  await dealershipNameField.fill(`AutoFlow Playwright QA ${Date.now()}`);
  await page.getByRole("button", { name: /^Continue/ }).click();

  await expect(page.getByRole("heading", { name: "Currency" })).toBeVisible();
  await page.getByRole("button", { name: /^Continue/ }).click();

  await expect(
    page.getByRole("heading", { name: "Lead Sources" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load Default Lead Sources" }).click();

  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  await page.getByRole("button", { name: "Load Default Pipeline" }).click();

  await expect(
    page.getByRole("heading", { name: "You're All Set" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Go to Dashboard" }).click();
}

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
    throw new Error(
      "E2E_LOGIN_USER and E2E_LOGIN_PASSWORD must be set to run the E2E suite.",
    );
  }
  const verificationCode = verificationCodeFor();

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
  const continueButton = page.getByRole("button", {
    name: "Continue",
    exact: true,
  });
  if (!(await passwordField.isVisible().catch(() => false))) {
    await continueButton.click();
  }
  await passwordField.waitFor({ state: "visible", timeout: 15_000 });
  await passwordField.fill(password);

  await continueButton.click();

  await completeVerificationIfNeeded(page, verificationCode);
  await page.waitForURL((url) => !isSignInRoute(url), { timeout: 30_000 });

  // Existing fixtures land on a role-dependent /{orgId}/... route. Brand-new
  // fixtures first land on /dashboard with the dealership onboarding wizard;
  // complete it once so future runs can use the saved authenticated state.
  await completeOnboardingIfNeeded(page);
  await page.waitForURL(isOrgRoute, { timeout: 30_000 });

  await expect(page.getByRole("banner")).toBeVisible();

  await page.context().storageState({ path: authFile });
});
