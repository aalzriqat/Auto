"use client";

/**
 * Who the finance company pays for a CONSIGNED car — the dealership, or the
 * supplier directly. Recorded through `applications.setSupplierSettlementRoute`,
 * the same mutation the Finance Applications → Review dialog calls; the
 * control moved, the authority did not.
 *
 * It decides opposite balance sheets at finalization — a payable to the
 * supplier for his whole entitlement, or a claim on him for the margin — so
 * `finalizeDeal` refuses until it is on the record. Asked on the deal screen
 * because that is where the operator is when the close refuses.
 *
 * Every fact here is the SERVER's: which route is recorded, whether the direct
 * route is available and, when it is not, why. The screen forms no opinion
 * about who pays for the car.
 */
export type SupplierSettlementRoute = "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
export type DirectRouteRefusal =
  | "NoExternalFinancier"
  | "LEASE"
  | "PAYER_UNNAMED"
  | "HeldDeposit"
  | null;

const DIRECT_ROUTE_REFUSAL_KEY: Record<NonNullable<DirectRouteRefusal>, string> = {
  NoExternalFinancier: "RouteDirectUnavailableNoExternalFinancier",
  LEASE: "RouteDirectUnavailableLease",
  PAYER_UNNAMED: "RouteDirectUnavailableUnnamedProvider",
  HeldDeposit: "RouteDirectUnavailableHeldDeposit",
};

export function SettlementRouteControl({
  route,
  canSettleDirectToSupplier,
  directRouteRefusal,
  supplierName,
  disabled = false,
  t,
  onChoose,
}: Readonly<{
  /** The recorded route, or undefined when nothing has been recorded yet. */
  route: SupplierSettlementRoute | undefined;
  canSettleDirectToSupplier: boolean;
  directRouteRefusal: DirectRouteRefusal | undefined;
  supplierName: string | undefined;
  disabled?: boolean;
  t: (key: string) => string;
  onChoose: (route: SupplierSettlementRoute) => void | Promise<void>;
}>) {
  const supplierLabel = supplierName ?? t("TheSupplier");
  const reasonKey =
    (directRouteRefusal && DIRECT_ROUTE_REFUSAL_KEY[directRouteRefusal]) ||
    "RouteDirectUnavailableNoExternalFinancier";

  return (
    <fieldset
      className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3"
      data-testid="deal-settlement-route"
    >
      <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
        {t("SupplierSettlementRoute")}
      </legend>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("ConsignedSaleSettlementDesc").replace("{supplier}", supplierLabel)}
      </p>
      {/* `role="radio"` elements must be owned by a `radiogroup`; fieldset and
          legend group them visually but establish no ARIA ownership. */}
      <div role="radiogroup" aria-label={t("SupplierSettlementRoute")} className="grid gap-2">
        {(
          [
            ["THROUGH_DEALERSHIP", "RouteThroughDealership", "RouteThroughDealershipHint"],
            ["DIRECT_TO_SUPPLIER", "RouteDirectToSupplier", "RouteDirectToSupplierHint"],
          ] as const
        ).map(([value, labelKey, hintKey]) => {
          // Nothing is preselected when no route has been recorded. Defaulting
          // the control to THROUGH_DEALERSHIP showed it as already chosen while
          // the server still considered the deal unanswered.
          const selected = route === value;
          // Shown disabled with the reason rather than hidden: an operator
          // looking for the option they were told to pick needs to know why
          // it is not there.
          const unavailable = value === "DIRECT_TO_SUPPLIER" && !canSettleDirectToSupplier;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled || unavailable}
              onClick={() => void onChoose(value)}
              className={`rounded-md border p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? "border-amber-500 bg-background shadow-sm"
                  : "border-border bg-background/40 enabled:hover:bg-background"
              }`}
            >
              <span className="block text-sm font-medium">{t(labelKey)}</span>
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {t(unavailable ? reasonKey : hintKey)}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
