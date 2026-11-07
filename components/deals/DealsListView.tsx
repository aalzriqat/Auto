"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefCallback } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AlertTriangle, Banknote, CarFront, ChevronRight, Lock, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLocalized } from "@/lib/dateLocale";
import { formatExactMinorAmount } from "@/lib/moneyDisplay";
import { cn } from "@/lib/utils";
import { formatDealNumber, parseDealNumberQuery } from "@/convex/utils/dealNumberFormat";
import type { DealListRowFigures } from "@/convex/dealListRow";
import { MoneySurfaceErrorBoundary } from "@/components/accounting/MoneySurfaceErrorBoundary";
import { currentDealStep, type DealStep } from "./dealRows";

/**
 * The Deals list — one entry per canonical deal, cash or financed, opening the
 * ONE deal screen (SCRUM-215, owner design direction c19384).
 *
 * Signature: the list is a NEEDS-ACTION QUEUE first and a register second.
 * Every row states why it is waiting and on whom, and — since the owner's
 * rich-row direction — what the deal IS at a glance, in this order: the car
 * (photo, name, deal number), the customer, how it is paid for (cash, the
 * financier, and whether the car is on consignment), the step it is on, its
 * status, who owns it and since when, the selling price and the net profit.
 *
 * Where each fact comes from, and what it is NOT:
 *  - The queue reasons are derived from facts the list queries already serve
 *    (status, a held deposit, a named financier, a receipt, the route). Nothing
 *    here computes a blocker the server has not stated.
 *  - The photo, consignment, step, financed selling price and net profit are
 *    the deal cockpit's own read model, served per row by `dealListRow.figures`
 *    — the step is the cockpit's live stage, the profit is the cockpit's
 *    headline, gated on the server (`view:cost_price`, SCRUM-902). The view
 *    never computes either; a withheld figure is "—" with the reason, never 0.
 *  - Every count is a count of LOADED rows, labelled so while more can load.
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
  /** The selling price the LIST serves (a sale's price), formatted; null where the cockpit serves it instead. */
  amountLabel: string | null;
  /** SCRUM-808: the issued per-organization deal number; absent on a deal the backfill has not reached. */
  dealNumber?: number;
  /** The record the deal screen is keyed by — what the row's cockpit facts are read for. */
  source: { kind: "APPLICATION" | "SALE"; id: string };
};

/** A row's cockpit facts: `undefined` while loading, `null` when the server served none. */
export type RowFigures = DealListRowFigures | null | undefined;

/**
 * How a row gets its cockpit facts. A hook supplied by the page (the live one
 * subscribes to `dealListRow.figures`); `enabled` is false until the row is
 * near the viewport, so a long list reads only the deals somebody can see.
 * The default serves nothing, which renders every cockpit fact as unavailable.
 */
export type UseDealRowFigures = (row: DealRow, enabled: boolean) => RowFigures;

const useNoRowFigures: UseDealRowFigures = () => null;

export const DealRowFiguresContext = createContext<UseDealRowFigures>(useNoRowFigures);

/** A failed subscription uses the same localized row state as a null response. */
function RowFiguresBoundary({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <MoneySurfaceErrorBoundary
      fallback={<DealRowFiguresContext.Provider value={useNoRowFigures}>{children}</DealRowFiguresContext.Provider>}
    >
      {children}
    </MoneySurfaceErrorBoundary>
  );
}

/** Turns a cockpit minor amount into display text; the page supplies the org's formatter. */
export type FormatMinor = (amountMinor: number, currency: string) => string;

const defaultFormatMinor: FormatMinor = (amountMinor, currency) =>
  `${formatExactMinorAmount(amountMinor, currency)} ${currency}`;

/**
 * Whether the row has come near the viewport. Once true it stays true, so a row
 * scrolled past keeps its subscription rather than re-reading on every scroll.
 * Without IntersectionObserver (a test DOM, an old engine) every row is near.
 */
