import { test, expect, type Page } from "@playwright/test";
import {
  APPROVER_AUTH_FILE,
  createCustomer,
  createVehicle,
  gotoOrgRoute,
  testDataSuffix,
} from "../utils";

/**
 * The financed deal's economics, recorded by the two people the product
 * requires — through the interface, with nothing written behind it.
 *
 * The *rules* are proved server-side in convex/financingEconomics.test.ts, and
 * the card's own behaviour in FinanceCompanyDecision.test.tsx. Neither can see
 * what this proves: that an operator can actually reach those writers. SCRUM-68
 * exists because they could not — the mutations were real and had no caller,
 * so a configured deal stopped dead after its credit decision.
 *
 * Why two identities, and why this cannot be collapsed into one:
 * `approveDealerPurchaseAmount` refuses the application's own salesperson, and
 * so does `updateStatus`. That is separation of duties over the number the
 * dealership's own contribution derives from — the product's rule, not a
 * testing inconvenience. One login can prove the deal up to the approval and no
 * further, which is precisely the part where the money is decided. So the
 * salesperson builds and quotes the deal, and a MANAGER at the same dealership
 * makes both decisions. Owner ruling on SCRUM-68: provision the second identity
 * rather than weaken the requirement to backend coverage.
 *
 * Everything the deal needs is created here through the same screens an
 * operator uses. There is no seeding, no `ctx.db.patch`, and no test-only
 * mutation anywhere in this file — a fixture written behind the UI would prove
 * the UI can DISPLAY a state, not that anyone can reach it.
 */

const COMPANY_NAME = "AutoFlow E2E Finance";
const CUSTOMER_STATUS = "Employee";
/** The rate the company buys at, configured once and snapshotted per deal. */
const PURCHASE_LTV = "90";
const VEHICLE_PRICE = "15000";
const DOWN_PAYMENT = "3000";
const QUOTATION = "13000";
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
 * So the fixture approves in full, which is an ordinary outcome and leaves this
 * spec testing what it is for — the workflow tail — instead of a stage nobody
 * can clear. The blocked-gap state is NOT swept away with it: it is pinned in
 * `DealCockpitWorkflowTail.test.tsx`, which asserts the rail still says the gap
 * is unresolved and that the screen now explains why the step cannot be taken
 * there. Raise this figure back above the quotation once SCRUM-83 ships a
 * resolution step, and drive that step here.
 */
const APPROVED_PURCHASE = "13000";

// A full deal: two sign-ins, a wizard, a credit decision, three recorded
// figures, a handover and a finalize — each a real navigation against a real
// deployment.
test.describe.configure({ timeout: 600_000 });
// Bounded per action, not only per test. Without this a locator that never
// resolves waits out the whole 600s and reports the test as slow rather than
// naming the control it could not find.
test.use({ actionTimeout: 25_000 });

/**
 * Whether something is on the page, given a bounded chance to arrive.
 *
 * `count()` does not wait, and both of this spec's fixtures load from their own
 * subscription after the surrounding card has rendered. Asking "does this exist
 * yet" the moment the heading appeared answered no, and the run created a
 * second "Employee" — then a third, then a fourth, until a strict-mode
 * ambiguity in the company dialog finally said so. An existence check that can
 * legitimately answer NO still has to give the answer time to arrive.
 */
async function existsWithin(locator: ReturnType<Page["getByText"]>): Promise<boolean> {
  return locator
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
}

