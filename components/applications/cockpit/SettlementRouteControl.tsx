"use client";

import { useId } from "react";

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
export type DirectRouteRefusal = "NoExternalFinancier" | "LEASE" | "PAYER_UNNAMED" | null;

const DIRECT_ROUTE_REFUSAL_KEY: Record<NonNullable<DirectRouteRefusal>, string> = {
  NoExternalFinancier: "RouteDirectUnavailableNoExternalFinancier",
  LEASE: "RouteDirectUnavailableLease",
  PAYER_UNNAMED: "RouteDirectUnavailableUnnamedProvider",
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
  const groupId = useId();
  const supplierLabel = supplierName ?? t("TheSupplier");
  const [descriptionBeforeSupplier, descriptionAfterSupplier] =
    t("ConsignedSaleSettlementDesc").split("{supplier}", 2);
  const reasonKey =
    (directRouteRefusal && DIRECT_ROUTE_REFUSAL_KEY[directRouteRefusal]) ||
    "RouteDirectUnavailableNoExternalFinancier";

  return (
    <fieldset
      className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-3"
      data-testid="deal-settlement-route"
    >
      <legend id={`${groupId}-legend`} className="px-1 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
        {t("SupplierSettlementRoute")}
      </legend>
      <p id={`${groupId}-description`} className="text-xs leading-relaxed text-muted-foreground">
        {descriptionBeforeSupplier}
        {descriptionAfterSupplier !== undefined && <><bdi>{supplierLabel}</bdi>{descriptionAfterSupplier}</>}
      </p>
      <div role="radiogroup" aria-labelledby={`${groupId}-legend`} aria-describedby={`${groupId}-description`} className="grid gap-2">
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
          const choiceId = `${groupId}-${value}`;
          const choiceDisabled = disabled || unavailable;
          return (
            <label
              key={value}
              className={`rounded-md border p-3 text-start transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-1 ${
                selected
                  ? "border-amber-500 bg-background shadow-sm"
                  : "border-border bg-background/40"
              } ${
                choiceDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-background"
              }`}
            >
              <input
                type="radio"
                name={groupId}
                value={value}
                checked={selected}
                disabled={choiceDisabled}
                aria-labelledby={`${choiceId}-label`}
                aria-describedby={`${choiceId}-hint`}
                onChange={() => void onChoose(value)}
                className="sr-only"
              />
              <span id={`${choiceId}-label`} className="block text-sm font-medium">{t(labelKey)}</span>
              <span id={`${choiceId}-hint`} className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {t(unavailable ? reasonKey : hintKey)}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
