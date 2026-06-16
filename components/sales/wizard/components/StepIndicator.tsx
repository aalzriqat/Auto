"use client";

import { cn } from "@/lib/utils";
import { Check } from "lucide-react";
import {
    Car,
    User,
    CheckCircle2,
    LucideIcon,
} from "lucide-react";
import { PaymentType } from "../types";
import { useLanguage } from "@/components/providers/LanguageProvider";

interface StepIndicatorProps {
    currentStep: number;
    paymentType: PaymentType;
}

type StepConfig = {
    label: string;
    icon: LucideIcon;
};

export function StepIndicator({
    currentStep,
    paymentType,
}: StepIndicatorProps) {
    const { t } = useLanguage();
    const steps: StepConfig[] = [
        { label: t("WizardStepQuoteSetup" as any), icon: Car },
        { label: t("WizardStepCustomer" as any), icon: User },
        { label: t("WizardStepReviewGenerate" as any), icon: CheckCircle2 },
    ];

    const isCash = paymentType === "CASH";

    return (
        <div className="flex items-center justify-center gap-0 mb-6 md:mb-8">
            {steps.map((step, index) => {
                const stepNum = index + 1;
                const isCompleted = currentStep > stepNum;
                const isActive = currentStep === stepNum;
                const Icon = step.icon;

                return (
                    <div key={stepNum} className="flex items-center">
                        <div className="flex flex-col items-center">
                            <div
                                className={cn(
                                    "w-9 h-9 md:w-10 md:h-10 rounded-full flex items-center justify-center border-2 transition-all duration-300",
                                    isCompleted
                                        ? "bg-emerald-500 border-emerald-500 text-white"
                                        : isActive
                                            ? isCash
                                                ? "bg-teal-600 border-teal-600 text-white shadow-lg shadow-teal-500/30"
                                                : "bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-500/30"
                                            : "bg-muted border-border text-muted-foreground"
                                )}
                            >
                                {isCompleted ? (
                                    <Check className="w-4 h-4 md:w-5 md:h-5" />
                                ) : (
                                    <Icon className="w-4 h-4 md:w-5 md:h-5" />
                                )}
                            </div>

                            <span
                                className={cn(
                                    "text-xs mt-1 font-medium whitespace-nowrap",
                                    isActive
                                        ? "text-foreground"
                                        : "text-muted-foreground hidden sm:block"
                                )}
                            >
                                {step.label}
                            </span>
                        </div>

                        {index < steps.length - 1 && (
                            <div
                                className={cn(
                                    "w-10 sm:w-16 h-0.5 mx-1 mb-4 md:mb-5 transition-all duration-500",
                                    currentStep > stepNum
                                        ? "bg-emerald-500"
                                        : "bg-border"
                                )}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}