"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SaleDialog } from "@/components/sales/SaleDialog";
import { QuoteDialog } from "@/components/sales/QuoteDialog";
import { Doc } from "@/convex/_generated/dataModel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search, Pencil, Trash2, FileText, ExternalLink, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { toast } from "@/components/ui/sonner";
import { generateBillOfSale } from "@/lib/pdf";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTableControls } from "@/hooks/useTableControls";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";
import { SaleTrailDialog } from "@/components/sales/SaleTrailDialog";

export default function SalesPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { format } = useCurrency();
  const { results: sales, status: salesStatus, loadMore: loadMoreSales } = usePaginatedQuery(
    api.sales.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 25 }
  );
  const removeSale = useMutation(api.sales.softDelete);

  const [isSaleDialogOpen, setIsSaleDialogOpen] = useState(false);
  const [isQuoteDialogOpen, setIsQuoteDialogOpen] = useState(false);
  const [editingSale, setEditingSale] = useState<any>(null);
  const [saleToDelete, setSaleToDelete] = useState<any>(null);
  const [trailSaleId, setTrailSaleId] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedSales,
  } = useTableControls({
    data: sales,
    searchFields: (s) => [s.customerName, s.vehicleSummary, s.salespersonName, s.vehicleVin],
    sortAccessors: {
      date: (s) => s.saleDate,
      price: (s) => s.salePrice,
      status: (s) => s.status,
    },
  });

  const filteredSales = sortedSales?.filter((s) => statusFilter === "ALL" || s.status === statusFilter);

  const handleEdit = (sale: any) => {
    setEditingSale(sale);
    setIsSaleDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !saleToDelete) return;
    try {
      await removeSale({ orgId: activeOrgId, saleId: saleToDelete._id });
      toast.success(t("SaleRemovedSuccess" as any));
      setSaleToDelete(null);
    } catch (error: any) {
      toast.error(error);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "COMPLETED": return <Badge variant="default" className="bg-green-600 hover:bg-green-700">{t("CompletedStatus" as any)}</Badge>;
      case "PENDING": return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30">{t("PendingStatus" as any)}</Badge>;
      case "CANCELLED": return <Badge variant="destructive">{t("CancelledStatus" as any)}</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <RoleGuard permissions={["view:sales"]}>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setIsQuoteDialogOpen(true)}>
              {t("CreateQuote" as any)}
            </Button>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex items-center w-full max-w-sm space-x-2 relative">
            <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
            <Input
              placeholder={t("SearchSales" as any)}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ps-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder={t("Status" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("AllStatuses" as any)}</SelectItem>
              <SelectItem value="COMPLETED">{t("CompletedStatus" as any)}</SelectItem>
              <SelectItem value="PENDING">{t("PendingStatus" as any)}</SelectItem>
              <SelectItem value="CANCELLED">{t("CancelledStatus" as any)}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Mobile card list */}
        <div className="flex flex-col gap-3 md:hidden">
          {filteredSales === undefined ? (
            <p className="text-center py-8 text-muted-foreground">{t("LoadingSales" as any)}</p>
          ) : filteredSales.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">{t("NoSalesFound" as any)}</p>
          ) : filteredSales.map((sale) => (
            <div key={sale._id} className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-sm truncate">{sale.customerName}</p>
                  <p className="text-xs text-muted-foreground truncate">{sale.vehicleSummary}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">{sale.vehicleVin}</p>
                </div>
                {getStatusBadge(sale.status)}
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-sm">{format(sale.salePrice)}</p>
                  <p className="text-xs text-muted-foreground">{new Date(sale.saleDate).toLocaleDateString()} · {sale.salespersonName}</p>
                </div>
                <div className="flex gap-0.5">
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setTrailSaleId(sale._id)}>
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => {
                    try { generateBillOfSale("AutoFlow Dealership", sale.customerName, sale.vehicleSummary, sale.vehicleVin, sale.salePrice, sale.saleDate); toast.success(t("BillOfSaleGenerated" as any)); } catch { toast.error(t("FailedGeneratePDF" as any)); }
                  }}>
                    <FileText className="h-4 w-4 text-blue-500" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => handleEdit(sale)}>
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setSaleToDelete(sale)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {salesStatus === "CanLoadMore" && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={() => loadMoreSales(25)}>{t("LoadMore" as any) || "Load More"}</Button>
            </div>
          )}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableColumnHeader label={t("Date" as any)} sortKey="date" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <TableHead>{t("Customer" as any)}</TableHead>
                <TableHead>{t("Vehicle" as any)}</TableHead>
                <TableHead>{t("Salesperson" as any)}</TableHead>
                <SortableColumnHeader className="text-end" label={t("Price" as any)} sortKey="price" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortableColumnHeader label={t("Status" as any)} sortKey="status" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <TableHead className="text-end">{t("Actions" as any)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSales === undefined ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {t("LoadingSales" as any)}
                  </TableCell>
                </TableRow>
              ) : filteredSales.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {t("NoSalesFound" as any)}
                  </TableCell>
                </TableRow>
              ) : (
                filteredSales.map((sale) => (
                  <TableRow key={sale._id}>
                    <TableCell className="font-medium">
                      {new Date(sale.saleDate).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{sale.customerName}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{sale.vehicleSummary}</span>
                        <span className="text-xs text-muted-foreground">{sale.vehicleVin}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <span>{sale.salespersonName}</span>
                        {(sale as any).applicationId && (
                          <Link href={`/${activeOrgId}/applications`} className="flex items-center gap-1 text-[10px] text-blue-500 hover:underline">
                            <ExternalLink className="h-2.5 w-2.5" /> Finance app
                          </Link>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {format(sale.salePrice)}
                    </TableCell>
                    <TableCell>{getStatusBadge(sale.status)}</TableCell>
                    <TableCell className="text-end">
                      <Button variant="ghost" size="icon" onClick={() => setTrailSaleId(sale._id)} title={t("ViewSaleTrail" as any)}>
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => {

                        try {
                          console.log("SALE RECORD", sale);
                          generateBillOfSale(
                            "AutoFlow Dealership",
                            sale.customerName,
                            sale.vehicleSummary,
                            sale.vehicleVin,
                            sale.salePrice,
                            sale.saleDate
                          );
                          toast.success(t("BillOfSaleGenerated" as any));
                        } catch (err) {
                          toast.error(t("FailedGeneratePDF" as any));
                        }
                      }}>
                        <FileText className="h-4 w-4 text-blue-500" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(sale)}>
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setSaleToDelete(sale)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {salesStatus === "CanLoadMore" && (
            <div className="flex justify-center p-4">
              <Button variant="outline" onClick={() => loadMoreSales(25)}>
                {t("LoadMore" as any) || "Load More"}
              </Button>
            </div>
          )}
        </div>

        <SaleDialog
          open={isSaleDialogOpen}
          onOpenChange={setIsSaleDialogOpen}
          sale={editingSale}
        />

        <QuoteDialog
          open={isQuoteDialogOpen}
          onOpenChange={setIsQuoteDialogOpen}
        />

        <SaleTrailDialog
          saleId={trailSaleId}
          open={!!trailSaleId}
          onOpenChange={(open) => !open && setTrailSaleId(null)}
        />

        <Dialog open={!!saleToDelete} onOpenChange={(open) => !open && setSaleToDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("DeleteSaleRecord" as any)}</DialogTitle>
              <DialogDescription>
                {t("DeleteSaleConfirm" as any)} <br />
                <span className="font-semibold text-foreground">{saleToDelete?.vehicleSummary}</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSaleToDelete(null)}>{t("Cancel" as any)}</Button>
              <Button variant="destructive" onClick={handleDelete}>{t("DeletePermanently" as any)}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </RoleGuard>
  );
}
