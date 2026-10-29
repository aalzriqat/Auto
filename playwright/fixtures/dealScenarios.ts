import { expect, test, type Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { createCustomer, gotoOrgRoute, testDataSuffix, testVin } from "../utils";
import {
  CUSTOMER_STATUS,
  approveCreditDecision,
  dismissOverlays,
  hideFloatingButtons,
  openDealDetails,
} from "./financedDeal";

/**
 * The steps of a whole deal, parameterised, for the accounting-verified
 * scenario matrix (SCRUM-595).
 *
 * `financedDeal.ts` builds ONE deal with fixed figures because its spec is
 * about reaching the writers. The matrix is about what those writers POST, so
 * every figure that changes the posting — the company's purchase LTV, the
 * vehicle's cost, the down payment, a deposit and how it was paid, the
 * expected-payment method — is an input here, and each step returns control to
 * the spec so it can snapshot the ledger between steps.
 *
 * Everything still goes through the screens an operator uses, with one
 * exception: a vehicle WITH A COST is created through the same public
 * `vehicles.create` mutation the Add Vehicle wizard calls. The UI helper
 * (`createVehicle`) always records cost 0, and a sale of a zero-cost vehicle
 * posts no cost of sale — the exact line the matrix has to check.
 */

export type DepositMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
export type ExpectedPaymentMethod = "CASH" | "INTERNAL_INSTALLMENT" | "CHEQUE" | "BANK_TRANSFER";
export type ForwardMethod = "BANK_TRANSFER" | "CASH" | "CHEQUE" | "CARD";

export type FinancedScenario = {
  id: string;
  title: string;
  company: { name: string; ltvPercent: number };
  vehicle: { price: number; cost: number; costPaidBy: "BANK_TRANSFER" | "CASH" | "CHEQUE" | "CARD" | "ON_ACCOUNT" };
  downPayment: number;
  /** What the dealership sends the company; omitted = keep the calculated figure. */
  quotation?: number;
  approved: number;
  deposit?: { amount: number; method: DepositMethod };
  expectedPayment: ExpectedPaymentMethod;
  forwardMethod?: ForwardMethod;
  /** How an approval below the quotation is settled; absent = the dealership absorbs it. */
  gap?: GapAgreement;
};

/** A finance company of a given purchase LTV, created once per deployment and reused. */
export async function ensureCompany(
  page: Page,
  company: { name: string; ltvPercent: number },
): Promise<void> {
  await gotoOrgRoute(page, "settings/finance");
  await dismissOverlays(page);
  await expect(page.getByRole("button", { name: "Add Status" })).toBeVisible();
  await hideFloatingButtons(page);
  // The status must exist before a company can accept it; the configured
  // fixture creates it, and every scenario run calls that first.
  await expect(page.getByText(CUSTOMER_STATUS, { exact: true }).first()).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: company.name }).first();
  const exists = await row
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (exists) return;

  await page.getByRole("button", { name: "Add Company" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#company-name").fill(company.name);
  await dialog.locator("#default-ltv-percent").fill(String(company.ltvPercent));
  await dialog.locator("#admin-fees").fill("0");
  await dialog.locator("#first-payment-offset-rule").selectOption("yes");
  await dialog.getByLabel(CUSTOMER_STATUS).first().check();
  await dialog.locator("#default-ltv-percent").press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(company.name, { exact: true }).first()).toBeVisible();
}

/**
 * The supplier master row named `displayName`, created through the public mutation on first use.
 * SCRUM-868 P2: a creditor is sent to the backend as an id, never as typed text.
 */
export async function ensureSupplier(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  displayName: string,
): Promise<Id<"suppliers">> {
  const found = await client.query(api.suppliers.search, { orgId, query: displayName });
  const exact = found.find((row) => row.displayName === displayName && row.status === "ACTIVE");
  if (exact) return exact._id;
  const created = await client.mutation(api.suppliers.create, {
    orgId,
    displayName,
    idempotencyKey: `qa-supplier:${displayName}`,
  });
  return created.supplierId;
}

