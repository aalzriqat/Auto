import { useState } from "react";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import { SettlementAdviceCorrectionDialog } from "./SettlementAdviceCorrectionDialog";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { useDealMoneyPresentation } from "./useDealMoneyPresentation";

type AdviceAmounts = Pick<
  ReturnType<typeof useDealMoneyPresentation>,
  "discrepancy" | "discrepancyFactor" | "adviceRecordedLabel" | "adviceApprovedLabel"
>;

export function useDealAdviceCorrection(
  onCorrectSettlementAdvice: DealCockpitViewProps["onCorrectSettlementAdvice"],
  t: (key: string) => string,
) {
  const [correctingAdvice, setCorrectingAdvice] = useState(false);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);

  const handleCorrectAdvice = async (correction: {
    amountMajor: number;
    reference?: string;
    disbursedAt?: number;
    reason: string;
  }) => {
    if (!onCorrectSettlementAdvice) return;
    setCorrectionSubmitting(true);
    try {
      await onCorrectSettlementAdvice(correction);
      // Deliberately not "corrected" or "resolved". The server re-derives the
      // reconciliation state from the evidence, so a correction that still
      // disagrees leaves the deal flagged — and a toast claiming otherwise
      // would be the screen telling the operator a discrepancy is closed when
      // the strip above it still says it is open. The strip is the answer.
      toast.success(t("SettlementAdviceCorrectionSaved"));
      setCorrectingAdvice(false);
    } catch (error) {
      // The server's refusals here name the thing to change: a reason too
      // short, an advice that was never recorded, a future date. Replacing them
      // with "an unexpected error occurred" turns the one recovery path this
      // state has into a dead end.
      toast.error(getErrorMessage(error));
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  function renderDialog({
    discrepancy,
    discrepancyFactor,
    adviceRecordedLabel,
    adviceApprovedLabel,
  }: AdviceAmounts, offered: boolean) {
    if (!discrepancy || !offered) return null;
    return (
      <SettlementAdviceCorrectionDialog
        open={correctingAdvice}
        submitting={correctionSubmitting}
        recordedMajor={
          discrepancy.recordedMinor != null
            ? discrepancy.recordedMinor / discrepancyFactor
            : null
        }
        recordedReference={discrepancy.recordedReference ?? null}
        recordedAt={discrepancy.recordedAt ?? null}
        recordedLabel={adviceRecordedLabel}
        approvedLabel={adviceApprovedLabel}
        t={t}
        onOpenChange={setCorrectingAdvice}
        onCorrect={handleCorrectAdvice}
      />
    );
  }

  return { open: () => setCorrectingAdvice(true), renderDialog };
}
