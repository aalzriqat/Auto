import type { Doc } from "../_generated/dataModel";
import { deriveAccountingProfit } from "./financingEconomics";
import { toMinorSameCurrencyOrUndefined } from "./money";
import type { saleEconomics } from "./vehicleOwnership";

/** The cash cockpit's accounting basis; management costs are composed by withDealManagementCosts. */
export function cashAccountingProfit(args: {
  sale: Doc<"sales">;
  economics: ReturnType<typeof saleEconomics>;
  currency: string;
}) {
  const { sale, economics, currency } = args;
  const minor = (value: number | null) => value === null ? null :
    (toMinorSameCurrencyOrUndefined(value, currency, currency) ?? null);
  return deriveAccountingProfit({
    dealCancelled: sale.status === "CANCELLED",
    saleCompleted: sale.status === "COMPLETED",
    financedDirectWithoutApproval: economics.isAgentSale &&
      (sale.financingType === "FINANCED" || sale.financingType === "LEASE") &&
      economics.settlementRoute === "DIRECT_TO_SUPPLIER" && !sale.applicationId,
    dealershipMarginMinor: minor(economics.dealershipMargin),
    salePriceMinor: minor(sale.salePrice),
    recognizedCostMinor: minor(economics.recognizedCost),
    supplierEntitlementMinor: economics.isAgentSale ? minor(economics.supplierSettlement) : null,
    currency,
  });
}
