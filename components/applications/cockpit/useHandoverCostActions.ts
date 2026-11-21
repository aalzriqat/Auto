import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandIdentity } from "@/hooks/useCommandIdentity";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, isConvexError } from "@/lib/errors";
import {
  HandoverCostAttemptError,
  type ActualHandoverCost,
  type DirectHandoverPayment,
  type ExpectedHandoverRow,
  type NewHandoverCost,
} from "./HandoverCostsPanel";

export function useHandoverCostActions({
  orgId,
  applicationId,
  commandId,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  commandId: CommandIdentity;
  t: (key: string) => string;
}>) {
  const recordDealFee = useMutation(api.financeDealCosts.recordDealFee);
  const recordTemplateFeeActual = useMutation(api.financeDealCosts.recordTemplateFeeActual);
  const recordExecutionFeeActual = useMutation(api.financeDealCosts.recordExecutionFeeActual);
  const bindExecutionFeeLine = useMutation(api.financeDealCosts.bindExecutionFeeLine);
  const unbindExecutionFeeLine = useMutation(api.financeDealCosts.unbindExecutionFeeLine);
  const recordActualFeeAmount = useMutation(api.financeDealCosts.recordActualFeeAmount);
  const recordDirectFeePayment = useMutation(api.financeDealCosts.recordDirectFeePayment);
  const voidDealFee = useMutation(api.financeDealCosts.voidDealFee);
  const reconcileDealFee = useMutation(api.financeDealCosts.reconcileDealFee);

  return {
    onAdd: async (values: NewHandoverCost) => {
      const feeIntent = `record-deal-fee:${applicationId}:${values.intentId}`;
      try {
        await recordDealFee({
          orgId,
          applicationId,
          // REQUIRED: the currency the form was opened under and the
          // amount counted in. A retry replays this captured value.
          expectedCurrency: values.currency,
          feeType: values.feeType,
          description: values.description,
          // An ADDITIONAL cost: actual only. The UI never authors an
          // expectation — those are the finance company's, from the
          // deal's frozen snapshot (owner correction 2026-09-12 21:05).
          estimatedAmountMinor: undefined,
          actualAmountMinor: values.actualAmountMinor,
          // Always the employee's, out of custody cash (owner ruling
          // 2026-09-28, SCRUM-439); charged to the named record in the
          // same command when this caller may, else it waits under
          // "Charge a cost".
          paidBy: "EMPLOYEE",
          ...(values.custodyId ? { custodyId: values.custodyId } : {}),
          paidTo: values.paidTo,
          accountingTreatment: values.accountingTreatment,
          paidAt: values.paidAt,
          receiptReference: values.receiptReference,
          source: "MANUAL",
          idempotencyKey: commandId.for(feeIntent),
        });
        commandId.retire(feeIntent);
        toast.success(t("HandoverCostSaved"));
      } catch (error) {
        // The server's own refusal is thrown inside the mutation and
        // rolls it back: nothing committed. Anything else is a lost
        // response, and the cost may already exist.
        throw new HandoverCostAttemptError(getErrorMessage(error), isConvexError(error) ? "REFUSED" : "UNKNOWN");
      }
    },
    onAbandonAdd: (intentId: string) => {
      commandId.retire(`record-deal-fee:${applicationId}:${intentId}`);
    },
    /**
     * The ACTUAL for a fee the finance company's policy configures. The
     * caller names WHICH fee by its position in the deal's frozen
     * snapshot and what it saw there; the server copies every other
     * field from that entry and refuses a stale or out-of-range
     * reference.
     *
     * One retained identity per (deal, position), with the SAME outcome
     * discipline as the additional-cost add: a REFUSED attempt is the
     * server's own answer (ConvexError, nothing committed) and releases
     * the identity, so the next submit is a new command; an UNKNOWN
     * attempt (lost response) KEEPS it, so the form's verbatim retry
     * replays the same line and a changed payload is refused as a
     * different intent. The server's one-live-line-per-position rule is
     * what makes this lifecycle safe end to end: after a lost response,
     * replay, cancel-and-record-again, or a second operator can land at
     * most one actual on the row.
     */
    onRecordTemplateActual: async (row: ExpectedHandoverRow, values: ActualHandoverCost) => {
      const intent = `record-template-fee:${applicationId}:${row.templateIndex}`;
      try {
        await recordTemplateFeeActual({
          orgId,
          applicationId,
          templateIndex: row.templateIndex,
          feeType: row.feeType,
          actualAmountMinor: values.actualAmountMinor,
          // REQUIRED: the deal's denomination the amount was counted in.
          expectedCurrency: values.currency,
          paidAt: values.paidAt,
          receiptReference: values.receiptReference,
          idempotencyKey: commandId.for(intent),
        });
        commandId.retire(intent);
        toast.success(t("HandoverCostSaved"));
      } catch (error) {
        const outcome = isConvexError(error) ? "REFUSED" : "UNKNOWN";
        if (outcome === "REFUSED") commandId.retire(intent);
        throw new HandoverCostAttemptError(getErrorMessage(error), outcome);
      }
    },
    onAbandonTemplateActual: (row: ExpectedHandoverRow) => {
      commandId.retire(`record-template-fee:${applicationId}:${row.templateIndex}`);
    },
    /**
     * SCRUM-690: record the execution fee's actual and link it in one
     * command. The same outcome discipline as the template actual; the
     * server keeps at most one linked line per deal, so a replay, or a
     * second attempt after a lost response, lands at most one.
     */
    onRecordExecutionFee: async (values: ActualHandoverCost) => {
      const intent = `record-execution-fee:${applicationId}`;
      try {
        await recordExecutionFeeActual({
          orgId,
          applicationId,
          actualAmountMinor: values.actualAmountMinor,
          expectedCurrency: values.currency,
          // Out of custody cash, like every handover cost the UI records
          // (owner ruling 2026-09-28, SCRUM-439).
          paidBy: "EMPLOYEE",
          paidAt: values.paidAt,
          receiptReference: values.receiptReference,
          idempotencyKey: commandId.for(intent),
        });
        commandId.retire(intent);
        toast.success(t("ExecutionFeeRecorded"));
      } catch (error) {
        const outcome = isConvexError(error) ? "REFUSED" : "UNKNOWN";
        if (outcome === "REFUSED") commandId.retire(intent);
        throw new HandoverCostAttemptError(getErrorMessage(error), outcome);
      }
    },
    onAbandonExecutionFee: () => {
      commandId.retire(`record-execution-fee:${applicationId}`);
    },
    // Linking and unlinking set a marker on one named line: a replay
    // converges, so neither carries an idempotency key.
    onLinkExecutionFee: async (feeId: string) => {
      try {
        await bindExecutionFeeLine({ orgId, feeId: feeId as Id<"financeDealFees"> });
        toast.success(t("ExecutionFeeLinked"));
      } catch (error) {
        throw new Error(getErrorMessage(error));
      }
    },
    onUnlinkExecutionFee: async (feeId: string, reason: string) => {
      try {
        await unbindExecutionFeeLine({ orgId, feeId: feeId as Id<"financeDealFees">, reason });
        toast.success(t("ExecutionFeeUnlinked"));
      } catch (error) {
        throw new Error(getErrorMessage(error));
      }
    },
    onRecordDirectPayment: async (feeId: string, values: DirectHandoverPayment) => {
      const intent = `record-direct-payment:${applicationId}:${feeId}:${values.intentId}`;
      try {
        await recordDirectFeePayment({
          orgId,
          feeId: feeId as Id<"financeDealFees">,
          method: values.method,
          // SCRUM-54: the physical bank, frozen in the form's attempt so a replay sends the same one.
          ...(values.bankAccountId ? { bankAccountId: values.bankAccountId } : {}),
          paidAt: values.paidAt,
          // The amount the operator saw when they chose to pay: the
          // server refuses if the line has changed since (R1).
          expectedAmountMinor: values.expectedAmountMinor,
          reference: values.reference,
          idempotencyKey: commandId.for(intent),
        });
        commandId.retire(intent);
        toast.success(t("DirectPaymentSaved"));
      } catch (error) {
        // The server's own refusal rolled the mutation back: nothing
        // committed, so the identity is released. Anything else is a lost
        // response — the payment may exist, and the form replays it.
        const outcome = isConvexError(error) ? "REFUSED" : "UNKNOWN";
        if (outcome === "REFUSED") commandId.retire(intent);
        throw new HandoverCostAttemptError(getErrorMessage(error), outcome);
      }
    },
    onAbandonDirectPayment: (feeId: string, intentId: string) => {
      commandId.retire(`record-direct-payment:${applicationId}:${feeId}:${intentId}`);
    },
    onRecordActual: async (feeId: string, values: ActualHandoverCost) => {
      try {
        await recordActualFeeAmount({
          orgId,
          feeId: feeId as Id<"financeDealFees">,
          // REQUIRED: the LINE's stored currency, which the amount was
          // scaled at — never the org's current one.
          expectedCurrency: values.currency,
          actualAmountMinor: values.actualAmountMinor,
          paidAt: values.paidAt,
          receiptReference: values.receiptReference,
        });
        toast.success(t("HandoverCostSaved"));
      } catch (error) {
        throw new Error(getErrorMessage(error));
      }
    },
    onVoid: async (feeId: string, reason: string) => {
      try {
        await voidDealFee({ orgId, feeId: feeId as Id<"financeDealFees">, reason });
        toast.success(t("HandoverCostRemoved"));
      } catch (error) {
        throw new Error(getErrorMessage(error));
      }
    },
    onReconcile: async (
      feeId: string,
      notes: string,
      expectedActualAmountMinor: number,
      expectedActualEvidenceRevision: number
    ) => {
      try {
        await reconcileDealFee({
          orgId,
          feeId: feeId as Id<"financeDealFees">,
          notes,
          // The figure and evidence the checker was looking at: the server refuses if either moved.
          expectedActualAmountMinor,
          expectedActualEvidenceRevision,
        });
        toast.success(t("HandoverCostReconciled"));
      } catch (error) {
        throw new Error(getErrorMessage(error));
      }
    },
  };
}
