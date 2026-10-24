import { expect, type Browser, type Page } from "@playwright/test";
import { jsonToConvex } from "convex/values";
import { api } from "../../convex/_generated/api";
import { newContainedContext } from "../containedContext";
import { authenticatedConvexClient, APPROVER_AUTH_FILE, USER_AUTH_FILE, resolveOrgId } from "../utils";

const DIRECT = "accountingCutover:postOpeningBalanceDirect";
const DRAFT = "accountingCutover:draftOpeningBalance";
const APPROVE = "accountingCutover:approveOpeningBalance";
const TRACKED = new Set([DIRECT, DRAFT, APPROVE]);
const DENIED = new Set(["clever-mockingbird-719", "kindly-hound-172", "affable-eel-180"]);
const MINOR = { receivable: 100003, prepaid: 200000, capital: 300003 };
type Receipt = { fn: string; args: Record<string, unknown>; connection: string };
type ObservedReceipt = Receipt & {
  outcome: { status: "pending" } | { status: "failed" } | { status: "success"; result: unknown };
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Opening evidence object unavailable");
  return Object.fromEntries<unknown>(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Opening evidence identity unavailable");
  return value;
}
function frame(payload: string | Buffer): Record<string, unknown> | null {
  try { return record(JSON.parse(payload.toString())); } catch { return null; }
}
// Native Convex value codec, not an alternative form/backend validator.
function decode(value: unknown): unknown { return jsonToConvex(JSON.parse(JSON.stringify(value))); }

function workflowTarget(baseURL: string | undefined): URL {
  const main = process.env.GITHUB_WORKFLOW === "Trusted Main E2E (Playwright)" &&
    ["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? "");
  const candidate = process.env.GITHUB_WORKFLOW === "Trusted Browser Attack Swarm" && process.env.GITHUB_EVENT_NAME === "workflow_run";
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true" || (!main && !candidate)) {
    throw new Error("Opening browser proof requires an existing trusted Preview workflow");
  }
  const app = new URL(baseURL ?? "http://localhost:3000");
  const target = new URL(process.env.NEXT_PUBLIC_CONVEX_URL ?? "");
  const deployment = /^([a-z0-9-]+)\.convex\.cloud$/.exec(target.hostname)?.[1];
  if (!["localhost", "127.0.0.1"].includes(app.hostname) || target.protocol !== "https:" ||
      target.pathname !== "/" || !deployment || DENIED.has(deployment)) {
    throw new Error("Opening browser proof refuses a nonlocal app or non-Preview target");
  }
  return target;
}

/** Install before navigation. Only the three intended economic calls are retained. */
function observe(page: Page, expected: URL, app: URL) {
  const connections: { url: string; received: boolean }[] = [];
  const receipts: ObservedReceipt[] = [];
  let wrongTarget = false;
  page.on("request", request => {
    const url = new URL(request.url());
    if (/\.convex\.(cloud|site)$/.test(url.hostname) &&
        (url.hostname !== expected.hostname || url.protocol !== "https:")) wrongTarget = true;
  });
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (!/\.convex\.(cloud|site)$/.test(url.hostname)) return;
    if (url.hostname !== expected.hostname || url.protocol !== "wss:") { wrongTarget = true; return; }
    const connection = { url: socket.url(), received: false };
    connections.push(connection);
    const requests = new Map<number, ObservedReceipt>();
    socket.on("framesent", event => {
      const message = frame(event.payload);
      if (message?.type !== "Mutation" || typeof message.udfPath !== "string" || !TRACKED.has(message.udfPath)) return;
      if (!Number.isSafeInteger(message.requestId) || !Array.isArray(message.args) || message.args.length !== 1) return;
      const receipt: ObservedReceipt = { fn: message.udfPath, args: record(decode(message.args[0])),
        connection: connection.url, outcome: { status: "pending" } };
      requests.set(Number(message.requestId), receipt); receipts.push(receipt);
    });
    socket.on("framereceived", event => {
      connection.received = true;
      const message = frame(event.payload);
      if (message?.type !== "MutationResponse" || typeof message.requestId !== "number") return;
      const receipt = requests.get(message.requestId);
      if (receipt) receipt.outcome = message.success === true
        ? { status: "success", result: decode(message.result) } : { status: "failed" };
    });
  });
  async function guard() {
    await expect.poll(() => connections.some(connection => connection.received), { timeout: 30000 }).toBe(true);
    expect(wrongTarget, "all observed Convex sockets must address the workflow Preview").toBe(false);
    expect(new URL(page.url()).origin).toBe(app.origin);
  }
  async function successful(fn: string) {
    await expect.poll(() => receipts.filter(receipt => receipt.fn === fn && receipt.outcome.status === "success").length).toBe(1);
    await guard();
    const receipt = receipts.find(item => item.fn === fn && item.outcome.status === "success");
    if (!receipt || receipt.outcome.status !== "success") throw new Error("Successful opening browser response unavailable");
    return { fn: receipt.fn, args: receipt.args, connection: receipt.connection, result: receipt.outcome.result };
  }
  return { guard, successful };
}

