"use client";

import { Check, AlertTriangle, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { FinanceComparisonResult } from "../hooks/useFinanceComparison";
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

const DESC_TRANSLATIONS: Record<string, string> = {
  "في حال كان العمل على تطبيقات التوصيل يطلب كفيل درجة اولى بالاضافة الى كفيل عادي": "If working on delivery apps, a 1st-degree guarantor and a regular guarantor are required.",
  "في حالة السجل التجاري يجب ان يكون السجل لسنة او اكثر ويرفق معه كشف حساب و رخصة مهن. (ملاحظة: تمويل فقط BYD Toyota KIA)": "For commercial register, it must be 1+ year old with bank statement and vocational license. (Note: Only finances BYD, Toyota, KIA)",
  "في حال كان العمل على تطبيقات التوصيل يطلب كفيل درجة اولى وكفيل عادي": "If working on delivery apps, a 1st-degree guarantor and a regular guarantor are required.",
  "في حالة السجل التجاري يجب ان يكون السجل لسنة او اكثر ويرفق معه كشف حساب و رخصة مهن": "For commercial register, it must be 1+ year old with bank statement and vocational license.",
  "المستعمل عمر 7 سنوات او اقل": "Used vehicles must be 7 years old or less."
};

interface FinanceCompanyCardProps {
  result: FinanceComparisonResult;
  selected: boolean;
  onSelect: (companyId: string) => void;
}

export function FinanceCompanyCard({
  result,
  selected,
  onSelect,
}: FinanceCompanyCardProps) {
  const { isRtl, t } = useLanguage();

  return (
    <button
      type="button"
      onClick={() => {
        if (!result.exceedsValuation) {
          onSelect(result.companyId);
        }
      }}
      className={cn(
        "text-start rounded-xl border transition-all duration-200 overflow-hidden",
        result.exceedsValuation
          ? "border-red-500/40 opacity-70 cursor-not-allowed"
          : selected
            ? "border-indigo-500 ring-2 ring-indigo-500/30 shadow-lg shadow-indigo-500/10"
            : "border-border hover:border-indigo-500/50 hover:shadow-md"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "px-4 py-3 border-b flex items-center justify-between",
          selected
            ? "bg-indigo-500/10 border-indigo-500/30"
            : "bg-muted/30 border-border"
        )}
      >
        <div>
          <p className="font-semibold text-sm">
            {result.companyName}
          </p>

          <p className="text-xs text-muted-foreground">
            {result.profitRate}% {t("ProfitRate" as any) || "Profit Rate"}
          </p>
        </div>

        {selected && (
          <div className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center">
            <Check className="w-3 h-3 text-white" />
          </div>
        )}

        {result.exceedsValuation && (
          <AlertTriangle className="w-4 h-4 text-red-400" />
        )}
      </div>

      {/* Monthly installment */}
      <div className="px-4 pt-3 pb-2 text-center bg-gradient-to-b from-background to-muted/10">
        <p className="text-xs text-muted-foreground mb-0.5">
          {t("MonthlyInstallment" as any)}
        </p>

        <p
          className={cn(
            "text-2xl font-bold",
            result.exceedsValuation
              ? "text-red-400"
              : selected
                ? "text-indigo-400"
                : "text-foreground"
          )}
        >
          {result.monthlyInstallment.toLocaleString(
            undefined,
            {
              minimumFractionDigits: 2,
            }
          )}

          <span className="text-sm font-normal text-muted-foreground ms-1">
            {t("JOD" as any)}
          </span>
        </p>
      </div>

      {/* Details */}
      <div className="px-4 pb-3 space-y-1.5 text-xs">
        <div className="flex justify-between text-muted-foreground">
          <span>{t("FinancedAmount" as any)}</span>

          <span className="font-medium text-foreground">
            {result.totalFinancedAmount.toLocaleString(
              undefined,
              {
                minimumFractionDigits: 2,
              }
            )}
          </span>
        </div>

        <div className="flex justify-between text-muted-foreground">
          <span>{t("TotalProfit" as any) || "Bank Profit"}</span>

          <span className="font-medium text-foreground">
            {result.totalProfit.toLocaleString(
              undefined,
              {
                minimumFractionDigits: 2,
              }
            )}
          </span>
        </div>

        {result.takafulAmount > 0 && (
          <div className="flex justify-between text-muted-foreground">
            <span>{t("Takaful" as any)}</span>

            <span className="font-medium text-foreground">
              {result.takafulAmount.toLocaleString(
                undefined,
                {
                  minimumFractionDigits: 2,
                }
              )}
            </span>
          </div>
        )}

        {result.actualValuation > 0 && (
          <div className="flex justify-between text-muted-foreground">
            <span>{t("BankValuation" as any)}</span>

            <span
              className={cn(
                "font-medium",
                result.exceedsValuation
                  ? "text-red-400"
                  : "text-foreground"
              )}
            >
              {result.actualValuation.toLocaleString(
                undefined,
                {
                  minimumFractionDigits: 2,
                }
              )}
            </span>
          </div>
        )}

        {/* Exceeds valuation warning */}
        {result.exceedsValuation && (
          <div className="rounded-md bg-red-950/40 border border-red-500/30 p-2 mt-2 space-y-0.5">
            <p className="font-semibold text-red-400">
              {t("ExceedsLimit" as any) || "Exceeds Bank Limit"}
            </p>

            <p className="text-red-300/80">
              {t("ExceedingBy" as any) || "Exceeding by"}:{" "}
              {(result.totalFinancedAmount - result.maxFinancingAllowed).toLocaleString(undefined, { minimumFractionDigits: 2 })} {t("JOD" as any)}
            </p>

            <p className="text-red-300/80">
              {t("MinDownPayment" as any)}:{" "}
              {result.minimumDownPayment.toLocaleString(
                undefined,
                {
                  minimumFractionDigits: 2,
                }
              )}{" "}
              {t("JOD" as any)}
            </p>
          </div>
        )}

        {/* Required Documents */}
        {result.companyDocs.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <p className="font-medium text-muted-foreground mb-1 flex items-center gap-1">
              <FileText className="w-3 h-3" />
              {t("RequiredDocuments" as any)}
            </p>

            <ul className="space-y-0.5">
              {result.companyDocs.map((doc: any) => (
                <li
                  key={doc._id}
                  className="flex items-center gap-1.5"
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full flex-shrink-0",
                      doc.isRequired
                        ? "bg-amber-400"
                        : "bg-muted-foreground"
                    )}
                  />

                  <div className="flex flex-col">
                    <span
                      className={
                        doc.isRequired
                          ? "text-foreground/80"
                          : "text-muted-foreground"
                      }
                    >
                      {isRtl ? doc.documentName : (DOC_TRANSLATIONS[doc.documentName] || doc.documentName)}

                      {doc.isRequired && (
                        <span className="text-amber-400 ms-0.5">
                          *
                        </span>
                      )}
                    </span>
                    {doc.description && (
                      <span className="text-[10px] text-muted-foreground/80 leading-tight mt-0.5">
                        {isRtl ? doc.description : (DESC_TRANSLATIONS[doc.description] || doc.description)}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </button>
  );
}