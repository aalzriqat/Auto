/** U-RET public-command callback. Literal JOD oracle: SCRUM-486 / SCRUM-435.
 * This module selects no target and supplies no credentials or database fixtures. */
const key = () => crypto.randomUUID();
const page = { numItems: 100, cursor: null };
const object = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("U-RET public object unavailable");
  return value;
};
const array = value => {
  if (!Array.isArray(value)) throw new Error("U-RET public rows unavailable");
  return value;
};
const equal = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`U-RET assertion: ${label}; expected ${JSON.stringify(expected)}, measured ${JSON.stringify(actual)}`);
};
const sorted = rows => rows.map(row => JSON.stringify(row)).sort();
const J = (code, debit, credit, status = "POSTED") => [code, "JOD", debit, credit, status];
const PURCHASE = [J("1400", 10000000, 0), J("1100", 0, 10000000)];
const DEPOSIT = [J("1100", 200000, 0), J("2100", 0, 200000)];
const FORWARD = [J("2220", 1575000, 0), J("1110", 0, 1575000)];
const SALE = [J("1210", 12500000, 0), J("4100", 0, 12500000), J("5100", 10000000, 0),
  J("1400", 0, 10000000), J("4180", 1375000, 0), J("2220", 0, 1375000),
  J("2100", 200000, 0), J("2220", 0, 200000)];
const RECEIPT = [J("1110", 12500000, 0), J("1210", 0, 12500000)];
const COMMISSION = [J("6100", 250000, 0), J("2300", 0, 250000)];
const reversed = lines => lines.flatMap(([code, currency, debit, credit]) => [
  [code, currency, debit, credit, "REVERSED"], [code, currency, credit, debit, "POSTED"],
]);
const PAID = [...PURCHASE, ...DEPOSIT, ...FORWARD, ...SALE, ...RECEIPT, ...COMMISSION];
const RETURNED = [...PURCHASE, ...DEPOSIT, ...reversed(FORWARD), ...SALE, ...RECEIPT, ...COMMISSION];
const UNWOUND = [...PURCHASE, ...DEPOSIT, ...reversed(FORWARD), ...reversed(SALE), ...reversed(RECEIPT), ...reversed(COMMISSION)];
const PAID_TRIAL = { "1100": -9800000, "1110": 10925000, "2300": 250000, "4100": 12500000,
  "4180": -1375000, "5100": 10000000, "6100": 250000 };
const RETURNED_TRIAL = { ...PAID_TRIAL, "1110": 12500000, "2220": 1575000 };
const UNWOUND_TRIAL = { "1100": -9800000, "1400": 10000000, "2100": 200000 };
const REFUNDED_TRIAL = { "1100": -10000000, "1400": 10000000 };

/**
 * `bankAccounts:getBookBalance` is called without `asOf`, so the backend answers at its own `Date.now()` and echoes that
 * instant back as `asOf` (convex/bankAccounts.ts: `args.asOf ?? Date.now()`, then `base = { ..., asOf }`). On a live
 * deployment two reads are evaluated at two different instants, so the echo differs between a before and an after read
 * with no change to any book. It is the read clock, not a financial or operational witness: the balance, status, currency,
 * bank identity, `unmatchedMinor` and `unattributedLineCount` beside it stay in the witness and are compared exactly.
 * The clock is still required to be a valid instant, so a malformed answer is not silently dropped.
 */
async function bankWitness(must, args) {
  const { asOf, ...witness } = object(await must("query", "bankAccounts:getBookBalance", args));
  equal(Number.isSafeInteger(asOf), true, "native bank balance read clock is a valid instant");
  return witness;
}

