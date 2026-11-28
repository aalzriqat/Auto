import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { getLocalizedErrorMessage } from "@/lib/errors";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";

type CancellableStatus = "PENDING" | "COMPLETED";

/**
 * One operator's confirmation, together with the facts it was given under: the
 * sale it belongs to and the status (draft or completed) the warning showed.
 * It counts only while both still match what is on screen (SCRUM-1034).
 */
type Attempt = Readonly<{
  /** `orgId:saleId`, the same identity the sibling `correctingDraft` state is checked against. */
  key: string;
  /** The status whose warning the operator read when they opened the dialog. */
  status: CancellableStatus;
  submitting: boolean;
  error: string | null;
}>;

/** Closing drops this sale's confirmation only; another sale's is left as it is. */
function closeIfMine(current: Attempt | null, key: string): Attempt | null {
  return current?.key === key ? null : current;
}

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
 * SCRUM-1034: the dialog state is one `Attempt` that carries the sale and the
 * status it was opened under, and it is rendered only while both still match
 * (derived during render, as React advises, not synchronised by an effect):
 * - another sale on this mounted instance: the old dialog and error are inert;
 * - the status changed while the dialog was open and nothing is in flight (a
 *   draft completed elsewhere): the confirmation is closed and the operator is
 *   told, so they reopen and read the warning that now applies;
 * - the status changed while the request is in flight: the request cannot be
 *   called back, so the dialog stays on the warning that was confirmed until the
 *   server answers.
 *
 * Returns undefined when the action must not be offered, so the header renders
 * no button and the view mounts no dialog.
 */
export function useCancelCashDeal({
  orgId,
  saleId,
  status,
  canCancel,
}: Readonly<{
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  /** The sale's status as the deal screen read it; only PENDING and COMPLETED are cancellable. */
  status: string | undefined;
  /** The caller holds edit:sales AND approve:requests (the two the server demands). */
  canCancel: boolean;
}>): DealCockpitViewProps["cashCancel"] {
  const { t } = useLanguage();
  const updateSale = useMutation(api.sales.update);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [notice, setNotice] = useState<Readonly<{ message: string }> | null>(null);
  // A ref, not the state: two clicks in the same tick both see `submitting === false`.
  // Holds the sale whose request is in flight, so another sale is not blocked by it.
  const inFlight = useRef<string | null>(null);

  const key = `${orgId}:${saleId}`;
  const offered: CancellableStatus | null =
    canCancel && (status === "PENDING" || status === "COMPLETED") ? status : null;
  const mine = attempt?.key === key ? attempt : null;
  // A request already sent keeps its dialog; otherwise the confirmation stands only for its own status.
  const open = mine !== null && (mine.submitting || mine.status === offered);

  // Adjusting state while rendering, the pattern react.dev documents for state that depends on
  // props ("You Might Not Need an Effect"): a confirmation that no longer matches its sale or its
  // status is dropped before anything is committed, so it can never be clicked or reappear.
  if (attempt !== null && !attempt.submitting && !(attempt.key === key && attempt.status === offered)) {
    setAttempt(null);
    // The same sale, a different status: the operator must be told. The notice is a new object per
    // event so the effect below runs once for each, whatever its text.
    if (attempt.key === key && offered !== null) setNotice({ message: t("CancelDealChanged") });
  }
  // The only effect: showing the notice is a side effect on the outside world (a toast), which
  // render must not perform.
  useEffect(() => {
    if (notice !== null) toast.info(notice.message);
  }, [notice]);

  if (offered === null) return undefined;

  return {
    isCompleted: (open ? mine.status : offered) === "COMPLETED",
    confirming: open,
    submitting: open && mine.submitting,
    error: open ? mine.error : null,
    onOpenChange: (next: boolean) => {
      if (inFlight.current === key) return; // the request cannot be called back, so the dialog stays until it answers
      setAttempt((current) => (next ? { key, status: offered, submitting: false, error: null } : closeIfMine(current, key)));
    },
    onSubmit: async () => {
      // Only a confirmation that is on screen can be acted on.
      if (!open || inFlight.current === key) return;
      inFlight.current = key;
      const confirmed = mine.status;
      setAttempt({ key, status: confirmed, submitting: true, error: null });
      try {
        await updateSale({ orgId, saleId, status: "CANCELLED" });
        toast.success(t("CancelDealSuccess"));
        setAttempt((current) => (current?.key === key ? null : current));
      } catch (error_) {
        // A coded refusal is shown in the user's language; any other is the
        // server's own text (or the generic message), unchanged.
        const message = getLocalizedErrorMessage(error_, t);
        setAttempt((current) =>
          current?.key === key ? { key, status: confirmed, submitting: false, error: message } : current,
        );
      } finally {
        if (inFlight.current === key) inFlight.current = null;
      }
    },
  };
}
