"use client";

import { useState, useEffect } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useSearchParams } from "next/navigation";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VehicleDialog } from "@/components/vehicles/VehicleDialog";
import { VehicleHistoryDialog } from "@/components/vehicles/VehicleHistoryDialog";
import { VehicleDetailsDialog } from "@/components/vehicles/VehicleDetailsDialog";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, Trash2, ImageIcon, Download, ClipboardList, Check, X, Hourglass, History, Eye, FileSpreadsheet } from "lucide-react";
import { VehicleImportDialog } from "@/components/vehicles/VehicleImportDialog";
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
import { Label } from "@/components/ui/label";

function StatusBadge({ status, t }: { status: string; t: any }) {
  switch (status) {
    case "AVAILABLE":
      return <Badge variant="default" className="bg-green-600">{t("AvailableLC" as any) || "Available"}</Badge>;
    case "RESERVED":
      return <Badge variant="secondary" className="bg-yellow-500 text-white">{t("Reserved" as any) || "Reserved"}</Badge>;
    case "SOLD":
      return <Badge variant="secondary" className="bg-blue-600 text-white">{t("Sold" as any) || "Sold"}</Badge>;
    case "IN_INSPECTION":
      return <Badge variant="outline" className="text-orange-500 border-orange-500">{t("InInspection" as any) || "Inspection"}</Badge>;
    case "IN_REPAIR":
      return <Badge variant="outline" className="text-red-500 border-red-500">{t("InRepair" as any) || "Repair"}</Badge>;
    case "ARCHIVED":
      return <Badge variant="secondary">{t("Archived" as any) || "Archived"}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function VehiclesPage() {
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlightId");

  const { activeOrgId } = useOrg();
  const { results: vehicles, status: vehiclesStatus, loadMore: loadMoreVehicles } = usePaginatedQuery(
    api.vehicles.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 20 }
  );
  const removeVehicle = useMutation(api.vehicles.softDelete);

  const [searchQuery, setSearchQuery] = useState("");
  const [isVehicleDialogOpen, setIsVehicleDialogOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Doc<"vehicles"> | null>(null);

  const [vehicleToDelete, setVehicleToDelete] = useState<Doc<"vehicles"> | null>(null);
  const [galleryVehicle, setGalleryVehicle] = useState<any | null>(null);
  const [historyVehicle, setHistoryVehicle] = useState<Doc<"vehicles"> | null>(null);
  const [detailsVehicle, setDetailsVehicle] = useState<Doc<"vehicles"> | null>(null);
  const [statusRequestVehicle, setStatusRequestVehicle] = useState<Doc<"vehicles"> | null>(null);
  const [isApprovalsDialogOpen, setIsApprovalsDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [statusRequestNotes, setStatusRequestNotes] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<any>("");

  const myMembership = useQuery(api.memberships.getMyMembership, activeOrgId ? { orgId: activeOrgId } : "skip");
  const permissions = myMembership?.permissions || [];
  const canCreate = permissions.includes("create:vehicles");
  const canEdit = permissions.includes("edit:vehicles");
  const canDelete = permissions.includes("delete:vehicles");
  // Distinct from canCreate/canEdit above: those gate which mutation gets
  // called (direct vs. request-for-approval), these gate whether the
  // Add/Edit buttons appear at all — a "Requires Approval" role still needs
  // to see and use them, just routed through requestCreate/requestUpdate.
  const canCreateOrRequest = canCreate || permissions.includes("create:vehicles:request");
  const canEditOrRequest = canEdit || permissions.includes("edit:vehicles:request");

  const pendingRequests = useQuery(api.vehicleRequests.listPending, activeOrgId && canEdit ? { orgId: activeOrgId } : "skip");
  const pendingEdits = useQuery(api.vehicleEdits.listPending, activeOrgId && canEdit ? { orgId: activeOrgId } : "skip");
  const createStatusRequest = useMutation(api.vehicleRequests.create);
  const resolveStatusRequest = useMutation(api.vehicleRequests.resolve);
  const resolveEditRequest = useMutation(api.vehicleEdits.resolve);
  const updateVehicle = useMutation(api.vehicles.update);

  const handleStatusSubmit = async () => {
    if (!activeOrgId || !statusRequestVehicle || !selectedStatus) return;
    try {
      if (canEdit) {
        // Manager can change directly
        await updateVehicle({ orgId: activeOrgId, vehicleId: statusRequestVehicle._id, status: selectedStatus });
        toast.success(t("VehicleStatusUpdated" as any));
      } else {
        // Sales/Reception requests it
        await createStatusRequest({
          orgId: activeOrgId,
          vehicleId: statusRequestVehicle._id,
          requestedStatus: selectedStatus,
          notes: statusRequestNotes,
        });
        toast.success(t("StatusChangeRequested" as any));
      }
      setStatusRequestVehicle(null);
      setSelectedStatus("");
      setStatusRequestNotes("");
    } catch (error: any) {
      toast.error(error.message || t("FailedToSubmitRequest" as any));
    }
  };

  const handleResolveRequest = async (requestId: Id<"vehicleStatusRequests">, status: "APPROVED" | "REJECTED") => {
    if (!activeOrgId) return;
    try {
      await resolveStatusRequest({ orgId: activeOrgId, requestId, status });
      toast.success(`Status request ${status.toLowerCase()}`);
    } catch (error: any) {
      toast.error(error.message || `Failed to ${status.toLowerCase()} request`);
    }
  };

  const handleResolveEdit = async (requestId: Id<"vehicleEdits">, status: "APPROVED" | "REJECTED") => {
    if (!activeOrgId) return;
    try {
      await resolveEditRequest({ orgId: activeOrgId, requestId, status });
      toast.success(`Edit request ${status.toLowerCase()}`);
    } catch (error: any) {
      toast.error(error.message || `Failed to ${status.toLowerCase()} request`);
    }
  };

  const filteredVehicles = vehicles?.filter(v =>
    v.vin.toLowerCase().includes(searchQuery.toLowerCase()) ||
    v.make.toLowerCase().includes(searchQuery.toLowerCase()) ||
    v.model.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    if (highlightId && vehicles) {
      const el = document.getElementById(`row-${highlightId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [highlightId, vehicles]);

  const handleEdit = (vehicle: Doc<"vehicles">) => {
    setEditingVehicle(vehicle);
    setIsVehicleDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingVehicle(null);
    setIsVehicleDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !vehicleToDelete) return;
    try {
      await removeVehicle({ orgId: activeOrgId, vehicleId: vehicleToDelete._id });
      toast.success(t("VehicleRemoved" as any));
      setVehicleToDelete(null);
    } catch (error: any) {
      toast.error(error.message || t("FailedToRemoveVehicle" as any));
    }
  };

  const handleDownloadSingle = async (url: string, index: number) => {
    if (!galleryVehicle) return;
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = blobUrl;
      a.download = `${galleryVehicle.make}-${galleryVehicle.model}-image-${index + 1}.jpg`.replace(/\s+/g, '-').toLowerCase();

      document.body.appendChild(a);
      a.click();

      window.URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Error downloading image:", error);
      toast.error(t("FailedToDownloadImage" as any));
    }
  };

  const handleDownloadAll = async () => {
    if (!galleryVehicle?.imageUrls) return;

    try {
      const toastId = toast.loading(t("DownloadingImages" as any));
      for (let i = 0; i < galleryVehicle.imageUrls.length; i++) {
        await handleDownloadSingle(galleryVehicle.imageUrls[i], i);
        // Small delay to prevent browser from blocking multiple rapid downloads
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      toast.success(t("AllImagesDownloaded" as any), { id: toastId });
    } catch (error) {
      console.error("Error downloading images:", error);
      toast.error(t("FailedToDownloadImages" as any));
    }
  };

  return (
    <RoleGuard permissions={["view:vehicles"]}>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        <div className="flex flex-wrap gap-2">
          {canEdit && (
            <Button variant="outline" onClick={() => setIsApprovalsDialogOpen(true)}>
              <ClipboardList className="me-2 h-4 w-4" />
              {t("Approvals" as any)}
              {((pendingRequests?.length || 0) + (pendingEdits?.length || 0)) > 0 && (
                <span className="ms-2 bg-red-500 text-white text-xs px-2 py-0.5 rounded-full">
                  {(pendingRequests?.length || 0) + (pendingEdits?.length || 0)}
                </span>
              )}
            </Button>
          )}
          {canCreate && (
            <Button variant="outline" onClick={() => setIsImportDialogOpen(true)}>
              <FileSpreadsheet className="me-2 h-4 w-4" /> {t("Import" as any)}
            </Button>
          )}
          {canCreateOrRequest && (
            <Button onClick={handleAddNew}>
              <Plus className="me-2 h-4 w-4" /> {t("AddVehicle")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ms-3" />
        <Input
          placeholder={t("Search" as any) || "Search vehicles..."}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="ps-9"
        />
      </div>

      {/* Mobile card list */}
      <div className="flex flex-col gap-3 md:hidden">
        {filteredVehicles === undefined ? (
          <p className="text-center py-8 text-muted-foreground">{t("LoadingInventory" as any)}</p>
        ) : filteredVehicles.length === 0 ? (
          <p className="text-center py-8 text-muted-foreground">{t("NoVehiclesFound" as any)}</p>
        ) : filteredVehicles.map((vehicle) => (
          <div
            key={vehicle._id}
            id={`row-${vehicle._id}`}
            className={`rounded-xl border bg-card p-4 space-y-3 ${highlightId === vehicle._id ? "ring-2 ring-primary" : ""}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {vehicle.year} {vehicle.make} {vehicle.model}
                  {vehicle.trim && <span className="text-muted-foreground text-xs ms-1">{vehicle.trim}</span>}
                </p>
                <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{vehicle.vin}</p>
              </div>
              <StatusBadge status={vehicle.status} t={t} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {vehicle.mileage != null && <span>{vehicle.mileage.toLocaleString()} km</span>}
              {vehicle.transmission && <span>{vehicle.transmission.charAt(0) + vehicle.transmission.slice(1).toLowerCase()}</span>}
              {vehicle.notes && <span className="truncate max-w-[200px]">{vehicle.notes}</span>}
            </div>
            <div className="flex items-center justify-between">
              <p className="font-bold text-sm">{vehicle.sellingPrice.toLocaleString()} JOD</p>
              <div className="flex gap-0.5">
                <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setDetailsVehicle(vehicle)}>
                  <Eye className="h-4 w-4 text-muted-foreground" />
                </Button>
                <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setGalleryVehicle(vehicle)}>
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                </Button>
                {canEditOrRequest && (
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => handleEdit(vehicle)}>
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                )}
                {canDelete && (
                  <Button variant="ghost" size="icon" className="h-10 w-10" onClick={() => setVehicleToDelete(vehicle)}>
                    <Trash2 className="h-4 w-4 text-red-500" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden md:block rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Vehicle")}</TableHead>
              <TableHead>{t("VIN" as any)}</TableHead>
              <TableHead>{t("Year" as any)}</TableHead>
              <TableHead>{t("Mileage" as any)}</TableHead>
              <TableHead>{t("Transmission" as any)}</TableHead>
              <TableHead>{t("Price" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead>{t("Notes" as any)}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredVehicles === undefined ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  {t("LoadingInventory" as any)}
                </TableCell>
              </TableRow>
            ) : filteredVehicles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  {t("NoVehiclesFound" as any)}
                </TableCell>
              </TableRow>
            ) : (
              filteredVehicles.map((vehicle) => (
                <TableRow
                  key={vehicle._id}
                  id={`row-${vehicle._id}`}
                  className={highlightId === vehicle._id ? "bg-primary/20 transition-all duration-1000" : ""}
                >
                  <TableCell className="font-medium">
                    {vehicle.make} {vehicle.model} {vehicle.trim && <span className="text-muted-foreground text-xs ms-1">{vehicle.trim}</span>}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{vehicle.vin}</TableCell>
                  <TableCell>{vehicle.year}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {vehicle.mileage != null ? vehicle.mileage.toLocaleString() : "-"} km
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {vehicle.transmission ? vehicle.transmission.charAt(0) + vehicle.transmission.slice(1).toLowerCase() : "-"}
                  </TableCell>
                  <TableCell>{vehicle.sellingPrice.toLocaleString()} JOD</TableCell>
                  <TableCell>
                    {canEditOrRequest ? (
                      <button
                        onClick={() => {
                          setStatusRequestVehicle(vehicle);
                          setSelectedStatus(vehicle.status);
                        }}
                        className="hover:opacity-80 transition-opacity flex flex-col items-start text-left gap-1"
                      >
                        <StatusBadge status={vehicle.status} t={t} />
                        {vehicle.pendingStatusRequest && (
                          <span className="text-[10px] text-muted-foreground font-medium flex items-center mt-1">
                            <Hourglass className="h-3 w-3 me-1 inline" />
                            {t("Pending" as any)}: {vehicle.pendingStatusRequest}
                          </span>
                        )}
                      </button>
                    ) : (
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={vehicle.status} t={t} />
                        {vehicle.pendingStatusRequest && (
                          <span className="text-[10px] text-muted-foreground font-medium flex items-center mt-1">
                            <Hourglass className="h-3 w-3 me-1 inline" />
                            {t("Pending" as any)}: {vehicle.pendingStatusRequest}
                          </span>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate" title={vehicle.notes}>
                    {vehicle.notes ? vehicle.notes : <span className="text-muted-foreground italic text-xs">{t("NoNotes" as any)}</span>}
                  </TableCell>
                  <TableCell className="text-end space-x-1">
                    <Button variant="ghost" size="icon" onClick={() => setDetailsVehicle(vehicle)} title={t("ViewDetails" as any)}>
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setGalleryVehicle(vehicle)} title={t("ViewGallery" as any)}>
                      <ImageIcon className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setHistoryVehicle(vehicle)} title={t("ViewAuditTrail" as any)}>
                      <History className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    {canEditOrRequest && (
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(vehicle)} title={t("EditVehicle" as any)}>
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button variant="ghost" size="icon" onClick={() => setVehicleToDelete(vehicle)} title={t("DeleteVehicle" as any)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {vehiclesStatus === "CanLoadMore" && (
        <div className="flex justify-center mt-4">
          <Button variant="outline" onClick={() => loadMoreVehicles(20)}>
            {t("LoadMore" as any) || "Load More"}
          </Button>
        </div>
      )}

      <VehicleDialog
        open={isVehicleDialogOpen}
        onOpenChange={setIsVehicleDialogOpen}
        vehicle={editingVehicle}
        canCreate={canCreate}
        canEdit={canEdit}
      />

      <VehicleHistoryDialog
        vehicle={historyVehicle}
        open={!!historyVehicle}
        onOpenChange={(open) => !open && setHistoryVehicle(null)}
      />

      <VehicleDetailsDialog
        vehicle={detailsVehicle}
        open={!!detailsVehicle}
        onOpenChange={(open) => !open && setDetailsVehicle(null)}
        canViewPurchasePrice={canEdit}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!vehicleToDelete} onOpenChange={(open) => !open && setVehicleToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("RemoveVehicle" as any)}</DialogTitle>
            <DialogDescription>
              {t("RemoveVehicleConfirm" as any)} {vehicleToDelete?.year} {vehicleToDelete?.make} {vehicleToDelete?.model}?
              {t("RemoveVehicleWarning" as any)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVehicleToDelete(null)}>{t("Cancel")}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("Remove" as any)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Gallery Dialog */}
      <Dialog open={!!galleryVehicle} onOpenChange={(open) => !open && setGalleryVehicle(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{galleryVehicle?.year} {galleryVehicle?.make} {galleryVehicle?.model}</DialogTitle>
            <DialogDescription>
              {t("VehicleGallery" as any)}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {galleryVehicle?.imageUrls && galleryVehicle.imageUrls.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-h-[60vh] overflow-y-auto pe-2">
                {galleryVehicle.imageUrls.map((url: string, index: number) => (
                  <div key={index} className="relative aspect-video rounded-md overflow-hidden bg-muted group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`Vehicle image ${index + 1}`}
                      className="object-cover w-full h-full"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Button variant="secondary" size="sm" onClick={() => handleDownloadSingle(url, index)}>
                        <Download className="h-4 w-4 me-2" />
                        {t("Download" as any)}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-muted-foreground border-2 border-dashed rounded-lg">
                <ImageIcon className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p>{t("NoImages" as any)}</p>
              </div>
            )}
          </div>
          <DialogFooter className="sm:justify-between items-center w-full mt-4">
            {galleryVehicle?.imageUrls && galleryVehicle.imageUrls.length > 0 ? (
              <Button variant="outline" onClick={handleDownloadAll}>
                <Download className="h-4 w-4 me-2" />
                {t("DownloadAll" as any)}
              </Button>
            ) : (
              <div />
            )}
            <Button variant="ghost" onClick={() => setGalleryVehicle(null)}>{t("Close" as any)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status Change Request Dialog */}
      <Dialog open={!!statusRequestVehicle} onOpenChange={(open) => !open && setStatusRequestVehicle(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ChangeStatus" as any)}</DialogTitle>
            <DialogDescription>
              {canEdit
                ? t("UpdateStatusDesc" as any)
                : t("RequestStatusDesc" as any)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t("NewStatus" as any)}</Label>
              <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                <SelectTrigger>
                  <SelectValue placeholder={t("SelectStatus" as any)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AVAILABLE">{t("StatusAvailable" as any)}</SelectItem>
                  <SelectItem value="RESERVED">{t("StatusReserved" as any)}</SelectItem>
                  <SelectItem value="SOLD">{t("StatusSold" as any)}</SelectItem>
                  <SelectItem value="IN_INSPECTION">{t("StatusInInspection" as any)}</SelectItem>
                  <SelectItem value="IN_REPAIR">{t("StatusInRepair" as any)}</SelectItem>
                  <SelectItem value="ARCHIVED">{t("StatusArchived" as any)}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!canEdit && (
              <div className="space-y-2">
                <Label>{t("Notes" as any)} (Optional)</Label>
                <Input
                  placeholder={t("ReasonForChange" as any)}
                  value={statusRequestNotes}
                  onChange={(e) => setStatusRequestNotes(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusRequestVehicle(null)}>{t("Cancel" as any)}</Button>
            <Button onClick={handleStatusSubmit}>{t("Submit" as any)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Approvals Dialog */}
      <Dialog open={isApprovalsDialogOpen} onOpenChange={setIsApprovalsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("PendingApprovals" as any)}</DialogTitle>
            <DialogDescription>
              {t("ReviewApprovals" as any)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {!pendingRequests?.length && !pendingEdits?.length ? (
              <div className="text-center py-8 text-muted-foreground">
                {t("NoPendingRequests" as any)}
              </div>
            ) : (
              <>
                {/* Edit Requests */}
                {pendingEdits?.map((req) => (
                  <div key={req._id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border rounded-lg bg-card">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={req.type === "CREATE" ? "default" : "secondary"}>
                          {req.type === "CREATE" ? t("NewVehicleReq" as any) : t("EditDetailsReq" as any)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{t("ByReq" as any)} {req.user?.name}</span>
                      </div>
                      <p className="font-semibold text-sm mt-2">
                        {req.payload?.year} {req.payload?.make} {req.payload?.model}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>VIN: {req.payload?.vin}</span>
                        <span>•</span>
                        <span>Price: {req.payload?.sellingPrice?.toLocaleString()} JOD</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleResolveEdit(req._id, "REJECTED")} className="text-red-500 hover:text-red-600 hover:bg-red-50 border-red-200">
                        <X className="h-4 w-4 me-1" /> {t("Reject" as any)}
                      </Button>
                      <Button size="sm" onClick={() => handleResolveEdit(req._id, "APPROVED")} className="bg-green-600 hover:bg-green-700 text-white">
                        <Check className="h-4 w-4 me-1" /> {t("Approve" as any)}
                      </Button>
                    </div>
                  </div>
                ))}

                {/* Status Requests */}
                {pendingRequests?.map((req) => (
                  <div key={req._id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border rounded-lg bg-card">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{t("StatusChangeReq" as any)}</Badge>
                        <span className="text-xs text-muted-foreground">{t("ByReq" as any)} {req.user?.name}</span>
                      </div>
                      <p className="font-semibold text-sm mt-2">
                        {req.vehicle?.year} {req.vehicle?.make} {req.vehicle?.model}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>VIN: {req.vehicle?.vin}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm mt-2">
                        <StatusBadge status={req.vehicle?.currentStatus || ""} t={t} />
                        <span>→</span>
                        <StatusBadge status={req.requestedStatus} t={t} />
                      </div>
                      {req.notes && (
                        <p className="text-xs text-muted-foreground italic mt-2">"{req.notes}"</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleResolveRequest(req._id, "REJECTED")} className="text-red-500 hover:text-red-600 hover:bg-red-50 border-red-200">
                        <X className="h-4 w-4 me-1" /> {t("Reject" as any)}
                      </Button>
                      <Button size="sm" onClick={() => handleResolveRequest(req._id, "APPROVED")} className="bg-green-600 hover:bg-green-700 text-white">
                        <Check className="h-4 w-4 me-1" /> {t("Approve" as any)}
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsApprovalsDialogOpen(false)}>{t("Close" as any)}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VehicleImportDialog open={isImportDialogOpen} onOpenChange={setIsImportDialogOpen} />
    </div>
    </RoleGuard>
  );
}
