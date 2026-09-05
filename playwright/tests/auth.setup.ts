import { test as setup, expect, type Page } from "@playwright/test";
import { APPROVER_AUTH_FILE } from "../utils";

/**
 * The dealership's own salesperson. Creates the deals every other spec drives.
 */
const authFile = "playwright/.auth/user.json";
/**
 * A SECOND person at the same dealership, holding approval authority.
 *
 * Not a convenience. AutoFlow's financed workflow enforces separation of duties
 * — `approveDealerPurchaseAmount` and `updateStatus` both refuse the
 * application's own salesperson — so the full operator path simply cannot be
 * driven end to end by one identity. A suite with one login can prove the deal
 * up to the approval and no further, which is precisely the part where the
 * dealership's money is decided. Owner ruling on SCRUM-68: provision the second
 * identity rather than weaken the requirement.
 *
 * Reusable infrastructure, not a SCRUM-68 fixture: every approval and
 * separation-of-duties workflow after this one needs the same two seats.
 */
const approverAuthFile = APPROVER_AUTH_FILE;
const orgRoutePattern = /^\/[^/]+\/(dashboard|sales|leads|accounting)(\?.*)?$/;
const e2eLocalStorage = {
  "autoflow-locale": "en",
  dealer_website_onboarding_seen_v1: "1",
  feature_spotlight_seen_v3: "1",
  global_search_onboarding_seen_v1: "1",
  messenger_onboarding_seen_v1: "1",
} as const;
const e2eLocalStorageEntries = Object.entries(e2eLocalStorage);

function isOrgRoute(url: URL): boolean {
  return orgRoutePattern.test(url.pathname + url.search);
}

function isSignInRoute(url: URL): boolean {
  return url.pathname.startsWith("/sign-in");
}

function verificationCodeFor(): string {
  return process.env.E2E_LOGIN_VERIFICATION_CODE || "424242";
}

