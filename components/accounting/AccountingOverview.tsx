"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { CheckCircle2, ChevronLeft, ChevronRight, Inbox, XCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LoadingAccountingState } from "./AccountingTabShared";
import { periodLabel, periodStatusClassName } from "./setup/types";
import { ACCOUNTING_SECTIONS, type AccountingSectionId } from "./accountingSections";

type AccountingSetupStatus = FunctionReturnType<typeof api.accountingSetup.status>;

type Translate = (key: string) => string;

/** `tone`: a setup blocker stops every posting; a pending event may still be retried. */
type AttentionItem = {
  key: string;
  tone: "blocker" | "pending";
  title: ReactNode;
  detail: ReactNode;
  section: AccountingSectionId;
};

function chartReady(status: AccountingSetupStatus): boolean {
  return status.chartInitialized && status.systemAccountsValid;
}

/** Setup blockers plus the pending sample — counted without building the rows. */
function attentionCount(status: AccountingSetupStatus): number {
  return (chartReady(status) ? 0 : 1) + (status.currentOpenPeriod === null ? 1 : 0) + status.pendingEvents.length;
}

/** The server caps the pending sample, so a capped list reads "10+", never an exact count. */
function attentionCountLabel(status: AccountingSetupStatus): string | null {
  const count = attentionCount(status);
  if (count === 0) return null;
  return status.hasMorePendingEvents ? `${count}+` : String(count);
}

/**
 * Setup blockers first, then the pending events exactly as the server
 * returned them. Nothing here is computed from balances.
 */
function buildAttentionItems(status: AccountingSetupStatus, t: Translate, localeCode: string): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (!chartReady(status)) {
    items.push({
      key: "chart",
      tone: "blocker",
      title: t("ChartOfAccounts"),
      detail:
        status.chartInitialized && status.missingSystemAccountKeys.length > 0
          ? `${t("MissingSystemAccounts")}: ${status.missingSystemAccountKeys.join(", ")}`
          : t("ChartOfAccountsNeedsSetup"),
      section: "settings",
    });
  }

  if (status.currentOpenPeriod === null) {
    items.push({
      key: "period",
      tone: "blocker",
      title: t("AccountingPeriod"),
      detail: t("NoCurrentOpenPeriod"),
      section: "reconcile",
    });
  }

  for (const event of status.pendingEvents) {
    items.push({
      key: event._id,
      tone: "pending",
      // One LTR run, or Arabic prose reorders "TYPE · source: id".
      title: (
        <bdi dir="ltr">
          {event.eventType ?? event.kind}
          <span className="font-normal text-muted-foreground">
            {" · "}
            {event.sourceType}: {event.sourceId}
          </span>
        </bdi>
      ),
      detail: (
        <>
          <bdi>{new Date(event.accountingDate).toLocaleDateString(localeCode)}</bdi>
          {" · "}
          {t("Attempts")}: <bdi dir="ltr">{event.attempts}</bdi>
          {event.reason ? (
            <>
              {" · "}
              <bdi>{event.reason}</bdi>
            </>
          ) : null}
        </>
      ),
      section: "reconcile",
    });
  }

  return items;
}

function sectionLabel(section: AccountingSectionId, t: Translate): string {
  return t(ACCOUNTING_SECTIONS.find((item) => item.id === section)?.labelKey ?? "");
}

/**
 * Landing section of the Accounting workspace.
 *
 * Deliberately reads only what the Setup tab already reads
 * (`accountingSetup.status`) and restates it exception-first: what blocks
 * the books, then the readiness signals and the most recent periods, then
 * the section directory. It shows no balances, totals or exception counts
 * of its own — those belong to the sections that own them.
 */
