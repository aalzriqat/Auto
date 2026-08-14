import { expect, type Page } from "@playwright/test";
import { createCustomer, createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";

/**
 * Building a financed deal through the interface — the steps, without the
 * assertions.
 *
 * Extracted from `financed-deal-economics.spec.ts` when the rendered measure
 * gate needed the same deal. Extracted rather than copied on purpose: two specs
 * with their own private wizard-driving code drift, and the one that is not
 * being actively debugged drifts silently until it fails for a reason that has
 * nothing to do with its subject.
 *
 * Deliberately granular. `financed-deal-economics.spec.ts` is ABOUT reaching
 * these writers, so it interleaves its own assertions between the steps and
 * composes them itself; a single opaque `buildTheWholeDeal()` would have hidden
 * exactly what that spec exists to prove. `buildDealWithRecordedEconomics`
 * below is the composed convenience for callers that only need a deal to look
 * at.
 *
 * Everything here goes through the same screens an operator uses. There is no
 * seeding, no `ctx.db.patch`, and no test-only mutation — a fixture written
 * behind the UI would prove the UI can DISPLAY a state, not that anyone can
 * reach it.
 */

export const COMPANY_NAME = "AutoFlow E2E Finance";
export const CUSTOMER_STATUS = "Employee";
/** The rate the company buys at, configured once and snapshotted per deal. */
export const PURCHASE_LTV = "90";
export const VEHICLE_PRICE = "15000";
export const DOWN_PAYMENT = "3000";
export const QUOTATION = "13000";
/**
 * Approved AT the quotation, and the reason is not cosmetic.
 *
 * This was 12,000 — a 1,000 shortfall — and when the tail moved from the review
 * dialog onto the real stage rail the spec stopped at
 * _"الخطوة التالية: فجوة التخمين — لم تُحل فجوة التخمين"_. That is not a flake
 * and it is not the rail being wrong: an approval below the quotation writes
 * `gapResolution: PENDING_NEGOTIATION`, `deriveDealStages` does not count that
 * as resolved, and **nothing in AutoFlow writes the values that would resolve
 * it** — the recording workflow does not exist. The stage has no exit, and
 * because the rail is sequential it hides every step after it. **SCRUM-83.**
 *
 * The old spec never saw this because it drove `Finance Applications → Review`,
 * which ignores the rail entirely. That is the whole point of moving it.
 *
 * So the fixture approves in full, which is an ordinary outcome and leaves the
 * specs testing what they are for. The blocked-gap state is NOT swept away with
 * it: it is pinned in `DealCockpitWorkflowTail.test.tsx`. Raise this figure back
 * above the quotation once SCRUM-83 ships a resolution step, and drive that step
 * from the spec then.
 */
export const APPROVED_PURCHASE = "13000";

async function existsWithin(locator: ReturnType<Page["getByText"]>): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/** Waits out the coachmarks and tours that mount over everything underneath. */
export async function dismissOverlays(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const overlay = page.locator('button[aria-label^="Dismiss "]');
    if (!(await overlay.count())) break;
    await overlay
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {});
  }
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  if (await skip.count()) {
    await skip
      .first()
      .click({ timeout: 5_000 })
      .catch(() => {});
  }
}

/**
 * Hides the floating feedback and messenger buttons.
 *
 * They are fixed to the bottom-end corner and sit over the wizard's primary
 * action at this viewport, so the pointer lands on them instead. A real overlap
 * worth its own issue, and not what these specs are here to prove.
 */
export async function hideFloatingButtons(page: Page): Promise<void> {
  await page.addStyleTag({
    // Matched structurally, not by aria-label: the labels are translated.
    content: 'button[class*="fixed"] { display: none !important; }',
  });
}

/**
 * A finance company that buys at a known rate, and a customer status it
 * accepts.
 *
 * Both are prerequisites for the wizard to offer CONFIGURED financing at all —
 * without an accepted status it can only produce an "Others" quote, which is a
 * different financing mode with no dealer-side economics. Created if absent so
 * the specs are self-contained on a fresh deployment, reused if present so they
 * do not accumulate a company per run.
 */