async function books(must, f) {
  const list = object(await must("query", "accountingLedger:listJournalEntries", { orgId: f.orgId, paginationOpts: page }));
  equal(list.isDone, true, "bounded complete journal inventory");
  const details = [];
  for (const entry of array(list.page)) details.push(object(await must("query", "accountingLedger:getJournalEntry", {
    orgId: f.orgId, journalEntryId: entry._id,
  })));
  const args = { orgId: f.orgId };
  return { details, trial: await must("query", "accountingReports:trialBalance", args),
    income: await must("query", "accountingReports:incomeStatement", { ...args, fromDate: f.periodStart, toDate: f.periodEnd }),
    bank: await bankWitness(must, args),
    application: await must("query", "applications:get", { ...args, applicationId: f.applicationId }),
    sale: await must("query", "sales:get", { ...args, saleId: f.saleId }),
    vehicle: await must("query", "vehicles:get", { ...args, vehicleId: f.vehicleId }),
    applicationList: await must("query", "applications:list", { ...args, paginationOpts: page }),
    deposits: await must("query", "deposits:listByVehicle", { ...args, vehicleId: f.vehicleId }),
    invoice: await must("query", "subledger:getReceivableBalance", { ...args, receivableDocumentId: f.invoiceId }),
    allocations: await must("query", "subledger:listAllocations", { ...args, receivableDocumentId: f.invoiceId }),
    unwind: await must("query", "dealUnwind:unwindStatus", { ...args, applicationId: f.applicationId }),
    period: await must("query", "accountingPeriods:get", { ...args, periodId: f.periodId }) };
}

function journalRows(witness, f) {
  return witness.details.flatMap(detail => {
    const entry = object(detail.entry);
    equal(entry.periodId, f.periodId, "journal belongs to actual open period");
    return array(detail.lines).map(line => {
      if (!f.codes.has(String(line.accountId))) throw new Error("U-RET unknown journal account");
      if (f.codes.get(String(line.accountId)) === "1110") equal(line.bankAccountId, f.bankId, "literal bank-line attribution");
      if (f.codes.get(String(line.accountId)) === "1210") {
        equal(line.customerId, f.customerId, "receivable journal customer attribution");
        equal(line.financeCompanyId, f.companyId, "receivable journal financier attribution");
      }
      if (f.codes.get(String(line.accountId)) === "1400") equal(line.vehicleId, f.vehicleId, "inventory vehicle attribution");
      return [f.codes.get(String(line.accountId)), line.currency, line.debitMinor, line.creditMinor, entry.status];
    });
  });
}
function assertBooks(witness, f, expected, bank, income, trial = UNWOUND_TRIAL) {
  equal(sorted(journalRows(witness, f)), sorted(expected), "literal journal multiset");
  equal(object(witness.trial).isBalanced, true, "trial balance balanced");
  equal(sorted(array(witness.trial.rows).filter(row => row.netMinor !== 0).map(row => [row.code, row.currency, row.netMinor])),
    sorted(Object.entries(trial).map(([code, net]) => [code, "JOD", net])), "literal public trial balance");
  const invoice = object(object(witness.invoice).doc);
  equal(invoice.customerId, f.customerId, "invoice customer attribution");
  equal(invoice.financeCompanyId, f.companyId, "invoice financier attribution");
  equal(invoice.sourceType, "finance_application", "invoice source family");
  equal(invoice.sourceId, f.applicationId, "invoice source identity");
  equal(invoice.payerType, "FINANCE_COMPANY", "invoice payer classification");
  equal(invoice.documentType, "INVOICE", "invoice document classification");
  equal(invoice.currency, "JOD", "invoice currency");
  equal(invoice.scale, 3, "invoice scale");
  equal(invoice.originalAmountMinor, 12500000, "literal original financier receivable");
  equal(witness.invoice.outstandingMinor, 0, "financier receivable not collectible after payment or cancellation");
  equal(object(witness.bank).status, "OK", "native bank reader available");
  equal(object(witness.bank).balanceMinor, bank, "native bank balance");
  equal(object(witness.income).netIncome, income, "native income statement");
}
/**
 * `operation` must return the NON-THROWING result of `ctx.asSales` / `ctx.asApprover`
 * (`{ ok, error, errorCode }`). The throwing `*Must` wrappers keep only the refusal's message text
 * (`<path> failed: <message>`), never its machine code, so a code such as DEAL_UNWIND_NOT_FOUND could
 * not be recognised on a live deployment. `expected` is the coded refusal, or a fragment of a plain-text
 * refusal that has no code. A refusal that carries a machine code must carry exactly `expected`: the message-text
 * fallback applies ONLY when the refusal has no code, so a different code whose message merely mentions
 * `expected` (for example FORBIDDEN naming CUSTOMER_CREDIT_PAYOUT_DISABLED) cannot pass.
 */
