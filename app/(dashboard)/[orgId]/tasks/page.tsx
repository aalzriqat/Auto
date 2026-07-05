"use client";

import { useState } from "react";
import { RoleGuard } from "@/components/auth/RoleGuard";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TaskDialog } from "@/components/tasks/TaskDialog";
import { TaskHistoryDialog } from "@/components/tasks/TaskHistoryDialog";
import { CustomerDetailsDialog } from "@/components/customers/CustomerDetailsDialog";
import { useLanguage } from "@/components/providers/LanguageProvider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Pencil, Calendar, CheckSquare, XCircle, Clock, History, Phone, Mail, Printer } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DateTimePicker } from "@/components/ui/datetime-picker";
import { toast } from "@/components/ui/sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useTableControls } from "@/hooks/useTableControls";
import { SortableColumnHeader } from "@/components/ui/sortable-column-header";

const PRIORITY_RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

export default function TasksPage() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { results: tasks } = usePaginatedQuery(api.tasks.list, activeOrgId ? { orgId: activeOrgId } : "skip", { initialNumItems: 100 });
  const updateTask = useMutation(api.tasks.update);

  const [priorityFilter, setPriorityFilter] = useState<"all" | "HIGH" | "MEDIUM" | "LOW">("all");
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [taskToCancel, setTaskToCancel] = useState<any>(null);
  const [taskToReschedule, setTaskToReschedule] = useState<any>(null);
  const [historyTask, setHistoryTask] = useState<any>(null);
  const [statusNote, setStatusNote] = useState("");
  const [newDueDate, setNewDueDate] = useState<Date | undefined>(undefined);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  const {
    search: searchQuery,
    setSearch: setSearchQuery,
    sortKey,
    sortDir,
    toggleSort,
    rows: sortedTasks,
  } = useTableControls({
    data: tasks,
    searchFields: (task) => [task.title, task.customerName, task.assigneeName],
    sortAccessors: {
      dueDate: (task) => task.dueDate,
      priority: (task) => PRIORITY_RANK[(task as any).priority] ?? 0,
    },
  });

  const filteredTasks = sortedTasks?.filter((t) =>
    priorityFilter === "all" || (t as any).priority === priorityFilter
  );

  const handleEdit = (task: any) => {
    setEditingTask(task);
    setIsTaskDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingTask(null);
    setIsTaskDialogOpen(true);
  };

  const handleCancel = async () => {
    if (!activeOrgId || !taskToCancel) return;
    if (!statusNote.trim()) {
      toast.error(t("CancelReasonRequired" as any) || "Please provide a cancellation reason.");
      return;
    }
    try {
      await updateTask({
        orgId: activeOrgId,
        taskId: taskToCancel._id,
        status: "CANCELLED",
        statusNote: statusNote.trim()
      });
      toast.success(t("TaskCancelledSuccess" as any) || "Task cancelled successfully");
      setTaskToCancel(null);
      setStatusNote("");
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleReschedule = async () => {
    if (!activeOrgId || !taskToReschedule) return;
    if (!statusNote.trim()) {
      toast.error(t("RescheduleReasonRequired" as any) || "Please provide a reschedule reason.");
      return;
    }
    if (!newDueDate) {
      toast.error(t("NewDateRequired" as any) || "Please select a new date.");
      return;
    }
    try {
      const parsedDate = newDueDate.getTime();
      await updateTask({
        orgId: activeOrgId,
        taskId: taskToReschedule._id,
        dueDate: parsedDate,
        statusNote: statusNote.trim()
      });
      toast.success(t("TaskRescheduleSuccess" as any) || "Task rescheduled successfully");
      setTaskToReschedule(null);
      setStatusNote("");
      setNewDueDate(undefined);
    } catch (error: any) {
      toast.error(error);
    }
  };

  const handleToggleStatus = async (task: any) => {
    if (!activeOrgId) return;
    const newStatus = task.status === "COMPLETED" ? "PENDING" : "COMPLETED";
    try {
      await updateTask({
        orgId: activeOrgId,
        taskId: task._id,
        status: newStatus,
      });
      toast.success(t("TaskMarkedStatus" as any) || `Task status updated`);
    } catch (error: any) {
      toast.error(error);
    }
  };

  const getStatusBadge = (status: string, dueDate: number) => {
    if (status === "CANCELLED") {
      return <Badge variant="secondary" className="bg-gray-200 text-gray-700">{t("Cancelled" as any) || "Cancelled"}</Badge>;
    }
    if (status === "COMPLETED") {
      return <Badge variant="default" className="bg-green-600 hover:bg-green-700">{t("TaskCompleted" as any) || "Completed"}</Badge>;
    }

    // Check if overdue
    const isOverdue = dueDate < new Date().setHours(0, 0, 0, 0);
    if (isOverdue) {
      return <Badge variant="destructive">{t("Overdue" as any) || "Overdue"}</Badge>;
    }

    return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30">{t("TaskPending" as any) || "Pending"}</Badge>;
  };

  const getPriorityBadge = (priority?: string) => {
    switch (priority) {
      case "HIGH": return <Badge variant="outline" className="bg-red-50 text-red-600 border-red-200 text-[10px] px-1.5">{t("High" as any)}</Badge>;
      case "MEDIUM": return <Badge variant="outline" className="bg-yellow-50 text-yellow-600 border-yellow-200 text-[10px] px-1.5">{t("Medium" as any)}</Badge>;
      case "LOW": return <Badge variant="outline" className="bg-slate-50 text-slate-500 border-slate-200 text-[10px] px-1.5">{t("Low" as any)}</Badge>;
      default: return null;
    }
  };

  return (
    <RoleGuard permissions={["view:tasks"]}>
      <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4">
        <Button onClick={handleAddNew}>
          <Plus className="me-2 h-4 w-4" /> {t("ScheduleTask" as any) || "Schedule Task"}
        </Button>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative w-full max-w-sm">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            placeholder={t("SearchTasks" as any) || "Search tasks..."}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9"
          />
        </div>
        <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as any)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder={t("Priority" as any)} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("AllPriorities" as any)}</SelectItem>
            <SelectItem value="HIGH">{t("High" as any)}</SelectItem>
            <SelectItem value="MEDIUM">{t("Medium" as any)}</SelectItem>
            <SelectItem value="LOW">{t("Low" as any)}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <SortableColumnHeader className="w-16" label={t("Priority" as any)} sortKey="priority" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <TableHead>{t("Task" as any) || "Task"}</TableHead>
              <SortableColumnHeader label={t("DueDate" as any)} sortKey="dueDate" activeSortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <TableHead>{t("AssignedTo" as any) || "Assigned To"}</TableHead>
              <TableHead>{t("RelatedCustomer" as any) || "Related Customer"}</TableHead>
              <TableHead>{t("Status" as any) || "Status"}</TableHead>
              <TableHead className="text-end">{t("TaskActions" as any) || "Actions"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTasks === undefined ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  {t("LoadingTasks" as any) || "Loading tasks..."}
                </TableCell>
              </TableRow>
            ) : filteredTasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                  {t("NoTasksFound" as any) || "No tasks found."}
                </TableCell>
              </TableRow>
            ) : (
              filteredTasks.map((task) => (
                <TableRow key={task._id} className={task.status === "COMPLETED" ? "opacity-60" : ""}>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-8 w-8 rounded-full ${task.status === "COMPLETED" ? "text-green-600" : "text-muted-foreground"}`}
                      onClick={() => handleToggleStatus(task)}
                    >
                      <CheckSquare className="h-5 w-5" />
                    </Button>
                  </TableCell>
                  <TableCell>
                    {getPriorityBadge((task as any).priority)}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium flex items-center gap-2">
                      {task.status === "CANCELLED" ? <span className="line-through text-muted-foreground">{task.title}</span> : task.title}
                    </div>
                    {task.description && (
                      <div className="text-xs text-muted-foreground line-clamp-1">{task.description}</div>
                    )}
                    {task.statusNote && (
                      <div className="text-xs font-semibold text-blue-600 dark:text-blue-400 mt-1">Note: {task.statusNote}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center text-sm">
                      <Calendar className="me-2 h-3 w-3 text-muted-foreground" />
                      {new Date(task.dueDate).toLocaleDateString()}
                    </div>
                  </TableCell>
                  <TableCell>{task.assigneeName}</TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      {task.customerName && task.customerId ? (
                        <button
                          onClick={() => setSelectedCustomerId(task.customerId || null)}
                          className="text-sm text-blue-500 hover:text-blue-700 hover:underline transition-colors focus:outline-none"
                        >
                          {task.customerName}
                        </button>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">-</span>
                      )}

                      {task.communicationMethod && (
                        <div className="flex items-center text-xs text-muted-foreground mt-1">
                          {task.communicationMethod === "PHONE" && <Phone className="h-3 w-3 me-1" />}
                          {task.communicationMethod === "EMAIL" && <Mail className="h-3 w-3 me-1" />}
                          {task.communicationMethod === "FAX" && <Printer className="h-3 w-3 me-1" />}
                          <span className="capitalize">{task.communicationMethod.toLowerCase()}</span>
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{getStatusBadge(task.status, task.dueDate)}</TableCell>
                  <TableCell className="text-end space-x-1">
                    <Button variant="ghost" size="icon" onClick={() => setHistoryTask(task)} title="View History">
                      <History className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => {
                      setTaskToReschedule(task);
                      setStatusNote("");
                      setNewDueDate(new Date(task.dueDate));
                    }} title="Reschedule">
                      <Clock className="h-4 w-4 text-blue-500" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(task)} title="Edit">
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => {
                      setTaskToCancel(task);
                      setStatusNote("");
                    }} title="Cancel">
                      <XCircle className="h-4 w-4 text-red-500" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <TaskDialog
        open={isTaskDialogOpen}
        onOpenChange={setIsTaskDialogOpen}
        task={editingTask}
      />

      <Dialog open={!!taskToCancel} onOpenChange={(open) => !open && setTaskToCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("CancelTask" as any) || "Cancel Task"}</DialogTitle>
            <DialogDescription>
              {t("CancelTaskDesc" as any) || "Please provide a reason for cancelling this task. It will remain in the database for historical purposes."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder={t("CancelReason" as any) || "Reason for cancellation..."}
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTaskToCancel(null)}>{t("KeepTask" as any) || "Keep Task"}</Button>
            <Button variant="destructive" onClick={handleCancel}>{t("CancelTask" as any) || "Cancel Task"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!taskToReschedule} onOpenChange={(open) => !open && setTaskToReschedule(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("RescheduleTask" as any) || "Reschedule Task"}</DialogTitle>
            <DialogDescription>
              {t("RescheduleTaskDesc" as any) || "Select a new date and provide a reason for rescheduling."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">{t("DueDateTime" as any) || "New Due Date & Time"}</label>
              <DateTimePicker
                value={newDueDate}
                onChange={(date) => setNewDueDate(date)}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">{t("NoteReason" as any) || "Reason"}</label>
              <Input
                placeholder={t("RescheduleReason" as any) || "Why is it being rescheduled?"}
                value={statusNote}
                onChange={(e) => setStatusNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTaskToReschedule(null)}>{t("Cancel" as any) || "Cancel"}</Button>
            <Button onClick={handleReschedule}>{t("SaveChanges" as any) || "Save Changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TaskHistoryDialog
        open={!!historyTask}
        onOpenChange={(open) => !open && setHistoryTask(null)}
        task={historyTask}
      />

      <RoleGuard permissions={["view:customers"]}>
        <CustomerDetailsDialog
          customerId={selectedCustomerId as Id<"customers">}
          open={!!selectedCustomerId}
          onOpenChange={(open) => !open && setSelectedCustomerId(null)}
        />
      </RoleGuard>
    </div>
    </RoleGuard>
  );
}
