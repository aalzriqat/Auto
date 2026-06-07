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

const STAGES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "TEST_DRIVE",
  "NEGOTIATION",
  "RESERVED",
  "WON",
  "LOST",
] as const;

export default function LeadsPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const leads = useQuery(api.leads.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeLead = useMutation(api.leads.remove);
  
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

  const leadsByStage = STAGES.reduce((acc, stage) => {
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
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 flex-shrink-0">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t("SalesLeads" as any) || "Sales Leads"}</h2>
          <p className="text-muted-foreground">
            {t("TrackBuyers" as any) || "Track potential buyers through the sales pipeline."}
          </p>
        </div>
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> {t("AddLead" as any) || "Add Lead"}
        </Button>
      </div>

      <div className="flex-1 overflow-x-auto pb-4">
        <div className="flex gap-4 min-w-max h-full">
          {STAGES.map((stage) => {
            let stageTranslationKey: string = stage;
            if (stage === "NEW") stageTranslationKey = "StageNew";
            if (stage === "CONTACTED") stageTranslationKey = "StageContacted";
            if (stage === "INTERESTED") stageTranslationKey = "Interested";
            if (stage === "TEST_DRIVE") stageTranslationKey = "StageTestDrive";
            if (stage === "NEGOTIATION") stageTranslationKey = "StageNegotiation";
            if (stage === "RESERVED") stageTranslationKey = "Reserved";
            if (stage === "WON") stageTranslationKey = "StageWon";
            if (stage === "LOST") stageTranslationKey = "Lost";

            return (
            <div key={stage} className="w-[300px] flex flex-col bg-muted/40 rounded-lg border border-border/50">
              <div className="p-3 border-b border-border/50 flex justify-between items-center bg-muted/50 rounded-t-lg">
                <h3 className="font-semibold text-sm">{t(stageTranslationKey as any) || stage.replace("_", " ")}</h3>
                <Badge variant="secondary" className="text-xs">
                  {leadsByStage[stage]?.length || 0}
                </Badge>
              </div>
              
              <div className="p-3 flex-1 overflow-y-auto space-y-3">
                {leadsByStage[stage]?.length === 0 ? (
                  <div className="text-sm text-muted-foreground text-center py-4 italic">
                    {t("Empty" as any) || "Empty"}
                  </div>
                ) : (
                  leadsByStage[stage]?.map((lead) => (
                    <div 
                      key={lead._id} 
                      className="bg-card border rounded-md p-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer group relative"
                      onClick={() => handleEdit(lead)}
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium flex items-center gap-1.5">
                          <User className="w-3 h-3 text-muted-foreground" />
                          <span className="text-sm truncate max-w-[200px]">{lead.customerName}</span>
                        </div>
                      </div>
                      
                      {lead.vehicleSummary && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                          <Car className="w-3 h-3" />
                          <span className="truncate">{lead.vehicleSummary}</span>
                        </div>
                      )}
                      
                      <div className="flex items-center justify-between mt-3">
                        <Badge variant="outline" className={`text-[10px] uppercase font-semibold ${getStageColor(lead.stage)} border-transparent`}>
                          {t(stageTranslationKey as any) || lead.stage.replace("_", " ")}
                        </Badge>
                        {lead.assignedUserName && (
                          <div className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {lead.assignedUserName}
                          </div>
                        )}
                      </div>

                      <div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
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
                          className="p-1 hover:bg-blue-500/10 rounded text-muted-foreground hover:text-blue-500"
                          title={t("GenerateQuote" as any) || "Generate Quote"}
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setLeadToDelete(lead);
                          }}
                          className="p-1 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive"
                          title={t("RemoveLead" as any) || "Delete Lead"}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )})}
        </div>
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
              {t("RemoveLeadConfirm" as any) || "Are you sure you want to delete this lead? This action cannot be undone."} <br/>
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
