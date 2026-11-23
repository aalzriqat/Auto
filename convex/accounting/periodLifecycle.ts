import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { readOpeningUnallocatedLiabilities } from "../utils/openingUnallocatedLiabilities";
import { verifyOpeningRead, type OpeningReadCtx } from "../utils/openingSourceIdentity";
import { getCumulativeBalancesAsOfBounded } from "./accountSnapshots";
import {
  SUPPLIER_RECOVERABLES_RECON_FAMILY_WARNING,
  EMPLOYEE_ADVANCES_RECON_FAMILY_WARNING,
  OPENING_DIFFERENCE_WARNING_BY_FAMILY,
  OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY,
  CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING,
  OPENING_SUSPENSE_OPEN_WARNING,
  OPENING_SUSPENSE_UNAVAILABLE_WARNING,
  supplierPayablesUnavailableWarning,
} from "../utils/closeWarnings";

type SharedGlBalances = (cutoff: number) => ReturnType<typeof getCumulativeBalancesAsOfBounded>;
type OpeningCheckState = "OPEN" | "CLEAR" | "UNAVAILABLE";

type Reconciliation = {
  isReconciled: boolean;
  currencies: readonly string[];
  byCurrency: Readonly<Record<string, { isReconciled: boolean }>>;
};
type OpeningFamilyReconciliation = {
  status: "AVAILABLE" | "UNAVAILABLE";
  unavailableReason?: string;
  unexplainedOpeningDifference?: object | null;
};
type CommissionDivergence = {
  unrecognizedCount: number;
  strandedCount: number;
  noPeriodCount: number;
  divergentCount: number;
};

export type PeriodCloseInputs = {
  allPendingOutbox: Doc<"pendingAccountingEvents">[];
  allFailedOutbox: Doc<"pendingAccountingEvents">[];
  allSales: Doc<"sales">[];
  sharedGl: SharedGlBalances;
};

type PeriodCloseReconciliations = {
  openingCtx: OpeningReadCtx;
  arReconciliation: Reconciliation;
  vehicleInventoryRecon: Reconciliation;
  supplierPayablesRecon: Reconciliation & OpeningFamilyReconciliation;
  customerDepositsRecon: Reconciliation & { status: "AVAILABLE" | "UNAVAILABLE"; unavailableReason?: string };
  commissionPayableRecon: Reconciliation;
  employeeAdvancesRecon: OpeningFamilyReconciliation;
  supplierRecoverablesRecon: OpeningFamilyReconciliation;
  partnerCapitalRecon: OpeningFamilyReconciliation;
  prepaidRecognitionShortfall: { hasShortfall: boolean; byCurrency: object; scheduleCount: number };
  commissionRecognitionDivergence: CommissionDivergence;
};

type OpeningHistoryReader = (ctx: OpeningReadCtx, orgId: Id<"organizations">) => Promise<OpeningCheckState>;
type PeriodCloseReaders<Results> = {
  readReconciliations: (ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, period: Doc<"accountingPeriods">, inputs: PeriodCloseInputs) => Promise<Results>;
  orgHasOpeningHistory: OpeningHistoryReader;
  openingSuspenseIsOpen: (ctx: OpeningReadCtx, orgId: Id<"organizations">, cutoff: number) => Promise<OpeningCheckState>;
};

const OPENING_SOURCE_FAMILY_WARNINGS = {
  EMPLOYEE_ADVANCES: EMPLOYEE_ADVANCES_RECON_FAMILY_WARNING,
  SUPPLIER_RECOVERABLES: SUPPLIER_RECOVERABLES_RECON_FAMILY_WARNING,
  PARTNER_CAPITAL: OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY.PARTNER_CAPITAL,
} as const;

type OpeningFamilyKey = keyof typeof OPENING_SOURCE_FAMILY_WARNINGS;

/** Close warnings for the opening-family readers. An "unavailable" reading only warrants a warning where an
 * opening balance exists to reconcile; elsewhere these families are ordinary current-state subledgers. */
