import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkflowAction } from "./DealWorkflowAction";
import { type StageDeepLink } from "./dealStepView";
import { SaleDialog } from "@/components/sales/SaleDialog";
import { CashDraftTermsDialog, useSaveDraft } from "./CashDraftTermsDialog";
import { DealCommissionsRow } from "@/components/commissions/DealCommissionsRow";
import { DealCockpit, DealCockpitView, useSaleDealPermissions } from "./DealCockpit";
import { useRecordDealSupplierReceipt } from "./useDealSupplierSettlementActions";
import { useCancelCashDeal } from "./useCancelCashDeal";
import { useLanguage } from "@/components/providers/LanguageProvider";

/**
 * The cash rail's one next step per live stage (SCRUM-417, G8) — see
 * `SaleDealCockpit`. A stage absent here offers no step. HANDOVER is not here:
 * it opens the sale's own dialog, which needs this screen's state (W3).
 */
const CASH_STAGE_ACTION: Readonly<Partial<Record<string, WorkflowAction>>> = {
  SETTLEMENT: { stageKey: "SETTLEMENT", actionKey: "SettleSupplierAction", opens: "SETTLE_SUPPLIER" },
};

/**
 * THE canonical deal screen, keyed on the sale — cash or financed.
 *
 * This is the one address a deal has once it exists. It is not a cash-only
 * screen: a sale with a finance application is rendered HERE, by delegating the
 * financed wiring to `DealCockpit`, so the operator never has to know
 * which kind of deal they are looking at to find it.
 *
 * The delegation is what keeps this honest. The financed deal's money still
 * comes from `applications.dealCockpit` — the shipped, reviewed query that
 * understands approved purchase amounts, supplier settlement routes and the
 * `postable: false` management headline. Teaching `sales.dealCockpit` to
 * compute financed money would have produced a SECOND source of truth for the
 * same figures, which is the one thing SCRUM-26 and SCRUM-30 forbade outright.
 * So: one URL, one view, and each kind's money answered by the query that
 * already knows it.
 *
 * There is no settlement-advice correction on the cash path because there is no
 * finance company to have issued one — the action is ABSENT rather than shown
 * disabled, which is the same rule the rest of this screen follows.
 *
 * The supplier receipt action IS wired, and deliberately. A consigned CASH deal
 * settled DIRECT_TO_SUPPLIER leaves the supplier holding the dealership's margin
 * exactly as a financed one does, and `supplierReceivables.recordReceipt` is
 * keyed on the claim rather than on any financing — so the collection workflow
 * the previous release built works here unchanged.
 */