export async function ensureFinanceCompany(page: Page): Promise<void> {
  await gotoOrgRoute(page, "settings/finance");
  await dismissOverlays(page);

  /**
   * Wait for the page before counting anything on it.
   *
   * `count()` does not wait. Asking "does this status exist yet" while the
   * screen was still mounting answered zero, and the run created a SECOND
   * "Employee" — which then made every later `getByLabel("Employee")`
   * ambiguous under strict mode. The bug was in the question, not the answer:
   * an existence check has to be asked of a loaded page.
   */
  const addStatus = page.getByRole("button", { name: "Add Status" });
  await expect(addStatus).toBeVisible();
  await hideFloatingButtons(page);

  const statusExists = await existsWithin(
    page.getByText(CUSTOMER_STATUS, { exact: true }),
  );
  if (!statusExists) {
    await addStatus.click();
    await page.getByPlaceholder("Status label...").fill(CUSTOMER_STATUS);
    await page.getByRole("button", { name: "Add New" }).click();
    await expect(page.getByText(CUSTOMER_STATUS, { exact: true }).first()).toBeVisible();
  }

  if (await existsWithin(page.getByText(COMPANY_NAME, { exact: true }))) return;

  await page.getByRole("button", { name: "Add Company" }).click();
  const dialog = page.getByRole("dialog");
  // Positional, not by label: this dialog's <Label>s carry no `htmlFor` and its
  // <Input>s no `id`, so nothing associates them and `getByLabel` finds
  // nothing — which is also why a screen reader announces these fields as
  // unlabelled. Pre-existing and outside this change's diff; recorded as
  // follow-up rather than fixed here. The two fields below are the exceptions,
  // and are addressed by the ids they actually have.
  await dialog.locator("form input").first().fill(COMPANY_NAME);
  // The field SCRUM-68 turns on: with no purchase LTV the quotation calculator
  // cannot run and the funding split cannot be worked out.
  await dialog.locator("#default-ltv-percent").fill(PURCHASE_LTV);
  // `.first()`: a deployment someone has been experimenting on can carry more
  // than one status of the same name, and this only needs the company to accept
  // the one the wizard will offer.
  await dialog.getByLabel(CUSTOMER_STATUS).first().check();
  /**
   * Submitted from the form, not by clicking Save.
   *
   * At this project's 1280×720 viewport the Add Company dialog is taller than
   * the screen and does not scroll: Save sits below the fold and cannot be
   * reached at all. A real defect for anyone on a 720px-high laptop — recorded
   * as follow-up, since it is outside this change's diff — and the reason this
   * uses the keyboard path a form already supports rather than pretending the
   * button is clickable.
   */
  await dialog.locator("#default-ltv-percent").press("Enter");

  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(COMPANY_NAME, { exact: true }).first()).toBeVisible();
}

/**
 * Builds the deal the way a salesperson does, and returns the application's own
 * deal URL.
 */
export async function createFinancedApplication(
  page: Page,
  fixtures: { model: string; customer: string },
): Promise<string> {
  await gotoOrgRoute(page, "sales");
  await dismissOverlays(page);
  await page.locator("#btn-new-installment-sale").click();
  await hideFloatingButtons(page);

  // A draft left by an earlier run puts a resume banner over the wizard; start
  // clean rather than steering someone else's half-finished deal.
  const startFresh = page.getByRole("button", { name: "Start Fresh" });
  if (await startFresh.count()) await startFresh.click();

  // --- step 1: the car, the money, and the financing company ---------------
  await page.getByRole("button", { name: /Select an available vehicle/ }).click();
  await page.getByText(fixtures.model, { exact: false }).first().click();

  await page.locator('input[name="vehiclePrice"]').fill(VEHICLE_PRICE);
  await page.locator('input[name="downPayment"]').fill(DOWN_PAYMENT);
  await page.locator('input[name="termMonths"]').fill("60");

  // The customer's status is what makes a configured company offerable.
  await page.getByText(CUSTOMER_STATUS, { exact: true }).first().click();
  await page.getByText(COMPANY_NAME, { exact: false }).first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // --- step 2: the customer -----------------------------------------------
  await page.getByPlaceholder(/Search by name, phone/).fill(fixtures.customer);
  await page.getByText(fixtures.customer, { exact: false }).first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  // --- step 3: the quote, then the application ----------------------------
  await page.getByRole("button", { name: "Generate Quote", exact: true }).click();
  await expect(page.getByText("Quote generated and saved!")).toBeVisible();

  const startApplication = page.getByRole("button", {
    name: "Start Finance Application",
  });
  await expect(startApplication).toBeVisible();
  await startApplication.click();

  // Creating the application does not open it. The wizard swaps the button for
  // "View Application", and that goes to the LIST — so the deal is reached the
  // way an operator reaches it from there: by its own row.
  await expect(page.getByText(/View Application/)).toBeVisible();

  await gotoOrgRoute(page, "applications");
  await dismissOverlays(page);
  const row = page.getByRole("row").filter({ hasText: fixtures.customer }).first();
  await expect(row).toBeVisible();
  await row.locator('a[href$="/deal"]').first().click();

  await page.waitForURL(/\/applications\/[^/]+\/deal$/, { timeout: 60_000 });
  return page.url();
}

