"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { ArrowRight, AlertTriangle } from "lucide-react";

/**
 * The one question an operator is asked about a عربون at the end of a consigned
 * deal: does it form part of the final settlement?
 *
 * ## Why it is one question and not a menu of accounts
 *
 * Until this existed, `APPLY_TO_TRANSACTION_SETTLEMENT` had no client at all.
 * The `DIRECT_TO_SUPPLIER` route shipped, so a salesperson could say the buyer
 * paid the supplier directly — and then the sale was refused, with a message
 * advertising "applied to the supplier settlement", which no screen offered.
 * The only escape was refunding the customer's deposit, a materially different
 * financial outcome reached because the right one was unreachable.
 *
 * The fix is deliberately not a treatment picker. Which account the money lands
 * in is not the salesperson's decision and is not knowable from where they sit:
 * it follows from the settlement route, the supplier's entitlement and the
 * dealership's margin. So they confirm the one fact only they know — that this
 * money is part of this deal — and the server derives the rest. Every figure
 * below comes from `sales.consignedSalePreview`, which answers through the same
 * function the completion posts through, so what is shown here is what posts.
 *
 * ## What it deliberately does not render
 *
 * No journal, no account names, no debits and credits. And no option the server
 * would refuse: when the deposit cannot be treated this way the reason is shown
 * as a reason, not as a choice that fails on submit.
 */

interface Props {
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
  /** The line this decision is about — the عربون's share is per car. */
  vehicleId: Id<"vehicles">;
  settlementRoute: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
  /** THIS line's confirmation. Never a boolean shared with other lines. */
  value: boolean;
  onChange: (vehicleId: Id<"vehicles">, applied: boolean) => void;
  /**
   * Reported up whenever the server's answer for this line changes, so the
   * caller can decide what the QUOTE can be submitted as. The treatment is
   * quote-wide on the wire, so a caller has to know that one line refuses it
   * before letting the deal be submitted — and it has to know WHICH line, or
   * the operator gets a refusal with no address.
   */
  onEligibility?: (
    vehicleId: Id<"vehicles">,
    state: { canApply: boolean; required: boolean; reason: string | null; label: string }
  ) => void;
  disabled?: boolean;
}

