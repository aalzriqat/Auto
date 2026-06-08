"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { LeadDialog } from "@/components/leads/LeadDialog";
import { Doc } from "@/convex/_generated/dataModel";
import { Plus, User, Car, Calendar, Trash2, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { toast } from "sonner";
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


export default function LeadsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const leads = useQuery(api.leads.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeLead = useMutation(api.leads.softDelete);

  const [isLeadDialogOpen, setIsLeadDialogOpen] = useState(false);
  const [editingLead, setEditingLead] = useState<any>(null);
  const [leadToDelete, setLeadToDelete] = useState<any>(null);

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

  return (
    <div className="space-y-6 flex flex-col h-full overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> {t("AddLead" as any) || "Add Lead"}
        </Button>
      </div>

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

      <div className="flex-1 overflow-auto bg-card rounded-xl border-0 ring-1 ring-slate-100 dark:ring-zinc-800 shadow-sm">
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
              leads?.map((lead) => {
                let stageTranslationKey: string = lead.stage;
                if (lead.stage === "NEW") stageTranslationKey = "StageNew";
                if (lead.stage === "CONTACTED") stageTranslationKey = "StageContacted";
                if (lead.stage === "INTERESTED") stageTranslationKey = "Interested";
                if (lead.stage === "TEST_DRIVE") stageTranslationKey = "StageTestDrive";
                if (lead.stage === "NEGOTIATION") stageTranslationKey = "StageNegotiation";
                if (lead.stage === "RESERVED") stageTranslationKey = "Reserved";
                if (lead.stage === "WON") stageTranslationKey = "StageWon";
                if (lead.stage === "LOST") stageTranslationKey = "Lost";

                return (
                  <TableRow key={lead._id} className="cursor-pointer group hover:bg-slate-50/50 dark:hover:bg-zinc-900/50 transition-colors" onClick={() => handleEdit(lead)}>
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
                        {t(stageTranslationKey as any) || lead.stage.replace("_", " ")}
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
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            try {
                              generateQuote(
                                "Bloom Cars Dealership",
                                lead.customerName,
                                lead.vehicleSummary || "Unknown Vehicle",
                                "TBD",
                                0
                              );
                              toast.success(t("QuoteGenerated" as any) || "Quote generated");
                            } catch (err) {
                              toast.error(t("FailedGenerateQuote" as any) || "Failed to generate Quote");
                            }
                          }}
                          className="p-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md text-muted-foreground hover:text-blue-600 transition-colors"
                          title={t("GenerateQuote" as any) || "Generate Quote"}
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setLeadToDelete(lead);
                          }}
                          className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md text-muted-foreground hover:text-red-600 transition-colors"
                          title={t("RemoveLead" as any) || "Delete Lead"}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <LeadDialog
        open={isLeadDialogOpen}
        onOpenChange={setIsLeadDialogOpen}
        lead={editingLead}
      />

      <Dialog open={!!leadToDelete} onOpenChange={(open) => !open && setLeadToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("RemoveLead" as any) || "Delete Lead"}</DialogTitle>
            <DialogDescription>
              {t("RemoveLeadConfirm" as any) || "Are you sure you want to delete this lead? This action cannot be undone."} <br />
              <span className="font-semibold text-foreground">{leadToDelete?.customerName}</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeadToDelete(null)}>{t("Cancel" as any) || "Cancel"}</Button>
            <Button variant="destructive" onClick={handleDelete}>{t("Delete" as any) || "Delete"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
