import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage } from "@/lib/errors";
import type { CreditDecision } from "./CreditDecisionDialog";
import {
  creditStatusReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

export type FinancedCreditStatus =
  | "PENDING_DOCS"
  | "UNDER_REVIEW"
  | CreditDecision;

/** The toast for each credit-stage transition this screen can record. */
const CREDIT_STATUS_SUCCESS: Record<
  "PENDING_DOCS" | "UNDER_REVIEW" | "APPROVED" | "REJECTED",
  string
> = {
  PENDING_DOCS: "AppSubmittedForDocumentsSuccess",
  UNDER_REVIEW: "AppUnderReviewSuccess",
  APPROVED: "AppApprovedSuccess",
  REJECTED: "AppRejectedSuccess",
};

export function useFinancedCreditDecision({
  orgId,
  applicationId,
  trackRecorded,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
  t: (key: string) => string;
}>) {
  const updateStatus = useMutation(api.applications.updateStatus);
  const [decidingCredit, setDecidingCredit] = useState(false);
  const [creditSubmitting, setCreditSubmitting] = useState(false);
  const [creditError, setCreditError] = useState<string | null>(null);
  /**
   * `updateStatus` for the two dealership moves on the credit stage. Not
   * idempotency-keyed, exactly as in Review: the server refuses an illegal
   * transition, so a repeat is a refusal rather than a second effect.
   */
  async function recordCreditStatus(status: FinancedCreditStatus) {
    setCreditSubmitting(true);
    setCreditError(null);
    try {
      await trackRecorded(
        () => updateStatus({ orgId, applicationId, status }),
        CREDIT_STATUS_SUCCESS[status],
        {
          reflectedWhen: creditStatusReflected(status),
        },
      );
      setDecidingCredit(false);
    } catch (error) {
      // "You cannot approve your own application", an illegal transition —
      // each names what to change. Kept in the dialog so it belongs to the
      // attempt that earned it. Localised so a coded refusal (e.g. VEHICLE_DELETED) reads in the
      // user's language.
      const message = getLocalizedErrorMessage(error, t);
      setCreditError(message);
      toast.error(message);
    } finally {
      setCreditSubmitting(false);
    }
  }

  return {
    open: () => {
      setCreditError(null);
      setDecidingCredit(true);
    },
    recordCreditStatus,
    dialog: {
      deciding: decidingCredit,
      submitting: creditSubmitting,
      error: creditError,
      onOpenChange: setDecidingCredit,
      onSubmit: recordCreditStatus,
    },
  };
}
