import type { ComponentProps } from "react";
import { DealVehicleCard } from "./DealVehicleCard";
import { SettlementRouteControl } from "./SettlementRouteControl";
import { FinancingPlanPanel } from "./FinancingPlanPanel";
import { DealClosingReadinessPanel } from "./DealClosingReadinessPanel";
import { DealCustodyPanel } from "./DealCustodyPanel";
import { HandoverCostsPanel } from "./HandoverCostsPanel";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { DealCockpitData } from "./DealStagePresentation";

export function buildDealRecordPanels({
  deal,
  routeBlocksClose,
  settlementRoute,
  financingPlan,
  handoverCosts,
  closingChecklist,
  noCostCloseout,
  custody,
  custodyMoney,
  goToPanel,
  money,
  locale,
  t,
}: Pick<
  DealCockpitViewProps,
  "settlementRoute" | "financingPlan" | "handoverCosts" | "closingChecklist" | "noCostCloseout" | "custody" | "custodyMoney"
> &
  Readonly<{
    deal: Pick<DealCockpitData, "vehicle">;
    routeBlocksClose: boolean;
    goToPanel: (id: string) => void;
    money: (minor: number) => string;
    locale: ComponentProps<typeof DealClosingReadinessPanel>["locale"];
    t: (key: string) => string;
  }>) {
  const costsDestination = handoverCosts
    ? { labelKey: "ClosingCheckGoToCosts", onGo: () => goToPanel("deal-handover-costs-panel") }
    : undefined;
  const custodyDestination =
    custody && custodyMoney
      ? { labelKey: "ClosingCheckGoToCustody", onGo: () => goToPanel("deal-custody-panel") }
      : undefined;
  const legalInvoiceRecord = closingChecklist?.legalInvoice?.onRecord;
  // Only checks with a real home here. REMITTANCE_KNOWN and FIRST_PAYMENT_RECORDED
  // have no panel of their own on this screen and keep their reason text.
  const closingDestinations: Partial<Record<string, { labelKey: string; onGo: () => void }>> = {
    ...(costsDestination
      ? {
          HANDOVER_COSTS_PAID: costsDestination,
          CONFIGURED_FEES_RECORDED: costsDestination,
          COSTS_CLOSABLE: costsDestination,
        }
      : {}),
    ...(custodyDestination
      ? { CUSTODY_ON_LEDGER: custodyDestination, CUSTODY_SETTLED: custodyDestination }
      : {}),
    ...(legalInvoiceRecord
      ? { LEGAL_INVOICE_RECORDED: { labelKey: "RecordLegalInvoice", onGo: legalInvoiceRecord } }
      : {}),
  };

  const vehicleNode = deal.vehicle ? (
      <DealVehicleCard vehicle={deal.vehicle} t={t}>
        {settlementRoute && !routeBlocksClose && (
          <SettlementRouteControl
            route={settlementRoute.route}
            canSettleDirectToSupplier={settlementRoute.canSettleDirectToSupplier}
            directRouteRefusal={settlementRoute.directRouteRefusal}
            supplierName={settlementRoute.supplierName}
            disabled={settlementRoute.locked}
            t={t}
            onChoose={settlementRoute.onChoose}
          />
        )}
      </DealVehicleCard>
  ) : null;
  const planNode = financingPlan ? (
    <FinancingPlanPanel
      plan={financingPlan.facts}
      formatMajor={financingPlan.formatMajor}
      t={t}
    />
  ) : null;
  const handoverCostsNode = handoverCosts ? <HandoverCostsPanel {...handoverCosts} t={t} /> : null;
  const closingNode = closingChecklist ? (
    <DealClosingReadinessPanel
      closingChecklist={closingChecklist}
      destinations={closingDestinations}
      noCostCloseout={noCostCloseout}
      money={money}
      locale={locale}
      t={t}
    />
  ) : noCostCloseout ?? null;
  const custodyNode =
    custody && custodyMoney ? <DealCustodyPanel wiring={custody} money={custodyMoney} t={t} /> : null;

  return { vehicleNode, planNode, handoverCostsNode, closingNode, custodyNode, goToCosts: costsDestination?.onGo };
}
