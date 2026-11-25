"use client";

import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useLanguage } from "@/components/providers/LanguageProvider";
import type { ReportRangeProblem } from "@/lib/reportRange";
export function ReportsDateFilter({
  startDateStr,
  endDateStr,
  setStartDateStr,
  setEndDateStr,
  selectedSalesperson,
  setSelectedSalesperson,
  salespersonOptions,
  rangeProblem,
}: {
  rangeProblem: ReportRangeProblem | null;
  startDateStr: string;
  endDateStr: string;
  setStartDateStr: (v: string) => void;
  setEndDateStr: (v: string) => void;
  selectedSalesperson: string;
  setSelectedSalesperson: (v: string) => void;
  salespersonOptions: Array<{ id: string; name: string }>;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-wrap items-end gap-4 no-print bg-card p-4 rounded-lg border shadow-sm">
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("StartDate")}</label>
        <Input type="date" value={startDateStr} onChange={(e) => setStartDateStr(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("EndDate")}</label>
        <Input type="date" value={endDateStr} onChange={(e) => setEndDateStr(e.target.value)} />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">{t("Salesperson")}</label>
        <SearchableSelect
          value={selectedSalesperson}
          onValueChange={setSelectedSalesperson}
          className="w-[180px]"
          placeholder={t("AllSalespeople")}
          options={[
            { value: "all", label: t("AllSalespeople") },
            ...salespersonOptions.map((sp) => ({ value: sp.name, label: sp.name })),
          ]}
        />
      </div>
      {rangeProblem !== null && (
        <p role="alert" className="basis-full text-sm text-amber-700 dark:text-amber-300">
          {t(rangeProblem === "TOO_LONG" ? "ReportRangeTooLong" : rangeProblem === "NOT_VALID" ? "ReportRangeNotValid" : "ReportRangeReversed")}
        </p>
      )}
    </div>
  );
}
