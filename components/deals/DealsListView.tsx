"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowUpRight, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The Deals list — one entry per canonical deal, cash or financed, opening the
 * ONE deal screen (SCRUM-215, owner design direction c19384).
 *
 * Signature: the list is a NEEDS-ACTION QUEUE first and a register second.
 * Every row states, before anything else, why it is waiting and on whom — the
 * dealership or somebody else — so a sales agent reads the queue, not a
 * status column. Grouping is by the reason, with a count.
 *
 * What the reasons are made of, and what they are NOT: each one is derived from
 * facts the list queries already serve to this caller (status, a held deposit
 * awaiting resolution, a named financier, a recorded receipt, the settlement
 * route). Nothing here computes a blocker the server has not stated: the
 * stage rail's finer blockers (documents outstanding, route required …) live
 * on the deal itself. And every count is a count of LOADED rows — the label
 * says so whenever more can be loaded, because a page is not the org.
 */

export type DealKind = "CASH" | "FINANCED";

/** Why a deal is waiting, and on whom. Derived from served facts only. */
export type DealReason =
  | "DEPOSIT_PENDING"
  | "DOCS_PENDING"
  | "AWAITING_DECISION"
  | "READY_FOR_HANDOVER"
  | "AWAITING_RECEIPT"
  | "CASH_PENDING";

export type DealWaitingOn = "DEALERSHIP" | "OTHERS" | "NONE";

export type DealRow = {
  key: string;
  href: string;
  kind: DealKind;
  customerName: string;
  vehicleDesc: string;
  /** Translated already, or null on a cash deal. */
  financierLabel: string | null;
  statusLabel: string;
  statusTone: "active" | "done" | "stopped" | "neutral";
  reason: DealReason | null;
  waitingOn: DealWaitingOn;
  /** The most recent recorded moment on the row; what "since" is measured from. */
  since: number;
  salespersonName: string;
  /** Already formatted, or null when the caller is not shown it. */
  amountLabel: string | null;
};

const REASON_LABEL: Record<DealReason, string> = {
  DEPOSIT_PENDING: "ReasonDepositPending",
  DOCS_PENDING: "ReasonDocsPending",
  AWAITING_DECISION: "ReasonAwaitingDecision",
  READY_FOR_HANDOVER: "ReasonReadyForHandover",
  AWAITING_RECEIPT: "ReasonAwaitingReceipt",
  CASH_PENDING: "ReasonCashPending",
};

/** Severity order for the reason groups: money first. */
const REASON_ORDER: DealReason[] = [
  "DEPOSIT_PENDING",
  "AWAITING_RECEIPT",
  "READY_FOR_HANDOVER",
  "DOCS_PENDING",
  "CASH_PENDING",
  "AWAITING_DECISION",
];

const REASON_TONE: Record<DealReason, string> = {
  DEPOSIT_PENDING: "bg-amber-500",
  AWAITING_RECEIPT: "bg-amber-500",
  READY_FOR_HANDOVER: "bg-primary",
  DOCS_PENDING: "bg-primary",
  CASH_PENDING: "bg-primary",
  AWAITING_DECISION: "bg-muted-foreground/50",
};

type View = "needs" | "waiting" | "all";

function statusClass(tone: DealRow["statusTone"]): string {
  switch (tone) {
    case "active":
      return "border-primary/40 bg-primary/10 text-primary";
    case "done":
      return "border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "stopped":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    default:
      return "";
  }
}

