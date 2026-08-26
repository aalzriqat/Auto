import { test as setup, expect, type Page } from "@playwright/test";
import {
  APPROVER_AUTH_FILE,
  authenticatedConvexClient,
  resolveOrgId,
} from "../utils";
import { api } from "../../convex/_generated/api";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Id } from "../../convex/_generated/dataModel";

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
    /**
     * Checked after sign-in and BEFORE the storage state is written, so an
     * identity that is not fit for purpose never becomes a saved session.
     */
    verify?: (page: Page) => Promise<void>;
    /**
     * Whether landing on the dealership wizard is a legitimate first run.
     *
     * True for the primary fixture, which owns the QA dealership and creates it
     * on a brand-new instance. FALSE for every additional identity: they are
     * meant to JOIN that dealership, so a wizard means the invitation was never
     * accepted, and completing it would silently create a second, empty
     * dealership and produce a suite that passes against the wrong org.
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

  // Existing fixtures land on a role-dependent /{orgId}/... route. Brand-new
  // fixtures first land on /dashboard with the dealership onboarding wizard;
  // complete it once so future runs can use the saved authenticated state.
  if (options.mayCreateDealership) {
    await completeOnboardingIfNeeded(page);
  } else if (!isOrgRoute(new URL(page.url()))) {
    /**
     * Detected by the CHOICE screen an orgless identity actually lands on.
     *
     * Not by the "Dealership Name" field: that only mounts after clicking "I
     * run a dealership", which this branch exists to prevent. Waiting for it
     * therefore always timed out, `stranded` stayed false, and the run failed
     * thirty seconds later on the same generic URL timeout the check was added
     * to replace — while costing every correctly-provisioned identity that
     * briefly passes through /dashboard the full wait first.
     *
     * Raced against arrival at an org route, so a membership that resolves a
     * moment later wins and nothing is delayed by the loser.
     */
    const strandedOnChoice = await Promise.race([
      page
        .getByText("I run a dealership", { exact: true })
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(() => true),
      page.waitForURL(isOrgRoute, { timeout: 20_000 }).then(() => false),
    ]).catch(() => false);
    if (strandedOnChoice) {
      throw new Error(
        `${options.user} signed in and was offered the "how will you use AutoFlow" choice, which means it belongs to no dealership. Add this identity to the QA organization with a role holding approve:finance_application — do NOT let it create a dealership of its own, or the suite will run against an empty org.`,
      );
    }
  }
  await page.waitForURL(isOrgRoute, { timeout: 30_000 });

  await expect(page.getByRole("banner")).toBeVisible();

  await page.evaluate(seedE2ELocalStorage, e2eLocalStorageEntries);
  if (options.verify) await options.verify(page);
  await page.context().storageState({ path: options.storagePath });
}

/**
 * The owner's organization id, handed to the approver's setup.
 *
 * Written to disk rather than kept in a module variable: these are two separate
 * setup tests, and a fact that only survives because they happen to share a
 * worker process is a fact that breaks the day the runner changes. Lives beside
 * the storage states, which are already gitignored.
 */
const ORG_HANDOFF_FILE = "playwright/.auth/org.json";

function rememberOwnerOrg(orgId: string): void {
  mkdirSync(dirname(ORG_HANDOFF_FILE), { recursive: true });
  writeFileSync(ORG_HANDOFF_FILE, JSON.stringify({ orgId }), "utf8");
}

function recalledOwnerOrg(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ORG_HANDOFF_FILE, "utf8"));
    const orgId = (parsed as { orgId?: unknown })?.orgId;
    return typeof orgId === "string" ? orgId : null;
  } catch {
    return null;
  }
}

/**
 * The approver is only useful if it can actually approve, in the RIGHT org.
 *
 * Checked before the storage state is written, so a seat that cannot approve
 * never becomes a saved session that later specs trust. Without this the suite
 * fails much later, inside an approval spec, on a permission refusal that reads
 * exactly like a product bug.
 */
async function assertApproverSeat(page: Page): Promise<void> {
  const orgId = (await resolveOrgId(page)) as Id<"organizations">;
  const ownerOrgId = recalledOwnerOrg();
  if (ownerOrgId && orgId !== ownerOrgId) {
    throw new Error(
      `The approver signed in to organization ${orgId}, but the dealership under ` +
        `test is ${ownerOrgId}. A second identity in a different org would drive ` +
        `every approval spec against the wrong dealership.`,
    );
  }

  const client = await authenticatedConvexClient(page);
  const membership = await client.query(api.memberships.getMyMembership, { orgId });
  if (!membership?.permissions?.includes(APPROVAL_PERMISSION)) {
    throw new Error(
      `The approver holds role "${membership?.roleName ?? "NONE"}" in ${orgId}, which ` +
        `does not include ${APPROVAL_PERMISSION}. Provisioning attached the seat but ` +
        `not the authority.`,
    );
  }
}

