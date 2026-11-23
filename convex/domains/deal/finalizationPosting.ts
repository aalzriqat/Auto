import { isProvablyFinancierless } from "../../utils/dealSettlementFigures";
import { type MutationCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { isForwardPlan } from "../../utils/financedSalePostingPlan";
import { resolveFinancedSalePlan } from "../../utils/financedSaleRecognition";
import {
  hookFinanceDisbursed,
  getOrgCurrency,
} from "../../accounting/workflowHooks";
import { toMinorUnits } from "../../utils/money";
import { manualPayerOf } from "../../utils/manualFinancePayer";
import {
  ensureFinanceCompanyReceivable,
  transferFinancedAmountFromCustomerReceivable,
} from "./financeReceivables";
import { settlesDirectToSupplier } from "./settlementRouting";
import { QuoteMode } from "./quoteIntake";
import type { FinalizeDealInput } from "./finalizeDeal";

export async function recordFinancedClosing(
  ctx: MutationCtx,
  args: FinalizeDealInput,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes">,
  saleId: Id<"sales">,
  saleFinancingType: Doc<"sales">["financingType"],
  quoteMode: QuoteMode | undefined,
  financedSalePlan: Awaited<ReturnType<typeof resolveFinancedSalePlan>>,
  actorId: Id<"users">,
) {
  const now = Date.now();
  // Resolved once, before anything reads it: the patch below and the
  // posting block further down must agree about which way this deal
  // settles, and re-deriving it twice invites them to disagree.
  const directToSupplier = await settlesDirectToSupplier(ctx, app);

  // The divergence the surrounding comment used to describe is closed.
  //
  // This module opened the finance-company receivable from
  // quote.totalFinancedAmount — the customer's financing principal, which
  // is not what the company owes the dealership — and the note here said
  // "PR 2 replaces that posting" while this one stayed deliberately dormant
  // on the money path. This is that replacement. A deal the settlement plan
  // covers is now recognised from the plan, and the principal reaches no
  // ledger account at all.
  //
  // No reconciliation flag is raised, and now for a better reason than
  // before: there is no longer a knowingly-wrong figure to flag. A deal
  // whose settlement cannot be established refuses at
  // the closing-readiness check instead of posting and queueing.

  await ctx.db.patch(args.applicationId, {
    status: "CLOSED",
    finalizedSaleId: saleId,
    finalizationIdempotencyKey: args.idempotencyKey,
    updatedAt: now,
    // Credit stays APPROVED — CLOSED is the sale being created, not a
    // change of decision. What moves is settlement: from here the
    // finance company owes the dealership money.
    creditDecision: "APPROVED",
    // SCRUM-567: NOT_APPLICABLE comes from the same predicate the reader
    // uses; the reader re-proves the lifecycle on every read, and it is
    // never read as settled. Anything unproven stays EXPECTED.
    settlementStatus: isProvablyFinancierless(app, {
      settlesDirect: directToSupplier,
      financingType: saleFinancingType,
      mode: quoteMode,
    })
      ? "NOT_APPLICABLE"
      : "EXPECTED",
    // …except on the direct route, where it owes the dealership nothing.
    // The expected remittance is what the COMPANY will send HERE, and on
    // this route it sends it to the supplier instead. Left at a positive
    // figure it asserts a remittance that will never arrive, and puts the
    // deal into the reconciliation triage queue describing the wrong
    // arrangement — the queue a later settlement PR reconciles against.
    ...(directToSupplier ? { expectedDealerRemittanceMinor: 0 } : {}),
    // Which plan actually posted, recorded next to the sale it posted for.
    // Correcting a fee row afterwards re-derives a different plan; this says
    // what the journal was built from, so the two can be told apart.
    ...(financedSalePlan
      ? {
          financedSaleRecognitionFingerprint: financedSalePlan.fingerprint,
          financedSaleNetReceivableMinor:
            financedSalePlan.financeCompanyReceivableMinor,
          // SCRUM-435: frozen forward due (H + C) and its split.
          ...(isForwardPlan(financedSalePlan)
            ? {
                financedSalePlanVersion: financedSalePlan.version,
                financeCompanyForwardDueMinor: financedSalePlan.forwardDueMinor,
                forwardDepositPortionMinor:
                  financedSalePlan.forwardDepositMinor,
                forwardContributionPortionMinor:
                  financedSalePlan.forwardContributionMinor,
              }
            : {}),
          // SCRUM-27: a manual deal's dealership contribution is derived
          // at this moment (S minus the deposits held) and frozen here, so
          // the cockpit and forward readers see the figure that posted.
          ...(!app.companyId && isForwardPlan(financedSalePlan)
            ? {
                dealerContributionMinor:
                  financedSalePlan.forwardContributionMinor,
                economicsRevision: (app.economicsRevision ?? 0) + 1,
              }
            : {}),
        }
      : {}),
  });

  // On the direct route the finance company pays the SUPPLIER, so none of
  // the three postings below apply — and each would be wrong in its own
  // way rather than merely redundant:
  //
  //  - `transferFinancedAmountFromCustomerReceivable` reduces the customer
  //    receivable to `sale − financed`, which is zero or negative here. On
  //    the direct route that document holds only the dealership's OWN
  //    charges (documentation fees, warranty, GAP), because the car was
  //    invoiced to the buyer by the supplier. It would zero a fee the
  //    customer genuinely owes and mark it PAID, while the GL still
  //    carries the matching AR debit — subledger and ledger disagreeing by
  //    the whole fee.
  //  - `hookFinanceDisbursed` posts DR AR-Finance / CR AR-Customers for
  //    the full principal against a customer AR that was never debited
  //    with it, driving that account to a large credit balance for a
  //    customer who owes nothing.
  //  - the canonical finance-company receivable would record the company
  //    owing the dealership money it will pay to the supplier instead —
  //    a claim nothing can ever settle, sitting beside the real claim,
  //    which runs the other way and is opened against the supplier by
  //    `completeSale`.
  //
  // The dealership's asset on this deal is that supplier margin claim.
  // It is already open by the time this runs.

  // A deal the plan covers has already recognised its finance-company
  // receivable inside the sale's own journal entry, at what the company will
  // actually remit. All that remains is the matching subledger document, at
  // exactly the same figure — the GL and the canonical receivable disagreeing
  // about one counterparty is the failure the shared amount exists to prevent.
  if (financedSalePlan) {
    if (financedSalePlan.financeCompanyReceivableMinor > 0) {
      await ensureFinanceCompanyReceivable(ctx, {
        orgId: args.orgId,
        applicationId: args.applicationId,
        ...(app.companyId
          ? { financeCompanyId: app.companyId }
          : { payerNameSnapshot: manualPayerOf(app)?.name }),
        customerId: app.customerId,
        amountMinor: financedSalePlan.financeCompanyReceivableMinor,
        currency: financedSalePlan.currency,
        actorId,
        now,
      });
    }
  } else if (
    // The pre-plan posting, now reachable only by the deals the plan does
    // not cover. It opens the receivable from the customer's principal and
    // transfers the customer's own receivable down to match, which is the
    // defect SCRUM-192 exists to remove — so nothing that CAN take the plan
    // is allowed to arrive here instead.
    !directToSupplier &&
    app.companyId &&
    quote.totalFinancedAmount &&
    quote.totalFinancedAmount > 0
  ) {
    const currency = await getOrgCurrency(ctx, args.orgId);
    const loanAmountMinor = toMinorUnits(quote.totalFinancedAmount, currency);
    const saleAmountMinor = toMinorUnits(quote.vehiclePrice, currency);
    await hookFinanceDisbursed(ctx, {
      orgId: args.orgId,
      applicationId: args.applicationId,
      saleId,
      financeCompanyId: app.companyId,
      customerId: app.customerId,
      loanAmountMinor,
      currency,
      actorId,
      occurredAt: now,
    });

    await transferFinancedAmountFromCustomerReceivable(ctx, {
      orgId: args.orgId,
      saleId,
      saleAmountMinor,
      financedAmountMinor: loanAmountMinor,
    });

    // Open the canonical finance-company receivable alongside the GL
    // transfer, so the amount owed by the finance company is tracked in
    // the subledger and settled by allocation at confirmDisbursement —
    // not just as an untracked GL balance.
    await ensureFinanceCompanyReceivable(ctx, {
      orgId: args.orgId,
      applicationId: args.applicationId,
      financeCompanyId: app.companyId,
      customerId: app.customerId,
      amountMinor: loanAmountMinor,
      currency,
      actorId,
      now,
    });
  }

  return saleId;
}
