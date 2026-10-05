"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Banknote, CarFront, ChevronRight, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLocalized } from "@/lib/dateLocale";
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
  | "CASH_PENDING"
  | "SALE_PENDING";

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
  SALE_PENDING: "ReasonSalePending",
};

/** Severity order for the reason groups: money first. */
const REASON_ORDER: DealReason[] = [
  "DEPOSIT_PENDING",
  "AWAITING_RECEIPT",
  "READY_FOR_HANDOVER",
  "DOCS_PENDING",
  "CASH_PENDING",
  "SALE_PENDING",
  "AWAITING_DECISION",
];

const REASON_TONE: Record<DealReason, string> = {
  DEPOSIT_PENDING: "bg-amber-500",
  AWAITING_RECEIPT: "bg-amber-500",
  READY_FOR_HANDOVER: "bg-primary",
  DOCS_PENDING: "bg-primary",
  CASH_PENDING: "bg-primary",
  SALE_PENDING: "bg-primary",
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

/**
 * The row's anchor: the car, with the deal's kind on it. No photo is served to
 * the list, so it is a mark rather than a thumbnail — but it gives every row the
 * same visual start, and a financed deal reads differently from a cash one
 * without colour being the only cue (the kind is also written in the row).
 */
function VehicleMark({ kind }: Readonly<{ kind: DealKind }>) {
  return (
    <span
      className={cn(
        "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
        kind === "FINANCED" ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      )}
      aria-hidden
    >
      <CarFront className="h-5 w-5" />
      {kind === "CASH" && (
        <Banknote className="absolute -bottom-1 -end-1 h-4 w-4 rounded-sm bg-background p-px" />
      )}
    </span>
  );
}

function ReasonLine({ reason, t }: Readonly<{ reason: DealReason; t: (key: string) => string }>) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", REASON_TONE[reason])} aria-hidden />
      <span className="truncate">{t(REASON_LABEL[reason])}</span>
    </span>
  );
}

/**
 * The deal's kind, written (the vehicle mark is decorative), and its financier.
 * The kind never truncates; a long financier does, with its full name on hover.
 */
function KindLine({ row, t }: Readonly<{ row: DealRow; t: (key: string) => string }>) {
  return (
    <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      <span data-fact="kind" data-kind={row.kind} className="shrink-0 whitespace-nowrap">
        {t(row.kind === "CASH" ? "DealKindCash" : "DealKindFinanced")}
      </span>
      {row.financierLabel && (
        <>
          <span aria-hidden>·</span>
          <span data-fact="financier" className="min-w-0 truncate" title={row.financierLabel}>
            <bdi>{row.financierLabel}</bdi>
          </span>
        </>
      )}
    </p>
  );
}

/** Owner and date on one line: a long owner name truncates, the date never does. */
function OwnerDate({ row, locale }: Readonly<{ row: DealRow; locale?: string }>) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span data-fact="owner" dir="auto" className="min-w-0 truncate" title={row.salespersonName}>
        <bdi>{row.salespersonName}</bdi>
      </span>
      <span aria-hidden>·</span>
      <span data-fact="date" className="shrink-0 whitespace-nowrap">
        <bdi>{formatLocalized(row.since, "d MMM yyyy", locale)}</bdi>
      </span>
    </span>
  );
}