export async function openingActors(browser: Browser, baseURL: string | undefined) {
  const target = workflowTarget(baseURL), app = new URL(baseURL ?? "http://localhost:3000");
  const ownerContext = await newContainedContext(browser, { storageState: USER_AUTH_FILE });
  const financeContext = await newContainedContext(browser, { storageState: APPROVER_AUTH_FILE });
  const owner = await ownerContext.newPage(), finance = await financeContext.newPage();
  await owner.addInitScript(() => localStorage.setItem("autoflow-locale", "en"));
  await finance.addInitScript(() => localStorage.setItem("autoflow-locale", "en"));
  const ownerWire = observe(owner, target, app), financeWire = observe(finance, target, app);
  try {
    await resolveOrgId(owner); await resolveOrgId(finance);
    await ownerWire.guard(); await financeWire.guard();
    const ownerClient = await authenticatedConvexClient(owner), financeClient = await authenticatedConvexClient(finance);
    return { owner, finance, ownerWire, financeWire, ownerClient, financeClient,
      async close() { await ownerContext.close(); await financeContext.close(); } };
  } catch (error) { await ownerContext.close(); await financeContext.close(); throw error; }
}
type Actors = Awaited<ReturnType<typeof openingActors>>;

export async function freshOpening(actors: Actors, label: string) {
  await actors.ownerWire.guard(); await actors.financeWire.guard();
  const client = actors.ownerClient;
  const owner = await client.query(api.users.getMe, {}), finance = await actors.financeClient.query(api.users.getMe, {});
  if (!owner || !finance || owner._id === finance._id || !finance.email) throw new Error("Two existing distinct QA identities required");
  const orgId = await client.mutation(api.organizations.create, { name: `QA TEST opening UI ${label} ${Date.now()}` });
  const roles = await client.query(api.roles.list, { orgId });
  const role = roles.find(item => item.name === "SENIOR_ACCOUNTANT");
  if (!role) throw new Error("Native finance role unavailable");
  // Email remains in memory only. This must take the existing-user branch.
  const membership = await client.mutation(api.memberships.add, { orgId, userEmail: finance.email, roleId: role._id });
  expect(membership.status).toBe("added");
  const ownerSeat = await client.query(api.memberships.getMyMembership, { orgId });
  const financeSeat = await actors.financeClient.query(api.memberships.getMyMembership, { orgId });
  expect(ownerSeat.isSystemOwnerRole).toBe(true);
  expect(financeSeat.userId).toBe(finance._id); expect(financeSeat.roleId).toBe(role._id);
  expect(financeSeat.isSystemOwnerRole).toBe(false);
  await client.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  await client.mutation(api.chartOfAccounts.initialize, { orgId });
  const now = new Date(), year = now.getUTCFullYear(), month = now.toISOString().slice(0, 7);
  await client.mutation(api.accountingPeriods.create, { orgId, fiscalYear: year, periodNumber: 1,
    startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), openImmediately: true });
  const customerId = await client.mutation(api.customers.create, { orgId, firstName: "QA TEST", lastName: "Opening UI customer" });
  const partnerId = await client.mutation(api.partnerEquity.add, { orgId, partnerName: "QA TEST opening UI partner", idempotencyKey: crypto.randomUUID() });
  const accounts = await client.query(api.chartOfAccounts.list, { orgId });
  const account = (key: string) => {
    const found = accounts.find(item => item.systemKey === key);
    if (!found) throw new Error("Native opening control account unavailable");
    return found;
  };
  const ar = account("ACCOUNTS_RECEIVABLE_CUSTOMERS"), prepaid = account("PREPAID_EXPENSES"), capital = account("PARTNER_CAPITAL");
  const ownerStatus = await client.query(api.accountingCutover.openingBalanceStatus, { orgId });
  const financeStatus = await actors.financeClient.query(api.accountingCutover.openingBalanceStatus, { orgId });
  expect(ownerStatus.canPostDirectly).toBe(true);
  expect(financeStatus.canManageFinance).toBe(true); expect(financeStatus.canPostDirectly).toBe(false);
  const journals = await client.query(api.accountingLedger.listJournalEntries, { orgId, paginationOpts: { cursor: null, numItems: 10 } });
  expect(journals.isDone).toBe(true); expect(journals.page).toHaveLength(0);
  return { orgId, customerId, partnerId, ar, prepaid, capital, month, date: now.toISOString().slice(0, 10), memo: `QA TEST ${label} opening`, ownerId: owner._id, financeId: finance._id };
}
type Fixture = Awaited<ReturnType<typeof freshOpening>>;

