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
import { KNOWN_SURVIVING_REFERENCES } from "../convex/utils/orgResetReferences";
import { RESET_VEHICLE_REFERENCE_CLEARS, RESET_KEPT_REFERENCE_INDEX, RESET_SURVIVOR_INDEX, survivingReferenceTables } from "../convex/utils/orgResetSurvivorPreflight";
import { OPENING_ATOMIC_REFERENCE_CLEARS } from "../convex/utils/openingResetCleanup";
import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import schema from "../convex/schema";
import { CHILD_TABLES_FOR_TEST, RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";
import { allReferences, collect, type Ref, type ValidatorLike } from "./schemaIdReferences";

const pairKey = (table: string, path: string, target: string) => `${table}.${path}->${target}`;

/**
 * Optional reference fields between two reset-scoped tables that are
 * deliberately NOT ordered/deferred. Optional only. Each reason was verified by
 * grepping the readers and writers of the field (SCRUM-559); a field that IS
 * hard-dereferenced must be an edge, or be safe only because the suspension
 * preflight blocks every non-internal caller, and the reason must say so.
 */
const ACCEPTED_OPTIONAL_DANGLING: Record<string, string> = {
  "commitmentRoots.lineageRootId->commitmentRoots": "Optional same-table immutable lineage, no ordering can protect self references. Reset removes all roots while suspended.",
  "commitmentRoots.restoredFromRootId->commitmentRoots": "Optional same-table predecessor; all roots are deleted, no new authority is granted by this reference.",
  "commitmentRoots.originReservationId->vehicleReservations": "Historical optional origin. Reservations drain first, so expiry has no source rows to act on before claims/roots drain.",
  "vehicleCommitmentClaims.restoredFromClaimId->vehicleCommitmentClaims": "Optional same-table predecessor lineage; all claims drain before roots.",
  "vehicleCommitmentClaims.reservationId->vehicleReservations": "Reservations drain before claims to remove the expiry cron source first; the opposite reservation->claim link is deferred.",
  "depositVehicleHolds.sourceHoldId->depositVehicleHolds": "Optional same-table immutable lineage; all holds drain before their deposit.",
  "deposits.reservationId->vehicleReservations": "Optional reverse lifecycle link, reservations drain first so expiry has no source; tenant mutations are suspended.",
  "deposits.singleVehicleCommitmentClaimId->vehicleCommitmentClaims": "Optional reverse claim link; claims drain first, with reservations already gone and tenant writers suspended.",
  "financeApplications.currentCommitmentClaims[].claimId->vehicleCommitmentClaims": "Optional reverse claim projection. Claims drain before applications; reservations are gone before claims and tenant writers are suspended.",
  "vehicles.soldBySaleId->sales": "Optional SOLD ownership, erased with vehicle. Sales must drain first because their vehicle link is required; this reset never restores a SOLD vehicle to inventory.",
  "dealCommissionLines.payrollItemId->payrollItems":
    "Written only (payroll.ts payItem patch when a line is paid); no reader dereferences it. Lines are deleted after payroll items, so a pass that stops between them leaves a line pointing at a deleted item that nothing reads.",
  "accountingEvents.reversalOfEventId->accountingEvents":
    "Self-reference; read only as an id compare (utils/financeCompanyForward.ts:154) and passed to a null-guarded get (utils/prepaidRecognitionEvents.ts:179-182); never a hard dereference.",
  "accountingEvents.reversedByEventId->accountingEvents":
    "Self-reference; every read null-guards the get (accounting/reversals.ts:58-59, accountingReports.ts:1110-1111, utils/financeCompanyForward.ts:149-153 fails to NEEDS_REPAIR).",
  "retainedCreditRefundRequests.accountingEventId->accountingEvents":
    "Optional, set once at payout (retainedCreditRefunds.ts); written only, the list query never dereferences it.",
  "canonicalPayments.accountingEventId->accountingEvents":
    "Written only (subledger.ts:123,201); no reader dereferences it.",
  "canonicalPayments.cashierSessionId->cashierReconciliations":
    "Written only (subledger.ts:200); no reader dereferences it.",
  "canonicalPayments.originalPaymentId->canonicalPayments":
    "Self-reference; no reader or writer exists in convex/ outside the schema.",
  "canonicalPayments.reversalPaymentId->canonicalPayments":
    "Self-reference; no reader or writer exists in convex/ outside the schema.",
  "chartOfAccounts.parentAccountId->chartOfAccounts":
    "Self-reference; read only to validate the parent when an account is created (chartOfAccounts.ts:817-818), a tenant mutation the suspension blocks.",
  "collectionPayments.chequeId->postDatedCheques":
    "Only compared through the by_cheque index (collections.ts:2263); never dereferenced from the payment row.",
  "collectionPayments.receivableId->receivables":
    "Read only through a null-guarded get (collections.ts:292, hydratePayment); no other reader dereferences it.",
  "collectionPayments.reconciliationId->cashierReconciliations":
    "Written (collections.ts:3026) and index-filtered (collections.ts:2928) only; no reader dereferences it.",
  "commitmentAuthorityWork.activeAttemptId->commitmentAuthorityAttempt":
    "Reverse edge would cycle (attempt.workId requires work); the reset refuses any org holding authority rows (orgFinancialReset.ts authority preflight), and the one reader null-guards (accountingOutbox.ts:895-904).",
  "financeApplications.approvedPurchaseAppraisalId->financeAppraisals":
    "Dereferenced by financingEconomics.recomputeEconomicsForApplication (financingEconomics.ts:188-190, null-tolerated but silently drops the LTV basis) via financeDealCosts.recordDealFee (financeDealCosts.ts:1828); a reverse edge would cycle because appraisals require their application. Safe mid-reset ONLY because the suspension preflight blocks that tenant-auth writer (financeDealCosts.ts has no internal or scheduled entry point).",
  "financeAppraisals.supersededByAppraisalId->financeAppraisals":
    "Self-reference; written only (financingEconomics.ts:2096); no reader dereferences it.",
  "financeDealCustodyEntries.reversesEntryId->financeDealCustodyEntries":
    "Self-reference; hard-dereferenced by financeDealCosts.ts:1326,1419,3235 and utils/custodySourceLedger.ts:1258,1750, all tenant-auth functions or pure ledger folds over a live custody, blocked by the suspension preflight.",
  "invoiceReceiptApplications.splitFromApplicationId->invoiceReceiptApplications":
    "Self-reference (a table cannot defer itself through CHILD_TABLES); written only when an application is split (accounting/invoiceReceiptActivation.ts:273); no reader dereferences it.",
  "invoiceReceiptApplications.splitRemainderId->invoiceReceiptApplications":
    "Self-reference; written when an application is split (accounting/invoiceReceiptActivation.ts:288) and only echoed back as an id in the replay result (:127); never dereferenced.",
  "journalEntries.accountingEventId->accountingEvents":
    "Reverse of the E2 edge (accountingEvents.journalEntryId), which would cycle; the only reader null-guards (accountingLedger.ts:198).",
  "journalEntries.reversalOfJournalEntryId->journalEntries":
    "Self-reference; written only (accounting/reversals.ts:219); no reader dereferences it.",
  "journalEntries.reversedByJournalEntryId->journalEntries":
    "Self-reference; written only (accounting/reversals.ts:272); no reader dereferences it.",
  "paymentAllocations.reversalOfAllocationId->paymentAllocations":
    "Self-reference; used only as a Map key in accountingReports.ts:443-450, never dereferenced.",
  "paymentAllocations.reversedByAllocationId->paymentAllocations":
    "Self-reference; written only (subledger.ts:367); no reader dereferences it.",
  "postDatedCheques.replacementChequeId->postDatedCheques":
    "Self-reference; the only reader (chequeLineageAudit.ts:77-78) null-guards the get and answers UNRESOLVED; collections.ts:2171 writes it.",
  "receivableDocuments.accountingEventId->accountingEvents":
    "Written only (subledger.ts:123); no reader dereferences it.",
  "receivableDocuments.reversedDocumentId->receivableDocuments":
    "Self-reference; no reader or writer exists in convex/ outside the schema.",
  "receivables.applicationId->financeApplications":
    "Only ownership-checked when a receivable is created (collections.ts:239-241), a tenant mutation the suspension blocks; never dereferenced from a stored row.",
  "sales.applicationId->financeApplications":
    "Dereferenced by sales.cancel (sales.ts:1024-1025, fails closed), getBillOfSaleEconomics (sales.ts:353) and utils/financingProvenance.ts:86,98 (reports and dashboard). A reverse edge would cycle. Safe mid-reset ONLY because the suspension preflight blocks those tenant-auth callers.",
  "transactions.depositId->deposits":
    "Read through null-guarded gets (transactions.ts:40-45, depositRevenueImpact.ts:107) and an id compare (reports.ts:1050).",
  "transactions.expenseId->expenses":
    "Written at creation only (transactions.ts:273,297); no reader dereferences it.",
};

/**
 * ⚠️ OPEN DECISION (SCRUM-546, owner ruling c21566: document only). Surviving
 * references that the reset leaves pointing at deleted reset-scoped rows, or
 * that a reset-scoped table holds to a table the reset does not clear. None of
 * these is endorsed; listing them stops the set growing silently.
 */


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
  refs: Ref[],
  atomicClears: readonly string[] = [...OPENING_ATOMIC_REFERENCE_CLEARS, ...RESET_VEHICLE_REFERENCE_CLEARS]
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
    // These exact new edges have destructive-lifecycle read/write controls; no dangling exemption.
    if (atomicClears.includes(key)) { seen.add(key); continue; }
    // These two optional protocol cursors are consumed by openingResetCleanup and
    // removed on reset completion. They are not operational or financial authority.
    if (ref.optional && (key === "organizations.openingCleanupPayableScan.pendingPayableIds[]->vehicleSupplierPayables" ||
      key === "organizations.openingCleanupReferenceScan.source.id->vehicleSupplierPayables")) continue;

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

  const staleEntries = [...Object.keys(accepted), ...Object.keys(known), ...atomicClears].filter((k) => !seen.has(k));
  return { unaccounted: unaccounted.sort(), acceptedButRequired, staleEntries: staleEntries.sort() };
}

