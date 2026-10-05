import { test, expect } from "@playwright/test";
import {
  APPROVER_AUTH_FILE,
  createCustomer,
  createVehicle,
  testDataSuffix,
} from "../utils";
import {
  PURCHASE_LTV,
  approveCreditDecision,
  createFinancedApplication,
  ensureFinanceCompany,
  openDealDetails,
  recordApprovedAmount,
  recordQuotation,
} from "../fixtures/financedDeal";

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

// A full deal: two sign-ins, a wizard, a credit decision, three recorded
// figures, a handover and a finalize — each a real navigation against a real
// deployment.
test.describe.configure({ timeout: 600_000 });
// Bounded per action, not only per test. Without this a locator that never
// resolves waits out the whole 600s and reports the test as slow rather than
// naming the control it could not find.
test.use({ actionTimeout: 25_000 });

test.describe("recording a financed deal's economics through the interface", () => {
  /**
   * This spec RUNS on Trusted Main E2E; it is not skipped. Since SCRUM-417 UX3
   * the deal record sits behind a "Deal details" toggle, so it is opened with
   * openDealDetails() before the record's controls are used.
   *
   * This drives the deal cockpit end to end: the quotation, the approved
   * amount, the handover and the finalize are all entered through that screen's
   * controls. A redesign moves every one of them.
   *
   * What this proves is not a layout detail: it is that an operator can REACH
   * the economics writers at all. SCRUM-68 exists because they could not. The
   * mutations were real and had no caller, and a configured deal stopped dead
   * after its credit decision. It is also the only spec that exercises
   * separation of duties across two identities end to end. A redesign that
   * ships without keeping this gate can reintroduce exactly the defect the
   * original ticket was filed for.
   *
   * Tracked with the redesign: SCRUM-63 (Unified Deal Workspace).
   */

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
      await approveCreditDecision(managerPage, dealUrl);

      // --- the salesperson records what was SENT to the finance company ----
      await recordQuotation(page, dealUrl);
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
      await recordApprovedAmount(managerPage, dealUrl, async (approvalDialog) => {
        // The rate the split will be computed at, stated before the money
        // decision is committed rather than discovered in the result.
        await expect(approvalDialog.getByText(`${PURCHASE_LTV}%`)).toBeVisible();
      });

      // --- the derived economics, worked out by the server -----------------
      // 13,000 approved - 3,000 customer first payment = 10,000 funded (within 90% cap of 11,700),
      // leaving 1,300 unfinanced. Asserted as figures rather than as "a panel appeared":
      // a split that renders but does not add up is the failure this is here to catch.

      // The approval moves the live step to handover, which folds the decision
      // card into the collapsed "Deal details" record (SCRUM-417 UX3) — open it
      // the way an operator would before reading the split.
      await openDealDetails(managerPage);
      await expect(managerPage.getByText("What that leaves")).toBeVisible();
      await expect(managerPage.getByText(/10,000/).first()).toBeVisible();
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

      // --- closing readiness (SCRUM-407), completed from the cockpit ---------
      // SCRUM-432. The server refuses to finalize a covered deal whose costs
      // are not itemized and reconciled, or that has no legal invoice (the v1
      // plan posts revenue from it; SCRUM-411 retires that). This spec used to
      // click "Confirm closing" without either and then match "Closed" as a
      // substring anywhere on the page, so it passed while nothing closed.
      // The close is withheld first, and says why, rather than offered and
      // refused. exact: the step checklist inside this container renders its
      // current "close-deal" item as a button named "Close the deal Next",
      // which a substring match would also take.
      const close = nextStep.getByRole("button", { name: "Close the deal", exact: true });
      await expect(nextStep).toContainText("The deal is not ready to close yet");
      await expect(close).toHaveCount(0);

      // No costs were borne: that is stated as a zero-cost line, then checked.
      // The costs panel lives in the record at this step (idempotent).
      await openDealDetails(managerPage);
      const costs = managerPage.getByTestId("deal-handover-costs");
      await costs.getByRole("button", { name: "Add cost" }).click();
      const addCost = costs.getByTestId("deal-handover-cost-add");
      await addCost.locator("#handover-cost-type").selectOption("OTHER_CLOSING_EXPENSE");
      await addCost
        .locator("#handover-cost-description")
        .fill("The dealership bore no closing costs on this deal.");
      await addCost.locator("#handover-cost-amount").fill("0");
      await addCost.getByRole("button", { name: "Save cost" }).click();
      await expect(addCost).toHaveCount(0);
      await costs.getByRole("button", { name: "Reconcile fee" }).click();
      await costs.locator("#reconcile-notes").fill("Nothing to match: no costs were borne.");
      await costs.getByRole("button", { name: "Confirm reconciliation" }).click();
      await expect(costs.getByRole("button", { name: "Reconcile fee" })).toHaveCount(0);

      // The costs are closable now, and the close is STILL withheld — for the
      // legal invoice alone. Without this the first withheld assertion could
      // be satisfied by the costs, and a broken invoice gate would go unseen.
      const checklist = managerPage.getByTestId("deal-closing-checklist");
      await expect(checklist.getByTestId("closing-check-COSTS_CLOSABLE")).toHaveAttribute(
        "data-status",
        "READY",
      );
      await expect(
        checklist.getByTestId("closing-check-LEGAL_INVOICE_RECORDED"),
      ).toHaveAttribute("data-status", "BLOCKED");
      await expect(close).toHaveCount(0);

      // The legal invoice, made out to the finance company (the dialog's
      // default). The plan must balance: with no deposit, no customer gap and
      // nothing deducted, revenue is exactly the 13,000 the company remits.
      // The checklist's own link for the blocked check opens the same dialog
      // (both call legalInvoice.onRecord); the card-header button shares the
      // name, so a role+name lookup matches two elements.
      await checklist.getByTestId("closing-check-go-LEGAL_INVOICE_RECORDED").click();
      const invoiceDialog = managerPage.getByRole("dialog");
      await invoiceDialog.locator("#legal-invoice-amount").fill("13000");
      await invoiceDialog.locator("#legal-invoice-number").fill(`INV-E2E-${testDataSuffix()}`);
      // SCRUM-596 (F-28): the invoice date is the paper's date. While the
      // browser's day has not begun on the ledger's UTC clock (00:00-03:00 in
      // Amman) nothing is pre-filled and saving waits for an explicit pick —
      // never a silent move into the previous day. Either way the test picks
      // the latest day the picker allows, which the server always accepts.
      const invoiceDate = invoiceDialog.locator("#legal-invoice-date");
      const save = invoiceDialog.getByRole("button", { name: "Save Legal Invoice" });
      if (await invoiceDialog.locator("#legal-invoice-date-hint").isVisible()) {
        await expect(invoiceDate).toHaveValue("");
        await expect(save).toBeDisabled();
        await managerPage.screenshot({
          path: test.info().outputPath("legal-invoice-date-not-open-yet.png"),
        });
      }
      const latestDay = await invoiceDate.getAttribute("max");
      expect(latestDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await invoiceDate.fill(latestDay!);
      await save.click();
      await expect(invoiceDialog).not.toBeVisible();
      await expect(
        checklist.getByTestId("closing-check-LEGAL_INVOICE_RECORDED"),
      ).toHaveAttribute("data-status", "READY");

      // And now — and only now — closing is the step the rail names.
      await expect(close).toBeVisible();
      await close.click();
      const finalizeDialog = managerPage.getByRole("dialog");
      await expect(finalizeDialog).toContainText("It cannot be undone");
      await finalizeDialog.getByRole("button", { name: "Confirm closing" }).click();

      // The deal is closed: the record's own status, exactly, in the deal's
      // header — not the word appearing somewhere on the page — and there is
      // no close left to offer.
      await expect(
        managerPage.getByTestId("deal-header").getByText("Closed", { exact: true }),
      ).toBeVisible();
      await expect(close).toHaveCount(0);
    } finally {
      await approverContext.close();
    }
  });
});
