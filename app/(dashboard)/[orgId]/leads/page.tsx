"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LeadDialog } from "@/components/leads/LeadDialog";
import { SocialConversationDialog } from "@/components/leads/SocialConversationDialog";
import { Id } from "@/convex/_generated/dataModel";
import { Plus, User, Car, Trash2, FileText, LayoutList, Kanban, MessageCircle, Search, AlertTriangle, Clock, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { downloadElementAsPdf } from "@/lib/htmlToPdf";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { LeadQuotePrintTemplate } from "@/components/leads/LeadQuotePrintTemplate";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { useTableControls } from "@/hooks/useTableControls";
import { useHighlightRow } from "@/hooks/useHighlightRow";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useStoredViewPreference } from "@/hooks/useStoredViewPreference";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";

import { LEAD_STAGES } from "@/convex/constants";
import { getErrorMessage } from "@/lib/errors";

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  TEST_DRIVE: "Test Drive",
  NEGOTIATION: "Negotiation",
  RESERVED: "Reserved",
  WON: "Won",
  LOST: "Lost",
};

const LEAD_VIEW_OPTIONS = ["table", "kanban"] as const;
type LeadView = typeof LEAD_VIEW_OPTIONS[number];
type LeadStage = typeof LEAD_STAGES[number];

const NEXT_ACTION_BY_STAGE: Record<LeadStage, string> = {
  NEW: "Make first contact",
  CONTACTED: "Confirm vehicle interest",
  INTERESTED: "Schedule a test drive",
  TEST_DRIVE: "Capture test-drive outcome",
  NEGOTIATION: "Prepare or follow up quote",
  RESERVED: "Confirm deal completion",
  WON: "Complete handover",
  LOST: "Record loss reason",
};