/** A vehicle carrying a real cost, through the mutation the Add Vehicle wizard calls. */
export async function createCostedVehicle(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
  opts: FinancedScenario["vehicle"] & { model: string },
): Promise<Id<"vehicles">> {
  const bankFunded = opts.costPaidBy === "BANK_TRANSFER" || opts.costPaidBy === "CHEQUE" || opts.costPaidBy === "CARD";
  const bankAccountId = opts.cost > 0 && bankFunded ? await ensureReceivingBank(client, orgId) : undefined;
  return (await client.mutation(api.vehicles.create, {
    orgId,
    vin: testVin(),
    make: "Playwright",
    model: opts.model,
    year: 2024,
    mileage: 100,
    color: "Black",
    fuelType: "Petrol",
    transmission: "Automatic",
    sellingPrice: opts.price,
    purchasePrice: opts.cost,
    purchasePaymentMethod: opts.costPaidBy,
    ...(bankAccountId ? { bankAccountId } : {}),
    // Bought on account, the payable needs someone to owe.
    // SCRUM-717: the creditor of an owned purchase is its own field, never the consignment supplier.
    // SCRUM-868 P2: it is a supplier master id; the server writes the name from the master.
    ...(opts.costPaidBy === "ON_ACCOUNT"
      ? { purchaseSupplierId: await ensureSupplier(client, orgId, "QA TEST Supplier") }
      : {}),
    sourceType: "STOCK",
    status: "AVAILABLE",
    notes: "QA TEST — SCRUM-595 scenario matrix",
    idempotencyKey: `qa-scenario-${opts.model}`,
  })) as Id<"vehicles">;
}

export async function scenarioCustomer(page: Page, tag: string): Promise<string> {
  const { firstName, lastName } = await createCustomer(page, {
    lastName: `${tag}-${testDataSuffix()}`,
  });
  return `${firstName} ${lastName}`;
}

/** Wizard steps 1–3 for a configured finance company; leaves the page on step 4. */
export async function quoteFinancedDeal(
  page: Page,
  s: FinancedScenario,
  fixtures: { model: string; customer: string },
): Promise<void> {
  await gotoOrgRoute(page, "sales");
  await dismissOverlays(page);
  await page.locator("#btn-new-installment-sale").click();
  await hideFloatingButtons(page);

  const startFresh = page.getByRole("button", { name: "Start Fresh" });
  const selectVehicle = page.getByRole("button", { name: /Select an available vehicle/ });
  await expect(startFresh.or(selectVehicle).first()).toBeVisible();
  if (await startFresh.isVisible()) {
    await startFresh.click();
    await expect(selectVehicle).toBeVisible();
  }

  await selectVehicle.click();
  await page.getByPlaceholder(/Search by make, model/).fill(fixtures.model);
  await page.getByText(fixtures.model, { exact: false }).first().click();
  await page.locator('input[name="vehiclePrice"]').fill(String(s.vehicle.price));
  await page.locator('input[name="downPayment"]').fill(String(s.downPayment));
  await page.locator('input[name="termMonths"]').fill("60");
  await page.getByText(CUSTOMER_STATUS, { exact: true }).first().click();
  // exact: one company's name can be a prefix of another's.
  await page.getByText(s.company.name, { exact: true }).first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByPlaceholder(/Search by name, phone/).fill(fixtures.customer);
  await page.getByText(fixtures.customer, { exact: false }).first().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByRole("button", { name: "Generate Quote", exact: true }).click();
  await expect(page.getByText("Quote generated and saved!")).toBeVisible();
  await expect(page.getByText(/AutoFlow calculation/)).toBeVisible();
}