export function DealsListView({
  rows,
  loading,
  canLoadMore,
  loadingMore,
  onLoadMore,
  newDealHref,
  t,
}: Readonly<{
  /** `undefined` while the first page is loading. */
  rows: ReadonlyArray<DealRow> | undefined;
  loading: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Present only for a caller who may start a deal. */
  newDealHref: string | null;
  t: (key: string) => string;
}>) {
  const [view, setView] = useState<View>("needs");
  const [reason, setReason] = useState<DealReason | null>(null);
  const [kind, setKind] = useState<DealKind | null>(null);
  const [search, setSearch] = useState("");

  const loaded = rows ?? [];
  const counts = useMemo(
    () => ({
      needs: loaded.filter((row) => row.waitingOn === "DEALERSHIP").length,
      waiting: loaded.filter((row) => row.waitingOn === "OTHERS").length,
      all: loaded.length,
    }),
    [loaded]
  );
  const reasonCounts = useMemo(() => {
    const out = new Map<DealReason, number>();
    for (const row of loaded) {
      if (row.waitingOn === "DEALERSHIP" && row.reason) out.set(row.reason, (out.get(row.reason) ?? 0) + 1);
    }
    return REASON_ORDER.filter((key) => out.has(key)).map((key) => [key, out.get(key)!] as const);
  }, [loaded]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return loaded
      .filter((row) =>
        view === "needs" ? row.waitingOn === "DEALERSHIP" : view === "waiting" ? row.waitingOn === "OTHERS" : true
      )
      .filter((row) => (view === "needs" && reason ? row.reason === reason : true))
      .filter((row) => (kind ? row.kind === kind : true))
      .filter((row) =>
        needle
          ? [row.customerName, row.vehicleDesc, row.financierLabel ?? "", row.salespersonName]
              .join(" ")
              .toLowerCase()
              .includes(needle)
          : true
      )
      .sort((a, b) => b.since - a.since);
  }, [loaded, view, reason, kind, search]);

  const filtersActive = reason !== null || kind !== null || search.trim() !== "";
  const countSuffix = canLoadMore ? "+" : "";

  return (
    <div className="flex-1 space-y-4 p-4 pt-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t("DealsTitle")}</h1>
        {newDealHref && (
          <Button asChild>
            <Link href={newDealHref}>
              <Plus className="h-4 w-4 me-2" />
              {t("NewDeal")}
            </Link>
          </Button>
        )}
      </div>

      {/* Views: the queue, the ones somebody else is holding, the register. */}
      <div role="tablist" aria-label={t("DealsTitle")} className="flex gap-1 overflow-x-auto border-b">
        {(
          [
            ["needs", "DealsNeedsAction", counts.needs],
            ["waiting", "DealsWaitingOnOthers", counts.waiting],
            ["all", "DealsAll", counts.all],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => {
              setView(key);
              setReason(null);
            }}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm",
              view === key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t(label)}
            <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
              <bdi dir="ltr">
                {count}
                {countSuffix}
              </bdi>
            </span>
          </button>
        ))}
      </div>

      {/* Reason groups — the queue's own index. Only on the queue view. */}
      {view === "needs" && reasonCounts.length > 0 && (
        <div role="group" aria-label={t("DealsNeedsAction")} className="flex flex-wrap gap-2">
          {reasonCounts.map(([key, count]) => (
            <button
              key={key}
              type="button"
              aria-pressed={reason === key}
              onClick={() => setReason((current) => (current === key ? null : key))}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                reason === key ? "border-primary bg-primary/5" : "hover:bg-muted/60"
              )}
            >
              <span className={cn("h-2 w-2 shrink-0 rounded-full", REASON_TONE[key])} aria-hidden />
              {t(REASON_LABEL[key])}
              <span className="text-xs tabular-nums text-muted-foreground">
                <bdi dir="ltr">
                  {count}
                  {countSuffix}
                </bdi>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-md border">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative w-full max-w-sm">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              placeholder={t("SearchDeals")}
              aria-label={t("SearchDeals")}
              onChange={(event) => setSearch(event.target.value)}
              className="ps-9"
            />
          </div>
          {(["CASH", "FINANCED"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => setKind((current) => (current === option ? null : option))}
              className={cn(
                "rounded-full border px-3 py-1 text-xs",
                kind === option ? "border-primary bg-primary/5 font-medium" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(option === "CASH" ? "DealKindCash" : "DealKindFinanced")}
            </button>
          ))}
          {filtersActive && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setReason(null);
                setKind(null);
                setSearch("");
              }}
            >
              {t("ClearFilters")}
            </Button>
          )}
        </div>

        {rows === undefined || loading ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("LoadingDeals")}</p>
        ) : visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {t(view === "needs" && !filtersActive ? "DealsQueueEmpty" : "NoDealsFound")}
          </p>
        ) : (
          <>
            {/* Cards on a phone, a table above it: the same rows, one source. */}
            <ul className="divide-y sm:hidden" data-testid="deals-cards">
              {visible.map((row) => (
                <li key={row.key}>
                  <Link href={row.href} className="block space-y-1.5 p-3 hover:bg-muted/40">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        <bdi>{row.customerName}</bdi>
                      </span>
                      <Badge variant="outline" className={statusClass(row.statusTone)}>
                        {row.statusLabel}
                      </Badge>
                    </div>
                    {row.reason && (
                      <p className="flex items-center gap-2 text-sm">
                        <span className={cn("h-2 w-2 shrink-0 rounded-full", REASON_TONE[row.reason])} aria-hidden />
                        {t(REASON_LABEL[row.reason])}
                      </p>
                    )}
                    <p className="text-sm text-muted-foreground">
                      <bdi>{row.vehicleDesc}</bdi>
                      {row.financierLabel && (
                        <>
                          {" · "}
                          <bdi>{row.financierLabel}</bdi>
                        </>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <bdi>{row.salespersonName}</bdi>
                      {" · "}
                      <bdi>{format(row.since, "d MMM yyyy")}</bdi>
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden sm:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("DealsReasonColumn")}</TableHead>
                    <TableHead>{t("DealsCustomerVehicleColumn")}</TableHead>
                    <TableHead>{t("DealsTypeColumn")}</TableHead>
                    <TableHead>{t("Status")}</TableHead>
                    <TableHead>{t("DealsSinceColumn")}</TableHead>
                    <TableHead>{t("DealOwner")}</TableHead>
                    {visible.some((row) => row.amountLabel !== null) && (
                      <TableHead className="text-end">{t("Amount")}</TableHead>
                    )}
                    <TableHead>
                      <span className="sr-only">{t("OpenDeal")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <TableRow key={row.key} data-testid={`deal-row-${row.key}`}>
                      <TableCell>
                        {row.reason ? (
                          <span className="flex items-center gap-2 text-sm">
                            <span className={cn("h-2 w-2 shrink-0 rounded-full", REASON_TONE[row.reason])} aria-hidden />
                            {t(REASON_LABEL[row.reason])}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">
                          <bdi>{row.customerName}</bdi>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          <bdi>{row.vehicleDesc}</bdi>
                        </p>
                      </TableCell>
                      <TableCell className="text-sm">
                        {t(row.kind === "CASH" ? "DealKindCash" : "DealKindFinanced")}
                        {row.financierLabel && (
                          <span className="text-muted-foreground">
                            {" · "}
                            <bdi>{row.financierLabel}</bdi>
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={statusClass(row.statusTone)}>
                          {row.statusLabel}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <bdi>{format(row.since, "d MMM yyyy")}</bdi>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        <bdi>{row.salespersonName}</bdi>
                      </TableCell>
                      {visible.some((r) => r.amountLabel !== null) && (
                        <TableCell className="text-end tabular-nums">
                          {row.amountLabel ? <bdi dir="ltr">{row.amountLabel}</bdi> : ""}
                        </TableCell>
                      )}
                      <TableCell className="text-end">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={row.href} aria-label={`${t("OpenDeal")}: ${row.customerName}`}>
                            {t("OpenDeal")}
                            <ArrowUpRight className="h-4 w-4 ms-1.5 rtl:-scale-x-100" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
          <span>
            <bdi dir="ltr">{visible.length}</bdi> {t("DealsShownOf")} <bdi dir="ltr">{loaded.length}</bdi>{" "}
            {t(canLoadMore ? "DealsLoadedMoreAvailable" : "DealsLoadedAll")}
          </span>
          {canLoadMore && (
            <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={onLoadMore}>
              {t("LoadMore")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
