import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import type { CommandIdentity } from "@/hooks/useCommandIdentity";
import { usePendingDepositPayouts } from "@/hooks/usePendingDepositPayouts";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { DealDeposit } from "./StoppedDealDepositsPanel";
import {
  depositReleaseReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

type DepositActions = Pick<
  NonNullable<DealCockpitViewProps["deposits"]>,
  "resolvingId" | "unconfirmed" | "onDismissUnconfirmed" | "onResolve"
>;

export function useStoppedDealDepositActions({
  orgId,
  commandId,
  app,
  canResolveDeposits,
  trackRecorded,
}: Readonly<{
  orgId: Id<"organizations">;
  commandId: CommandIdentity;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  canResolveDeposits: boolean;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
}>): DealCockpitViewProps["deposits"] {
  const releaseDeposit = useMutation(api.deposits.release);
  const [resolvingId, setResolvingDepositId] = useState<string | null>(null);
  // The server's release counter distinguishes a retry from a new payout with
  // the same inputs (SCRUM-313). Keep uncertain attempts until confirmed or
  // explicitly dismissed (SCRUM-469).
  const pendingPayouts = usePendingDepositPayouts(commandId.retire);

  const applicationDeposits: DealDeposit[] = (app?.deposits ?? []).map(
    (deposit) => ({
      _id: deposit._id,
      amount: deposit.amount,
      status: deposit.status,
      method: deposit.method,
      currency: deposit.currency,
      releasedAmountMinor: deposit.releasedAmountMinor,
      releaseCount: deposit.releaseCount,
    }),
  );
  const showApplicationDeposits =
    app != null &&
    (app.status === "REJECTED" || app.status === "CANCELLED") &&
    applicationDeposits.length > 0;
  /**
   * Whether a deposit's FACE value is what `deposits.release` would actually
   * pay out — the only case in which this screen may put that figure on an
   * irreversible confirmation.
   *
   * The server releases the FREE part of the row: face value less what a live
   * sale has applied, what is still assigned to a car on the deal, what was
   * released for its own decision, and what was already paid out. Those live
   * in holds and applications the deal payload does not carry, so the answer
   * is read from the server's own allocation summary
   * (`deposits.quoteAllocation`) rather than reconstructed here. Any money in
   * any of those buckets, on any deposit of the quote, and the action is
   * withheld with a reason — the deposit manager on the vehicle is the surface
   * that resolves shares and remainders exactly. Conservative on purpose: the
   * cost of withholding is a pointer, the cost of over-offering is an operator
   * authorising 5,000 while 2,000 moves.
   */
  const allocation = useQuery(
    api.deposits.quoteAllocation,
    showApplicationDeposits && app?.quoteId
      ? { orgId, quoteId: app.quoteId }
      : "skip",
  );
  const quoteHasCommittedMoney =
    allocation === undefined ||
    allocation === null ||
    allocation.isMultiVehicle ||
    allocation.allocatedMinor > 0 ||
    allocation.appliedMinor > 0 ||
    allocation.reversingMinor > 0 ||
    allocation.releasedAwaitingDecisionMinor > 0 ||
    allocation.refundedMinor > 0 ||
    allocation.forfeitedMinor > 0 ||
    allocation.otherFinalizedMinor > 0;

  const onResolve: DepositActions["onResolve"] = async (
    depositId,
    resolution,
    refundMethod,
    observedReleaseCount,
    bankAccountId,
  ) => {
    const method = resolution === "REFUNDED" ? refundMethod : "NONE";
    // A DIFFERENT decision than an unconfirmed earlier attempt is not
    // sent: it would mint a new key and could pay out twice. The panel
    // shows the reconciliation notice instead.
    const gate = pendingPayouts.check(
      depositId,
      resolution,
      String(method),
      bankAccountId,
    );
    if (gate.status === "blocked") return;
    const releaseIntent =
      gate.recordedIntent ??
      `release-deposit:${depositId}:${resolution}:${method}:${bankAccountId ?? "none"}:gen${observedReleaseCount}`;
    pendingPayouts.record(depositId, {
      resolution,
      method: String(method),
      bankAccountId,
      intent: releaseIntent,
    });
    setResolvingDepositId(depositId);
    try {
      await trackRecorded(
        () =>
          releaseDeposit({
            orgId,
            depositId: depositId as Id<"deposits">,
            resolution,
            refundMethod: resolution === "REFUNDED" ? refundMethod : undefined,
            bankAccountId,
            idempotencyKey: commandId.for(releaseIntent),
          }),
        resolution === "REFUNDED"
          ? "DepositRefundedSuccess"
          : "DepositForfeitedSuccess",
        // The deposit's own release counter moved past the one the
        // dialog observed; nothing else on the deal proves it.
        {
          reflectedWhen: depositReleaseReflected(
            depositId,
            observedReleaseCount,
          ),
        },
      );
      commandId.retire(releaseIntent);
      pendingPayouts.confirm(depositId);
    } catch (error) {
      pendingPayouts.settleFailure(depositId, error, releaseIntent);
      toast.error(getErrorMessage(error));
      throw error;
    } finally {
      setResolvingDepositId(null);
    }
  };

  return showApplicationDeposits
    ? {
        items: applicationDeposits,
        canResolve: canResolveDeposits,
        faceValueIsReleasable: !quoteHasCommittedMoney,
        resolvingId,
        unconfirmed: pendingPayouts.blocked,
        onDismissUnconfirmed: pendingPayouts.dismiss,
        onResolve,
      }
    : undefined;
}
