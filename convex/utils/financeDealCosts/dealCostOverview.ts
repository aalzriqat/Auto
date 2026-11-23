import { custodyFeeExpenseKey } from "../dealCustodyPosting";
import type { DealCostAccounting } from "./dealCostAccounting";
import { requireOwnedRow, requireTenantAuth } from "../tenancy";
import { isSystemOwnerRole, PERMISSIONS } from "../permissions";
import {
  actualEvidenceRevisionOf,
  APPLICATION_NOT_FOUND,
  dealAcceptsNewCustodyCash,
  dealEconomicsFrozen,
} from "./dealCostGuards";
import {
  custodyActualExpensesMinor,
  loadActiveFees,
  summarizeCustody,
  unreadableCustodyAmounts,
} from "../settlementDeductions";
import { custodyPageFor, MAX_DEAL_CUSTODY_RECORDS } from "./custodyRecords";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { deriveFeeStatus, summarizeFees, unreadableFeeAmounts } from "../feeSummary";
import { custodyPayableReclassPosted } from "../custodySourceLedger";
import { deriveExpectedFees, type ExpectedFeeRow } from "../handoverFeeProjection";
import {
  blockingHandoverLines,
  directPaymentRefusal,
  handoverPaymentState,
  type HandoverScope,
} from "../handoverCostPayment";
import { dealSettlesDirect, financedSaleRecognitionApplies } from "../financedSaleRecognition";
import {
  executionFeeBindRefusal,
  executionFeeHeadline,
  executionFeePosition,
  executionFeeUnrecorded,
  executionFeeWithheld,
} from "../executionFeePosition";
import { getOpenPeriodForDate } from "../postingPeriod";
import { companyFor, deriveFeeTemplateAdoption } from "./feeTemplates";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/**
 * How much cash the deal's policy says an employee will need at the counter:
 * the configured fees the finance company expects an EMPLOYEE to pay, less
 * those already recorded as paid. A recommendation for the person handing
 * over the money, never an amount anything issues or stores — and withheld
 * (null, with the reason) rather than partial when a relevant estimate is
 * unreadable or nothing is configured.
 */
