"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { LeadDialog } from "@/components/leads/LeadDialog";
import { SocialConversationDialog } from "@/components/leads/SocialConversationDialog";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { Plus, User, Car, Trash2, FileText, LayoutList, Kanban, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "@/components/ui/sonner";
import { generateQuote } from "@/lib/pdf";
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

import { LEAD_STAGES } from "@/convex/constants";

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

export default function LeadsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { results: leads, status: leadsStatus, loadMore: loadMoreLeads } = usePaginatedQuery(
    api.leads.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 25 }
  );
  const removeLead = useMutation(api.leads.softDelete);
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlightId");

  const [isLeadDialogOpen, setIsLeadDialogOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<any>(null);
  const [leadToDelete, setLeadToDelete] = useState<any>(null);
  const [view, setView] = useState<"table" | "kanban">("table");
  const [conversationCustomerId, setConversationCustomerId] = useState<Id<"customers"> | null>(null);
  const [highlightedLeadId, setHighlightedLeadId] = useState<string | null>(null);
  const rowRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    if (!highlightId || !leads?.some((l) => l._id === highlightId)) return;
    setHighlightedLeadId(highlightId);
    rowRefs.current[highlightId]?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timeout = setTimeout(() => setHighlightedLeadId(null), 4000);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightId, leads]);

  const handleEdit = (lead: any) => {
    setEditingLead(lead);
    setIsLeadDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingLead(null);
    setIsLeadDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !leadToDelete) return;
    try {
      await removeLead({ orgId: activeOrgId, leadId: leadToDelete._id });
      toast.success(t("LeadRemovedSuccess" as any) || "Lead deleted successfully");
      setLeadToDelete(null);
    } catch (error: any) {
      toast.error(error.message || (t("LeadRemoveFail" as any) || "Failed to delete lead"));
    }
  };

  const leadsByStage = LEAD_STAGES.reduce((acc, stage) => {
    acc[stage] = leads?.filter((l) => l.stage === stage) || [];
    return acc;
  }, {} as Record<string, any[]>);

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
      <div className="space-y-6 flex flex-col h-full overflow-hidden">
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

        {/* TABLE VIEW */}
        {view === "table" && (
          <>
          {/* Mobile card list */}
          <div className="flex flex-col gap-3 md:hidden">
            {!leads || leads.length === 0 ? (
              <p className="text-center py-12 text-muted-foreground">{t("Empty" as any) || "No leads found."}</p>
            ) : leads.map((lead) => (
              <div
                key={lead._id}
                ref={(el) => { rowRefs.current[lead._id] = el; }}
                className={`rounded-xl border bg-card p-4 space-y-3 cursor-pointer active:bg-muted/30 transition-shadow ${highlightedLeadId === lead._id ? "ring-2 ring-amber-400" : ""}`}
                onClick={() => handleEdit(lead)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-500 font-bold text-xs shrink-0">
                      {lead.customerName ? lead.customerName.charAt(0).toUpperCase() : "?"}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{lead.customerName}</p>
                      {lead.vehicleSummary && (
                        <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                          <Car className="h-3 w-3 shrink-0" />{lead.vehicleSummary}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full shrink-0 ${getStageColor(lead.stage)}`}>
                    {translateStage(lead.stage)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  {lead.assignedUserName ? (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <User className="h-3 w-3" />{lead.assignedUserName}
                    </span>
                  ) : <span />}
                  <div className="flex items-center">
                    {(lead.source?.startsWith("Instagram") || lead.source?.startsWith("Facebook")) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConversationCustomerId(lead.customerId); }}
                        className="p-3 rounded-md text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        title={t("ViewConversation" as any)}
                      >
                        <MessageCircle className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setLeadToDelete(lead); }}
                      className="p-3 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
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
                  <TableHead className="py-4 px-6 font-medium">{t("Customer" as any) || "Customer"}</TableHead>
                  <TableHead className="py-4 px-6 font-medium">{t("Vehicle" as any) || "Vehicle"}</TableHead>
                  <TableHead className="py-4 px-6 font-medium">{t("Stage" as any) || "Stage"}</TableHead>
                  <TableHead className="py-4 px-6 font-medium">{t("AssignedTo" as any) || "Assigned To"}</TableHead>
                  <TableHead className="py-4 px-6 font-medium text-end">{t("Actions" as any) || "Actions"}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads?.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">
                      {t("Empty" as any) || "No leads found. Add a new lead to get started."}
                    </TableCell>
                  </TableRow>
                ) : (
                  leads?.map((lead) => (
                    <TableRow
                      key={lead._id}
                      ref={(el) => { rowRefs.current[lead._id] = el; }}
                      className={`cursor-pointer group hover:bg-slate-50/50 dark:hover:bg-zinc-900/50 transition-colors ${highlightedLeadId === lead._id ? "ring-2 ring-inset ring-amber-400" : ""}`}
                      onClick={() => handleEdit(lead)}
                    >
                      <TableCell className="py-4 px-6 font-medium">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-zinc-800 flex items-center justify-center text-slate-500 font-medium text-xs flex-shrink-0">
                            {lead.customerName ? lead.customerName.charAt(0).toUpperCase() : "?"}
                          </div>
                          <span className="truncate max-w-[200px]">{lead.customerName}</span>
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
                      <TableCell className="py-4 px-6 text-end">
                        <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {(lead.source?.startsWith("Instagram") || lead.source?.startsWith("Facebook")) && (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConversationCustomerId(lead.customerId); }}
                              className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md text-muted-foreground hover:text-blue-600 transition-colors"
                              title={t("ViewConversation" as any)}
                            >
                              <MessageCircle className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); try { generateQuote("AutoFlow Dealership", lead.customerName, lead.vehicleSummary || "Unknown Vehicle", "TBD", 0); toast.success(t("QuoteGenerated" as any) || "Quote generated"); } catch { toast.error(t("FailedGenerateQuote" as any) || "Failed to generate Quote"); } }}
                            className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md text-muted-foreground hover:text-blue-600 transition-colors"
                          >
                            <FileText className="w-4 h-4" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setLeadToDelete(lead); }}
                            className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md text-muted-foreground hover:text-red-600 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
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
                  <div key={stage} className={`flex flex-col w-60 flex-shrink-0 bg-slate-50 dark:bg-zinc-900/40 rounded-xl border border-t-4 ${getStageBorderColor(stage)}`}>
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
                            onClick={() => handleEdit(lead)}
                            className="bg-white dark:bg-zinc-800 rounded-lg p-3 shadow-sm border border-slate-100 dark:border-zinc-700 cursor-pointer hover:shadow-md transition-shadow group"
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-6 h-6 rounded-full bg-slate-100 dark:bg-zinc-700 flex items-center justify-center text-[10px] font-medium flex-shrink-0">
                                {lead.customerName?.charAt(0)?.toUpperCase() ?? "?"}
                              </div>
                              <span className="text-sm font-medium truncate flex-1">{lead.customerName}</span>
                              {(lead.source?.startsWith("Instagram") || lead.source?.startsWith("Facebook")) && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setConversationCustomerId(lead.customerId); }}
                                  className="p-1 rounded text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors shrink-0"
                                  title={t("ViewConversation" as any)}
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                            {lead.vehicleSummary && (
                              <div className="flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                                <Car className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate">{lead.vehicleSummary}</span>
                              </div>
                            )}
                            {lead.assignedUserName && (
                              <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-1 truncate">
                                <User className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate">{lead.assignedUserName}</span>
                              </div>
                            )}
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
      </div>
    </RoleGuard>
  );
}
