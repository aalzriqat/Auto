"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function PartnerEquityTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const equities = useQuery(api.partnerEquity.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  if (!equities) {
    return <div className="p-8 text-center text-slate-500">Loading partner equity...</div>;
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "JOD",
      minimumFractionDigits: 0,
    }).format(amount);
  };

  return (
    <div className="p-6">
      <div className="mb-6 flex justify-between items-center">
        <h2 className="text-lg font-semibold text-slate-900">{t("PartnerEquity" as any) || "Partner Equity"}</h2>
      </div>

      <div className="rounded-md border border-slate-200">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>Partner Name</TableHead>
              <TableHead className="text-right">Initial Capital</TableHead>
              <TableHead className="text-right">Current Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {equities.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-slate-500 py-8">
                  No partner equity records found.
                </TableCell>
              </TableRow>
            ) : (
              equities.map((eq) => (
                <TableRow key={eq._id}>
                  <TableCell className="font-medium">
                    {eq.partnerName}
                  </TableCell>
                  <TableCell className="text-right text-slate-600">
                    {formatCurrency(eq.initialCapital)}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-slate-900">
                    {formatCurrency(eq.currentBalance)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
