import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import type { PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { SupplierSettlementDialog } from "./SupplierSettlementDialog";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { DealCockpitData } from "./DealStagePresentation";
import type { WorkflowAction } from "./DealWorkflowAction";

export function useSupplierReceiptAction({
  deal,
  orgId,
  callerMaySettleSupplier,
  supplierSettlementHref,
  onRecordSupplierReceipt,
  trackStep,
  t,
}: Pick<DealCockpitViewProps, "orgId" | "supplierSettlementHref" | "onRecordSupplierReceipt"> &
  Readonly<{
    deal: DealCockpitData | undefined | null;
    callerMaySettleSupplier: boolean;
    trackStep: NonNullable<DealCockpitViewProps["recordedFeedback"]>["track"];
    t: (key: string) => string;
  }>) {
  const [settlingSupplier, setSettlingSupplier] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // CX-6. `recordReceipt` is ADDITIVE — it adds to `amountReceived` — so a lost
  // outcome or a double invocation records a second receipt and posts a second
  // cash/receivable journal. `submitting` is UI state and cannot deduplicate a
  // commit that already landed. One key per attempt, held in a ref so a retry
  // reuses it, and cleared only once the server has confirmed.
  const receiptKeyRef = useRef<string | null>(null);

  // A claim to settle AND a caller the server would accept the receipt from.
  // The first four terms are the deal's state; the last is the operator's
  // authority, decided by the container from MANAGE_FINANCE and never here.
  //
  // `supplierReceipt` is the SERVER's own verdict on whether `recordReceipt`
  // would take the command, formed from the claim's status. The position alone
  // was not enough: a DISPUTED claim reads OWED_TO_DEALERSHIP — the money IS
  // still owed — and the screen offered a settlement the mutation refuses on
  // sight. The position stays truthful; the action follows the verdict.
  const supplierRow = deal?.money?.parties.find((p) => p.party === "SUPPLIER");
  const supplierReceipt = deal?.money?.supplierReceipt;
  const supplierClaimSettleable =
    deal?.money?.settlesDirectToSupplier === true &&
    deal.money.routeKnown &&
    supplierRow?.position === "OWED_TO_DEALERSHIP" &&
    supplierRow.amountMinor !== null &&
    supplierReceipt?.actionable === true;
  const canSettleSupplier = callerMaySettleSupplier && supplierClaimSettleable;
  const supplierReceiptBankOptions = useQuery(
    api.supplierReceivables.listReceiptBankOptions,
    orgId && canSettleSupplier && settlingSupplier && supplierRow?.receivableId
      ? { orgId, receivableId: supplierRow.receivableId as Id<"vehicleSupplierReceivables"> }
      : "skip"
  );
  // Named guidance for the one refusal the operator can act on. Every other
  // reason simply withholds the button, as before.
  const supplierGuidance =
    supplierReceipt?.actionable === false && supplierReceipt.reason === "CLAIM_DISPUTED"
      ? t("SupplierClaimDisputedGuidance")
      : undefined;

  // Authority is LIVE, not a snapshot taken when the dialog opened. If the
  // membership finishes loading without MANAGE_FINANCE, is revoked mid-entry,
  // or the deal's state stops allowing a settlement, the open dialog closes
  // itself IN THE SAME RENDER (React's adjust-state-during-render pattern, so
  // no frame ever paints the form under a lost grant, and regaining the grant
  // later does not re-open a form nobody asked for). The dialog is also
  // mounted only while the action is offered, and the submit path re-checks,
  // so a stale form cannot send the command.
  if (!canSettleSupplier && settlingSupplier) setSettlingSupplier(false);

  const handleSupplierReceipt = async (receipt: {
    amount: number;
    receiptMethod?: PaymentMethod;
    bankAccountId?: Id<"bankAccounts">;
    receiptReference?: string;
    receivedAt?: number;
  }) => {
    // Fail closed on the authority as it stands NOW, not as it stood when the
    // form was opened. The server would refuse anyway; this stops the screen
    // from issuing a command it already knows will be refused.
    if (!canSettleSupplier || !supplierRow?.receivableId) {
      setSettlingSupplier(false);
      return;
    }
    setSubmitting(true);
    try {
      // Keyed to THIS claim, whose id the server resolved. The screen never
      // lets a client name a receivable of its own choosing.
      receiptKeyRef.current ??= crypto.randomUUID();
      const receiptKey = receiptKeyRef.current;
      await trackStep(
        () =>
          onRecordSupplierReceipt(supplierRow.receivableId as Id<"vehicleSupplierReceivables">, {
            ...receipt,
            idempotencyKey: receiptKey,
          }),
        "ReceiptRecorded"
      );
      // Only now: a failed attempt keeps its key so retrying is the same
      // receipt rather than a second one.
      receiptKeyRef.current = null;
      setSettlingSupplier(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const open = canSettleSupplier ? () => setSettlingSupplier(true) : undefined;

  function resolveAction(action: WorkflowAction): WorkflowAction {
    if (open) return { ...action, onStart: open };
    // Told apart, in the order the operator can act on: a disputed claim
    // (the money panel's own guidance), a claim this caller may not settle,
    // and a balance that is not settled from this screen at all.
    let reason = "CashSettlementNotRecordedHere";
    if (supplierGuidance) reason = "SupplierClaimDisputedGuidance";
    else if (supplierClaimSettleable || deal?.money == null) reason = "SupplierSettlementNeedsPermission";
    // S4: on the through-dealership route the supplier's share is a payable
    // the dealership owes, paid from the supplier payables page. Only that
    // position is a payable someone can pay; every other sub-case (an
    // UNKNOWN obligation, a route not known) keeps its own reason and a note.
    if (
      reason === "CashSettlementNotRecordedHere" &&
      deal?.money?.settlesDirectToSupplier === false &&
      supplierRow?.position === "DEALERSHIP_OWES"
    ) {
      return {
        ...action,
        unavailableReasonKey: "SupplierPayableRecordedOnPayables",
        ...(supplierSettlementHref
          ? { unavailableLink: { href: supplierSettlementHref, labelKey: "OpenSourcingPayablesAction" } }
          : { unavailableNoteKey: "SupplierPayablesNeedFinanceRole" }),
      };
    }
    return {
      ...action,
      unavailableReasonKey: reason,
      ...(reason === "CashSettlementNotRecordedHere"
        ? { unavailableNoteKey: "SupplierSettlementNeedsPermission" }
        : {}),
    };
  }

  function renderDialog(factor: number, money: (minor: number) => string) {
    // Unmount immediately when live authority or the actionable claim is lost.
    return supplierRow && supplierRow.amountMinor !== null && canSettleSupplier ? (
      <SupplierSettlementDialog
        open={settlingSupplier}
        submitting={submitting}
        supplierName={supplierRow.name}
        outstandingMajor={supplierRow.amountMinor / factor}
        outstandingLabel={money(supplierRow.amountMinor)}
        bankOptions={supplierReceiptBankOptions}
        t={t}
        onOpenChange={setSettlingSupplier}
        onConfirm={handleSupplierReceipt}
      />
    ) : null;
  }

  return { open, guidance: supplierGuidance, resolveAction, renderDialog };
}
