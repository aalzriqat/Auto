"use client";

import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "date-fns";

export function FixedAssetsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { results: assets } = usePaginatedQuery(api.fixedAssets.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });

  if (!assets) {
    return <div className="p-8 text-center text-slate-500">Loading assets...</div>;
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
        <h2 className="text-lg font-semibold text-slate-900">{t("FixedAssets" as any) || "Fixed Assets"}</h2>
      </div>

      <div className="rounded-md border border-slate-200">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>Asset Name</TableHead>
              <TableHead>Purchase Date</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead className="text-right">Purchase Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assets.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-slate-500 py-8">
                  No fixed assets found.
                </TableCell>
              </TableRow>
            ) : (
              assets.map((asset) => (
                <TableRow key={asset._id}>
                  <TableCell className="font-medium">
                    {asset.name}
                  </TableCell>
                  <TableCell>
                    {format(new Date(asset.purchaseDate), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {asset.notes || "-"}
                  </TableCell>
                  <TableCell className="text-right font-semibold text-slate-900">
                    {formatCurrency(asset.purchaseValue)}
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
