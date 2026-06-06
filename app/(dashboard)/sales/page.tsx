"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SaleDialog } from "@/components/sales/SaleDialog";
import { Doc } from "@/convex/_generated/dataModel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Pencil, Trash2, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "sonner";
import { generateBillOfSale } from "@/lib/pdf";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function SalesPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const sales = useQuery(api.sales.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeSale = useMutation(api.sales.remove);

  const [searchQuery, setSearchQuery] = useState("");
  const [isSaleDialogOpen, setIsSaleDialogOpen] = useState(false);
  const [editingSale, setEditingSale] = useState<any>(null);
  const [saleToDelete, setSaleToDelete] = useState<any>(null);

  const filteredSales = sales?.filter(s => {
    const q = searchQuery.toLowerCase();
    return s.customerName.toLowerCase().includes(q) || 
           s.vehicleSummary.toLowerCase().includes(q) ||
           s.salespersonName.toLowerCase().includes(q) ||
           s.vehicleVin.toLowerCase().includes(q);
  });

  const handleEdit = (sale: any) => {
    setEditingSale(sale);
    setIsSaleDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingSale(null);
    setIsSaleDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !saleToDelete) return;
    try {
      await removeSale({ orgId: activeOrgId, saleId: saleToDelete._id });
      toast.success(t("SaleRemovedSuccess" as any) || "Sale deleted successfully");
      setSaleToDelete(null);
    } catch (error: any) {
      toast.error(error.message || (t("SaleRemoveFail" as any) || "Failed to delete sale"));
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "COMPLETED": return <Badge variant="default" className="bg-green-600 hover:bg-green-700">{t("Completed" as any) || "Completed"}</Badge>;
      case "PENDING": return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30">{t("Pending" as any) || "Pending"}</Badge>;
      case "CANCELLED": return <Badge variant="destructive">{t("Cancelled" as any) || "Cancelled"}</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t("SalesRecords" as any) || "Sales Records"}</h2>
          <p className="text-muted-foreground">
            {t("SalesRecordsDesc" as any) || "Log and manage vehicle sales and track revenue."}
          </p>
        </div>
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> {t("LogSale" as any) || "Log Sale"}
        </Button>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
        <Input
          placeholder={t("SearchSales" as any) || "Search by customer, vehicle, or salesperson..."}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ps-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Date" as any) || "Date"}</TableHead>
              <TableHead>{t("Customer" as any) || "Customer"}</TableHead>
              <TableHead>{t("Vehicle" as any) || "Vehicle"}</TableHead>
              <TableHead>{t("Salesperson" as any) || "Salesperson"}</TableHead>
              <TableHead className="text-end">{t("Price" as any) || "Price"}</TableHead>
              <TableHead>{t("Status" as any) || "Status"}</TableHead>
              <TableHead className="text-end">{t("Actions" as any) || "Actions"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredSales === undefined ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  {t("LoadingSales" as any) || "Loading sales..."}
                </TableCell>
              </TableRow>
            ) : filteredSales.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  {t("NoSalesFound" as any) || "No sales found."}
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
                  <TableCell>{sale.salespersonName}</TableCell>
                  <TableCell className="text-end font-medium">
                    {sale.salePrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} JOD
                  </TableCell>
                  <TableCell>{getStatusBadge(sale.status)}</TableCell>
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon" onClick={() => {
                      try {
                        generateBillOfSale(
                          "AutoFlow Dealership",
                          sale.customerName,
                          sale.vehicleSummary,
                          sale.vehicleVin,
                          sale.salePrice,
                          sale.saleDate
                        );
                        toast.success(t("BillOfSaleGenerated" as any) || "Bill of Sale generated");
                      } catch (err) {
                        toast.error(t("FailedGeneratePDF" as any) || "Failed to generate PDF");
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
      </div>

      <SaleDialog
        open={isSaleDialogOpen}
        onOpenChange={setIsSaleDialogOpen}
        sale={editingSale}
      />

      <Dialog open={!!saleToDelete} onOpenChange={(open) => !open && setSaleToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("DeleteSaleRecord" as any) || "Delete Sale Record"}</DialogTitle>
            <DialogDescription>
              {t("DeleteSaleConfirm" as any) || "Are you sure you want to delete this sale? This action cannot be undone. If you just want to cancel the sale, use the Edit button to change its status to CANCELLED."} <br/>
              <span className="font-semibold text-foreground">{saleToDelete?.vehicleSummary}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaleToDelete(null)}>{t("Cancel" as any) || "Cancel"}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("DeletePermanently" as any) || "Delete Permanently"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