export function DealsListView({
  rows,
  loading,
  canLoadMore,
  loadingMore,
  complete,
  onLoadMore,
  newDealHref,
  t,
  locale,
}: Readonly<{
  /** `undefined` while the first page is loading. */
  rows: ReadonlyArray<DealRow> | undefined;
  loading: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  /** Every source is exhausted: the only state that may claim "all loaded". */
  complete: boolean;
  onLoadMore: () => void;
  /** Present only for a caller who may start a deal. */
  newDealHref: string | null;
  t: (key: string) => string;
  /** The interface language: month names follow it (an Arabic list never shows "Oct"). */
  locale?: string;
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
  // Completeness is proven (every source exhausted), never inferred from the
  // absence of canLoadMore/loadingMore: a page in flight, first or later,
  // sets neither on its own (SCRUM-603-2).
  const incomplete = !complete;
  const rowsLoaded = rows !== undefined && !loading;
  const countSuffix = incomplete ? "+" : "";
  // The queue is built from loaded rows only: with more to load, an empty
  // queue proves nothing about older deals (SCRUM-603-2).
  const showAmount = visible.some((row) => row.amountLabel !== null);
  let emptyKey = "NoDealsFound";
  if (view === "needs" && !filtersActive) emptyKey = incomplete ? "DealsQueueEmptyLoadedOnly" : "DealsQueueEmpty";

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
      <div role="tablist" aria-label={t("DealsTitle")} className="flex flex-wrap gap-1 border-b">
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

      <div className="@container rounded-md border">
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
          <p className="p-6 text-center text-sm text-muted-foreground">{t(emptyKey)}</p>
        ) : (
          <>
            {/* Cards on a phone, a table above it: the same rows, one source. */}
            <ul className="divide-y @2xl:hidden" data-testid="deals-cards">
              {visible.map((row) => (
                <li key={row.key}>
                  <Link
                    href={row.href}
                    className="flex gap-3 p-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                  >
                    <VehicleMark kind={row.kind} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-start justify-between gap-2">
                        <span dir="auto" className="min-w-0 truncate font-medium">
                          <bdi>{row.customerName}</bdi>
                        </span>
                        <Badge variant="outline" className={cn("shrink-0 whitespace-nowrap", statusClass(row.statusTone))}>
                          {row.statusLabel}
                        </Badge>
                      </div>
                      <p
                        dir="auto"
                        className="truncate text-sm text-muted-foreground rtl:text-right"
                        title={row.vehicleDesc}
                      >
                        <bdi>{row.vehicleDesc}</bdi>
                      </p>
                      <KindLine row={row} t={t} />
                      {row.reason && <ReasonLine reason={row.reason} t={t} />}
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <OwnerDate row={row} locale={locale} />
                        {row.amountLabel && (
                          <span className="shrink-0 font-medium tabular-nums text-foreground">
                            <bdi dir="ltr">{row.amountLabel}</bdi>
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {/*
              Once the LIST (not the viewport) is wide enough: ONE table whose
              columns appear as the container has room, so a tablet or a
              desktop with the sidebar open folds the reason under the deal
              instead of wrapping every cell. The whole row opens the deal.
            */}
            <div className="hidden @2xl:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="whitespace-nowrap">{t("DealsCustomerVehicleColumn")}</TableHead>
                    <TableHead className="hidden whitespace-nowrap @4xl:table-cell">{t("DealsReasonColumn")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("Status")}</TableHead>
                    <TableHead className="hidden whitespace-nowrap @5xl:table-cell">
                      {t("DealOwner")} · {t("DealsSinceColumn")}
                    </TableHead>
                    {showAmount && <TableHead className="whitespace-nowrap text-end">{t("Amount")}</TableHead>}
                    <TableHead className="w-10">
                      <span className="sr-only">{t("OpenDealRow")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <TableRow
                      key={row.key}
                      data-testid={`deal-row-${row.key}`}
                      className="group relative focus-within:bg-muted/50"
                    >
                      <TableCell className="py-3">
                        <div className="flex items-center gap-3">
                          <VehicleMark kind={row.kind} />
                          <div className="min-w-0 max-w-[18rem] @6xl:max-w-[24rem]">
                            <p dir="auto" className="truncate font-medium rtl:text-right" title={row.customerName}>
                              <bdi>{row.customerName}</bdi>
                            </p>
                            <p
                              dir="auto"
                              className="truncate text-xs text-muted-foreground rtl:text-right"
                              title={row.vehicleDesc}
                            >
                              <bdi>{row.vehicleDesc}</bdi>
                            </p>
                            <KindLine row={row} t={t} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden @4xl:table-cell">
                        {row.reason ? (
                          <div className="max-w-[12rem]">
                            <ReasonLine reason={row.reason} t={t} />
                          </div>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {/* Below the wide columns, the reason and owner · date fold under the status. */}
                        <div className="max-w-[14rem] space-y-1">
                          <Badge variant="outline" className={cn("whitespace-nowrap", statusClass(row.statusTone))}>
                            {row.statusLabel}
                          </Badge>
                          {row.reason && (
                            <div className="@4xl:hidden">
                              <ReasonLine reason={row.reason} t={t} />
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground @5xl:hidden">
                            <OwnerDate row={row} locale={locale} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-sm @5xl:table-cell">
                        <p data-fact="owner" dir="auto" className="max-w-[10rem] truncate rtl:text-right" title={row.salespersonName}>
                          <bdi>{row.salespersonName}</bdi>
                        </p>
                        <p data-fact="date" className="whitespace-nowrap text-xs text-muted-foreground">
                          <bdi>{formatLocalized(row.since, "d MMM yyyy", locale)}</bdi>
                        </p>
                      </TableCell>
                      {showAmount && (
                        <TableCell className="whitespace-nowrap text-end font-medium tabular-nums">
                          {row.amountLabel ? <bdi dir="ltr">{row.amountLabel}</bdi> : ""}
                        </TableCell>
                      )}
                      <TableCell className="text-end">
                        {/* The row's one link; its overlay makes the whole row the target. */}
                        <Link
                          href={row.href}
                          aria-label={`${t("OpenDealRow")}: ${row.customerName}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors after:absolute after:inset-0 after:content-[''] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ChevronRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        {rowsLoaded && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
            <span>
              <bdi dir="ltr">{visible.length}</bdi> {t("DealsShownOf")} <bdi dir="ltr">{loaded.length}</bdi>{" "}
              {t(incomplete ? "DealsLoadedMoreAvailable" : "DealsLoadedAll")}
            </span>
            {incomplete && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loadingMore || !canLoadMore}
                onClick={onLoadMore}
              >
                {t("LoadMore")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