/** Opens one application's review dialog from the list, by its customer. */
export async function openReviewDialog(page: Page, customer: string) {
  await gotoOrgRoute(page, "applications");
  await dismissOverlays(page);
  const row = page.getByRole("row").filter({ hasText: customer }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Review", exact: true }).click();
  return page.getByRole("dialog");
}

/**
 * The credit decision, made by somebody who is not the deal's own salesperson.
 *
 * Two steps, because the application's own state machine has two:
 * PENDING_DOCS → UNDER_REVIEW → APPROVED. `updateStatus` refuses the jump —
 * "Invalid finance application status transition" — while the dialog offers
 * Approve from either state and reports the refusal as an unexpected error.
 * SCRUM-73.
 */
export async function approveCreditDecision(
  managerPage: Page,
  customerLastName: string,
): Promise<void> {
  const decision = await openReviewDialog(managerPage, customerLastName);
  await decision.getByRole("button", { name: "Mark Under Review" }).click();
  await decision.getByRole("button", { name: "Approve Application" }).click();
  await managerPage.getByRole("button", { name: "Close", exact: true }).click();
  // Read back off the ROW rather than off the button that made it — a disabled
  // button proves the click landed, not that the application moved.
  await expect(
    managerPage.getByRole("row").filter({ hasText: customerLastName }).first(),
  ).toContainText("Approved");
}

/** Records what the dealership SENT the finance company, from the deal cockpit. */
export async function recordQuotation(page: Page, dealUrl: string): Promise<void> {
  await page.goto(dealUrl);
  await dismissOverlays(page);
  await hideFloatingButtons(page);

  await page.getByRole("button", { name: "Record quotation" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#submitted-quotation-amount").fill(QUOTATION);
  await dialog.getByRole("button", { name: "Record quotation" }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Records what the finance company ANSWERED, from the deal cockpit.
 *
 * The manager's, not the salesperson's: `approveDealerPurchaseAmount` refuses
 * the application's own salesperson, which is separation of duties over the
 * number the dealership's contribution derives from.
 */
export async function recordApprovedAmount(
  managerPage: Page,
  dealUrl: string,
  /**
   * A chance to assert about the OPEN dialog before the money decision is
   * committed.
   *
   * `financed-deal-economics.spec.ts` checks that the rate the split will be
   * computed at is stated before the operator commits, rather than discovered in
   * the result. That assertion only exists while the dialog is open, so it
   * cannot live outside this helper — and duplicating the whole open/fill/submit
   * sequence in the spec just to reach it is how two copies start drifting.
   */
  beforeSubmit?: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>,
): Promise<void> {
  await managerPage.goto(dealUrl);
  await dismissOverlays(managerPage);
  await hideFloatingButtons(managerPage);

  await managerPage.getByRole("button", { name: "Record approved amount" }).click();
  const dialog = managerPage.getByRole("dialog");
  await beforeSubmit?.(dialog);
  await dialog.locator("#approved-purchase-amount").fill(APPROVED_PURCHASE);
  await dialog
    .locator("#approved-purchase-notes")
    .fill("Approved by phone; recorded from the company's advice.");
  await dialog.getByRole("button", { name: "Record approved amount" }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * A whole financed deal with its economics on the record, for callers that need
 * a deal to LOOK at rather than a workflow to prove.
 *
 * Its own disposable deal every run — never a deal that already exists, and
 * never the production evidence deal. The screens under test render from
 * whatever is on the record, so a fixture that adopted somebody else's row
 * would be measuring their data and could mutate it.
 */
export async function buildDealWithRecordedEconomics(
  page: Page,
  managerPage: Page,
  tag: string,
): Promise<string> {
  await ensureFinanceCompany(page);

  const { model } = await createVehicle(page, {
    model: `E2E-${tag}-${testDataSuffix()}`,
    requireImmediate: true,
  });
  const { firstName, lastName } = await createCustomer(page, {
    lastName: `${tag}-${testDataSuffix()}`,
  });
  const customer = `${firstName} ${lastName}`;

  const dealUrl = await createFinancedApplication(page, { model, customer });
  await approveCreditDecision(managerPage, lastName);
  await recordQuotation(page, dealUrl);
  await recordApprovedAmount(managerPage, dealUrl);

  return dealUrl;
}