export function SaleDealCockpit({
  orgId,
  saleId,
  stageDeepLink,
}: Readonly<{ orgId: Id<"organizations">; saleId: Id<"sales">; stageDeepLink?: StageDeepLink }>) {
  const deal = useQuery(api.sales.dealCockpit, { orgId, saleId });
  const recordSupplierReceipt = useRecordDealSupplierReceipt(orgId);
  const updateSale = useSaveDraft();
  const { permissionsLoading, canSettleSupplier, canWriteSale, canReadSaleForm, canViewSales, canViewFinance, canCancelCashDeal } =
    useSaleDealPermissions();
  const { t } = useLanguage();
  // SCRUM-969: an applicationless sale only (a financed deal cancels through its
  // application, in `DealCockpit`). `dealKind` alone is not the test: a FINANCED
  // sale with no application also lands on this branch, and the server cancels
  // it here exactly like a cash sale.
  const cashCancel = useCancelCashDeal({
    orgId,
    saleId,
    status: deal?.status,
    canCancel: canCancelCashDeal && deal != null && deal.financingApplicationId == null,
    t,
  });

  /**
   * HANDOVER on a cash deal is the sale still being a draft (SCRUM-417 W3).
   * Completing it is the sale's OWN dialog — the one the Sales page opens —
   * which saves the draft through `sales.update` (edit:sales) and then
   * completes it through `sales.completeDraft` (create:sales) with its
   * idempotency key and deposit decision. So the step is offered to a caller
   * holding both, and opens that dialog for THIS sale; nothing about
   * completion is reimplemented here.
   *
   * The dialog edits a hydrated sale record, which the cockpit payload is not,
   * so `sales.get` (view:sales, the cockpit's own read permission) is loaded —
   * only while the step is live and usable. Until it arrives the step offers
   * no button: the dialog opened with no sale is the NEW-sale form.
   */
  /**
   * Round 2 (Codex S417-R2-2): the dialog also READS, unconditionally, on
   * mount — `customers.list` (view:customers), `vehicles.listAll`
   * (view:vehicles; also what `approvals.profitApprovalStatus` inside it
   * takes) and `memberships.list` (view:users) — and convex/react rethrows a
   * refused query during render. Its other read, `sales.consignedSalePreview`,
   * takes view:sales, which this screen already requires. A caller missing any
   * of the three is told so instead of being handed a form that throws.
   */
  const cashLive = deal?.stages.find((stage) => stage.state === "CURRENT" || stage.state === "BLOCKED");
  const canCompleteSale = canWriteSale && canReadSaleForm;
  const handoverLive = cashLive?.key === "HANDOVER" && deal?.financingApplicationId == null;
  const saleRecord = useQuery(api.sales.get, handoverLive && canCompleteSale ? { orgId, saleId } : "skip");
  // The dialog completes a DRAFT (`completingDraft` in SaleDialog is
  // `sale.status === "PENDING"`); any other loaded status is not this step.
  const draftSale =
    saleRecord && saleRecord._id === saleId && saleRecord.status === "PENDING" ? saleRecord : undefined;
  /**
   * Round 2 (Codex S417-R2-3), CONTAINED — not fixed — here. A draft linked to
   * a quote completes through the reservation-deposit resolution, which
   * refuses without a stated deposit treatment when the car's share exceeds
   * what the dealership billed. SaleDialog calls `completeDraft` without one
   * and has no control to state it. No server read answers "is a treatment
   * required" (it turns on the bill, which the client must not rebuild), so
   * the step is withheld for a quote-linked draft whose quote has RECEIVED a
   * deposit — `deposits.quoteAllocation.totalReceivedMinor`, the server's own
   * figure, on the view:sales this screen already requires — or whose
   * allocation cannot be read. A draft with no quote carries no deposit
   * resolution at all and is unaffected.
   */
  const quoteAllocation = useQuery(
    api.deposits.quoteAllocation,
    draftSale?.quoteId ? { orgId, quoteId: draftSale.quoteId } : "skip"
  );
  const [completingSale, setCompletingSale] = useState(false);
  const [correctingDraft, setCorrectingDraft] = useState<{
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    terms: NonNullable<NonNullable<typeof deal>["cashDraftTerms"]>;
  } | null>(null);
  const correctableDraft = handoverLive && deal?.saleId === saleId ? deal.cashDraftTerms : undefined;

  /**
   * A financed sale is rendered here, not sent elsewhere.
   *
   * `sales.dealCockpit` deliberately withholds money for a financed sale — there
   * is no second profit for this deal to publish at any permission level — so the
   * financed money must come from `applications.dealCockpit`. Delegating gets
   * that without duplicating it, and without moving the operator off the URL they
   * are on. `canonicalizeUrl={false}` because THIS route is already the canonical
   * one; the delegate must not send it back to itself.
   */
  const financingApplicationId = deal?.financingApplicationId ?? null;
  if (financingApplicationId) {
    return (
      <DealCockpit
        orgId={orgId}
        applicationId={financingApplicationId}
        canonicalizeUrl={false}
        stageDeepLink={stageDeepLink}
      />
    );
  }

  /**
   * The cash rail's one next step (SCRUM-417, G8), from the handlers this
   * screen already has — nothing new is invented for it.
   *
   * HANDOVER on a cash deal is the sale still being a draft: completing it is
   * `sales.completeDraft`, an economic command with its own deposit decision
   * that lives in the sale's own dialog, so the step names where it is done
   * rather than growing a second completion path here. SETTLEMENT is the
   * supplier's claim, settled through the same dialog the money panel opens;
   * the view resolves it against the claim's state and this caller's authority.
   */
  let cashAction: WorkflowAction | undefined;
  if (permissionsLoading || !cashLive) cashAction = undefined;
  else if (cashLive.key === "HANDOVER") {
    // Told apart in the order an operator can act on: the authority to
    // complete at all, then the reads the form needs, then — once THIS draft
    // is loaded — whether its completion needs a deposit decision the form
    // cannot record. Until what decides it has loaded, no button.
    let reason: string | undefined;
    if (!canWriteSale) reason = "CashSaleCompletionNeedsPermission";
    else if (!canReadSaleForm) reason = "CashSaleCompletionNeedsReadAccess";
    else if (draftSale?.quoteId && quoteAllocation !== undefined) {
      if (quoteAllocation === null || quoteAllocation.totalReceivedMinor > 0) {
        reason = "CashSaleCompletionNeedsDepositDecision";
      }
    }
    const decided = draftSale !== undefined && (!draftSale.quoteId || quoteAllocation !== undefined);
    if (reason) {
      cashAction = {
        stageKey: "HANDOVER",
        actionKey: "CompleteCashSaleAction",
        unavailableReasonKey: reason,
        // SCRUM-417 UX1 (S4): the deposit decision is made from the sale's own
        // dialog on the Sales page. Linked only for a caller who can open it;
        // the two permission reasons above already name who acts.
        ...(reason === "CashSaleCompletionNeedsDepositDecision"
          ? canViewSales
            ? { unavailableLink: { href: `/${orgId}/sales/sales`, labelKey: "OpenSalesPageAction" } }
            : { unavailableNoteKey: "SalesPageNeedsAccess" }
          : {}),
      };
    } else if (decided) {
      cashAction = {
        stageKey: "HANDOVER",
        actionKey: "CompleteCashSaleAction",
        onStart: () => setCompletingSale(true),
      };
    }
  } else cashAction = CASH_STAGE_ACTION[cashLive.key];

  return (
    <>
      <DealCockpitView
        orgId={orgId}
        renderCommissions={({ profitMinor, money, t }) => (
          <DealCommissionsRow orgId={orgId} saleId={deal?.saleId} profitMinor={profitMinor} money={money} t={t} />
        )}
        deal={deal}
        stageDeepLink={stageDeepLink}
        backHref={`/${orgId}/deals`}
        workflowAction={cashAction}
        cashCancel={cashCancel}
        stageCorrection={correctableDraft ? {
          stageKey: "SALE_AGREED",
          labelKey: "CorrectCashDraftTermsAction",
          onOpen: () => setCorrectingDraft({ orgId, saleId, terms: correctableDraft }),
        } : undefined}
        canSettleSupplier={canSettleSupplier}
        supplierSettlementHref={
          // Supplier payables are paid on the sourcing page (`sourcingPayables.markPaid`,
          // MANAGE_FINANCE; its list needs VIEW_FINANCE).
          canSettleSupplier && canViewFinance ? `/${orgId}/sourcing` : undefined
        }
        onRecordSupplierReceipt={recordSupplierReceipt}
      />
      {/* Mounted only with THIS sale's record in hand: without one the dialog
          is the new-sale form, which must never open from a deal. */}
      {/* Offered only for a loaded DRAFT (`draftSale`); kept mounted on the
          record while open, so the sale turning COMPLETED under its own
          submit does not yank the form away mid-flow. */}
      {completingSale && saleRecord && saleRecord._id === saleId && (
        <SaleDialog open onOpenChange={setCompletingSale} sale={saleRecord} />
      )}
      {correctingDraft?.saleId === saleId && correctingDraft.orgId === orgId && (
        <CashDraftTermsDialog
          draft={correctingDraft.terms}
          onClose={() => setCorrectingDraft(null)}
          onSave={async (correction) => {
            await updateSale({
              orgId,
              saleId,
              salePrice: correction.salePrice,
              saleDate: correction.saleDate,
              draftCorrection: correction.draftCorrection,
            });
          }}
        />
      )}
    </>
  );
}
