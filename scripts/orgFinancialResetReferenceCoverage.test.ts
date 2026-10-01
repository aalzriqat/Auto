/**
 * SCRUM-546 — schema-driven reference coverage for the organization financial
 * reset.
 *
 * The reset deletes each table in `RESET_TABLES` in independently-batched
 * passes. Any `v.id(<target>)` field on a reset-scoped table whose target is
 * ALSO reset-scoped can therefore be left dangling by a partial pass, unless
 * (a) the child is listed before the target AND (b) `CHILD_TABLES` defers the
 * target while the child still has rows. Two defects of exactly this shape
 * (SCRUM-534 quotes/sales, SCRUM-546 payrollRuns) were found by reviewers, one
 * edge at a time. This test walks the schema so the next one fails here.
 *
 * Every (table, field path, target) must be exactly one of:
 *   1. COVERED       — CHILD_TABLES[target] lists the table, and the table is
 *                      ordered before the target in RESET_TABLES;
 *   2. ACCEPTED      — an OPTIONAL field listed in ACCEPTED_OPTIONAL_DANGLING;
 *   3. KNOWN SURVIVING — listed in KNOWN_SURVIVING_REFERENCES (OPEN DECISION).
 * Anything else, and any stale entry in the lists, fails.
 */
import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import schema from "../convex/schema";
import { CHILD_TABLES_FOR_TEST, RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";

interface ValidatorLike {
  kind: string;
  isOptional?: string;
  tableName?: string;
  fields?: Record<string, ValidatorLike>;
  element?: ValidatorLike;
  members?: ValidatorLike[];
  key?: ValidatorLike;
  value?: ValidatorLike;
}

interface Ref {
  table: string;
  path: string;
  target: string;
  /** False only when the reference is mandatory: no optional/nullable wrapper on the path. */
  optional: boolean;
}

const pairKey = (table: string, path: string, target: string) => `${table}.${path}->${target}`;

/** Collect every v.id() under a validator, tracking optional/nullable wrappers. */
function collect(
  table: string,
  validator: ValidatorLike,
  path: string,
  optional: boolean,
  out: Ref[]
): void {
  const opt = optional || validator.isOptional === "optional";
  switch (validator.kind) {
    case "id":
      out.push({ table, path, target: validator.tableName as string, optional: opt });
      return;
    case "object":
      for (const [name, child] of Object.entries(validator.fields ?? {})) {
        collect(table, child, path ? `${path}.${name}` : name, opt, out);
      }
      return;
    case "array":
      if (validator.element) collect(table, validator.element, `${path}[]`, opt, out);
      return;
    case "record":
      // Key and value are both visited; like array elements they inherit the parent's optionality.
      if (validator.key) collect(table, validator.key, `${path}{key}`, opt, out);
      if (validator.value) collect(table, validator.value, `${path}{}`, opt, out);
      return;
    case "union": {
      const members = validator.members ?? [];
      const nullable = members.some((m) => m.kind === "null");
      for (const m of members) collect(table, m, path, opt || nullable, out);
      return;
    }
    // Leaf kinds that cannot hold a table id.
    case "float64":
    case "int64":
    case "boolean":
    case "bytes":
    case "string":
    case "null":
    case "any":
    case "literal":
      return;
    default:
      throw new Error(
        `Unhandled validator kind "${validator.kind}" at ${table}.${path}: teach collect() about it so no id reference is skipped`
      );
  }
}

function allReferences(): Ref[] {
  const tables = schema.tables as unknown as Record<string, { validator: ValidatorLike }>;
  const out: Ref[] = [];
  for (const [name, def] of Object.entries(tables)) {
    collect(name, def.validator, "", false, out);
  }
  return out;
}

/**
 * Optional reference fields between two reset-scoped tables that are
 * deliberately NOT ordered/deferred. Optional only; each needs a reason.
 */
const ACCEPTED_OPTIONAL_DANGLING: Record<string, string> = {
  "accountingEvents.journalEntryId->journalEntries":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "accountingEvents.reversalOfEventId->accountingEvents":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "accountingEvents.reversedByEventId->accountingEvents":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "canonicalPayments.accountingEventId->accountingEvents":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "canonicalPayments.cashierSessionId->cashierReconciliations":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "canonicalPayments.originalPaymentId->canonicalPayments":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "canonicalPayments.reversalPaymentId->canonicalPayments":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "chartOfAccounts.parentAccountId->chartOfAccounts":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "collectionPayments.canonicalPaymentId->canonicalPayments":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "collectionPayments.chequeId->postDatedCheques":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "collectionPayments.paymentAllocationId->paymentAllocations":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "collectionPayments.receivableId->receivables":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "collectionPayments.reconciliationId->cashierReconciliations":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "commitmentAuthorityWork.activeAttemptId->commitmentAuthorityAttempt":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "deposits.canonicalPaymentId->canonicalPayments":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "financeApplications.approvedPurchaseAppraisalId->financeAppraisals":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "financeAppraisals.supersededByAppraisalId->financeAppraisals":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "financeDealCustodyEntries.reversesEntryId->financeDealCustodyEntries":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "financeDealFees.custodyId->financeDealCustody":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "financeDealFees.custodyPosted.custodyId->financeDealCustody":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "journalEntries.accountingEventId->accountingEvents":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "journalEntries.reversalOfJournalEntryId->journalEntries":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "journalEntries.reversedByJournalEntryId->journalEntries":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "paymentAllocations.reversalOfAllocationId->paymentAllocations":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "paymentAllocations.reversedByAllocationId->paymentAllocations":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "pendingAccountingEvents.originalEventId->accountingEvents":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "pendingAccountingEvents.resultEventId->accountingEvents":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "postDatedCheques.applicationId->financeApplications":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "postDatedCheques.originApplicationId->financeApplications":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "postDatedCheques.receivableId->receivables":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "postDatedCheques.replacementChequeId->postDatedCheques":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "receivableDocuments.accountingEventId->accountingEvents":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "receivableDocuments.reversedDocumentId->receivableDocuments":
    "optional self-reference between rows of one reset table; pre-existing, not individually reviewed; dangling tolerated.",
  "receivables.applicationId->financeApplications":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "receivables.canonicalReceivableDocumentId->receivableDocuments":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "sales.applicationId->financeApplications":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "sales.canonicalReceivableDocumentId->receivableDocuments":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "transactions.depositId->deposits":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
  "transactions.expenseId->expenses":
    "optional reference between reset tables with no CHILD_TABLES edge; pre-existing, not individually reviewed; dangling tolerated.",
};

/**
 * ⚠️ OPEN DECISION (SCRUM-546, owner ruling c21566: document only). Surviving
 * references that the reset leaves pointing at deleted reset-scoped rows, or
 * that a reset-scoped table holds to a table the reset does not clear. None of
 * these is endorsed; listing them stops the set growing silently.
 */
const KNOWN_SURVIVING_REFERENCES: Record<string, string> = {
  "accountBalanceSnapshots.accountId->chartOfAccounts":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "applicationDocuments.applicationId->financeApplications":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "bankStatementLines.matchedJournalLineId->journalLines":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "cashMovements.accountingEventId->accountingEvents":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "claims.receivableDocumentId->receivableDocuments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "claims.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "collectionApprovalRequests.receivableId->receivables":
    "OPEN DECISION: REQUIRED reference; the child is listed AFTER its target in RESET_TABLES and has no edge, so a pass can delete the target while the child survives.",
  "collectionReminders.chequeId->postDatedCheques":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "collectionReminders.receivableId->receivables":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "commitmentAuthorityAttempt.workId->commitmentAuthorityWork":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "commitmentAuthorityWork.depositId->deposits":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "commitmentAuthorityWork.pendingEventId->pendingAccountingEvents":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "commitmentAuthorityWork.saleId->sales":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "commitmentRoots.consumedBySaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "commitmentRoots.headQuoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.correctionJournalEntryId->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.originalJournalEntryIds[]->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.recognizedRevenueTransactionId->transactions":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "consignedSaleCorrections.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "dealerProductDeferrals.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositApplications.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositApplications.quoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "depositApplications.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositRequests.confirmedDepositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "depositRequests.quoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "depositVehicleHolds.appliedSaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "depositVehicleHolds.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "employeeAdvanceRecoveries.payrollItemId->payrollItems":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "financeCompanyForwards.applicationId->financeApplications":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "financeDealCustodyEntries.custodyId->financeDealCustody":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "fixedAssetEvents.accountingEventId->accountingEvents":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "journalLines.accountId->chartOfAccounts":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "journalLines.journalEntryId->journalEntries":
    "OPEN DECISION: REQUIRED reference; the child is listed AFTER its target in RESET_TABLES and has no edge, so a pass can delete the target while the child survives.",
  "manualJournalDrafts.journalEntryId->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "manualJournalDrafts.lines[].accountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "openingBalanceDrafts.journalEntryId->journalEntries":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "openingBalanceDrafts.lines[].accountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "partnerEquityTransactions.accountingEventId->accountingEvents":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentAllocations.paymentId->canonicalPayments":
    "OPEN DECISION: REQUIRED reference; the child is listed AFTER its target in RESET_TABLES and has no edge, so a pass can delete the target while the child survives.",
  "paymentAllocations.receivableDocumentId->receivableDocuments":
    "OPEN DECISION: REQUIRED reference; the child is listed AFTER its target in RESET_TABLES and has no edge, so a pass can delete the target while the child survives.",
  "paymentIntents.canonicalPaymentId->canonicalPayments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.collectionPaymentId->collectionPayments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.paymentAllocationId->paymentAllocations":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.receivableDocumentId->receivableDocuments":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.receivableId->receivables":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentIntents.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "paymentVouchers.depositId->deposits":
    "OPEN DECISION: REQUIRED reference; the child is listed AFTER its target in RESET_TABLES and has no edge, so a pass can delete the target while the child survives.",
  "prepaidExpenseSchedules.expenseId->expenses":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "receiptMovements.initialAllocationIds[]->paymentAllocations":
    "OPEN DECISION: REQUIRED reference; child is ordered first but has no CHILD_TABLES edge, so a partial (small batchSize) pass can delete the target while the child survives.",
  "vehicleCommitmentClaims.applicationId->financeApplications":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.consumedBySaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleCommitmentClaims.quoteId->quotes":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleReservations.depositId->deposits":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicles.soldBySaleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierPayables.paymentAccountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierPayables.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierReceivables.receiptAccountId->chartOfAccounts":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
  "vehicleSupplierReceivables.saleId->sales":
    "OPEN DECISION: table is NOT cleared by the reset; REQUIRED reference survives pointing at a reset-deleted row.",
  "workOrders.expenseId->expenses":
    "OPEN DECISION: table is NOT cleared by the reset; optional reference survives pointing at a reset-deleted row.",
};

interface Verdict {
  unaccounted: string[];
  acceptedButRequired: string[];
  staleEntries: string[];
}

/** Pure so the mutation control can run it against a doctored CHILD_TABLES. */
function evaluate(
  resetTables: readonly string[],
  childTables: Readonly<Record<string, readonly string[]>>,
  accepted: Readonly<Record<string, string>>,
  known: Readonly<Record<string, string>>,
  refs: Ref[]
): Verdict {
  const resetSet = new Set(resetTables);
  const order = new Map(resetTables.map((t, i) => [t, i]));
  const unaccounted: string[] = [];
  const acceptedButRequired: string[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (!resetSet.has(ref.target)) continue; // target survives the reset in any case
    const key = pairKey(ref.table, ref.path, ref.target);
    const fromReset = resetSet.has(ref.table);

    if (fromReset) {
      const deferred = (childTables[ref.target] ?? []).includes(ref.table);
      const ordered =
        ref.table !== ref.target && (order.get(ref.table) ?? Infinity) < (order.get(ref.target) ?? -1);
      if (deferred && ordered) continue;
      if (key in accepted) {
        seen.add(key);
        if (!ref.optional) acceptedButRequired.push(key);
        continue;
      }
    }
    if (key in known) {
      seen.add(key);
      continue;
    }
    unaccounted.push(key);
  }

  const staleEntries = [...Object.keys(accepted), ...Object.keys(known)].filter((k) => !seen.has(k));
  return { unaccounted: unaccounted.sort(), acceptedButRequired, staleEntries: staleEntries.sort() };
}

const render = (title: string, keys: string[]) =>
  `${title}\n${keys.map((k) => `  - ${k}`).join("\n")}`;

describe("organization financial reset covers every reset-to-reset reference", () => {
  test("the analyzer sees the references it is supposed to guard", () => {
    const keys = new Set(allReferences().map((r) => pairKey(r.table, r.path, r.target)));
    // Required references that motivated this test, incl. an array-of-ids one.
    expect(keys).toContain("payrollItems.runId->payrollRuns");
    expect(keys).toContain("payrollItems.commissionSaleIds[]->sales");
    expect(keys).toContain("financeApplications.quoteId->quotes");
    expect(allReferences().find((r) => r.table === "payrollItems" && r.path === "runId")?.optional).toBe(
      false
    );
  });

  test("every reference is covered, accepted, or a pinned open decision", () => {
    const verdict = evaluate(
      RESET_TABLES_FOR_TEST,
      CHILD_TABLES_FOR_TEST,
      ACCEPTED_OPTIONAL_DANGLING,
      KNOWN_SURVIVING_REFERENCES,
      allReferences()
    );
    expect(
      verdict.unaccounted,
      render(
        "Reset-scoped references with no CHILD_TABLES edge + RESET_TABLES order, and no pinned decision. " +
          "Add the edge (child before parent), or pin the pair with a reason:",
        verdict.unaccounted
      )
    ).toEqual([]);
    expect(
      verdict.acceptedButRequired,
      render("ACCEPTED_OPTIONAL_DANGLING is only for OPTIONAL fields:", verdict.acceptedButRequired)
    ).toEqual([]);
    expect(
      verdict.staleEntries,
      render("Pinned entries that no longer match a schema reference:", verdict.staleEntries)
    ).toEqual([]);
  });

  test("MUTATION CONTROL: removing the payrollRuns edge is detected", () => {
    const mutated: Record<string, readonly string[]> = { ...CHILD_TABLES_FOR_TEST };
    delete mutated.payrollRuns;
    const verdict = evaluate(
      RESET_TABLES_FOR_TEST,
      mutated,
      ACCEPTED_OPTIONAL_DANGLING,
      KNOWN_SURVIVING_REFERENCES,
      allReferences()
    );
    expect(verdict.unaccounted).toContain("payrollItems.runId->payrollRuns");
  });

  test("MUTATION CONTROL: listing payrollRuns before payrollItems is detected", () => {
    const reordered = RESET_TABLES_FOR_TEST.filter((t) => t !== "payrollRuns");
    reordered.splice(reordered.indexOf("payrollItems"), 0, "payrollRuns");
    const verdict = evaluate(
      reordered,
      CHILD_TABLES_FOR_TEST,
      ACCEPTED_OPTIONAL_DANGLING,
      KNOWN_SURVIVING_REFERENCES,
      allReferences()
    );
    expect(verdict.unaccounted).toContain("payrollItems.runId->payrollRuns");
  });

  test("MUTATION CONTROL: a v.record key id is collected", () => {
    const out: Ref[] = [];
    collect("t", v.record(v.id("payrollRuns"), v.string()) as unknown as ValidatorLike, "f", false, out);
    expect(out).toEqual([{ table: "t", path: "f{key}", target: "payrollRuns", optional: false }]);
  });

  test("MUTATION CONTROL: a v.record value id inherits the parent optionality", () => {
    const required: Ref[] = [];
    collect("t", v.record(v.string(), v.id("payrollRuns")) as unknown as ValidatorLike, "f", false, required);
    expect(required).toEqual([{ table: "t", path: "f{}", target: "payrollRuns", optional: false }]);
    const optionalOut: Ref[] = [];
    collect("t", v.record(v.string(), v.id("payrollRuns")) as unknown as ValidatorLike, "f", true, optionalOut);
    expect(optionalOut[0]?.optional).toBe(true);
  });

  test("MUTATION CONTROL: an unknown validator kind throws instead of being skipped", () => {
    expect(() => collect("t", { kind: "futureKind" }, "f", false, [])).toThrow(/futureKind.*t\.f|t\.f.*futureKind/);
  });
});
