import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandIdentity } from "@/hooks/useCommandIdentity";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, isConvexError } from "@/lib/errors";
import type { ForwardCorrectionKind } from "../ForwardCorrectionDialog";
import type {
  ForwardConfirmOutcome,
  ForwardPaymentValues,
} from "../RecordForwardToFinanceCompanyDialog";

import type { PreFinalizeForward } from "./usePreFinalizeForward";

export function useDealForwardActions({
  orgId,
  applicationId,
  commandId,
  deal,
  preFinalizeForward,
  costCurrency,
  economicsCurrencyCode,
  canConfirmFinanceDisbursement,
  canViewFinance,
  unwindBars,
  formatEconomics,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  commandId: CommandIdentity;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  preFinalizeForward: PreFinalizeForward | undefined;
  costCurrency?: string;
  economicsCurrencyCode: string;
  canConfirmFinanceDisbursement: boolean;
  canViewFinance: boolean;
  unwindBars: boolean;
  formatEconomics: (minor: number) => string;
  t: (key: string) => string;
}>) {
  const recordFinanceCompanyForward = useMutation(
    api.financeCompanyForward.recordFinanceCompanyForward,
  );
  const reverseFinanceCompanyForward = useMutation(
    api.financeCompanyForward.reverseFinanceCompanyForward,
  );
  const reportFinanceCompanyForwardReturned = useMutation(
    api.financeCompanyForward.reportFinanceCompanyForwardReturned,
  );

  const [recordingForward, setRecordingForward] = useState(false);
  const [forwardSubmitting, setForwardSubmitting] = useState(false);
  const [forwardCorrection, setForwardCorrection] =
    useState<ForwardCorrectionKind | null>(null);
  const [forwardCorrectionSubmitting, setForwardCorrectionSubmitting] =
    useState(false);

  const forwardBlocksTransfer =
    deal?.forward?.applies === true &&
    deal.forward.state !== "SETTLED" &&
    deal.forward.state !== "NOT_DUE";
  /**
   * The figures the payment dialog pins, and the amount it sends. After the close
   * they are the frozen plan's (`money.forward`); before it, the plan the close
   * WOULD freeze (SCRUM-411 P2-01), offered only while the server says the payment
   * is still to be recorded and this caller may record it. The two never overlap:
   * the cockpit's `forward.applies` is false until a plan is frozen.
   */
  const forwardPayment =
    deal?.forward?.applies === true && deal.money?.forward
      ? deal.money.forward
      : preFinalizeForward?.state === "UNPAID" && preFinalizeForward.mayRecord
        ? preFinalizeForward.money
        : null;
  // SCRUM-54: banks a bank-method forward may name. The query needs the SAME pair of
  // permissions as the payment (a manager can hold both without MANAGE_FINANCE), so
  // it is asked only for a caller who holds both.
  const forwardBankOptions = useQuery(
    api.financeCompanyForward.listForwardBankOptions,
    forwardPayment && canConfirmFinanceDisbursement && canViewFinance
      ? { orgId, currency: costCurrency ?? economicsCurrencyCode }
      : "skip",
  );
  /**
   * The payment the take-back / report-returned control acts on. A finalized
   * deal's comes from the cockpit; before the close, from the server's status of
   * the payment recorded for the plan the close would freeze, which is also how a
   * STALE payment (recorded against other figures) is taken back and re-recorded.
   */
  const forwardCorrectionTargetId =
    deal?.forward?.onBooksForwardId ??
    preFinalizeForward?.onBooksForwardId ??
    null;
  const mayCorrectForward =
    deal?.forward?.planV2 === true
      ? deal.forward.mayRecord === true
      : preFinalizeForward?.mayRecord === true;

  async function correctForward(
    forwardId: Id<"financeCompanyForwards"> | null,
    transferConfirmed: boolean | undefined,
    reason: string,
  ): Promise<void> {
    const kind = forwardCorrection;
    if (!forwardId || !kind) return;
    // A VOID dialog opened before the transfer was confirmed must not submit after it.
    if (kind === "VOID" && transferConfirmed === true) {
      toast.error(t("ForwardVoidAfterTransfer"));
      setForwardCorrection(null);
      return;
    }
    setForwardCorrectionSubmitting(true);
    const intent = `forward-correction:${kind}:${applicationId}:${forwardId}:${reason}`;
    try {
      if (kind === "VOID") {
        await reverseFinanceCompanyForward({
          orgId,
          applicationId,
          forwardId,
          reason,
          idempotencyKey: commandId.for(intent),
        });
      } else {
        await reportFinanceCompanyForwardReturned({
          orgId,
          applicationId,
          forwardId,
          reason,
          idempotencyKey: commandId.for(intent),
        });
      }
      commandId.retire(intent);
      toast.success(t("ForwardCorrectionSuccess"));
      setForwardCorrection(null);
    } catch (error) {
      if (isConvexError(error)) commandId.retire(intent);
      toast.error(getErrorMessage(error));
    } finally {
      setForwardCorrectionSubmitting(false);
    }
  }

  async function recordForward(
    values: ForwardPaymentValues,
  ): Promise<ForwardConfirmOutcome> {
    // The amount pinned with the first attempt, never the live due: a retry
    // after a lost response must be byte-identical (same key, same args).
    const dueMinor = values.expectedAmountMinor;
    if (!dueMinor) return;
    setForwardSubmitting(true);
    // One key per attempt: a retry after a lost response is the
    // SAME command, and a changed input (the bank included) is a new one.
    const intent = `record-forward:${applicationId}:${dueMinor}:${values.method}:${values.bankAccountId ?? ""}:${values.paidAt}:${values.reference ?? ""}`;
    try {
      await recordFinanceCompanyForward({
        orgId,
        applicationId,
        method: values.method,
        ...(values.bankAccountId
          ? { bankAccountId: values.bankAccountId }
          : {}),
        paidAt: values.paidAt,
        expectedAmountMinor: dueMinor,
        reference: values.reference,
        idempotencyKey: commandId.for(intent),
      });
      commandId.retire(intent);
      toast.success(t("ForwardRecordedSuccess"));
      setRecordingForward(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
      // The server's own answer committed nothing; anything else may have.
      if (isConvexError(error)) commandId.retire(intent);
      else return "UNKNOWN";
    } finally {
      setForwardSubmitting(false);
    }
  }

  return {
    blocksTransfer: forwardBlocksTransfer,
    openRecord: () => setRecordingForward(true),
    record: forwardPayment
      ? {
          confirming: recordingForward,
          submitting: forwardSubmitting,
          onOpenChange: setRecordingForward,
          onConfirm: recordForward,
          dueMinor: forwardPayment.dueMinor,
          totalLabel: formatEconomics(forwardPayment.dueMinor),
          depositLabel: formatEconomics(forwardPayment.depositMinor),
          contributionLabel: formatEconomics(forwardPayment.contributionMinor),
          // E, shown only when above zero. `?? 0`: the frontend can deploy before the backend that adds the field.
          ...((forwardPayment.approvalExcessMinor ?? 0) > 0
            ? { excessLabel: formatEconomics(forwardPayment.approvalExcessMinor) }
            : {}),
          bankOptions: forwardBankOptions,
        }
      : undefined,
    correction:
      mayCorrectForward && forwardCorrectionTargetId && !unwindBars
        ? {
            canVoid: deal?.forward?.transferConfirmed !== true,
            open: forwardCorrection,
            submitting: forwardCorrectionSubmitting,
            onOpen: setForwardCorrection,
            onClose: () => setForwardCorrection(null),
            onConfirm: (reason: string) =>
              correctForward(
                forwardCorrectionTargetId,
                deal?.forward?.transferConfirmed,
                reason,
              ),
          }
        : undefined,
  };
}
