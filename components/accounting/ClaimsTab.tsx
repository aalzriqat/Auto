"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export function ClaimsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const claims = useQuery(api.claims.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  if (!claims) {
    return <div className="p-8 text-center text-slate-500">Loading claims...</div>;
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
        <h2 className="text-lg font-semibold text-slate-900">{t("Claims" as any) || "Claims"}</h2>
      </div>

      <div className="rounded-md border border-slate-200">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Financing Entity</TableHead>
              <TableHead>Buyer Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Claim Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                  No claims found.
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
