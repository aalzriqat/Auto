"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BookOpen, Briefcase, Landmark, HandCoins } from "lucide-react";
import { GeneralLedgerTab } from "./GeneralLedgerTab";
import { FixedAssetsTab } from "./FixedAssetsTab";
import { PartnerEquityTab } from "./PartnerEquityTab";
import { ClaimsTab } from "./ClaimsTab";

export function AccountingClient() {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();

  if (!activeOrgId) return null;

  return (
    <div className="p-6 max-w-[1600px] mx-auto w-full flex flex-col h-full gap-6">
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

      <Tabs defaultValue="ledger" className="flex-1 flex flex-col h-full overflow-hidden">
        <TabsList className="w-full sm:w-auto self-start mb-4 bg-white border border-slate-200/60 p-1">
          <TabsTrigger value="ledger" className="gap-2 data-[state=active]:bg-primary/5 data-[state=active]:text-primary data-[state=active]:shadow-none px-4">
            <BookOpen className="w-4 h-4" />
            {t("GeneralLedger" as any)}
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
        </TabsList>

        <div className="flex-1 overflow-y-auto min-h-0 bg-white rounded-xl border border-slate-200/60 shadow-sm">
          <TabsContent value="ledger" className="h-full m-0 data-[state=inactive]:hidden">
            <GeneralLedgerTab />
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
        </div>
      </Tabs>
    </div>
  );
}