export function DepositSettlementDecision({
  orgId,
  quoteId,
  vehicleId,
  settlementRoute,
  value,
  onChange,
  onEligibility,
  disabled,
}: Props) {
  const { t, isRtl } = useLanguage();

  // The same query, with the same arguments, that ConsignedSettlementSection
  // already subscribes to for this line — convex/react shares the subscription,
  // so this costs nothing extra and cannot show a different answer.
  const preview = useQuery(api.sales.consignedSalePreview, {
    orgId,
    vehicleId,
    quoteId,
    settlementRoute,
  });

  const deposit = preview?.depositSettlement ?? null;
  const canApply = deposit?.canApplyToSettlement ?? null;

  // Reported up so the caller knows what the whole quote can be submitted as.
  useEffect(() => {
    if (!preview || !deposit) return;
    onEligibility?.(vehicleId, {
      canApply: deposit.canApplyToSettlement,
      required: deposit.treatmentRequired,
      reason: deposit.blockedReason,
      label: preview.vehicleLabel,
    });
  }, [preview, deposit, vehicleId, onEligibility]);

  // A confirmation can outlive the thing it confirmed.
  //
  // The route is chosen in a sibling panel, so an operator can tick this on
  // THROUGH_DEALERSHIP (where the عربون fits the customer's bill), then correct
  // the route to DIRECT_TO_SUPPLIER (where it exceeds the margin). The checkbox
  // disappears and the refusal renders — but a surviving `true` would still be
  // submitted, and the sale refused for a reason the screen already displayed,
  // from a control no longer on it to untick.
  //
  // Scoped to THIS line's own confirmation. It was briefly a single boolean for
  // the whole quote, which meant an ineligible line silently unticked a box the
  // operator had just clicked on a DIFFERENT, perfectly eligible car — a
  // control that visibly does nothing, with the explanation attached to some
  // other car's panel.
  useEffect(() => {
    if (value && canApply === false) onChange(vehicleId, false);
  }, [value, canApply, onChange, vehicleId]);

  // `null` is dealer-owned stock or a line this preview cannot speak for;
  // `undefined` is "not answered yet". Neither should reserve space.
  //
  // No عربون on this quote is the same: there is nothing to decide, and
  // rendering an empty section is how operators learn to click past the ones
  // that matter.
  if (!preview || !deposit) return null;

  const money = (n: number) =>
    n.toLocaleString(isRtl ? "ar-JO" : "en-JO", { maximumFractionDigits: 2 });
  const supplier = preview.supplierName || t("TheSupplier" as any);
  const directToSupplier = preview.settlementRoute === "DIRECT_TO_SUPPLIER";

  return (
    <section
      className={cn(
        // Grouped by an accent edge and spacing rather than another rounded
        // card. This sits directly above the supplier-settlement panel, and a
        // third stacked box would read as three unrelated widgets instead of
        // one continuous account of where this deal's money is.
        "space-y-3 border-s-2 ps-4",
        deposit.treatmentRequired && !value ? "border-amber-500" : "border-border"
      )}
    >
      <header className="space-y-1">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("DepositSettlementTitle" as any)}
        </h4>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("DepositSettlementDesc" as any)}
        </p>
      </header>

      {/* Suppressed while the split is undecided. The server sends 0 there
          because no share exists yet, and rendering it read "Deposit held on
          this car — 0" directly above "this car's share has not been decided",
          which states a figure and then denies it. */}
      {deposit.allocationDecided && (
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-sm">{t("DepositSettlementHeldAmount" as any)}</span>
          <span className="text-base font-semibold tabular-nums">
            {money(deposit.depositAmount)}
          </span>
        </div>
      )}

      {!deposit.allocationDecided ? (
        // A share nobody has decided is not a number this screen may invent.
        <Note tone="warning">{t("DepositSettlementNotDecided" as any)}</Note>
      ) : !deposit.canApplyToSettlement ? (
        <Note tone="warning">
          <span className="font-medium">{t("DepositSettlementUnavailable" as any)}</span>
          {/* The server's own wording, so the operator reads the same sentence
              here as they would have read on a rejected submit. */}
          <span className="block">{deposit.blockedReason}</span>
        </Note>
      ) : (
        <>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox
              checked={value}
              onCheckedChange={(checked) => onChange(vehicleId, checked === true)}
              disabled={disabled}
              className="mt-0.5"
            />
            <span className="leading-snug">{t("DepositSettlementConfirm" as any)}</span>
          </label>

          {deposit.treatmentRequired && !value && (
            <Note tone="warning">{t("DepositSettlementRequired" as any)}</Note>
          )}

          {value && (
            /* Stated as a change, not as a standing figure.
             *
             * The supplier-settlement panel sits directly below this one and
             * shows the SAME parties owing the GROSS — 3,000 where this shows
             * 2,000. Rendered in that panel's `party → party  amount` idiom the
             * two read as a contradiction, and a salesperson scanning down the
             * screen has no way to tell which is the real number. Both are: one
             * before the عربون, one after. So this says exactly that, and
             * borrows nothing that could be mistaken for the other. */
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
              <span>
                {directToSupplier
                  ? t("DepositSettlementSupplierOwes" as any).replace("{supplier}", supplier)
                  : t("DepositSettlementCustomerOwes" as any)}
              </span>
              <span className="flex items-baseline gap-2 tabular-nums">
                <span className="text-muted-foreground">
                  {money(
                    directToSupplier
                      ? preview.supplierReceivable
                      : preview.customerVehicleReceivable
                  )}
                </span>
                <ArrowRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 self-center text-muted-foreground",
                    isRtl && "rotate-180"
                  )}
                  aria-hidden
                />
                <span className="text-base font-semibold">
                  {money(
                    directToSupplier
                      ? deposit.supplierReceivableAfter
                      : deposit.customerReceivableAfter
                  )}
                </span>
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Note({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "warning";
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 text-xs leading-relaxed",
        tone === "warning" && "text-amber-700 dark:text-amber-500"
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
