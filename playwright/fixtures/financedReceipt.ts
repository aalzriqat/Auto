import { expect, type Page } from "@playwright/test";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { getDictionary } from "../../lib/i18n/dictionaries";
import { authenticatedConvexClient, testDataSuffix } from "../utils";

export async function createReceivingBank(page: Page, orgId: Id<"organizations">) {
  const copy = getDictionary("en");
  await page.goto(`/${orgId}/accounting?section=cash`);

  const client = await authenticatedConvexClient(page);
  const settings = await client.query(api.orgSettings.get, { orgId });
  const currency = settings?.currency;
  if (!currency) throw new Error("The test organization needs a configured currency.");
  const name = `QA TEST Deal Receipt ${testDataSuffix()}`;

  await page.getByRole("button", { name: copy.CreateBankAccount, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.CreateBankAccount });
  await dialog.getByPlaceholder("e.g. Main Operating Account").fill(name);
  await expect(dialog.locator("input[maxlength='3']")).toHaveValue(currency);
  await expect(dialog.getByRole("spinbutton")).toHaveValue("0");
  await dialog.getByRole("button", { name: copy.CreateBankAccount }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();

  const accounts = await client.query(api.bankAccounts.list, { orgId });
  const bank = accounts.find((entry) => entry.name === name);
  if (!bank?.isActive || bank.currency !== currency || bank.openingBalanceMinor !== 0) {
    throw new Error("The receiving-bank fixture was not saved with the expected opening state.");
  }
  return { id: bank._id, name, currency };
}

export async function expectPostedFinancedReceipt(
  client: ConvexHttpClient,
  route: Readonly<{ orgId: Id<"organizations">; applicationId: Id<"financeApplications"> }>,
  bank: Awaited<ReturnType<typeof createReceivingBank>>,
  approvedAmount: number,
): Promise<void> {
  const { orgId, applicationId } = route;
  const { currency } = bank;
  const { maximumFractionDigits: scale } = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).resolvedOptions();
  if (scale === undefined) throw new Error("The receipt currency has no minor-unit precision.");
  const amountMinor = approvedAmount * 10 ** scale;
  const entries = async () => {
    const events = await client.query(api.accountingLedger.listAccountingEvents, {
      orgId,
      sourceType: "financeApplications",
      sourceId: `disbursement_${applicationId}`,
    });
    return events.filter((event) => event.eventType === "FINANCE_CASH_RECEIVED");
  };

  await expect.poll(entries, { timeout: 60_000 }).toMatchObject([{
    status: "POSTED",
    currency,
    payload: {
      applicationId,
      amountMinor,
      currency,
      paymentMethod: "BANK_TRANSFER",
      bankAccountId: bank.id,
    },
  }]);
  const [receipt] = await entries();
  if (!receipt?.journalEntryId) throw new Error("The posted receipt has no linked journal entry.");

  const journal = await client.query(api.accountingLedger.getJournalEntry, {
    orgId,
    journalEntryId: receipt.journalEntryId,
  });
  expect(journal?.entry.accountingEventId).toBe(receipt._id);

  const accounts = await client.query(api.chartOfAccounts.list, { orgId });
  const accountCode = new Map(accounts.map(({ _id, code }) => [_id, code]));
  const lines = journal?.lines.map((line) => ({
    code: accountCode.get(line.accountId),
    debitMinor: line.debitMinor,
    creditMinor: line.creditMinor,
    currency: line.currency,
    bankAccountId: line.bankAccountId,
  }));
  expect(lines).toHaveLength(2);
  expect(lines).toEqual(expect.arrayContaining([
    { code: "1110", debitMinor: amountMinor, creditMinor: 0, currency, bankAccountId: bank.id },
    { code: "1210", debitMinor: 0, creditMinor: amountMinor, currency, bankAccountId: undefined },
  ]));
  const application = await client.query(api.applications.get, route);
  expect(application).toMatchObject({
    disbursedAt: expect.any(Number),
    disbursedAmountMinor: amountMinor,
    settlementStatus: "FULLY_SETTLED",
  });
}
