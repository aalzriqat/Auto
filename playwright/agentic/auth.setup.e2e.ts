import { test } from '@e2e-dev/web';
import { credentials, expect } from 'e2e';

// The app defaults to Arabic/RTL on empty storage and shows first-run tours; the agent tests are
// written in English, so seed the same keys the Playwright fixture seeds (playwright/tests/auth.setup.ts).
const E2E_LOCAL_STORAGE: Record<string, string> = {
  'autoflow-locale': 'en',
  dealer_website_onboarding_seen_v1: '1',
  feature_spotlight_seen_v3: '1',
  global_search_onboarding_seen_v1: '1',
  messenger_onboarding_seen_v1: '1',
};

// Either language, in case Clerk keeps its own locale.
const CONTINUE = /^(Continue|متابعة)$/;

const ORG_ROUTE = /\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/;

test.setup('sign in as the salesperson', { sessions: ['sales'] }, async ({ app, browser, screen, session }) => {
  const sales = credentials.user('sales');

  await app.open('/sign-in');
  await browser.evaluate((entries: Record<string, string>) => {
    for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
    return null;
  }, E2E_LOCAL_STORAGE);
  // The locale is read at boot, so the seeded value only applies after a reload.
  await browser.reload();

  // Clerk's hosted <SignIn/>: the password field is on the first screen for some identifiers
  // and behind "Continue" for others.
  await browser.locator('#identifier-field').fill(sales.username);
  const password = browser.locator('#password-field');
  if (!(await password.isVisible())) {
    await screen.getByRole('button', CONTINUE).tap();
  }
  await password.fill(sales.password);
  await screen.getByRole('button', CONTINUE).tap();

  // Clerk challenges a new device with an email code on /sign-in/factor-two. The QA identity is a
  // `+clerk_test` address, so Clerk's fixed test code applies (same as playwright/tests/auth.setup.ts).
  await browser.waitForURL(/\/sign-in\/factor|\/[^/]+\/(dashboard|sales|leads|accounting)/, { timeout: 30_000 });
  if ((await browser.url()).includes('/sign-in/factor')) {
    // Typed the instant the URL changed, the digits land before Clerk's OTP boxes are wired and
    // Clerk answers "Enter code.": wait for the field, focus it, and type one digit at a time.
    const code = screen.getByRole('textbox', 'Enter verification code');
    await expect(code).toBeVisible();
    await code.tap();
    await code.pressSequentially(process.env.E2E_LOGIN_VERIFICATION_CODE || '424242', { delay: 100 });
    // Clerk submits on the last digit and navigates away; press Continue only if it has not.
    const submitted = await browser.waitForURL(ORG_ROUTE, { timeout: 5_000 }).then(() => true, () => false);
    if (!submitted) await screen.getByRole('button', CONTINUE).tap();
  }

  // A seeded dealership member lands on an org route; anything else (a rejected code, the orgless
  // onboarding choice) is a fixture problem and fails here, before saving.
  await browser.waitForURL(ORG_ROUTE, { timeout: 30_000 });
  await expect(screen.getByRole('banner')).toBeVisible();
  await session.save('sales');
});
