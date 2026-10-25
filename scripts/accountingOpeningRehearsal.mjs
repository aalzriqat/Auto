/** Native public-API opening rehearsal. All amounts are independent synthetic JOD minor units.
 * No database seeding, target selection, deployment or provider credential handling lives here. */
/** @typedef {Record<string, unknown>} Row */
/** @typedef {(kind: "query"|"mutation", name:string, args:Row)=>Promise<unknown>} Must */
/** @typedef {{results:unknown[],orgId:string,config:{salesEmail:string,approverEmail:string},salesMust:Must,approverMust:Must,recordCase:(results:unknown[],id:string,title:string,body:()=>Promise<unknown>)=>Promise<unknown>,unproven:(reason:string)=>void}} Context */
/** @param {unknown} value @returns {Row} */
function row(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Opening public readback unavailable");
  return /** @type {Row} */ (value);
}
/** @param {unknown} value @returns {Row[]} */
function rows(value) {
  if (!Array.isArray(value))
    throw new Error("Opening public row set unavailable");
  return value.map(row);
}
/** @param {unknown} value @returns {string} */
function id(value) {
  if (typeof value !== "string" || !value)
    throw new Error("Opening public identity unavailable");
  return value;
}
/** @param {unknown} actual @param {unknown} expected @param {string} label */
function equal(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Opening assertion refused: ${label}`);
}
/** @param {()=>Promise<unknown>} operation @param {string} expectedMessage */
async function refuses(operation, expectedMessage) {
  let refused = false;
  try {
    await operation();
  } catch (error) {
    if (
      !String(error instanceof Error ? error.message : error).includes(
        expectedMessage,
      )
    )
      throw new Error("Opening containment returned an unexpected refusal");
    refused = true;
  }
  if (!refused) throw new Error("Opening containment did not refuse");
}
const key = () => globalThis.crypto.randomUUID();
const paginationOpts = { numItems: 100, cursor: null };
/** @param {Must} must @param {string} orgId */
async function journals(must, orgId) {
  const response = row(
    await must("query", "accountingLedger:listJournalEntries", {
      orgId,
      paginationOpts,
    }),
  );
  equal(response.isDone, true, "bounded journal inventory complete");
  return rows(response.page);
}
/** @param {Must} must @param {string} orgId */
async function balances(must, orgId) {
  return row(await must("query", "accountingReports:trialBalance", { orgId }));
}
/** @param {Must} must @param {string} orgId @param {string} name @param {string} type @param {string} code */
async function custom(must, orgId, name, type, code) {
  return id(
    await must("mutation", "chartOfAccounts:create", {
      orgId,
      name: `QA TEST ${name}`,
      code,
      type,
      normalBalance: type === "ASSET" ? "DEBIT" : "CREDIT",
      isControlAccount: true,
      allowManualPosting: false,
      currencyRestriction: "JOD",
    }),
  );
}
/** @param {Context} ctx */
async function prepareOpening(ctx) {
  const must = ctx.salesMust;
  const primary = row(await must("query", "users:getMe", {}));
  const approver = row(await ctx.approverMust("query", "users:getMe", {}));
  const normalize = /** @param {unknown} email */ (email) =>
    id(email).trim().toLowerCase();
  equal(
    normalize(primary.email),
    normalize(ctx.config.salesEmail),
    "existing primary identity",
  );
  equal(
    normalize(approver.email),
    normalize(ctx.config.approverEmail),
    "existing approver identity",
  );
  if (id(primary._id) === id(approver._id))
    throw new Error("Opening requires two actual distinct QA users");
  const orgId = id(
    await must("mutation", "organizations:create", {
      name: `QA TEST opening rehearsal ${key()}`,
    }),
  );
  const roles = rows(await must("query", "roles:list", { orgId }));
  const finance = roles.find((value) => value.name === "SENIOR_ACCOUNTANT");
  if (
    !finance ||
    !Array.isArray(finance.permissions) ||
    !finance.permissions.includes("manage:finance")
  )
    throw new Error("Native finance approval authority unavailable");
  const membership = row(
    await must("mutation", "memberships:add", {
      orgId,
      userEmail: id(approver.email),
      roleId: id(finance._id),
    }),
  );
  equal(
    membership.status,
    "added",
    "existing-user membership, never invitation",
  );
  const seated = row(
    await ctx.approverMust("query", "memberships:getMyMembership", { orgId }),
  );
  equal(seated.userId, approver._id, "actual approver membership");
  equal(seated.roleId, finance._id, "native approval seat");
  await must("mutation", "orgSettings:upsert", {
    orgId,
    currency: "JOD",
    currencySymbol: "JD",
    enabledPaymentTypes: ["CASH"],
  });
  await must("mutation", "chartOfAccounts:initialize", { orgId });
  const now = new Date();
  const year = now.getUTCFullYear(),
    month = now.getUTCMonth();
  const periodStart = Date.UTC(year, month - 1, 1),
    periodEnd = Date.UTC(year, month, 1) - 1,
    nextMonth = Date.UTC(year, month + 1, 1);
  // Future periods are required by the native immutable seven-installment approval.
  for (let offset = -1; offset <= 7; offset += 1) {
    const start = new Date(Date.UTC(year, month + offset, 1));
    await must("mutation", "accountingPeriods:create", {
      orgId,
      fiscalYear: start.getUTCFullYear(),
      periodNumber: start.getUTCMonth() + 1,
      startDate: start.getTime(),
      endDate: Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1,
      openImmediately: offset <= 0,
    });
  }
  const accounts = rows(
    await must("query", "chartOfAccounts:list", { orgId, activeOnly: true }),
  );
  /** @param {string} systemKey */
  const account = (systemKey) => {
    const found = accounts.find((value) => value.systemKey === systemKey);
    if (!found) throw new Error(`Opening account unavailable: ${systemKey}`);
    return id(found._id);
  };
  const claim = await custom(must, orgId, "claim control", "ASSET", "1891");
  const deposit = await custom(must, orgId, "deposit control", "ASSET", "1892");
  const other = await custom(
    must,
    orgId,
    "other payable control",
    "LIABILITY",
    "2391",
  );
  const commission = await custom(
    must,
    orgId,
    "commission control",
    "LIABILITY",
    "2392",
  );
  const unknown = await custom(
    must,
    orgId,
    "unidentified pool",
    "LIABILITY",
    "2393",
  );
  await custom(must, orgId, "unused decoy", "ASSET", "1893");
  const bankAccountId = id(
    await must("mutation", "bankAccounts:create", {
      orgId,
      name: "QA TEST physical JOD bank",
      currency: "JOD",
      openingBalanceMinor: 0,
      openingBalanceDate: periodStart,
    }),
  );
  const customerId = id(
    await must("mutation", "customers:create", {
      orgId,
      firstName: "QA TEST",
      lastName: "Opening customer",
    }),
  );
  const partnerId = id(
    await must("mutation", "partnerEquity:add", {
      orgId,
      partnerName: "QA TEST opening partner",
      idempotencyKey: key(),
    }),
  );
  const vin = `QA${key().replaceAll("-", "").slice(0, 15).toUpperCase()}`;
  await must("mutation", "vehicles:importBulk", {
    orgId,
    acquisitionPosting: "OPENING_STOCK",
    importId: key(),
    vehicles: [
      {
        rowId: 1,
        vin,
        make: "QA TEST",
        model: "Opening stock",
        year: year - 1,
        color: "White",
        fuelType: "PETROL",
        transmission: "AUTOMATIC",
        sellingPrice: 300,
        purchasePrice: 200.007,
        sourceType: "STOCK",
      },
    ],
  });
  const vehicles = row(
    await must("query", "vehicles:list", { orgId, paginationOpts }),
  );
  const vehicle = rows(vehicles.page).find((value) => value.vin === vin);
  if (!vehicle) throw new Error("Native imported opening stock unavailable");
  equal(
    (await journals(must, orgId)).length,
    0,
    "no fake acquisition or capital posting",
  );
  /** @type {Row[]} */
  const allocations = [
    {
      kind: "CUSTOMER_RECEIVABLE",
      rowKey: "ar",
      accountId: account("ACCOUNTS_RECEIVABLE_CUSTOMERS"),
      customerId,
      amountMinor: 100003,
      title: "QA TEST AR",
      dueDate: Date.now(),
    },
    {
      kind: "VEHICLE_INVENTORY",
      rowKey: "stock",
      accountId: account("VEHICLE_INVENTORY"),
      vehicleId: id(vehicle._id),
      amountMinor: 200007,
    },
    {
      kind: "EMPLOYEE_ADVANCE",
      rowKey: "advance",
      accountId: account("EMPLOYEE_ADVANCES"),
      userId: id(approver._id),
      amountMinor: 30001,
    },
    {
      kind: "PARTNER_CAPITAL",
      rowKey: "capital",
      accountId: account("PARTNER_CAPITAL"),
      partnerId,
      amountMinor: 1000000,
    },
    {
      kind: "PREPAID_EXPENSE",
      rowKey: "prepaid",
      accountId: account("PREPAID_EXPENSES"),
      amountMinor: 70003,
      title: "QA TEST future benefit",
      expenseSystemKey: "GENERAL_EXPENSE",
      startYearMonth: new Date(nextMonth).toISOString().slice(0, 7),
      termMonths: 3,
      attestedUnexpiredBenefit: true,
    },
    {
      kind: "SUPPLIER_RECOVERABLE",
      rowKey: "claim",
      accountId: claim,
      amountMinor: 11001,
      counterpartyName: "QA TEST supplier",
      title: "QA TEST claim",
      purpose: "CLAIM",
    },
    {
      kind: "SUPPLIER_RECOVERABLE",
      rowKey: "deposit",
      accountId: deposit,
      amountMinor: 13001,
      counterpartyName: "QA TEST supplier",
      title: "QA TEST refundable deposit",
      purpose: "REFUNDABLE_DEPOSIT",
    },
    {
      kind: "SUPPLIER_PAYABLE",
      rowKey: "supplier",
      accountId: account("ACCOUNTS_PAYABLE_SUPPLIERS"),
      amountMinor: 100001,
      counterpartyName: "QA TEST supplier",
      title: "QA TEST supplier obligation",
    },
    {
      kind: "OTHER_PAYABLE",
      rowKey: "other",
      accountId: other,
      amountMinor: 90001,
      counterpartyName: "QA TEST creditor",
      title: "QA TEST other obligation",
    },
    {
      kind: "EMPLOYEE_COMMISSION",
      rowKey: "commission",
      accountId: commission,
      amountMinor: 50003,
      userId: id(approver._id),
    },
    {
      kind: "UNALLOCATED_LIABILITY",
      rowKey: "unknown-deposit",
      accountId: account("CUSTOMER_DEPOSITS_LIABILITY"),
      amountMinor: 20001,
      purpose: "CUSTOMER_DEPOSIT",
      title: "QA TEST unknown deposit",
    },
    {
      kind: "UNALLOCATED_LIABILITY",
      rowKey: "unknown-receipt",
      accountId: unknown,
      amountMinor: 23001,
      purpose: "UNIDENTIFIED_RECEIPT",
      title: "QA TEST unidentified receipt",
    },
  ];
  const credits = new Set([
    "PARTNER_CAPITAL",
    "SUPPLIER_PAYABLE",
    "OTHER_PAYABLE",
    "EMPLOYEE_COMMISSION",
    "UNALLOCATED_LIABILITY",
  ]);
  /** @type {Row[]} */
  const lines = allocations.map((value) => ({
    accountId: value.accountId,
    debitMinor: credits.has(id(value.kind)) ? 0 : value.amountMinor,
    creditMinor: credits.has(id(value.kind)) ? value.amountMinor : 0,
  }));
  lines.push(
    { accountId: account("CASH_ON_HAND"), debitMinor: 1000000, creditMinor: 0 },
    {
      accountId: account("BANK_ACCOUNT"),
      debitMinor: 500000,
      creditMinor: 0,
      bankAccountId,
    },
    {
      accountId: account("RETAINED_EARNINGS"),
      debitMinor: 0,
      creditMinor: 641009,
    },
  );
  const opening = {
    orgId,
    expectedCurrency: "JOD",
    asOfDate: periodStart,
    lines,
    allocations,
  };
  const posted = row(
    await must(
      "mutation",
      "accountingCutover:postOpeningBalanceDirect",
      opening,
    ),
  );
  return {
    orgId,
    opening,
    posted,
    allocations,
    accounts,
    partnerId,
    customerId,
    periodEnd,
    nextMonth,
    year,
    month,
    account,
  };
}
/** @typedef {Awaited<ReturnType<typeof prepareOpening>>} Opening */
/** @typedef {Opening & {sources:Row[],prepaidId:string}} ProvenOpening */
/** @param {unknown} value @returns {number} */
function minor(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Opening minor-unit readback unavailable");
  return value;
}
/** @param {Row[]} sources @param {Row[]} allocations */
function assertOpeningAllocationRows(sources, allocations) {
  for (const allocation of allocations) {
    const source = sources.find((value) => value.rowKey === allocation.rowKey);
    if (!source) throw new Error("Opening source missing");
    if ("purpose" in allocation)
      equal(source.purpose, allocation.purpose, "exact source purpose");
    for (const field of ["customerId", "vehicleId", "userId", "partnerId"])
      if (field in allocation)
        equal(source.partyId, allocation[field], "exact source party");
    for (const field of ["kind", "accountId", "amountMinor"])
      equal(source[field], allocation[field], `source ${field}`);
    if (allocation.kind === "UNALLOCATED_LIABILITY") {
      equal(
        source.allocationStatus,
        "UNALLOCATED",
        "unknown remains unallocated",
      );
      equal(source.documentId, null, "unknown has no spendable document");
      equal(source.partyId, null, "unknown has no claimant");
    } else equal(source.recordAvailable, true, "actual source available");
  }
}
/** @param {Must} must @param {string} orgId */
async function proveNoFakeBusinessRows(must, orgId) {
  for (const endpoint of ["sales:list", "expenses:list"]) {
    const page = row(await must("query", endpoint, { orgId, paginationOpts }));
    equal(page.isDone, true, "complete empty business inventory");
    equal(rows(page.page).length, 0, "no fake sale or expense");
  }
}
/** @param {Must} must @param {Opening} fixture */
async function proveNativeSourceReaders(must, fixture) {
  const { orgId, partnerId, customerId } = fixture;
  const sources = rows(
    row(
      await must("query", "accountingCutover:postedOpeningAllocationReadback", {
        orgId,
      }),
    ).rows,
  );
  const canonical = rows(
    await must("query", "subledger:listReceivables", { orgId, limit: 100 }),
  );
  const ar = canonical.find((value) => value.customerId === customerId);
  if (!ar) throw new Error("Canonical opening receivable unavailable");
  equal(
    row(
      await must("query", "subledger:getReceivableBalance", {
        orgId,
        receivableDocumentId: id(ar._id),
      }),
    ).outstandingMinor,
    100003,
    "canonical AR balance",
  );
  const advances = rows(await must("query", "payroll:listAdvances", { orgId }));
  equal(advances.length, 1, "one native opening advance");
  equal(advances[0].amountMinor, 30001, "opening advance amount");
  const partners = row(
    await must("query", "partnerEquity:list", { orgId, paginationOpts }),
  );
  const partner = rows(partners.page).find((value) => value._id === partnerId);
  if (!partner) throw new Error("Opening partner unavailable");
  equal(partner.balanceMinor, 1000000, "opening capital identity");
  const recoveries = row(
    await must("query", "supplierCostRecoveries:list", { orgId }),
  );
  equal(
    rows(recoveries.items)
      .map((value) => minor(value.amountDueMinor))
      .sort((left, right) => left - right),
    [11001, 13001],
    "both native recoverable purposes",
  );
  for (const rowKey of ["supplier", "other"]) {
    const source = sources.find((value) => value.rowKey === rowKey);
    if (!source) throw new Error("Opening payable source missing");
    const payable = row(
      await must("query", "sourcingPayables:get", {
        orgId,
        payableId: id(source.documentId),
      }),
    );
    equal(
      Math.round(Number(payable.amountDue) * 1000),
      rowKey === "supplier" ? 100001 : 90001,
      "native payable amount",
    );
  }
  const commissions = rows(
    await must("query", "openingCommissionLiabilities:list", { orgId }),
  );
  equal(commissions.length, 1, "one distinct opening commission");
  equal(commissions[0].remainingMinor, 50003, "opening commission owing");
  equal(commissions[0].sourceStatus, "AVAILABLE", "commission source proven");
}
/** @param {Must} must @param {Opening} fixture */
async function proveOpeningSources(must, fixture) {
  const { orgId, opening, posted, allocations } = fixture;
  const lines = /** @type {Row[]} */ (opening.lines);
  const readback = row(
    await must("query", "accountingCutover:postedOpeningAllocationReadback", {
      orgId,
    }),
  );
  const sources = rows(readback.rows);
  equal(sources.length, 12, "every admitted source materialized");
  equal(readback.draftId, posted.draftId, "opening source identity");
  equal(readback.journalStatus, "POSTED", "opening journal posted");
  assertOpeningAllocationRows(sources, allocations);
  await proveNoFakeBusinessRows(must, orgId);
  await proveNativeSourceReaders(must, fixture);
  const journal = row(
    await must("query", "accountingLedger:getJournalEntry", {
      orgId,
      journalEntryId: id(posted.journalId),
    }),
  );
  const actualLines = rows(journal.lines);
  equal(
    actualLines.reduce((total, value) => total + minor(value.debitMinor), 0),
    1924016,
    "literal opening debit total",
  );
  equal(
    actualLines.reduce((total, value) => total + minor(value.creditMinor), 0),
    1924016,
    "literal opening credit total",
  );
  equal(actualLines.length, lines.length, "no extra opening journal legs");
  for (const line of lines) {
    const found = actualLines.filter(
      (value) => value.accountId === line.accountId,
    );
    equal(found.length, 1, "one exact selected control line");
    equal(found[0].debitMinor, line.debitMinor, "opening debit");
    equal(found[0].creditMinor, line.creditMinor, "opening credit");
  }
  equal(
    (await journals(must, orgId)).length,
    1,
    "only authentic opening journal",
  );
  const schedules = rows(
    await must("query", "prepaidExpenses:listSchedules", { orgId }),
  );
  const prepaidSource = sources.find((value) => value.rowKey === "prepaid");
  const prepaid = schedules.find(
    (value) => value._id === prepaidSource?.documentId,
  );
  if (!prepaid) throw new Error("Opening prepaid source unavailable");
  return { ...fixture, sources, prepaidId: id(prepaid._id) };
}
/** @param {Must} must @param {ProvenOpening} fixture */
async function settleOpening(must, fixture) {
  const { orgId, periodEnd, sources, year, month, account } = fixture;
  const commission = id(
    fixture.allocations.find((value) => value.rowKey === "commission")
      ?.accountId,
  );
  const claim = id(
    fixture.allocations.find((value) => value.rowKey === "claim")?.accountId,
  );
  const other = id(
    fixture.allocations.find((value) => value.rowKey === "other")?.accountId,
  );
  // Close the real historical period without an override; failure is a failed case, never a skip.
  const periods = rows(
    await must("query", "accountingPeriods:list", { orgId }),
  );
  const previous = periods.find((value) => value.endDate === periodEnd);
  if (!previous) throw new Error("Opening period unavailable");
  const checklist = row(
    await must("query", "accountingPeriods:closeChecklist", {
      orgId,
      periodId: id(previous._id),
    }),
  );
  await must("mutation", "accountingPeriods:close", {
    orgId,
    periodId: id(previous._id),
    acknowledgedWarnings: checklist.warnings,
  });
  const closed = await must("query", "accountingReports:balanceSheet", {
    orgId,
    asOfDate: periodEnd,
  });
  const sourceFor = /** @param {string} rowKey */ (rowKey) => {
    const source = sources.find((value) => value.rowKey === rowKey);
    if (!source) throw new Error("Opening source absent");
    return id(source.documentId);
  };
  const receipt = {
    orgId,
    recoveryId: sourceFor("claim"),
    amountMinor: 11001,
    method: "CASH",
    receivedDate: Date.now(),
    idempotencyKey: key(),
  };
  await must("mutation", "supplierCostRecoveries:recordReceipt", receipt);
  await must("mutation", "supplierCostRecoveries:recordReceipt", receipt);
  const payment = {
    orgId,
    payableId: sourceFor("other"),
    paymentMethod: "CASH",
    idempotencyKey: key(),
  };
  await must("mutation", "sourcingPayables:markPaid", payment);
  await must("mutation", "sourcingPayables:markPaid", payment);
  const runId = id(
    await must("mutation", "payroll:createRun", {
      orgId,
      periodYear: year,
      periodMonth: month + 1,
    }),
  );
  await must("mutation", "payroll:approveRun", { orgId, runId });
  const payslips = rows(
    await must("query", "payroll:listRunItems", { orgId, runId }),
  );
  equal(payslips.length, 1, "one actual employee payslip");
  for (const [field, amount] of [
    ["grossMinor", 50003],
    ["netMinor", 20002],
    ["advanceDeductionMinor", 30001],
    ["openingCommissionMinor", 50003],
    ["commissionMinor", 0],
    ["baseSalaryMinor", 0],
  ])
    equal(payslips[0][String(field)], amount, `native payroll ${field}`);
  const beforePayRows = await journals(must, orgId);
  const beforePay = beforePayRows.length;
  await must("mutation", "payroll:payRun", { orgId, runId, method: "CASH" });
  await refuses(
    () => must("mutation", "payroll:payRun", { orgId, runId, method: "CASH" }),
    "Only an approved payroll run can be paid.",
  );
  const paidJournals = await journals(must, orgId);
  equal(
    paidJournals.length,
    beforePay + 1,
    "native payroll pays once without reaccrual",
  );
  const payrollJournal = paidJournals.find(
    (value) => !beforePayRows.some((original) => original._id === value._id),
  );
  if (!payrollJournal) throw new Error("Native payroll journal absent");
  const paidDetail = row(
    await must("query", "accountingLedger:getJournalEntry", {
      orgId,
      journalEntryId: id(payrollJournal._id),
    }),
  );
  const paidLines = rows(paidDetail.lines);
  equal(paidLines.length, 3, "no payroll reaccrual or extra journal legs");
  for (const [accountId, debit, credit] of [
    [commission, 50003, 0],
    [account("CASH_ON_HAND"), 0, 20002],
    [account("EMPLOYEE_ADVANCES"), 0, 30001],
  ]) {
    const line = paidLines.find((value) => value.accountId === accountId);
    if (!line) throw new Error("Native payroll selected control absent");
    equal(line.debitMinor, debit, "payroll exact debit");
    equal(line.creditMinor, credit, "payroll exact credit");
  }
  for (const endpoint of [
    "accountingReports:commissionPayableReconciliation",
    "accountingReports:supplierPayablesReconciliation",
  ])
    equal(
      row(await must("query", endpoint, { orgId })).isReconciled,
      true,
      "native reconciliation",
    );
  const settledAdvances = rows(
    await must("query", "payroll:listAdvances", { orgId }),
  );
  equal(
    settledAdvances[0].recoveredMinor,
    30001,
    "native opening advance fully recovered",
  );
  const trial = await balances(must, orgId);
  equal(trial.isBalanced, true, "native trial balance");
  const trialRows = rows(trial.rows);
  for (const accountId of [
    claim,
    other,
    commission,
    account("EMPLOYEE_ADVANCES"),
  ])
    equal(
      trialRows.find((value) => value.accountId === accountId)?.netMinor,
      0,
      "selected source control settled once",
    );
  equal(
    await must("query", "accountingReports:balanceSheet", {
      orgId,
      asOfDate: periodEnd,
    }),
    closed,
    "closed balance snapshots unchanged by later settlements",
  );
  return {
    allocations: 12,
    admittedKinds: 10,
    currency: "JOD",
    openingDebitsMinor: 1924016,
    openingCreditsMinor: 1924016,
    closedSnapshotCompared: true,
    nativeSettlements: ["CLAIM", "OTHER_PAYABLE", "PAYROLL"],
    scope:
      "synthetic disposable organization; public API and native ledger readers",
  };
}
/** @param {Context} ctx @param {ProvenOpening} fixture */
async function proveDefaultRefusals(ctx, fixture) {
  const must = ctx.salesMust;
  const { orgId, opening, partnerId, prepaidId } = fixture;
  const before = await journals(must, orgId),
    sharedBefore = await journals(must, ctx.orgId);
  await refuses(
    () =>
      must("mutation", "accountingCutover:postOpeningBalanceDirect", opening),
    "An opening balance has already been posted or is awaiting approval for this organization.",
  );
  await refuses(
    () =>
      must("mutation", "partnerEquity:recordEquityMovement", {
        orgId,
        partnerId,
        type: "PROFIT_DISTRIBUTION",
        amountMinor: 1000,
        paymentMethod: "CASH",
        idempotencyKey: key(),
      }),
    "Profit distribution is not available during the pilot.",
  );
  await refuses(
    () =>
      must("mutation", "prepaidExpenses:correctSchedule", {
        orgId,
        scheduleId: prepaidId,
        writeOffMinor: 1,
        reason: "QA TEST unsupported opening correction",
        idempotencyKey: key(),
      }),
    "Opening prepaid corrections require a separate finance review.",
  );
  const readback = row(
    await must("query", "accountingCutover:postedOpeningAllocationReadback", {
      orgId,
    }),
  );
  const payable = rows(readback.rows).find(
    (value) => value.rowKey === "supplier",
  );
  if (!payable) throw new Error("Opening payable absent");
  await refuses(
    () =>
      must("mutation", "sourcingPayables:markPaid", {
        orgId: ctx.orgId,
        payableId: id(payable.documentId),
        paymentMethod: "CASH",
        idempotencyKey: key(),
      }),
    "Supplier payable not found.",
  );
  equal(
    await journals(must, orgId),
    before,
    "refusals leave opening ledger unchanged",
  );
  equal(
    await journals(must, ctx.orgId),
    sharedBefore,
    "foreign refusal leaves shared ledger unchanged",
  );
  return before;
}
/** @param {Context} ctx @param {ProvenOpening} fixture @param {Row[]} before */
async function proveManagement(ctx, fixture, before) {
  const must = ctx.salesMust;
  const { orgId, posted, nextMonth } = fixture;
  const management = {
    orgId,
    openingDraftId: id(posted.draftId),
    totalMinor: 100003,
    firstEffectiveMonth: nextMonth,
    supportingReference: "QA TEST synthetic management classification",
    classificationAttestation:
      "CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL",
    expectedCurrency: "JOD",
    idempotencyKey: key(),
  };
  const planId = id(
    await must("mutation", "openingManagementSettlement:draft", management),
  );
  equal(
    await must("mutation", "openingManagementSettlement:draft", management),
    planId,
    "same management command replay",
  );
  await refuses(
    () =>
      must("mutation", "openingManagementSettlement:approve", {
        orgId,
        planId,
      }),
    "The management schedule approver must differ from its preparer.",
  );
  await ctx.approverMust("mutation", "openingManagementSettlement:approve", {
    orgId,
    planId,
  });
  const report = row(
    await must("query", "openingManagementSettlement:report", {
      orgId,
      planId,
      throughDate: Date.now(),
    }),
  );
  const installments = rows(report.installments);
  equal(
    installments.map((value) => value.amountMinor),
    [14286, 14286, 14286, 14286, 14286, 14286, 14287],
    "immutable seven-part remainder",
  );
  for (const installment of installments)
    equal(
      installment.recognition,
      "SCHEDULED",
      "future is not recognised or paid",
    );
  equal(report.recognisedMinor, 0, "future management recognition zero");
  equal(
    await journals(must, orgId),
    before,
    "management never writes formal GL",
  );
}
/** Complete native reader witnesses around management commands, not inferred from journal counts.
 * @param {Must} must @param {Opening} fixture @param {string} sessionId @param {number} [balanceAsOf] */
async function managementBooks(must, fixture, sessionId, balanceAsOf) {
  const { orgId, partnerId, account } = fixture;
  const entries = await journals(must, orgId);
  const details = [];
  for (const entry of entries) {
    const detail = row(await must("query", "accountingLedger:getJournalEntry", {
      orgId, journalEntryId: id(entry._id),
    }));
    rows(detail.lines);
    details.push(detail);
  }
  const trial = await balances(must, orgId);
  equal(trial.isBalanced, true, "management witness trial balanced");
  const trialRows = rows(trial.rows);
  for (const [systemKey, expected] of [
    ["CASH_ON_HAND", 1000000], ["BANK_ACCOUNT", 500000], ["PREPAID_EXPENSES", 70003],
  ]) equal(trialRows.find(value => value.accountId === account(String(systemKey)))?.netMinor,
    expected, `management witness ${systemKey}`);
  const bank = row(await must("query", "bankAccounts:getBookBalance", {
    orgId, ...(balanceAsOf === undefined ? {} : { asOf: balanceAsOf }),
  }));
  equal(bank.status, "OK", "management physical bank available");
  equal(bank.balanceMinor, 500000, "management physical bank balance");
  // asOf is a balance cutoff, not evidence that a cached query physically ran again.
  const { asOf, ...bankBalance } = bank;
  const bankBalanceAsOf = minor(asOf);
  if (balanceAsOf !== undefined)
    equal(bankBalanceAsOf, balanceAsOf, "management bank cutoff matches request");
  const cash = rows(await must("query", "cashDrawer:list", { orgId }));
  equal(cash.length, 1, "complete single cash session witness");
  equal(cash[0]._id, sessionId, "actual cash session witness");
  equal(cash[0].openingFloatMinor, 1000000, "management physical cash float");
  const cashMovements = rows(await must("query", "cashDrawer:listMovements", { orgId, sessionId }));
  const prepaid = rows(await must("query", "prepaidExpenses:listSchedules", { orgId }));
  equal(prepaid.length, 1, "actual prepaid witness");
  const partners = row(await must("query", "partnerEquity:list", { orgId, paginationOpts }));
  equal(partners.isDone, true, "complete partner witness");
  const partnerRows = rows(partners.page);
  equal(partnerRows.length, 1, "actual single partner witness");
  equal(partnerRows[0]._id, partnerId, "actual partner identity witness");
  equal(partnerRows[0].balanceStatus, "VERIFIED", "partner witness available");
  equal(partnerRows[0].balanceMinor, 1000000, "management partner balance");
  const partnerMovements = rows(await must("query", "partnerEquity:listTransactions", { orgId, partnerId }));
  return { bankBalanceAsOf, books: {
    entries, details, trial, bankBalance,
    banks: rows(await must("query", "bankAccounts:list", { orgId })),
    cash, cashMovements, prepaid, partners: partnerRows, partnerMovements,
  } };
}
/** Preserve the future-zero proof above; a separate governed opening owns this current-month proof.
 * @param {Context} ctx */
async function proveCurrentManagement(ctx) {
  const must = ctx.salesMust;
  const fixture = await prepareOpening(ctx);
  await proveOpeningSources(must, fixture);
  const { orgId, posted, year, month } = fixture;
  const firstMonth = Date.UTC(year, month, 1);
  const banks = rows(await must("query", "bankAccounts:list", { orgId }));
  equal(banks.length, 1, "single physical bank setup");
  await must("mutation", "bankAccounts:setReconciliationTarget", { orgId, bankAccountId: id(banks[0]._id) });
  const sessionId = id(await must("mutation", "cashDrawer:open", { orgId, openingFloatMinor: 1000000 }));
  const before = await managementBooks(must, fixture, sessionId);
  const preparer = row(await must("query", "users:getMe", {}));
  const approver = row(await ctx.approverMust("query", "users:getMe", {}));
  if (id(preparer._id) === id(approver._id)) throw new Error("Current management requires distinct actual actors");
  const observation = row(row(await must("query", "openingManagementSettlement:context", { orgId })).postedOpening);
  equal(observation.id, posted.draftId, "current management observed native opening");
  const expectedOpeningVersion = observation.observationVersion;
  if (typeof expectedOpeningVersion !== "string" || !expectedOpeningVersion) throw new Error("Opening observation unavailable");
  const planId = id(await must("mutation", "openingManagementSettlement:draftFromObservation", {
    orgId, expectedOpeningVersion, totalMinor: 100003,
    firstEffectiveMonth: firstMonth, supportingReference: "QA TEST current management classification",
    classificationAttestation: "CONSUMED_BEFORE_OPENING_NOT_PREPAID_NOT_CAPITAL",
    expectedCurrency: "JOD", idempotencyKey: key(),
  }));
  await ctx.approverMust("mutation", "openingManagementSettlement:approve", { orgId, planId });
  const plans = rows(await must("query", "openingManagementSettlement:list", { orgId }));
  equal(plans.length, 1, "one native current management plan");
  const plan = plans[0];
  equal(plan._id, planId, "native current management identity");
  equal(plan.status, "APPROVED", "native current management approved");
  equal(plan.createdBy, preparer._id, "native current management preparer");
  equal(plan.approvedBy, approver._id, "native current management approver");
  const approvedAt = minor(plan.approvedAt);
  const approval = new Date(approvedAt);
  equal(Date.UTC(approval.getUTCFullYear(), approval.getUTCMonth(), 1), firstMonth,
    "current management approval month, no rollover or clock mismatch");
  const periods = rows(await must("query", "accountingPeriods:list", { orgId }));
  const current = periods.filter(value => value.startDate === firstMonth);
  equal(current.length, 1, "native current management period identity");
  equal(current[0].status, "OPEN", "native current management period open");
  equal(current[0].endDate, Date.UTC(year, month + 1, 1) - 1, "native current management period end");
  if (approvedAt < firstMonth || approvedAt > Number(current[0].endDate))
    throw new Error("Current management approval outside its measured period");
  const expectedMonths = Array.from({ length: 7 }, (_, index) => Date.UTC(year, month + index, 1));
  const expectedAmounts = [14286, 14286, 14286, 14286, 14286, 14286, 14287];
  const installments = rows(plan.installments);
  equal(plan.totalMinor, 100003, "native current management total");
  equal(installments.map(value => value.amountMinor), expectedAmounts, "native current management literal split");
  equal(installments.map(value => value.effectiveMonth), expectedMonths, "native current management effective months");
  equal(installments.map(value => value.recognitionMonth), expectedMonths, "native current management recognition months");
  // approvedAt comes from the server's stored plan, never a future client-clock cutoff.
  const report = row(await must("query", "openingManagementSettlement:report", { orgId, planId, throughDate: approvedAt }));
  equal(report.throughDate, approvedAt, "server-derived management report date");
  const reported = rows(report.installments);
  equal(reported.map(value => value.amountMinor), expectedAmounts, "reported current management literal split");
  equal(reported.map(value => value.recognitionMonth), expectedMonths, "reported current management recognition months");
  equal(reported.map(value => value.recognition),
    ["RECOGNISED", "SCHEDULED", "SCHEDULED", "SCHEDULED", "SCHEDULED", "SCHEDULED", "SCHEDULED"],
    "exact first management recognition");
  equal(report.recognisedMinor, 14286, "current management recognised amount");
  const official = row(await must("query", "accountingReports:incomeStatement", {
    orgId, fromDate: fixture.opening.asOfDate, toDate: approvedAt,
  }));
  equal(official.netIncome, 0, "independent native current income");
  equal(report.officialNetIncomeMinor, 0, "current management official income");
  equal(report.managementProfitMinor, -14286, "current management profit");
  equal(report.distributionAvailable, false, "current management cannot distribute");
  const after = await managementBooks(must, fixture, sessionId, approvedAt);
  for (const witness of [before, after]) {
    const cutoff = new Date(witness.bankBalanceAsOf);
    equal(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1), firstMonth,
      "current management witness month, no rollover");
  }
  if (approvedAt < before.bankBalanceAsOf)
    throw new Error("Current management bank cutoff is later than approval");
  equal(after.books, before.books, "current management native books unchanged");
  await proveNoFakeBusinessRows(must, orgId);
  return { recognisedMinor: report.recognisedMinor, managementProfitMinor: report.managementProfitMinor,
    distributionAvailable: report.distributionAvailable, plan, report, currentPeriod: current[0], official,
    witnesses: { before, after }, scope: "one current-month installment; no elapsed-seven-month, OCC or production-data proof" };
}
/** @param {Must} must @param {ProvenOpening} fixture */
async function proveIdentifiedCredit(must, fixture) {
  const { orgId } = fixture;
  // Current identified credit remains independent of the two unallocated opening pools.
  const creditCustomer = id(
    await must("mutation", "customers:create", {
      orgId,
      firstName: "QA TEST",
      lastName: "Current credit owner",
    }),
  );
  await must("mutation", "collections:recordPayment", {
    orgId,
    customerId: creditCustomer,
    amount: 25,
    method: "CASH",
    paymentDate: Date.now(),
    idempotencyKey: key(),
  });
  const credits = row(
    await must("query", "collections:listRetainedCredits", {
      orgId,
      customerId: creditCustomer,
      paginationOpts,
    }),
  );
  const creditRows = rows(credits.page);
  equal(creditRows.length, 1, "only actual identified receipt spendable");
  equal(
    creditRows[0].remainingUnappliedMinor,
    25000,
    "identified receipt denomination",
  );
  const receivableId = id(
    await must("mutation", "collections:createReceivable", {
      orgId,
      customerId: creditCustomer,
      sourceType: "OTHER",
      creditSystemKey: "MISCELLANEOUS_INCOME",
      title: "QA TEST current invoice",
      amount: 25,
      dueDate: Date.now(),
      idempotencyKey: key(),
    }),
  );
  await must("mutation", "collections:applyRetainedCredit", {
    orgId,
    receiptMovementId: id(creditRows[0].receiptMovementId),
    receivableId,
    requestedAmount: 25,
    idempotencyKey: key(),
  });
  const remaining = row(
    await must("query", "collections:listRetainedCredits", {
      orgId,
      customerId: creditCustomer,
      paginationOpts,
    }),
  );
  equal(
    rows(remaining.page).map((value) => value.remainingUnappliedMinor),
    [0],
    "identified credit consumed once",
  );
  const trial = await balances(must, orgId);
  const finalBalances = rows(trial.rows);
  for (const allocation of fixture.allocations.filter(
    (value) => value.kind === "UNALLOCATED_LIABILITY",
  ))
    equal(
      finalBalances.find((value) => value.accountId === allocation.accountId)
        ?.netMinor,
      Number(allocation.amountMinor),
      "unknown pool not consumed by current credit",
    );
  const final = row(
    await must("query", "accountingCutover:postedOpeningAllocationReadback", {
      orgId,
    }),
  );
  const unknownSources = rows(final.rows).filter(
    (value) => value.kind === "UNALLOCATED_LIABILITY",
  );
  equal(unknownSources.length, 2, "both unknown sources retained");
  for (const source of unknownSources) {
    equal(source.allocationStatus, "UNALLOCATED", "unknown pool held");
    equal(source.documentId, null, "unknown pool not spendable");
  }
}
/** Execute named callbacks through the caller's existing evidence owner. @param {Context} ctx */
export async function runOpeningRehearsalCases(ctx) {
  /** @type {ProvenOpening|undefined} */
  let fixture;
  await ctx.recordCase(
    ctx.results,
    "S858-OPENING",
    "All admitted opening families through native public APIs",
    async () => {
      const opening = await prepareOpening(ctx);
      const proven = await proveOpeningSources(ctx.salesMust, opening);
      const detail = await settleOpening(ctx.salesMust, proven);
      fixture = proven;
      return detail;
    },
  );
  await ctx.recordCase(
    ctx.results,
    "S858-CONTAINMENT",
    "Opening refuses duplicate, foreign source and uncertified payout; management is non-GL",
    async () => {
      if (!fixture)
        return ctx.unproven(
          "Opening positive fixture unavailable; containment was not executed",
        );
      const before = await proveDefaultRefusals(ctx, fixture);
      await proveManagement(ctx, fixture, before);
      await proveIdentifiedCredit(ctx.salesMust, fixture);
      await proveNoFakeBusinessRows(ctx.salesMust, fixture.orgId);
      const currentManagement = await proveCurrentManagement(ctx);
      return {
        duplicateRefused: true,
        foreignRefused: true,
        payoutRefused: true,
        openingCorrectionRefused: true,
        twoPersonApproval: true,
        managementInstallments: 7,
        managementLedgerUnchanged: true,
        refusedCommandsLedgerUnchanged: true,
        unknownPools: "UNALLOCATED",
        currentManagement,
        scope:
          "current supported refusals; no payout activation or fake expense",
      };
    },
  );
}
