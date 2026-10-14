"use client";

import { useParams } from "next/navigation";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import type { Id } from "@/convex/_generated/dataModel";
import { SaleDealCockpit } from "@/components/applications/cockpit/DealCockpit";
import { DealInvoiceReceiptsPanel } from "@/components/applications/cockpit/DealInvoiceReceiptsPanel";
import { useStageDeepLink } from "@/components/applications/cockpit/useStageDeepLink";
import { MoneySurfaceErrorBoundary } from "@/components/accounting/MoneySurfaceErrorBoundary";
import { Skeleton } from "@/components/ui/skeleton";

export function SaleDealCockpitClient() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const stageDeepLink = useStageDeepLink();
  const params = useParams<{ saleId: string }>();
  const saleId = params?.saleId;

  // `activeOrgId` is withheld until a live membership query confirms the caller
  // actually belongs to the org in the URL, so rendering before it arrives would
  // query on a tenancy nobody has verified yet.
  if (!activeOrgId || !saleId) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <>
      <SaleDealCockpit
        orgId={activeOrgId as Id<"organizations">}
        saleId={saleId as Id<"sales">}
        stageDeepLink={stageDeepLink}
      />
      {/* SCRUM-724: customer money after completion. It withholds itself from a
          caller without view:finance; a failure of its own queries degrades to
          this alert instead of taking the cockpit down. Keyed by org + sale so
          another deal starts clean. */}
      <MoneySurfaceErrorBoundary
        key={`${activeOrgId}:${saleId}`}
        fallback={
          <div role="alert" className="mt-6 rounded-md border border-border px-4 py-6 text-sm text-destructive">
            {t("DealReceiptPanelLoadFailed")}
          </div>
        }
      >
        <DealInvoiceReceiptsPanel
          orgId={activeOrgId as Id<"organizations">}
          saleId={saleId as Id<"sales">}
        />
      </MoneySurfaceErrorBoundary>
    </>
  );
}
