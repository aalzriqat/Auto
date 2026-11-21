import type { ComponentProps, RefObject } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DealDocumentsPanel } from "./DealDocumentsPanel";
import { DealActivityLog } from "./DealActivityLog";
import { dealStatusLabelKey } from "./DealStagePresentation";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { DealCockpitData } from "./DealStagePresentation";

const NO_UPLOADS: ReadonlySet<string> = new Set();

export function DealRecordTabs({
  deal,
  documents,
  hasDocumentsPane,
  tab,
  onTabChange,
  lowerTabsRef,
  documentsTriggerRef,
  formatMoment,
  t,
}: Pick<DealCockpitViewProps, "documents"> &
  Readonly<{
    deal: Pick<DealCockpitData, "documents" | "timeline">;
    hasDocumentsPane: boolean;
    tab: "documents" | "activity";
    onTabChange: (value: string) => void;
    lowerTabsRef: RefObject<HTMLDivElement | null>;
    documentsTriggerRef: RefObject<HTMLButtonElement | null>;
    formatMoment: ComponentProps<typeof DealActivityLog>["formatMoment"];
    t: (key: string) => string;
  }>) {
  const documentsPane = documents ? (
    <DealDocumentsPanel
      documents={documents.items}
      history={documents.history}
      checklist={deal.documents}
      canUpload={documents.canUpload}
      canVerify={documents.canVerify}
      uploadingRuleIds={documents.uploadingRuleIds}
      t={t}
      onUpload={documents.onUpload}
      onVerify={documents.onVerify}
    />
  ) : deal.documents.length > 0 ? (
    <DealDocumentsPanel
      documents={undefined}
      checklist={deal.documents}
      canUpload={false}
      canVerify={false}
      uploadingRuleIds={NO_UPLOADS}
      t={t}
      onUpload={() => {}}
      onVerify={() => {}}
    />
  ) : null;
  const activityPane = (
    <DealActivityLog
      entries={deal.timeline}
      formatMoment={formatMoment}
      statusLabel={(status) => t(dealStatusLabelKey(status))}
      t={t}
    />
  );
  if (!hasDocumentsPane) return activityPane;
  return (
    <Tabs
      ref={lowerTabsRef}
      value={tab}
      onValueChange={onTabChange}
      className="scroll-mt-32 space-y-3 sm:scroll-mt-20"
      data-testid="deal-lower-tabs"
    >
      <TabsList>
        <TabsTrigger ref={documentsTriggerRef} value="documents">
          {t("DealTabDocuments")}
        </TabsTrigger>
        <TabsTrigger value="activity">{t("DealTabActivity")}</TabsTrigger>
      </TabsList>
      <TabsContent value="documents" forceMount className="data-[state=inactive]:hidden">
        {documentsPane}
      </TabsContent>
      <TabsContent value="activity" forceMount className="data-[state=inactive]:hidden">
        {activityPane}
      </TabsContent>
    </Tabs>
  );
}
