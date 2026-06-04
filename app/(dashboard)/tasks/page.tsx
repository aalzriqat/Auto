"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/components/providers/OrgProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TaskDialog } from "@/components/tasks/TaskDialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Search, Pencil, Trash2, Calendar, CheckSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function TasksPage() {
  const { activeOrgId } = useOrg();
  const tasks = useQuery(api.tasks.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const removeTask = useMutation(api.tasks.remove);
  const updateTask = useMutation(api.tasks.update);

  const [searchQuery, setSearchQuery] = useState("");
  const [isTaskDialogOpen, setIsTaskDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<any>(null);
  const [taskToDelete, setTaskToDelete] = useState<any>(null);

  const filteredTasks = tasks?.filter(t => {
    const q = searchQuery.toLowerCase();
    return t.title.toLowerCase().includes(q) || 
           (t.customerName && t.customerName.toLowerCase().includes(q)) ||
           (t.assigneeName && t.assigneeName.toLowerCase().includes(q));
  });

  const handleEdit = (task: any) => {
    setEditingTask(task);
    setIsTaskDialogOpen(true);
  };

  const handleAddNew = () => {
    setEditingTask(null);
    setIsTaskDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!activeOrgId || !taskToDelete) return;
    try {
      await removeTask({ orgId: activeOrgId, taskId: taskToDelete._id });
      toast.success("Task deleted successfully");
      setTaskToDelete(null);
    } catch (error: any) {
      toast.error(error.message || "Failed to delete task");
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
      toast.success(`Task marked as ${newStatus.toLowerCase()}`);
    } catch (error: any) {
      toast.error(error.message || "Failed to update task status");
    }
  };

  const getStatusBadge = (status: string, dueDate: number) => {
    if (status === "COMPLETED") {
      return <Badge variant="default" className="bg-green-600 hover:bg-green-700">Completed</Badge>;
    }
    
    // Check if overdue
    const isOverdue = dueDate < new Date().setHours(0,0,0,0);
    if (isOverdue) {
      return <Badge variant="destructive">Overdue</Badge>;
    }

    return <Badge variant="secondary" className="bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30">Pending</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Tasks & CRM</h2>
          <p className="text-muted-foreground">
            Manage your daily tasks, follow-ups, and schedules.
          </p>
        </div>
        <Button onClick={handleAddNew}>
          <Plus className="mr-2 h-4 w-4" /> Schedule Task
        </Button>
      </div>

      <div className="flex items-center w-full max-w-sm space-x-2">
        <Search className="h-4 w-4 text-muted-foreground absolute ml-3" />
        <Input
          placeholder="Search tasks..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>Task</TableHead>
              <TableHead>Due Date</TableHead>
              <TableHead>Assigned To</TableHead>
              <TableHead>Related Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTasks === undefined ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  Loading tasks...
                </TableCell>
              </TableRow>
            ) : filteredTasks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No tasks found.
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
                    <div className="font-medium">{task.title}</div>
                    {task.description && (
                      <div className="text-xs text-muted-foreground line-clamp-1">{task.description}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center text-sm">
                      <Calendar className="mr-2 h-3 w-3 text-muted-foreground" />
                      {new Date(task.dueDate).toLocaleDateString()}
                    </div>
                  </TableCell>
                  <TableCell>{task.assigneeName}</TableCell>
                  <TableCell>
                    {task.customerName ? (
                      <span className="text-sm">{task.customerName}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground italic">-</span>
                    )}
                  </TableCell>
                  <TableCell>{getStatusBadge(task.status, task.dueDate)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(task)}>
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setTaskToDelete(task)}>
                      <Trash2 className="h-4 w-4 text-red-500" />
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

      <Dialog open={!!taskToDelete} onOpenChange={(open) => !open && setTaskToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Task</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this task? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTaskToDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
