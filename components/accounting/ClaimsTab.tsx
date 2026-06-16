"use client";

import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export function ClaimsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const formatCurrency = useCurrencyFormatter();
  const { results: claims } = usePaginatedQuery(api.claims.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });

  if (!claims) {
    return <div className="p-8 text-center text-slate-500">{t("LoadingClaims" as any)}</div>;
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex justify-between items-center">
        <h2 className="text-lg font-semibold text-slate-900">{t("Claims" as any)}</h2>
      </div>

      <div className="rounded-md border border-slate-200">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("Date" as any)}</TableHead>
              <TableHead>{t("FinancingEntity" as any)}</TableHead>
              <TableHead>{t("BuyerName" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-right">{t("ClaimAmount" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                  {t("NoClaimsFound" as any)}
                </TableCell>
              </TableRow>
            ) : (
              claims.map((claim) => (
                <TableRow key={claim._id}>
                  <TableCell className="font-medium">
                    {format(new Date(claim.claimDate), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>{claim.financingEntity}</TableCell>
                  <TableCell>{claim.buyerName}</TableCell>
                  <TableCell>
                    <Badge variant={claim.status === "REJECTED" ? "destructive" : claim.status === "PENDING" ? "secondary" : "default"}
                      className={claim.status === "PAID" ? "bg-green-100 text-green-800 hover:bg-green-100" : claim.status === "PENDING" ? "bg-yellow-100 text-yellow-800 hover:bg-yellow-100" : ""}>
                      {claim.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-semibold text-slate-900">
                    {formatCurrency(claim.claimAmount)}
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
