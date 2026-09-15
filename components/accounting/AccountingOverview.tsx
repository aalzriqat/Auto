"use client";

import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { CheckCircle2, ChevronLeft, ChevronRight, XCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { LoadingAccountingState } from "./AccountingTabShared";
import { periodLabel } from "./setup/types";
import { ACCOUNTING_SECTIONS, type AccountingSectionId } from "./accountingSections";

/**
 * Landing section of the Accounting workspace.
 *
 * Deliberately reads only what the Setup tab already reads
 * (`accountingSetup.status`) and restates it as a readiness list that points
 * at the section where each item is fixed. It shows no balances, totals or
 * exception counts of its own — those belong to the sections that own them.
 */
export function AccountingOverview({
  onNavigate,
}: Readonly<{ onNavigate: (section: AccountingSectionId) => void }>) {
  const { activeOrgId } = useOrg();
  const { t, isRtl } = useLanguage();
  const setupStatus = useQuery(
    api.accountingSetup.status,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  if (!activeOrgId) return null;
  if (setupStatus === undefined) return <LoadingAccountingState label={t("Loading")} />;

  const chartReady = setupStatus.chartInitialized && setupStatus.systemAccountsValid;
  const pendingCount = setupStatus.pendingEvents.length;
  const Chevron = isRtl ? ChevronLeft : ChevronRight;

  const readiness: ReadonlyArray<{
    key: string;
    title: string;
    detail: ReactNode;
    ready: boolean;
    section: AccountingSectionId;
  }> = [
    {
      key: "chart",
      title: t("ChartOfAccounts"),
      detail: chartReady ? t("ChartOfAccountsReady") : t("ChartOfAccountsNeedsSetup"),
      ready: chartReady,
      section: "settings",
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
      section: "reconcile",
    },
    {
      key: "events",
      title: t("PendingAccountingEvents"),
      detail: pendingCount === 0 ? t("NoPendingAccountingEvents") : t("PendingAccountingEventsNeedAttention"),
      ready: pendingCount === 0,
      section: "reconcile",
    },
  ];

  const sections = ACCOUNTING_SECTIONS.filter((section) => section.id !== "overview");

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <section aria-labelledby="accounting-readiness-heading">
        <h2 id="accounting-readiness-heading" className="text-base font-semibold text-foreground">
          {t("AccountingReadiness")}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("AccountingReadinessDesc")}</p>
        <ul className="mt-3 divide-y divide-border border-y border-border md:grid md:grid-cols-3 md:divide-x md:divide-y-0 rtl:md:divide-x-reverse">
          {readiness.map((item) => (
            <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 md:px-4 md:first:ps-0 md:last:pe-0">
              {item.ready ? (
                <CheckCircle2 aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              ) : (
                <XCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
              )}
              <div className="min-w-[10rem] flex-1">
                <p className="font-medium text-foreground">{item.title}</p>
                <p className="text-sm text-muted-foreground">{item.detail}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={item.ready ? "ghost" : "outline"}
                className="ms-auto shrink-0"
                onClick={() => onNavigate(item.section)}
              >
                {t(ACCOUNTING_SECTIONS.find((section) => section.id === item.section)?.labelKey ?? "")}
                <Chevron aria-hidden className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <nav aria-labelledby="accounting-sections-heading">
        <h2 id="accounting-sections-heading" className="text-base font-semibold text-foreground">
          {t("AccountingSectionsHeading")}
        </h2>
        <ul className="mt-3 border-t border-border sm:grid sm:grid-cols-2 sm:gap-x-8">
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <li key={section.id} className="border-b border-border">
                <button
                  type="button"
                  onClick={() => onNavigate(section.id)}
                  className="flex w-full items-start gap-3 py-2.5 text-start rounded-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{t(section.labelKey)}</span>
                    <span className="block text-xs text-muted-foreground">{t(section.descriptionKey)}</span>
                  </span>
                  <Chevron aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
