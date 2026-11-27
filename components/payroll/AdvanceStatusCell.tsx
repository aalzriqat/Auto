"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { Badge } from "@/components/ui/badge";
import { TableCell } from "@/components/ui/table";
import { AdvanceOriginBadge } from "./AdvanceOriginBadge";

/**
 * The status cell of the payroll advances list: the advance's status badge (unchanged from the page it came from) and,
 * for an advance moved out of an opening prepaid schedule (SCRUM-961), the badge that says so.
 */
export function AdvanceStatusCell({ advance }: Readonly<{
  advance: { status: string; prepaidReclassificationId?: string | null };
}>) {
  const { t } = useLanguage();
  return (
    <TableCell>
      <Badge variant="outline" className={advance.status === "OUTSTANDING" ? "text-orange-600 border-orange-300" : "text-green-600 border-green-300"}>
        {t(`AdvanceStatus_${advance.status}`)}
      </Badge>
      <AdvanceOriginBadge prepaidReclassificationId={advance.prepaidReclassificationId} />
    </TableCell>
  );
}
