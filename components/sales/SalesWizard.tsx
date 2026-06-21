"use client";

import { useState, useEffect, useRef } from "react";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

import { StepIndicator } from "@/components/sales/wizard/components/StepIndicator";
import Step1QuoteSetup from "@/components/sales/wizard/steps/Step1QuoteSetup";
import Step2Customer from "@/components/sales/wizard/steps/Step2Customer";
import { Step3Review } from "@/components/sales/wizard/steps/Step3Review";
import { Step4QuoteSuccess } from "@/components/sales/wizard/steps/Step4QuoteSuccess";

import { X, Banknote, CreditCard, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

import type { WizardData, PaymentType } from "@/components/sales/wizard/types";

export interface WizardDraft {
  paymentType: PaymentType;
  currentStep: number;
  wizardData: WizardData;
  selectedCustomerId: string | null;
  savedAt: number;
}

export function SalesWizard({
  paymentType,
  onClose,
  initialDraft,
  resumeDraft,
  initialCustomer,
}: {
  paymentType: PaymentType;
  onClose: () => void;
  /** Pre-filled from an approval snapshot — starts at step 1 */
  initialDraft?: Partial<WizardData>;
  /** Direct resume from the sales page draft card — restores step + customer */
  resumeDraft?: WizardDraft;
  /** Pre-selected customer when launching from a lead's context */
  initialCustomer?: Doc<"customers"> | null;
}) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const saveDraftMutation = useMutation(api.wizardDrafts.saveDraft);
  const clearDraftMutation = useMutation(api.wizardDrafts.clearDraft);

  // Only query the DB draft when neither an approval snapshot nor a direct resume is supplied
  const skipDbDraftQuery = !!(initialDraft || resumeDraft);
  const dbDraft = useQuery(
    api.wizardDrafts.getMyDraft,
    activeOrgId && !skipDbDraftQuery ? { orgId: activeOrgId as Id<"organizations"> } : "skip"
  );

  const [currentStep, setCurrentStep] = useState(() => resumeDraft?.currentStep ?? 1);
  const [wizardData, setWizardData] = useState<WizardData>(() => {
    if (resumeDraft) return { ...resumeDraft.wizardData };
    return {
      vehicleId: initialDraft?.vehicleId ?? "",
      vehiclePrice: initialDraft?.vehiclePrice ?? 0,
      desiredProfit: initialDraft?.desiredProfit ?? 0,
      downPayment: initialDraft?.downPayment ?? 0,
      termMonths: initialDraft?.termMonths ?? 84,
      selectedCompanyId: initialDraft?.selectedCompanyId,
      manualProfitRate: initialDraft?.manualProfitRate,
      manualInsuranceRate: initialDraft?.manualInsuranceRate,
      manualExecutionCommission: initialDraft?.manualExecutionCommission,
      leadId: initialDraft?.leadId,
    };
  });
  const [selectedCustomer, setSelectedCustomer] = useState<Doc<"customers"> | null>(
    resumeDraft ? null : initialCustomer ?? null
  );
  const [finalQuoteData, setFinalQuoteData] = useState<{
    quoteId: Id<"quotes">;
    selectedVehicle?: Doc<"vehicles">;
    selectedCompany?: Doc<"financeCompanies">;
    selectedResult: any;
  } | null>(null);

  // Resume prompt — only shown when coming in cold (no initialDraft / resumeDraft)
  const [storedDraft, setStoredDraft] = useState<WizardDraft | null>(null);
  const [showResumePrompt, setShowResumePrompt] = useState(false);
  const hasCheckedDraft = useRef(false);

  useEffect(() => {
    if (hasCheckedDraft.current) return;
    if (dbDraft === undefined) return; // Still loading
    hasCheckedDraft.current = true;

    if (dbDraft && dbDraft.paymentType === paymentType && dbDraft.currentStep > 1) {
      setStoredDraft({
        paymentType: dbDraft.paymentType as PaymentType,
        currentStep: dbDraft.currentStep,
        wizardData: dbDraft.wizardData as WizardData,
        selectedCustomerId: dbDraft.selectedCustomerId ?? null,
        savedAt: dbDraft.savedAt,
      });
      setShowResumePrompt(true);
    }
  }, [dbDraft, paymentType]);

  // Debounced auto-save to DB on every meaningful state change
  useEffect(() => {
    if (!activeOrgId || showResumePrompt) return;
    if (currentStep === 4) return;

    const timer = setTimeout(() => {
      saveDraftMutation({
        orgId: activeOrgId as Id<"organizations">,
        paymentType,
        currentStep,
        wizardData,
        selectedCustomerId: selectedCustomer?._id,
      });
    }, 1500);

    return () => clearTimeout(timer);
    // saveDraftMutation is stable; omitting it avoids a spurious extra save
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrgId, paymentType, currentStep, wizardData, selectedCustomer, showResumePrompt]);

  function handleResumeDraft() {
    if (!storedDraft) return;
    setWizardData(storedDraft.wizardData);
    setCurrentStep(storedDraft.currentStep);
    setShowResumePrompt(false);
  }

  function handleDiscardDraft() {
    if (activeOrgId) clearDraftMutation({ orgId: activeOrgId as Id<"organizations"> });
    setShowResumePrompt(false);
  }

  function handleClose() {
    // Draft already saved to DB — user can resume next time
    onClose();
  }

  function handleSuccess(data: typeof finalQuoteData) {
    if (activeOrgId) clearDraftMutation({ orgId: activeOrgId as Id<"organizations"> });
    setFinalQuoteData(data);
    setCurrentStep(4);
  }

  const accentGradient =
    paymentType === "CASH"
      ? "from-teal-950/40 to-background"
      : "from-indigo-950/40 to-background";

  const Icon = paymentType === "CASH" ? Banknote : CreditCard;

  return (
    <div
      className={cn(
        "min-h-[calc(100vh-8rem)] rounded-2xl border bg-gradient-to-b p-6 md:p-8",
        accentGradient
      )}
    >
      {/* HEADER */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <Icon className="w-6 h-6 text-indigo-400" />
            {t(paymentType === "CASH" ? "NewCashQuote" as any : "NewInstallmentQuote" as any)}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("StepLabel" as any)} {currentStep} {t("StepOf" as any)} 3
          </p>
        </div>
        <button
          onClick={handleClose}
          className="p-2 rounded-full hover:bg-muted transition"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* RESUME PROMPT */}
      {showResumePrompt && storedDraft && (
        <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-medium text-amber-700 dark:text-amber-400 text-sm">
              {t("DraftFound" as any) ?? "You have an unsaved draft from a previous session."}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("DraftFoundDesc" as any) ?? `Saved at step ${storedDraft.currentStep} — ${new Date(storedDraft.savedAt).toLocaleTimeString()}`}
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={handleDiscardDraft}>
              {t("StartFresh" as any) ?? "Start Fresh"}
            </Button>
            <Button size="sm" onClick={handleResumeDraft} className="bg-amber-600 hover:bg-amber-700 text-white">
              <RotateCcw className="w-3.5 h-3.5 me-1.5" />
              {t("ResumeDraft" as any) ?? "Resume Draft"}
            </Button>
          </div>
        </div>
      )}

      {/* STEP INDICATOR */}
      <StepIndicator currentStep={currentStep} paymentType={paymentType} />

      {/* STEPS */}
      <div className="mt-6">
        {currentStep === 1 && (
          <Step1QuoteSetup
            paymentType={paymentType}
            initialData={wizardData}
            onNext={(data) => {
              setWizardData(data);
              setCurrentStep(2);
            }}
          />
        )}

        {currentStep === 2 && (
          <Step2Customer
            paymentType={paymentType}
            selectedCustomer={selectedCustomer}
            onSelectCustomer={setSelectedCustomer}
            onNext={() => setCurrentStep(3)}
            onBack={() => setCurrentStep(1)}
          />
        )}

        {currentStep === 3 && selectedCustomer && (
          <Step3Review
            paymentType={paymentType}
            wizardData={wizardData}
            selectedCustomer={selectedCustomer}
            onBack={() => setCurrentStep(2)}
            onSuccess={(data) => handleSuccess(data)}
          />
        )}

        {currentStep === 4 && selectedCustomer && finalQuoteData && (
          <Step4QuoteSuccess
            paymentType={paymentType}
            wizardData={wizardData}
            selectedCustomer={selectedCustomer}
            quoteId={finalQuoteData.quoteId}
            selectedVehicle={finalQuoteData.selectedVehicle}
            selectedCompany={finalQuoteData.selectedCompany}
            selectedResult={finalQuoteData.selectedResult}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
