"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

export function GeneralLedgerTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const transactions = useQuery(api.transactions.list, activeOrgId ? { orgId: activeOrgId } : "skip");

  if (!transactions) {
    return <div className="p-8 text-center text-slate-500">Loading ledger...</div>;
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
        <h2 className="text-lg font-semibold text-slate-900">{t("RecentTransactions" as any) || "Recent Transactions"}</h2>
      </div>

      <div className="rounded-md border border-slate-200">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                  No transactions found.
                </TableCell>
              </TableRow>
            ) : (
              transactions.map((tx) => (
                <TableRow key={tx._id}>
                  <TableCell className="font-medium">
                    {format(new Date(tx.date), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={tx.type === "IN" ? "default" : "destructive"}
                           className={tx.type === "IN" ? "bg-green-100 text-green-800 hover:bg-green-100" : ""}>
                      {tx.type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-slate-50 text-slate-600">
                      {tx.category.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate" title={tx.description}>
                    {tx.description}
                  </TableCell>
                  <TableCell className={`text-right font-semibold ${tx.type === "IN" ? "text-emerald-600" : "text-rose-600"}`}>
                    {tx.type === "IN" ? "+" : "-"}{formatCurrency(tx.amount)}
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
