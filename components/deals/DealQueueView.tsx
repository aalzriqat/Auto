"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import {
  DEAL_STAGE_LABEL,
  DEAL_STATUS_LABEL,
  daysSinceLastActivity,
  stallLevel,
  type StallLevel,
} from "@/lib/deals/queueLabels";

/**
 * THE DEAL QUEUE — "what needs my attention?", answered in one screen.
 *
 * The design decision worth defending: this is NOT another table. The two lists
 * it unifies (`/applications`, `/sales`) are both sortable tables where the
 * operationally decisive fact — what is holding this deal up, and for how long —
 * is either absent or reduced to one narrow column among eight. An operator
 * scanning them has to read every row to find the one that needs work.
 *
 * So the blocker LEADS each row, as a sentence, in the largest type on the row.
 * And the row carries a STALL STRIPE on its inline-start edge whose weight rises
 * with how long the deal has sat. A dealership floor gets triaged the way a
 * service bay does: you look for the job that has not moved. The stripe makes
 * that visible without reading a word — and it encodes a real fact rather than
 * decorating the row, because a deal nobody is waiting on never earns one,
 * however old it is.
 *
 * No money appears here at any permission level. `deals.queue` returns no amount
 * at all, which is deliberate: `applications.list` spreads whole documents and
 * hands financed amounts to anyone holding `view:sales`.
 *
 * Split from its data wrapper for the same reason `DealCockpitView` is — RTL and
 * bidi behaviour is only checkable on rendered output, and a component welded to
 * `useQuery` can only be rendered against whatever happens to be in a deployment.
 */

export const DEAL_QUEUE_VIEWS = [
  { key: "NEEDS_ATTENTION", label: "DealViewNeedsAttention" },
  { key: "ALL", label: "DealViewAll" },
  { key: "WAITING_ON_FINANCE", label: "DealViewWaitingOnFinance" },
  { key: "READY_FOR_HANDOVER", label: "DealViewReadyForHandover" },
  { key: "DEPOSIT_PENDING", label: "DealViewDepositPending" },
  { key: "CASH", label: "DealViewCash" },
  { key: "FINANCED", label: "DealViewFinanced" },
] as const;

export type DealQueueViewKey = (typeof DEAL_QUEUE_VIEWS)[number]["key"];

export interface DealQueueRowData {
  key: string;
  href: string;
  dealKind: "CASH" | "FINANCED";
  anchor: "APPLICATION" | "SALE";
  customerName: string;
  vehicleLabel: string;
  providerName: string | null;
  providerLabelKey: string | null;
  ownerName: string;
  statusKey: string;
  stageKey: string | null;
  blockerKey: string | null;
  needsAttention: boolean;
  depositPending: boolean;
  lastActivityAt: number;
}

export interface DealQueueData {
  rows: DealQueueRowData[];
  counts: Record<string, number>;
  truncated: boolean;
  limit: number;
}

/**
 * The stripe. Three levels, and the quiet one is genuinely quiet — if every row
 * is coloured then none of them is a signal.
 */
const STALL_STRIPE: Record<StallLevel, string> = {
  FRESH: "border-s-border",
  ATTENTION: "border-s-amber-500",
  URGENT: "border-s-destructive",
};

const STALL_TEXT: Record<StallLevel, string> = {
  FRESH: "text-muted-foreground",
  ATTENTION: "text-amber-700 dark:text-amber-400",
  URGENT: "text-destructive",
};

/**
 * What the row's headline says, and whether it describes outstanding work.
 *
 * Order matters, and the deposit case is the reason this is a function rather
 * than a ternary. A REJECTED deal has a fully STOPPED rail — no live stage, no
 * blocker — so it fell through to "nothing outstanding" while the same row
 * rendered a "deposit pending" badge two lines below. The screen contradicted
 * itself, and a held deposit is money owed to a real customer, which is
 * precisely the thing a dead deal makes easy to forget.
 *
 * This is presentation, not a second derivation: the blocker still comes from
 * the server's stage rail, and the deposit fact is the server's too. All this
 * decides is which of the facts it was given leads the row.
 */
function primaryLine(row: DealQueueRowData): { key: string; outstanding: boolean } {
  if (row.blockerKey) return { key: `Blocker${row.blockerKey}`, outstanding: true };
  if (row.depositPending) return { key: "DealDepositAwaitingResolution", outstanding: true };
  if (row.stageKey) {
    return { key: DEAL_STAGE_LABEL[row.stageKey] ?? row.stageKey, outstanding: true };
  }
  return { key: "DealNoOpenStep", outstanding: false };
}

