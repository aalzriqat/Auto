"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarChart3, BookOpen, Briefcase, Landmark, HandCoins, WalletCards, ScrollText, Settings, Building2 } from "lucide-react";
import { AccountingSetupTab } from "./AccountingSetupTab";
import { BankAccountsTab } from "./BankAccountsTab";
import { FinancialReportsTab } from "./FinancialReportsTab";
import { GeneralLedgerTab } from "./GeneralLedgerTab";
import { FixedAssetsTab } from "./FixedAssetsTab";
import { PartnerEquityTab } from "./PartnerEquityTab";
import { ClaimsTab } from "./ClaimsTab";
import { CollectionsTab } from "./CollectionsTab";
import { ManualJournalTab } from "./ManualJournalTab";

export function AccountingClient() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();

  if (!activeOrgId) return null;

  return (
    <div className="p-6 max-w-[1600px] mx-auto w-full flex flex-col md:h-full gap-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Landmark className="w-6 h-6 text-primary" />
            {t("Accounting" as any)}
          </h1>
          <p className="text-slate-500 mt-1">
            {t("AccountingDesc" as any)}
          </p>
        </div>
      </div>

      <Tabs defaultValue="setup" className="flex-1 flex flex-col md:h-full md:overflow-hidden">
        <div className="overflow-x-auto self-start mb-4 w-full sm:w-auto">
          <TabsList className="w-max bg-white border border-slate-200/60 p-1">
            <TabsTrigger value="setup" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <Settings className="w-4 h-4" />
              {t("AccountingSetup" as any)}
            </TabsTrigger>
            <TabsTrigger value="ledger" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <BookOpen className="w-4 h-4" />
              {t("TransactionRegister" as any)}
            </TabsTrigger>
            <TabsTrigger value="glReports" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <BarChart3 className="w-4 h-4" />
              {t("GLReports" as any)}
            </TabsTrigger>
            <TabsTrigger value="assets" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <Briefcase className="w-4 h-4" />
              {t("FixedAssets" as any)}
            </TabsTrigger>
            <TabsTrigger value="equity" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <HandCoins className="w-4 h-4" />
              {t("PartnerEquity" as any)}
            </TabsTrigger>
            <TabsTrigger value="claims" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <Landmark className="w-4 h-4" />
              {t("Claims" as any)}
            </TabsTrigger>
            <TabsTrigger value="collections" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <WalletCards className="w-4 h-4" />
              {t("Collections" as any)}
            </TabsTrigger>
            <TabsTrigger value="manualJournal" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <ScrollText className="w-4 h-4" />
              {t("ManualJournal" as any)}
            </TabsTrigger>
            <TabsTrigger value="bankAccounts" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
              <Building2 className="w-4 h-4" />
              {t("BankAccounts" as any)}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="md:flex-1 md:overflow-y-auto md:min-h-0 bg-white rounded-xl border border-slate-200/60 shadow-sm">
          <TabsContent value="setup" className="h-full m-0 data-[state=inactive]:hidden">
            <AccountingSetupTab />
          </TabsContent>
          <TabsContent value="ledger" className="h-full m-0 data-[state=inactive]:hidden">
            <GeneralLedgerTab />
          </TabsContent>
          <TabsContent value="glReports" className="h-full m-0 data-[state=inactive]:hidden">
            <FinancialReportsTab />
          </TabsContent>
          <TabsContent value="assets" className="h-full m-0 data-[state=inactive]:hidden">
            <FixedAssetsTab />
          </TabsContent>
          <TabsContent value="equity" className="h-full m-0 data-[state=inactive]:hidden">
            <PartnerEquityTab />
          </TabsContent>
          <TabsContent value="claims" className="h-full m-0 data-[state=inactive]:hidden">
            <ClaimsTab />
          </TabsContent>
          <TabsContent value="collections" className="h-full m-0 data-[state=inactive]:hidden">
            <CollectionsTab />
          </TabsContent>
          <TabsContent value="manualJournal" className="h-full m-0 data-[state=inactive]:hidden">
            <ManualJournalTab />
          </TabsContent>
          <TabsContent value="bankAccounts" className="h-full m-0 data-[state=inactive]:hidden">
            <BankAccountsTab />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