export async function fillOpening(page: Page, fixture: Fixture) {
  await page.goto(`/${fixture.orgId}/accounting?section=settings`);
  await page.getByRole("button", { name: "Set opening balance", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("As of date", { exact: true }).fill(fixture.date);
  await dialog.getByLabel("Memo", { exact: true }).fill(fixture.memo);
  await dialog.getByRole("button", { name: "Add line", exact: true }).click();
  const controls = [fixture.ar, fixture.prepaid, fixture.capital];
  for (let index = 0; index < controls.length; index += 1) {
    await dialog.getByRole("combobox", { name: "Account", exact: true }).nth(index).click();
    await page.getByRole("option", { name: new RegExp(`^${controls[index].code} —`) }).click();
  }
  await dialog.getByRole("textbox", { name: "Debit", exact: true }).nth(0).fill("100.003");
  await dialog.getByRole("textbox", { name: "Debit", exact: true }).nth(1).fill("200.000");
  await dialog.getByRole("textbox", { name: "Credit", exact: true }).nth(2).fill("300.003");
  const section = dialog.getByRole("region", { name: "Historical allocations" });
  for (const account of controls) {
    const group = section.locator("div.rounded-md.border").filter({ has: page.locator("strong").filter({ hasText: `${account.code}` }) });
    await group.getByRole("button", { name: "Add allocation", exact: true }).click();
  }
  await section.getByLabel("Search customers by name or contact", { exact: true }).fill("Opening UI customer");
  await section.getByLabel("Customer", { exact: true }).selectOption(fixture.customerId);
  await section.getByLabel("Partner", { exact: true }).selectOption(fixture.partnerId);
  const amounts = section.getByRole("textbox", { name: /^Historical amount/ });
  await amounts.nth(0).fill("100.003"); await amounts.nth(1).fill("200.000"); await amounts.nth(2).fill("300.003");
  await section.getByLabel("Receivable title", { exact: true }).fill("Synthetic opening invoice");
  await section.getByLabel("Due date", { exact: true }).fill(`${Number(fixture.date.slice(0, 4)) + 1}-01-31`);
  await section.getByLabel("Unexpired service or benefit", { exact: true }).fill("Synthetic unexpired rent");
  await section.getByLabel("Expense category when recognized", { exact: true }).selectOption("RENT_EXPENSE");
  await section.getByLabel("First recognition month", { exact: true }).fill(fixture.month);
  await section.getByLabel("Months remaining", { exact: true }).fill("3");
  await section.getByRole("checkbox").check();
  return dialog;
}

export function assertOpeningPayload(receipt: Receipt, fixture: Fixture) {
  expect(receipt.args.orgId).toBe(fixture.orgId); expect(receipt.args.expectedCurrency).toBe("JOD");
  expect(receipt.args.memo).toBe(fixture.memo);
  expect(receipt.args.asOfDate).toBe(Date.parse(`${fixture.date}T00:00:00.000Z`));
  expect(receipt.args.lines).toEqual([
    { accountId: fixture.ar._id, debitMinor: MINOR.receivable, creditMinor: 0 },
    { accountId: fixture.prepaid._id, debitMinor: MINOR.prepaid, creditMinor: 0 },
    { accountId: fixture.capital._id, debitMinor: 0, creditMinor: MINOR.capital },
  ]);
  if (!Array.isArray(receipt.args.allocations)) throw new Error("Browser opening allocations unavailable");
  const rows = receipt.args.allocations.map(record);
  expect(rows).toHaveLength(3); expect(new Set(rows.map(row => text(row.rowKey))).size).toBe(3);
  expect(rows.map(({ rowKey: _rowKey, ...row }) => row)).toEqual([
    { kind: "CUSTOMER_RECEIVABLE", accountId: fixture.ar._id, amountMinor: MINOR.receivable, customerId: fixture.customerId,
      title: "Synthetic opening invoice", dueDate: Date.UTC(Number(fixture.date.slice(0, 4)) + 1, 0, 31) },
    { kind: "PREPAID_EXPENSE", accountId: fixture.prepaid._id, amountMinor: MINOR.prepaid, title: "Synthetic unexpired rent",
      startYearMonth: fixture.month, termMonths: 3, expenseSystemKey: "RENT_EXPENSE", attestedUnexpiredBenefit: true },
    { kind: "PARTNER_CAPITAL", accountId: fixture.capital._id, amountMinor: MINOR.capital, partnerId: fixture.partnerId },
  ]);
}

export async function assertNativeOpening(actors: Actors, fixture: Fixture, result: unknown) {
  const posted = record(result), client = actors.ownerClient;
  const readback = await client.query(api.accountingCutover.postedOpeningAllocationReadback, { orgId: fixture.orgId });
  if (!readback) throw new Error("Native posted opening readback unavailable");
  expect(readback.draftId).toBe(text(posted.draftId)); expect(readback.journalEntryId).toBe(text(posted.journalId));
  expect(readback.journalStatus).toBe("POSTED"); expect(readback.currency).toBe("JOD");
  expect(readback.asOfDate).toBe(Date.parse(`${fixture.date}T00:00:00.000Z`));
  expect(readback.rows).toHaveLength(3);
  for (const row of readback.rows) expect("recordAvailable" in row && row.recordAvailable).toBe(true);
  const entries = await client.query(api.accountingLedger.listJournalEntries, { orgId: fixture.orgId, paginationOpts: { cursor: null, numItems: 10 } });
  expect(entries.isDone).toBe(true); expect(entries.page).toHaveLength(1);
  const journal = await client.query(api.accountingLedger.getJournalEntry, { orgId: fixture.orgId, journalEntryId: entries.page[0]._id });
  expect(journal).not.toBeNull(); if (!journal) throw new Error("Native opening journal unavailable");
  expect(journal.entry._id).toBe(posted.journalId); expect(journal.lines).toHaveLength(3);
  expect(journal.lines.map(line => ({ accountId: line.accountId, debitMinor: line.debitMinor, creditMinor: line.creditMinor })))
    .toEqual(expect.arrayContaining([
      { accountId: fixture.ar._id, debitMinor: MINOR.receivable, creditMinor: 0 },
      { accountId: fixture.prepaid._id, debitMinor: MINOR.prepaid, creditMinor: 0 },
      { accountId: fixture.capital._id, debitMinor: 0, creditMinor: MINOR.capital },
    ]));
  const receivables = await client.query(api.subledger.listReceivables, { orgId: fixture.orgId, limit: 10 });
  expect(receivables).toHaveLength(1); expect(receivables[0].customerId).toBe(fixture.customerId);
  const balance = await client.query(api.subledger.getReceivableBalance, { orgId: fixture.orgId, receivableDocumentId: receivables[0]._id });
  if (!balance) throw new Error("Native opening receivable balance unavailable");
  expect(balance.outstandingMinor).toBe(MINOR.receivable);
  const schedules = await client.query(api.prepaidExpenses.listSchedules, { orgId: fixture.orgId });
  expect(schedules).toHaveLength(1); expect(schedules[0].totalMinor).toBe(MINOR.prepaid); expect(schedules[0].recognizedMinor).toBe(0);
  expect(readback.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "CUSTOMER_RECEIVABLE", documentId: receivables[0]._id, amountMinor: MINOR.receivable }),
    expect.objectContaining({ kind: "PREPAID_EXPENSE", documentId: schedules[0]._id, amountMinor: MINOR.prepaid }),
    expect.objectContaining({ kind: "PARTNER_CAPITAL", documentId: fixture.partnerId, amountMinor: MINOR.capital }),
  ]));
  const partners = await client.query(api.partnerEquity.list, { orgId: fixture.orgId, paginationOpts: { cursor: null, numItems: 10 } });
  expect(partners.isDone).toBe(true); expect(partners.page).toHaveLength(1);
  expect(partners.page[0]._id).toBe(fixture.partnerId); expect(partners.page[0].balanceMinor).toBe(MINOR.capital);
  return { draftId: readback.draftId, journalId: readback.journalEntryId, rows: readback.rows, journalLines: journal.lines };
}

export const openingFunctions = { direct: DIRECT, draft: DRAFT, approve: APPROVE };
export const openingResult = record;
