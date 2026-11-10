import { expect, test, type Locator, type Page } from "@playwright/test";
import { api } from "../../convex/_generated/api";
import { dictionaries } from "../../lib/i18n/dictionaries";
import { authenticatedConvexClient, resolveOrgId, testVin } from "../utils";

const LOCAL_BACKEND = "http://127.0.0.1:3210";
test.use({ serviceWorkers: "block" });

/** Fail before any navigation or seed. This journey never accepts a cloud backend. */
async function containLocalJourney(page: Page, baseURL: string | undefined) {
  const target = process.env.NEXT_PUBLIC_CONVEX_URL?.replace(/\/$/, "");
  const app = new URL(baseURL ?? "http://localhost:3000");
  if (target !== LOCAL_BACKEND || !["localhost", "127.0.0.1"].includes(app.hostname)) {
    throw new Error("Supplier identity journey requires the disposable runner-local Convex backend and local app");
  }
  let escaped = false;
  await page.route(/https?:\/\/[^/]+\.convex\.(cloud|site)(\/|$)/, async route => {
    escaped = true;
    await route.abort("blockedbyclient");
  });
  await page.routeWebSocket(/.*/, socket => {
    const url = new URL(socket.url());
    if (url.origin === "ws://127.0.0.1:3210") socket.connectToServer();
    else { escaped = true; socket.close(); }
  });
  return () => expect(escaped, "No cloud Convex HTTP or WebSocket connection").toBe(false);
}

async function selectSupplier(page: Page, trigger: Locator, name: string) {
  await trigger.click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(trigger).toContainText(name);
  await expect(trigger.locator("bdi")).toHaveText(name);
}

/**
 * A submit that closes its dialog can detach the button before Playwright finishes the click's
 * actionability checks. The click then retries until the test times out, although the submission
 * landed (see createVehicle in ../utils.ts). Fire the click with a short cap and judge the outcome
 * by the dialog closing. The backend reads that follow still fail a submission that never happened.
 */
async function submitAndExpectClosed(dialog: Locator, button: Locator) {
  const click = button.click({ timeout: 5_000 }).catch(() => undefined);
  await expect(dialog).not.toBeVisible();
  await click;
}

