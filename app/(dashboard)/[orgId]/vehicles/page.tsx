"use client";

import { useEffect, useMemo, useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
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
import { useTableControls } from "@/hooks/useTableControls";
import { useHighlightRow } from "@/hooks/useHighlightRow";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, Pencil, ImageIcon, Download, ClipboardList, Check, X, Hourglass, History, FileSpreadsheet, AlertTriangle, LayoutGrid, List, Bookmark, MoreHorizontal, Archive } from "lucide-react";
import { VehicleImportDialog } from "@/components/vehicles/VehicleImportDialog";
import { VehicleExportButton } from "@/components/vehicles/VehicleExportButton";
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
import { getErrorMessage } from "@/lib/errors";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useStoredViewPreference } from "@/hooks/useStoredViewPreference";
import { interpolate } from "@/lib/i18n/interpolate";
import { translateVehicleStatus, type Translate } from "@/lib/i18n/statusLabels";

const DAY_MS = 24 * 60 * 60 * 1000;
type AgingFilter = "ALL" | "0-30" | "31-60" | "61-90" | "90+";
type VehicleStatus = Doc<"vehicles">["status"];
type RequestableVehicleStatus = Exclude<VehicleStatus, "SOURCING">;
type VehicleStatusFilter = "ALL" | VehicleStatus;
type VehicleView = "table" | "cards";

const VEHICLE_VIEW_OPTIONS = ["table", "cards"] as const;
const VEHICLE_STATUS_FILTERS = new Set<VehicleStatusFilter>([
  "ALL", "AVAILABLE", "SOURCING", "RESERVED", "SOLD", "IN_INSPECTION", "IN_REPAIR", "ARCHIVED",
]);
const VEHICLE_AGING_FILTERS = new Set<AgingFilter>(["ALL", "0-30", "31-60", "61-90", "90+"]);
const VEHICLE_SORT_KEYS = new Set(["model", "price", "year", "addedDate"]);

interface VehicleSavedView {
  id: string;
  name: string;
  search: string;
  status: VehicleStatusFilter;
  aging: AgingFilter;
  view: VehicleView;
  sortKey?: string;
  sortDir: "asc" | "desc";
}

function isVehicleSavedView(value: unknown): value is VehicleSavedView {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<VehicleSavedView>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.search === "string" &&
    !!candidate.status && VEHICLE_STATUS_FILTERS.has(candidate.status) &&
    !!candidate.aging && VEHICLE_AGING_FILTERS.has(candidate.aging) &&
    (candidate.view === "table" || candidate.view === "cards") &&
    (candidate.sortKey === undefined || VEHICLE_SORT_KEYS.has(candidate.sortKey)) &&
    (candidate.sortDir === "asc" || candidate.sortDir === "desc")
  );
}

function isRequestableVehicleStatus(status: VehicleStatus): status is RequestableVehicleStatus {
  return status !== "SOURCING";
}

function StatusBadge({ status, t }: Readonly<{ status: string; t: Translate }>) {
  const label = translateVehicleStatus(status, t);
  switch (status) {
    case "AVAILABLE":
      return <Badge variant="default" className="bg-green-600">{label}</Badge>;
    case "RESERVED":
      return <Badge variant="secondary" className="bg-yellow-500 text-white">{label}</Badge>;
    case "SOLD":
      return <Badge variant="secondary" className="bg-blue-600 text-white">{label}</Badge>;
    case "IN_INSPECTION":
      return <Badge variant="outline" className="text-orange-500 border-orange-500">{label}</Badge>;
    case "IN_REPAIR":
      return <Badge variant="outline" className="text-red-500 border-red-500">{label}</Badge>;
    case "SOURCING":
      return <Badge variant="outline" className="text-purple-600 border-purple-600">{label}</Badge>;
    case "ARCHIVED":
      return <Badge variant="secondary">{label}</Badge>;
    default:
      return <Badge variant="outline">{label}</Badge>;
  }
}

