import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandIdentity } from "@/hooks/useCommandIdentity";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, isConvexError } from "@/lib/errors";
import type { DealCustodyActions } from "./DealCustodyPanel";

type CustodyCommands = Pick<
  DealCustodyActions,
  | "onPlan"
  | "onClearPlan"
  | "onOpen"
  | "onMove"
  | "onReverse"
  | "onAttach"
  | "onClose"
  | "onReopen"
  | "onAbandonOpen"
  | "onAbandonMove"
  | "onAbandonClose"
>;

export function useDealCustodyActions({
  orgId,
  applicationId,
  commandId,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  commandId: CommandIdentity;
  t: (key: string) => string;
}>): CustodyCommands {
  const planCustodyHandler = useMutation(api.financeDealCosts.planCustodyHandler);
  const openDealCustody = useMutation(api.financeDealCosts.openDealCustody);
  const recordCustodyMovement = useMutation(api.financeDealCosts.recordCustodyMovement);
  const setFeeCustody = useMutation(api.financeDealCosts.setFeeCustody);
  const reconcileDealCustody = useMutation(api.financeDealCosts.reconcileDealCustody);
  const reopenDealCustody = useMutation(api.financeDealCosts.reopenDealCustody);

  // One intent per dialog attempt. The deal, record and kind are named for
  // legibility only; the attempt's `intentId` is what makes it one command.
  const openCustodyIntent = (intentId: string) => `open-custody:${applicationId}:${intentId}`;
  const custodyMoveIntent = (custodyId: string, kind: string, intentId: string) => `custody-move:${custodyId}:${kind}:${intentId}`;
  const custodyCloseIntent = (custodyId: string, intentId: string) => `custody-close:${custodyId}:${intentId}`;
  const custodyCommand = async (intent: string, work: (idempotencyKey: string) => Promise<unknown>) => {
    try {
      await work(commandId.for(intent));
      commandId.retire(intent);
      toast.success(t("CustodySaved"));
    } catch (error) {
      // The server's own refusal rolled back and nothing committed: the next
      // attempt is a new command. Anything else may have landed; keep the key.
      if (isConvexError(error)) commandId.retire(intent);
      throw new Error(getErrorMessage(error));
    }
  };
  const custodyPlain = async (work: () => Promise<unknown>) => {
    try {
      await work();
      toast.success(t("CustodySaved"));
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  };

  return {
    onPlan: (values) =>
      custodyPlain(() =>
        planCustodyHandler({
          orgId,
          applicationId,
          userId: values.userId,
          amountMinor: values.amountMinor,
          note: values.note,
        })
      ),
    onClearPlan: () => custodyPlain(() => planCustodyHandler({ orgId, applicationId })),
    onOpen: (values) =>
      custodyCommand(openCustodyIntent(values.intentId), (idempotencyKey) =>
        openDealCustody({
          orgId,
          applicationId,
          userId: values.userId,
          issuedMinor: values.amountMinor,
          method: values.method,
          ...(values.bankAccountId ? { bankAccountId: values.bankAccountId } : {}),
          reference: values.reference,
          note: values.note,
          occurredAt: values.occurredAt,
          idempotencyKey,
        })
      ),
    onMove: (custodyId, kind, values) =>
      custodyCommand(custodyMoveIntent(custodyId, kind, values.intentId), (idempotencyKey) =>
        recordCustodyMovement({
          orgId,
          custodyId,
          kind,
          amountMinor: values.amountMinor,
          method: values.method,
          ...(values.bankAccountId ? { bankAccountId: values.bankAccountId } : {}),
          reference: values.reference,
          note: values.note,
          occurredAt: values.occurredAt,
          idempotencyKey,
        })
      ),
    onReverse: (custodyId, movement, reason) =>
      custodyCommand(`custody-reverse:${custodyId}:${movement.entryId}`, (idempotencyKey) =>
        recordCustodyMovement({
          orgId,
          custodyId,
          kind: "REVERSAL",
          reversesEntryId: movement.entryId,
          amountMinor: movement.amountMinor,
          note: reason,
          idempotencyKey,
        })
      ),
    onAttach: (custodyId, feeId) =>
      custodyPlain(() =>
        setFeeCustody({ orgId, feeId, custodyId })
      ),
    onClose: (custodyId, values) =>
      // A closure is a command like a movement: it may post a write-off,
      // and a lost response must replay rather than refuse on the
      // closure it already made — so it carries a key the same way.
      custodyCommand(custodyCloseIntent(custodyId, values.intentId), (idempotencyKey) =>
        reconcileDealCustody({
          orgId,
          custodyId,
          notes: values.notes,
          writeOffReason: values.writeOffReason,
          idempotencyKey,
        })
      ),
    onReopen: (custodyId, reason) =>
      custodyPlain(() => reopenDealCustody({ orgId, custodyId, reason })),
    // The dialog was abandoned with its command not having succeeded:
    // its identity is over, so a later genuine command with the same
    // figures can never replay it.
    onAbandonOpen: (intentId) => commandId.retire(openCustodyIntent(intentId)),
    onAbandonMove: (custodyId, kind, intentId) => commandId.retire(custodyMoveIntent(custodyId, kind, intentId)),
    onAbandonClose: (custodyId, intentId) => commandId.retire(custodyCloseIntent(custodyId, intentId)),
  };
}