async function refused(must, f, operation, expected) {
  const before = await books(must, f);
  const result = await operation();
  const hasCode = typeof result?.errorCode === "string" && result.errorCode !== "";
  const matched = result?.ok === false &&
    (hasCode ? result.errorCode === expected : String(result.error).toLowerCase().includes(expected.toLowerCase()));
  if (!matched) throw new Error(`U-RET missing or wrong refusal: ${expected}; observed ${JSON.stringify(result)}`);
  equal(await books(must, f), before, "refusal preserves complete public financial/operational witnesses");
}
async function retry(must, f, operation) {
  const first = await operation(), before = await books(must, f);
  equal(await operation(), first, "same-key result");
  equal(await books(must, f), before, "same-key retry preserves all witnesses");
  return first;
}

async function prepare(ctx) {
  const must = ctx.salesMust, approver = object(await ctx.approverMust("query", "users:getMe", {}));
  const primary = object(await must("query", "users:getMe", {}));
  equal(String(primary.email).toLowerCase(), ctx.config.salesEmail.toLowerCase(), "actual primary identity");
  equal(String(approver.email).toLowerCase(), ctx.config.approverEmail.toLowerCase(), "actual approver identity");
  if (primary._id === approver._id) throw new Error("U-RET requires distinct actual QA identities");
  const orgId = await must("mutation", "organizations:create", { name: `QA TEST U-RET ${key()}` });
  const roles = array(await must("query", "roles:list", { orgId }));
  const manager = roles.find(role => role.name === "MANAGER");
  if (!manager) return ctx.unproven("U-RET native MANAGER role unavailable");
  const membership = object(await must("mutation", "memberships:add", { orgId, userEmail: approver.email, roleId: manager._id }));
  equal(membership.status, "added", "existing-user native membership");
  const seated = object(await ctx.approverMust("query", "memberships:getMyMembership", { orgId }));
  equal(seated.userId, approver._id, "actual second QA actor seated");
  equal(seated.roleId, manager._id, "actual positive approval role seated");
  await must("mutation", "orgSettings:upsert", { orgId, currency: "JOD", currencySymbol: "JD" });
  await must("mutation", "orgSettings:setCommissionMode", { orgId, commissionMode: "MANUAL" });
  await must("mutation", "chartOfAccounts:initialize", { orgId });
  const now = new Date(), year = now.getUTCFullYear(), month = now.getUTCMonth();
  const periodId = await must("mutation", "accountingPeriods:create", { orgId, fiscalYear: year, periodNumber: month + 1,
    startDate: Date.UTC(year, month, 1), endDate: Date.UTC(year, month + 1, 1) - 1, openImmediately: true });
  const codes = new Map(array(await must("query", "chartOfAccounts:list", { orgId })).map(account => [String(account._id), account.code]));
  const bankId = await must("mutation", "bankAccounts:create", { orgId, name: `QA TEST U-RET bank ${key()}`,
    currency: "JOD", openingBalanceMinor: 0, openingBalanceDate: Date.now() });
  await must("mutation", "orgCustomerStatuses:seed", { orgId });
  const eligibility = array(await must("query", "orgCustomerStatuses:list", { orgId }))[0]?._id;
  if (!eligibility) return ctx.unproven("U-RET native customer eligibility unavailable");
  const customerId = await must("mutation", "customers:create", { orgId, firstName: "QA TEST", lastName: "Unwind" });
  const companyId = await must("mutation", "finance:createCompany", { orgId, name: `QA TEST U-RET financier ${key()}`,
    profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, defaultLtvPercent: 87.4, adminFees: 0,
    acceptedStatuses: [eligibility], isActive: true });
  const vehicleId = await must("mutation", "vehicles:create", { orgId, vin: `1HGCM82633A${key().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    make: "Kia", model: "Sportage", year: 2024, mileage: 10, color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
    sellingPrice: 12500, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 10000, purchasePaymentMethod: "CASH", idempotencyKey: key() });
  const quoteId = await must("mutation", "quotes:saveQuote", { orgId, customerId, vehicleId, mode: "CONFIGURED_FINANCE_COMPANY",
    companyId, customerEligibilityStatusIds: [eligibility], vehiclePrice: 12500, downPayment: 200, totalFinancedAmount: 12300, termMonths: 48 });
  const depositId = await must("mutation", "deposits:create", { orgId, quoteId, amount: 200, method: "CASH", idempotencyKey: key() });
  const applicationId = await must("mutation", "applications:createFromQuote", { orgId, quoteId });
  await must("mutation", "financingEconomics:recordSubmittedQuotation", { orgId, applicationId, submittedQuotationMinor: 12500000, source: "MANUAL_ENTRY" });
  await ctx.approverMust("mutation", "financingEconomics:approveDealerPurchaseAmount", { orgId, applicationId,
    approvedAmountMinor: 12500000, basis: "MANUAL", notes: "QA TEST independent U-RET literal" });
  await must("mutation", "applications:updateStatus", { orgId, applicationId, status: "UNDER_REVIEW" });
  await ctx.approverMust("mutation", "applications:updateStatus", { orgId, applicationId, status: "APPROVED" });
  const economicsStamp = await must("query", "applications:handoverStamp", { orgId, applicationId });
  await must("mutation", "applications:registerVehicleHandover", { orgId, applicationId, economicsStamp });
  await must("mutation", "applications:registerExpectedPayment", { orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now() });
  await must("mutation", "financeDealCosts:recordLegalInvoice", { orgId, applicationId, legalInvoiceAmountMinor: 12500000,
    legalInvoiceNumber: `QA-${key()}`, legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY" });
  const feeId = await must("mutation", "financeDealCosts:recordDealFee", { orgId, applicationId, expectedCurrency: "JOD", idempotencyKey: key(),
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "QA TEST no closing cost" });
  await must("mutation", "financeDealCosts:reconcileDealFee", { orgId, feeId, notes: "QA TEST zero cost", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0 });
  await must("mutation", "financeCompanyForward:recordFinanceCompanyForward", { orgId, applicationId, method: "BANK_TRANSFER", bankAccountId: bankId,
    paidAt: Date.now(), expectedAmountMinor: 1575000, reference: "QA-URET-FORWARD", idempotencyKey: key() });
  const saleId = await must("mutation", "applications:finalizeDeal", { orgId, applicationId, idempotencyKey: key() });
  const invoices = array(await must("query", "subledger:listReceivables", { orgId, limit: 200 }))
    .filter(row => row.sourceType === "finance_application" && row.sourceId === applicationId && row.payerType === "FINANCE_COMPANY");
  equal(invoices.length, 1, "one exact financier invoice");
  const invoiceId = invoices[0]._id;
  await must("mutation", "bankAccounts:setReconciliationTarget", { orgId, bankAccountId: bankId });
  await ctx.approverMust("mutation", "applications:confirmDisbursement", { orgId, applicationId, disbursedAmountMinor: 12500000,
    bankAccountId: bankId, idempotencyKey: key() });
  await must("mutation", "sales:setCommissionAmount", { orgId, saleId, commissionAmount: 250 });
  return { orgId, periodId, periodStart: Date.UTC(year, month, 1), periodEnd: Date.UTC(year, month + 1, 1) - 1,
    codes, bankId, customerId, companyId, vehicleId, quoteId, depositId, applicationId, saleId, invoiceId };
}

const startArgs = f => ({ orgId: f.orgId, applicationId: f.applicationId, reason: "QA TEST customer returned vehicle", idempotencyKey: key() });
const forwardArgs = f => ({ orgId: f.orgId, unwindId: f.unwindId, returnedAt: Date.now(), reference: "QA-URET-RETURN", idempotencyKey: key() });
const finishArgs = f => ({ orgId: f.orgId, unwindId: f.unwindId, method: "BANK_TRANSFER", refundedAt: Date.now(), bankReference: "QA-URET-REFUND",
  creditNoteReference: "QA-URET-CREDIT", vehicleReturnedAt: Date.now(), vehicleReturnNote: "QA TEST returned for inspection",
  customerPaymentDisposition: "RETAIN_CREDIT", idempotencyKey: key() });

async function deniedAuthority(ctx, f, granted, missing, operation) {
  const must = ctx.salesMust, original = object(await ctx.approverMust("query", "memberships:getMyMembership", { orgId: f.orgId }));
  const roleId = await must("mutation", "roles:create", { orgId: f.orgId, name: `QA TEST U-RET ${key()}`, permissions: granted });
  let failure, attestation;
  try {
    await must("mutation", "memberships:updateRole", { orgId: f.orgId, membershipId: original._id, newRoleId: roleId });
    attestation = object(await ctx.approverMust("query", "memberships:getMyMembership", { orgId: f.orgId }));
    equal(attestation.userId, original.userId, "denied actual same actor");
    equal(attestation.roleId, roleId, "actual assigned role");
    equal(array(attestation.permissions).includes(missing), false, "denied capability absent");
    for (const permission of granted) equal(attestation.permissions.includes(permission), true, "required control authority actually granted");
    await refused(must, f, operation, "FORBIDDEN");
  } catch (error) { failure = error; }
  try {
    await must("mutation", "memberships:updateRole", { orgId: f.orgId, membershipId: original._id, newRoleId: original.roleId });
    equal(await ctx.approverMust("query", "memberships:getMyMembership", { orgId: f.orgId }), original, "original membership restored");
  } catch (restoreError) {
    if (failure) throw new AggregateError([failure, restoreError], "U-RET refusal and role restoration failed");
    throw restoreError;
  }
  if (failure) throw failure;
  return attestation;
}

async function closedControl(ctx, stage) {
  const must = ctx.salesMust, f = await prepare(ctx), args = startArgs(f);
  f.unwindId = await must("mutation", "dealUnwind:startDealUnwind", args);
  if (stage === "finish") await must("mutation", "dealUnwind:recordDealUnwindForwardReturn", forwardArgs(f));
  await must("mutation", "bankAccounts:setReconciliationTarget", { orgId: f.orgId, bankAccountId: f.bankId });
  const checklist = object(await must("query", "accountingPeriods:closeChecklist", { orgId: f.orgId, periodId: f.periodId }));
  if (checklist.canClose !== true) return ctx.unproven("U-RET clean native period close unavailable; no override used");
  await must("mutation", "accountingPeriods:close", { orgId: f.orgId, periodId: f.periodId, acknowledgedWarnings: array(checklist.warnings) });
  const before = await books(must, f);
  equal(object(before.period).status, "CLOSED", "actual closed period");
  assertBooks(before, f, stage === "finish" ? RETURNED : PAID, stage === "finish" ? 12500000 : 10925000, 875000,
    stage === "finish" ? RETURNED_TRIAL : PAID_TRIAL);
  await refused(must, f, () => ctx.asSales("mutation", stage === "finish" ? "dealUnwind:finishDealUnwind" : "dealUnwind:recordDealUnwindForwardReturn",
    stage === "finish" ? finishArgs(f) : forwardArgs(f)), "DEAL_UNWIND_PERIOD_NOT_OPEN");
  equal(await books(must, f), before, "closed consumers unchanged");
  return { phase: stage, periodStatus: "CLOSED", bankMinor: object(before.bank).balanceMinor };
}

export async function runUnwindRehearsalCases(ctx) {
  await ctx.recordCase(ctx.results, "U-RET", "Configured-financier unwind: literal reversals, held deposit, authorities, retries and closed consumers", async () => {
    if (!ctx.config?.salesEmail || !ctx.config?.approverEmail) return ctx.unproven("U-RET actual two-identity native context unavailable");
    const must = ctx.salesMust, f = await prepare(ctx), roles = [];
    assertBooks(await books(must, f), f, PAID, 10925000, 875000, PAID_TRIAL);
    const args = startArgs(f), basePermissions = ["view:sales", "view:finance_applications"];
    for (const [granted, missing] of [["cancel:closed_deal", "confirm:finance_disbursement"], ["confirm:finance_disbursement", "cancel:closed_deal"]])
      roles.push(await deniedAuthority(ctx, f, [...basePermissions, granted], missing,
        () => ctx.asApprover("mutation", "dealUnwind:startDealUnwind", { ...args, idempotencyKey: key() })));
    const foreignOrg = await ctx.approverMust("mutation", "organizations:create", { name: `QA TEST U-RET foreign ${key()}` });
    const foreignBefore = await ctx.approverMust("query", "accountingLedger:listJournalEntries", { orgId: foreignOrg, paginationOpts: page });
    await refused(must, f, () => ctx.asApprover("mutation", "dealUnwind:startDealUnwind", { ...args, orgId: foreignOrg, idempotencyKey: key() }), "DEAL_UNWIND_NOT_FOUND");
    equal(await ctx.approverMust("query", "accountingLedger:listJournalEntries", { orgId: foreignOrg, paginationOpts: page }), foreignBefore, "foreign tenant ledger unchanged");
    f.unwindId = await retry(must, f, () => must("mutation", "dealUnwind:startDealUnwind", args));
    const started = await books(must, f);
    assertBooks(started, f, PAID, 10925000, 875000, PAID_TRIAL);
    equal(object(started.unwind).unwindId, f.unwindId, "actual unwind identity");
    equal(object(started.unwind).status, "ACTIVE", "start active without posting");
    await refused(must, f, () => ctx.asSales("mutation", "applications:cancelApplication", { orgId: f.orgId,
      applicationId: f.applicationId, reason: "QA TEST active-unwind bypass", idempotencyKey: key() }), "DEAL_UNWIND_ACTIVE");
    await refused(must, f, () => ctx.asSales("mutation", "dealUnwind:finishDealUnwind", finishArgs(f)), "DEAL_UNWIND_FORWARD_FIRST");
    const returned = forwardArgs(f);
    await refused(must, f, () => ctx.asApprover("mutation", "dealUnwind:recordDealUnwindForwardReturn", {
      ...returned, orgId: foreignOrg, idempotencyKey: key() }), "DEAL_UNWIND_NOT_FOUND");
    for (const [granted, missing] of [["cancel:closed_deal", "confirm:finance_disbursement"], ["confirm:finance_disbursement", "cancel:closed_deal"]])
      roles.push(await deniedAuthority(ctx, f, [...basePermissions, granted], missing,
        () => ctx.asApprover("mutation", "dealUnwind:recordDealUnwindForwardReturn", { ...returned, idempotencyKey: key() })));
    await retry(must, f, () => must("mutation", "dealUnwind:recordDealUnwindForwardReturn", returned));
    assertBooks(await books(must, f), f, RETURNED, 12500000, 875000, RETURNED_TRIAL);
    const finish = finishArgs(f);
    await refused(must, f, () => ctx.asApprover("mutation", "dealUnwind:finishDealUnwind", {
      ...finish, orgId: foreignOrg, idempotencyKey: key() }), "DEAL_UNWIND_NOT_FOUND");
    for (const [granted, missing] of [["cancel:closed_deal", "confirm:finance_disbursement"], ["confirm:finance_disbursement", "cancel:closed_deal"]])
      roles.push(await deniedAuthority(ctx, f, [...basePermissions, granted], missing,
        () => ctx.asApprover("mutation", "dealUnwind:finishDealUnwind", { ...finish, idempotencyKey: key() })));
    await refused(must, f, () => ctx.asSales("mutation", "dealUnwind:finishDealUnwind", { ...finish, method: "CASH", bankReference: undefined,
      voucherNumber: "QA-WRONG-RAIL", recipientAcknowledged: true, idempotencyKey: key() }), "DEAL_UNWIND_REFUND_METHOD_MISMATCH");
    // Owner ruling 2026-10-19: no customer-credit payout during the pilot (CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED stays on).
    // A request carrying ANY payout field is refused with the pilot code by the otherwise fully authorized owner, with the
    // forward-returned state, bank, income and deposit unchanged. Mirrors the harness cell U-REFUND rf-2, rf-3 and rf-4.
    // The harness cell's rf-1 (REFUND disposition with POSITIVE active customer credit and no payout field) needs that
    // credit to exist, and the only door that creates it is dark in the pilot, so it cannot be reached here and is not claimed.
    const payout = { customerRefundAmountMinor: 3000, customerRefundBankAccountId: f.bankId,
      customerRefundReference: "QA-URET-PAYOUT", customerRefundedAt: Date.now() };
    for (const over of [
      { customerPaymentDisposition: "REFUND", customerRefundMethod: "BANK_TRANSFER", ...payout },
      { customerPaymentDisposition: "REFUND", customerRefundMethod: "CASH", ...payout, customerRefundBankAccountId: undefined },
      { customerPaymentDisposition: "RETAIN_CREDIT", customerRefundMethod: "BANK_TRANSFER", ...payout },
    ]) await refused(must, f, () => ctx.asSales("mutation", "dealUnwind:finishDealUnwind", { ...finish, ...over, idempotencyKey: key() }),
      "CUSTOMER_CREDIT_PAYOUT_DISABLED");
    await retry(must, f, () => must("mutation", "dealUnwind:finishDealUnwind", finish));
    const after = await books(must, f);
    assertBooks(after, f, UNWOUND, 0, 0);
    equal(object(after.unwind).status, "COMPLETED", "public unwind completed");
    equal(object(after.application).status, "CANCELLED", "application cancelled");
    equal(object(after.sale).status, "CANCELLED", "sale cancelled");
    equal(object(after.invoice.doc).status, "CANCELLED", "financier invoice cancelled");
    equal(array(after.allocations).filter(row => row.status === "ACTIVE").length, 0, "no surviving remittance allocation");
    equal(object(after.vehicle).status, "IN_INSPECTION", "returned vehicle inspection");
    equal(object(after.vehicle).purchasePrice, 10000, "original acquisition cost retained");
    equal(array(after.deposits).find(row => row._id === f.depositId)?.status, "HELD", "customer deposit held");
    equal(array(after.deposits).find(row => row._id === f.depositId)?.amount, 200, "literal held deposit amount");
    equal(array(object(after.applicationList).page).find(row => row._id === f.applicationId)?.hasPendingDepositResolution, true,
      "actual application-list pending-deposit consumer");
    await refused(must, f, () => ctx.asSales("mutation", "vehicles:update", { orgId: f.orgId, vehicleId: f.vehicleId, status: "AVAILABLE" }), "still needs a refund or forfeiture decision");
    await refused(must, f, () => ctx.asSales("mutation", "dealUnwind:startDealUnwind", startArgs(f)), "DEAL_UNWIND_NOT_ELIGIBLE");
    const release = { orgId: f.orgId, depositId: f.depositId, resolution: "REFUNDED", refundMethod: "CASH",
      idempotencyKey: `release-deposit:${f.depositId}:REFUNDED:CASH:gen0` };
    await refused(must, f, () => ctx.asSales("mutation", "deposits:release", release), "Deposit creator cannot resolve their own deposit");
    await retry(must, f, () => ctx.approverMust("mutation", "deposits:release", release));
    assertBooks(await books(must, f), f, [...UNWOUND, J("2100", 200000, 0), J("1100", 0, 200000)], 0, 0, REFUNDED_TRIAL);
    await must("mutation", "vehicles:update", { orgId: f.orgId, vehicleId: f.vehicleId, status: "AVAILABLE" });
    equal(object((await books(must, f)).vehicle).status, "AVAILABLE", "held disposition releases vehicle");
    equal(array(object((await books(must, f)).applicationList).page).find(row => row._id === f.applicationId)?.hasPendingDepositResolution,
      false, "actual pending-deposit consumer cleared");
    const closed = [await closedControl(ctx, "forward"), await closedControl(ctx, "finish")];
    equal(await ctx.approverMust("query", "accountingLedger:listJournalEntries", { orgId: foreignOrg, paginationOpts: page }), foreignBefore, "all foreign-tenant refusals leave foreign ledger unchanged");
    return { fixture: "SYNTHETIC_PUBLIC_COMMANDS", assertedLiterals: { forwardReturnedMinor: 1575000, refundedRemittanceMinor: 12500000,
      heldDepositMinor: 200000 }, measured: { finalBankMinor: object(after.bank).balanceMinor, finalIncomeMinor: object(after.income).netIncome },
      deniedAuthorities: roles.map(role => ({ roleId: role.roleId, permissions: role.permissions })), closed,
      boundary: "Actual run determines evidence scope; local convex-test is harness only, no platform/OCC/UI or complete U-RET family claim" };
  });
}
