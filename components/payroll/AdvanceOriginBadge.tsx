"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";

/**
 * SCRUM-961: marks an employee advance that was moved out of an opening prepaid schedule (it carries
 * `prepaidReclassificationId`), so it is not read as cash paid out. Ordinary advances show nothing.
 */
export function AdvanceOriginBadge({ prepaidReclassificationId }: Readonly<{ prepaidReclassificationId?: string | null }>) {
  const { t } = useLanguage();
  if (!prepaidReclassificationId) return null;
  return (
    <Badge variant="outline" className="ms-2 border-blue-500/20 bg-blue-500/10 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
      {t("AdvanceFromPrepaidReclass")}
    </Badge>
  );
}