export function deriveRecommendedCustody(expected: {
  source: "COMPANY_RULE_SNAPSHOT" | "NO_SNAPSHOT" | "NO_TEMPLATES";
  rows: ReadonlyArray<
    Pick<ExpectedFeeRow, "paidBy" | "deductedFromSettlement" | "accountingTreatment" | "expectedAmountMinor" | "actual">
  >;
}): {
  recommendedMinor: number | null;
  reason: "NOT_CONFIGURED" | "NO_EMPLOYEE_PAID_FEES" | "UNSAFE_AMOUNT" | null;
  /** How many employee-paid configured fees still have no actual on record. */
  outstandingCount: number;
} {
  if (expected.source !== "COMPANY_RULE_SNAPSHOT") {
    return { recommendedMinor: null, reason: "NOT_CONFIGURED", outstandingCount: 0 };
  }
  // The rows an employee will pay AT THE COUNTER out of the cash they hold —
  // the same eligibility `resolveFeeCustody` enforces. A fee the company
  // withholds from the remittance is never handed over in cash, and a
  // treatment custody cannot post is not one this money will be charged for.
  const employeeRows = expected.rows.filter(
    (row) =>
      row.paidBy === "EMPLOYEE" &&
      !row.deductedFromSettlement &&
      custodyFeeExpenseKey(row.accountingTreatment).systemKey !== null
  );
  if (employeeRows.length === 0) {
    return { recommendedMinor: null, reason: "NO_EMPLOYEE_PAID_FEES", outstandingCount: 0 };
  }
  const outstanding = employeeRows.filter((row) => row.actual === null);
  if (outstanding.some((row) => row.expectedAmountMinor === null)) {
    return { recommendedMinor: null, reason: "UNSAFE_AMOUNT", outstandingCount: outstanding.length };
  }
  const sum = outstanding.reduce((total, row) => total + (row.expectedAmountMinor ?? 0), 0);
  if (!Number.isSafeInteger(sum)) {
    return { recommendedMinor: null, reason: "UNSAFE_AMOUNT", outstandingCount: outstanding.length };
  }
  return { recommendedMinor: sum, reason: null, outstandingCount: outstanding.length };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Every cost and custody record on a deal, with the totals a person reads. */
export async function listDealCostsHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
  },
  accounting: DealCostAccounting
) {
  const auth = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS, PERMISSIONS.VIEW_COST_PRICE]);
  const app = await requireOwnedRow(
    ctx,
    args.orgId,
    "financeApplications",
    args.applicationId,
    APPLICATION_NOT_FOUND
  );
  // The plan names a person and an amount: `financeApplicationProjection`
  // classes it DISBURSEMENT_WORKFLOW (VIEW_FINANCE or the disbursement
  // permission), and this secondary read honours the same tier rather than
  // serving it to every application viewer (Codex AF-CUST-05, ACC-10).
  const mayReadPlan =
    isSystemOwnerRole(auth.role) ||
    auth.role.permissions.includes(PERMISSIONS.VIEW_FINANCE) ||
    auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);

  // The same bounded read the writers make, and the ONE thing this read
  // refuses on: past `MAX_LIVE_DEAL_FEE_LINES` the screen would be showing
  // a prefix of a deal's costs that reads like the whole of them.
  const fees = await loadActiveFees(ctx, args.applicationId);
  const custodyRows = await custodyPageFor(ctx, args.applicationId);

  // The deal's denomination as the WRITERS would resolve it. Short of that
  // row cap a read does not refuse (a query that throws blanks the screen),
  // so a contradiction is reported in the payload instead: the per-line
  // facts stay readable in their own currency, and every scalar total is
  // withheld with the reason.
  const currency = app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
  const lineCurrencies = [...new Set(fees.map((fee) => fee.currency))];
  const foreignLineCurrencies = lineCurrencies.filter((code) => code !== currency);
  // The same contract for an amount nobody can read: a line carrying NaN, a
  // fraction, a negative or an unsafe value (legacy or raw-edited — the
  // writers refuse them, the rows do not) makes every total a non-figure,
  // and the totals are withheld with the reason rather than served corrupt.
  const amountsUnreadable = unreadableFeeAmounts(fees);
  const summaryUnavailable =
    foreignLineCurrencies.length > 0
      ? {
          reason: "MIXED_DENOMINATION" as const,
          dealCurrency: currency,
          lineCurrencies,
          message: `Costs on this deal are recorded in ${lineCurrencies.join(", ")} while the deal is in ${currency}; totals are unavailable until the records agree.`,
        }
      : amountsUnreadable !== null
        ? {
            reason: amountsUnreadable,
            dealCurrency: currency,
            lineCurrencies,
            message:
              "A cost amount on this deal is not a readable minor-unit figure; totals are unavailable until the line is corrected.",
          }
        : null;

  // Bounded on purpose: the custody SUMMARY is served here, capped and
  // flagged; the movement log behind each record is served by
  // `listCustodyMovements`, paginated, one record at a time. Hydrating
  // every movement of every record inside this read is what could take a
  // deal past the platform's read limits and blank the screen.
  const custodyTruncated = custodyRows.length > MAX_DEAL_CUSTODY_RECORDS;
  const boundedCustody = custodyRows.slice(0, MAX_DEAL_CUSTODY_RECORDS);

  const custody = [];
  for (const row of boundedCustody) {
    // A custody record is balanced against the actuals on the lines it paid
    // for. If any of those lines is in another currency the arithmetic is
    // meaningless, and the record is reported without a summary.
    const paidLines = fees.filter((fee) => fee.custodyId === row._id);
    const custodyMismatch =
      row.currency !== currency || paidLines.some((fee) => fee.currency !== row.currency);
    // The same fail-closed contract as the deal totals: a stored total or a
    // linked actual that is not a readable figure withholds the balance
    // with its own reason. The screen stays up; the record shows no money.
    const actualExpensesMinor = custodyActualExpensesMinor(fees, row._id);
    const custodyUnreadable = custodyMismatch ? null : unreadableCustodyAmounts(row, actualExpensesMinor);
    const holder = await ctx.db.get(row.userId);
    // The latest payable reclassification issued for this record, and
    // whether the ledger has it yet: a version dated into a closed month
    // waits in the outbox with every later one queued behind it, and the
    // screen must not present the row's target as a posted balance.
    const latestReclass = row.payableReclassVersion ?? 0;
    const payableAwaitingPost =
      latestReclass > 0 && !(await custodyPayableReclassPosted(ctx, args.orgId, row._id, latestReclass));
    custody.push({
      ...row,
      /** Who holds the money — the assignee, by display name only; never an address. */
      userName: holder?.name ?? "",
      /** Opened before custody posted to the ledger: every money command refuses it (`assertCustodyOnLedger`). */
      legacy: row.ledgerPosting !== "CANONICAL",
      /** The latest EMPLOYEE_REIMBURSEMENTS_PAYABLE reclassification for this record is still queued, so `payableTargetMinor` is not yet what the books carry. */
      payableAwaitingPost,
      /** The live lines this custody paid for, by id. */
      paidFeeIds: paidLines.map((fee) => fee._id),
      summary:
        custodyMismatch || custodyUnreadable !== null || actualExpensesMinor === null
          ? null
          : summarizeCustody(row, actualExpensesMinor),
      summaryUnavailable: custodyMismatch
        ? { reason: "MIXED_DENOMINATION" as const, custodyCurrency: row.currency, dealCurrency: currency }
        : custodyUnreadable !== null
          ? { reason: custodyUnreadable, custodyCurrency: row.currency, dealCurrency: currency }
          : null,
    });
  }

  const summary = summaryUnavailable === null ? summarizeFees(fees) : null;
  const expectedFees = deriveExpectedFees({
    snapshot: app.companyRuleSnapshot,
    fees,
    currency,
    actualTotalMinor: summary ? summary.actualTotalMinor : null,
  });
  // Whether a configured financed-sale plan covers the deal: the plan itself
  // recognises a settlement-deducted cost only then (SCRUM-443 v6).
  const handoverScope: HandoverScope = {
    // The direct route's transfer goes to the supplier: no settlement for the plan to deduct from.
    planRecognisesDeductions: !(await dealSettlesDirect(ctx, app)) && financedSaleRecognitionApplies(app, { settlesDirect: false }),
  };
  const plannedHolder = mayReadPlan && app.plannedCustody ? await ctx.db.get(app.plannedCustody.userId) : null;
  const executionFee = executionFeePosition(app, fees, currency);
  return {
    currency,
    /**
     * The finance company's execution fee (SCRUM-690 F-PNTR-1) — the same
     * position the finalization gate and both profit headlines read. Null
     * when the deal expects no such fee. `eligibleFeeIds` are the live lines
     * `bindExecutionFeeLine` would accept, by its own predicate.
     */
    executionFee: executionFee.applies
      ? {
          expectedMinor: executionFee.expectedMinor,
          boundFeeId: executionFee.bound?.feeId ?? null,
          unrecorded: executionFeeUnrecorded(executionFee),
          withheld: executionFeeWithheld(executionFeeHeadline(executionFee)),
          eligibleFeeIds: fees
            .filter((fee) => fee.executionFeeBinding === undefined && executionFeeBindRefusal(fee, currency) === null)
            .map((fee) => fee._id),
        }
      : null,
    fees: fees.map((fee) => ({
      ...fee,
      status: deriveFeeStatus(fee),
      /** The revision a reconcile form pins (SCRUM-834); a never-re-recorded line reads 0. */
      actualEvidenceRevision: actualEvidenceRevisionOf(fee),
      /** Whether this line may be charged to an employee's custody from the screen — the boundary's own rules. */
      custodyEligible:
        fee.paidBy === "EMPLOYEE" &&
        !fee.deductedFromSettlement &&
        custodyFeeExpenseKey(fee.accountingTreatment).systemKey !== null &&
        // Every custody record is opened in the deal's currency, so a line
        // in any other currency matches no record (R5, F4).
        fee.currency === currency,
      /**
       * Who paid this handover cost and whether it is on the books
       * (SCRUM-443) — `handoverCostPayment`, the module the closing check
       * and the mutation guards read, so the screen cannot disagree with
       * them. NOT_HANDOVER_LINE for a line outside the invariant.
       */
      handoverPayment: handoverPaymentState(fee, handoverScope),
      /** Whether a direct dealership payment may be recorded on this line now — the mutation's own predicate, in the deal's currency. */
      directPaymentEligible:
        dealAcceptsNewCustodyCash(app).accepts &&
        directPaymentRefusal(fee) === null &&
        fee.currency === currency,
    })),
    /** The live handover lines that stop the deal finalizing (no actual, or neither custody-paid nor direct-paid) — by id, for the screen to point at. */
    handoverCostsBlockingFeeIds: blockingHandoverLines(fees, handoverScope).map((fee) => fee._id),
    /**
     * Whether the org's ledger can take a custody posting right now, with the
     * reason it cannot — the same predicate every custody money mutation
     * refuses on, so a disabled button and a refusal say one thing.
     */
    custodyAccounting: await accounting.dealCustodyAccountingReadiness(ctx, args.orgId),
    /** Whether a posting dated today lands now or queues for a period to be opened. */
    custodyPostsNow: (await getOpenPeriodForDate(ctx, args.orgId, Date.now())) !== null,
    /** Whether posting-bearing edits are refused because the sale is recognized — the writers' own predicate. */
    economicsFrozen: dealEconomicsFrozen(app),
    /** Whether NEW custody cash may be issued on this deal — the issuing commands' own predicate, stopped states included. */
    acceptsNewCustodyCash: dealAcceptsNewCustodyCash(app),
    /** Withheld from a caller below the disbursement tier — `plannedCustody` is then null and says nothing about whether a plan exists. */
    plannedCustodyWithheld: !mayReadPlan,
    /** Who is planned to handle the payments, before any cash moves. Display name only. */
    plannedCustody: mayReadPlan && app.plannedCustody
      ? {
          userId: app.plannedCustody.userId,
          userName: plannedHolder?.name ?? "",
          amountMinor: app.plannedCustody.amountMinor ?? null,
          note: app.plannedCustody.note ?? null,
          plannedAt: app.plannedCustody.plannedAt,
        }
      : null,
    /** What the policy says the employee will need at the counter — a recommendation, never issued or stored. */
    recommendedCustody: deriveRecommendedCustody(expectedFees),
    // Null, never a plausible number, when the lines do not share the deal's
    // currency. A client that renders `summary.actualTotalMinor` has to
    // handle the absence — that is the contract, not a hidden total.
    summary,
    summaryUnavailable,
    // The checklist the finance company's frozen policy implies — expected
    // rows and total derived from the application's own rule snapshot, each
    // matched to the live line that records its actual. Read-only: nothing
    // here is a line, and nothing here is written.
    expected: {
      ...expectedFees,
      // Whether "not configured" is the whole story, or the company has
      // since configured fees an owner may adopt. Reported, never applied.
      adoption: deriveFeeTemplateAdoption({
        app,
        company: await companyFor(ctx, app),
        liveFeeCount: fees.length,
        custodyRecorded: custodyRows.length > 0,
      }),
    },
    custody,
    /** More custody records exist than this read hydrates; the list above is a prefix. */
    custodyTruncated,
    legalInvoiceAmountMinor: app.legalInvoiceAmountMinor,
    legalInvoiceNumber: app.legalInvoiceNumber,
    legalInvoiceDate: app.legalInvoiceDate,
    legalInvoiceRevision: app.legalInvoiceRevision ?? 0,
    legalInvoiceIssuedTo: app.legalInvoiceIssuedTo,
    legalInvoiceIssuedToOther: app.legalInvoiceIssuedToOther,
    legalInvoiceIssuedBy: app.legalInvoiceIssuedBy,
    legalInvoiceIssuerName: app.legalInvoiceIssuerName,
  };
}
