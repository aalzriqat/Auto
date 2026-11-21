import { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { PreFinalizeForward } from "./usePreFinalizeForward";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage, isConvexError } from "@/lib/errors";
import type { CancelApplicationValues } from "./CancelApplicationDialog";
import type { UnwindFinishValues, UnwindStatusView } from "./UnwindDealDialog";

type CancelArguments = FunctionArgs<typeof api.applications.cancelApplication>;

export function useDealExitActions({
  orgId,
  applicationId,
  app,
  deal,
  preFinalizeForward,
  canApproveApplication,
  canCreateApplication,
  canCancelClosedDeal,
  canConfirmFinanceDisbursement,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  preFinalizeForward: PreFinalizeForward | undefined;
  canApproveApplication: boolean;
  canCreateApplication: boolean;
  canCancelClosedDeal: boolean;
  canConfirmFinanceDisbursement: boolean;
  t: (key: string) => string;
}>) {
  const applicationStatus = app?.status;
  const disbursedAt = app?.disbursedAt;
  // Mirror the backend permission tiers exactly.
  // SCRUM-413: a CLOSED deal is reversed with CANCEL_CLOSED_DEAL alone (no
  // create-application authority); every other status keeps create (+ approve
  // once APPROVED). A CLOSED deal is cancelled only on the server's own answer
  // (`mayCancelFinalized`: the same permission tiers AND the forward gate); no
  // answer yet means no Cancel, never a permission-only guess.
  // SCRUM-411 B1: an approved deal that already carries a payment to the finance company
  // cannot be cancelled either (the server refuses until it is taken back), so the
  // server's `blocksCancel` withholds Cancel before the close as `mayCancelFinalized` does after.
  const preFinalizeCancelBlocked =
    app?.status !== "CLOSED" && preFinalizeForward?.blocksCancel === true;
  const canCancel =
    app != null &&
    app.status !== "CANCELLED" &&
    (app.status === "CLOSED"
      ? // A recorded supplier payment bars bare cancellation just as the company's own payment does.
        canCancelClosedDeal &&
        deal?.forward?.mayCancelFinalized === true &&
        !app.disbursedAt &&
        !app.supplierDisbursementStatus
      : canCreateApplication &&
        (app.status === "APPROVED" ? canApproveApplication : true) &&
        !preFinalizeCancelBlocked);
  // The caller holds the cancel authority but the server still refuses: with no
  // disbursement authority the missing piece is a manager; with it, only the
  // forward gate is left, which is not a permission.
  const cancelHint: "MANAGER" | "FORWARD" | undefined =
    app?.status === "CLOSED" &&
    deal?.forward?.planV2 === true &&
    deal.forward.mayCancelFinalized !== true &&
    !app.disbursedAt &&
    !app.supplierDisbursementStatus &&
    canCancelClosedDeal
      ? canConfirmFinanceDisbursement
        ? "FORWARD"
        : "MANAGER"
      : preFinalizeCancelBlocked &&
          canCreateApplication &&
          canApproveApplication
        ? "FORWARD"
        : undefined;
  const cancelApplication = useMutation(api.applications.cancelApplication);
  const startDealUnwind = useMutation(api.dealUnwind.startDealUnwind);
  const recordDealUnwindForwardReturn = useMutation(
    api.dealUnwind.recordDealUnwindForwardReturn,
  );
  const finishDealUnwind = useMutation(api.dealUnwind.finishDealUnwind);
  const abandonDealUnwind = useMutation(api.dealUnwind.abandonDealUnwind);

  const [cancelling, setCancelling] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const unwindStatus = useQuery(
    api.dealUnwind.unwindStatus,
    applicationStatus === "CLOSED" ? { orgId, applicationId } : "skip",
  );
  // A closed deal's controls that an active unwind bars stay off until its status has been read.
  const unwindBars =
    applicationStatus === "CLOSED" &&
    (unwindStatus === undefined || unwindStatus.status === "ACTIVE");
  const [unwindOpen, setUnwindOpen] = useState(false);
  const [unwindSubmitting, setUnwindSubmitting] = useState(false);
  const [unwindError, setUnwindError] = useState<string | null>(null);
  const unwindKeyRef = useRef<string | null>(null);
  // The server's answer: a live unwind, or a paid deal whose start it would accept. Otherwise the
  // refusal is shown as a hint, so a paid deal is never left without an explanation.
  const unwindOffered =
    unwindStatus != null &&
    applicationStatus === "CLOSED" &&
    (unwindStatus.status === "ACTIVE" ||
      (!!disbursedAt && unwindStatus.eligibility.canStart)) &&
    // A viewer who may do none of it gets no button rather than a dialog of dead controls.
    Object.values(unwindStatus.eligibility).some(Boolean);
  const unwindHint =
    unwindStatus != null &&
    !unwindOffered &&
    applicationStatus === "CLOSED" &&
    !!disbursedAt
      ? unwindStatus.refusals.start
      : undefined;
  const runUnwind = async (
    step: string,
    success: string,
    call: (idempotencyKey: string) => Promise<unknown>,
  ): Promise<boolean> => {
    setUnwindSubmitting(true);
    setUnwindError(null);
    try {
      unwindKeyRef.current ??= `unwind-${step}:${applicationId}:${crypto.randomUUID()}`;
      await call(unwindKeyRef.current);
      unwindKeyRef.current = null;
      toast.success(t(success));
    } catch (error) {
      // A refusal is final for this attempt; a lost response keeps the key so a retry replays.
      if (isConvexError(error)) unwindKeyRef.current = null;
      const message = getLocalizedErrorMessage(error, t);
      setUnwindError(message);
      toast.error(message);
      return false;
    } finally {
      setUnwindSubmitting(false);
    }
    return true;
  };
  // A lost response retains the cancellation key so a retry is the same reversal.
  const cancelKeyRef = useRef<string | null>(null);

  const unwind =
    applicationStatus === "CLOSED" && unwindStatus
      ? {
          status: unwindStatus as UnwindStatusView,
          offered: unwindOffered,
          hint: unwindHint
            ? { code: unwindHint.code, message: unwindHint.message }
            : undefined,
          open: unwindOpen,
          submitting: unwindSubmitting,
          error: unwindError,
          notBefore: disbursedAt,
          onOpenChange: (next: boolean) => {
            setUnwindOpen(next);
            if (next) setUnwindError(null);
            // A closed dialog ends its attempt: its key is retired so a later one starts clean.
            else unwindKeyRef.current = null;
          },
          onStart: async (reason: string) => {
            await runUnwind("start", "UnwindStartedSuccess", (idempotencyKey) =>
              startDealUnwind({ orgId, applicationId, reason, idempotencyKey }),
            );
          },
          onForwardReturn: async (values: {
            returnedAt: number;
            reference: string;
          }) => {
            await runUnwind(
              "forward",
              "UnwindForwardRecordedSuccess",
              (idempotencyKey) =>
                recordDealUnwindForwardReturn({
                  orgId,
                  unwindId: unwindStatus.unwindId!,
                  returnedAt: values.returnedAt,
                  reference: values.reference,
                  idempotencyKey,
                }),
            );
          },
          onFinish: async (values: UnwindFinishValues) => {
            const done = await runUnwind(
              "finish",
              "UnwindFinishedSuccess",
              (idempotencyKey) =>
                finishDealUnwind({
                  orgId,
                  unwindId: unwindStatus.unwindId!,
                  ...values,
                  idempotencyKey,
                }),
            );
            if (done) setUnwindOpen(false);
          },
          onAbandon: async (reason: string) => {
            const done = await runUnwind(
              "abandon",
              "UnwindAbandonedSuccess",
              (idempotencyKey) =>
                abandonDealUnwind({
                  orgId,
                  unwindId: unwindStatus.unwindId!,
                  reason,
                  idempotencyKey,
                }),
            );
            if (done) setUnwindOpen(false);
          },
        }
      : undefined;

  return {
    unwindBars,
    unwind,
    cancelHint,
    cancel: canCancel
      ? {
          isClosed: applicationStatus === "CLOSED",
          confirming: cancelling,
          submitting: cancelSubmitting,
          error: cancelError,
          onOpenChange: setCancelling,
          onSubmit: async (values: CancelApplicationValues) => {
            setCancelSubmitting(true);
            setCancelError(null);
            try {
              cancelKeyRef.current ??= `cancel-application:${crypto.randomUUID()}`;
              await cancelApplication({
                orgId,
                applicationId,
                reason: values.reason,
                failureReason:
                  values.failureReason as CancelArguments["failureReason"],
                appraisalFeeResponsibility:
                  values.appraisalFeeResponsibility as CancelArguments["appraisalFeeResponsibility"],
                appraisalFeeResponsibilityReason:
                  values.appraisalFeeResponsibilityReason,
                idempotencyKey: cancelKeyRef.current,
              });
              cancelKeyRef.current = null;
              toast.success(t("AppCancelledSuccess"));
              setCancelling(false);
            } catch (error) {
              // "Disbursement funds already confirmed received" is the one
              // refusal an operator can do nothing about here; it says so.
              const message = getLocalizedErrorMessage(error, t);
              setCancelError(message);
              toast.error(message);
            } finally {
              setCancelSubmitting(false);
            }
          },
        }
      : undefined,
  };
}