/** The permission the financed workflow's second seat actually has to hold. */
const APPROVAL_PERMISSION = "approve:finance_application";

/**
 * Put the approver in the dealership the way a dealership would.
 *
 * A Convex PREVIEW deployment starts as an EMPTY DATABASE. Organizations and
 * memberships live in that database, so the approver cannot already belong to a
 * "QA organization" there — no such org exists until this run creates one. The
 * approver setup then throws by design, and because the browser project
 * declares `dependencies: ["setup"]`, Playwright skips EVERY dependent spec.
 * One unprovisioned identity silently zeroes the entire suite.
 *
 * The fix is not to seed the database, skip the seat, or point at a long-lived
 * deployment. It is to do what a real dealership does on its first day: the
 * owner signs up, then adds a colleague. `memberships.createAccount` is the
 * action behind Add Team Member — the same public call the Team screen makes,
 * with the owner's own session and the owner's own permissions. No backdoor is
 * introduced, because nothing here is reachable that an operator could not
 * already reach.
 *
 * Called with the OWNER's live session, immediately after their onboarding, so
 * it never depends on a storage-state file another test may not have written
 * yet.
 */
async function ensureApproverProvisioned(page: Page): Promise<void> {
  const approverEmail = process.env.E2E_APPROVER_USER;
  // Absent credentials are the approver setup's own business — it skips loudly
  // and says which specs go with it. Nothing to provision here.
  if (!approverEmail) return;

  const orgId = (await resolveOrgId(page)) as Id<"organizations">;
  rememberOwnerOrg(orgId);
  const client = await authenticatedConvexClient(page);
  const wanted = approverEmail.toLowerCase().trim();

  const roles = await client.query(api.roles.list, { orgId });
  // Chosen by PERMISSION, never by name. "MANAGER" happens to hold it today;
  // picking the role by what it can actually do means a renamed or re-scoped
  // template fails here, loudly, instead of provisioning a seat that cannot
  // approve anything and failing much later inside an unrelated spec.
  const roleWithApproval = (roles ?? []).find(
    (role) => role.name !== "OWNER" && role.permissions?.includes(APPROVAL_PERMISSION),
  );

  // Rerun-safe: a named preview is REUSED across runs, so the second run finds
  // the approver already in the org. Verify the seat instead of duplicating it
  // — `prepareDirectAccount` refuses a duplicate member outright.
  const members = await client.query(api.memberships.list, {
    orgId,
    paginationOpts: { numItems: 200, cursor: null },
  });
  const existing = (members?.page ?? []).find(
    (m: { userEmail?: string }) => (m.userEmail ?? "").toLowerCase() === wanted,
  );

  if (existing) {
    const heldRole = (roles ?? []).find((role) => role._id === existing.roleId);
    if (!heldRole?.permissions?.includes(APPROVAL_PERMISSION)) {
      throw new Error(
        `${approverEmail} is already in this organization but holds role ` +
          `"${heldRole?.name ?? "UNKNOWN"}", which does not include ` +
          `${APPROVAL_PERMISSION}. Every approval spec would fail on a refusal that ` +
          `looks like a product bug. Fix the role rather than the test.`,
      );
    }
    return;
  }

  if (!roleWithApproval) {
    throw new Error(
      `No non-OWNER role in this organization holds ${APPROVAL_PERMISSION}, so the ` +
        `approver cannot be given a seat that can approve anything. The default ` +
        `MANAGER template used to carry it — check whether it still does.`,
    );
  }

  try {
    await client.action(api.memberships.createAccount, {
      orgId,
      firstName: "E2E",
      lastName: "Approver",
      email: approverEmail,
      roleId: roleWithApproval._id,
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    // One precise prerequisite rather than a generic failure. This action calls
    // Clerk from the BACKEND, so the key has to be on the Convex deployment —
    // having it in the workflow env is not the same thing.
    if (/CLERK_SECRET_KEY/i.test(message)) {
      throw new Error(
        "memberships.createAccount needs CLERK_SECRET_KEY on the CONVEX deployment " +
          "(not just in the workflow environment) to attach the approver's Clerk " +
          "identity. Set it on the disposable named preview only.",
      );
    }
    throw error;
  }
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
    mayCreateDealership: true,
  });

  // The owner exists and has a dealership now, so they can staff it. Done
  // here, on the live owner session, rather than as a separate setup test
  // that would depend on this one's storage-state file already existing.
  await ensureApproverProvisioned(page);
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
    mayCreateDealership: false,
    verify: assertApproverSeat,
  });
});
