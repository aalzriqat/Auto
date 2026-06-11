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
    const steps: StepConfig[] = [
        { label: "Quote Setup", icon: Car },
        { label: "Customer", icon: User },
        { label: "Review & Generate", icon: CheckCircle2 },
    ];

    const isCash = paymentType === "CASH";

    return (
        <div className="flex items-center justify-center gap-0 mb-8">
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
                                    "w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all duration-300",
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
                                    <Check className="w-5 h-5" />
                                ) : (
                                    <Icon className="w-5 h-5" />
                                )}
                            </div>

                            <span
                                className={cn(
                                    "text-xs mt-1 font-medium whitespace-nowrap",
                                    isActive
                                        ? "text-foreground"
                                        : "text-muted-foreground"
                                )}
                            >
                                {step.label}
                            </span>
                        </div>

                        {index < steps.length - 1 && (
                            <div
                                className={cn(
                                    "w-16 h-0.5 mx-1 mb-5 transition-all duration-500",
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