function seedE2ELocalStorage(entries: [string, string][]): void {
  entries.forEach(([key, value]) => {
    window.localStorage.setItem(key, value);
  });
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
  /**
   * Detected by the CODE FIELD, not by the URL.
   *
   * This used to wait for a `/sign-in/factor…` path and return when it did not
   * arrive. Clerk raises the same challenge without changing the path — "You're
   * signing in from a new device", on `/sign-in` itself — and on that render
   * the setup skipped straight past the boxes, left them empty, and failed
   * thirty seconds later on a navigation that was never going to happen. The
   * screenshot said "Enter code."; the error said "waiting for navigation",
   * which named neither the challenge nor the field.
   *
   * Either signal now counts, whichever arrives first: the code field, or a
   * URL that has already left sign-in because no challenge was raised.
   */
  const codeField = page
    .locator(
      'input[autocomplete="one-time-code"]:visible, input[inputmode="numeric"]:visible, input[name*="code"]:visible',
    )
    .first();
  const challenged = await Promise.race([
    codeField.waitFor({ state: "visible", timeout: 15_000 }).then(() => true),
    page
      .waitForURL((url) => !isSignInRoute(url), { timeout: 15_000 })
      .then(() => false),
  ]).catch(() => false);
  if (!challenged) return;

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

/**
 * Runs the dealership wizard from the CHOICE screen the app actually shows
 * first.
 *
 * ⚠️ THE SCREEN THIS USED TO WAIT FOR IS NOT THE FIRST ONE. `/dashboard`
 * presents "How will you be using AutoFlow?" to any orgless, non-support-agent
 * user, and "Dealership Name" only mounts after "I run a dealership" is
 * clicked. Waiting directly for that field therefore timed out after 15s on
 * every genuine first run, returned as though no onboarding were needed, and
 * the run then failed thirty seconds later on `waitForURL(isOrgRoute)` —
 * naming a navigation instead of the screen it was stuck on. Measured at
 * `90d5f03fe`, run `33933915963`.
 *
 * Reaching this at all is now an explicit opt-in (see `mayCreateDealership`):
 * CI seeds the QA dealership deterministically and neither fixture is allowed
 * to create one.
 */
async function completeOnboardingFromChoiceScreen(page: Page): Promise<void> {
  await page.getByText("I run a dealership", { exact: true }).click();

  const dealershipNameField = page.getByRole("textbox", {
    name: "Dealership Name",
  });
  await dealershipNameField.waitFor({ state: "visible", timeout: 15_000 });

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
 * Signs one identity in against Clerk's hosted <SignIn/>, using the field ids
 * Clerk renders: #identifier-field, #password-field, then a "Continue" button.
 * Forces English locale before the app boots — LanguageProvider defaults to
 * Arabic/RTL on an empty localStorage, and that default would persist into the
 * saved storageState for every dependent test.
 */
async function signIn(
  page: Page,
  options: {
    user: string;
    password: string;
    storagePath: string;
    /** Which configured secret this identity came from, for diagnostics. */
    seatLabel: string;
    /**
     * Whether landing on the orgless choice screen is a legitimate first run
     * this fixture may resolve by creating a dealership.
     *
     * FALSE in CI for BOTH identities. The QA dealership is seeded
     * deterministically against the preview deployment before any browser
     * starts (`convex/e2eBootstrap.ts`), so an identity that still lands on
     * the choice screen is reporting a broken bootstrap — and letting it click
     * through would create a second, empty dealership and produce a suite that
     * passes against the wrong org. It could never fix the approver either:
     * the approver has to JOIN the first dealership, which no wizard can do.
     *
     * Opt-in via `E2E_ALLOW_DEALERSHIP_CREATION=1` for a developer running the
     * suite against their own personal Convex dev deployment, where no preview
     * bootstrap has run. CI never sets it.
     */
    mayCreateDealership: boolean;
  },
): Promise<void> {
  const verificationCode = verificationCodeFor();

  await page.addInitScript(seedE2ELocalStorage, e2eLocalStorageEntries);

  await page.goto("/sign-in");

  const identifierField = page.locator("#identifier-field");
  await identifierField.waitFor({ state: "visible", timeout: 15_000 });
  await identifierField.fill(options.user);

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
  await passwordField.fill(options.password);

  await continueButton.click();

  await completeVerificationIfNeeded(page, verificationCode);
  await page.waitForURL((url) => !isSignInRoute(url), { timeout: 30_000 });

  /**
   * Seeded fixtures land on a role-dependent /{orgId}/... route. An identity
   * with no membership lands on the orgless choice screen instead.
   *
   * Detected by the CHOICE screen, raced against arrival at an org route, so a
   * membership that resolves a moment later wins and a correctly-seeded
   * identity is never delayed by the loser.
   */
  if (!isOrgRoute(new URL(page.url()))) {
    const strandedOnChoice = await Promise.race([
      page
        .getByText("I run a dealership", { exact: true })
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true),
      page.waitForURL(isOrgRoute, { timeout: 20_000 }).then(() => false),
    ]).catch(() => false);

    if (strandedOnChoice && options.mayCreateDealership) {
      await completeOnboardingFromChoiceScreen(page);
    } else if (strandedOnChoice) {
      throw new Error(
        `${options.seatLabel} signed in successfully and was then offered the "How will you be using AutoFlow?" choice, ` +
          `which means it belongs to no dealership on this deployment.\n\n` +
          `This is an E2E BOOTSTRAP failure, not a product failure and not a Clerk credential failure — authentication ` +
          `plainly worked to get this far.\n\n` +
          `Every Playwright run claims a brand-new Convex preview whose database is empty, so the QA dealership, its ` +
          `roles and both memberships have to be seeded against that exact deployment before the browser starts. That is ` +
          `\`scripts/e2ePreviewBootstrap.mjs\` -> \`e2eBootstrap:bootstrapE2EOrganization\`, run with an explicit ` +
          `--preview-name. Check that step's output.\n\n` +
          `Do NOT resolve this by letting the fixture create a dealership: the approver has to JOIN the salesperson's ` +
          `dealership (AutoFlow refuses to let one person both create and approve a deal), and a second empty org would ` +
          `make the whole suite pass against the wrong tenant. Set E2E_ALLOW_DEALERSHIP_CREATION=1 only when running ` +
          `locally against your own dev deployment.`,
      );
    }
  }
  await page.waitForURL(isOrgRoute, { timeout: 30_000 });

  await expect(page.getByRole("banner")).toBeVisible();

  await page.evaluate(seedE2ELocalStorage, e2eLocalStorageEntries);
  await page.context().storageState({ path: options.storagePath });
}

/**
 * Local-only escape hatch.
 *
 * On CI this is never set, so NEITHER fixture may create a dealership — the
 * preview bootstrap owns that, and a fixture that quietly creates its own is
 * how a suite ends up green against an empty org nobody meant to test.
 */
function mayCreateDealership(): boolean {
  return process.env.E2E_ALLOW_DEALERSHIP_CREATION === "1";
}

/** The dealership's salesperson — the identity every existing spec runs as. */
setup("authenticate", async ({ page }) => {
  const user = process.env.E2E_LOGIN_USER;
  const password = process.env.E2E_LOGIN_PASSWORD;
  if (!user || !password) {
    throw new Error(
      "E2E_LOGIN_USER and E2E_LOGIN_PASSWORD must be set to run the E2E suite.",
    );
  }

  await signIn(page, {
    user,
    password,
    storagePath: authFile,
    seatLabel: "E2E_LOGIN_USER (the salesperson seat)",
    mayCreateDealership: mayCreateDealership(),
  });
});

/**
 * The approving colleague. Skipped, loudly, where the identity is not
 * provisioned: the specs that need it skip in turn and say so, which is a
 * different and honest outcome from a suite that quietly proves less.
 */
setup("authenticate the approver", async ({ page }) => {
  const user = process.env.E2E_APPROVER_USER;
  const password = process.env.E2E_APPROVER_PASSWORD;
  setup.skip(
    !user || !password,
    "E2E_APPROVER_USER / E2E_APPROVER_PASSWORD are not set, so no approval-workflow spec can run.",
  );

  await signIn(page, {
    user: user!,
    password: password!,
    storagePath: approverAuthFile,
    seatLabel: "E2E_APPROVER_USER (the approving colleague's seat)",
    // Unconditionally false, even under E2E_ALLOW_DEALERSHIP_CREATION: this
    // identity must JOIN the salesperson's dealership. A wizard here could only
    // ever produce a second, empty org — which is the failure, not the fix.
    mayCreateDealership: false,
  });
});
