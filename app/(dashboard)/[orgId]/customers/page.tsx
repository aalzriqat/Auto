"use client";

import { useState, useEffect } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CustomerDialog } from "@/components/customers/CustomerDialog";
import { CustomerDetailsDialog } from "@/components/customers/CustomerDetailsDialog";
import { MergeCustomersDialog } from "@/components/customers/MergeCustomersDialog";
import { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Pencil, Trash2, Mail, Phone, FileSpreadsheet, Merge } from "lucide-react";
import { CustomerImportDialog } from "@/components/customers/CustomerImportDialog";
import { toast } from "@/components/ui/sonner";
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
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useTableControls } from "@/hooks/useTableControls";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";

export default function CustomersPage() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlightId");

  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { results: customers, status: customersStatus, loadMore: loadMoreCustomers } = usePaginatedQuery(
    api.customers.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 25 }
  );
  const removeCustomer = useMutation(api.customers.softDelete);

  const [isCustomerDialogOpen, setIsCustomerDialogOpen] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Doc<"customers"> | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<Id<"customers"> | null>(null);

  const [customerToDelete, setCustomerToDelete] = useState<Doc<"customers"> | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isMergeDialogOpen, setIsMergeDialogOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("ALL");
  const { hasPermission } = usePermissions();

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedCustomers,
  } = useTableControls({
    data: customers,
    searchFields: (c) => [`${c.firstName} ${c.lastName}`, c.email, c.phone],
    sortAccessors: {
      name: (c) => `${c.firstName} ${c.lastName}`.toLowerCase(),
      addedDate: (c) => c.createdAt ?? c._creationTime,
    },
  });

  const sourceOptions = Array.from(
    new Set((customers ?? []).map((c) => (c as any).source).filter(Boolean))
  ) as string[];

  const filteredCustomers = sortedCustomers?.filter((c) =>
    sourceFilter === "ALL" || (c as any).source === sourceFilter
  );

  useEffect(() => {
    if (highlightId && customers) {
      const el = document.getElementById(`row-${highlightId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [highlightId, customers]);

  const handleEdit = (customer: Doc<"customers">, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingCustomer(customer);
    setIsCustomerDialogOpen(true);
  };

  const handleRowClick = (customerId: Id<"customers">) => {
    setSelectedCustomerId(customerId);
    setIsDetailsOpen(true);
  };

  const handleAddNew = () => {
    setEditingCustomer(null);
    setIsCustomerDialogOpen(true);
  };

  const handleDelete = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!activeOrgId || !customerToDelete) return;
    try {
      await removeCustomer({ orgId: activeOrgId, customerId: customerToDelete._id });
      toast.success(t("CustomerRemovedSuccess" as any));
      setCustomerToDelete(null);
    } catch (error: any) {
      toast.error(error);
    }
  };

  return (
    <RoleGuard permissions={["view:customers"]}>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        {hasPermission(PERMISSIONS.MERGE_CUSTOMERS) && (
          <Button variant="outline" onClick={() => setIsMergeDialogOpen(true)}>
            <Merge className="me-2 h-4 w-4" /> {t("MergeDuplicates" as any) || "Merge Duplicates"}
          </Button>
        )}
        <Button variant="outline" onClick={() => setIsImportDialogOpen(true)}>
          <FileSpreadsheet className="me-2 h-4 w-4" /> Import
        </Button>
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> {t("AddCustomer" as any)}
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex items-center w-full max-w-sm space-x-2 relative">
          <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
          <Input
            placeholder={t("SearchCustomers" as any)}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9"
          />
        </div>
        {sourceOptions.length > 0 && (
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder={t("Source" as any)} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("AllSources" as any)}</SelectItem>
              {sourceOptions.map((source) => (
                <SelectItem key={source} value={source}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Mobile card list */}
      <div className="flex flex-col gap-3 md:hidden">
        {filteredCustomers === undefined ? (
          <p className="text-center py-8 text-muted-foreground">{t("LoadingCustomers" as any)}</p>
        ) : filteredCustomers.length === 0 ? (
          <p className="text-center py-8 text-muted-foreground">{t("NoCustomers" as any)}</p>
        ) : filteredCustomers.map((customer) => (
          <div
            key={customer._id}
            id={`row-${customer._id}`}
            className={`rounded-xl border bg-card p-4 space-y-2 active:bg-muted/50 ${highlightId === customer._id ? "ring-2 ring-primary" : ""}`}
          >
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-start"
                onClick={() => handleRowClick(customer._id)}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <span className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-sm shrink-0">
                    {customer.firstName.charAt(0).toUpperCase()}
                  </span>
                  <span className="font-semibold text-sm truncate">{customer.firstName} {customer.lastName}</span>
                </span>
                <span className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground ps-12">
                  {customer.email && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="truncate">{customer.email}</span>
                    </span>
                  )}
                  {(customer.phone || customer.whatsapp) && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3 shrink-0" />
                      <span>{customer.phone || customer.whatsapp}</span>
                    </span>
                  )}
                  {customer.nationalId && <span>{t("NationalID" as any)}: {customer.nationalId}</span>}
                </span>
              </button>
              <div className="flex gap-0.5 shrink-0">
                <Button variant="ghost" size="icon" className="h-10 w-10" onClick={(e) => handleEdit(customer, e)}>
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </Button>
                <Button variant="ghost" size="icon" className="h-10 w-10" onClick={(e) => { e.stopPropagation(); setCustomerToDelete(customer); }}>
                  <Trash2 className="h-4 w-4 text-red-500" />
                </Button>
              </div>
            </div>
          </div>
        ))}
        {customersStatus === "CanLoadMore" && (
          <div className="flex justify-center pt-2">
            <Button variant="outline" onClick={() => loadMoreCustomers(25)}>{t("LoadMore" as any)}</Button>
          </div>
        )}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableColumnHeader label={t("Name" as any)} sortKey="name" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <TableHead>{t("Contact" as any)}</TableHead>
              <TableHead>{t("NationalID" as any)}</TableHead>
              <SortableColumnHeader label={t("AddedDate" as any)} sortKey="addedDate" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <TableHead>{t("Source" as any)}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredCustomers === undefined ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  {t("LoadingCustomers" as any)}
                </TableCell>
              </TableRow>
            ) : filteredCustomers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  {t("NoCustomers" as any)}
                </TableCell>
              </TableRow>
            ) : (
              filteredCustomers.map((customer) => (
                <TableRow
                  key={customer._id}
                  id={`row-${customer._id}`}
                  className={`cursor-pointer hover:bg-muted/50 ${highlightId === customer._id ? "bg-primary/20 transition-all duration-1000" : ""}`}
                  onClick={() => handleRowClick(customer._id)}
                >
                  <TableCell className="font-medium">
                    {customer.firstName} {customer.lastName}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                      {customer.email && (
                        <div className="flex items-center gap-1">
                          <Mail className="h-3 w-3" /> {customer.email}
                        </div>
                      )}
                      {(customer.phone || customer.whatsapp) && (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {customer.phone || customer.whatsapp}
                        </div>
                      )}
                      {!customer.email && !customer.phone && !customer.whatsapp && (
                        <span className="italic text-xs">{t("NoContactInfo" as any)}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {customer.nationalId || <span className="text-muted-foreground italic">{t("NA" as any)}</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground" title={(customer as any).createdByName ? `${t("AddedBy" as any)}: ${(customer as any).createdByName}` : undefined}>
                    {new Date((customer as any).createdAt ?? customer._creationTime).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {(customer as any).source ?? "—"}
                  </TableCell>
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon" onClick={(e) => handleEdit(customer, e)}>
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={(e) => {
                      e.stopPropagation();
                      setCustomerToDelete(customer);
                    }}>
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {customersStatus === "CanLoadMore" && (
          <div className="flex justify-center p-4">
            <Button variant="outline" onClick={() => loadMoreCustomers(25)}>
              {t("LoadMore" as any)}
            </Button>
          </div>
        )}
      </div>

      <CustomerDialog
        open={isCustomerDialogOpen}
        onOpenChange={setIsCustomerDialogOpen}
        customer={editingCustomer}
      />

      <CustomerDetailsDialog
        open={isDetailsOpen}
        onOpenChange={setIsDetailsOpen}
        customerId={selectedCustomerId}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!customerToDelete} onOpenChange={(open) => !open && setCustomerToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("RemoveCustomer" as any)}</DialogTitle>
            <DialogDescription>
              {t("RemoveCustomerConfirm" as any)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCustomerToDelete(null)}>{t("Cancel" as any)}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("Remove" as any)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CustomerImportDialog open={isImportDialogOpen} onOpenChange={setIsImportDialogOpen} />

      <MergeCustomersDialog open={isMergeDialogOpen} onOpenChange={setIsMergeDialogOpen} />
    </div>
    </RoleGuard>
  );
}