export default function LeadsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefillCustomerId = searchParams.get("customerId");
  const { hasPermission } = usePermissions();
  const canEditLeads = hasPermission(PERMISSIONS.EDIT_LEADS);
  const canDeleteLeads = hasPermission(PERMISSIONS.DELETE_LEADS);
  const canViewUsers = hasPermission(PERMISSIONS.VIEW_USERS);
  const { results: leads, status: leadsStatus, loadMore: loadMoreLeads } = usePaginatedQuery(
    api.leads.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 25 }
  );
  const removeLead = useMutation(api.leads.softDelete);
  const updateLead = useMutation(api.leads.update);
  const { results: memberships } = usePaginatedQuery(
    api.memberships.list,
    activeOrgId && canViewUsers ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );
  const orgSettings = useOrgSettings();
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const [isLeadDialogOpen, setIsLeadDialogOpen] = useState(Boolean(prefillCustomerId));
  type LeadListItem = NonNullable<typeof leads>[number];
  const [editingLead, setEditingLead] = useState<LeadListItem | null>(null);
  const [leadToDelete, setLeadToDelete] = useState<LeadListItem | null>(null);
  const [printingLead, setPrintingLead] = useState<LeadListItem | null>(null);
  const [view, setView] = useStoredViewPreference<LeadView>(
    `autoflow:${activeOrgId ?? "default"}:lead-view`,
    "table",
    LEAD_VIEW_OPTIONS
  );
  const [stageFilter, setStageFilter] = useState<"ALL" | LeadStage>("ALL");
  const [sourceFilter, setSourceFilter] = useState("ALL");
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<Id<"leads">>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [defaultCustomerId, setDefaultCustomerId] = useState<Id<"customers"> | null>(
    () => prefillCustomerId as Id<"customers"> | null
  );
  const [conversationCustomerId, setConversationCustomerId] = useState<Id<"customers"> | null>(null);

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows: searchedLeads,
  } = useTableControls({
    data: leads,
    searchFields: (l) => [l.customerName, l.vehicleSummary, l.assignedUserName],
    sortAccessors: {
      customer: (l) => (l.customerName ?? "").toLowerCase(),
      stage: (l) => l.stage,
      createdAt: (l) => l._creationTime,
      updatedAt: (l) => l.updatedAt ?? l._creationTime,
    },
    // Matches the order the query already returns, so the Created At header
    // shows the sort that is actually in effect instead of appearing unsorted.
    // It has to agree with the server: this sort only reorders rows already
    // loaded, so a default that disagreed would shuffle each page against the
    // stream it came from and make newest-first true only within a page.
    defaultSortKey: "createdAt",
    defaultSortDir: "desc",
    pagination: { status: leadsStatus, loadMore: loadMoreLeads, batchSize: 25 },
  });

  const sourceOptions = useMemo(
    () => Array.from(new Set((leads ?? []).map((lead) => lead.source))).sort((first, second) => first.localeCompare(second)),
    [leads]
  );
  const filteredLeads = searchedLeads?.filter((lead) =>
    (stageFilter === "ALL" || lead.stage === stageFilter) &&
    (sourceFilter === "ALL" || lead.source === sourceFilter)
  );
  const selectedLeads = useMemo(
    () => (leads ?? []).filter((lead) => selectedLeadIds.has(lead._id)),
    [leads, selectedLeadIds]
  );
  const allFilteredSelected = !!filteredLeads?.length && filteredLeads.every((lead) => selectedLeadIds.has(lead._id));

  useEffect(() => {
    if (!prefillCustomerId || !activeOrgId) return;
    router.replace(`/${activeOrgId}/leads`, { scroll: false });
  }, [activeOrgId, prefillCustomerId, router]);

  const highlightedLeadId = useHighlightRow({
    // Fed the *rendered* rows: a row hidden by the active search or filter has
    // no element to scroll to, and the hook must not report it as found.
    rows: filteredLeads,
    getId: (l) => l._id,
    pagination: { status: leadsStatus, loadMore: loadMoreLeads, batchSize: 25 },
  });

  const handleEdit = (lead: LeadListItem) => {
    setEditingLead(lead);
    setDefaultCustomerId(null);
    setIsLeadDialogOpen(true);
  };

  const openLeadWorkspace = (leadId: Id<"leads">) => {
    router.push(`/${activeOrgId}/leads/${leadId}`);
  };

  const handleAddNew = () => {
    setEditingLead(null);
    setDefaultCustomerId(null);
    setIsLeadDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !leadToDelete) return;
    try {
      await removeLead({ orgId: activeOrgId, leadId: leadToDelete._id });
      toast.success(t("LeadRemovedSuccess" as any) || "Lead deleted successfully");
      setLeadToDelete(null);
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const handleDownloadLeadQuote = async (lead: LeadListItem) => {
    setPrintingLead(lead);
    // Wait for the (now-mounted) print template to actually paint before capturing it.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const saved = await downloadElementAsPdf("lead-quote-pdf-content", `Quote_${lead.customerName}.pdf`);
    if (saved) {
      toast.success(t("QuoteGenerated" as any) || "Quote generated");
    } else {
      toast.error(t("FailedGenerateQuote" as any) || "Failed to generate Quote");
    }
    setPrintingLead(null);
  };

  // eslint-disable-next-line react-hooks/purity -- Keep every age indicator consistent within this render.
  const currentTime = Date.now();
  const getLeadAgeDays = (lead: LeadListItem) =>
    Math.max(0, Math.floor((currentTime - lead._creationTime) / (24 * 60 * 60 * 1000)));

  const getDaysSinceActivity = (lead: LeadListItem) =>
    Math.max(0, Math.floor((currentTime - (lead.updatedAt ?? lead._creationTime)) / (24 * 60 * 60 * 1000)));

  const isStaleLead = (lead: LeadListItem) =>
    lead.stage !== "WON" && lead.stage !== "LOST" && getDaysSinceActivity(lead) >= 7;

  const updateLeadStage = async (leadId: Id<"leads">, stage: LeadStage) => {
    if (!activeOrgId) return;
    try {
      await updateLead({ orgId: activeOrgId, leadId, stage });
      toast.success("Lead moved");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  const toggleLeadSelection = (leadId: Id<"leads">) => {
    setSelectedLeadIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(leadId)) nextIds.delete(leadId);
      else nextIds.add(leadId);
      return nextIds;
    });
  };

  const toggleAllFilteredLeads = () => {
    setSelectedLeadIds((currentIds) => {
      const nextIds = new Set(currentIds);
      if (allFilteredSelected) filteredLeads?.forEach((lead) => nextIds.delete(lead._id));
      else filteredLeads?.forEach((lead) => nextIds.add(lead._id));
      return nextIds;
    });
  };

  const runBulkLeadUpdate = async (updates: Array<Promise<unknown>>, successMessage: string) => {
    setIsBulkUpdating(true);
    const settledUpdates = await Promise.allSettled(updates);
    const failureCount = settledUpdates.filter((update) => update.status === "rejected").length;
    if (failureCount > 0) toast.error(`${failureCount} lead${failureCount === 1 ? "" : "s"} could not be updated. Please try again.`);
    else {
      toast.success(successMessage);
      setSelectedLeadIds(new Set());
    }
    setIsBulkUpdating(false);
  };

  const handleBulkStageChange = (stage: LeadStage) => {
    if (!activeOrgId) return;
    void runBulkLeadUpdate(
      selectedLeads.map((lead) => updateLead({ orgId: activeOrgId, leadId: lead._id, stage })),
      "Lead stages updated"
    );
  };

  const handleBulkAssignment = (assignedUserId: Id<"users">) => {
    if (!activeOrgId) return;
    void runBulkLeadUpdate(
      selectedLeads.map((lead) => updateLead({ orgId: activeOrgId, leadId: lead._id, assignedUserId })),
      "Leads assigned"
    );
  };

  const leadsByStage = LEAD_STAGES.reduce((acc, stage) => {
    acc[stage] = filteredLeads?.filter((lead) => lead.stage === stage) || [];
    return acc;
  }, {} as Record<LeadStage, LeadListItem[]>);

  const getStageColor = (stage: string) => {
    switch (stage) {
      case "NEW": return "bg-blue-500/10 text-blue-500";
      case "CONTACTED": return "bg-purple-500/10 text-purple-500";
      case "INTERESTED": return "bg-indigo-500/10 text-indigo-500";
      case "TEST_DRIVE": return "bg-orange-500/10 text-orange-500";
      case "NEGOTIATION": return "bg-yellow-500/10 text-yellow-500";
      case "RESERVED": return "bg-teal-500/10 text-teal-500";
      case "WON": return "bg-green-500/10 text-green-500";
      case "LOST": return "bg-red-500/10 text-red-500";
      default: return "bg-gray-500/10 text-gray-500";
    }
  };

  const getStageBorderColor = (stage: string) => {
    switch (stage) {
      case "NEW": return "border-t-blue-400";
      case "CONTACTED": return "border-t-purple-400";
      case "INTERESTED": return "border-t-indigo-400";
      case "TEST_DRIVE": return "border-t-orange-400";
      case "NEGOTIATION": return "border-t-yellow-400";
      case "RESERVED": return "border-t-teal-400";
      case "WON": return "border-t-green-400";
      case "LOST": return "border-t-red-400";
      default: return "border-t-gray-400";
    }
  };

  const translateStage = (stage: string) => {
    const keyMap: Record<string, string> = {
      NEW: "StageNew", CONTACTED: "StageContacted", INTERESTED: "Interested",
      TEST_DRIVE: "StageTestDrive", NEGOTIATION: "StageNegotiation",
      RESERVED: "Reserved", WON: "StageWon", LOST: "Lost",
    };
    return t(keyMap[stage] as any) || STAGE_LABELS[stage] || stage;
  };

  return (
    <RoleGuard permissions={["view:leads"]}>
      <div className="space-y-6 flex flex-col md:h-full md:overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          {/* View toggle */}
          <div className="flex items-center gap-1 rounded-lg border bg-muted/30 p-1 w-fit">
            <button
              onClick={() => setView("table")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${view === "table" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <LayoutList className="h-3.5 w-3.5" /> List
            </button>
            <button
              onClick={() => setView("kanban")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${view === "kanban" ? "bg-white shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Kanban className="h-3.5 w-3.5" /> Board
            </button>
          </div>
          <Button onClick={handleAddNew}>
            <Plus className="me-2 h-4 w-4" /> {t("AddLead" as any) || "Add Lead"}
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-shrink-0">
          <div className="bg-card border-0 ring-1 ring-slate-100 dark:ring-zinc-800 rounded-xl p-6 shadow-sm flex flex-col justify-center">
            <h3 className="text-sm font-medium text-muted-foreground">{t("TotalLeads" as any) || "Total Leads"}</h3>
            <p className="text-3xl font-bold mt-2 text-foreground">{leads?.length || 0}</p>
          </div>
          <div className="bg-card border-0 ring-1 ring-slate-100 dark:ring-zinc-800 rounded-xl p-6 shadow-sm flex flex-col justify-center">
            <h3 className="text-sm font-medium text-muted-foreground">{t("ActiveLeads" as any) || "Active Leads"}</h3>
            <p className="text-3xl font-bold mt-2 text-blue-600">{leads?.filter(l => l.stage !== "WON" && l.stage !== "LOST").length || 0}</p>
          </div>
          <div className="bg-card border-0 ring-1 ring-slate-100 dark:ring-zinc-800 rounded-xl p-6 shadow-sm flex flex-col justify-center">
            <h3 className="text-sm font-medium text-muted-foreground">{t("WonLeads" as any) || "Leads Won"}</h3>
            <p className="text-3xl font-bold mt-2 text-emerald-600">{leads?.filter(l => l.stage === "WON").length || 0}</p>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 lg:flex-row lg:items-center">
          <div className="flex items-center w-full lg:max-w-md relative">
            <Search className="h-4 w-4 text-muted-foreground absolute start-3" />
            <Input
              placeholder={t("SearchLeads" as any) || "Search leads..."}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="ps-9"
            />
          </div>
          <Select value={stageFilter} onValueChange={(stage) => setStageFilter(stage as "ALL" | LeadStage)}>
            <SelectTrigger className="w-full lg:w-[180px]"><SelectValue placeholder="All stages" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All stages</SelectItem>
              {LEAD_STAGES.map((stage) => <SelectItem key={stage} value={stage}>{translateStage(stage)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-full lg:w-[180px]"><SelectValue placeholder="All sources" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All sources</SelectItem>
              {sourceOptions.map((source) => <SelectItem key={source} value={source}>{source}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-2 lg:ms-auto">
            {(searchQuery || stageFilter !== "ALL" || sourceFilter !== "ALL") && <Button variant="ghost" size="sm" onClick={() => { setSearchQuery(""); setStageFilter("ALL"); setSourceFilter("ALL"); }}>Clear filters</Button>}
            <span className="text-sm text-muted-foreground">{filteredLeads?.length ?? 0} {leadsStatus === "Exhausted" ? "results" : "loaded results"}</span>
          </div>
        </div>

        {selectedLeadIds.size > 0 && (
          <div className="sticky top-2 z-20 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3 shadow-lg">
            <span className="text-sm font-medium">{selectedLeadIds.size} selected</span>
            {canEditLeads && (
              <>
                <Select onValueChange={(stage) => handleBulkStageChange(stage as LeadStage)} disabled={isBulkUpdating}>
                  <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="Move to stage" /></SelectTrigger>
                  <SelectContent>{LEAD_STAGES.map((stage) => <SelectItem key={stage} value={stage}>{translateStage(stage)}</SelectItem>)}</SelectContent>
                </Select>
                {canViewUsers && (
                  <Select onValueChange={(userId) => handleBulkAssignment(userId as Id<"users">)} disabled={isBulkUpdating}>
                    <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Assign salesperson" /></SelectTrigger>
                    <SelectContent>{memberships?.map((membership) => <SelectItem key={membership.userId} value={membership.userId}>{membership.userName}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </>
            )}
            <Button variant="ghost" size="sm" onClick={() => setSelectedLeadIds(new Set())}>Clear selection</Button>
          </div>
        )}

        {/* TABLE VIEW */}
        {view === "table" && (
          <>
          {/* Mobile card list */}
          <div className="flex flex-col gap-3 md:hidden">
            {!filteredLeads || filteredLeads.length === 0 ? (
              <p className="text-center py-12 text-muted-foreground">{t("Empty" as any) || "No leads found."}</p>
            ) : filteredLeads.map((lead) => (
              <div
                key={lead._id}
                id={`row-${lead._id}`}
                className={`relative rounded-xl border bg-card p-4 active:bg-muted/30 transition-shadow ${highlightedLeadId === lead._id ? "ring-2 ring-amber-400" : ""}`}
              >
                <button
                  type="button"
                  className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  onClick={() => openLeadWorkspace(lead._id)}
                  aria-label={`Open ${lead.customerName || "lead"}`}
                />
                <div className="relative z-10 pointer-events-none space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="pointer-events-auto"><Checkbox checked={selectedLeadIds.has(lead._id)} onCheckedChange={() => toggleLeadSelection(lead._id)} aria-label={`Select ${lead.customerName}`} /></div>
                      <span className="w-9 h-9 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-500 font-bold text-xs shrink-0">{lead.customerName?.charAt(0).toUpperCase() ?? "?"}</span>
                      <div className="min-w-0"><p className="font-semibold text-sm truncate">{lead.customerName}</p><p className="text-xs text-muted-foreground truncate">{lead.source}</p></div>
                    </div>
                    <Badge variant="outline" className={`text-[10px] uppercase border-transparent ${getStageColor(lead.stage)}`}>{translateStage(lead.stage)}</Badge>
                  </div>
                  {isStaleLead(lead) && <Badge variant="outline" className="border-amber-300 text-amber-700"><AlertTriangle className="h-3 w-3 me-1" />Stale · {getDaysSinceActivity(lead)} days</Badge>}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div><p className="text-muted-foreground">Interest</p><p className="truncate">{lead.vehicleSummary || "Any vehicle"}</p></div>
                    <div><p className="text-muted-foreground">Owner</p><p className="truncate">{lead.assignedUserName || "Unassigned"}</p></div>
                    <div><p className="text-muted-foreground">Age</p><p>{getLeadAgeDays(lead)} days</p></div>
                    <div><p className="text-muted-foreground">Last activity</p><p>{getDaysSinceActivity(lead)} days ago</p></div>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2 text-xs"><span className="text-muted-foreground">Next: </span>{NEXT_ACTION_BY_STAGE[lead.stage]}</div>
                  <div className="pointer-events-auto flex items-center justify-end border-t pt-2">
                    {canEditLeads && <Button variant="ghost" size="sm" onClick={() => handleEdit(lead)}><Pencil className="h-4 w-4 me-2" />Edit</Button>}
                    {(lead.source?.startsWith("Instagram") || lead.source?.startsWith("Facebook")) && (
                      <button
                        type="button"
                        onClick={() => setConversationCustomerId(lead.customerId)}
                        className="p-3 rounded-md text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        title={t("ViewConversation" as any)}
                      >
                        <MessageCircle className="w-4 h-4" />
                      </button>
                    )}
                    {canDeleteLeads && (
                      <button
                        type="button"
                        onClick={() => setLeadToDelete(lead)}
                        className="p-3 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        aria-label={`Delete ${lead.customerName || "lead"}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {leadsStatus === "CanLoadMore" && (
              <div className="flex justify-center pt-2">
                <Button variant="outline" onClick={() => loadMoreLeads(25)}>{t("LoadMore" as any) || "Load More"}</Button>
              </div>
            )}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block flex-1 overflow-auto bg-card rounded-xl border-0 ring-1 ring-slate-100 dark:ring-zinc-800 shadow-sm">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/50 dark:bg-zinc-900/50 hover:bg-slate-50/50 dark:hover:bg-zinc-900/50">
                  <TableHead className="w-10 px-4"><Checkbox checked={allFilteredSelected} onCheckedChange={toggleAllFilteredLeads} aria-label="Select all filtered leads" /></TableHead>
                  <SortableColumnHeader className="py-4 px-6 font-medium" label={t("Customer" as any) || "Customer"} sortKey="customer" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <TableHead className="py-4 px-6 font-medium">{t("Vehicle" as any) || "Vehicle"}</TableHead>
                  <SortableColumnHeader className="py-4 px-6 font-medium" label={t("Stage" as any) || "Stage"} sortKey="stage" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <TableHead className="py-4 px-6 font-medium">{t("AssignedTo" as any) || "Assigned To"}</TableHead>
                  <TableHead className="py-4 px-6 font-medium">Next action</TableHead>
                  <SortableColumnHeader className="py-4 px-6 font-medium" label="Activity / age" sortKey="updatedAt" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                  <TableHead className="py-4 px-6 font-medium text-end">{t("Actions" as any) || "Actions"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLeads?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      {t("Empty" as any) || "No leads found. Add a new lead to get started."}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLeads?.map((lead) => (
                    <TableRow
                      key={lead._id}
                      id={`row-${lead._id}`}
                      className={`cursor-pointer group hover:bg-slate-50/50 dark:hover:bg-zinc-900/50 transition-colors ${highlightedLeadId === lead._id ? "ring-2 ring-inset ring-amber-400" : ""}`}
                      onClick={() => openLeadWorkspace(lead._id)}
                    >
                      <TableCell className="px-4" onClick={(event) => event.stopPropagation()}><Checkbox checked={selectedLeadIds.has(lead._id)} onCheckedChange={() => toggleLeadSelection(lead._id)} aria-label={`Select ${lead.customerName}`} /></TableCell>
                      <TableCell className="py-4 px-6 font-medium">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-500 font-medium text-xs flex-shrink-0">
                            {lead.customerName ? lead.customerName.charAt(0).toUpperCase() : "?"}
                          </div>
                          <div className="min-w-0"><span className="truncate max-w-[200px] block">{lead.customerName}</span>{isStaleLead(lead) && <span className="mt-1 flex items-center gap-1 text-[11px] text-amber-700"><AlertTriangle className="h-3 w-3" />Stale {getDaysSinceActivity(lead)}d</span>}</div>
                        </div>
                      </TableCell>
                      <TableCell className="py-4 px-6">
                        {lead.vehicleSummary ? (
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <Car className="w-4 h-4 flex-shrink-0" />
                            <span className="truncate max-w-[200px]">{lead.vehicleSummary}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-4 px-6">
                        <Badge variant="outline" className={`text-[10px] uppercase font-semibold ${getStageColor(lead.stage)} border-transparent px-2 py-0.5 rounded-full`}>
                          {translateStage(lead.stage)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-4 px-6">
                        {lead.assignedUserName ? (
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <User className="w-4 h-4 flex-shrink-0" />
                            <span className="truncate max-w-[150px]">{lead.assignedUserName}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/50">-</span>
                        )}
                      </TableCell>
                      <TableCell className="py-4 px-6 text-sm max-w-[220px]">
                        {NEXT_ACTION_BY_STAGE[lead.stage]}
                      </TableCell>
                      <TableCell className="py-4 px-6 text-muted-foreground whitespace-nowrap">
                        <p>{getDaysSinceActivity(lead)}d since activity</p>
                        <p className="text-xs">{getLeadAgeDays(lead)}d old</p>
                      </TableCell>
                      <TableCell className="py-4 px-6 text-end">
                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {canEditLeads && <button type="button" onClick={(event) => { event.stopPropagation(); handleEdit(lead); }} className="p-2 hover:bg-muted rounded-md text-muted-foreground"><Pencil className="h-4 w-4" /></button>}
                          {(lead.source?.startsWith("Instagram") || lead.source?.startsWith("Facebook")) && (
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setConversationCustomerId(lead.customerId); }}
                              className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md text-muted-foreground hover:text-blue-600 transition-colors"
                              title={t("ViewConversation" as any)}
                            >
                              <MessageCircle className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleDownloadLeadQuote(lead); }}
                            className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md text-muted-foreground hover:text-blue-600 transition-colors"
                          >
                            <FileText className="w-4 h-4" />
                          </button>
                          {canDeleteLeads && (
                            <button
                              type="button"
                              onClick={(event) => { event.stopPropagation(); setLeadToDelete(lead); }}
                              className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md text-muted-foreground hover:text-red-600 transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
            {leadsStatus === "CanLoadMore" && (
              <div className="flex justify-center p-4">
                <Button variant="outline" onClick={() => loadMoreLeads(25)}>{t("LoadMore" as any) || "Load More"}</Button>
              </div>
            )}
          </div>
          </>
        )}

        {/* KANBAN VIEW */}
        {view === "kanban" && (
          <div className="flex-1 overflow-x-auto pb-4">
            <div className="flex gap-3 h-full min-w-max">
              {LEAD_STAGES.map((stage) => {
                const stageLeads = leadsByStage[stage] || [];
                return (
                  <div key={stage} className={`flex flex-col w-72 flex-shrink-0 bg-slate-50 dark:bg-zinc-900/40 rounded-xl border border-t-4 ${getStageBorderColor(stage)}`}>
                    {/* Column header */}
                    <div className="px-3 py-3 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                        {translateStage(stage)}
                      </span>
                      <span className="text-xs bg-white dark:bg-zinc-800 border rounded-full px-2 py-0.5 font-medium text-slate-500">
                        {stageLeads.length}
                      </span>
                    </div>

                    {/* Cards */}
                    <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-2 min-h-[120px]">
                      {stageLeads.length === 0 ? (
                        <div className="text-center py-6 text-xs text-muted-foreground/50">Empty</div>
                      ) : (
                        stageLeads.map((lead) => (
                          <div
                            key={lead._id}
                            className="relative bg-white dark:bg-zinc-800 rounded-lg p-3 shadow-sm border border-slate-100 dark:border-zinc-700 hover:shadow-md transition-shadow group"
                          >
                            <button
                              type="button"
                              className="absolute inset-0 z-0 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                              onClick={() => openLeadWorkspace(lead._id)}
                              aria-label={`Open ${lead.customerName || "lead"}`}
                            />
                            <div className="relative z-10 pointer-events-none space-y-3">
                              <div className="flex items-center gap-2">
                                <div className="pointer-events-auto"><Checkbox checked={selectedLeadIds.has(lead._id)} onCheckedChange={() => toggleLeadSelection(lead._id)} aria-label={`Select ${lead.customerName}`} /></div>
                                <div className="min-w-0 flex flex-1 items-center gap-2 text-start">
                                  <span className="w-6 h-6 rounded-full bg-slate-100 dark:bg-zinc-700 flex items-center justify-center text-[10px] font-medium flex-shrink-0">
                                    {lead.customerName?.charAt(0)?.toUpperCase() ?? "?"}
                                  </span>
                                  <span className="text-sm font-medium truncate flex-1">{lead.customerName}</span>
                                </div>
                                {(lead.source?.startsWith("Instagram") || lead.source?.startsWith("Facebook")) && (
                                  <button
                                    type="button"
                                    onClick={() => setConversationCustomerId(lead.customerId)}
                                    className="pointer-events-auto p-1 rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors shrink-0"
                                    title={t("ViewConversation" as any)}
                                  >
                                    <MessageCircle className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                              {isStaleLead(lead) && <Badge variant="outline" className="border-amber-300 text-amber-700"><AlertTriangle className="h-3 w-3 me-1" />Stale {getDaysSinceActivity(lead)}d</Badge>}
                              <div className="space-y-1 text-[11px] text-muted-foreground">
                                <p className="flex items-center gap-1"><Car className="w-3 h-3 shrink-0" /><span className="truncate">{lead.vehicleSummary || "Any vehicle"}</span></p>
                                <p className="flex items-center gap-1"><User className="w-3 h-3 shrink-0" /><span className="truncate">{lead.assignedUserName || "Unassigned"}</span></p>
                                <p className="flex items-center gap-1"><Clock className="w-3 h-3 shrink-0" />{getDaysSinceActivity(lead)}d since activity · {getLeadAgeDays(lead)}d old</p>
                              </div>
                              <div className="rounded-md bg-muted/50 p-2 text-[11px]"><span className="text-muted-foreground">Next: </span>{NEXT_ACTION_BY_STAGE[lead.stage]}</div>
                              {canEditLeads && (
                                <div className="pointer-events-auto">
                                  <Select value={lead.stage} onValueChange={(nextStage) => void updateLeadStage(lead._id, nextStage as LeadStage)}>
                                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>{LEAD_STAGES.map((nextStage) => <SelectItem key={nextStage} value={nextStage}>{translateStage(nextStage)}</SelectItem>)}</SelectContent>
                                  </Select>
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <LeadDialog
          open={isLeadDialogOpen}
          onOpenChange={setIsLeadDialogOpen}
          lead={editingLead}
          defaultCustomerId={defaultCustomerId}
        />

        <SocialConversationDialog
          customerId={conversationCustomerId}
          open={!!conversationCustomerId}
          onOpenChange={(o) => !o && setConversationCustomerId(null)}
        />

        <Dialog open={!!leadToDelete} onOpenChange={(open) => !open && setLeadToDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("RemoveLead" as any) || "Delete Lead"}</DialogTitle>
              <DialogDescription>
                {t("RemoveLeadConfirm" as any) || "Are you sure you want to delete this lead?"} <br />
                <span className="font-semibold text-foreground">{leadToDelete?.customerName}</span>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setLeadToDelete(null)}>{t("Cancel" as any)}</Button>
              <Button variant="destructive" onClick={handleDelete}>{t("Delete" as any)}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {printingLead && (
          <LeadQuotePrintTemplate
            customerName={printingLead.customerName}
            vehicleSummary={printingLead.vehicleSummary || t("UnknownVehicle" as any) || "Unknown Vehicle"}
            estimatedPrice={printingLead.vehiclePrice ?? 0}
            dateStr={new Date().toLocaleDateString()}
            orgBranding={{
              name: orgSettings?.dealershipName,
              legalName: orgSettings?.legalCompanyName,
              logoUrl,
              primaryColor: orgSettings?.primaryColor,
              currencySymbol: orgSettings?.currencySymbol,
            }}
          />
        )}
      </div>
    </RoleGuard>
  );
}