async function supplierJourney(page: Page, baseURL: string | undefined, locale: "en" | "ar") {
    test.setTimeout(180_000);
    const guard = await containLocalJourney(page, baseURL);
    const t = dictionaries[locale];
    await page.addInitScript(language => localStorage.setItem("autoflow-locale", language), locale);
    await resolveOrgId(page);
    const client = await authenticatedConvexClient(page);
    const orgId = await client.mutation(api.organizations.create, { name: `QA TEST P7 ${locale} ${Date.now()}` });
    await client.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    await client.mutation(api.chartOfAccounts.initialize, { orgId });
    const now = new Date(), year = now.getUTCFullYear();
    await client.mutation(api.accountingPeriods.create, { orgId, fiscalYear: year, periodNumber: 1,
      startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true });
    const supplierName = `QA P7 ${locale} مورّد Motors`;
    const { supplierId } = await client.mutation(api.suppliers.create, { orgId, displayName: supplierName, idempotencyKey: "KEY_1" });
    const accounts = await client.query(api.chartOfAccounts.list, { orgId });
    const cash = accounts.find(account => account.systemKey === "CASH_ON_HAND");
    const payableControl = accounts.find(account => account.systemKey === "ACCOUNTS_PAYABLE_SUPPLIERS");
    if (!cash || !payableControl) throw new Error("Synthetic opening accounts unavailable");

    // Openings precede operational activity. Choose identity in the real allocation editor.
    await page.goto(`/${orgId}/accounting?section=settings`);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.getByRole("button", { name: t.OpeningBalanceSet, exact: true }).click();
    const opening = page.getByRole("dialog");
    await opening.getByLabel(t.OpeningBalanceAsOfDate, { exact: true }).fill(now.toISOString().slice(0, 10));
    await opening.getByLabel(t.OpeningBalanceMemo, { exact: true }).fill(`QA P7 ${locale}`);
    for (const [index, account] of [cash, payableControl].entries()) {
      await opening.getByRole("combobox", { name: t.OpeningBalanceAccount, exact: true }).nth(index).click();
      await page.getByRole("option", { name: new RegExp(`^${account.code} `) }).click();
    }
    await opening.getByRole("textbox", { name: t.OpeningBalanceDebit, exact: true }).nth(0).fill("100.003");
    await opening.getByRole("textbox", { name: t.OpeningBalanceCredit, exact: true }).nth(1).fill("100.003");
    const allocation = opening.getByRole("region", { name: t.OpeningAllocationSection });
    await allocation.getByRole("button", { name: t.OpeningAllocationAdd, exact: true }).click();
    await selectSupplier(page, allocation.getByRole("combobox", { name: t.OpeningAllocationSupplier, exact: true }), supplierName);
    await allocation.getByRole("textbox", { name: new RegExp(`^${t.OpeningAllocationAmount}`) }).fill("100.003");
    await allocation.getByLabel(t.OpeningAllocationSourceTitle, { exact: true }).fill(`QA P7 supplier balance ${locale}`);
    page.once("dialog", async confirmation => { expect(confirmation.type()).toBe("confirm"); await confirmation.accept(); });
    await opening.getByRole("button", { name: t.OpeningBalancePost, exact: true }).click();
    await expect(opening).not.toBeVisible();
    const payables = await client.query(api.sourcingPayables.listBounded, { orgId });
    expect(payables.complete).toBe(true);
    expect(payables.items).toHaveLength(1);
    const payable = payables.items[0];
    expect(payable.supplierId).toBe(supplierId);
    expect(payable.sourcedFromName).toBe(supplierName);
    expect(payable.amountDue).toBe(100.003);
    const beforeVehicle = await client.query(api.accountingLedger.listJournalEntries, { orgId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(beforeVehicle.isDone).toBe(true);

    // The five-step operator form selects the same canonical party for a consigned car.
    await page.goto(`/${orgId}/vehicles`);
    await page.getByRole("button", { name: t.AddVehicle, exact: true }).click();
    const vehicleDialog = page.getByRole("dialog"), vin = testVin();
    await vehicleDialog.locator('input[name="vin"]').fill(vin);
    await vehicleDialog.getByRole("button", { name: t.WizardContinue, exact: true }).click();
    await vehicleDialog.getByLabel(t.Make).fill("Toyota");
    await vehicleDialog.getByLabel(t.Model, { exact: true }).fill(`P7-${locale}`);
    await vehicleDialog.getByLabel(t.Year).fill("2024");
    await vehicleDialog.getByLabel(t.Color).fill("Black");
    await vehicleDialog.getByLabel(t.Mileage).fill("100");
    await vehicleDialog.getByRole("button", { name: t.WizardContinue, exact: true }).click();
    await vehicleDialog.getByRole("button", { name: t.VehicleOwnershipConsignment, exact: true }).click();
    await selectSupplier(page, vehicleDialog.getByTestId("vehicle-sourced-supplier"), supplierName);
    await vehicleDialog.getByLabel(t.SupplierCost).fill("80");
    await vehicleDialog.getByLabel(`${t.SellingPrice} (JOD)`, { exact: true }).fill("100");
    await vehicleDialog.getByRole("button", { name: t.WizardContinue, exact: true }).click();
    await vehicleDialog.getByRole("button", { name: t.WizardContinue, exact: true }).click();
    await submitAndExpectClosed(vehicleDialog, vehicleDialog.getByRole("button", { name: t.AddVehicle, exact: true }));
    const inventory = await client.query(api.vehicles.list, { orgId, paginationOpts: { cursor: null, numItems: 10 } });
    expect(inventory.isDone).toBe(true); expect(inventory.page).toHaveLength(1);
    expect(inventory.page[0].sourcedSupplierId).toBe(supplierId);
    expect(inventory.page[0].sourcedFromName).toBe(supplierName);
    expect(await client.query(api.accountingLedger.listJournalEntries, { orgId, paginationOpts: { cursor: null, numItems: 10 } })).toEqual(beforeVehicle);
    await page.reload();
    expect((await client.query(api.vehicles.get, { orgId, vehicleId: inventory.page[0]._id })).sourcedSupplierId).toBe(supplierId);

    // Choose the payable of that supplier. Its immutable identity is displayed, never re-selected.
    await page.goto(`/${orgId}/sourcing`);
    const row = page.getByRole("row").filter({ hasText: supplierName });
    await row.getByRole("button", { name: t.MarkPaid, exact: true }).click();
    const payment = page.getByRole("dialog");
    await expect(payment.getByText(supplierName, { exact: false })).toBeVisible();
    await expect(payment.getByTestId("supplier-payment-amount")).toHaveAttribute("dir", "ltr");
    await submitAndExpectClosed(payment, payment.getByRole("button", { name: t.ConfirmPayment, exact: true }));
    await page.reload();
    const paid = await client.query(api.sourcingPayables.get, { orgId, payableId: payable._id });
    expect(paid?.supplierId).toBe(supplierId); expect(paid?.sourcedFromName).toBe(supplierName);
    expect(paid?.status).toBe("PAID"); expect(paid?.amountPaid).toBe(100.003);
    guard();
}

test("supplier identity survives opening, consignment and payable payment in en", async ({ page, baseURL }) => {
  await supplierJourney(page, baseURL, "en");
});
test("supplier identity survives opening, consignment and payable payment in ar", async ({ page, baseURL }) => {
  await supplierJourney(page, baseURL, "ar");
});