export function AccountingOverview({
  onNavigate,
}: Readonly<{ onNavigate: (section: AccountingSectionId) => void }>) {
  const { activeOrgId } = useOrg();
  const { t, isRtl, locale } = useLanguage();
  const setupStatus = useQuery(
    api.accountingSetup.status,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  if (!activeOrgId) return null;
  if (setupStatus === undefined) return <LoadingAccountingState label={t("Loading")} />;

  const chartOk = chartReady(setupStatus);
  const pendingCount = setupStatus.pendingEvents.length;
  const Chevron = isRtl ? ChevronLeft : ChevronRight;
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";
  const attention = buildAttentionItems(setupStatus, t, localeCode);
  const countLabel = attentionCountLabel(setupStatus);
  const recentPeriods = setupStatus.recentPeriods.slice(0, 4);

  const readiness: ReadonlyArray<{ key: string; title: string; detail: ReactNode; ready: boolean }> = [
    {
      key: "chart",
      title: t("ChartOfAccounts"),
      detail: chartOk ? t("ChartOfAccountsReady") : t("ChartOfAccountsNeedsSetup"),
      ready: chartOk,
    },
    {
      key: "period",
      title: t("AccountingPeriod"),
      detail: setupStatus.currentOpenPeriod ? (
        <>
          {t("OpenPeriod")}: <bdi dir="ltr">{periodLabel(setupStatus.currentOpenPeriod)}</bdi>
        </>
      ) : (
        t("NoCurrentOpenPeriod")
      ),
      ready: setupStatus.currentOpenPeriod !== null,
    },
    {
      key: "events",
      title: t("PendingAccountingEvents"),
      detail: pendingCount === 0 ? t("NoPendingAccountingEvents") : t("PendingAccountingEventsNeedAttention"),
      ready: pendingCount === 0,
    },
  ];

  const sections = ACCOUNTING_SECTIONS.filter((section) => section.id !== "overview");

  return (
    <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-start">
      <section aria-labelledby="accounting-attention-heading" className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="accounting-attention-heading" className="text-base font-semibold text-foreground">
            {t("AccountingNeedsAttention")}
            {countLabel && (
              <span className="ms-2 inline-flex min-w-[1.5rem] justify-center rounded-full bg-destructive/10 px-1.5 text-xs font-semibold tabular-nums text-destructive">
                <bdi dir="ltr">{countLabel}</bdi>
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground">{t("AccountingNeedsAttentionDesc")}</p>
        </div>

        {attention.length === 0 ? (
          // Scoped, not "all clear": `status` samples PENDING rows only, so a
          // FAILED posting never reaches this list — it lives in Close Review.
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-dashed border-border px-4 py-6">
            <Inbox aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">{t("AccountingNoAttentionItemsReported")}</p>
              <p className="text-sm text-muted-foreground">{t("AccountingNoAttentionItemsReportedDesc")}</p>
            </div>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border border-y border-border">
            {attention.map((item) => (
              <li key={item.key} className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                <span
                  aria-hidden
                  className={cn(
                    "mt-2 h-2 w-2 rounded-full",
                    item.tone === "blocker" ? "bg-destructive" : "bg-amber-500 dark:bg-amber-400"
                  )}
                />
                <div className="min-w-0">
                  <p className="font-medium text-foreground [overflow-wrap:anywhere]">{item.title}</p>
                  <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={item.tone === "blocker" ? "default" : "outline"}
                  className="col-start-2 justify-self-start sm:col-start-3 sm:justify-self-end"
                  onClick={() => onNavigate(item.section)}
                >
                  {sectionLabel(item.section, t)}
                  <Chevron aria-hidden className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {setupStatus.hasMorePendingEvents && (
          <p className="mt-2 text-xs text-muted-foreground">{t("MorePendingAccountingEvents")}</p>
        )}
      </section>

      <aside className="grid min-w-0 gap-4 md:grid-cols-2 lg:grid-cols-1">
        <section aria-labelledby="accounting-readiness-heading" className="rounded-lg border border-border bg-muted/30 p-4">
          <h2 id="accounting-readiness-heading" className="text-sm font-semibold text-foreground">
            {t("AccountingReadiness")}
          </h2>
          <ul className="mt-2 space-y-2">
            {readiness.map((item) => (
              <li key={item.key} className="flex items-start gap-2.5">
                {item.ready ? (
                  <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="accounting-periods-heading" className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="accounting-periods-heading" className="text-sm font-semibold text-foreground">
              {t("AccountingRecentPeriods")}
            </h2>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-me-2 h-7 px-2 text-xs"
              onClick={() => onNavigate("reconcile")}
            >
              {sectionLabel("reconcile", t)}
              <Chevron aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>
          {recentPeriods.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("NoAccountingPeriods")}</p>
          ) : (
            <ul className="mt-2 divide-y divide-border/70">
              {recentPeriods.map((period) => (
                <li key={period._id} className="flex items-center justify-between gap-3 py-1.5">
                  <bdi dir="ltr" className="text-sm font-medium tabular-nums text-foreground">
                    {periodLabel(period)}
                  </bdi>
                  <Badge variant="outline" className={periodStatusClassName(period.status)}>
                    {t(`PeriodStatus_${period.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <nav aria-labelledby="accounting-sections-heading" className="min-w-0 lg:col-span-2">
        <h2 id="accounting-sections-heading" className="text-sm font-semibold text-muted-foreground">
          {t("AccountingSectionsHeading")}
        </h2>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <li key={section.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onNavigate(section.id)}
                  className="flex h-full w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-start hover:border-primary/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-foreground">
                      {t(section.labelKey)}
                      {section.admin && (
                        <span className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t("AccountingAdminSections")}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">{t(section.descriptionKey)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