/** Step 4: the deposit, recorded by someone allowed to confirm money received. */
export async function recordQuoteDeposit(
  page: Page,
  deposit: { amount: number; method: DepositMethod },
): Promise<void> {
  await page.getByRole("button", { name: "Record Deposit" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[name="amount"]').fill(String(deposit.amount));
  await dialog.getByRole("combobox", { name: "Payment Method" }).click();
  const label = { CASH: "Cash", BANK_TRANSFER: "Bank Transfer", CHEQUE: "Cheque", CARD: "Card" }[
    deposit.method
  ];
  await page.getByRole("option", { name: label, exact: true }).click();
  if (deposit.method === "BANK_TRANSFER" || deposit.method === "CARD") {
    await dialog.locator("#record-deposit-bank").click();
    await page.getByRole("option", { name: `${RECEIVING_BANK_NAME} · JOD`, exact: true }).click();
  }
  await dialog.locator('textarea[name="notes"]').fill("QA TEST deposit (SCRUM-595)");
  await dialog.getByRole("button", { name: "Record Deposit" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Deposit Recorded/ })).toBeVisible();
}

/** Step 4 → the application; returns its deal URL. */
export async function startApplication(page: Page, customer: string): Promise<string> {
  const start = page.getByRole("button", { name: "Start application & record quotation" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText(/View Application/)).toBeVisible();

  await gotoOrgRoute(page, "deals");
  await dismissOverlays(page);
  await page.getByRole("tab", { name: /All deals/ }).click();
  await page.getByRole("textbox", { name: "Search deals by customer, vehicle, financier or owner" }).fill(customer);
  const row = page.getByRole("row").filter({ hasText: customer }).first();
  // The list pages oldest first (SCRUM-603): past 100 deals a new one only
  // appears after "Load more". Reach it the way a user would, and record that
  // it was needed, so the defect stays visible instead of being absorbed.
  const loadMore = page.getByRole("button", { name: /^Load more$/i });
  for (let pages = 0; pages < 20; pages++) {
    // The list renders in stages; wait until it shows either the deal or the
    // way to the next page. Neither, once everything is loaded, is a failure.
    await expect(row.or(loadMore).first()).toBeVisible({ timeout: 30_000 });
    if (await row.isVisible()) break;
    await loadMore.click(); // waits while the previous page is still loading
    test.info().annotations.push({
      type: "known-defect",
      description: `SCRUM-603: ${customer} needed "Load more" (page ${pages + 2}) to appear on the Deals page`,
    });
  }  await expect(row).toBeVisible();
  await row.locator('a[href$="/deal"]').first().click();
  await page.waitForURL(/\/applications\/[^/]+\/deal$/, { timeout: 60_000 });
  return page.url();
}

export function applicationIdOf(dealUrl: string): Id<"financeApplications"> {
  const match = /\/applications\/([^/]+)\/deal$/.exec(new URL(dealUrl).pathname);
  if (!match) throw new Error(`Unexpected deal URL shape: ${dealUrl}`);
  return match[1] as Id<"financeApplications">;
}

export async function recordQuotationAmount(page: Page, dealUrl: string, amount: number): Promise<void> {
  await page.goto(dealUrl);
  await dismissOverlays(page);
  await hideFloatingButtons(page);
  await page.getByRole("button", { name: "Record quotation" }).click();
  const dialog = page.getByRole("dialog");
  const input = dialog.locator("#submitted-quotation-amount");
  // The calculation can land while `fill` runs (between its select-all and its
  // insert): the one-shot prefill then writes the still-untouched field and the
  // typed figure is APPENDED to it — F21 recorded "21428.57213000". So type
  // only once the field has settled (the prefill landed, or never will), and
  // type ONCE: a retry loop would turn that race into a pass and hide it (Codex
  // F21 on b246aed9a; the UI window itself is tracked as SCRUM-607).
  await expect(input).toBeVisible();
  let last = await input.inputValue();
  let stableSince = Date.now();
  await expect
    .poll(
      async () => {
        const now = await input.inputValue();
        if (now !== last) {
          last = now;
          stableSince = Date.now();
        }
        return Date.now() - stableSince;
      },
      { timeout: 20_000, intervals: [250], message: "the quotation field must settle before typing" },
    )
    .toBeGreaterThanOrEqual(2_000);
  await input.fill(String(amount));
  await expect(input, "the typed quotation must be recorded exactly as typed").toHaveValue(String(amount));
  const reason = dialog.locator("#submitted-quotation-reason");
  // Rendered once the typed figure departs from the calculated one, a beat
  // after the fill — `isVisible()` asks too early.
  const departs = await reason
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (departs) {
    await reason.fill("QA TEST: the finance company was sent the negotiated figure.");
  }
  await dialog.getByRole("button", { name: "Record quotation" }).click();
  await expect(dialog).not.toBeVisible();
}

export async function recordApproved(managerPage: Page, dealUrl: string, amount: number): Promise<void> {
  await managerPage.goto(dealUrl);
  await dismissOverlays(managerPage);
  await hideFloatingButtons(managerPage);
  await managerPage.getByRole("button", { name: "Record approved amount" }).click();
  const dialog = managerPage.getByRole("dialog");
  await dialog.locator("#approved-purchase-amount").fill(String(amount));
  await dialog.locator("#approved-purchase-notes").fill("QA TEST: recorded from the company's advice.");
  await dialog.getByRole("button", { name: "Record approved amount" }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Who covers the net shortfall (SCRUM-766), in major units. The customer's part
 * is placed on the destinations that must add up to it (ResolveGapDialog): cash
 * or instalments to the dealership, or paid straight to the finance company. The
 * dealership-bound part becomes a customer receivable (1200) at close and is
 * billed on the legal invoice (financedSalePostingPlan v2: legal invoice =
 * approved + customer's dealership-bound part). The finance-company part is not
 * the dealership's money: it lowers the contribution the dealership forwards by
 * the same amount (SCRUM-766 PR-B).
 */
export type GapAgreement =
  | { mode: "DEALER_ABSORBS" }
  | {
      mode: "CUSTOMER_ABSORBS" | "SPLIT";
      /** SPLIT only: the customer's part; the dealership's is derived. */
      customerShare?: number;
      cash: number;
      installments: number;
      /** Paid by the customer straight to the finance company (SCRUM-766 PR-B); 0 when absent. */
      toFinanceCompany?: number;
    };

const GAP_MODE_LABEL = {
  CUSTOMER_ABSORBS: /The customer covers it/,
  SPLIT: /Customer and dealership split it/,
  DEALER_ABSORBS: /The dealership covers it/,
} as const;

/**
 * An approved amount (or LTV) that leaves the showroom short of the quote-time
 * economics opens a net shortfall that blocks handover until someone decides who
 * covers it. Manager only: the
 * salesperson may not resolve the gap on their own deal.
 */
export async function resolveAppraisalGap(
  managerPage: Page,
  dealUrl: string,
  agreement: GapAgreement,
): Promise<void> {
  await managerPage.goto(dealUrl);
  await dismissOverlays(managerPage);
  await hideFloatingButtons(managerPage);
  await managerPage.getByRole("button", { name: "Resolve the shortfall" }).first().click();
  const dialog = managerPage.getByRole("dialog");
  await expect(dialog.getByText("Resolve the shortfall").first()).toBeVisible();
  await dialog.getByRole("radio", { name: GAP_MODE_LABEL[agreement.mode] }).click();
  if (agreement.mode !== "DEALER_ABSORBS") {
    if (agreement.mode === "SPLIT") {
      await dialog.locator("#gap-customer-share").fill(String(agreement.customerShare ?? 0));
    }
    await dialog.locator("#gap-cash").fill(String(agreement.cash));
    await dialog.locator("#gap-installments").fill(String(agreement.installments));
    await dialog.locator("#gap-financier").fill(String(agreement.toFinanceCompany ?? 0));
  }
  await dialog.locator("#gap-notes").fill(`QA TEST: net shortfall settled as ${agreement.mode}.`);
  await dialog.getByRole("button", { name: "Resolve the shortfall" }).click();
  await expect(dialog).not.toBeVisible();

  // The agreement to pay the finance company is a promise: the contribution drops, and the
  // deal can close, only after the payment is CONFIRMED with its reference (SCRUM-766 PR-B).
  if (agreement.mode !== "DEALER_ABSORBS" && (agreement.toFinanceCompany ?? 0) > 0) {
    await confirmCustomerPaymentToFinanceCompany(managerPage, agreement.toFinanceCompany ?? 0);
  }
}

/** The number in a rendered money figure ("400 JOD", "1,250.500 JOD" -> 1250.5). */
function renderedAmount(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9.]/g, ""));
}

/**
 * Confirms, from the cockpit's payment card, that the customer paid the finance company the
 * whole amount still awaiting confirmation (the dialog opens pre-filled with it), then checks
 * the figures as numbers: `toContainText("0")` would also pass "400 JOD".
 */
export async function confirmCustomerPaymentToFinanceCompany(
  managerPage: Page,
  expectedConfirmedMajor: number,
): Promise<void> {
  // The recorded approval advances the workbench to handover. Its financial
  // decision card remains available in the operator's deal-details section.
  await openDealDetails(managerPage);
  const card = managerPage.getByTestId("customer-finance-company-payment-card");
  await card.getByRole("button", { name: "Confirm payment" }).click();
  const dialog = managerPage.getByRole("dialog");
  await dialog.locator("#cust-fc-pay-reference").fill(`QA TEST TRF-${testDataSuffix()}`);
  await dialog.getByRole("button", { name: "Confirm payment" }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () => renderedAmount(await card.getByTestId("customer-finance-company-awaiting").textContent()))
    .toBe(0);
  await expect
    .poll(async () => renderedAmount(await card.getByTestId("customer-finance-company-confirmed").textContent()))
    .toBe(expectedConfirmedMajor);
}

export async function resolveAppraisalGapDealerAbsorbs(managerPage: Page, dealUrl: string): Promise<void> {
  await resolveAppraisalGap(managerPage, dealUrl, { mode: "DEALER_ABSORBS" });
}

export { approveCreditDecision };

/**
 * Handover → expected payment → zero-cost line + reconcile, as the manager.
 * The caller separately measures the pre-close forward and final sale entries.
 */
export async function prepareFinancedDealForClosing(
  managerPage: Page,
  dealUrl: string,
  s: FinancedScenario,
): Promise<void> {
  await managerPage.goto(dealUrl);
  await dismissOverlays(managerPage);
  await hideFloatingButtons(managerPage);
  const nextStep = managerPage.getByTestId("deal-next-step");

  await nextStep.getByRole("button", { name: "Register vehicle handover" }).click();
  const handover = managerPage.getByRole("dialog");
  await handover.getByRole("button", { name: "Confirm handover" }).click();
  await expect(handover).not.toBeVisible();

  await nextStep.getByRole("button", { name: "Register the expected payment" }).click();
  const expected = managerPage.getByRole("dialog");
  if (s.expectedPayment !== "BANK_TRANSFER") {
    await expected.getByRole("combobox", { name: "Payment Method" }).click();
    const label = {
      CASH: "Cash",
      INTERNAL_INSTALLMENT: "Installment with the customer",
      CHEQUE: "Cheque (finance company or bank)",
      BANK_TRANSFER: "Bank transfer",
    }[s.expectedPayment];
    await managerPage.getByRole("option", { name: label, exact: true }).click();
    if (s.expectedPayment === "CHEQUE") {
      await expected.locator('input[name="bank"]').fill("QA TEST Bank");
      await expected.locator('input[name="chequeNumber"]').fill(`CHQ-${testDataSuffix()}`);
      await expected.locator('input[name="faceAmount"]').fill(String(s.approved));
    }
  }
  await expected.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(expected).not.toBeVisible();

  await openDealDetails(managerPage);
  const costs = managerPage.getByTestId("deal-handover-costs");
  await costs.getByRole("button", { name: "Add cost" }).click();
  const addCost = costs.getByTestId("deal-handover-cost-add");
  await addCost.locator("#handover-cost-type").selectOption("OTHER_CLOSING_EXPENSE");
  await addCost.locator("#handover-cost-description").fill("QA TEST: no closing costs were borne.");
  await addCost.locator("#handover-cost-amount").fill("0");
  await addCost.getByRole("button", { name: "Save cost" }).click();
  await expect(addCost).toHaveCount(0);
  await costs.getByRole("button", { name: "Reconcile fee" }).click();
  await costs.locator("#reconcile-notes").fill("QA TEST: nothing to match.");
  await costs.getByRole("button", { name: "Confirm reconciliation" }).click();
  await expect(costs.getByRole("button", { name: "Reconcile fee" })).toHaveCount(0);
}

/** Finalize only after the caller has recorded and checked any required forward. */
export async function closeFinancedDeal(managerPage: Page): Promise<void> {
  // SCRUM-411: no legal invoice is recorded. The server derives the sale from the
  // approved amount, the contribution and the customer's gap, so a deal with no
  // real invoice closes once the other prerequisites are met.
  const close = managerPage.getByTestId("deal-next-step").getByRole("button", { name: "Close the deal", exact: true });
  await expect(close).toBeVisible();
  await close.click();
  const finalize = managerPage.getByRole("dialog");
  await finalize.getByRole("button", { name: "Confirm closing" }).click();
  await expect(
    managerPage.getByTestId("deal-header").getByText("Closed", { exact: true }),
  ).toBeVisible();
}

/** The forward to the finance company, when the deal owes one. */
export async function recordForward(
  managerPage: Page,
  method: ForwardMethod,
): Promise<void> {
  const action = managerPage
    .getByTestId("deal-next-step")
    .getByRole("button", { name: "Record payment to the finance company" });
  await expect(action).toBeVisible();
  await action.click();
  const dialog = managerPage.getByRole("dialog");
  await expect(dialog.getByTestId("forward-breakdown")).toBeVisible();
  await dialog.locator("#record-forward-method").selectOption(method);
  if (method !== "CASH") {
    // The scenario oracles are JOD. Never pick an arbitrary bank or currency.
    await dialog.locator("#record-forward-bank").selectOption({ label: `${RECEIVING_BANK_NAME} · JOD` });
  }
  await dialog.locator("#record-forward-reference").fill(`FWD-QA-${testDataSuffix()}`);
  await dialog.getByRole("button", { name: "Record payment" }).click();
  await expect(dialog).not.toBeVisible();
}

/** Record the actual QA return before cancelling a deal whose forward was paid. */
export async function recordForwardReturned(managerPage: Page): Promise<void> {
  await managerPage.getByTestId("deal-forward-returned").click();
  const dialog = managerPage.getByRole("dialog").filter({ hasText: "Report the payment returned" });
  await dialog.locator("#forward-correction-reason").fill("QA TEST: the finance company returned the full forwarded payment before cancellation.");
  await dialog.getByRole("button", { name: "Report returned by the company", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/**
 * Cancel the deal from the cockpit. On a CLOSED deal this unwinds the sale and
 * its posted journal (convex/applications.ts cancelApplication). All dialog
 * fields are optional; the reason is filled so the audit trail says why.
 */
export async function cancelDeal(managerPage: Page, reason: string): Promise<void> {
  await managerPage.getByTestId("deal-cancel-application").click();
  const dialog = managerPage.getByRole("dialog");
  await dialog.locator("#cancel-application-reason").fill(`QA TEST — ${reason}`);
  await dialog.getByRole("button", { name: "Cancel Application" }).click();
  await expect(dialog).not.toBeVisible();
}

/** The finance company's money arriving: the receivable from it is settled. */
export type DepositTreatment = "RETURN" | "REFUND" | "FORFEIT";

/**
 * A stopped (cancelled) deal still holding the customer's deposit shows it on
 * the deal cockpit (components/applications/cockpit/StoppedDealDepositsPanel):
 * Refund — with the method the cash leaves by, chosen in the confirmation — or
 * Forfeit. RETURN is "decide nothing": the deposit stays HELD on the quote for a
 * later deal, so the step asserts it is still held and moves no money.
 * Runs on the cockpit `cancelDeal` leaves the manager on.
 */
export async function decideDeposit(
  managerPage: Page,
  _customer: string,
  decision: { treatment: DepositTreatment; refundMethod?: "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD" },
): Promise<void> {
  const panel = managerPage.getByTestId("deal-deposits");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const heldRow = panel.locator('[data-testid^="deal-deposit-"]').filter({ hasText: "Held" }).first();
  await expect(heldRow).toBeVisible();
  if (decision.treatment === "RETURN") return;

  await heldRow.getByRole("button", { name: decision.treatment === "REFUND" ? "Refund" : "Forfeit", exact: true }).click();
  const confirm = managerPage.getByRole("dialog").filter({ hasText: "Resolve this deposit?" });
  await expect(confirm).toBeVisible();
  if (decision.treatment === "REFUND") {
    const method = { CASH: "Cash", BANK_TRANSFER: "Bank Transfer", CHEQUE: "Cheque", CARD: "Card" }[
      decision.refundMethod ?? "CASH"
    ];
    await confirm.getByRole("combobox").click();
    await managerPage.getByRole("option", { name: method, exact: true }).click();
    if (decision.refundMethod && decision.refundMethod !== "CASH") {
      await confirm.getByRole("combobox", { name: "Bank account received into", exact: true }).click();
      await managerPage.getByRole("option", { name: `${RECEIVING_BANK_NAME} · JOD`, exact: true }).click();
    }
  }
  await confirm
    .getByRole("button", { name: decision.treatment === "REFUND" ? "Confirm Refund" : "Confirm Forfeit" })
    .click();
  await expect(confirm).not.toBeVisible({ timeout: 60_000 });
  await expect(
    panel.getByText(decision.treatment === "REFUND" ? "Refunded" : "Forfeited", { exact: true }).first(),
  ).toBeVisible({ timeout: 60_000 });
}

/** The disposable-environment bank every through-dealership receipt names (SCRUM-54). */
export const RECEIVING_BANK_NAME = "QA TEST Receiving Bank";

/**
 * Seeds the physical bank the finance company's transfer is received into, through the
 * same authorized `bankAccounts.create` mutation the Bank Accounts screen calls (zero
 * opening balance, so it posts nothing). It is created in the org's CURRENT currency -
 * the deal's pinned currency in a disposable environment - and reused when it is already
 * there. The receipt dialog never preselects a bank and no other bank is ever chosen, so
 * a fixture that cannot seed this fails here, before any deal step runs.
 */
export async function ensureReceivingBank(
  client: ConvexHttpClient,
  orgId: Id<"organizations">,
): Promise<Id<"bankAccounts">> {
  const settings = await client.query(api.orgSettings.get, { orgId });
  const currency = settings?.currency;
  if (!currency) throw new Error("ensureReceivingBank: the org has no currency configured; refusing to guess one.");
  const banks = await client.query(api.bankAccounts.list, { orgId });
  const bank = banks.find((b) => b.name === RECEIVING_BANK_NAME && b.isActive && b.currency === currency);
  if (bank) return bank._id;
  return await client.mutation(api.bankAccounts.create, {
    orgId,
    name: RECEIVING_BANK_NAME,
    currency,
    openingBalanceMinor: 0,
    openingBalanceDate: Date.now(),
    notes: "QA TEST - SCRUM-54 receipt fixture",
  });
}

export async function confirmDisbursement(
  managerPage: Page,
  expectedPayment: ExpectedPaymentMethod,
): Promise<void> {
  const action = managerPage
    .getByTestId("deal-next-step")
    .getByRole("button", { name: "Confirm Disbursement" });
  await expect(action).toBeVisible();
  await action.click();
  const dialog = managerPage.getByRole("dialog");
  const bankPicker = dialog.getByRole("combobox", { name: "Receiving bank account" });
  if (expectedPayment === "CASH") {
    // Cash is cash on hand: the dialog must NOT ask for a bank.
    await expect(bankPicker).toHaveCount(0);
  } else {
    // Fail closed: the picker must exist and offer the seeded bank. Nothing else is selected.
    await expect(bankPicker).toBeVisible({ timeout: 60_000 });
    await expect(bankPicker).toBeEnabled({ timeout: 60_000 });
    await bankPicker.click();
    await managerPage.getByRole("option", { name: new RegExp(`^${RECEIVING_BANK_NAME}\\b`) }).click();
    await expect(bankPicker).toContainText(RECEIVING_BANK_NAME);
  }
  await dialog.getByRole("button", { name: "Confirm Receipt" }).click();
  await expect(dialog).not.toBeVisible();
}
