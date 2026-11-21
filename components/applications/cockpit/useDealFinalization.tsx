import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ProfitApprovalNotice,
  useProfitApproval,
} from "@/components/sales/ProfitApprovalNotice";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage, isConvexError } from "@/lib/errors";
import { closingReadinessRefusalOf } from "@/lib/closingReadinessReasonCodes";
import { closingReasonText } from "./DealClosingReadinessList";
import type { useRecordedFeedback } from "./recordedFeedback";

export function useDealFinalization({
  orgId,
  applicationId,
  vehicleId,
  quote,
  canCloseDeal,
  canViewVehicles,
  loading,
  finalizeReadinessHoldKey,
  trackRecorded,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  vehicleId?: Id<"vehicles">;
  quote?: Readonly<{ mode?: string; vehiclePrice?: number }> | null;
  canCloseDeal: boolean;
  canViewVehicles: boolean;
  loading: boolean;
  finalizeReadinessHoldKey?: string;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
  t: (key: string) => string;
}>) {
  const finalizeDeal = useMutation(api.applications.finalizeDeal);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [finalizeSubmitting, setFinalizeSubmitting] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // Retain the finalize request's key through retries: the
  // operation this key protects creates the sale and posts its journals.
  const finalizeKeyRef = useRef<string | null>(null);
  // SCRUM-260: finalizing sells at the quote's price, so that is the price
  // whose minimum-profit approval `completeSale` re-proves. A change to the
  // car's list price or minimum after the quote needs a fresh approval, and
  // this is where the operator can ask for it.
  const finalizeSalePrice = quote?.vehiclePrice ?? 0;
  const finalizeProfitApproval = useProfitApproval({
    orgId,
    vehicleId,
    salePrice: finalizeSalePrice,
    // Only the finalizer acts on it, and the status read needs VIEW_VEHICLES: a
    // viewer without both must not subscribe, or the thrown read takes the
    // whole cockpit down. completeSale still re-proves the rule server-side.
    enabled:
      canCloseDeal && canViewVehicles && !!quote && quote.mode !== "CASH",
    // SCRUM-659: a CASH deal still cannot close on a deleted car.
    livenessOnly:
      canCloseDeal && canViewVehicles && !!quote && quote.mode === "CASH",
    loading,
  });

  return {
    onStart: () => {
      setFinalizeError(null);
      setConfirmingFinalize(true);
    },
    confirmation: {
      confirming: confirmingFinalize,
      submitting: finalizeSubmitting,
      error: finalizeError,
      onOpenChange: setConfirmingFinalize,
      profitApproval: {
        blocked: finalizeProfitApproval.blocked,
        notice: <ProfitApprovalNotice approval={finalizeProfitApproval} />,
      },
      // The dialog outlives the READY verdict it was opened on (S414-R3-1):
      // it names the current reason and its confirm is disabled meanwhile.
      readinessHold: finalizeReadinessHoldKey
        ? t(finalizeReadinessHoldKey)
        : null,
      onSubmit: async () => {
        // Same predicate as the offer, checked again at the moment of the
        // write: nothing reaches `finalizeDeal` without a loaded READY verdict.
        if (finalizeReadinessHoldKey !== undefined) return;
        setFinalizeSubmitting(true);
        setFinalizeError(null);
        try {
          // ONE key per finalize attempt, minted on the first try and reused
          // by every retry after it. A finalize that runs twice is not a UI
          // glitch — it is a second sale, a second set of journals and a
          // second inventory movement for one car. Cleared only once the
          // server has confirmed, so a lost response retries the SAME
          // operation rather than starting a new one.
          finalizeKeyRef.current ??= `finalize-deal:${crypto.randomUUID()}`;
          const finalizeKey = finalizeKeyRef.current;
          await trackRecorded(
            () =>
              finalizeDeal({
                orgId,
                applicationId,
                idempotencyKey: finalizeKey,
              }),
            "DealFinalizedSuccess",
            // No `reflectedWhen`, on purpose: finalizing navigates to the
            // sale's own deal page and this cockpit unmounts, taking a held
            // line with it. The outcome is said at once, as cancel says it.
          );
          finalizeKeyRef.current = null;
          setConfirmingFinalize(false);
        } catch (error) {
          // Deliberately keeps the key: every refusal here is actionable and
          // names what to change — an unrecorded settlement route, missing
          // economics, an unresolved عربون — so the next attempt is the same
          // finalize with the same key, not a second one. A closing-readiness
          // refusal carries a code + params (SCRUM-414), translated exactly as
          // the readiness panel translates it; anything else keeps its message.
          const refusal = isConvexError(error)
            ? closingReadinessRefusalOf(error.data)
            : null;
          const message = refusal
            ? closingReasonText(
                t,
                refusal.code,
                refusal.params,
                refusal.message,
              ).text
            : getLocalizedErrorMessage(error, t);
          setFinalizeError(message);
          toast.error(message);
        } finally {
          setFinalizeSubmitting(false);
        }
      },
    },
  };
}
