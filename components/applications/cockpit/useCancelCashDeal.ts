import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage } from "@/lib/errors";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";

/**
 * Cancel a CASH deal from its own screen (SCRUM-969).
 *
 * The request is exactly the one the Sales page sends for a cancellation:
 * `sales.update({ orgId, saleId, status: "CANCELLED" })`. The server alone
 * decides whether it may happen (edit:sales + approve:requests, a different actor
 * from the salesperson, no linked application, the customer-credit disposition of
 * a completed sale); this hook only shows the caller's answer. It does not
 * refresh anything by hand: the deal screen is a live query, so a cancelled sale
 * reads back as CANCELLED on its own and the action disappears.
 *
 * Returns undefined when the action must not be offered, so the header renders
 * no button and the view mounts no dialog.
 */
export function useCancelCashDeal({
  orgId,
  saleId,
  status,
  canCancel,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  /** The sale's status as the deal screen read it; only PENDING and COMPLETED are cancellable. */
  status: string | undefined;
  /** The caller holds edit:sales AND approve:requests (the two the server demands). */
  canCancel: boolean;
  t: (key: string) => string;
}>): DealCockpitViewProps["cashCancel"] {
  const updateSale = useMutation(api.sales.update);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not the state: two clicks in the same tick both see `submitting === false`.
  const inFlight = useRef(false);

  if (!canCancel || (status !== "PENDING" && status !== "COMPLETED")) return undefined;

  return {
    isCompleted: status === "COMPLETED",
    confirming,
    submitting,
    error,
    onOpenChange: (next: boolean) => {
      if (inFlight.current) return; // the request cannot be called back, so the dialog stays until it answers
      setConfirming(next);
      if (next) setError(null);
    },
    onSubmit: async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setSubmitting(true);
      setError(null);
      try {
        await updateSale({ orgId, saleId, status: "CANCELLED" });
        toast.success(t("CancelDealSuccess"));
        setConfirming(false);
      } catch (caught) {
        // A coded refusal is shown in the user's language; any other is the
        // server's own text (or the generic message), unchanged.
        setError(getLocalizedErrorMessage(caught, t));
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
  };
}