function useNearViewport<T extends Element>(): [RefCallback<T>, boolean] {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const ref = useCallback(
    (node: T | null) => {
      if (near || node === null || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setNear(true);
            observer.disconnect();
          }
        },
        { rootMargin: "200px" }
      );
      observer.observe(node);
      return () => observer.disconnect();
    },
    [near]
  );
  return [ref, near];
}

/** The deal number, kept left-to-right inside Arabic text. */
function DealNumberTag({ value }: Readonly<{ value: number | undefined }>) {
  const label = formatDealNumber(value);
  if (label === null) return null;
  return (
    <bdi dir="ltr" className="font-mono text-xs font-semibold tabular-nums text-foreground" data-testid="deal-row-number">
      {label}
    </bdi>
  );
}

/** The row link's name: customers repeat, so the car and the deal number tell two of their deals apart. */
function rowLinkName(row: DealRow, t: (key: string) => string): string {
  return [`${t("OpenDealRow")}: ${row.customerName}`, row.vehicleDesc, formatDealNumber(row.dealNumber)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The search box matches a typed deal number ("123", "D-000123", Arabic digits) exactly, never as a substring, so
 * "123" does not find deal 1234; the text fields still match as substrings ("2024" still finds a 2024 car).
 */
function matchesSearch(row: DealRow, needle: string, dealNumber: number | null): boolean {
  if (dealNumber !== null && row.dealNumber === dealNumber) return true;
  return [row.customerName, row.vehicleDesc, row.financierLabel ?? "", row.salespersonName]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

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

/** Why a figure is not shown, by the reason the server gave. Anything else reads "not calculable yet". */
const WITHHELD_REASON_LABEL: Record<string, string> = {
  CostAccessRequired: "DealsFigureNeedsCostAccess",
  FinanceAccessRequired: "DealsFigureNeedsFinanceAccess",
  // The server served no facts for the row (an unreadable or missing deal): said so, not "not calculable".
  RowUnavailable: "DealsRowDetailsUnavailable",
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
 * The row's anchor: the car's own photo when the server serves one (only to a
 * caller who may view vehicles), otherwise the car mark with the deal's kind on
 * it. A photo that fails to load falls back to the mark, never a broken image.
 */
function VehicleThumb({
  kind,
  photoUrl,
  className,
}: Readonly<{ kind: DealKind; photoUrl: string | null; className?: string }>) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const shown = photoUrl && photoUrl !== failedUrl ? photoUrl : null;
  let tone = "bg-muted";
  if (!shown) tone = kind === "FINANCED" ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  return (
    <span
      className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-md", tone, className)}
      aria-hidden
    >
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- Convex storage URLs have no stable dimensions; the frame fixes the size.
        <img
          src={shown}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailedUrl(shown)}
          data-testid="deal-row-photo"
        />
      ) : (
        <>
          <CarFront className="h-5 w-5" />
          {kind === "CASH" && <Banknote className="absolute bottom-0.5 end-0.5 h-3.5 w-3.5 rounded-sm bg-background p-px" />}
        </>
      )}
    </span>
  );
}

function ReasonLine({ reason, t }: Readonly<{ reason: DealReason; t: (key: string) => string }>) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", REASON_TONE[reason])} aria-hidden />
      <span className="truncate">{t(REASON_LABEL[reason])}</span>
    </span>
  );
}

/** A SOURCED (consignment) car, by the cockpit's own classifier. */
function ConsignedTag({ t, className }: Readonly<{ t: (key: string) => string; className?: string }>) {
  return (
    <span
      data-fact="consigned"
      className={cn(
        "shrink-0 whitespace-nowrap rounded border border-amber-600/40 bg-amber-500/10 px-1 text-[0.6875rem] font-normal leading-4 text-amber-800 dark:text-amber-200",
        className
      )}
    >
      {t("DealsConsignedTag")}
    </span>
  );
}

