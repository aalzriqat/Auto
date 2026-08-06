/**
 * Contract test: every org-scoped table is reachable by the org hard-delete.
 *
 * Three tables shipped on the financing branch — `financeAppraisals`,
 * `financeApplicationOverrides` and `financeCompanyRuleVersions` — carrying
 * customer valuations, money-change audit rows, a finance company's commercial
 * terms and undeleted `_storage` blobs. All three were invisible to
 * `hardDeleteOrg`, which nonetheless reported success. Nothing in the toolchain
 * could tell them apart from the forty that were covered.
 *
 * Fixing those three does not stop the fourth. This does: the step list is
 * checked against the schema itself, so a new `orgId` table fails here until
 * somebody either deletes it with the org or writes down why it survives.
 */
import { describe, expect, test } from "vitest";
import schema from "../convex/schema";
import { ORGANIZATION_DELETION_STEPS } from "../convex/adminOrgs";
import { RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";

/**
 * Tables that hold an `orgId` and are deliberately NOT deleted with the org.
 *
 * Each needs a reason, because "it was never in the list" is exactly how the
 * three financing tables went missing.
 */
const RETAINED_BY_DESIGN: Record<string, string> = {
  // The platform's own deletion trail. Deleting it with the org would erase the
  // record that the deletion happened, which is the one row that must outlive
  // it.
  adminAuditLog: "platform deletion trail, retained on purpose",
  // The deletion driver's own state row. `runDeletionRequestBatch` patches it
  // on every tick, so deleting it mid-run makes the next tick find no request,
  // return early, and stop the chain — with no reschedule, no FAILED status and
  // no audit, leaving the organization half-deleted. It must outlive the org it
  // is deleting.
  organizationDeletionRequests: "the deletion driver's own state row",
};

/**
 * ⚠️ Org-scoped tables `hardDeleteOrg` does NOT reach today.
 *
 * These are PRE-EXISTING and unreviewed — not decisions. Writing them down is
 * not the same as endorsing them: several plainly hold tenant data a deletion
 * is supposed to remove (payroll runs and items, bank accounts and statement
 * lines, cash drawer sessions and movements, employee advances and their
 * recoveries, prepaid schedules, marketplace profiles). `hardDeleteOrg` reports
 * success while leaving every one of them behind.
 *
 * They are listed rather than fixed because closing them is a separate piece of
 * work with its own review — this list exists so the count cannot grow
 * silently while that work is pending. Adding a new org-scoped table without a
 * deletion step fails the test below; it does not get to join this list without
 * somebody typing its name here and being asked why.
 */
const KNOWN_UNCOVERED_PRE_EXISTING: readonly string[] = [
  "accountBalanceSnapshots",
  "accountingCutoverSignOffs",
  "bankAccounts",
  "bankStatementLines",
  "cashDrawerSessions",
  "cashMovements",
  "dealerProductDeferrals",
  "depositVehicleHolds",
  "employeeAdvanceRecoveries",
  "employeeAdvances",
  "employeeCompensation",
  "exchangeRates",
  "fixedAssetEvents",
  "leadActivities",
  "manualJournalDrafts",
  "marketplaceDealerProfiles",
  "marketplaceEvents",
  "marketplaceRequestMatches",
  "marketplaceResponses",
  "marketplaceTradeInRequests",
  "marketplaceWeeklyReportSends",
  "marketplaceWhatsAppFlows",
  "membershipOffboardingJobs",
  "openingBalanceDrafts",
  "partnerEquityTransactions",
  "paymentVouchers",
  "payrollItems",
  "payrollRuns",
  "prepaidAmortizationFailures",
  "prepaidCorrectionRequests",
  "prepaidExpenseSchedules",
  "prepaidScheduleCorrections",
  "pushSubscriptions",
  "userOffboardingReviews",
  "vehicleCostCorrections",
  "websiteLeadAbuseEvents",
  "websiteLeadBlocklist",
];

/** Table names in the schema that carry a direct `orgId` field. */
function orgScopedTables(): string[] {
  const tables = schema.tables as Record<string, { validator: { fields?: Record<string, unknown> } }>;
  return Object.entries(tables)
    .filter(([, table]) => Object.hasOwn(table.validator.fields ?? {}, "orgId"))
    .map(([name]) => name)
    .sort();
}

/** Table names the deletion step list reaches, including the storage-aware steps. */
function tablesCoveredByDeletion(): Set<string> {
  const covered = new Set<string>();
  for (const step of ORGANIZATION_DELETION_STEPS) {
    if (step.kind === "orgRows") covered.add(step.table);
  }
  // The special steps delete a named table plus its storage blobs. Listed
  // explicitly rather than inferred, so renaming one surfaces here.
  for (const [kind, table] of [
    ["vehiclesWithStorage", "vehicles"],
    ["vehicleEditsWithStorage", "vehicleEdits"],
    ["applicationDocumentsWithStorage", "applicationDocuments"],
    ["financeAppraisalsWithStorage", "financeAppraisals"],
    ["orgSettingsWithStorage", "orgSettings"],
    ["socialPostsWithStorage", "socialPosts"],
    ["dmConversations", "dmConversations"],
    ["liveChatThreads", "liveChatThreads"],
  ] as const) {
    if (ORGANIZATION_DELETION_STEPS.some((step) => step.kind === kind)) covered.add(table);
  }
  return covered;
}

describe("organization hard-delete coverage", () => {
  test("the analyzer actually sees the schema", () => {
    // A guard nobody has watched work is not a guard. If this list ever comes
    // back empty the assertions below all pass vacuously.
    const tables = orgScopedTables();
    expect(tables.length).toBeGreaterThan(40);
    expect(tables).toContain("financeApplications");
    expect(tables).toContain("financeAppraisals");
  });

  test("no NEW org-scoped table escapes the org hard-delete", () => {
    const covered = tablesCoveredByDeletion();
    const known = new Set([...KNOWN_UNCOVERED_PRE_EXISTING, ...Object.keys(RETAINED_BY_DESIGN)]);
    const missing = orgScopedTables().filter(
      (table) => !covered.has(table) && !known.has(table)
    );

    expect(
      missing,
      `These tables carry an orgId but nothing in ORGANIZATION_DELETION_STEPS removes them, ` +
        `so hardDeleteOrg would report success and leave them behind forever:\n` +
        missing.map((t) => `  - ${t}`).join("\n") +
        `\n\nAdd a deletion step (storage-aware if the table holds _storage ids), ` +
        `or add the table to RETAINED_BY_DESIGN with the reason it must outlive the org.`
    ).toEqual([]);
  });

  test("the known-uncovered list only shrinks", () => {
    // Every entry that has since been covered should be struck off, so the list
    // stays an accurate account of what is still wrong rather than decaying
    // into stale noise that nobody trusts.
    const covered = tablesCoveredByDeletion();
    const stale = KNOWN_UNCOVERED_PRE_EXISTING.filter((table) => covered.has(table));
    expect(
      stale,
      `These are now deleted with the org — remove them from KNOWN_UNCOVERED_PRE_EXISTING:\n` +
        stale.map((t) => `  - ${t}`).join("\n")
    ).toEqual([]);

    const schemaTables = new Set(Object.keys(schema.tables));
    const vanished = KNOWN_UNCOVERED_PRE_EXISTING.filter((t) => !schemaTables.has(t));
    expect(vanished, "listed tables that no longer exist in the schema").toEqual([]);
  });

  test("a retained-by-design table is never added to the deletion steps", () => {
    // The other direction, and the one that bites hardest. Adding
    // `{ kind: "orgRows", table: "organizationDeletionRequests", index: "by_org" }`
    // passes every other test in this file and kills the deletion chain at that
    // step: the next tick finds no request, returns early, and the run stops
    // with no reschedule, no FAILED status and no audit — leaving the
    // organization half-deleted. Same shape for `adminAuditLog`, which would
    // erase the record that the deletion happened.
    const covered = tablesCoveredByDeletion();
    const wronglyCovered = Object.keys(RETAINED_BY_DESIGN).filter((t) => covered.has(t));
    expect(
      wronglyCovered,
      `These must OUTLIVE the org but a deletion step now removes them:\n` +
        wronglyCovered.map((t) => `  - ${t}: ${RETAINED_BY_DESIGN[t]}`).join("\n")
    ).toEqual([]);
  });

  test("the deletion steps only name tables that exist", () => {
    const schemaTables = new Set(Object.keys(schema.tables));
    const unknown = [...tablesCoveredByDeletion()].filter((table) => !schemaTables.has(table));
    expect(unknown).toEqual([]);
  });

  test("the financial reset knows about every storage field it has to delete", () => {
    // The reset sweeps blobs by a hardcoded field name. `expenses`,
    // `paymentVouchers`, `receivableDocuments` and `postDatedCheques` are all in
    // its table list and are plausible attachment carriers — the day one gains a
    // storage id under any other name, the orphan defect this branch just fixed
    // returns silently. Same thesis as the deletion guard above: fixing the
    // instance does not stop the next one.
    const schemaTables = schema.tables as Record<
      string,
      { validator: { fields?: Record<string, unknown> } }
    >;
    const found: Record<string, string[]> = {};
    for (const table of RESET_TABLES_FOR_TEST) {
      const fields = schemaTables[table]?.validator.fields ?? {};
      const storageFields = Object.entries(fields)
        .filter(([, validator]) => JSON.stringify(validator).includes('"_storage"'))
        .map(([name]) => name);
      if (storageFields.length > 0) found[table] = storageFields.sort();
    }
    expect(
      found,
      `A table in RESET_TABLES carries storage ids the reset does not sweep. ` +
        `Add it to the blob-deletion branch in convex/orgFinancialReset.ts, then update this expectation.`
    ).toEqual({ financeAppraisals: ["documentStorageIds"] });
  });

  test("the financial reset clears an application's children, not just the application", () => {
    // Leaving these behind orphans rows whose applicationId points at a deleted
    // document — and, for appraisals, storage blobs nothing references.
    expect(RESET_TABLES_FOR_TEST).toContain("financeApplications");
    expect(RESET_TABLES_FOR_TEST).toContain("financeAppraisals");
    expect(RESET_TABLES_FOR_TEST).toContain("financeApplicationOverrides");
  });
});
