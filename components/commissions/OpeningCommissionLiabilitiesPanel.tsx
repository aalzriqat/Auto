"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { scaleForCurrency } from "@/convex/utils/money";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Mount only inside the existing VIEW_COMMISSIONS guard; all scope and debt proof are server-owned. */
export function OpeningCommissionLiabilitiesPanel({ orgId }: { orgId: Id<"organizations"> }) {
  const { t, locale } = useLanguage();
  const rows = useQuery(api.openingCommissionLiabilities.list, { orgId });
  if (rows === undefined) return <p role="status">{t("OpeningCommissionLoading")}</p>;
  if (rows.length === 0) return null;
  function amount(minor: number | null, currency: string) {
    if (minor === null) return "—";
    const scale = scaleForCurrency(currency);
    return `${(minor / 10 ** scale).toLocaleString(locale, { minimumFractionDigits: scale, maximumFractionDigits: scale })} ${currency}`;
  }
  function status(row: NonNullable<typeof rows>[number]) {
    if (row.sourceStatus !== "AVAILABLE") return t("OpeningCommissionSourceUnavailable");
    if (row.notYetEffective) return t("OpeningCommissionNotEffective");
    if (row.remainingMinor === 0) return t("OpeningCommissionSettled");
    return t(row.payrollAvailable ? "OpeningCommissionOwed" : "OpeningCommissionPayrollUnavailable");
  }
  return <Card>
    <CardHeader><CardTitle>{t("OpeningEmployeeCommissions")}</CardTitle><p className="text-sm text-muted-foreground">{t("OpeningCommissionPayrollOnly")}</p></CardHeader>
    <CardContent><Table>
      <TableHeader><TableRow><TableHead>{t("OpeningAllocationEmployee")}</TableHead><TableHead>{t("AmountLabel")}</TableHead><TableHead>{t("OpeningCommissionOwed")}</TableHead><TableHead>{t("Status")}</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(row => <TableRow key={row._id}>
        <TableCell>{row.employeeName}</TableCell><TableCell>{amount(row.amountMinor, row.currency)}</TableCell><TableCell>{amount(row.remainingMinor, row.currency)}</TableCell>
        <TableCell>{status(row)}</TableCell>
      </TableRow>)}</TableBody>
    </Table></CardContent>
  </Card>;
}
