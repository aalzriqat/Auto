"use client";

import { useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";

const defaultEnd = new Date();
const defaultStart = new Date();
defaultStart.setDate(defaultStart.getDate() - 30);

export function GeneralLedgerTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();

  const [startDateStr, setStartDateStr] = useState(defaultStart.toISOString().split("T")[0]);
  const [endDateStr, setEndDateStr] = useState(defaultEnd.toISOString().split("T")[0]);
  const [filterActive, setFilterActive] = useState(false);

  const startDate = filterActive ? new Date(startDateStr).setHours(0, 0, 0, 0) : undefined;
  const endDate = filterActive ? new Date(endDateStr).setHours(23, 59, 59, 999) : undefined;

  const { results: transactions, status, loadMore } = usePaginatedQuery(
    api.transactions.list,
    activeOrgId
      ? { orgId: activeOrgId, startDate, endDate }
      : "skip",
    { initialNumItems: 100 }
  );

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "JOD", minimumFractionDigits: 0 }).format(amount);

  const totalIn = transactions?.filter((t) => t.type === "IN").reduce((s, t) => s + t.amount, 0) ?? 0;
  const totalOut = transactions?.filter((t) => t.type === "OUT").reduce((s, t) => s + t.amount, 0) ?? 0;

  return (
    <div className="p-6 space-y-4">
      {/* Date filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">{t("StartDate" as any)}</label>
          <Input type="date" value={startDateStr} onChange={(e) => setStartDateStr(e.target.value)} className="h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">{t("EndDate" as any)}</label>
          <Input type="date" value={endDateStr} onChange={(e) => setEndDateStr(e.target.value)} className="h-8 text-sm" />
        </div>
        <Button size="sm" variant={filterActive ? "default" : "outline"} onClick={() => setFilterActive(!filterActive)}>
          {filterActive ? "Clear filter" : "Apply filter"}
        </Button>
      </div>

      {/* Summary row */}
      <div className="flex gap-4 text-sm">
        <span className="text-emerald-600 font-semibold">IN: {formatCurrency(totalIn)}</span>
        <span className="text-rose-600 font-semibold">OUT: {formatCurrency(totalOut)}</span>
        <span className="text-slate-600 font-semibold">Net: {formatCurrency(totalIn - totalOut)}</span>
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
            {!transactions ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">Loading...</TableCell>
              </TableRow>
            ) : transactions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">No transactions found.</TableCell>
              </TableRow>
            ) : (
              transactions.map((tx) => (
                <TableRow key={tx._id}>
                  <TableCell className="font-medium">{format(new Date(tx.date), "MMM d, yyyy")}</TableCell>
                  <TableCell>
                    <Badge
                      variant={tx.type === "IN" ? "default" : "destructive"}
                      className={tx.type === "IN" ? "bg-green-100 text-green-800 hover:bg-green-100" : ""}
                    >
                      {tx.type}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-slate-50 text-slate-600">
                      {tx.category.replace(/_/g, " ")}
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

      {status === "CanLoadMore" && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => loadMore(100)}>Load more</Button>
        </div>
      )}
    </div>
  );
}
