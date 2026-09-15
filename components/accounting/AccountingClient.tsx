"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Landmark } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  ACCOUNTING_SECTIONS,
  DEFAULT_ACCOUNTING_SECTION,
  isAccountingSectionId,
  type AccountingSection,
  type AccountingSectionId,
} from "./accountingSections";
import { AccountingOverview } from "./AccountingOverview";
import { AccountingSetupTab } from "./AccountingSetupTab";
import { BankAccountsTab } from "./BankAccountsTab";
import { FinancialReportsTab } from "./FinancialReportsTab";
import { GeneralLedgerTab } from "./GeneralLedgerTab";
import { FixedAssetsTab } from "./FixedAssetsTab";
import { PrepaidExpensesTab } from "./PrepaidExpensesTab";
import { PartnerEquityTab } from "./PartnerEquityTab";
import { ClaimsTab } from "./ClaimsTab";
import { CollectionsTab } from "./CollectionsTab";
import { ManualJournalTab } from "./ManualJournalTab";

const SECTION_PARAM = "section";

/**
 * Sub-views inside a grouped section. Keys are the section id; values are the
 * existing tab components hosted there, in their original order.
 */
type SubView = { id: string; labelKey: string; render: () => ReactNode };

const SUB_VIEWS: Partial<Record<AccountingSectionId, readonly SubView[]>> = {
  receivables: [
    { id: "claims", labelKey: "Claims", render: () => <ClaimsTab /> },
    { id: "collections", labelKey: "Collections", render: () => <CollectionsTab /> },
  ],
  journal: [
    { id: "register", labelKey: "TransactionRegister", render: () => <GeneralLedgerTab /> },
    { id: "manual", labelKey: "ManualJournal", render: () => <ManualJournalTab /> },
  ],
  assets: [
    { id: "fixedAssets", labelKey: "FixedAssets", render: () => <FixedAssetsTab /> },
    { id: "prepaid", labelKey: "PrepaidExpenses", render: () => <PrepaidExpensesTab /> },
    { id: "equity", labelKey: "PartnerEquity", render: () => <PartnerEquityTab /> },
  ],
};

function readSectionFromUrl(value: string | null): AccountingSectionId {
  return isAccountingSectionId(value) ? value : DEFAULT_ACCOUNTING_SECTION;
}

function writeSectionToUrl(section: AccountingSectionId) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (section === DEFAULT_ACCOUNTING_SECTION) url.searchParams.delete(SECTION_PARAM);
  else url.searchParams.set(SECTION_PARAM, section);
  window.history.replaceState(window.history.state, "", url.toString());
}

/**
 * Section navigation for `sm` and up. The eight labels wrap onto a second
 * row when the width needs it, so nothing is ever clipped; the Radix roving
 * tabindex gives arrow-key movement and mirrors it under RTL. The two admin
 * sections sit at the far end, lighter, so the daily six read as one group.
 */
