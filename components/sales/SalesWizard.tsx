"use client";

import { useState } from "react";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

import { StepIndicator } from "@/components/sales/wizard/components/StepIndicator";
import Step1QuoteSetup from "@/components/sales/wizard/steps/Step1QuoteSetup";
import Step2Customer from "@/components/sales/wizard/steps/Step2Customer";
import { Step3Review } from "@/components/sales/wizard/steps/Step3Review";
import { Step4QuoteSuccess } from "@/components/sales/wizard/steps/Step4QuoteSuccess";

import { X, Banknote, CreditCard } from "lucide-react";

import type { WizardData, PaymentType } from "@/components/sales/wizard/types";

export function SalesWizard({
  paymentType,
  onClose,
}: {
  paymentType: PaymentType;
  onClose: () => void;
}) {
  // ─────────────────────────────────────────────
  // Wizard state (ONLY orchestration lives here)
  // ─────────────────────────────────────────────
  const [currentStep, setCurrentStep] = useState(1);

  const [wizardData, setWizardData] = useState<WizardData>({
    vehicleId: "",
    vehiclePrice: 0,
    desiredProfit: 0,
    downPayment: 0,
    termMonths: 84,
    selectedCompanyId: undefined,
  });

  const [selectedCustomer, setSelectedCustomer] =
    useState<Doc<"customers"> | null>(null);

  const [finalQuoteData, setFinalQuoteData] = useState<{
    quoteId: Id<"quotes">;
    selectedVehicle?: Doc<"vehicles">;
    selectedCompany?: Doc<"financeCompanies">;
    selectedResult: any;
  } | null>(null);

  // ─────────────────────────────────────────────
  // Styling based on payment type
  // ─────────────────────────────────────────────
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
      {/* ───────────────── HEADER ───────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Icon className="w-6 h-6 text-indigo-400" />
            New {paymentType === "CASH" ? "Cash" : "Installment"} Quote
          </h1>

          <p className="text-sm text-muted-foreground mt-1">
            Step {currentStep} of 3
          </p>
        </div>

        <button
          onClick={onClose}
          className="p-2 rounded-full hover:bg-muted transition"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* ───────────────── STEP INDICATOR ───────────────── */}
      <StepIndicator
        currentStep={currentStep}
        paymentType={paymentType}
      />

      {/* ───────────────── STEPS ───────────────── */}
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
            onSuccess={(data) => {
              setFinalQuoteData(data);
              setCurrentStep(4);
            }}
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