async function openingFamilyWarnings(
  orgHasOpeningHistory: OpeningHistoryReader,
  ctx: OpeningReadCtx,
  orgId: Id<"organizations">,
  families: ReadonlyArray<readonly [OpeningFamilyKey, OpeningFamilyReconciliation]>,
): Promise<string[]> {
  const out: string[] = [];
  const hasOpeningHistory = families.some(([, recon]) => recon.status === "UNAVAILABLE")
    ? await orgHasOpeningHistory(ctx, orgId)
    : "CLEAR";
  for (const [family, recon] of families) {
    if (recon.status === "UNAVAILABLE") {
      if (recon.unavailableReason === "SOURCE_FAMILY_UNSUPPORTED") out.push(OPENING_SOURCE_FAMILY_WARNINGS[family]);
      else if (hasOpeningHistory !== "CLEAR") out.push(OPENING_RECON_UNAVAILABLE_WARNING_BY_FAMILY[family]);
    } else if (recon.unexplainedOpeningDifference) out.push(OPENING_DIFFERENCE_WARNING_BY_FAMILY[family]);
  }
  return out;
}

/** Close warnings for sale commissions the ledger does not recognize, or recognizes at a different amount.
 * Reported separately on purpose: "never recognized" is a migration backlog, "different amount" needs a person. */
function commissionDivergenceWarnings(
  d: CommissionDivergence,
): string[] {
  const out: string[] = [];
  if (d.unrecognizedCount > 0) {
    out.push(`${d.unrecognizedCount} completed sale commission(s) are not recognized in the ledger at all. Run the commission accrual backfill.`);
  }
  if (d.strandedCount > 0) {
    out.push(`${d.strandedCount} completed sale commission(s) are not recognized and sit in a closed or locked period, so the backfill cannot post them. Reopen the period covering them (or set the commission to zero) first.`);
  }
  if (d.noPeriodCount > 0) {
    out.push(`${d.noPeriodCount} completed sale commission(s) fall on dates no accounting period covers, so they can never post and will block future closes. Create a period covering those sale dates.`);
  }
  if (d.divergentCount > 0) {
    out.push(`${d.divergentCount} commission(s) are recognized in the ledger at a different amount than the sale records. Review before closing.`);
  }
  return out;
}

function supplierPayablesWarnings(recon: PeriodCloseReconciliations["supplierPayablesRecon"]): string[] {
  // Could not see everything (too many rows to read, or AP-affecting postings still in flight): never report that
  // as reconciled, and never as a difference in an empty list of currencies either.
  if (recon.status === "UNAVAILABLE") return [supplierPayablesUnavailableWarning(recon.unavailableReason)];
  if (recon.isReconciled) return [];
  const badCurrencies = recon.currencies.filter((c) => !recon.byCurrency[c].isReconciled);
  return [`Supplier payables subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`];
}

function customerDepositsWarnings(
  recon: PeriodCloseReconciliations["customerDepositsRecon"],
  openingBasisUnavailable: boolean,
): string[] {
  if (recon.status === "UNAVAILABLE") {
    // Could not compare as of the period end: never reported as reconciled, and never as a difference
    // in an empty list of currencies. An unavailable opening liability basis already has its own warning;
    // an opening deposit row that cannot be dated (its draft is gone) does not, so it is warned here.
    const covered = recon.unavailableReason === "OPENING_SOURCE_UNAVAILABLE" && openingBasisUnavailable;
    return covered ? [] : [CUSTOMER_DEPOSITS_RECON_UNAVAILABLE_WARNING];
  }
  if (recon.isReconciled) return [];
  const badCurrencies = recon.currencies.filter((c) => !recon.byCurrency[c].isReconciled);
  return [`Customer deposits subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`];
}

/**
 * Everything that must be true before a period can close. Closing only flips
 * a status flag and writes an audit entry — this is what actually protects
 * the books: any accounting event still waiting to post, any manual journal
 * still waiting on its second-approver, any AR-vs-GL discrepancy, or any bank
 * statement line from within the period that's never been matched, all block
 * the close outright rather than silently landing in a later period.
 */