const render = (title: string, keys: string[]) =>
  `${title}\n${keys.map((k) => `  - ${k}`).join("\n")}`;

describe("organization financial reset covers every reset-to-reset reference", () => {
  test("runtime survivor and retained-reference probes name real org-leading indexes", () => {
    const definitions = schema.tables as unknown as Record<string, { indexes: Array<{ indexDescriptor: string; fields: string[] }> }>;
    for (const table of survivingReferenceTables(RESET_TABLES_FOR_TEST)) {
      const index = definitions[table]?.indexes.find(i => i.indexDescriptor === RESET_SURVIVOR_INDEX[table]);
      expect(index?.fields[0], table).toBe("orgId");
    }
    for (const [table, name] of Object.entries(RESET_KEPT_REFERENCE_INDEX)) {
      expect(definitions[table]?.indexes.find(i => i.indexDescriptor === name)?.fields[0], table).toBe("orgId");
    }
  });
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

  test("MUTATION CONTROL: removing measured atomic clears exposes every new cycle/proof edge", () => {
    const verdict = evaluate(RESET_TABLES_FOR_TEST, CHILD_TABLES_FOR_TEST, ACCEPTED_OPTIONAL_DANGLING, KNOWN_SURVIVING_REFERENCES, allReferences(), []);
    expect(verdict.unaccounted).toEqual(expect.arrayContaining([...OPENING_ATOMIC_REFERENCE_CLEARS, ...RESET_VEHICLE_REFERENCE_CLEARS]));
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