/**
 * How the deal is paid for, written (the photo/mark is decorative): cash, or
 * the financier, and a consignment tag on a SOURCED car. The kind never
 * truncates; a long financier does, with its full name on hover.
 */
function KindLine({
  row,
  consigned,
  t,
  className,
}: Readonly<{ row: DealRow; consigned: boolean; t: (key: string) => string; className?: string }>) {
  return (
    <p className={cn("flex min-w-0 items-center gap-1 text-xs text-muted-foreground", className)}>
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
      {consigned && <ConsignedTag t={t} className="ms-1" />}
    </p>
  );
}

/** The cockpit's live step, a done/stopped mark, a loading shimmer, or a dash when the server served none. */
function StepLine({ step, loading, t }: Readonly<{ step: DealStep | null; loading: boolean; t: (key: string) => string }>) {
  if (loading) {
    return (
      <span className="block h-4 w-24 animate-pulse rounded bg-muted" data-fact="step-loading">
        <span className="sr-only">{t("DealsFigureLoading")}</span>
      </span>
    );
  }
  if (step === null) return <span className="text-sm text-muted-foreground">—</span>;
  if (step.kind === "LIVE") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm" data-fact="step" data-blocked={step.blocked || undefined}>
        {/* Blocked is a shape as well as a colour: the cockpit's own warning mark. */}
        {step.blocked ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
        )}
        <span className="truncate" title={t(step.labelKey)}>
          {t(step.labelKey)}
        </span>
        {step.blocked && <span className="sr-only">({t("StageStateBlocked")})</span>}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground" data-fact="step">
      <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" aria-hidden />
      <span className="truncate">{t(step.kind === "DONE" ? "DealsStepDone" : "StageStateStopped")}</span>
    </span>
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

/** A money figure, or the reason it is not shown — "—" with a short hint, never a zero. */
function Figure({
  value,
  reason,
  loading,
  negative,
  t,
}: Readonly<{ value: string | null; reason: string | null; loading: boolean; negative?: boolean; t: (key: string) => string }>) {
  if (loading) {
    return (
      <span className="ms-auto block h-4 w-16 animate-pulse rounded bg-muted">
        <span className="sr-only">{t("DealsFigureLoading")}</span>
      </span>
    );
  }
  if (value !== null) {
    // The number (and its sign) is its own left-to-right run, the currency label its own: an
    // Arabic label never pulls the minus sign or the digits out of order.
    const [amount, ...label] = value.split(" ");
    return (
      <span className={cn("whitespace-nowrap font-medium tabular-nums", negative && "text-destructive")}>
        <bdi dir="ltr">{amount}</bdi>
        {label.length > 0 && <> <bdi>{label.join(" ")}</bdi></>}
      </span>
    );
  }
  const hint = t(WITHHELD_REASON_LABEL[reason ?? ""] ?? "DealsFigureNotCalculable");
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground" title={hint} data-fact="figure-withheld">
      {reason === "CostAccessRequired" && <Lock className="h-3 w-3" aria-hidden />}
      <span aria-hidden>—</span>
      <span className="sr-only">{hint}</span>
    </span>
  );
}

/** Everything a row renders from its cockpit facts, resolved once for the card and the table row alike. */
function useRowFacts(row: DealRow, enabled: boolean, formatMinor: FormatMinor) {
  const useFigures = useContext(DealRowFiguresContext);
  const figures = useFigures(row, enabled);
  const loading = figures === undefined;
  const served = figures ?? null;
  const price =
    row.amountLabel ??
    (served?.sellingPriceMinor != null && served.currency ? formatMinor(served.sellingPriceMinor, served.currency) : null);
  const profit =
    served?.netProfitMinor != null && served.currency ? formatMinor(served.netProfitMinor, served.currency) : null;
  return {
    loading,
    photoUrl: served?.photoUrl ?? null,
    consigned: served?.consigned === true,
    step: served ? currentDealStep(served.stages) : null,
    price,
    // A list-served price never waits on the cockpit read.
    priceLoading: loading && row.amountLabel === null,
    priceReason: served ? served.sellingPriceReason : "RowUnavailable",
    profit,
    profitNegative: (served?.netProfitMinor ?? 0) < 0,
    profitReason: served ? served.netProfitReason : "RowUnavailable",
  };
}

