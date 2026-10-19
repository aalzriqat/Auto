"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { netProfitAfterCommissionsMinor } from "@/convex/utils/dealCommissionLines";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";

type Translate = (key: string) => string;

/**
 * One compact row on the deal's money card: the deal's employee commissions as a
 * single total that expands into its lines, and the net profit after them.
 *
 * Registration lives on the Commissions page; this only reads. It is hidden for
 * a caller who cannot view commissions, because the figures are employees' pay.
 *
 * `profitMinor` is the card's own headline profit (null when it is not known).
 * The net figure is derived from it and never shown when either side is unknown.
 */
export function DealCommissionsRow({
  orgId,
  saleId,
  profitMinor,
  money,
  t,
}: Readonly<{
  orgId: Id<"organizations"> | undefined;
  saleId: Id<"sales"> | null | undefined;
  profitMinor: number | null;
  money: (minor: number) => string;
  t: Translate;
}>) {
  const { hasPermission, isLoading } = usePermissions();
  const canView = !isLoading && hasPermission(PERMISSIONS.VIEW_COMMISSIONS);
  const view = useQuery(
    api.dealCommissions.forSale,
    canView && orgId && saleId ? { orgId, saleId } : "skip"
  );
  const [open, setOpen] = useState(false);

  if (!canView || !orgId || !saleId) return null;
  if (view === undefined) {
    return <p className="text-sm text-muted-foreground">{t("DealCommissionsLoading")}</p>;
  }

  const net = netProfitAfterCommissionsMinor(profitMinor, view.totalMinor);
  const rows: Array<{ key: string; label: string; who: string; amountMinor: number | null; note?: string | null }> = [
    {
      key: "salesperson",
      label: t("DealCommissionSalespersonLine"),
      who: view.salesperson.employeeName,
      amountMinor: view.salesperson.amountMinor,
    },
    ...view.lines.map((line) => ({
      key: line.id,
      label: t(`DealCommissionKind${line.kind}`),
      who: line.employeeName,
      amountMinor: line.amountMinor,
      note: line.note,
    })),
  ];

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2" data-testid="deal-commissions-row">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-start"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-sm text-muted-foreground">{t("DealCommissionsTotal")}</span>
        <span className="flex items-center gap-2 text-sm font-medium tabular-nums">
          {view.totalMinor === null ? "—" : money(view.totalMinor)}
          {open ? <ChevronUp className="h-4 w-4" aria-label={t("DealCommissionsHide")} /> : <ChevronDown className="h-4 w-4" aria-label={t("DealCommissionsShow")} />}
        </span>
      </button>

      {view.salePending && <p className="text-xs text-amber-700 dark:text-amber-400">{t("DealCommissionsPendingSale")}</p>}
      {view.totalMinor === null && <p className="text-xs text-amber-700 dark:text-amber-400">{t("DealCommissionsUnreadable")}</p>}

      {open && (
        <div className="space-y-2 pt-1">
          <ul className="divide-y text-sm">
            {rows.map((row) => (
              <li key={row.key} className="flex items-start justify-between gap-3 py-1.5">
                <span>
                  <span className="block">{row.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {row.who}
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                </span>
                <span className="tabular-nums">{row.amountMinor === null ? "—" : money(row.amountMinor)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("DealCommissionsRegisteredNote")}</p>
          <Link href={`/${orgId}/commissions`} className="text-xs text-primary underline-offset-2 hover:underline">
            {t("DealCommissionsOpenPage")}
          </Link>
        </div>
      )}

      {view.saleStatus !== "CANCELLED" && (
        <div className="flex items-baseline justify-between gap-3 border-t pt-1.5">
          <span className="text-sm text-muted-foreground">{t("DealCommissionsNetAfter")}</span>
          {net === null ? (
            <span className="text-xs text-muted-foreground">{t("DealCommissionsNetUnavailable")}</span>
          ) : (
            <span className={`text-sm font-semibold tabular-nums ${net < 0 ? "text-profit-negative" : ""}`}>{money(net)}</span>
          )}
        </div>
      )}
    </div>
  );
}