/** Waits out the coachmarks and tours that mount over everything underneath. */
async function dismissOverlays(page: Page): Promise<void> {
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
 * worth its own issue, and not what this spec is here to prove.
 */
async function hideFloatingButtons(page: Page): Promise<void> {
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
 * the spec is self-contained on a fresh deployment, reused if present so it
 * does not accumulate a company per run.
 */
async function ensureFinanceCompany(page: Page): Promise<void> {
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
async function createFinancedApplication(
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
async function openReviewDialog(page: Page, customer: string) {
  await gotoOrgRoute(page, "applications");
  await dismissOverlays(page);
  const row = page.getByRole("row").filter({ hasText: customer }).first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Review", exact: true }).click();
  return page.getByRole("dialog");
}

test.describe("recording a financed deal's economics through the interface", () => {
  /**
   * Gated on the CREDENTIALS, not on the session file they produce.
   *
   * `test.skip()` at describe level runs during suite DISCOVERY — before the
   * setup project has run, and therefore before `playwright/.auth/approver.json`
   * exists. That directory is gitignored, so on any clean runner the file is
   * absent at discovery and this suite would skip *permanently*: green CI, and
   * the one path the issue exists to prove never executed. It passed locally
   * only because earlier runs had left the file behind.
   *
   * The environment variables are present at discovery (playwright.config.ts
   * loads `.env.local` at config time), and they are the same condition the
   * approver's setup skips on — so the two can no longer disagree about whether
   * this identity exists.
   */
  test.skip(
    !process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD,
    "No approver identity is provisioned (E2E_APPROVER_USER / E2E_APPROVER_PASSWORD), and AutoFlow refuses to let one person both create and approve a deal — so this path cannot be driven. Provision the second identity rather than weakening what this proves.",
  );

  test("a salesperson quotes it, a manager approves it, and the deal finalizes", async ({
    page,
    browser,
  }) => {
    await ensureFinanceCompany(page);

    const { model } = await createVehicle(page, {
      model: `E2E-ECON-${testDataSuffix()}`,
      requireImmediate: true,
    });
    const { firstName, lastName } = await createCustomer(page, {
      lastName: `Econ-${testDataSuffix()}`,
    });
    const customer = `${firstName} ${lastName}`;

    const dealUrl = await createFinancedApplication(page, { model, customer });

    // --- the manager, at the same dealership, on their own browser ---------
    const approverContext = await browser.newContext({
      storageState: APPROVER_AUTH_FILE,
    });
    const managerPage = await approverContext.newPage();

    try {
      // The credit decision. `updateStatus` refuses the application's own
      // salesperson, so this is the manager's to make and could not have been
      // reached from the page above.
      const decision = await openReviewDialog(managerPage, lastName);
      // Two steps, because the application's own state machine has two:
      // PENDING_DOCS → UNDER_REVIEW → APPROVED. `updateStatus` refuses the
      // jump — "Invalid finance application status transition: PENDING_DOCS ->
      // APPROVED" — while the dialog offers Approve from either state and
      // reports the refusal as an unexpected error. SCRUM-73.
      await decision.getByRole("button", { name: "Mark Under Review" }).click();
      await decision.getByRole("button", { name: "Approve Application" }).click();
      // The decision itself, read back off the row rather than off the button
      // that made it — a disabled button proves the click landed, not that the
      // application moved.
      await managerPage.getByRole("button", { name: "Close", exact: true }).click();
      await expect(
        managerPage.getByRole("row").filter({ hasText: lastName }).first(),
      ).toContainText("Approved");

      // --- the salesperson records what was SENT to the finance company ----
      await page.goto(dealUrl);
      await dismissOverlays(page);
      await hideFloatingButtons(page);

      await page.getByRole("button", { name: "Record quotation" }).click();
      const quotationDialog = page.getByRole("dialog");
      await quotationDialog.locator("#submitted-quotation-amount").fill(QUOTATION);
      await quotationDialog
        .getByRole("button", { name: "Record quotation" })
        .click();
      await expect(quotationDialog).not.toBeVisible();
      // Matched on the figure alone: the currency's position and separator come
      // from the org's locale, and an assertion that also pins those would fail
      // on a formatting difference while the number was right.
      await expect(page.getByText(/13,000/).first()).toBeVisible();

      // The salesperson is NOT offered the approval — the server would refuse
      // it, and an action that only produces a refusal is not offered.
      await expect(
        page.getByRole("button", { name: "Record approved amount" }),
      ).toHaveCount(0);

      // --- the manager records what the finance company ANSWERED -----------
      await managerPage.goto(dealUrl);
      await dismissOverlays(managerPage);
      await hideFloatingButtons(managerPage);

      await managerPage
        .getByRole("button", { name: "Record approved amount" })
        .click();
      const approvalDialog = managerPage.getByRole("dialog");
      // The rate the split will be computed at, stated before the money
      // decision is committed rather than discovered in the result.
      await expect(approvalDialog.getByText(`${PURCHASE_LTV}%`)).toBeVisible();
      await approvalDialog.locator("#approved-purchase-amount").fill(APPROVED_PURCHASE);
      await approvalDialog
        .locator("#approved-purchase-notes")
        .fill("Approved by phone; recorded from the company's advice.");
      await approvalDialog
        .getByRole("button", { name: "Record approved amount" })
        .click();
      await expect(approvalDialog).not.toBeVisible();

      // --- the derived economics, worked out by the server -----------------
      // 13,000 at 90% = 11,700 funded, leaving 1,300 unfinanced. Asserted as
      // figures rather than as "a panel appeared": a split that renders but
      // does not add up is the failure this is here to catch.
      await expect(managerPage.getByText("What that leaves")).toBeVisible();
      await expect(managerPage.getByText(/11,700/).first()).toBeVisible();
      await expect(managerPage.getByText(/1,300/).first()).toBeVisible();

      // --- handover, expected payment, and close — FROM THE COCKPIT ---------
      // SCRUM-78. This tail used to be driven through
      // `Finance Applications → row → Review`, which is exactly why the suite
      // stayed green while the cockpit could not perform a single one of these
      // steps: the spec was exercising a screen the operator was never sent to.
      // The rail names each step here, so the spec takes each step here.
      //
      // `managerPage` is already on the cockpit from the approval above — no
      // navigation, because an operator who has just recorded the approval does
      // not go anywhere either. That is the whole claim under test.
      const nextStep = managerPage.getByTestId("deal-next-step");
      await expect(nextStep).toContainText("Vehicle handover");

      await nextStep.getByRole("button", { name: "Register vehicle handover" }).click();
      const handoverDialog = managerPage.getByRole("dialog");
      // The one-way door, stated before it closes. `reopenApproval` refuses once
      // the vehicle has gone out, so this warning is the last correction
      // checkpoint — and the figure it asks the operator to verify has to be in
      // front of them, not remembered.
      await expect(handoverDialog).toContainText(
        "can no longer be corrected through the normal correction flow",
      );
      await expect(handoverDialog.getByText(/13,000/).first()).toBeVisible();
      await handoverDialog.getByRole("button", { name: "Confirm handover" }).click();
      await expect(handoverDialog).not.toBeVisible();

      // Durable state, not the toast that fades: the rail has moved on, and the
      // block now names the step AFTER handover and offers it.
      const expectedPayment = nextStep.getByRole("button", {
        name: "Register the expected payment",
      });
      await expect(expectedPayment).toBeVisible();
      await expectedPayment.click();
      // Confirmed as it opens: the form already carries a method and today's
      // date. Picking a different one would be this spec asserting something
      // about payment methods, which is a different subject.
      await managerPage
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm", exact: true })
        .click();

      // And now — and only now — closing is the step the rail names. Asserted
      // as an ORDERING rather than as three independent buttons: the server
      // refuses a close with no expected payment, so a screen that offered both
      // at once would be offering a guaranteed refusal.
      const close = nextStep.getByRole("button", { name: "Close the deal" });
      await expect(close).toBeVisible();
      await close.click();
      const finalizeDialog = managerPage.getByRole("dialog");
      await expect(finalizeDialog).toContainText("It cannot be undone");
      await finalizeDialog.getByRole("button", { name: "Confirm closing" }).click();

      // The deal is closed, and the operator lands on it rather than on a list.
      await expect(managerPage.getByText("Closed").first()).toBeVisible();
    } finally {
      await approverContext.close();
    }
  });
});
