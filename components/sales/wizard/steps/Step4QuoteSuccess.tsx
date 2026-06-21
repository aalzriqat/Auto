"use client";

import { useState } from "react";
import Link from "next/link";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { PaymentType, WizardData } from "../types";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileDown, LogOut, HandCoins, FileText, BadgeCheck } from "lucide-react";
import { QuotePrintTemplate } from "../../QuotePrintTemplate";
import { RecordDepositDialog } from "../components/RecordDepositDialog";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { toast } from "@/components/ui/sonner";

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
  quoteId,
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

  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [depositRecorded, setDepositRecorded] = useState(false);
  const [applicationId, setApplicationId] = useState<Id<"financeApplications"> | null>(null);
  const [isStartingApplication, setIsStartingApplication] = useState(false);
  const createApplication = useMutation(api.applications.createFromQuote);

  const [saleId, setSaleId] = useState<Id<"sales"> | null>(null);
  const [isCompletingSale, setIsCompletingSale] = useState(false);
  const createSale = useMutation(api.sales.create);
  const markQuoteShared = useMutation(api.quotes.updateQuoteStatus);
  const quote = useQuery(
    api.quotes.get,
    activeOrgId ? { orgId: activeOrgId, quoteId } : "skip"
  );
  const me = useQuery(api.users.getMe);

  const handleStartApplication = async () => {
    if (!activeOrgId) return;
    setIsStartingApplication(true);
    try {
      const id = await createApplication({ orgId: activeOrgId, quoteId });
      setApplicationId(id);
      toast.success(t("ApplicationStartedSuccess" as any) ?? "Finance application started");
    } catch (error: any) {
      toast.error(error.message || (t("ApplicationStartFail" as any) ?? "Failed to start finance application"));
    } finally {
      setIsStartingApplication(false);
    }
  };

  const handleCompleteCashSale = async () => {
    if (!activeOrgId || !quote || !me) return;
    setIsCompletingSale(true);
    try {
      const id = await createSale({
        orgId: activeOrgId,
        vehicleId: wizardData.vehicleId as Id<"vehicles">,
        customerId: selectedCustomer._id,
        salespersonId: me._id,
        salePrice: quote.vehiclePrice,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "CASH",
        downPayment: quote.downPayment,
        quoteId,
      });
      setSaleId(id);
      toast.success(t("SaleCompletedSuccess" as any) ?? "Cash sale completed");
    } catch (error: any) {
      toast.error(error.message || (t("SaleCompleteFail" as any) ?? "Failed to complete sale"));
    } finally {
      setIsCompletingSale(false);
    }
  };

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

      // Downloading the quote means it's being handed to the customer — mark it
      // SHARED so the originating lead (if any) advances to NEGOTIATION. The PDF
      // already saved successfully, so a failure here shouldn't surface as an error.
      if (activeOrgId) {
        markQuoteShared({ orgId: activeOrgId, quoteId, status: "SHARED" }).catch(() => {});
      }
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

        <div className="pt-6 flex flex-wrap gap-4 justify-center items-center">
          <Button
            onClick={handleDownload}
            className="bg-indigo-600 hover:bg-indigo-700 min-w-[200px]"
            size="lg"
          >
            <FileDown className="w-4 h-4 me-2" />
            {t("DownloadPDFQuote" as any)}
          </Button>

          <Button
            onClick={() => setDepositDialogOpen(true)}
            disabled={depositRecorded || !!saleId}
            variant="outline"
            size="lg"
            className="min-w-[200px] border-amber-500/40 text-amber-600 hover:bg-amber-500/10"
          >
            <HandCoins className="w-4 h-4 me-2" />
            {depositRecorded
              ? (t("DepositRecorded" as any) ?? "Deposit Recorded ✓")
              : (t("RecordDeposit" as any) ?? "Record Deposit")}
          </Button>

          {paymentType === "INSTALLMENT" && (
            applicationId ? (
              <Button asChild variant="outline" size="lg" className="min-w-[200px] border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10">
                <Link href={activeOrgId ? `/${activeOrgId}/applications` : "#"}>
                  <FileText className="w-4 h-4 me-2" />
                  {t("ViewApplication" as any) ?? "View Application →"}
                </Link>
              </Button>
            ) : (
              <Button
                onClick={handleStartApplication}
                disabled={isStartingApplication}
                variant="outline"
                size="lg"
                className="min-w-[200px]"
              >
                <FileText className="w-4 h-4 me-2" />
                {isStartingApplication
                  ? (t("Saving" as any) || "Saving...")
                  : (t("StartFinanceApplication" as any) ?? "Start Finance Application")}
              </Button>
            )
          )}

          {paymentType === "CASH" && (
            saleId ? (
              <Button asChild variant="outline" size="lg" className="min-w-[200px] border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10">
                <Link href={activeOrgId ? `/${activeOrgId}/sales?highlightId=${saleId}` : "#"}>
                  <BadgeCheck className="w-4 h-4 me-2" />
                  {t("SaleCompleted" as any) ?? "Sale Completed ✓"}
                </Link>
              </Button>
            ) : (
              <Button
                onClick={handleCompleteCashSale}
                disabled={isCompletingSale || !quote || !me}
                variant="outline"
                size="lg"
                className="min-w-[200px] border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10"
              >
                <BadgeCheck className="w-4 h-4 me-2" />
                {isCompletingSale
                  ? (t("Saving" as any) || "Saving...")
                  : (t("CompleteCashSale" as any) ?? "Complete Cash Sale")}
              </Button>
            )
          )}

          <Button onClick={onClose} variant="outline" size="lg" className="min-w-[200px]">
            <LogOut className="w-4 h-4 me-2" />
            {t("DoneClose" as any)}
          </Button>
        </div>
      </div>

      <RecordDepositDialog
        open={depositDialogOpen}
        onOpenChange={setDepositDialogOpen}
        quoteId={quoteId}
        onRecorded={() => setDepositRecorded(true)}
      />

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
