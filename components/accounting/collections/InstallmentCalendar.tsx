"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";

function dayKey(value: number): string {
  return format(new Date(value), "yyyy-MM-dd");
}

export function InstallmentCalendar() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const formatCurrency = useCurrencyFormatter();
  const [month, setMonth] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<Date | undefined>(new Date());

  const rangeStart = useMemo(() => startOfMonth(month).getTime(), [month]);
  const rangeEnd = useMemo(() => endOfMonth(month).getTime(), [month]);

  const receivables = useQuery(
    api.collections.listReceivablesDueBetween,
    activeOrgId ? { orgId: activeOrgId, startDate: rangeStart, endDate: rangeEnd } : "skip"
  );

  const byDay = useMemo(() => {
    const map = new Map<string, NonNullable<typeof receivables>>();
    for (const row of receivables ?? []) {
      const key = dayKey(row.dueDate);
      const existing = map.get(key) ?? [];
      existing.push(row);
      map.set(key, existing);
    }
    return map;
  }, [receivables]);

  const daysWithReceivables = useMemo(
    () => [...byDay.keys()].map((key) => new Date(`${key}T00:00:00`)),
    [byDay]
  );
  const today = new Date();
  const overdueDays = useMemo(
    () => daysWithReceivables.filter((d) => d < new Date(today.getFullYear(), today.getMonth(), today.getDate())),
    [daysWithReceivables]
  );

  const selectedKey = selectedDay ? dayKey(selectedDay.getTime()) : undefined;
  const selectedRows = selectedKey ? byDay.get(selectedKey) ?? [] : [];

  if (!activeOrgId) return null;
  if (receivables === undefined) {
    return <p className="p-8 text-center text-slate-500">{t("Loading" as any)}</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
      <div className="rounded-md border border-slate-200 bg-white">
        <Calendar
          mode="single"
          month={month}
          onMonthChange={setMonth}
          selected={selectedDay}
          onSelect={setSelectedDay}
          modifiers={{ hasReceivables: daysWithReceivables, overdue: overdueDays }}
          modifiersClassNames={{
            hasReceivables: "bg-amber-50 font-semibold",
            overdue: "bg-rose-50 text-rose-700",
          }}
        />
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <h3 className="font-semibold text-slate-900">
          {selectedDay ? format(selectedDay, "MMM d, yyyy") : t("SelectADay" as any)}
        </h3>
        {selectedRows.length === 0 ? (
          <p className="text-sm text-slate-500">{t("NoInstallmentsDue" as any)}</p>
        ) : (
          <div className="space-y-2">
            {selectedRows.map((row) => (
              <div key={row._id} className="flex items-center justify-between rounded-md border border-slate-100 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{row.customerName}</div>
                  <div className="text-xs text-slate-500">{row.vehicleLabel || row.title}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">{formatCurrency(row.outstandingAmount)}</div>
                  <Badge variant="outline" className="mt-1">{row.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
