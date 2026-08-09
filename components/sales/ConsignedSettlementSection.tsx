"use client";

import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { cn } from "@/lib/utils";
import { consignedRouteRefusal } from "@/lib/consignedRouteGuard";
import { ArrowRight, AlertTriangle } from "lucide-react";

/**
 * Where the buyer's money went on a consigned sale, and what that does.
 *
 * A SOURCED car is legally the supplier's: the dealership sells it as his agent
 * and keeps only the spread. The one thing it cannot infer is who collected the
 * money — and that single fact flips which side of the balance sheet the deal
 * lands on. Through the dealership, it owes him his entitlement; direct to him,
 * he is holding the dealership's margin.
 *
 * That is why this is a decision with a rendered consequence rather than a
 * field. The obligation line under the choice redraws as the route changes, and
 * its arrow points the way the money still has to travel. Employees confuse the
 * reservation deposit, the finance company's down payment and the supplier
 * settlement constantly; showing the direction is what stops the confusion.
 *
 * Every figure comes from `sales.consignedSalePreview`, which runs the same
 * `saleEconomics` and cost basis the ledger posts from. Nothing here is
 * recomputed client-side: a preview that can disagree with the posting is worse
 * than no preview.
 */

type Route = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";

interface Props {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles"> | undefined;
  /**
   * Preview this car's LINE of the quote. The price then comes from the server,
   * off that line — a quote's own `vehiclePrice` is the total of every car on
   * it, and pairing it with one car's supplier cost showed an operator a margin
   * that belonged to no vehicle.
   */
  quoteId?: Id<"quotes">;
  /** Used only when no quote is named — the sale form knows its own price. */
  salePrice?: number;
  value: Route;
  onChange: (route: Route) => void;
  disabled?: boolean;
  /** The route is one decision for the whole quote, so it is asked for once. */
  showRouteSelector?: boolean;
  /**
   * Whether this line turned out to be consigned at all — knowable only once
   * the preview answers, and the caller needs it to decide which line carries
   * the route selector. Picking the first line blind puts the selector on a
   * dealer-owned car, where this component renders nothing, so a mixed quote
   * loses the control entirely and posts the default route.
   */
  onApplicable?: (vehicleId: Id<"vehicles">, applicable: boolean) => void;
  /**
   * The deal is going through a finance company. Paying the supplier directly
   * has no representation on that side of the settlement yet, and the server
   * refuses it — so the option is disabled here rather than offered and failed.
   */
  financed?: boolean;
}

