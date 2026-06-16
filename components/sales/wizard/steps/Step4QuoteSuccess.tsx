"use client";

import { Doc, Id } from "@/convex/_generated/dataModel";
import { PaymentType, WizardData } from "../types";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileDown, LogOut } from "lucide-react";
import { QuotePrintTemplate } from "../../QuotePrintTemplate";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrgSettings } from "@/hooks/useOrgSettings";

interface Step4QuoteSuccessProps {
  paymentType: PaymentType;
  wizardData: WizardData;
  selectedCustomer: Doc<"customers">;
  quoteId: Id<"quotes">;
  selectedVehicle?: Doc<"vehicles">;
  selectedCompany?: Doc<"financeCompanies">;
  selectedResult: any;
  onClose: () => void;
}

export function Step4QuoteSuccess({
  paymentType,
  wizardData,
  selectedCustomer,
  quoteId: _quoteId,
  selectedVehicle,
  selectedCompany,
  selectedResult,
  onClose,
}: Step4QuoteSuccessProps) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const orgSettings = useOrgSettings();
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const orgBranding = {
    name: orgSettings?.dealershipName,
    logoUrl,
    primaryColor: orgSettings?.primaryColor,
    address: orgSettings?.dealershipAddress,
    phone: orgSettings?.dealershipPhone,
    currencySymbol: orgSettings?.currencySymbol,
  };

  const handleDownload = async () => {
    const element = document.getElementById("pdf-quote-content");
    if (!element) return;

    try {
      element.classList.remove("hidden");
      element.style.position = "absolute";
      element.style.left = "-9999px";
      element.style.top = "-9999px";
      element.style.display = "block";

      const { default: html2canvas } = await import("html2canvas");
      const { jsPDF } = await import("jspdf");

      const canvas = await html2canvas(element, { scale: 2, useCORS: true });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF("p", "mm", "a4");
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
      pdf.save(`Quote_${selectedCustomer.firstName}.pdf`);
    } catch {
      // silently fail — browser PDF generation
    } finally {
      element.style.display = "";
      element.style.position = "";
      element.style.left = "";
      element.style.top = "";
      element.classList.add("hidden");
    }
  };

  return (
    <>
      <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center print:hidden">
        <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mb-4">
          <CheckCircle2 className="w-8 h-8" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-foreground">
            {t("QuoteGeneratedSuccess" as any)}
          </h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            {t("QuoteSavedLinkedTo" as any)}{" "}
            <span className="font-semibold text-foreground">
              {selectedCustomer.firstName} {selectedCustomer.lastName}
            </span>
          </p>
        </div>

        <div className="pt-6 flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Button
            onClick={handleDownload}
            className="bg-indigo-600 hover:bg-indigo-700 min-w-[200px]"
            size="lg"
          >
            <FileDown className="w-4 h-4 me-2" />
            {t("DownloadPDFQuote" as any)}
          </Button>

          <Button onClick={onClose} variant="outline" size="lg" className="min-w-[200px]">
            <LogOut className="w-4 h-4 me-2" />
            {t("DoneClose" as any)}
          </Button>
        </div>
      </div>

      <QuotePrintTemplate
        paymentType={paymentType}
        wizardData={wizardData}
        selectedVehicle={selectedVehicle}
        selectedCompany={selectedCompany}
        selectedCustomer={selectedCustomer}
        selectedResult={selectedResult}
        dateStr={new Date().toLocaleDateString("ar-JO")}
        orgBranding={orgBranding}
      />
    </>
  );
}
