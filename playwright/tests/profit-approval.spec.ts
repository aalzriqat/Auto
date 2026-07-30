import { test, expect, type Page } from "@playwright/test";
import { createVehicle, gotoOrgRoute, testDataSuffix } from "../utils";

/**
 * The *rule* — a below-minimum-profit financed deal needs a manager's approval
 * for that exact profit figure — is enforced and tested server-side in
 * convex/utils/profitApproval.ts and convex/profitApprovalEnforcement.test.ts.
 * Nothing here re-proves it.
 *
 * What only a browser can prove is the wiring around that rule: that
 * Step1QuoteSetup.tsx surfaces the gate at all, that the Convex subscription
 * carries a manager's verdict back into an already-open wizard without a
 * reload, and that the Next button tracks the verdict. A backend that refuses
 * the sale while the UI happily marches the salesperson to step 4 is still a
 * broken product, and no Convex test can see that.
 *
 * Both tests drive two pages in the same context: the salesperson's wizard
 * stays open on page one while the manager responds on page two, because
 * navigating the wizard away would discard the in-progress quote.
 *
 * Locale note: "Approval Required", "Profit Approved", "Request Profit
 * Approval" and the two status sentences are hard-coded English in the
 * component. "Profit", "Next", "Approve" and "Reject" are NOT — they come from
 * t() and would be Arabic under an ar locale. auth.setup.ts pins the locale to
 * English via storageState, which every page in the context inherits.
 */

// These tests each do several full navigations plus a cold second page that
// redoes the Clerk handshake and OrgProvider's membership gate.
test.describe.configure({ timeout: 120_000 });

const MINIMUM_PROFIT = 5000;
const REQUESTED_PROFIT = 100;

async function openBlockedInstallmentQuote(page: Page) {
  const { model } = await createVehicle(page, {
    model: `E2E-APPROVAL-${testDataSuffix()}`,
    minimumProfit: MINIMUM_PROFIT,
    requireImmediate: true,
  });

  await gotoOrgRoute(page, "sales");

  // Rendered only when the org enables INSTALLMENT in its payment types; no
  // other spec exercises this entry point, so say why it is missing.
  const installmentEntry = page.locator("#btn-new-installment-sale");
  await expect(
    installmentEntry,
    "The QA org has no INSTALLMENT payment type enabled, so the financed wizard cannot be opened. Enable it in Settings → Finance for the fixture org."
  ).toBeVisible();
  await installmentEntry.click();

  await page.getByRole("button", { name: /Select an available vehicle/ }).click();
  // Fill the picker's search box rather than page.keyboard.type: typing goes to
  // whatever has focus at that instant and does not wait for React to commit
  // the dropdown's autoFocus, which silently drops leading keystrokes.
  await page.getByPlaceholder(/^Search by make, model/).fill(model);
  await page.getByRole("button", { name: model }).click();

  await page.getByLabel("Profit", { exact: true }).fill(String(REQUESTED_PROFIT));

  // The gate is live before anything is submitted: the alert appears and Next
  // is disabled, so the deal cannot progress past step 1 at all.
  await expect(page.getByText("Approval Required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  return { model };
}

async function respondOnApprovalsPage(page: Page, model: string, action: "Approve" | "Reject") {
  await gotoOrgRoute(page, "approvals");

  // listPendingApprovals requires APPROVE_REQUESTS; without it the query throws,
  // useQuery stays undefined and the page renders its spinner forever. Assert
  // the list resolved before looking for the card, so a permissions problem
  // reports as a permissions problem.
  await expect(
    page.getByTestId("approval-card").first().or(page.getByText("No pending approvals")),
    "The approvals list never resolved. The QA fixture most likely lacks the approve:requests permission, which makes listPendingApprovals throw and leaves the page on its loading spinner."
  ).toBeVisible();

  const card = page.getByTestId("approval-card").filter({ hasText: model });
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: action }).click();
  await expect(card).not.toBeVisible();
}

test.describe("profit approval gate", () => {
  test("a rejected below-minimum deal stays blocked in the wizard", async ({ page, context }) => {
    const { model } = await openBlockedInstallmentQuote(page);

    await page.getByRole("button", { name: "Request Profit Approval" }).click();
    await expect(
      page.getByText("Approval request is currently pending. Please wait for a manager.")
    ).toBeVisible();

    const managerPage = await context.newPage();
    await respondOnApprovalsPage(managerPage, model, "Reject");
    await managerPage.close();

    // The wizard is subscribed to checkPendingApproval, so the verdict lands
    // without a reload. The deal must remain un-sellable.
    await expect(
      page.getByText("Your request for this profit amount was rejected.")
    ).toBeVisible();
    await expect(page.getByText("Approval Required")).toBeVisible();
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
    await expect(page.getByText("Profit Approved")).toHaveCount(0);
  });

  test("an approved below-minimum deal unblocks the wizard", async ({ page, context }) => {
    const { model } = await openBlockedInstallmentQuote(page);

    await page.getByRole("button", { name: "Request Profit Approval" }).click();
    await expect(
      page.getByText("Approval request is currently pending. Please wait for a manager.")
    ).toBeVisible();

    const managerPage = await context.newPage();
    await respondOnApprovalsPage(managerPage, model, "Approve");
    await managerPage.close();

    await expect(page.getByText("Profit Approved")).toBeVisible();
    await expect(page.getByText("Approval Required")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  test("cutting the profit below the approved amount re-blocks the deal", async ({
    page,
    context,
  }) => {
    const { model } = await openBlockedInstallmentQuote(page);

    await page.getByRole("button", { name: "Request Profit Approval" }).click();
    const managerPage = await context.newPage();
    await respondOnApprovalsPage(managerPage, model, "Approve");
    await managerPage.close();

    await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();

    // An approval is for a specific figure. Dropping the profit below it
    // afterwards must not ride on the earlier verdict.
    await page.getByLabel("Profit", { exact: true }).fill(String(REQUESTED_PROFIT - 50));

    await expect(page.getByText("Approval Required")).toBeVisible();
    await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