export function ConsignedSettlementSection({
  orgId,
  vehicleId,
  quoteId,
  salePrice,
  value,
  onChange,
  disabled,
  showRouteSelector = true,
  onApplicable,
  financed = false,
}: Props) {
  const { t, isRtl } = useLanguage();

  // A route can outlive the deal shape that allowed it: the financing type is
  // chosen further down the same form, so an operator can pick
  // DIRECT_TO_SUPPLIER on a cash deal and then switch it to FINANCED.
  //
  // This used to correct itself, with an effect that called
  // `onChange("THROUGH_DEALERSHIP")`. That is the one thing it must not do. The
  // route flipped off-screen with no toast and no field error, so the server
  // refusal — which exists to stop exactly this deal — never fired, because by
  // submit time the value was the one route the server accepts. The sale then
  // booked a supplier payable the dealership does not owe, a customer
  // receivable at the gross it will never collect, and no supplier receivable
  // for the margin the supplier owes it.
  //
  // The stale selection is kept, shown as selected, and explained; submit is
  // gated on `consignedRouteRefusal` in both callers. A refusal the operator
  // can see is worth more than a correction they cannot.

  const preview = useQuery(
    api.sales.consignedSalePreview,
    vehicleId
      ? {
          orgId,
          vehicleId,
          settlementRoute: value,
          ...(quoteId
            ? { quoteId }
            : { salePrice: Number.isFinite(salePrice) ? (salePrice as number) : 0 }),
        }
      : "skip"
  );

  // Reported up before the early return below, so a caller can learn which
  // lines are consigned. `undefined` is "not answered yet" and is deliberately
  // not reported as "no" — that would move the route selector onto another line
  // and then move it back when the query lands.
  useEffect(() => {
    if (!vehicleId || preview === undefined) return;
    onApplicable?.(vehicleId, preview !== null);
  }, [vehicleId, preview, onApplicable]);

  // `null` means the vehicle is dealer-owned, which has no supplier to settle
  // with; `undefined` means the query has not answered yet. Neither should
  // reserve space in the form — this section only exists for consigned cars.
  if (!vehicleId || preview === null || preview === undefined) return null;

  const money = (n: number) =>
    n.toLocaleString(isRtl ? "ar-JO" : "en-JO", { maximumFractionDigits: 2 });

  const directToSupplier = preview.settlementRoute === "DIRECT_TO_SUPPLIER";
  const supplier = preview.supplierName || t("TheSupplier" as any);

  // Past the early return, so the car is known to be consigned.
  const routeRefused =
    consignedRouteRefusal({ financed, route: value, isConsigned: true }) !== null;

  // Paying the supplier directly is not supported on a FINANCED deal yet: the
  // finance company's side of the settlement has nowhere to record it. The
  // server refuses it outright (see saleCompletion), so offering it here would
  // be offering a choice that fails on submit — which is the exact defect the
  // deposit-settlement work spent this whole PR removing.
  //
  // Disabled and explained rather than hidden. A missing option reads as a bug
  // to an operator who used it on a cash deal an hour ago; a disabled one with
  // a reason reads as a limitation.
  const routes: Array<{ id: Route; label: string; hint: string; unavailable?: string }> = [
    {
      id: "THROUGH_DEALERSHIP",
      label: t("RouteThroughDealership" as any),
      hint: t("RouteThroughDealershipHint" as any),
    },
    {
      id: "DIRECT_TO_SUPPLIER",
      label: t("RouteDirectToSupplier" as any),
      hint: t("RouteDirectToSupplierHint" as any),
      ...(financed ? { unavailable: t("RouteDirectUnavailableFinanced" as any) } : {}),
    },
  ];

  return (
    <section className="space-y-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-4 dark:bg-amber-400/[0.06]">
      <header className="space-y-1">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
          {t("ConsignedSaleSettlement" as any)}
        </h3>
        {preview.quoteLineIndex === undefined ? null : (
          <p className="text-sm font-medium">{preview.vehicleLabel}</p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("ConsignedSaleSettlementDesc" as any).replace("{supplier}", supplier)}
        </p>
      </header>

      {preview.missingSupplierCost ? (
        <p className="flex items-start gap-2 text-xs font-medium text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t("ConsignedNoSupplierCost" as any)}</span>
        </p>
      ) : null}

      {/* The selection stands and the deal is blocked, rather than the route
          being changed for the operator. `role="alert"` so the reason reaches a
          screen reader too: the financing control that causes this sits below
          this section, so the change that triggers it happens off-screen. */}
      {routeRefused ? (
        <p
          role="alert"
          className="flex items-start gap-2 text-xs font-medium text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t("RouteDirectRefusedFinanced" as any)}</span>
        </p>
      ) : null}

      <fieldset disabled={disabled} className={cn("space-y-2", !showRouteSelector && "hidden")}>
        <legend className="sr-only">{t("SupplierSettlementRoute" as any)}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {routes.map((route) => {
            const selected = value === route.id;
            return (
              <button
                key={route.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={route.unavailable !== undefined}
                onClick={() => onChange(route.id)}
                className={cn(
                  "rounded-md border p-3 text-start transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "border-amber-500 bg-background shadow-sm"
                    : "border-border bg-background/40 hover:bg-background"
                )}
              >
                <span className="block text-sm font-medium">{route.label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                  {route.unavailable ?? route.hint}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* The money statement. Three lines, because there are only three facts:
          what the deal was worth, what is his, and what is the dealership's. */}
      <dl className="space-y-1.5 border-t pt-3 text-sm">
        <Row
          label={t("GrossTransactionValue" as any)}
          value={money(preview.grossTransactionValue)}
          muted
        />
        <Row
          label={t("SupplierEntitlement" as any).replace("{supplier}", supplier)}
          value={money(preview.supplierEntitlement)}
          muted
        />
        <Row
          label={t("DealerGrossMargin" as any)}
          value={money(preview.dealershipMargin)}
          emphasis
        />
      </dl>

      {/* The consequence, and the reason this screen exists. */}
      <div className="flex items-center gap-2 rounded-md bg-background px-3 py-2.5 text-sm">
        <span className="font-medium">
          {directToSupplier ? supplier : t("TheDealership" as any)}
        </span>
        <ArrowRight
          className={cn("h-4 w-4 shrink-0 text-amber-600", isRtl && "rotate-180")}
          aria-hidden
        />
        <span className="font-medium">
          {directToSupplier ? t("TheDealership" as any) : supplier}
        </span>
        <span className="ms-auto tabular-nums font-semibold">
          {money(directToSupplier ? preview.supplierReceivable : preview.supplierPayable)}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {directToSupplier
          ? t("ConsignedDirectConsequence" as any).replace("{supplier}", supplier)
          : t("ConsignedThroughConsequence" as any).replace("{supplier}", supplier)}
      </p>
    </section>
  );
}

function Row({
  label,
  value,
  muted,
  emphasis,
}: {
  label: string;
  value: string;
  muted?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn("text-xs", muted && "text-muted-foreground")}>{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          emphasis ? "text-base font-semibold" : "text-sm text-muted-foreground"
        )}
      >
        {value}
      </dd>
    </div>
  );
}