export async function buildPeriodCloseChecklist<Results extends PeriodCloseReconciliations>(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  period: Doc<"accountingPeriods">,
  readers: PeriodCloseReaders<Results>,
) {
  // Collected once, unfiltered, and shared: the blocker counts below want only
  // this period's rows, while the commission-recognition control needs every
  // outstanding row regardless of date (a queued entry dated later still means
  // that sale's recognition is pending rather than wrong). Reading them twice
  // is what pushed this checklist toward the transaction read limit — and a
  // checklist that throws takes `close` down with it, before the owner override
  // that is supposed to be the escape hatch.
  const allPendingOutbox = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING"))
    .collect();
  // A dead-lettered event (accountingOutbox.ts's MAX_ATTEMPTS) represents the
  // same unposted GL impact as a pending one — it must block the close just
  // as hard, or a permanently-failed event could silently disappear from
  // every control the moment it stops retrying.
  const allFailedOutbox = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "FAILED"))
    .collect();

  // Same story for the sales table: both commission controls below scan it in
  // full, so without sharing, one close reads it twice.
  const allSales = await ctx.db
    .query("sales")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  // The three opening-family readers below compare the whole ledger at this same cutoff. Read it once for all
  // three: each reading it alone pushed the checklist past the per-transaction document limit.
  let glRead: ReturnType<SharedGlBalances> | undefined;
  const sharedGl: SharedGlBalances = (cutoff) => {
    if (cutoff !== period.endDate) return getCumulativeBalancesAsOfBounded(ctx, orgId, cutoff);
    glRead ??= getCumulativeBalancesAsOfBounded(ctx, orgId, cutoff);
    return glRead;
  };

  const pendingOutboxEvents = allPendingOutbox.filter((e) => e.accountingDate <= period.endDate);
  const failedOutboxEvents = allFailedOutbox.filter((e) => e.accountingDate <= period.endDate);

  // Not period-scoped by date. Since SCRUM-50 a draft DOES carry its declared
  // accountingDate from creation, so the original reason given here ("they have
  // no accountingDate until posted") is no longer true — but the behaviour is
  // still right for the other reason: an unresolved approval is a control gap
  // regardless of which period it will eventually land in.
  const pendingManualJournals = await ctx.db
    .query("manualJournalDrafts")
    .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "PENDING_APPROVAL"))
    .collect();

  const unmatchedBankLines = (
    await ctx.db
      .query("bankStatementLines")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "UNMATCHED"))
      .collect()
  ).filter((l) => l.statementDate <= period.endDate);

  const reconciliations = await readers.readReconciliations(ctx, orgId, period, {
    allPendingOutbox, allFailedOutbox, allSales, sharedGl,
  });
  const {
    arReconciliation,
    vehicleInventoryRecon,
    customerDepositsRecon,
    commissionPayableRecon,
    prepaidRecognitionShortfall,
    commissionRecognitionDivergence,
    openingCtx,
    supplierPayablesRecon,
    employeeAdvancesRecon,
    supplierRecoverablesRecon,
    partnerCapitalRecon,
  } = reconciliations;

  const blockers: string[] = [];
  const warnings: string[] = [];
  if (pendingOutboxEvents.length > 0) {
    blockers.push(`${pendingOutboxEvents.length} accounting event(s) from this period have not posted yet.`);
  }
  if (failedOutboxEvents.length > 0) {
    blockers.push(
      `${failedOutboxEvents.length} accounting event(s) from this period FAILED to post after repeated retries and require resolution — retry them (after fixing the underlying cause) or have an owner explicitly override the close.`
    );
  }
  if (pendingManualJournals.length > 0) {
    blockers.push(`${pendingManualJournals.length} manual journal entr${pendingManualJournals.length === 1 ? "y is" : "ies are"} awaiting approval.`);
  }
  if (!arReconciliation.isReconciled) {
    const badCurrencies = arReconciliation.currencies.filter((c) => !arReconciliation.byCurrency[c].isReconciled);
    blockers.push(`AR subledger does not reconcile to the GL for: ${badCurrencies.join(", ")}.`);
  }
  if (unmatchedBankLines.length > 0) {
    blockers.push(`${unmatchedBankLines.length} bank statement line(s) from this period are still unmatched.`);
  }
  // Point-in-time (as of period.endDate), computed from the authoritative
  // prepaid schedule — so, unlike the current-state warnings below, a shortfall
  // is a real "expense that belongs in this period hasn't been recognized"
  // error and blocks the close. Resolved by running the amortization cron /
  // recognizing the due months before closing.
  if (prepaidRecognitionShortfall.hasShortfall) {
    const currencies = Object.keys(prepaidRecognitionShortfall.byCurrency).join(", ");
    blockers.push(
      `${prepaidRecognitionShortfall.scheduleCount} prepaid expense schedule(s) have amortization due through this period that has not been recognized yet (${currencies}) — run prepaid amortization for the period before closing.`
    );
  }

  // Current-state reconciliations — advisory only (see the note above). A
  // discrepancy here is worth the accountant's attention but is frequently a
  // legitimate cross-period timing artifact rather than a real books error, so
  // it never blocks the close.
  if (!vehicleInventoryRecon.isReconciled) {
    const badCurrencies = vehicleInventoryRecon.currencies.filter((c) => !vehicleInventoryRecon.byCurrency[c].isReconciled);
    warnings.push(`Vehicle Inventory subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (current-state check — review for timing differences).`);
  }
  warnings.push(...supplierPayablesWarnings(supplierPayablesRecon));
  // SCRUM-858 (owner ruling 2026-10-28): a labelled opening-balance difference is reported here and
  // never corrected by a posting. The label text is a fixed constant because close matches it verbatim.
  if (supplierPayablesRecon.unexplainedOpeningDifference) {
    warnings.push(OPENING_DIFFERENCE_WARNING_BY_FAMILY.SUPPLIER_PAYABLES);
  }
  // Owner ruling 2026-11-04: the opening difference sits in suspense as an open item until classified.
  const suspense = await readers.openingSuspenseIsOpen(openingCtx, orgId, period.endDate);
  if (suspense === "OPEN") warnings.push(OPENING_SUSPENSE_OPEN_WARNING);
  if (suspense === "UNAVAILABLE") warnings.push(OPENING_SUSPENSE_UNAVAILABLE_WARNING);
  const heldOpeningLiabilities = await verifyOpeningRead(openingCtx,
    guarded => readOpeningUnallocatedLiabilities(guarded, orgId, period.endDate),
    () => ({ status: "UNAVAILABLE" as const, rows: [] }));
  if(heldOpeningLiabilities.status === "UNAVAILABLE")warnings.push("Opening unallocated liability basis is unavailable. Finance must reconcile the source proof.");
  else if(heldOpeningLiabilities.status === "UNALLOCATED")warnings.push("Opening liabilities include unallocated held pools. Arithmetic reconciliation does not establish beneficial ownership; these pools are not available for customer refunds or credit application.");
  warnings.push(
    ...(await openingFamilyWarnings(readers.orgHasOpeningHistory, openingCtx, orgId, [
      ["EMPLOYEE_ADVANCES", employeeAdvancesRecon],
      ["SUPPLIER_RECOVERABLES", supplierRecoverablesRecon],
      ["PARTNER_CAPITAL", partnerCapitalRecon],
    ])),
    ...customerDepositsWarnings(customerDepositsRecon, heldOpeningLiabilities.status === "UNAVAILABLE"),
  );
  if (!commissionPayableRecon.isReconciled) {
    const badCurrencies = commissionPayableRecon.currencies.filter((c) => !commissionPayableRecon.byCurrency[c].isReconciled);
    // The subledger side sums only what the commission ENTRIES actually
    // recognized in the GL (see computeCommissionPayableReconciliation), so
    // neither a commission still queued behind a closed period nor a correction
    // that posted into a later one shows up here as a difference. What remains
    // is a real one — which matters, because closing a period requires
    // acknowledging every warning verbatim, and a line that fires on every
    // close teaches people to click through the ones that matter.
    // "(current-state check — review for timing differences)" is what the other
    // four subledger warnings say, and it was copied here. It is no longer true
    // of this one: computeCommissionPayableReconciliation is point-in-time on
    // BOTH sides as of the period end, which is precisely the change that
    // stopped it firing on every close. Telling an accountant to go looking for
    // timing differences sends them after a cause that has been designed out.
    warnings.push(`Commission payable subledger does not reconcile to the GL for: ${badCurrencies.join(", ")} (evaluated as of the period end on both sides — this is a real difference, not a timing one).`);
  }
  // The reconciliation above compares the GL against amounts derived from the
  // same posted entries, so it cannot see a commission recognized at the wrong
  // figure — both sides would be wrong together and agree. These are the
  // independent checks: what the ledger recognized versus what the sale
  // actually records. Sales with an entry still in the outbox are excluded,
  // since unposted events are already a blocker above.
  //
  // Reported separately on purpose. "Never recognized" is the expected state of
  // every commission decided before earned-time recognition shipped, and it is
  // fixed by running the backfill; "recognized at a different amount" means
  // something went wrong and needs a person. Reporting both under one message
  // made an ordinary migration backlog read as ledger corruption — and a
  // warning that must be acknowledged verbatim on every close is exactly how
  // people learn to click through the ones that matter.
  warnings.push(...commissionDivergenceWarnings(commissionRecognitionDivergence));

  return {
    summary: {
      canClose: blockers.length === 0,
      blockers,
      warnings,
      pendingOutboxEventCount: pendingOutboxEvents.length,
      failedOutboxEventCount: failedOutboxEvents.length,
      pendingManualJournalCount: pendingManualJournals.length,
      unmatchedBankLineCount: unmatchedBankLines.length,
      prepaidRecognitionShortfallScheduleCount: prepaidRecognitionShortfall.scheduleCount,
    },
    reconciliations,
  };
}
