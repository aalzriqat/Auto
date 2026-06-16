"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { calculateUnifiedMurabaha } from "@/lib/financing";
import { useLanguage } from "@/components/providers/LanguageProvider";

import { ArrowLeft, CheckCircle2, Car, User, TrendingUp, FileText } from "lucide-react";

import  ReviewVehicleCard  from "../components/ReviewVehicleCard";
import  ReviewCustomerCard  from "../components/ReviewCustomerCard";
import  ReviewFinanceSummary  from "../components/ReviewFinanceSummary";

export function Step3Review({
  paymentType,
  wizardData,
  selectedCustomer,
  onBack,
  onSuccess,
}: {
  paymentType: "CASH" | "INSTALLMENT";
  wizardData: any;
  selectedCustomer: Doc<"customers">;
  onBack: () => void;
  onSuccess: (data: {
    quoteId: Id<"quotes">;
    selectedVehicle?: Doc<"vehicles">;
    selectedCompany?: Doc<"financeCompanies">;
    selectedResult: any;
  }) => void;
}) {
  const { activeOrgId } = useOrg();
  const saveQuote = useMutation(api.quotes.saveQuote);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const availableVehicles = useQuery(
    api.vehicles.listAll,
    activeOrgId ? { orgId: activeOrgId, status: "AVAILABLE" } : "skip"
  );

  const financeCompanies = useQuery(
    api.finance.listCompanies,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const documentRules = useQuery(
    api.documents.listRules,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const selectedVehicle = availableVehicles?.find(
    (v) => v._id === wizardData.vehicleId
  );

  const selectedCompany = financeCompanies?.find(
    (c) => c._id === wizardData.selectedCompanyId
  );

  const effectivePrice =
    wizardData.vehiclePrice + (wizardData.desiredProfit || 0);

  const selectedResult = useMemo(() => {
    if (paymentType === "CASH") {
      return {
        isCash: true,
        companyName: "Cash Deal",
        totalFinancedAmount: wizardData.vehiclePrice,
        monthlyInstallment: 0,
        totalProfit: 0,
        takafulAmount: 0,
      };
    }

    if (!selectedCompany) return null;

    const result = calculateUnifiedMurabaha({
      vehiclePrice: effectivePrice,
      downPayment: wizardData.downPayment,
      commission: selectedCompany.commission || 0,
      processingFees: selectedCompany.adminFees || 0,
      annualProfitRate: selectedCompany.profitRate,
      annualInsuranceRate: selectedCompany.insuranceRate || 0,
      termMonths: wizardData.termMonths,
      gracePeriodMonths: selectedCompany.gracePeriodMonths,
      includesCommissionInDebt: selectedCompany.includesCommissionInDebt,
    });

    const companyDocs =
      documentRules?.filter(
        (r) => r.companyId === selectedCompany._id || !r.companyId
      ) || [];

    return {
      isCash: false,
      companyName: selectedCompany.name,
      profitRateApplied: selectedCompany.profitRate,
      totalFinancedAmount: result.financedAmount,
      monthlyInstallment: result.monthlyInstallment,
      totalProfit: result.totalProfit,
      takafulAmount: result.takafulAmount,
      companyDocs,
    };
  }, [
    paymentType,
    selectedCompany,
    documentRules,
    wizardData,
    effectivePrice,
  ]);

  const [recipientName, setRecipientName] = useState("");
  const { t } = useLanguage();

  const handleGenerate = async () => {
    if (!activeOrgId || !selectedResult) return;

    setIsSubmitting(true);

    try {
      const quoteId = await saveQuote({
        orgId: activeOrgId,
        vehicleId: wizardData.vehicleId as Id<"vehicles">,
        customerId: selectedCustomer._id,
        companyId:
          paymentType === "CASH"
            ? undefined
            : (wizardData.selectedCompanyId as Id<"financeCompanies">),

        vehiclePrice: effectivePrice,
        downPayment: wizardData.downPayment,
        termMonths: wizardData.termMonths,

        totalFinancedAmount: selectedResult.totalFinancedAmount,
        monthlyInstallment: selectedResult.monthlyInstallment,
        profitRateApplied: (selectedResult as any).profitRateApplied,
        totalProfit: selectedResult.totalProfit,
      });

      toast.success("Quote generated successfully");
      onSuccess({
        quoteId: quoteId as Id<"quotes">,
        selectedVehicle,
        selectedCompany,
        selectedResult: {
          ...selectedResult,
          recipientName: recipientName.trim() || `${selectedCustomer.firstName} ${selectedCustomer.lastName}`,
        },
      });
    } catch (err: any) {
      toast.error(err.message || "Failed to generate quote");
    } finally {
      setIsSubmitting(false);
    }
  };

  const accentClass =
    paymentType === "CASH"
      ? "border-teal-500/30 bg-teal-500/5"
      : "border-indigo-500/30 bg-indigo-500/5";

  return (
    <div className="space-y-6">
      {/* HEADER SUMMARY GRID */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {selectedVehicle && (
          <ReviewVehicleCard
            vehicle={selectedVehicle}
            basePrice={wizardData.vehiclePrice}
            desiredProfit={wizardData.desiredProfit}
          />
        )}

        <ReviewCustomerCard customer={selectedCustomer} />
      </div>

      {/* FINANCE SUMMARY */}
      {selectedResult && (
        <ReviewFinanceSummary
          {...selectedResult}
          desiredProfit={wizardData.desiredProfit}
        />
      )}

      {/* DOCUMENTS */}
      {selectedResult && !selectedResult.isCash && (
        <div className={cn("border rounded-xl p-4", accentClass)}>
          <p className="text-xs font-semibold uppercase text-muted-foreground mb-2 flex items-center gap-1">
            <FileText className="w-3.5 h-3.5" />
            Required Documents
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
            {selectedResult.companyDocs?.map((doc: any) => (
              <div key={doc._id} className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    doc.isRequired ? "bg-amber-400" : "bg-muted-foreground"
                  )}
                />
                <span className="text-muted-foreground">
                  {doc.documentName}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* RECIPIENT INPUT */}
      <div className="border-t pt-4">
        <label className="text-sm font-medium mb-1.5 block">
          {t("QuoteTo" as any)}
        </label>
        <input
          type="text"
          placeholder={`${selectedCustomer.firstName} ${selectedCustomer.lastName}`}
          value={recipientName}
          onChange={(e) => setRecipientName(e.target.value)}
          className="flex h-9 w-full sm:max-w-md rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {/* ACTIONS */}
      <div className="flex justify-between pt-4 border-t">
        <Button variant="outline" onClick={onBack} disabled={isSubmitting}>
          <ArrowLeft className="w-4 h-4 me-2" />
          Back
        </Button>

        <Button
          onClick={handleGenerate}
          disabled={isSubmitting || !selectedResult}
          className={
            paymentType === "CASH"
              ? "bg-teal-600 hover:bg-teal-700"
              : "bg-indigo-600 hover:bg-indigo-700"
          }
        >
          <CheckCircle2 className="w-4 h-4 me-2" />
          {isSubmitting ? "Generating..." : "Generate Quote"}
        </Button>
      </div>
    </div>
  );
}