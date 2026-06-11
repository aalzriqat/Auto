"use client";

import { Doc, Id } from "@/convex/_generated/dataModel";
import { PaymentType, WizardData } from "../types";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileDown, LogOut } from "lucide-react";
import { generateQuote, generateFinanceQuote } from "@/lib/pdf";

interface Step4QuoteSuccessProps {
  paymentType: PaymentType;
  wizardData: WizardData;
  selectedCustomer: Doc<"customers">;
  quoteId: Id<"quotes">;
  selectedVehicle?: Doc<"vehicles">;
  selectedCompany?: Doc<"financeCompanies">;
  selectedResult: any; // The result from calculateUnifiedMurabaha
  onClose: () => void;
}

export function Step4QuoteSuccess({
  paymentType,
  wizardData,
  selectedCustomer,
  quoteId,
  selectedVehicle,
  selectedCompany,
  selectedResult,
  onClose,
}: Step4QuoteSuccessProps) {
  const isCash = paymentType === "CASH";

  const handleDownload = () => {
    const customerName = `${selectedCustomer.firstName} ${selectedCustomer.lastName}`;
    const vehicleSummary = selectedVehicle
      ? `${selectedVehicle.year} ${selectedVehicle.make} ${selectedVehicle.model}`
      : "Selected Vehicle";
    const vehicleVin = selectedVehicle?.vin || "";

    if (isCash) {
      generateQuote(
        "Auto Dealership", // We could grab from org/user if available
        customerName,
        vehicleSummary,
        vehicleVin,
        selectedResult.totalFinancedAmount // which is vehiclePrice for cash
      );
    } else {
      generateFinanceQuote(
        "Auto Dealership",
        customerName,
        vehicleSummary,
        selectedCompany?.name || "Finance Company",
        wizardData.vehiclePrice + (wizardData.desiredProfit || 0), // effective price
        wizardData.downPayment,
        wizardData.termMonths,
        selectedResult.profitRateApplied || 0,
        selectedResult.totalFinancedAmount || 0,
        selectedResult.totalProfit || 0,
        selectedResult.monthlyInstallment || 0,
        vehicleVin
      );
    }
  };

  return (
    <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center">
      <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mb-4">
        <CheckCircle2 className="w-8 h-8" />
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-foreground">
          Quote Generated Successfully!
        </h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          The quote has been saved and is now linked to{" "}
          <span className="font-semibold text-foreground">
            {selectedCustomer.firstName} {selectedCustomer.lastName}
          </span>{" "}
          and the selected vehicle.
        </p>
      </div>

      <div className="pt-6 flex flex-col sm:flex-row gap-4 justify-center items-center">
        <Button
          onClick={handleDownload}
          className="bg-indigo-600 hover:bg-indigo-700 min-w-[200px]"
          size="lg"
        >
          <FileDown className="w-4 h-4 mr-2" />
          Download PDF Quote
        </Button>

        <Button
          onClick={onClose}
          variant="outline"
          size="lg"
          className="min-w-[200px]"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Done & Close
        </Button>
      </div>
    </div>
  );
}
