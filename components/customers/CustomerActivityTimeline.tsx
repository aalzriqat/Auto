"use client";

import { Car, CheckSquare, CircleDollarSign, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";

export interface CustomerActivityItem {
  id: string;
  kind: "lead" | "sale" | "quote" | "task";
  title: string;
  detail: string;
  status: string;
  timestamp: number;
}

export function formatCustomerDateTime(timestamp: number, locale: "en" | "ar"): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-JO" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function CustomerActivityIcon({ kind }: Readonly<Pick<CustomerActivityItem, "kind">>) {
  switch (kind) {
    case "sale":
      return <CircleDollarSign className="h-4 w-4" />;
    case "lead":
      return <Car className="h-4 w-4" />;
    case "quote":
      return <FileText className="h-4 w-4" />;
    default:
      return <CheckSquare className="h-4 w-4" />;
  }
}

export function CustomerActivityTimeline({
  items,
  isLoading,
}: Readonly<{
  items: CustomerActivityItem[];
  isLoading: boolean;
}>) {
  const { t, locale } = useLanguage();
  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Loading")}</p>;
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">{t("NoCustomerActivity")}</p>;
  }

  return (
    <div className="relative space-y-0 before:absolute before:bottom-4 before:start-[17px] before:top-4 before:w-px before:bg-border">
      {items.map((activity) => (
        <div key={activity.id} className="relative flex gap-3 py-3">
          <span className="z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background">
            <CustomerActivityIcon kind={activity.kind} />
          </span>
          <div className="min-w-0 flex-1 rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div><p className="text-sm font-medium">{activity.title}</p><p className="text-xs text-muted-foreground">{activity.detail}</p></div>
              <Badge variant="outline">{activity.status}</Badge>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{formatCustomerDateTime(activity.timestamp, locale)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

