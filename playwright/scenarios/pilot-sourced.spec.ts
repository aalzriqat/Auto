import { test, expect, type Page, type Browser } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { authenticatedConvexClient, resolveOrgId, testDataSuffix, testVin, APPROVER_AUTH_FILE } from "../utils";
import { newContainedContext } from "../containedContext";
import { recordCashSale } from "../fixtures/cashSale";
import { ensureFinanceCompany, openDealDetails } from "../fixtures/financedDeal";
import {
  type FinancedScenario, scenarioCustomer, quoteFinancedDeal, startApplication,
  approveCreditDecision, recordApproved, recordQuotationAmount, prepareFinancedDealForClosing,
  closeFinancedDeal, confirmDisbursement, ensureReceivingBank,
} from "../fixtures/dealScenarios";
import { drainOutbox, ensureLedgerMonthOpen, expectLedgerDelta, jod, ledgerDelta, snapshotLedger } from "../ledger";

test.describe.configure({ timeout: 900_000, retries: 0 });
test.use({ actionTimeout: 25_000 });

async function sourcedVehicle(page: Parameters<typeof recordCashSale>[0], model: string) {
  const orgId = await resolveOrgId(page) as Id<"organizations">;
  const client = await authenticatedConvexClient(page);
  await client.mutation(api.vehicles.create, {
    orgId, vin: testVin(), make: "Playwright", model, year: 2024, mileage: 100, color: "Black",
    fuelType: "Petrol", transmission: "Automatic", sellingPrice: 12_500, status: "AVAILABLE",
    sourceType: "SOURCED", sourcedFromName: "QA TEST G8 Supplier", sourceCost: 10_000,
    idempotencyKey: model,
  });
  return { orgId, client };
}

test("pilot SOURCED CASH pays by deposit and opens the completed deal with agency-only books", async ({ page }) => {
  const model = `QA TEST G8 cash ${testDataSuffix()}`;
  const { orgId, client } = await sourcedVehicle(page, model);
  await ensureLedgerMonthOpen(client, orgId);
  const before = await snapshotLedger(client, orgId);
  await recordCashSale(page, { model }, 12_500);
  await drainOutbox(await authenticatedConvexClient(page), orgId);
  const delta = await ledgerDelta(await authenticatedConvexClient(page), orgId, before);
  // 12,500 held, then applied to AR; 10,000 belongs to the consignor.
  // No inventory or COGS. The three balanced journal shapes are independent literals.
  expectLedgerDelta(delta, [
    { "1100": { dr: jod(12_500) }, "2100": { cr: jod(12_500) } },
    { "1200": { dr: jod(12_500) }, "2400": { cr: jod(10_000) }, "4170": { cr: jod(2_500) } },
    { "2100": { dr: jod(12_500) }, "1200": { cr: jod(12_500) } },
  ]);
});

async function sourcedFinance(page: Page, browser: Browser, route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER") {
  expect(process.env.E2E_APPROVER_USER, "Second identity is mandatory").toBeTruthy();
  expect(process.env.E2E_APPROVER_PASSWORD, "Second identity is mandatory").toBeTruthy();
  const model = `QA TEST G8 financed ${testDataSuffix()}`;
  const { orgId, client } = await sourcedVehicle(page, model);
  await ensureLedgerMonthOpen(client, orgId);
  await ensureFinanceCompany(page);
  await ensureReceivingBank(client, orgId);
  const scenario: FinancedScenario = {
    id: "G8SF", title: "SOURCED through dealership", company: { name: "AutoFlow E2E Finance", ltvPercent: 90 },
    vehicle: { price: 12_500, cost: 10_000, costPaidBy: "CASH" },
    downPayment: 1_250, quotation: 12_500, approved: 12_500, expectedPayment: "BANK_TRANSFER",
  };
  const customer = await scenarioCustomer(page, "QA TEST G8 finance");
  await quoteFinancedDeal(page, scenario, { model, customer });
  const dealUrl = await startApplication(page, customer);
  const manager = await newContainedContext(browser, { storageState: APPROVER_AUTH_FILE });
  try {
    const managerPage = await manager.newPage();
    await approveCreditDecision(managerPage, dealUrl);
    await recordQuotationAmount(page, dealUrl, 12_500);
    await recordApproved(managerPage, dealUrl, 12_500);
    await prepareFinancedDealForClosing(managerPage, dealUrl, scenario);
    // Only the OWNER's actual product authority chooses the supplier route.
    await page.goto(dealUrl);
    await openDealDetails(page);
    const choice = page.getByTestId("deal-settlement-route").getByRole("radio", { name: route === "THROUGH_DEALERSHIP" ? /^Through the dealership/ : /^Direct to the supplier/ });
    await choice.click();
    await expect(choice).toHaveAttribute("aria-checked", "true");
    const before = await snapshotLedger(await authenticatedConvexClient(page), orgId);
    await closeFinancedDeal(managerPage);
    await drainOutbox(await authenticatedConvexClient(page), orgId);
    if (route === "THROUGH_DEALERSHIP") {
      expectLedgerDelta(await ledgerDelta(await authenticatedConvexClient(page), orgId, before), {
        "1210": { dr: jod(12_500) }, "2400": { cr: jod(10_000) }, "4170": { cr: jod(2_500) },
      });
      const receiptBefore = await snapshotLedger(await authenticatedConvexClient(page), orgId);
      await confirmDisbursement(managerPage, "BANK_TRANSFER");
      await drainOutbox(await authenticatedConvexClient(page), orgId);
      expectLedgerDelta(await ledgerDelta(await authenticatedConvexClient(page), orgId, receiptBefore), {
        "1110": { dr: jod(12_500) }, "1210": { cr: jod(12_500) },
      });
    } else {
      expectLedgerDelta(await ledgerDelta(await authenticatedConvexClient(page), orgId, before), {
        "1240": { dr: jod(2_500) }, "4170": { cr: jod(2_500) },
      });
      const adviceBefore = await snapshotLedger(await authenticatedConvexClient(page), orgId);
      // External payment advice is not a dealership bank receipt.
      await page.reload();
      await openDealDetails(page);
      await page.getByRole("button", { name: "Record payment to the supplier", exact: true }).click();
      const advice = page.getByRole("dialog");
      await advice.locator("#supplier-advice-amount").fill("12500");
      await advice.locator("#supplier-advice-reference").fill("QA TEST G8 advice");
      await advice.getByRole("button", { name: "Record it", exact: true }).click();
      await expect(advice).toHaveCount(0);
      await drainOutbox(await authenticatedConvexClient(page), orgId);
      expectLedgerDelta(await ledgerDelta(await authenticatedConvexClient(page), orgId, adviceBefore), {});
    }
    await managerPage.reload();
    await expect(managerPage.getByTestId("deal-header").getByText("Closed", { exact: true })).toBeVisible();
  } finally { await manager.close(); }
}

test("pilot SOURCED configured finance reaches delivery and full financier receipt with agency-only books", async ({ page, browser }) => {
  await sourcedFinance(page, browser, "THROUGH_DEALERSHIP");
});

test("pilot SOURCED direct finance reaches delivery and records external supplier advice without a bank receipt", async ({ page, browser }) => {
  await sourcedFinance(page, browser, "DIRECT_TO_SUPPLIER");
});