type RowFacts = ReturnType<typeof useRowFacts>;

function NetProfitFigure({ facts, t }: Readonly<{ facts: RowFacts; t: (key: string) => string }>) {
  return (
    <Figure
      value={facts.profit}
      reason={facts.profitReason}
      loading={facts.loading}
      negative={facts.profitNegative}
      t={t}
    />
  );
}

type RowProps = Readonly<{
  row: DealRow;
  t: (key: string) => string;
  locale?: string;
  formatMinor: FormatMinor;
  showNetProfit: boolean;
}>;

type PresentationProps = Omit<RowProps, "formatMinor"> & { facts: RowFacts };

/** One read and one latched near state for both responsive presentations. */
function DealPresentations({ tableTarget, ...props }: RowProps & { tableTarget: HTMLTableRowElement }) {
  const [ref, near] = useNearViewport<Element>();
  useEffect(() => ref(tableTarget), [ref, tableTarget]);
  const facts = useRowFacts(props.row, near, props.formatMinor);
  return (
    <>
      <DealCard {...props} facts={facts} ref={ref} />
      {createPortal(<DealTableCells {...props} facts={facts} />, tableTarget)}
    </>
  );
}

/** Ordered DOM slots keep table order stable when filtering or live sorting changes. */
function DealTableSlot({ row, onTarget }: Readonly<{
  row: DealRow;
  onTarget: (identity: string, node: HTMLTableRowElement | null) => void;
}>) {
  const identity = `${row.href}:${row.key}`;
  const ref = useCallback((node: HTMLTableRowElement | null) => onTarget(identity, node), [identity, onTarget]);
  return <TableRow ref={ref} data-testid={`deal-row-${row.key}`} className="group relative focus-within:bg-muted/50" />;
}

/** A phone card: the car first, then who and how, the step, and the two figures in a footer. */
function DealCard({ row, t, locale, showNetProfit, facts, ref }: PresentationProps & { ref: RefCallback<Element> }) {
  return (
    <li ref={ref} data-testid={`deal-card-${row.key}`}>
      <Link
        href={row.href}
        className="block space-y-2 p-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
      >
        <div className="flex gap-3">
          <VehicleThumb kind={row.kind} photoUrl={facts.photoUrl} className="h-12 w-16" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-start justify-between gap-2">
              <span dir="auto" className="min-w-0 truncate font-medium" title={row.vehicleDesc}>
                <bdi>{row.vehicleDesc}</bdi>
              </span>
              <Badge variant="outline" className={cn("shrink-0 whitespace-nowrap", statusClass(row.statusTone))}>
                {row.statusLabel}
              </Badge>
            </div>
            <p className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
              <DealNumberTag value={row.dealNumber} />
              {row.dealNumber !== undefined && <span aria-hidden>·</span>}
              <span dir="auto" className="min-w-0 truncate text-foreground" title={row.customerName}>
                <bdi>{row.customerName}</bdi>
              </span>
            </p>
            <KindLine row={row} consigned={facts.consigned} t={t} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <StepLine step={facts.step} loading={facts.loading} t={t} />
          </div>
          <div className="min-w-0 max-w-[50%] text-xs text-muted-foreground">
            <OwnerDate row={row} locale={locale} />
          </div>
        </div>
        {row.reason && <ReasonLine reason={row.reason} t={t} />}
        <dl className={cn("grid gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs", showNetProfit ? "grid-cols-2" : "grid-cols-1")}>
          <div className="min-w-0">
            <dt className="truncate text-muted-foreground">{t("DealsSellingPriceColumn")}</dt>
            <dd className="text-sm">
              <Figure value={facts.price} reason={facts.priceReason} loading={facts.priceLoading} t={t} />
            </dd>
          </div>
          {showNetProfit && (
            <div className="min-w-0" data-fact="net-profit">
              <dt className="truncate text-muted-foreground">{t("DealsNetProfitColumn")}</dt>
              <dd className="text-sm">
                <NetProfitFigure facts={facts} t={t} />
              </dd>
            </div>
          )}
        </dl>
      </Link>
    </li>
  );
}

