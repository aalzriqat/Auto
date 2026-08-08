"use client";

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
  value: boolean;
  onChange: (applied: boolean) => void;
  disabled?: boolean;
}

export function DepositSettlementDecision({
  orgId,
  quoteId,
  vehicleId,
  settlementRoute,
  value,
  onChange,
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

  // `null` is dealer-owned stock or a line this preview cannot speak for;
  // `undefined` is "not answered yet". Neither should reserve space.
  if (!preview) return null;
  const deposit = preview.depositSettlement;
  // No عربون on this quote — there is nothing to decide, and rendering an empty
  // section is how operators learn to click past the ones that matter.
  if (!deposit) return null;

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

      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm">{t("DepositSettlementHeldAmount" as any)}</span>
        <span className="text-base font-semibold tabular-nums">
          {money(deposit.depositAmount)}
        </span>
      </div>

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
              onCheckedChange={(checked) => onChange(checked === true)}
              disabled={disabled}
              className="mt-0.5"
            />
            <span className="leading-snug">{t("DepositSettlementConfirm" as any)}</span>
          </label>

          {deposit.treatmentRequired && !value && (
            <Note tone="warning">{t("DepositSettlementRequired" as any)}</Note>
          )}

          {value && (
            /* The consequence, in the same directional idiom the supplier
               settlement panel uses — so the deposit reads as part of one
               settlement story rather than a separate calculation. */
            <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2.5 text-sm">
              <span className="font-medium">
                {directToSupplier ? supplier : t("TheDealership" as any)}
              </span>
              <ArrowRight
                className={cn("h-4 w-4 shrink-0 text-muted-foreground", isRtl && "rotate-180")}
                aria-hidden
              />
              <span className="font-medium">
                {directToSupplier ? t("TheDealership" as any) : supplier}
              </span>
              <span className="ms-auto tabular-nums font-semibold">
                {money(
                  directToSupplier
                    ? deposit.supplierReceivableAfter
                    : deposit.customerReceivableAfter
                )}
              </span>
            </div>
          )}

          {value && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {directToSupplier
                ? t("DepositSettlementSupplierOwes" as any).replace("{supplier}", supplier)
                : t("DepositSettlementCustomerOwes" as any)}
            </p>
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