function SectionNav({ t }: Readonly<{ t: (key: string) => string }>) {
  const firstAdminId = ACCOUNTING_SECTIONS.find((item) => item.admin)?.id;
  return (
    <TabsList
      aria-label={t("AccountingSectionNav")}
      className="hidden h-auto w-full flex-wrap justify-start gap-x-1 rounded-none border-b border-border bg-transparent p-0 text-muted-foreground sm:flex"
    >
      {ACCOUNTING_SECTIONS.map((item) => (
        <TabsTrigger
          key={item.id}
          value={item.id}
          className={cn(
            "-mb-px rounded-none border-b-2 border-transparent bg-transparent px-2.5 py-2.5 text-sm font-medium text-muted-foreground shadow-none ring-offset-background hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none",
            item.admin && "text-[13px] font-normal",
            item.id === firstAdminId && "sm:ms-auto"
          )}
        >
          {t(item.labelKey)}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** Heading for the sections whose hosted component has no title of its own. */
function SectionHeading({ item, t }: Readonly<{ item: AccountingSection; t: (key: string) => string }>) {
  const Icon = item.icon;
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-border px-4 py-3 sm:px-6">
      <Icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <h2 className="flex flex-wrap items-center gap-x-2 text-lg font-semibold text-foreground">
          {t(item.labelKey)}
          {item.admin && (
            <span className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("AccountingAdminSections")}
            </span>
          )}
        </h2>
        <p className="text-sm text-muted-foreground">{t(item.descriptionKey)}</p>
      </div>
    </div>
  );
}

function sectionById(id: AccountingSectionId): AccountingSection {
  return ACCOUNTING_SECTIONS.find((item) => item.id === id) ?? ACCOUNTING_SECTIONS[0];
}

function SectionSelect({
  section,
  onChange,
  t,
}: Readonly<{
  section: AccountingSectionId;
  onChange: (section: AccountingSectionId) => void;
  t: (key: string) => string;
}>) {
  const daily = ACCOUNTING_SECTIONS.filter((item) => !item.admin);
  const admin = ACCOUNTING_SECTIONS.filter((item) => item.admin);
  return (
    <label className="block sm:hidden">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{t("AccountingGoToSection")}</span>
      <select
        value={section}
        onChange={(event) => onChange(readSectionFromUrl(event.target.value))}
        className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {daily.map((item) => (
          <option key={item.id} value={item.id}>
            {t(item.labelKey)}
          </option>
        ))}
        <optgroup label={t("AccountingSettings")}>
          {admin.map((item) => (
            <option key={item.id} value={item.id}>
              {t(item.labelKey)}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

function SectionSubTabs({
  section,
  t,
}: Readonly<{ section: AccountingSectionId; t: (key: string) => string }>) {
  const views = SUB_VIEWS[section];
  const [view, setView] = useState(views?.[0]?.id ?? "");
  if (!views || views.length === 0) return null;
  const active = views.find((item) => item.id === view) ?? views[0];
  return (
    <Tabs value={active.id} onValueChange={setView} className="space-y-3">
      <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <TabsList className="h-auto w-max border border-border bg-card p-1">
          {views.map((item) => (
            <TabsTrigger
              key={item.id}
              value={item.id}
              className="px-3 py-1.5 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
            >
              {t(item.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {views.map((item) => (
        <TabsContent key={item.id} value={item.id} className="m-0">
          <SectionFrame>{item.render()}</SectionFrame>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function SectionFrame({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return (
    <div className={cn("rounded-xl border border-border bg-card shadow-sm", className)}>{children}</div>
  );
}

export function AccountingClient() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const searchParams = useSearchParams();
  const [section, setSection] = useState<AccountingSectionId>(() =>
    readSectionFromUrl(searchParams.get(SECTION_PARAM))
  );

  const navigate = useCallback((next: AccountingSectionId) => {
    setSection(next);
    writeSectionToUrl(next);
  }, []);

  const onValueChange = useCallback(
    (value: string) => {
      if (isAccountingSectionId(value)) navigate(value);
    },
    [navigate]
  );

  const sectionContent = useMemo<Record<AccountingSectionId, ReactNode>>(
    () => ({
      overview: (
        <SectionFrame>
          <AccountingOverview onNavigate={navigate} />
        </SectionFrame>
      ),
      receivables: <SectionSubTabs key="receivables" section="receivables" t={t} />,
      cash: (
        <div className="max-w-5xl space-y-3">
          <SectionFrame>
            <BankAccountsTab />
          </SectionFrame>
          <p className="px-1 text-sm text-muted-foreground">{t("AccountingCashDrawerElsewhere")}</p>
        </div>
      ),
      journal: <SectionSubTabs key="journal" section="journal" t={t} />,
      reconcile: (
        <SectionFrame>
          <SectionHeading item={sectionById("reconcile")} t={t} />
          <AccountingSetupTab view="close" />
        </SectionFrame>
      ),
      statements: (
        <SectionFrame>
          <SectionHeading item={sectionById("statements")} t={t} />
          <FinancialReportsTab />
        </SectionFrame>
      ),
      assets: <SectionSubTabs key="assets" section="assets" t={t} />,
      settings: (
        <SectionFrame className="max-w-5xl">
          <SectionHeading item={sectionById("settings")} t={t} />
          <AccountingSetupTab view="settings" />
        </SectionFrame>
      ),
    }),
    [navigate, t]
  );

  if (!activeOrgId) return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          <Landmark aria-hidden className="h-6 w-6 text-primary" />
          {t("Accounting")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("AccountingWorkspaceDesc")}</p>
      </div>

      <Tabs value={section} onValueChange={onValueChange} className="flex flex-col gap-4">
        <SectionNav t={t} />
        <SectionSelect section={section} onChange={navigate} t={t} />

        {ACCOUNTING_SECTIONS.map((item) => (
          <TabsContent key={item.id} value={item.id} className="m-0 outline-none">
            {sectionContent[item.id]}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
