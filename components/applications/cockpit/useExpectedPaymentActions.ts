import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { FunctionReturnType } from "convex/server";
import {
  expectedPaymentReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

export function useExpectedPaymentActions({
  orgId,
  applicationId,
  deal,
  trackRecorded,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
  t: (key: string) => string;
}>) {
  const registerExpectedPayment = useMutation(
    api.applications.registerExpectedPayment,
  );
  const correctExpectedPayment = useMutation(
    api.applications.correctExpectedPayment,
  );
  const attestChequeFace = useMutation(api.applications.attestChequeFace);
  const [registeringPayment, setRegisteringPayment] = useState(false);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const payment: NonNullable<DealCockpitViewProps["expectedPayment"]> = {
    registering: registeringPayment,
    submitting: paymentSubmitting,
    error: paymentError,
    onOpenChange: (open) => {
      // Every way in (rail or cheque panel) opens a fresh form, never one
      // still carrying a previous attempt's refusal.
      if (open) setPaymentError(null);
      setRegisteringPayment(open);
    },
    onSubmit: async (values) => {
      setPaymentSubmitting(true);
      setPaymentError(null);
      try {
        await trackRecorded(
          () => registerExpectedPayment({ orgId, applicationId, ...values }),
          "ExpectedPaymentRegisteredSuccess",
          { reflectedWhen: expectedPaymentReflected },
        );
        setRegisteringPayment(false);
      } catch (error) {
        const message = getErrorMessage(error);
        setPaymentError(message);
        toast.error(message);
      } finally {
        setPaymentSubmitting(false);
      }
    },
  };
  const cheque: NonNullable<DealCockpitViewProps["fcCheque"]> = {
    onAttest: async (faceAmount, note) => {
      const chequeId =
        deal && "unattestedChequeId" in deal ? deal.unattestedChequeId : null;
      // Nothing to write to: refuse loudly so the dialog stays open and shows
      // the error instead of closing as if the face had been recorded.
      if (!chequeId) throw new Error(t("UnexpectedError"));
      await attestChequeFace({ orgId, chequeId, faceAmount, note });
      toast.success(t("FcAttestDone"));
    },
    onCorrect: async (reason) => {
      await correctExpectedPayment({ orgId, applicationId, reason });
      toast.success(t("FcCorrectExpectedPaymentDone"));
    },
  };

  return { payment, cheque };
}