export function DealQueueView({
  data,
  view,
  onViewChange,
  now,
}: Readonly<{
  data: DealQueueData | undefined;
  view: DealQueueViewKey;
  onViewChange: (view: DealQueueViewKey) => void;
  /**
   * The clock, passed in rather than read here.
   *
   * Waiting durations are derived from it, and reading `Date.now()` during
   * render makes the server and client disagree by however long the request
   * took — React reports that as a hydration error and the row flickers.
   * `null` means "not known yet", and durations are withheld rather than
   * guessed at.
   */
  now: number | null;
}>) {
  const { t, isRtl } = useLanguage();
  const Chevron = isRtl ? ChevronLeft : ChevronRight;

  return (
    <div className="flex-1 space-y-6 p-4 pt-6 md:p-8">
      {/* --- header: what this screen is for, said once ------------------- */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("DealsQueueTitle")}</h1>
        <p className="max-w-prose text-sm text-muted-foreground">{t("DealsQueueSubtitle")}</p>
      </div>

      {/* --- saved views -------------------------------------------------- */}
      {/* A scrolling strip rather than a Select: on a phone the operator's own
          view is usually one tap away, and burying seven short labels behind a
          dropdown costs a tap on every single visit. */}
      {/* A group of toggle buttons, NOT a tablist.
          The first version declared `role="tablist"` with `role="tab"` children,
          which promises the ARIA tabs pattern: arrow-key navigation, a roving
          tabindex, and a `tabpanel` the tabs control. None of that exists here.
          A screen-reader user would have been told this was a tab widget and
          then found the arrow keys dead — a worse outcome than plain buttons.
          These are filters over one list, so they are pressed, not selected. */}
      <div
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0"
        role="group"
        aria-label={t("DealsQueueTitle")}
      >
        {DEAL_QUEUE_VIEWS.map((entry) => {
          const active = entry.key === view;
          const count = data?.counts?.[entry.key];
          return (
            <button
              key={entry.key}
              type="button"
              aria-pressed={active}
              onClick={() => onViewChange(entry.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {t(entry.label as never)}
              {count !== undefined && (
                <span
                  className={`text-xs tabular-nums ${active ? "text-primary" : "text-muted-foreground/70"}`}
                >
                  <bdi>{count}</bdi>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* --- the queue ---------------------------------------------------- */}
      {/* Three sibling conditions rather than a ternary chain: loading, empty
          and populated are three distinct answers to "what is on the floor",
          and one of them must never be reachable by falling through another. */}
      {data === undefined && (
        <div className="space-y-px overflow-hidden rounded-lg border" data-testid="deal-queue-loading">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="space-y-2 p-4">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          ))}
        </div>
      )}

      {data !== undefined && data.rows.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center">
          <Inbox className="h-6 w-6 text-muted-foreground" aria-hidden />
          <p className="font-medium">{t("DealsQueueEmptyTitle")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {view === "NEEDS_ATTENTION"
              ? t("DealsQueueEmptyNeedsAttention")
              : t("DealsQueueEmptyView")}
          </p>
        </div>
      )}

      {data !== undefined && data.rows.length > 0 && (
        <div className="divide-y overflow-hidden rounded-lg border">
          {data.rows.map((row) => {
            const level = stallLevel({
              lastActivityAt: row.lastActivityAt,
              needsAttention: row.needsAttention,
              now: now ?? row.lastActivityAt,
            });
            const days = now === null ? null : daysSinceLastActivity(row.lastActivityAt, now);
            const primary = primaryLine(row);

            /**
             * How long the deal has been SILENT.
             *
             * Deliberately not "waiting": `lastActivityAt` is the last time
             * anything on the deal moved, not when the current step began, and
             * no such timestamp exists in the model. A row reading "6 days
             * waiting" put a precise claim on a number that does not carry it.
             * "Nobody has touched this in 6 days" is both true and the thing an
             * operator triaging a floor actually needs.
             *
             * Nothing at all until the clock is known — a duration guessed
             * during server render disagrees with the client by however long the
             * request took, and React reports that as a hydration error.
             */
            let silence: ReactNode = "";
            if (days === 0) {
              silence = t("DealActivityToday");
            } else if (days !== null) {
              silence = (
                <>
                  <bdi>{days}</bdi> {t(days === 1 ? "DealDayNoActivity" : "DealDaysNoActivity")}
                </>
              );
            }

            return (
              <Link
                key={row.key}
                href={row.href}
                data-testid="deal-queue-row"
                data-stall={level}
                className={`group flex items-start gap-3 border-s-[3px] p-4 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none ${STALL_STRIPE[level]}`}
              >
                <div className="min-w-0 flex-1 space-y-1.5">
                  {/* THE ANSWER. The largest text on the row, because it is the
                      only thing that decides whether the operator opens it.
                      A finished deal's line is muted and normal-weight: it is
                      still said, but it must not out-shout the rows that carry
                      real work. */}
                  <p
                    className={
                      primary.outstanding
                        ? "font-medium leading-snug"
                        : "leading-snug text-muted-foreground"
                    }
                  >
                    {t(primary.key as never)}
                  </p>

                  {/* Who, and what car. Two lines on a phone, one on desktop.
                      Joining them with a separator made "Kia Sportage 2023" wrap
                      after "Sportage" at 390px, splitting a vehicle label across
                      lines — and an Arabic customer name beside a Latin label
                      beside a year is exactly the bidi case that reorders into
                      nonsense when left as a single run, so each is its own
                      `<bdi>`. */}
                  {/* `items-start` is load-bearing, not tidiness. Each name is
                      its own `<bdi>`, so an all-Arabic customer name is an RTL
                      run — and as a stretched flex item in an LTR page it
                      aligned its own text to the right, leaving the customer
                      floating mid-row above a left-aligned vehicle label. Only
                      visible by rendering the English layout with Arabic data,
                      which is the ordinary case for this dealership. */}
                  <p className="flex flex-col items-start gap-x-1.5 text-sm text-muted-foreground sm:flex-row sm:flex-wrap">
                    <bdi>{row.customerName || t("UnknownCustomer")}</bdi>
                    {row.vehicleLabel && (
                      <span className="flex gap-x-1.5">
                        <span aria-hidden className="hidden sm:inline">
                          ·
                        </span>
                        <bdi>{row.vehicleLabel}</bdi>
                      </span>
                    )}
                  </p>

                  {/* Quiet metadata. Deliberately the smallest thing on the row:
                      it identifies the deal, it never triages it.
                      Separated by dots — rendered without them, the provider,
                      the status and the owner ran together as one ambiguous
                      string, and in Arabic there was no way to tell which name
                      was the finance company and which was the salesperson. */}
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                    <span className="rounded border px-1.5 py-0.5">
                      {t(row.dealKind === "CASH" ? "DealKindCash" : "DealKindFinanced")}
                    </span>
                    {/* Each separator travels INSIDE the span of the item it
                        precedes. Emitted as siblings they wrapped independently,
                        so a line could end on a dangling "·" with its value
                        alone on the next line. */}
                    {(row.providerName || row.providerLabelKey) && (
                      <span className="flex gap-x-1.5">
                        <span aria-hidden>·</span>
                        <bdi>{row.providerName ?? t(row.providerLabelKey as never)}</bdi>
                      </span>
                    )}
                    <span className="flex gap-x-1.5">
                      <span aria-hidden>·</span>
                      <span>{t((DEAL_STATUS_LABEL[row.statusKey] ?? row.statusKey) as never)}</span>
                    </span>
                    {row.ownerName && (
                      <span className="flex gap-x-1.5">
                        <span aria-hidden>·</span>
                        <bdi>{row.ownerName}</bdi>
                      </span>
                    )}
                    {row.depositPending && (
                      <span className="rounded border border-amber-500/60 bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
                        {t("DepositPending")}
                      </span>
                    )}
                  </p>
                </div>

                {/* Silence, and the chevron that says the row opens. */}
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  <span className={`max-w-24 text-end text-xs tabular-nums ${STALL_TEXT[level]}`}>
                    {silence}
                  </span>
                  <Chevron
                    className="h-4 w-4 text-muted-foreground/50 transition-colors group-hover:text-foreground"
                    aria-hidden
                  />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* --- truncation, stated rather than swallowed --------------------- */}
      {/* A worklist that silently stops at its scan limit reads as "you are
          done", which is the most expensive lie this screen could tell. */}
      {data?.truncated && (
        // `<output>` rather than `role="status"`: it carries the live-region
        // role natively, and screen readers reach it on devices where the bare
        // ARIA attribute is unreliable. This is the one message on the screen an
        // operator must not miss, so it announces itself.
        <output className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{t("DealsQueueTruncated").replace("{limit}", String(data.limit))}</span>
        </output>
      )}
    </div>
  );
}
