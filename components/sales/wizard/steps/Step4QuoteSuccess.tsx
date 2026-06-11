"use client";

import { Doc, Id } from "@/convex/_generated/dataModel";
import { PaymentType, WizardData } from "../types";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileDown, LogOut } from "lucide-react";
import { QuotePrintTemplate } from "../../QuotePrintTemplate";
import { useLanguage } from "@/components/providers/LanguageProvider";

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
  const { t } = useLanguage();

  const handleDownload = () => {
    // We use standard browser print which will pick up the hidden @media print layout
    window.print();
  };

  return (
    <>
      <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center print:hidden">
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
            {t("PrintQuote" as any) || "Print / Save Quote"}
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

      {/* Hidden print template rendered only for window.print() */}
      <QuotePrintTemplate
        paymentType={paymentType}
        wizardData={wizardData}
        selectedVehicle={selectedVehicle}
        selectedCompany={selectedCompany}
        selectedCustomer={selectedCustomer}
        selectedResult={selectedResult}
        dateStr={new Date().toLocaleDateString("ar-JO")}
      />
    </>
  );
}
