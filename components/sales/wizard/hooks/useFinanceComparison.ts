import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { calculateUnifiedMurabaha } from "@/lib/financing";

interface UseFinanceComparisonParams {
  vehiclePrice: number;
  desiredProfit: number;
  downPayment: number;
  termMonths: number;
  vehicleId: string;
  customerStatuses?: string[];
}

export interface FinanceComparisonResult {
  companyId: string;
  companyName: string;
  profitRate: number;
  feesConfigured: boolean;
  adminFees?: number;

  monthlyInstallment?: number;
  totalFinancedAmount?: number;
  totalProfit?: number;
  takafulAmount?: number;

  actualValuation: number;
  maxFinancingAllowed: number;

  exceedsValuation: boolean;
  minimumDownPayment?: number;

  companyDocs: any[];

  effectivePrice: number;
}

export function useFinanceComparison({
  vehiclePrice,
  desiredProfit,
  downPayment,
  termMonths,
  vehicleId,
  customerStatuses = [],
}: UseFinanceComparisonParams) {
  const { activeOrgId } = useOrg();

  const financeCompanies = useQuery(
    api.finance.listCompanies,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const documentRules = useQuery(
    api.documents.listRules,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const valuations = useQuery(
    api.finance.listValuations,
    activeOrgId && vehicleId ? { orgId: activeOrgId, vehicleId: vehicleId as Id<"vehicles"> } : "skip"
  );

  const effectivePrice = vehiclePrice + (desiredProfit || 0);

  const comparisons = useMemo((): FinanceComparisonResult[] => {
    if (!financeCompanies || !vehicleId || vehiclePrice <= 0) {
      return [];
    }

    let activeCompanies = financeCompanies.filter(
      (c: Doc<"financeCompanies">) => c.isActive
    );

    // If customer statuses are provided, filter companies by acceptedStatuses.
    // An empty selection means no requirements are known, so no companies match.
    if (customerStatuses.length === 0) {
      return [];
    }

    // Each company opts into which customer statuses it accepts via its
    // `acceptedStatuses` setting (configured in Finance Settings). No
    // restriction configured (undefined/empty) means it accepts all.
    activeCompanies = activeCompanies.filter((company: Doc<"financeCompanies">) => {
      const accepted = company.acceptedStatuses;
      if (!accepted || accepted.length === 0) return true;
      return customerStatuses.some((s) => accepted.includes(s as Id<"orgCustomerStatuses">));
    });

    return activeCompanies.map((company: Doc<"financeCompanies">) => {
      const executionFees = company.adminFees;
      const feesConfigured = executionFees !== undefined;

      const result = feesConfigured
        ? calculateUnifiedMurabaha({
            vehiclePrice: effectivePrice,
            downPayment,
            commission: company.commission || 0,
            processingFees: executionFees,
            annualProfitRate: company.profitRate,
            annualInsuranceRate: company.insuranceRate || 0,
            termMonths,
            gracePeriodMonths: company.gracePeriodMonths,
            includesCommissionInDebt:
              company.includesCommissionInDebt,
          })
        : null;

      const actualValuation =
        valuations?.find(
          (valuation: Doc<"vehicleValuations">) => valuation.companyId === company._id
        )?.valuationAmount || 0;

      const maxLTV = company.maxFinancingLTV || 0;

      const maxFinancingAllowed =
        maxLTV > 0 && actualValuation > 0
          ? actualValuation * (maxLTV / 100)
          : Number.MAX_SAFE_INTEGER;

      const exceedsValuation =
        result !== null &&
        result.financedAmount > maxFinancingAllowed &&
        actualValuation > 0;

      const minimumDownPayment = feesConfigured
        ? Math.max(
            0,
            effectivePrice + (company.commission || 0) + executionFees - maxFinancingAllowed
          )
        : undefined;

      const companyDocs =
        documentRules?.filter(
          (rule: Doc<"companyDocumentRules">) =>
            rule.companyId === company._id ||
            !rule.companyId
        ) || [];

      return {
        companyId: company._id as string,
        companyName: company.name,
        profitRate: company.profitRate,
        feesConfigured,
        adminFees: company.adminFees,

        monthlyInstallment:
          result?.monthlyInstallment,

        totalFinancedAmount:
          result?.financedAmount,

        totalProfit:
          result?.totalProfit,

        takafulAmount:
          result?.takafulAmount,

        actualValuation,

        maxFinancingAllowed,

        exceedsValuation,

        minimumDownPayment,

        companyDocs,

        effectivePrice,
      };
    });
  }, [
    financeCompanies,
    documentRules,
    valuations,
    vehicleId,
    vehiclePrice,
    desiredProfit,
    downPayment,
    termMonths,
    effectivePrice,
    customerStatuses,
  ]);

  return {
    comparisons,

    effectivePrice,

    financeCompanies,

    documentRules,

    valuations,

    loading:
      financeCompanies === undefined,

    hasVehicle:
      !!vehicleId && vehiclePrice > 0,
  };
}