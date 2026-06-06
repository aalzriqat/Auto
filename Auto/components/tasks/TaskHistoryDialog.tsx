"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

interface TaskHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: any | null;
}

export function TaskHistoryDialog({ open, onOpenChange, task }: TaskHistoryDialogProps) {
  const { activeOrgId } = useOrg();
  const history = useQuery(
    api.tasks.getHistory,
    activeOrgId && task ? { orgId: activeOrgId, taskId: task._id } : "skip"
  );

  const getActionBadge = (action: string) => {
    switch (action) {
      case "CREATE":
        return <Badge variant="default" className="bg-blue-500">Created</Badge>;
      case "UPDATE":
        return <Badge variant="outline" className="border-blue-500 text-blue-500">Updated</Badge>;
      case "RESCHEDULE":
        return <Badge variant="secondary" className="bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300">Rescheduled</Badge>;
      case "CANCEL":
        return <Badge variant="secondary" className="bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">Cancelled</Badge>;
      case "STATUS_CHANGE":
        return <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">Status Changed</Badge>;
      default:
        return <Badge variant="outline">{action}</Badge>;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Task History</DialogTitle>
          <DialogDescription>
            Audit trail for: {task?.title}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-6 px-6">
          <div className="space-y-6 py-4">
            {history === undefined ? (
              <div className="text-center py-8 text-muted-foreground">Loading history...</div>
            ) : history.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">No history found for this task.</div>
            ) : (
              <div className="relative border-l ml-3 pl-6 space-y-8">
                {history.map((entry: any) => (
                  <div key={entry._id} className="relative">
                    {/* Timeline dot */}
                    <span className="absolute -left-[31px] top-1 h-3 w-3 rounded-full bg-primary ring-4 ring-background" />
                    
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-3">
                        {getActionBadge(entry.action)}
                        <span className="font-semibold text-sm">{entry.userName}</span>
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(entry._creationTime).toLocaleString()}
                      </span>
                    </div>
                    
                    <div className="text-sm mt-2">
                      <p className="text-muted-foreground">{entry.details}</p>
                      
                      {entry.note && (
                        <div className="mt-3 bg-muted/50 p-3 rounded-md border text-sm">
                          <span className="font-semibold block mb-1">Note / Reason:</span>
                          <span className="italic text-muted-foreground">{entry.note}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
