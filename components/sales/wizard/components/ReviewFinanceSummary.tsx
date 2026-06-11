"use client";

import { cn } from "@/lib/utils";
import { FileText } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";

const DOC_TRANSLATIONS: Record<string, string> = {
  "هوية": "ID Card",
  "كشف ضمان": "Social Security Statement",
  "شهادة راتب": "Salary Certificate",
  "اي كفيلين": "Any Two Guarantors",
  "كفيل درجة اولى": "First-Degree Guarantor",
  "اثبات دخل كفيل درجة اولى": "First-Degree Guarantor Proof of Income",
  "اي كفيل": "Any Guarantor",
  "فاتورة كهرباء": "Electricity Bill",
  "دفتر عائلة": "Family Book",
  "عقد ايجار": "Lease Agreement",
  "كفيل انثى او كفيل عادي (يفضل انثى)": "Female Guarantor or Regular (Female Preferred)",
  "هوية/كفيل انثى": "ID / Female Guarantor",
};

interface CompanyDoc {
  _id: string;
  documentName: string;
  isRequired: boolean;
}

interface ReviewFinanceSummaryProps {
  isCash: boolean;
  companyName: string;
  profitRateApplied?: number;
  monthlyInstallment: number;
  totalFinancedAmount: number;
  totalProfit: number;
  takafulAmount?: number;
  desiredProfit?: number;
  companyDocs?: CompanyDoc[];
  className?: string;
}

export default function ReviewFinanceSummary({
  isCash,
  companyName,
  profitRateApplied,
  monthlyInstallment,
  totalFinancedAmount,
  totalProfit,
  takafulAmount = 0,
  desiredProfit = 0,
  companyDocs = [],
  className,
}: ReviewFinanceSummaryProps) {
  const { isRtl, t } = useLanguage();

  return (
    <div className={cn("rounded-xl border p-5 space-y-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="font-semibold">{companyName}</p>

        {!isCash && profitRateApplied !== undefined && (
          <span className="text-xs px-2 py-1 rounded-md bg-muted border">
            {profitRateApplied}% {t("Rate" as any)}
          </span>
        )}
      </div>

      {/* Main stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {!isCash ? (
          <>
            {/* Monthly */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">{t("Monthly" as any) || "Monthly"}</p>
              <p className="text-xl font-bold text-indigo-400">
                {(monthlyInstallment || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}
                <span className="text-xs text-muted-foreground ml-1">{t("JOD" as any)}</span>
              </p>
            </div>

            {/* Financed */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">{t("FinancedAmount" as any)}</p>
              <p className="text-sm font-semibold">
                {(totalFinancedAmount || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}{" "}
                {t("JOD" as any)}
              </p>
            </div>

            {/* Profit */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">{t("BankProfit" as any)}</p>
              <p className="text-sm font-semibold">
                {(totalProfit || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}{" "}
                {t("JOD" as any)}
              </p>
            </div>

            {/* Your profit */}
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">{t("YourProfit" as any)}</p>
              <p className="text-sm font-semibold text-emerald-400">
                {(desiredProfit || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                })}{" "}
                {t("JOD" as any)}
              </p>
            </div>
          </>
        ) : (
          <div className="col-span-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">
              {t("TotalToCollect" as any)}
            </p>
            <p className="text-2xl font-bold">
              {(totalFinancedAmount || 0).toLocaleString(undefined, {
                minimumFractionDigits: 2,
              })}{" "}
              {t("JOD" as any)}
            </p>
          </div>
        )}
      </div>

      {/* Documents */}
      {!isCash && companyDocs.length > 0 && (
        <div className="pt-3 border-t space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <FileText className="w-3 h-3" />
            {t("RequiredDocuments" as any)}
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 text-xs">
            {companyDocs.map((doc) => (
              <div key={doc._id} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full flex-shrink-0",
                    doc.isRequired ? "bg-amber-400" : "bg-muted-foreground/50"
                  )}
                />
                <span
                  className={
                    doc.isRequired
                      ? "text-foreground/80"
                      : "text-muted-foreground"
                  }
                >
                  {isRtl ? doc.documentName : (DOC_TRANSLATIONS[doc.documentName] || doc.documentName)}
                  {doc.isRequired && (
                    <span className="text-amber-400 ml-1">*</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}