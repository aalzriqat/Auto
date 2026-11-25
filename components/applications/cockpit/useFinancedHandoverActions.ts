import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { closingReadinessRefusalOf } from "@/lib/closingReadinessReasonCodes";
import { getErrorMessage, isConvexError } from "@/lib/errors";
import { closingReasonText } from "./DealClosingReadinessList";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import {
  handoverReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

type Handover = NonNullable<DealCockpitViewProps["handover"]>;
type GapActions = Pick<
  NonNullable<DealCockpitViewProps["gapResolution"]>,
  "resolving" | "submitting" | "onOpenChange" | "onSubmit"
>;

export function useFinancedHandoverActions({
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
  const registerVehicleHandover = useMutation(
    api.applications.registerVehicleHandover,
  );
  const resolveAppraisalGap = useMutation(
    api.financingEconomics.resolveAppraisalGap,
  );
  const [confirmingHandover, setConfirmingHandover] = useState(false);
  const [handoverSubmitting, setHandoverSubmitting] = useState(false);
  const [resolvingGap, setResolvingGap] = useState(false);
  const [gapSubmitting, setGapSubmitting] = useState(false);

  const gap: GapActions = {
    resolving: resolvingGap,
    submitting: gapSubmitting,
    onOpenChange: setResolvingGap,
    /**
     * RETHROWS, for the reason the handover submit documents: the refusal
     * belongs to the attempt that earned it, and the server's messages
     * name the figure that did not reconcile — the only thing that tells
     * the operator which of five boxes to change.
     */
    onSubmit: async (values) => {
      setGapSubmitting(true);
      try {
        await trackRecorded(
          () =>
            resolveAppraisalGap({
              orgId,
              applicationId,
              // The stamp the DIALOG snapshotted when it opened, passed straight
              // through. Re-reading it from `deal` here would undo that
              // snapshot and hand the server a revision the operator never saw.
              economicsStamp: values.economicsStamp ?? "",
              customerGapShareMinor: values.customerGapShareMinor,
              dealerGapShareMinor: values.dealerGapShareMinor,
              customerGapCashToDealerMinor: values.customerGapCashToDealerMinor,
              customerGapInstallmentToDealerMinor:
                values.customerGapInstallmentToDealerMinor,
              customerGapToFinanceCompanyMinor:
                values.customerGapToFinanceCompanyMinor,
              // Present only for a SOURCED vehicle's concession (SCRUM-766
              // PR-C), together with the basis the operator saw.
              supplierGapShareMinor: values.supplierGapShareMinor,
              observedSupplierEntitlementMinor:
                values.observedSupplierEntitlementMinor,
              observedSupplierName: values.observedSupplierName,
              observedSupplierId: values.observedSupplierId,
              notes: values.notes || undefined,
            }),
          "GapResolved",
        );
        setResolvingGap(false);
      } catch (error) {
        const message = getErrorMessage(error);
        toast.error(message);
        throw new Error(message);
      } finally {
        setGapSubmitting(false);
      }
    },
  };
  const handover: Handover = {
    confirming: confirmingHandover,
    submitting: handoverSubmitting,
    onOpenChange: setConfirmingHandover,
    /**
     * RETHROWS. The refusal belongs to the attempt that earned it, and the
     * attempt lives in the dialog — holding it here is what let a stale
     * "the figures changed" message survive into a freshly opened
     * confirmation about a different revision.
     */
    onSubmit: async (values) => {
      setHandoverSubmitting(true);
      try {
        await trackRecorded(
          () =>
            registerVehicleHandover({
              orgId,
              applicationId,
              notes: values.notes,
              // The stamp the dialog was OPENED against, passed straight
              // through. Not re-read from `deal` here — that would undo the
              // snapshot the dialog took and restore the race it closes.
              economicsStamp: values.economicsStamp,
            }),
          "HandoverRegistered",
          { reflectedWhen: handoverReflected },
        );
        setConfirmingHandover(false);
      } catch (error) {
        // Handover and finalization share the coded first-payment refusals.
        const refusal = isConvexError(error) ? closingReadinessRefusalOf(error.data) : null;
        const message = refusal
          ? closingReasonText(t, refusal.code, refusal.params, refusal.message).text
          : getErrorMessage(error);
        toast.error(message);
        throw new Error(message);
      } finally {
        setHandoverSubmitting(false);
      }
    },
  };

  return { gap, handover };
}