/**
 * A table row. Columns appear as the LIST (not the viewport) has room: the
 * financing always sits under the customer; below `@6xl` the net profit sits
 * under the selling price; below `@7xl` the owner and date fold under the
 * status — so a tablet or a desktop with the sidebar open never wraps a cell
 * or scrolls the table. The whole row opens the deal through its one link.
 */
function DealTableCells({ row, t, locale, showNetProfit, facts }: PresentationProps) {
  return (
    <>
      <TableCell className="py-2.5">
        <div className="flex items-center gap-2.5">
          <VehicleThumb kind={row.kind} photoUrl={facts.photoUrl} className="h-9 w-12" />
          <div className="min-w-0 max-w-[9rem] @6xl:max-w-[12rem] @7xl:max-w-[15rem]">
            <p dir="auto" className="truncate font-medium rtl:text-right" title={row.vehicleDesc}>
              <bdi>{row.vehicleDesc}</bdi>
            </p>
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <DealNumberTag value={row.dealNumber} />
              {facts.consigned && <ConsignedTag t={t} />}
            </p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <div className="min-w-0 max-w-[8rem] @6xl:max-w-[11rem] @7xl:max-w-[13rem]">
          <p dir="auto" className="truncate text-sm rtl:text-right" title={row.customerName}>
            <bdi>{row.customerName}</bdi>
          </p>
          {/* The consignment tag sits with the car in the table, where the line has room for the financier. */}
          <KindLine row={row} consigned={false} t={t} />
        </div>
      </TableCell>
      <TableCell>
        <div className="max-w-[8rem] space-y-0.5 @6xl:max-w-[11rem]">
          <StepLine step={facts.step} loading={facts.loading} t={t} />
          {row.reason && <ReasonLine reason={row.reason} t={t} />}
        </div>
      </TableCell>
      <TableCell>
        <div className="max-w-[10rem] space-y-1">
          <Badge variant="outline" className={cn("whitespace-nowrap", statusClass(row.statusTone))}>
            {row.statusLabel}
          </Badge>
          <div className="text-xs text-muted-foreground @7xl:hidden">
            <OwnerDate row={row} locale={locale} />
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden text-sm @7xl:table-cell">
        <p data-fact="owner" dir="auto" className="max-w-[10rem] truncate rtl:text-right" title={row.salespersonName}>
          <bdi>{row.salespersonName}</bdi>
        </p>
        <p data-fact="date" className="whitespace-nowrap text-xs text-muted-foreground">
          <bdi>{formatLocalized(row.since, "d MMM yyyy", locale)}</bdi>
        </p>
      </TableCell>
      <TableCell className="text-end text-sm">
        <Figure value={facts.price} reason={facts.priceReason} loading={facts.priceLoading} t={t} />
        {/* Below @6xl the net profit sits under the price in this one column. */}
        {showNetProfit && (
          <div className="text-xs @6xl:hidden" data-fact="net-profit">
            <NetProfitFigure facts={facts} t={t} />
          </div>
        )}
      </TableCell>
      {showNetProfit && (
        <TableCell className="hidden text-end text-sm @6xl:table-cell" data-fact="net-profit">
          <NetProfitFigure facts={facts} t={t} />
        </TableCell>
      )}
      <TableCell className="w-10 text-end">
        {/* The row's one link; its overlay makes the whole row the target. */}
        <Link
          href={row.href}
          aria-label={rowLinkName(row, t)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors after:absolute after:inset-0 after:content-[''] group-hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden />
        </Link>
      </TableCell>
    </>
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
  formatMinor = defaultFormatMinor,
  showNetProfit = true,
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
  /** Formats a cockpit minor amount with the org's currency label. */
  formatMinor?: FormatMinor;
  /**
   * Whether the net-profit column is laid out at all. A layout choice for a
   * caller who could never be served it — the SERVER still withholds the figure
   * from any caller without `view:cost_price`, whatever this says.
   */
  showNetProfit?: boolean;
}>) {
  const [view, setView] = useState<View>("needs");
  const [reason, setReason] = useState<DealReason | null>(null);
  const [kind, setKind] = useState<DealKind | null>(null);
  const [search, setSearch] = useState("");
  const [tableTargets, setTableTargets] = useState<ReadonlyMap<string, HTMLTableRowElement>>(() => new Map());
  const onTableTarget = useCallback((identity: string, node: HTMLTableRowElement | null) => {
    setTableTargets((current) => {
      const next = new Map(current);
      if (node) next.set(identity, node);
      else next.delete(identity);
      return next;
    });
  }, []);

  const loaded = useMemo(() => rows ?? [], [rows]);
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
    const typedDealNumber = parseDealNumberQuery(search);
    return loaded
      .filter((row) =>
        view === "needs" ? row.waitingOn === "DEALERSHIP" : view === "waiting" ? row.waitingOn === "OTHERS" : true
      )
      .filter((row) => (view === "needs" && reason ? row.reason === reason : true))
      .filter((row) => (kind ? row.kind === kind : true))
      .filter((row) => (needle ? matchesSearch(row, needle, typedDealNumber) : true))
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
  let emptyKey = "NoDealsFound";
  if (view === "needs" && !filtersActive) emptyKey = incomplete ? "DealsQueueEmptyLoadedOnly" : "DealsQueueEmpty";
  const rowProps = { t, locale, formatMinor, showNetProfit };

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

      <div className="@container rounded-md border bg-card">
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
          <output className="block p-6 text-center text-sm text-muted-foreground">{t("LoadingDeals")}</output>
        ) : visible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t(emptyKey)}</p>
        ) : (
          <>
            {/* Cards on a phone, a table above it: the same rows, one source. */}
            <ul className="divide-y @3xl:hidden" data-testid="deals-cards">
              {visible.map((row) => {
                const identity = `${row.href}:${row.key}`;
                const tableTarget = tableTargets.get(identity);
                return tableTarget ? (
                  <RowFiguresBoundary key={identity}>
                    <DealPresentations row={row} {...rowProps} tableTarget={tableTarget} />
                  </RowFiguresBoundary>
                ) : null;
              })}
            </ul>
            <div className="hidden @3xl:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="whitespace-nowrap">{t("DealsCarColumn")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("DealsCustomerColumn")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("DealsStepColumn")}</TableHead>
                    <TableHead className="whitespace-nowrap">{t("Status")}</TableHead>
                    <TableHead className="hidden whitespace-nowrap @7xl:table-cell">
                      {t("DealOwner")} · {t("DealsSinceColumn")}
                    </TableHead>
                    <TableHead className="whitespace-nowrap text-end">
                      {t("DealsSellingPriceColumn")}
                      {showNetProfit && (
                        <span className="block text-xs font-normal @6xl:hidden">{t("DealsNetProfitColumn")}</span>
                      )}
                    </TableHead>
                    {showNetProfit && (
                      <TableHead className="hidden whitespace-nowrap text-end @6xl:table-cell">
                        {t("DealsNetProfitColumn")}
                      </TableHead>
                    )}
                    <TableHead className="w-10">
                      <span className="sr-only">{t("OpenDealRow")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => (
                    <DealTableSlot key={`${row.href}:${row.key}`} row={row} onTarget={onTableTarget} />
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