export default function VehiclesPage() {
  const { t, locale } = useLanguage();
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";

  const { activeOrgId } = useOrg();
  const { results: vehicles, status: vehiclesStatus, loadMore: loadMoreVehicles } = usePaginatedQuery(
    api.vehicles.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 20 }
  );
  const removeVehicle = useMutation(api.vehicles.softDelete);

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    setSort,
    rows: sortedVehicles,
  } = useTableControls({
    data: vehicles,
    searchFields: (v) => [v.vin, v.make, v.model, v.trim, v.notes],
    sortAccessors: {
      model: (v) => `${v.make} ${v.model}`.toLowerCase(),
      price: (v) => v.sellingPrice,
      year: (v) => v.year,
      addedDate: (v) => v.createdAt ?? v._creationTime,
    },
    defaultSortKey: "addedDate",
    defaultSortDir: "desc",
    pagination: { status: vehiclesStatus, loadMore: loadMoreVehicles, batchSize: 20 },
  });
  type VehicleListItem = NonNullable<typeof vehicles>[number];
  const [agingFilter, setAgingFilter] = useState<AgingFilter>("ALL");
  const [statusFilter, setStatusFilter] = useState<VehicleStatusFilter>("ALL");
  const [view, setView] = useStoredViewPreference<VehicleView>(
    `autoflow:${activeOrgId ?? "default"}:vehicle-view`,
    "table",
    VEHICLE_VIEW_OPTIONS
  );
  const [selectedVehicleIds, setSelectedVehicleIds] = useState<Set<Id<"vehicles">>>(new Set());
  const [savedViews, setSavedViews] = useState<VehicleSavedView[]>([]);
  const [activeSavedViewId, setActiveSavedViewId] = useState("");
  const [isSaveViewDialogOpen, setIsSaveViewDialogOpen] = useState(false);
  const [savedViewName, setSavedViewName] = useState("");
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [isVehicleDialogOpen, setIsVehicleDialogOpen] = useState(false);
  const [editingVehicle, setEditingVehicle] = useState<Doc<"vehicles"> | null>(null);

  const [vehicleToDelete, setVehicleToDelete] = useState<Doc<"vehicles"> | null>(null);
  const [galleryVehicle, setGalleryVehicle] = useState<VehicleListItem | null>(null);
  const [historyVehicle, setHistoryVehicle] = useState<Doc<"vehicles"> | null>(null);
  const [detailsVehicle, setDetailsVehicle] = useState<Doc<"vehicles"> | null>(null);
  const [statusRequestVehicle, setStatusRequestVehicle] = useState<Doc<"vehicles"> | null>(null);
  const [isApprovalsDialogOpen, setIsApprovalsDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [statusRequestNotes, setStatusRequestNotes] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<VehicleStatus | "">("");

  const savedViewsStorageKey = `autoflow:${activeOrgId ?? "default"}:vehicle-saved-views`;
  useEffect(() => {
    try {
      const storedViews = window.localStorage.getItem(savedViewsStorageKey);
      if (!storedViews) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Refresh client-only saved views when the organization changes.
        setSavedViews([]);
        return;
      }
      const parsedViews: unknown = JSON.parse(storedViews);
      setSavedViews(Array.isArray(parsedViews) ? parsedViews.filter(isVehicleSavedView) : []);
    } catch {
      setSavedViews([]);
    }
  }, [savedViewsStorageKey]);

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
  // Only cost-price viewers get purchasePrice in the payload at all, so the
  // "missing cost" flag is meaningful (and shown) only for them — otherwise a
  // salesperson would see it on every vehicle. A missing cost means no auto
  // commission was calculated (see C3), which is what we want managers to spot.
  const canViewCost = permissions.includes("view:cost_price");
  // A vehicle's cost basis is sourceCost for SOURCED vehicles and purchasePrice
  // for everything else — the same rule the backend uses (vehicleHasCostBasis /
  // computeVehicleCapitalizedCost). Keying only off purchasePrice would wrongly
  // flag legitimately-costed SOURCED stock.
  const isMissingCost = (v: Doc<"vehicles">) => {
    if (!canViewCost || v.status === "SOURCING") return false;
    // Zero counts as missing too — a 0 cost basis would commission on ~the
    // full sale price (mirrors backend vehicleHasCostBasis).
    return v.sourceType === "SOURCED" ? !(v.sourceCost != null && v.sourceCost > 0) : !(v.purchasePrice != null && v.purchasePrice > 0);
  };

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
        if (!isRequestableVehicleStatus(selectedStatus)) {
          toast.error(t("VehicleManagerOnlySourcing"));
          return;
        }
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
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const handleResolveRequest = async (requestId: Id<"vehicleStatusRequests">, status: "APPROVED" | "REJECTED") => {
    if (!activeOrgId) return;
    try {
      await resolveStatusRequest({ orgId: activeOrgId, requestId, status });
      toast.success(`Status request ${status.toLowerCase()}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const handleResolveEdit = async (requestId: Id<"vehicleEdits">, status: "APPROVED" | "REJECTED") => {
    if (!activeOrgId) return;
    try {
      await resolveEditRequest({ orgId: activeOrgId, requestId, status });
      toast.success(`Edit request ${status.toLowerCase()}`);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  // eslint-disable-next-line react-hooks/purity -- Keep every inventory-age value consistent within this render.
  const currentTime = Date.now();
  const getVehicleAgeBucket = (createdAt: number): AgingFilter => {
    const ageDays = Math.max(0, Math.floor((currentTime - createdAt) / DAY_MS));
    if (ageDays <= 30) return "0-30";
    if (ageDays <= 60) return "31-60";
    if (ageDays <= 90) return "61-90";
    return "90+";
  };

  const getVehicleAgeDays = (vehicle: VehicleListItem) =>
    Math.max(0, Math.floor((currentTime - (vehicle.createdAt ?? vehicle._creationTime)) / DAY_MS));

  const getVehicleWarnings = (vehicle: VehicleListItem) => {
    const warnings: string[] = [];
    if (!vehicle.vin) warnings.push(t("VehicleVinMissing"));
    if (!vehicle.imageUrls?.some(Boolean)) warnings.push(t("VehiclePhotosMissing"));
    if (isMissingCost(vehicle)) warnings.push(t("VehicleAcquisitionCostMissing"));
    return warnings;
  };

  const agingFilterOptions: { value: AgingFilter; label: string }[] = [
    { value: "ALL", label: t("AgingAll" as any) },
    { value: "0-30", label: t("AgingBucket0To30" as any) },
    { value: "31-60", label: t("AgingBucket31To60" as any) },
    { value: "61-90", label: t("AgingBucket61To90" as any) },
    { value: "90+", label: t("AgingBucket90Plus" as any) },
  ];

  const filteredVehicles = sortedVehicles?.filter((v) => {
    // Sourced vehicles are excluded from the aging filter since they were never owned stock.
    const matchesStatus = statusFilter === "ALL" || v.status === statusFilter;
    const matchesAge = agingFilter === "ALL" || (
      v.sourceType !== "SOURCED" && getVehicleAgeBucket(v.createdAt ?? v._creationTime) === agingFilter
    );
    return matchesStatus && matchesAge;
  });

  const selectedVehicles = useMemo(
    () => (vehicles ?? []).filter((vehicle) => selectedVehicleIds.has(vehicle._id)),
    [selectedVehicleIds, vehicles]
  );
  const allFilteredSelected =
    !!filteredVehicles?.length && filteredVehicles.every((vehicle) => selectedVehicleIds.has(vehicle._id));

  const highlightedId = useHighlightRow({
    // Fed the *rendered* rows: a row hidden by the active search or filter has
    // no element to scroll to, and the hook must not report it as found.
    rows: filteredVehicles,
    getId: (v) => v._id,
    pagination: { status: vehiclesStatus, loadMore: loadMoreVehicles, batchSize: 20 },
  });

  const persistSavedViews = (nextViews: VehicleSavedView[]) => {
    try {
      window.localStorage.setItem(savedViewsStorageKey, JSON.stringify(nextViews));
      setSavedViews(nextViews);
      return true;
    } catch {
      toast.error(t("SavedViewsUnavailable"));
      return false;
    }
  };

  const handleSaveCurrentView = () => {
    const name = savedViewName.trim();
    if (!name) return;

    const existing = savedViews.find((savedView) => savedView.name.toLowerCase() === name.toLowerCase());
    const nextView: VehicleSavedView = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      search: searchQuery,
      status: statusFilter,
      aging: agingFilter,
      view,
      sortKey,
      sortDir,
    };
    const nextViews = existing
      ? savedViews.map((savedView) => savedView.id === existing.id ? nextView : savedView)
      : [...savedViews, nextView];

    if (!persistSavedViews(nextViews)) return;
    setActiveSavedViewId(nextView.id);
    setSavedViewName("");
    setIsSaveViewDialogOpen(false);
    toast.success(t("SavedViewSaved"));
  };

  const applySavedView = (savedView: VehicleSavedView) => {
    setSearchQuery(savedView.search);
    setStatusFilter(savedView.status);
    setAgingFilter(savedView.aging);
    setView(savedView.view);
    setSort(savedView.sortKey, savedView.sortDir);
    setActiveSavedViewId(savedView.id);
  };

  const deleteActiveSavedView = () => {
    if (!activeSavedViewId) return;
    if (!persistSavedViews(savedViews.filter((savedView) => savedView.id !== activeSavedViewId))) return;
    setActiveSavedViewId("");
    toast.success(t("SavedViewRemoved"));
  };

  const clearFilters = () => {
    setSearchQuery("");
    setStatusFilter("ALL");
    setAgingFilter("ALL");
    setActiveSavedViewId("");
  };

  const toggleVehicleSelection = (vehicleId: Id<"vehicles">) => {
    setSelectedVehicleIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(vehicleId)) nextIds.delete(vehicleId);
      else nextIds.add(vehicleId);
      return nextIds;
    });
  };

  const toggleAllFilteredVehicles = () => {
    setSelectedVehicleIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (allFilteredSelected) {
        filteredVehicles?.forEach((vehicle) => nextIds.delete(vehicle._id));
      } else {
        filteredVehicles?.forEach((vehicle) => nextIds.add(vehicle._id));
      }
      return nextIds;
    });
  };

  const exportSelectedVehicles = () => {
    if (selectedVehicles.length === 0) return;
    const escapeCell = (cell: string | number) => `"${String(cell).replaceAll('"', '""')}"`;
    const rows = selectedVehicles.map((vehicle) => [
      vehicle.vin ?? "",
      vehicle.year,
      vehicle.make,
      vehicle.model,
      vehicle.trim ?? "",
      translateVehicleStatus(vehicle.status, t),
      vehicle.sellingPrice,
      getVehicleAgeDays(vehicle),
    ]);
    const csv = [
      [t("VIN"), t("Year"), t("Make"), t("Model"), t("Trim"), t("Status"), t("VehicleCsvPriceJod"), t("VehicleCsvInventoryAgeDays")],
      ...rows,
    ].map((row) => row.map(escapeCell).join(",")).join("\n");
    const downloadUrl = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `vehicles_selected_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
  };

  const handleBulkStatusChange = async (nextStatus: VehicleStatus) => {
    if (!activeOrgId || selectedVehicles.length === 0) return;
    setIsBulkUpdating(true);
    let updates: PromiseSettledResult<unknown>[];
    if (canEdit) {
      updates = await Promise.allSettled(
        selectedVehicles.map((vehicle) =>
          updateVehicle({ orgId: activeOrgId, vehicleId: vehicle._id, status: nextStatus })
        )
      );
    } else {
      if (!isRequestableVehicleStatus(nextStatus)) {
        toast.error(t("VehicleManagerOnlySourcing"));
        setIsBulkUpdating(false);
        return;
      }
      updates = await Promise.allSettled(
        selectedVehicles.map((vehicle) =>
          createStatusRequest({
            orgId: activeOrgId,
            vehicleId: vehicle._id,
            requestedStatus: nextStatus,
            notes: "Bulk status change",
          })
        )
      );
    }
    const failures = updates.filter((update) => update.status === "rejected").length;
    if (failures > 0) {
      toast.error(interpolate(t(failures === 1 ? "VehicleBulkUpdateFailedOne" : "VehicleBulkUpdateFailedMany"), { count: failures }));
    } else {
      toast.success(t(canEdit ? "VehicleStatusesUpdated" : "VehicleStatusRequestsSubmitted"));
      setSelectedVehicleIds(new Set());
    }
    setIsBulkUpdating(false);
  };

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
    } catch (error) {
      toast.error(getErrorMessage(error));
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
      const imageUrls = galleryVehicle.imageUrls.filter((url): url is string => Boolean(url));
      for (let i = 0; i < imageUrls.length; i++) {
        await handleDownloadSingle(imageUrls[i], i);
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Vehicles")}</h1>
          <p className="text-sm text-muted-foreground">{t("VehiclesManageReadiness")}</p>
        </div>
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
          <VehicleExportButton />
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

      <div className="rounded-xl border bg-card p-4 space-y-4 shadow-sm">
        <div className="flex flex-col xl:flex-row gap-3 xl:items-center">
          <div className="flex items-center w-full xl:max-w-md relative">
            <Search className="h-4 w-4 text-muted-foreground absolute start-3" />
            <Input
              placeholder={t("VehicleSearchPlaceholder")}
              value={searchQuery}
              onChange={(event) => { setSearchQuery(event.target.value); setActiveSavedViewId(""); }}
              className="ps-9"
            />
          </div>
          <div className="flex flex-wrap gap-2 flex-1">
            <Select value={statusFilter} onValueChange={(nextStatus) => { setStatusFilter(nextStatus as VehicleStatusFilter); setActiveSavedViewId(""); }}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={t("AllVehicleStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("AllVehicleStatuses")}</SelectItem>
                {(Array.from(VEHICLE_STATUS_FILTERS).filter((status): status is VehicleStatus => status !== "ALL")).map((status) => (
                  <SelectItem key={status} value={status}>{translateVehicleStatus(status, t)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={agingFilter} onValueChange={(nextAge) => { setAgingFilter(nextAge as AgingFilter); setActiveSavedViewId(""); }}>
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder={t("InventoryAging")} />
              </SelectTrigger>
              <SelectContent>
                {agingFilterOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sortKey ? `${sortKey}:${sortDir}` : "none"}
              onValueChange={(nextSort) => {
                if (nextSort === "none") setSort(undefined);
                else {
                  const [nextKey, nextDirection] = nextSort.split(":");
                  setSort(nextKey, nextDirection as "asc" | "desc");
                }
                setActiveSavedViewId("");
              }}
            >
              <SelectTrigger className="w-[190px]">
                <SelectValue placeholder={t("SortVehicles")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="addedDate:desc">{t("NewestInventory")}</SelectItem>
                <SelectItem value="addedDate:asc">{t("OldestInventory")}</SelectItem>
                <SelectItem value="price:desc">{t("PriceHighToLow")}</SelectItem>
                <SelectItem value="price:asc">{t("PriceLowToHigh")}</SelectItem>
                <SelectItem value="model:asc">{t("ModelAToZ")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={activeSavedViewId || "none"}
              onValueChange={(savedViewId) => {
                if (savedViewId === "none") {
                  setActiveSavedViewId("");
                  return;
                }
                const savedView = savedViews.find((candidate) => candidate.id === savedViewId);
                if (savedView) applySavedView(savedView);
              }}
            >
              <SelectTrigger className="w-[170px]">
                <Bookmark className="h-4 w-4 me-2" />
                <SelectValue placeholder={t("SavedViews")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("SavedViews")}</SelectItem>
                {savedViews.map((savedView) => (
                  <SelectItem key={savedView.id} value={savedView.id}>{savedView.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => setIsSaveViewDialogOpen(true)}>{t("SaveView")}</Button>
            {activeSavedViewId && (
              <Button variant="ghost" size="icon" onClick={deleteActiveSavedView} title={t("DeleteSavedView")}>
                <X className="h-4 w-4" />
              </Button>
            )}
            <div className="flex items-center rounded-md border p-1">
              <Button variant={view === "table" ? "secondary" : "ghost"} size="icon" className="h-7 w-7" onClick={() => setView("table")} title={t("TableView")}>
                <List className="h-4 w-4" />
              </Button>
              <Button variant={view === "cards" ? "secondary" : "ghost"} size="icon" className="h-7 w-7" onClick={() => setView("cards")} title={t("CardView")}>
                <LayoutGrid className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {searchQuery && (
              <Badge variant="secondary" className="gap-1">{interpolate(t("SearchFilterChip"), { value: searchQuery })}<button type="button" onClick={() => setSearchQuery("")} aria-label={t("ClearSearch")}><X className="h-3 w-3" /></button></Badge>
            )}
            {statusFilter !== "ALL" && (
              <Badge variant="secondary" className="gap-1">{interpolate(t("StatusFilterChip"), { value: translateVehicleStatus(statusFilter, t) })}<button type="button" onClick={() => setStatusFilter("ALL")} aria-label={t("ClearStatusFilter")}><X className="h-3 w-3" /></button></Badge>
            )}
            {agingFilter !== "ALL" && (
              <Badge variant="secondary" className="gap-1">{interpolate(t("AgeFilterChip"), { value: interpolate(t("DaysCount"), { count: agingFilter }) })}<button type="button" onClick={() => setAgingFilter("ALL")} aria-label={t("ClearAgeFilter")}><X className="h-3 w-3" /></button></Badge>
            )}
            {(searchQuery || statusFilter !== "ALL" || agingFilter !== "ALL") && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>{t("ClearAll")}</Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {interpolate(t(vehiclesStatus === "Exhausted" ? "ResultsCount" : "LoadedResultsCount"), { count: filteredVehicles?.length ?? 0 })}
          </p>
        </div>
      </div>

      {selectedVehicleIds.size > 0 && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3 shadow-lg">
          <span className="text-sm font-medium">{interpolate(t("SelectedCount"), { count: selectedVehicleIds.size })}</span>
          <Button variant="outline" size="sm" onClick={exportSelectedVehicles}>
            <Download className="h-4 w-4 me-2" /> {t("ExportSelected")}
          </Button>
          {canEditOrRequest && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={isBulkUpdating}>{t("ChangeStatus")}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(["AVAILABLE", ...(canEdit ? ["SOURCING" as const] : []), "RESERVED", "SOLD", "IN_INSPECTION", "IN_REPAIR"] as VehicleStatus[]).map((status) => (
                  <DropdownMenuItem key={status} onSelect={() => void handleBulkStatusChange(status)}>
                    {translateVehicleStatus(status, t)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSelectedVehicleIds(new Set())}>{t("ClearSelection")}</Button>
        </div>
      )}

      {view === "cards" && <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
        {filteredVehicles === undefined ? (
          <p className="text-center py-8 text-muted-foreground">{t("LoadingInventory" as any)}</p>
        ) : filteredVehicles.length === 0 ? (
          <p className="text-center py-8 text-muted-foreground">{t("NoVehiclesFound" as any)}</p>
        ) : filteredVehicles.map((vehicle) => {
          const thumbnail = vehicle.imageUrls?.find((url): url is string => Boolean(url));
          const warnings = getVehicleWarnings(vehicle);
          return (
            <div
              key={vehicle._id}
              id={`row-${vehicle._id}`}
              className={`relative rounded-xl border bg-card overflow-hidden transition-shadow hover:shadow-md ${highlightedId === vehicle._id ? "ring-2 ring-primary" : ""}`}
            >
              <button
                type="button"
                className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                onClick={() => setDetailsVehicle(vehicle)}
                aria-label={interpolate(t("OpenVehicleAria"), { vehicle: `${vehicle.year} ${vehicle.make} ${vehicle.model}` })}
              />
              <div className="relative z-10 pointer-events-none">
                <div className="aspect-[16/7] bg-muted relative">
                  {thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Convex storage URLs are dynamic and already used throughout the vehicle gallery.
                    <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                  ) : <ImageIcon className="absolute inset-0 m-auto h-10 w-10 text-muted-foreground/40" />}
                  <div className="pointer-events-auto absolute start-3 top-3">
                    <Checkbox checked={selectedVehicleIds.has(vehicle._id)} onCheckedChange={() => toggleVehicleSelection(vehicle._id)} aria-label={interpolate(t("SelectVehicleAria"), { vehicle: `${vehicle.make} ${vehicle.model}` })} />
                  </div>
                  <div className="absolute end-3 top-3"><StatusBadge status={vehicle.status} t={t} /></div>
                </div>
                <div className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}</p>
                      <p className="text-xs text-muted-foreground font-mono truncate">{vehicle.vin ?? t("VinPending")}</p>
                    </div>
                    <p className="font-semibold whitespace-nowrap">{vehicle.sellingPrice.toLocaleString(localeCode)} {t("JOD")}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div><p className="text-xs text-muted-foreground">{t("InventoryAge")}</p><p>{interpolate(t("DaysCount"), { count: getVehicleAgeDays(vehicle) })}</p></div>
                    <div><p className="text-xs text-muted-foreground">{t("Mileage")}</p><p>{vehicle.mileage.toLocaleString(localeCode)} {t("KilometersShort")}</p></div>
                  </div>
                  {warnings.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {warnings.map((warning) => <Badge key={warning} variant="outline" className="border-amber-300 text-amber-700"><AlertTriangle className="h-3 w-3 me-1" />{warning}</Badge>)}
                    </div>
                  )}
                  <div className="pointer-events-auto flex items-center justify-end gap-1 border-t pt-2">
                    <Button variant="ghost" size="sm" onClick={() => setGalleryVehicle(vehicle)}><ImageIcon className="h-4 w-4 me-2" />{t("Photos")}</Button>
                    {canEditOrRequest && <Button variant="ghost" size="sm" onClick={() => handleEdit(vehicle)}><Pencil className="h-4 w-4 me-2" />{t("Edit")}</Button>}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setHistoryVehicle(vehicle)}><History className="h-4 w-4 me-2" />{t("AuditHistory")}</DropdownMenuItem>
                        {canDelete && <><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setVehicleToDelete(vehicle)}><Archive className="h-4 w-4 me-2" />{t("ArchiveVehicle")}</DropdownMenuItem></>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>}

      {view === "table" && <div className="rounded-xl border overflow-x-auto bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"><Checkbox checked={allFilteredSelected} onCheckedChange={toggleAllFilteredVehicles} aria-label={t("SelectAllFilteredVehicles")} /></TableHead>
              <TableHead className="w-16">{t("Photo")}</TableHead>
              <SortableColumnHeader label={t("Vehicle")} sortKey="model" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <TableHead>{t("Status" as any)}</TableHead>
              <SortableColumnHeader label={t("Price")} sortKey="price" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableColumnHeader label={t("InventoryAge")} sortKey="addedDate" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <TableHead>{t("Readiness")}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredVehicles === undefined ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  {t("LoadingInventory" as any)}
                </TableCell>
              </TableRow>
            ) : filteredVehicles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  {t("NoVehiclesFound" as any)}
                </TableCell>
              </TableRow>
            ) : (
              filteredVehicles.map((vehicle) => {
                const thumbnail = vehicle.imageUrls?.find((url): url is string => Boolean(url));
                const warnings = getVehicleWarnings(vehicle);
                return (
                <TableRow
                  key={vehicle._id}
                  id={`row-${vehicle._id}`}
                  className={`cursor-pointer ${highlightedId === vehicle._id ? "bg-primary/20 transition-all duration-1000" : ""}`}
                  onClick={() => setDetailsVehicle(vehicle)}
                >
                  <TableCell onClick={(event) => event.stopPropagation()}><Checkbox checked={selectedVehicleIds.has(vehicle._id)} onCheckedChange={() => toggleVehicleSelection(vehicle._id)} aria-label={interpolate(t("SelectVehicleAria"), { vehicle: `${vehicle.make} ${vehicle.model}` })} /></TableCell>
                  <TableCell>
                    <div className="h-10 w-14 rounded bg-muted overflow-hidden flex items-center justify-center">
                      {thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element -- Convex storage URLs are dynamic and already used throughout the vehicle gallery.
                        <img src={thumbnail} alt="" className="h-full w-full object-cover" />
                      ) : <ImageIcon className="h-4 w-4 text-muted-foreground/50" />}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">
                    <p>{vehicle.year} {vehicle.make} {vehicle.model} {vehicle.trim}</p>
                    <p className="font-mono text-xs text-muted-foreground">{vehicle.vin ?? t("VinPending")}</p>
                  </TableCell>
                  <TableCell>
                    {canEditOrRequest ? (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
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
                  <TableCell className="font-medium">{vehicle.sellingPrice.toLocaleString(localeCode)} {t("JOD")}</TableCell>
                  <TableCell><p>{interpolate(t("DaysCount"), { count: getVehicleAgeDays(vehicle) })}</p><p className="text-xs text-muted-foreground">{interpolate(t("AddedOn"), { date: new Date(vehicle.createdAt ?? vehicle._creationTime).toLocaleDateString(localeCode) })}</p></TableCell>
                  <TableCell>
                    {warnings.length === 0 ? <Badge variant="outline" className="border-green-300 text-green-700"><Check className="h-3 w-3 me-1" />{t("Ready")}</Badge> : <div className="flex items-center gap-1 text-xs text-amber-700" title={warnings.join(", ")}><AlertTriangle className="h-4 w-4" />{interpolate(t(warnings.length === 1 ? "WarningCountOne" : "WarningCountMany"), { count: warnings.length })}</div>}
                  </TableCell>
                  <TableCell className="text-end space-x-1" onClick={(event) => event.stopPropagation()}>
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
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canDelete && <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setVehicleToDelete(vehicle)}><Archive className="h-4 w-4 me-2" />{t("ArchiveVehicle")}</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>}

      {vehiclesStatus === "CanLoadMore" && (
        <div className="flex justify-center mt-4">
          <Button variant="outline" onClick={() => loadMoreVehicles(20)}>
            {t("LoadMore" as any) || "Load More"}
          </Button>
        </div>
      )}

      <Dialog open={isSaveViewDialogOpen} onOpenChange={setIsSaveViewDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("SaveCurrentView")}</DialogTitle>
            <DialogDescription>{t("SaveCurrentViewDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="vehicle-view-name">{t("ViewName")}</Label>
            <Input id="vehicle-view-name" value={savedViewName} onChange={(event) => setSavedViewName(event.target.value)} placeholder={t("SavedViewExample")} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSaveViewDialogOpen(false)}>{t("Cancel")}</Button>
            <Button onClick={handleSaveCurrentView} disabled={!savedViewName.trim()}>{t("SaveView")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* Archive is deliberately separated from routine edit actions. */}
      <Dialog open={!!vehicleToDelete} onOpenChange={(open) => !open && setVehicleToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ArchiveVehicle")}</DialogTitle>
            <DialogDescription>
              {interpolate(t("ArchiveVehicleDescription"), {
                vehicle: `${vehicleToDelete?.year ?? ""} ${vehicleToDelete?.make ?? ""} ${vehicleToDelete?.model ?? ""}`.trim(),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setVehicleToDelete(null)}>{t("Cancel")}</Button>
            <Button variant="destructive" onClick={handleDelete}><Archive className="h-4 w-4 me-2" />{t("ArchiveVehicle")}</Button>
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
                {galleryVehicle.imageUrls.filter((url): url is string => Boolean(url)).map((url, index) => (
                  <div key={index} className="relative aspect-video rounded-md overflow-hidden bg-muted group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={interpolate(t("VehicleImageAlt"), { index: index + 1 })}
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
              <Select value={selectedStatus} onValueChange={(status) => setSelectedStatus(status as VehicleStatus)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("SelectStatus" as any)} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AVAILABLE">{t("StatusAvailable" as any)}</SelectItem>
                  {canEdit && <SelectItem value="SOURCING">{t("StatusSourcing")}</SelectItem>}
                  <SelectItem value="RESERVED">{t("StatusReserved" as any)}</SelectItem>
                  <SelectItem value="SOLD">{t("StatusSold" as any)}</SelectItem>
                  <SelectItem value="IN_INSPECTION">{t("StatusInInspection" as any)}</SelectItem>
                  <SelectItem value="IN_REPAIR">{t("StatusInRepair" as any)}</SelectItem>
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
                {pendingEdits?.map((req: Doc<"vehicleEdits"> & { user: { name: string; email: string } | null; vehicle: Doc<"vehicles"> | null }) => (
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
                {pendingRequests?.map((req: Doc<"vehicleStatusRequests"> & { vehicle: { make: string; model: string; year: number; vin: string | undefined; currentStatus: string } | null; user: { name: string; email: string } | null }) => (
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
                        <p className="text-xs text-muted-foreground italic mt-2">&ldquo;{req.notes}&rdquo;</p>
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
